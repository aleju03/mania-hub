import { useEffect, useRef, useState } from "react";

import type { SupporterNameFontId } from "../../lib/supporter-name-fonts";
import { isShaderNameStyle, type SupporterNameStyleId } from "../../lib/supporter-name-styles";
import { useWebGlSlot } from "../../lib/gl-budget";

/* A supporter's name in their name tag style and/or name font. One element whose look comes
   from the `name-tag--<id>` rules in styles.css, so the caller's sizing,
   `truncate` and padding keep working: glows are drop-shadow filters, which
   draw past the clipping box instead of being cut by it, and every length is
   in em so the same style fits the hero and a picker tile.

   `live` (big names only: the profile hero, the /supporter preview) also runs
   the shader styles (SHADER_NAME_STYLES) as WebGL over the name
   (name-tag-shaders.ts, loaded on demand). The CSS look shows until the shader draws (a softer
   one for the liquid metals, `name-tag--pending`, so their hard reflection band doesn't flash
   before the real metal); then the text turns transparent but stays for layout, selection and
   truncation. */

export function SupporterStyledName({ nameStyle, nameFont = null, name, className, live = false }: {
  nameStyle: SupporterNameStyleId | null;
  nameFont?: SupporterNameFontId | null;
  name: string;
  className?: string;
  live?: boolean;
}) {
  const shaded = live && nameStyle !== null && isShaderNameStyle(nameStyle);
  const spanRef = useRef<HTMLSpanElement>(null);
  const hostRef = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);
  // name tags give way to bigger pieces (gl-budget.ts) and keep their CSS look meanwhile
  const glSlot = useWebGlSlot(spanRef, { enabled: shaded, low: true });

  useEffect(() => {
    const span = spanRef.current, host = hostRef.current;
    if (!shaded || !glSlot || !span || !host) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void import("../../lib/name-tag-shaders").then(({ mountNameShader }) => {
      if (cancelled) return;
      if (nameStyle && isShaderNameStyle(nameStyle)) cleanup = mountNameShader(span, host, nameStyle, () => setReady(true));
    });
    return () => {
      cancelled = true;
      cleanup?.();
      setReady(false);
    };
  }, [shaded, glSlot, nameStyle, nameFont, name]);

  return (
    <span ref={spanRef} className={`${className ?? ""}${nameStyle ? ` name-tag name-tag--${nameStyle}` : ""}${nameFont ? ` name-font--${nameFont}` : ""}${live ? " name-tag--hero" : ""}${shaded ? " relative" : ""}${ready ? " name-tag--live" : shaded ? " name-tag--pending" : ""}`}>
      {name}
      {shaded && <span ref={hostRef} aria-hidden className="name-tag-shader" />}
    </span>
  );
}
