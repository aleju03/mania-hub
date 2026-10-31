import { CUSTOM_THEME_LOOP_BUDGET, CUSTOM_THEME_SOURCE_MAX_BYTES, CUSTOM_THEME_TEXTURES } from "#custom-themes/inputs";
import { PROFILE_THEME_PRELUDE } from "./profile-theme-shaders";

/* The theme spec as one plain-text page, to copy from the editor or read at
   /workshop/themes/spec. The helpers' list is read out of the
   prelude itself, so it can't drift from what the shader really gets. */

export interface PreludeHelper {
  signature: string;
  note: string | null;
}

/* Every function the prelude defines, with the comment above it, if any. */
export function preludeHelpers(prelude = PROFILE_THEME_PRELUDE): PreludeHelper[] {
  const lines = prelude.split("\n");
  const helpers: PreludeHelper[] = [];
  lines.forEach((line, index) => {
    const match = /^(float|vec2|vec3|vec4|mat2|int|bool)\s+(\w+)\(([^)]*)\)\s*\{/.exec(line);
    if (!match) return;
    let note: string | null = null;
    const above = lines[index - 1]?.trim() ?? "";
    if (above.endsWith("*/")) {
      const comment: string[] = [];
      for (let back = index - 1; back >= 0; back--) {
        comment.unshift(lines[back].trim());
        if (lines[back].trim().startsWith("/*")) break;
      }
      note = comment.join(" ").replace(/^\/\*\s*|\s*\*\/$/g, "").replace(/\\`/g, "`").replace(/\s+/g, " ").trim();
    }
    helpers.push({ signature: `${match[1]} ${match[2]}(${match[3]})`, note });
  });
  return helpers;
}

const HELPER_NOTES: Record<string, string> = {
  hash: "a random value 0..1 for a point",
  noise: "smooth value noise, 0..1",
  fbm: "5 octaves of noise, 0..1",
  ihash: "integer-cell hash 0..1, the same on every GPU",
  inoise: "value noise on the integer hash: use it for new code, it never tears into squares on phones",
  ifbm: "5 octaves of inoise, 0..1",
  rot: "a 2D rotation matrix: rot(a) * p",
  pointerP: "the pointer in p units (see theme() below)",
};

export const CUSTOM_THEME_STARTER = `// Slow aurora curtains over a starfield, leaning toward the pointer.
vec3 theme(vec2 uv, vec2 p, float t) {
  vec3 col = mix(vec3(.01, .02, .04), vec3(.02, .05, .08), uv.y);
  col += vec3(.8, .9, 1.) * stars(p + vec2(0., u_scroll * .1), 60., .08, t) * .6;
  vec2 q = p + pointerP() * .05;
  float band = ifbm(vec2(q.x * 1.6 + t * .05, q.y * .6));
  float curtain = smoothstep(.15, 0., abs(q.y - .15 - (band - .5) * .5));
  col += vec3(.1, .8, .55) * curtain * (.25 + .2 * sin(t * .4 + q.x * 3.));
  return col;
}`;

export function customThemeSpec(): string {
  const helpers = preludeHelpers()
    .map((helper) => {
      const name = /\s(\w+)\(/.exec(helper.signature)?.[1] ?? "";
      const note = helper.note ?? HELPER_NOTES[name] ?? null;
      return `- ${helper.signature}${note ? `: ${note}` : ""}`;
    })
    .join("\n");
  return `PROFILE THEME SPEC

A profile theme is a GLSL ES 3.00 (WebGL2) fragment shader drawn full-screen
behind a player's profile. White text and dark panels sit on top of it.

THE CONTRACT
Write one function, plus any helpers of your own:

  vec3 theme(vec2 uv, vec2 p, float t)

- uv: 0..1 across the canvas, y up.
- p: centred on the canvas and measured in canvas heights, so p.y runs
  -0.5..0.5 and p.x wider on a wide screen. Use p for shapes so circles stay
  round.
- t: seconds since the theme started.
- Return the pixel's colour, linear 0..1. Don't write main(); the site's
  main() calls theme(), clamps the colour at 0 and adds a touch of dither.

A Shadertoy shader also works as pasted: void mainImage(out vec4 fragColor,
in vec2 fragCoord), with iTime, iResolution, iMouse (no clicks), iFrame and
iChannel0..${CUSTOM_THEME_TEXTURES - 1} (the theme's images). Single pass only: no Buffer A-D, no
sound, no keyboard.

INPUTS
- float u_time: seconds (the same as t).
- vec2 u_res: the canvas size in pixels.
- vec2 u_pointer: the pointer over the canvas, 0..1 with y up, eased.
- float u_scroll: how far the page has scrolled, in screen heights (0 at the
  top). Drift layers by it at different depths for parallax.
- float PX: one canvas pixel in p units, to keep fine detail from vanishing
  on small screens.
- sampler2D u_tex0..u_tex${CUSTOM_THEME_TEXTURES - 1} and vec2 u_texSize0..u_texSize${CUSTOM_THEME_TEXTURES - 1}: up to ${CUSTOM_THEME_TEXTURES} images the author
  uploads, premultiplied alpha, mipmapped, repeating. Their first row is at
  the top: sample with vec2(uv.x, 1. - uv.y). An unused slot reads as clear.

HELPERS (already defined; don't redefine them)
${helpers}

LIMITS
- At most ${CUSTOM_THEME_SOURCE_MAX_BYTES / 1024} KB of code. Outside comments, only basic keyboard
  characters: no curly quotes, accented letters, emoji or other alphabets.
- No uniform, in, out or layout declarations, no main(), and no #version,
  #extension, #pragma or #line. #define and #if work.
- Names starting with u_, gl_ or _cg_ belong to the site (reading
  gl_FragCoord is fine).
- Loops: every loop turn in a pixel counts, all loops together, and after
  ${CUSTOM_THEME_LOOP_BUDGET} turns every loop stops early. Keep raymarches and nested loops
  well under that, or parts of the image cut off.
- Cost: the theme can't be heavier than the heaviest built-in theme (Black
  hole). The editor measures it and says how far over it is. Fewer fbm
  octaves, fewer loop turns and fewer texture reads are the usual fixes.
- Stay dark: the page's text is white. A mean brightness around 0.05 to
  0.15 reads well; much above 0.3 makes the profile hard to read.
- Visitors on slow devices get a lower resolution, and the theme's still
  image if it is still too slow, so design for a still frame to look good.

EXAMPLE
${CUSTOM_THEME_STARTER}
`;
}
