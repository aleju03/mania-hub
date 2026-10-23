import {
  getShaderColorFromString,
  liquidMetalFragmentShader,
  LiquidMetalShapes,
  ShaderFitOptions,
  ShaderMount,
  toProcessedLiquidMetal,
} from "@paper-design/shaders";

import type { ShaderNameStyle } from "./supporter-name-styles";
import { queueGpuWork } from "./gpu-queue";

/* Live WebGL looks for a name tag, drawn over a supporter's name where it is
   big (the profile hero, the /supporter preview). Chrome and molten gold run
   the Liquid Metal shader from @paper-design/shaders (Apache-2.0); the rest
   are our own shaders below.
   Every one takes a mask of the name as it is laid out on the page, so the
   HTML text stays for layout, selection and truncation and only turns
   transparent once the canvas is drawing. Loaded on demand; lists keep the
   CSS version in styles.css. */

/* Liquid Metal's dark tone is near black, made for a light backdrop; over a
   dark profile cover whole letters would vanish into it, so names lift it to
   gunmetal. Pinned to the package version this line comes from; if it ever
   changes, the stock shader runs instead. */
const LIQUID_METAL_DARK = "vec3 color2 = vec3(.1, .1, .1 + .1 * smoothstep(.7, 1.3, diagTLtoBR));";
const nameLiquidMetalShader = liquidMetalFragmentShader.replace(
  LIQUID_METAL_DARK,
  "vec3 color2 = vec3(.3, .31, .35 + .08 * smoothstep(.7, 1.3, diagTLtoBR));",
);

/* What every own shader shares: noise, the glyph mask, and how deep inside the
   letters a pixel is. `uv` runs 0..1 over the name's box with y down; `p`
   measures both axes in box heights. */
// language=GLSL
const PRELUDE = `#version 300 es
precision mediump float;

uniform sampler2D u_image;
uniform float u_time;
uniform float u_imageAspectRatio;

in vec2 v_imageUV;
out vec4 fragColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0., a = .5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + 7.1;
    a *= .5;
  }
  return v;
}

float glyph(vec2 uv) {
  if (uv.x < 0. || uv.y < 0. || uv.x > 1. || uv.y > 1.) return 0.;
  return texture(u_image, uv).a;
}

float depthAt(vec2 uv, float aspect) {
  float d = 0.;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * .785398;
    d += glyph(uv + vec2(cos(a) * .05 / aspect, sin(a) * .07));
  }
  return d / 8.;
}
`;

/* An own shader from a body that sets vec3 color for a pixel inside the
   letters, given uv, p, t, aspect, body (glyph coverage), depth and rim (1 on
   the letters' edges, so dark looks still read on dark covers). */
function letterShader(body: string): string {
  return `${PRELUDE}
void main() {
  vec2 uv = v_imageUV;
  float aspect = u_imageAspectRatio;
  float t = u_time;
  vec2 p = vec2(uv.x * aspect, uv.y);
  float body = glyph(uv);
  if (body < .002) { fragColor = vec4(0.); return; }
  float depth = depthAt(uv, aspect) * body;
  float rim = body * (1. - smoothstep(.2, .65, depth));
  vec3 color = vec3(1.);
  ${body}
  fragColor = vec4(color * body, body);
}
`;
}

const twinkleStars = (scale: string, threshold: string) => `
  {
    vec2 cell = p * ${scale};
    vec2 id = floor(cell);
    vec2 f = fract(cell) - .5;
    float h = hash(id);
    vec2 at = (vec2(hash(id + 1.3), hash(id + 2.7)) - .5) * .6;
    float tw = .5 + .5 * sin(t * (1.5 + 3. * h) + h * 30.);
    color += vec3(1.) * smoothstep(.13, 0., length(f - at)) * step(${threshold}, h) * tw;
  }`;

