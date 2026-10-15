import { useEffect, useRef, useState } from "react";

import type { SupporterNameFontId } from "../../lib/supporter-name-fonts";
import { isShaderNameStyle, type SupporterNameStyleId } from "../../lib/supporter-name-styles";

/* A supporter's name in their name tag style and/or name font. One element whose look comes
   from the `name-tag--<id>` rules in styles.css, so the caller's sizing,
   `truncate` and padding keep working: glows are drop-shadow filters, which
   draw past the clipping box instead of being cut by it, and every length is
   in em so the same style fits the hero and a picker tile.

   `live` (big names only: the profile hero, the /supporter preview) also runs
   the shader styles (SHADER_NAME_STYLES) as WebGL over the name
   (name-tag-shaders.ts, loaded on demand). The CSS look shows until the shader draws; then the text
   turns transparent but stays for layout, selection and truncation. */

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

  useEffect(() => {
    const span = spanRef.current, host = hostRef.current;
    if (!shaded || !span || !host) return;
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
  }, [shaded, nameStyle, nameFont, name]);

  return (
    <span ref={spanRef} className={`${className ?? ""}${nameStyle ? ` name-tag name-tag--${nameStyle}` : ""}${nameFont ? ` name-font--${nameFont}` : ""}${shaded ? " relative" : ""}${ready ? " name-tag--live" : ""}`}>
      {name}
      {shaded && <span ref={hostRef} aria-hidden className="name-tag-shader" />}
    </span>
  );
}
