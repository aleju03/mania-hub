import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { SupporterNameFontId } from "../../lib/supporter-name-fonts";
import { baseNameStyle, isShaderNameStyle, isSolidNameStyle, TERMINAL_BARE, nameOutlineInline, solidNameColour, type SupporterNameStyleId } from "../../lib/supporter-name-styles";
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

/* The inline part of a name's look: a solid style's colour and the outline's. */
export function nameStyleInline(nameStyle: SupporterNameStyleId | null, outline: string | null): CSSProperties | undefined {
  if (!outline && !isSolidNameStyle(nameStyle)) return undefined;
  return {
    ...(isSolidNameStyle(nameStyle) ? { color: solidNameColour(nameStyle) } : null),
    ...(outline ? nameOutlineInline(outline) : null),
  } as CSSProperties;
}

export function SupporterStyledName({ nameStyle, nameFont = null, outline = null, name, className, live = false, still = false }: {
  nameStyle: SupporterNameStyleId | null;
  nameFont?: SupporterNameFontId | null;
  /* An outline round the letters in this colour (six hex digits), drawn
     with the text, so a live shader's letters sit inside it. */
  outline?: string | null;
  name: string;
  className?: string;
  live?: boolean;
  /* A still of the real shader look instead of the CSS one, for picker tiles
     (name-tag-shaders.ts stillNameShader); with `live` too, the still shows
     until the live shader draws. */
  still?: boolean;
}) {
  const isShader = nameStyle !== null && isShaderNameStyle(nameStyle);
  const shaded = live && isShader;
  const spanRef = useRef<HTMLSpanElement>(null);
  const hostRef = useRef<HTMLSpanElement>(null);
  const [liveReady, setLiveReady] = useState(false);
  const [stillReady, setStillReady] = useState(false);
  // the still stays up until the live shader has drawn, so a tile never drops
  // to its CSS look on the way between them
  const stilled = still && isShader && !liveReady;
  const ready = liveReady || stillReady;
  // name tags give way to bigger pieces (gl-budget.ts) and keep their CSS look meanwhile
  const glSlot = useWebGlSlot(spanRef, { enabled: shaded, low: true });

  useEffect(() => {
    const span = spanRef.current, host = hostRef.current;
    if (!shaded || !glSlot || !span || !host) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void import("../../lib/name-tag-shaders").then(({ mountNameShader }) => {
      if (cancelled) return;
      if (nameStyle && isShaderNameStyle(nameStyle)) cleanup = mountNameShader(span, host, nameStyle, () => setLiveReady(true));
    });
    return () => {
      cancelled = true;
      cleanup?.();
      setLiveReady(false);
    };
  }, [shaded, glSlot, nameStyle, nameFont, name]);

  useEffect(() => {
    const span = spanRef.current, host = hostRef.current;
    if (!stilled || !span || !host) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void import("../../lib/name-tag-shaders").then(({ stillNameShader }) => {
      if (cancelled) return;
      if (nameStyle && isShaderNameStyle(nameStyle)) cleanup = stillNameShader(span, host, nameStyle, () => setStillReady(true));
    });
    return () => {
      cancelled = true;
      cleanup?.();
      setStillReady(false);
    };
  }, [stilled, nameStyle, nameFont, name]);

  return (
    <span ref={spanRef} style={nameStyleInline(nameStyle, outline)} className={`${className ?? ""}${outline ? " name-outline" : ""}${nameStyle ? ` name-tag name-tag--${isSolidNameStyle(nameStyle) ? "solid" : baseNameStyle(nameStyle)}${nameStyle === TERMINAL_BARE ? " name-tag--bare" : ""}` : ""}${nameFont ? ` name-font--${nameFont}` : ""}${live || (still && isShader) ? " name-tag--hero" : ""}${shaded || stilled ? " relative" : ""}${ready ? " name-tag--live" : shaded ? " name-tag--pending" : still && isShader ? " name-tag--waiting" : ""}`}>
      {name}
      {(shaded || stilled) && <span ref={hostRef} aria-hidden className="name-tag-shader" />}
    </span>
  );
}