// language=GLSL
const OWN_SHADERS: Record<Exclude<ShaderNameStyle, "chrome" | "molten-gold" | "glitch">, string> = {
  // Heatmap: a thermal camera, cool at the edges, hot in the thick of the
  // letters, heat waves rising through.
  heatmap: letterShader(`
  float heat = depth * .4 + .62 * fbm(p * 2.2 + vec2(0., t * .55)) + .14 * sin(p.x * 4. - t * 1.4) + .1;
  vec3 ramp[7] = vec3[7](vec3(.07, .13, .42), vec3(.12, .23, .64), vec3(.18, .39, .91), vec3(.42, .84, 1.), vec3(1., .9, .47), vec3(1., .6, .12), vec3(1., .3, 0.));
  float x = clamp(heat, 0., .999) * 6.;
  int i = int(floor(x));
  color = mix(ramp[i], ramp[min(i + 1, 6)], fract(x));`),

  // Ethereal Dream: periwinkle letters, warm light drifting through, stardust.
  ethereal: letterShader(`
  float w = fbm(p * 2.6 + vec2(t * .45, -t * .18));
  // mostly the drifting noise, so thin fonts glow too, a little more in thick strokes
  float heat = smoothstep(.32, .6, w) * (.65 + .35 * smoothstep(.1, .6, depth));
  vec3 periwinkle = vec3(.43, .48, 1.);
  vec3 warm = mix(vec3(1., .47, .78), vec3(1., .62, .3), smoothstep(.45, .7, w));
  warm = mix(warm, vec3(1., .93, .6), smoothstep(.55, .75, w) * (.5 + .5 * depth));
  color = mix(periwinkle, warm, heat);
  vec2 cell = p * vec2(7., 10.);
  vec2 id = floor(cell);
  vec2 f = fract(cell) - .5;
  float h = hash(id);
  vec2 d = f - (vec2(hash(id + 3.1), hash(id + 7.7)) - .5) * .5;
  float dash = smoothstep(.3, 0., abs(d.x)) * smoothstep(.11, 0., abs(d.y));
  float twinkle = pow(max(0., sin(t * (2. + 2. * h) + h * 40.)), 6.);
  color = mix(color, vec3(1.), dash * twinkle * step(.4, h));`),

  // Soap-bubble pearl: an oily rainbow film over pearly white.
  pearl: letterShader(`
  vec2 q = p * 1.6;
  float n = fbm(q + vec2(t * .12, -t * .08) + fbm(q * 1.3 - t * .1));
  float film = n * 1.8 + depth * .6 + p.x * .22 + t * .04;
  vec3 iri = .55 + .45 * cos(6.2831 * (film + vec3(0., .33, .67)));
  color = mix(vec3(.94, .93, .98), iri, .55);
  color += .3 * pow(smoothstep(.55, .95, depth), 3.);
  color *= mix(.8, 1., smoothstep(0., .45, depth));`),

  // Galaxy: a window into space, nebula drifting, stars twinkling.
  galaxy: letterShader(`
  vec2 q = p * 1.4 + vec2(t * .12, t * .03);
  float n1 = fbm(q * 1.5 + fbm(q * 2. + vec2(t * .18, -t * .1)));
  vec3 neb = mix(vec3(.45, .2, .8), vec3(.98, .38, .72), smoothstep(.4, .8, n1));
  neb = mix(neb, vec3(.3, .58, 1.), smoothstep(.55, .9, fbm(q * 2.3 - vec2(t * .15, t * .05))));
  color = mix(vec3(.3, .2, .6), neb * 1.2, smoothstep(.18, .58, n1));
  ${twinkleStars("vec2(12., 12.)", ".6")}
  color = mix(color, vec3(.86, .8, 1.), rim * .85);`),

  // Aurora: light curtains waving over a dark teal sky.
  aurora: letterShader(`
  float x = p.x * 2.2 + fbm(vec2(p.x * 1.5, t * .15)) * 1.6;
  float curtain = 0.;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    curtain += smoothstep(0., .9, sin(x * (1. + fi * .7) + t * (.4 + fi * .2) + fi * 2.)) * (1. - fi * .25);
  }
  curtain = clamp(curtain / 1.8, 0., 1.) * (.55 + .45 * fbm(vec2(p.x * 3., uv.y * 2. - t * .3)));
  vec3 light = mix(vec3(.62, .4, 1.), vec3(.3, 1., .62), smoothstep(.15, .75, uv.y));
  light = mix(light, vec3(.25, .9, .95), smoothstep(.45, .9, uv.y) * .5);
  color = mix(vec3(.08, .3, .34), light, .25 + .75 * curtain);
  color = mix(color, vec3(.6, 1., .82), rim * .55);`),

  // Plasma: electric veins crawling through deep blue.
  plasma: letterShader(`
  vec2 q = p * 2.;
  float n = fbm(q + vec2(t * .3, t * .2));
  float n2 = fbm(q * 1.7 - vec2(t * .25, -t * .15) + n);
  float vein = pow(1. - abs(n2 * 2. - 1.), 12.);
  float vein2 = pow(1. - abs(fbm(q * 3. + t * .5) * 2. - 1.), 18.);
  color = vec3(.07, .13, .38) + vec3(.3, .7, 1.) * vein * 1.4 + vec3(.9, .95, 1.) * vein2 * 1.2;
  color *= .86 + .14 * noise(vec2(t * 18., 0.));
  color = mix(color, vec3(.5, .78, 1.), rim * .6);`),

  // Ink marble: ink folding through paper, a thread of gold in it.
  ink: letterShader(`
  vec2 q = p * 1.3;
  vec2 w1 = vec2(fbm(q + vec2(0., t * .06)), fbm(q + vec2(5.2, 1.3) - t * .05));
  vec2 w2 = vec2(fbm(q + 3. * w1 + vec2(1.7, 9.2)), fbm(q + 3. * w1 + vec2(8.3, 2.8) + t * .04));
  float m = fbm(q + 3. * w2);
  float bands = sin(m * 14.) * .5 + .5;
  vec3 ink = mix(vec3(.1, .1, .2), vec3(.24, .26, .62), smoothstep(.3, .7, w2.x));
  color = mix(vec3(.96, .94, .89), ink, smoothstep(.42, .58, bands) * .92);
  color = mix(color, vec3(.96, .76, .32), smoothstep(.965, 1., bands) * .85);`),

  // Caustics: pool light dancing over teal.
  caustics: letterShader(`
  vec2 q = p * 4.5;
  vec2 id = floor(q), f = fract(q);
  float f1 = 8., f2 = 8.;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 h = vec2(hash(id + o), hash(id + o + 9.1));
    vec2 pt = o + .5 + .42 * sin(t * .9 + 6.2831 * h);
    float d = length(pt - f);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
  }
  float net = pow(1. - smoothstep(0., .22, f2 - f1), 2.);
  float shimmer = fbm(p * 3. + t * .2);
  color = mix(vec3(.02, .38, .5), vec3(.08, .62, .72), shimmer);
  color += vec3(.7, 1., .98) * net * .9;
  color = mix(color, vec3(.7, 1., .98), rim * .35);`),

  // Lava lamp: hot blobs rising and merging through deep red.
  lava: letterShader(`
  float field = 0.;
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float h = hash(vec2(fi, 3.1));
    vec2 c = vec2(fract(h * 7.3 + fi * .37) * aspect, 1.3 - fract(t * .06 * (.6 + h) + h) * 1.6);
    c.x += .15 * sin(t * .4 + fi);
    float r = .2 + .12 * h;
    field += r * r / max(dot(p - c, p - c), .0005);
  }
  float blob = smoothstep(.85, 1.15, field);
  vec3 base = mix(vec3(.66, .12, .42), vec3(.9, .2, .22), uv.y);
  vec3 hot = mix(vec3(1., .45, .12), vec3(1., .88, .45), smoothstep(1.2, 3., field));
  color = mix(base, hot, blob);
  color = mix(color, vec3(1., .6, .5), rim * .4);`),

  // Note rain: osu!mania notes falling down lanes inside the letters, with a
  // flash where they cross the hit line under the x-height.
  "note-rain": letterShader(`
  float lane = .15;
  float col = floor(p.x / lane);
  float cx = fract(p.x / lane);
  float speed = .55 + .25 * hash(vec2(col, 1.));
  float ny = uv.y - t * speed + hash(vec2(col, 4.));
  float slot = floor(ny * 3.2);
  float fy = fract(ny * 3.2);
  float has = step(.35, hash(vec2(col, slot)));
  float note = has * smoothstep(.05, .14, cx) * smoothstep(.95, .86, cx) * smoothstep(0., .06, fy) * smoothstep(.34, .28, fy);
  vec3 laneColor = mod(col, 2.) < 1. ? vec3(.92, .94, 1.) : vec3(1., .45, .76);
  vec3 base = mix(vec3(.32, .24, .62), vec3(.46, .34, .78), uv.y);
  base += .05 * smoothstep(.02, 0., abs(cx - .02));
  color = mix(base, laneColor, note);
  float hitY = .74;
  float hny = hitY - t * speed + hash(vec2(col, 4.));
  float hfy = fract(hny * 3.2);
  float hit = step(.35, hash(vec2(col, floor(hny * 3.2)))) * smoothstep(0., .06, hfy) * smoothstep(.34, .28, hfy);
  color += laneColor * hit * smoothstep(.16, 0., abs(uv.y - hitY)) * .7;
  color = mix(color, vec3(.86, .82, 1.), rim * .5);`),

  // Dithering: a moving gradient in four Game Boy greens, ordered dither.
  dither: letterShader(`
  vec2 px = floor(gl_FragCoord.xy / 3.);
  vec2 b = mod(px, 4.);
  float bayer = 0.;
  {
    float bx = b.x, by = b.y;
    float m = mod(bx, 2.) * 2. + mod(by, 2.) * 3. - 4. * mod(bx, 2.) * mod(by, 2.);
    float m2 = floor(bx / 2.) * 2. + floor(by / 2.) * 3. - 4. * floor(bx / 2.) * floor(by / 2.);
    bayer = (m * 4. + m2 + .5) / 16.;
  }
  float v = fbm(p * 1.8 + vec2(t * .25, 0.)) * .7 + depth * .45 + .12 * sin(p.x * 3. - t * 1.2) - .05;
  float level = clamp(floor(v * 3. + bayer), 0., 3.);
  vec3 c0 = vec3(.19, .38, .19), c1 = vec3(.36, .56, .2), c2 = vec3(.55, .67, .06), c3 = vec3(.78, .86, .38);
  color = level < .5 ? c0 : level < 1.5 ? c1 : level < 2.5 ? c2 : c3;
  color = mix(color, c3, rim * .35);`),

  // Mesh gradient: soft colour blobs morphing.
  mesh: letterShader(`
  vec2 q = p * .9;
  q += .3 * vec2(fbm(q + t * .1), fbm(q - t * .1 + 3.));
  vec3 cols[4] = vec3[4](vec3(1., .55, .75), vec3(.45, .62, 1.), vec3(.72, .48, 1.), vec3(1., .78, .55));
  vec3 acc = vec3(0.);
  float wsum = 0.;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    vec2 c = vec2(fract(.23 + fi * .31) * aspect + .4 * aspect * sin(t * .17 + fi * 1.7), .5 + .45 * sin(t * .23 + fi * 2.3));
    float w = 1. / (.02 + pow(length(q - c * .9), 2.2));
    acc += cols[i] * w;
    wsum += w;
  }
  color = acc / wsum;
  color = mix(color, vec3(1.), rim * .2);`),
};

// Glitch: the name torn into shifted slices with an RGB split, in bursts.
// language=GLSL
const glitchShader = `${PRELUDE}
void main() {
  vec2 uv = v_imageUV;
  float aspect = u_imageAspectRatio;
  float t = u_time;
  float step12 = floor(t * 12.);
  float burst = step(.78, hash(vec2(floor(t * 2.5), 1.)));
  float band = floor(uv.y * 12.);
  float shift = (hash(vec2(band, step12)) - .5) * .18 * burst * step(.45, hash(vec2(band, step12 + 3.)));
  vec2 g = uv + vec2(shift / aspect, 0.);
  float split = (.012 + .03 * burst) / aspect;
  float r = glyph(g + vec2(split, 0.));
  float gc = glyph(g);
  float b = glyph(g - vec2(split, 0.));
  float alpha = max(gc, max(r, b));
  vec3 color = vec3(r, gc, b);
  color = mix(color, vec3(1.), gc * .6);
  // a stray block flipped to cyan now and then
  vec2 blk = floor(uv * vec2(8., 4.));
  float flip = burst * step(.9, hash(blk + step12));
  color = mix(color, vec3(.3, 1., .95), flip * gc);
  color *= .88 + .12 * sin(uv.y * 160.);
  fragColor = vec4(color * alpha, alpha);
}
`;

const SIZING = {
  u_fit: ShaderFitOptions.contain,
  u_scale: 1,
  u_rotation: 0,
  u_offsetX: 0,
  u_offsetY: 0,
  u_originX: 0.5,
  u_originY: 0.5,
  u_worldWidth: 0,
  u_worldHeight: 0,
};

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

async function blobImage(blob: Blob): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await loadImage(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/* The name as the span lays it out: white glyphs on transparent, the size of
   the span's padding box (times `scale`), with an ellipsis when it is cut. */
function drawNameMask(span: HTMLElement, scale: number): { url: string; aspect: number } | null {
  const style = getComputedStyle(span);
  const width = span.clientWidth;
  const height = span.clientHeight;
  if (width < 4 || height < 4) return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(scale, scale);
  const fontAt = (px: number) => `${style.fontStyle} ${style.fontWeight} ${px}px ${style.fontFamily}`;
  let fontPx = parseFloat(style.fontSize);
  ctx.font = fontAt(fontPx);
  // a font's own letter spacing (Arcade is tightened), where canvas supports it
  if ("letterSpacing" in ctx && style.letterSpacing !== "normal") ctx.letterSpacing = style.letterSpacing;
  // Canvas text ignores font-size-adjust (name fonts use it), so size the
  // mask from the width the page actually lays the name out at.
  const textNode = [...span.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
  if (textNode && textNode.textContent) {
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const laidOut = range.getBoundingClientRect().width;
    const drawn = ctx.measureText(textNode.textContent).width;
    if (laidOut > 0 && drawn > 0) {
      fontPx *= laidOut / drawn;
      ctx.font = fontAt(fontPx);
    }
  }
  ctx.fillStyle = "#fff";
  const padLeft = parseFloat(style.paddingLeft) || 0;
  const padRight = parseFloat(style.paddingRight) || 0;
  const padTop = parseFloat(style.paddingTop) || 0;
  const padBottom = parseFloat(style.paddingBottom) || 0;
  const room = width - padLeft - padRight;
  let text = span.textContent ?? "";
  // only when the page itself cuts the name (box widths round, so measuring
  // against them would cut names that fit)
  if (span.scrollWidth > span.clientWidth + 1) {
    while (text.length > 1 && ctx.measureText(`${text}…`).width > room) text = text.slice(0, -1);
    text = `${text}…`;
  }
  // CSS centres the font's ascent + descent in the line box.
  const metrics = ctx.measureText(text);
  const ascent = metrics.fontBoundingBoxAscent;
  const descent = metrics.fontBoundingBoxDescent;
  const lineHeight = height - padTop - padBottom;
  const baseline = padTop + (lineHeight - (ascent + descent)) / 2 + ascent;
  ctx.fillText(text, padLeft, baseline);
  return { url: canvas.toDataURL("image/png"), aspect: width / height };
}

type Built = { shader: string; uniforms: Record<string, unknown>; mipmaps?: string[] };

/* Liquid Metal's preprocessing of a name's mask takes a noticeable moment;
   keep the last few so hovering back over chrome or molten gold is instant. */
const liquidMetalImages = new Map<string, Promise<HTMLImageElement>>();
function processedLiquidMetal(maskUrl: string): Promise<HTMLImageElement> {
  let image = liquidMetalImages.get(maskUrl);
  if (!image) {
    image = toProcessedLiquidMetal(maskUrl).then((processed) => blobImage(processed.pngBlob));
    image.catch(() => liquidMetalImages.delete(maskUrl));
    liquidMetalImages.set(maskUrl, image);
    if (liquidMetalImages.size > 8) liquidMetalImages.delete(liquidMetalImages.keys().next().value!);
  }
  return image;
}

async function buildStyle(style: ShaderNameStyle, mask: { url: string; aspect: number }): Promise<Built> {
  if (style === "chrome" || style === "molten-gold") {
    const image = await processedLiquidMetal(mask.url);
    const gold = style === "molten-gold";
    return {
      shader: nameLiquidMetalShader,
      mipmaps: ["u_image"],
      uniforms: {
        u_image: image,
        u_colorBack: getShaderColorFromString("#00000000"),
        // a colour-burn tint turns the silver to gold
        u_colorTint: getShaderColorFromString(gold ? "#ffbf47" : "#ffffff"),
        u_contour: 0.5,
        u_distortion: gold ? 0.18 : 0.1,
        u_softness: gold ? 0.3 : 0.15,
        // more stripes for longer names, so the bands repeat along them
        u_repetition: Math.min(4, Math.max(2.5, mask.aspect * 0.6)),
        u_shiftRed: gold ? 0.15 : 0.3,
        u_shiftBlue: gold ? 0.15 : 0.3,
        u_angle: 90,
        u_isImage: true,
        u_shape: LiquidMetalShapes.none,
      },
    };
  }
  const image = await loadImage(mask.url);
  return { shader: style === "glitch" ? glitchShader : OWN_SHADERS[style], uniforms: { u_image: image } };
}

/* Mounts the live look in `host` (an absolutely placed box over `span`) and
   calls `onReady` once it draws. Returns the cleanup. */
export function mountNameShader(span: HTMLElement, host: HTMLElement, style: ShaderNameStyle, onReady: () => void): () => void {
  let mount: ShaderMount | null = null;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unqueue: (() => void) | undefined;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const build = async () => {
    await document.fonts.ready;
    if (disposed) return;
    const scale = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
    const mask = drawNameMask(span, scale);
    if (!mask) return;
    const built = await buildStyle(style, mask);
    if (disposed) return;
    const uniforms = { ...built.uniforms, ...SIZING } as ConstructorParameters<typeof ShaderMount>[2];
    if (mount) {
      mount.setUniforms(uniforms);
      onReady();
      return;
    }
    // a context and a compile each, so a list of names starts one at a time
    unqueue?.();
    unqueue = queueGpuWork(() => {
      if (disposed || mount) return;
      mount = new ShaderMount(host, built.shader, uniforms, { premultipliedAlpha: true }, still ? 0 : 1, 3, 2, undefined, built.mipmaps);
      onReady();
    });
  };

  // drawing the mask (and the liquid metals' processing of it) is heavy too,
  // so the first build waits its turn
  let unbuild: (() => void) | undefined = queueGpuWork(() => {
    unbuild = undefined;
    build().catch(() => {});
  });
  // Rebuild the mask when the name's box changes (resizes, truncation).
  let lastSize = `${span.clientWidth}x${span.clientHeight}`;
  const observer = new ResizeObserver(() => {
    const size = `${span.clientWidth}x${span.clientHeight}`;
    if (size === lastSize) return;
    lastSize = size;
    clearTimeout(timer);
    timer = setTimeout(() => build().catch(() => {}), 150);
  });
  observer.observe(span);

  return () => {
    disposed = true;
    clearTimeout(timer);
    unbuild?.();
    unqueue?.();
    observer.disconnect();
    // dispose() leaves the context to the garbage collector, and a page that
    // swaps names fast runs into the browser's cap of live contexts first
    const gl = mount?.canvasElement.getContext("webgl2");
    mount?.dispose();
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  };
}
