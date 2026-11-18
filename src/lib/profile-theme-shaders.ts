import type { SupporterProfileThemeId } from "./supporter-profile-themes";

/* The backdrops of the supporter profile themes, one GLSL ES 3.0 fragment
   shader each, drawn full-bleed behind a profile (profile-theme-gl.ts runs
   them). Every one defines `vec3 theme(vec2 uv, vec2 p, float t)`: `uv` runs
   0..1 over the canvas with y up, `p` is centred and measured in canvas
   heights, `t` is seconds. Shared inputs:
   - u_scroll: how far the page has scrolled, in viewport heights, so a
     backdrop can drift by at its own depth (0 where there is no page);
   - u_pointer: the pointer over the canvas, 0..1 with y up, eased;
   - PX: one canvas pixel in `p` units, to keep small things from vanishing
     in a thumbnail.
   They stay dark: white text and the page's panels sit on top. */

export const PROFILE_THEME_VERTEX = `#version 300 es
in vec2 a_position;
void main() { gl_Position = vec4(a_position, 0., 1.); }
`;

// language=GLSL
export const PROFILE_THEME_PRELUDE = `#version 300 es
precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform vec2 u_pointer;
uniform float u_scroll;
out vec4 fragColor;
float PX;

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
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.03 + 7.1;
    a *= .5;
  }
  return v;
}

// Value noise on an integer hash. The float hash above is chaotic in the
// last bit of its input, and some phone GPUs (Adreno) round the corner two
// cells share differently from each side, so its noise tears along its grid:
// the Universe Shifter's ink came out in boxes cut along rings, and Sakura's
// canopy in squares. Integer maths gives every GPU the same bits, once ints
// are full precision: a fragment shader's default is mediump, 16 bits on
// phones, where the multiplies overflow and every value comes out the same.
// Shifted positive before the uint conversion, which is undefined for
// negatives. Themes tuned on the float noise keep it; new ones use these.
precision highp int;

float ihash(ivec2 c) {
  uvec2 q = uvec2(c + 0x40000000) * uvec2(1597334673u, 3812015801u);
  return float(((q.x ^ q.y) * 1597334673u) >> 8) * (1. / 16777216.);
}

float inoise(vec2 p) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(ihash(i), ihash(i + ivec2(1, 0)), f.x), mix(ihash(i + ivec2(0, 1)), ihash(i + ivec2(1, 1)), f.x), f.y);
}

float ifbm(vec2 p) {
  float v = 0., a = .5;
  for (int i = 0; i < 5; i++) {
    v += a * inoise(p);
    p = p * 2.03 + 7.1;
    a *= .5;
  }
  return v;
}

mat2 rot(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

vec2 pointerP() {
  return (u_pointer - .5) * vec2(u_res.x / u_res.y, 1.);
}

/* Twinkling points: \`scale\` cells per unit, \`density\` the share of cells lit.
   Each layer's grid is turned its own way and a star sits anywhere in its
   cell, mostly tiny with now and then a bigger one, so no rows show. */
float stars(vec2 p, float scale, float density, float t) {
  vec2 cell = rot(scale * 1.37) * p * scale;
  vec2 id = floor(cell);
  vec2 f = fract(cell);
  float h = hash(id);
  if (h > density) return 0.;
  float size = pow(hash(id + 7.7), 5.);
  // a pixel or two across, whatever the layer: brighter stars are a touch bigger, never a disc
  float r = max(.02, PX * scale * (1.3 + 1.3 * size));
  vec2 o = r + vec2(hash(id + 1.3), hash(id + 2.7)) * (1. - 2. * r);
  float tw = .7 + .3 * sin(t * (.6 + 2.4 * hash(id + 5.)) + h * 40.);
  // a crisp point, not a soft disc
  return smoothstep(r, r * .35, length(f - o)) * tw * (.3 + .55 * hash(id + 9.1) + .5 * size) * min(1., .06 / r);
}

/* Distance between the nearest and second nearest cell points: 0 on a cell's edge. */
float voronoiEdge(vec2 x) {
  vec2 n = floor(x), f = fract(x);
  float m1 = 8., m2 = 8.;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = vec2(hash(n + g), hash(n + g + 7.3));
      float d = length(g + o - f);
      if (d < m1) { m2 = m1; m1 = d; } else if (d < m2) { m2 = d; }
    }
  }
  return m2 - m1;
}
`;

export const PROFILE_THEME_MAIN = `
void main() {
  PX = 1. / u_res.y;
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - .5 * u_res) / u_res.y;
  vec3 col = theme(uv, p, u_time);
  // a touch of noise, so the dark gradients do not band
  col += (hash(gl_FragCoord.xy + fract(u_time) * 31.) - .5) / 180.;
  fragColor = vec4(max(col, 0.), 1.);
}
`;

const shader = (body: string) => `${PROFILE_THEME_PRELUDE}\n${body}\n${PROFILE_THEME_MAIN}`;

// language=GLSL
export const PROFILE_THEME_SHADERS: Record<SupporterProfileThemeId, string> = {
  // Aurora: curtains of light hung high over a still lake, seen from its
  // shore: ribbons crossing the sky, bright along the lower edge, fading up
  // from green into violet, and again in the water. They gather toward the
  // pointer.
  aurora: shader(`
/* Aurora: curtains of light hung high over a still lake, seen from its
   shore. They run across the sky in ribbons, bright along the lower edge and
   fading upward from green into violet, fine rays standing in them. */
const float AU_HZ = -.15;   // where the far shore sits on the page

/* How much of ribbon k hangs over the point P of the sky (x across, y away
   from the eye), and how bright its rays are there. wide is how far a sight
   line moves across the sky between one height and the next, so a ribbon far
   off stays a ribbon instead of breaking into copies. */
float auRibbon(vec2 P, float t, float k, float wide) {
  float mid = 1.9 + k * 1.7 + (.32 - k * .3) * P.x + 1.05 * sin(P.x * .62 + k * 2.3 + t * .05) + .5 * sin(P.x * 1.55 - k * 1.1 - t * .08) + .7 * (inoise(vec2(P.x * .55 + t * .03, k * 5.)) - .5);
  float w = .17 + .09 * sin(P.x * .5 + k * 1.7 + t * .04);
  float we = sqrt(w * w + wide * wide);
  float d = (P.y - mid) / we;
  if (abs(d) > 2.6) return 0.;
  float far = smoothstep(4., 16., length(P));
  float rays = inoise(vec2(P.x * 6.5 + t * .22 * (k == 1. ? -1. : 1.), k * 7. + t * .06));
  rays = mix(.12 + 2.1 * rays * rays * rays, .5, far);
  // brightness travels along it in slow swells
  float swell = .4 + .6 * (.5 + .5 * sin(P.x * .6 - t * .28 + k * 2.));
  return exp(-d * d) * (w / we) * rays * swell;
}

/* The curtains' light along a sight line: the sky sampled at a few heights
   between their lower edge and their tops. */
vec3 auCurtains(vec3 rd, float t, int steps, float jitter) {
  vec3 sum = vec3(0.);
  float run = length(rd.xz) / rd.y;
  for (int j = 0; j < 12; j++) {
    if (j >= steps) break;
    float a = (float(j) + jitter) / float(steps);
    float h = mix(1., 2.4, a);
    vec2 P = rd.xz / rd.y * h;
    float wide = run * 1.4 / float(steps);
    float glow = auRibbon(P, t, 0., wide) + auRibbon(P, t, 1., wide) * .8 + auRibbon(P, t, 2., wide) * .6;
    vec3 tint = mix(vec3(.16, 1., .5), vec3(.62, .26, 1.), smoothstep(.2, .8, a));
    tint = mix(tint, vec3(.9, 1., .75), smoothstep(.12, 0., a) * .5);
    sum += tint * glow * (exp(-a * 5.) * 1.6 + exp(-a * 1.3) * .7) / (1. + dot(P, P) * .01);
  }
  return sum * 7.6 / float(steps) * smoothstep(.015, .16, rd.y);
}

/* The night sky behind them. */
vec3 auSky(vec2 p, float y, float t) {
  vec3 col = mix(vec3(.02, .06, .09), vec3(.004, .012, .035), smoothstep(0., .5, y));
  // the Milky Way, faint and aslant
  vec2 m = rot(.5) * p;
  float way = exp(-pow(m.y * 3.2 - .3, 2.)) * (.4 + .6 * ifbm(m * 3. + 7.));
  col += vec3(.05, .06, .1) * way * .6;
  col += vec3(.8, .88, 1.) * (stars(p, 28., .16, t) + .6 * stars(p + 3.1, 60., .2 + .2 * way, t)) * smoothstep(0., .12, y);
  return col;
}

/* A line of spruce: how far the tops reach above the ground at x. */
float auSpruce(float x, float y, float scale, float seed) {
  float c = x * scale + seed * 13.;
  float id = floor(c), f = fract(c) - .5;
  float tall = (.35 + .65 * hash(vec2(id, seed))) * (.5 + 1.1 * inoise(vec2(x * 2.3, seed * 3.))) / scale * 2.1;
  float up = y / tall;
  if (up > 1. || up < 0.) return up < 0. ? 1. : 0.;
  // boughs: the outline steps in and out on the way up
  float half_ = .5 * (1. - up) * (.6 + .4 * fract(up * 6. + hash(vec2(id, seed + 1.))));
  return smoothstep(half_ + PX * scale, half_ - PX * scale, abs(f));
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float sc = min(u_scroll, 3.);
  vec2 ptr = pointerP();
  // the shore drifts up a little as the page scrolls
  float hz = AU_HZ + sc * .07;
  float y = p.y - hz;
  float jitter = .5 + (hash(gl_FragCoord.xy) - .5) * .12;
  vec3 col;
  if (y > 0.) {
    vec3 rd = normalize(vec3(p.x, y, 1.05));
    col = auSky(p, y, t);
    vec3 glow = auCurtains(rd, t, 12, jitter);
    // they gather toward the pointer
    col += glow * (1. + .6 * exp(-length(p - ptr) * 3.));
    // far hills, then the spruce along the shore
    float hill = .018 + .05 * ifbm(vec2(p.x * 1.7, 2.));
    col = mix(col, vec3(.012, .03, .045) + glow * .04, smoothstep(PX, -PX, y - hill));
    float trees = max(max(auSpruce(p.x, y - .008, 40., 1.) * .85, auSpruce(p.x + .013, y - .003, 27., 3.)), auSpruce(p.x, y, 17., 2.));
    col = mix(col, vec3(.003, .008, .012), trees);
  } else {
    // the lake: the sky upside down, drawn out and broken by the water
    float dy = -y;
    float rip = inoise(vec2(p.x * 9., dy * 70. - t * .25)) - .5;
    vec2 pr = vec2(p.x + rip * (.012 + dy * .05), dy * (.92 + .1 * rip));
    vec3 rd = normalize(vec3(pr.x, pr.y, 1.05));
    col = auSky(vec2(pr.x, hz + pr.y), pr.y, t) * .5;
    col += auCurtains(rd, t, 6, jitter) * .8 * (1. + .6 * exp(-length(vec2(p.x, hz + dy) - ptr) * 3.));
    float hill = .018 + .05 * ifbm(vec2(pr.x * 1.7, 2.));
    float trees = max(max(max(auSpruce(pr.x, pr.y - .008, 40., 1.) * .85, auSpruce(pr.x + .013, pr.y - .003, 27., 3.)), auSpruce(pr.x, pr.y, 17., 2.)), smoothstep(PX * 3., -PX * 3., pr.y - hill) * .8);
    col = mix(col, vec3(.003, .008, .012), trees);
    // the water itself, darker toward the near shore, a pale line where it meets the far one
    col *= .55 + .45 * exp(-dy * 2.2);
    col += vec3(.03, .09, .09) * exp(-dy * 60.) * .5;
    col += vec3(.01, .02, .03) * smoothstep(.05, .6, dy);
  }
  col *= 1. - .25 * dot(p, p);
  return col;
}
`),

  // Sakura: dusk under a soft blossom canopy along the top of the hero,
  // with lantern glows far behind. The petals falling through it are real
  // geometry, drawn over this by profile-theme-petals.ts.
  sakura: shader(`
vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  vec3 col = mix(vec3(.04, .012, .03), vec3(.11, .035, .075), smoothstep(-.5, .55, p.y));
  col += vec3(.17, .05, .1) * exp(-length(p - vec2(.35, .45)) * 1.8);
  // a blossom canopy far out of focus along the top of the hero, thickest
  // in its right corner, riding away with it: just a soft pink haze
  float top = p.y - u_scroll - .5;
  float clump = ifbm(vec2(p.x * 1.8 + t * .01, (p.y - u_scroll) * 1.8));
  float reach = .18 + .14 * smoothstep(-.2, .6, p.x / aspect) + .12 * (clump - .5);
  float canopy = smoothstep(-reach - .08, -reach + .1, top);
  vec3 bloom = mix(vec3(.36, .1, .22), vec3(.85, .45, .62), smoothstep(.35, .75, clump));
  col = mix(col, bloom * .6, canopy * .8);
  // a few lantern glows far behind, very soft
  vec2 bq = (p - vec2(0., u_scroll * .4)) * 1.6 + vec2(t * .02, 0.);
  vec2 bid = floor(bq);
  vec2 bf = fract(bq) - .5 - (vec2(hash(bid + 2.), hash(bid + 4.)) - .5) * .4;
  float bok = exp(-dot(bf, bf) * 30.) * step(.75, hash(bid));
  col += mix(vec3(1., .5, .65), vec3(1., .75, .55), hash(bid + 6.)) * bok * .06;
  return col;
}`),

  // Synthwave: a striped sun over a neon grid racing toward you; the sky
  // scrolls away with the hero until the grid is all there is. The grid
  // steers after the pointer.
  synthwave: shader(`
vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  // the sky and sun belong to the hero and scroll away with it, leaving the grid
  float hz = .05 + min(u_scroll, 1.);
  // the grid, worked out for every pixel so its derivatives hold at the horizon.
  // Its horizon stops just above the top edge: one sitting higher would bring
  // the floor so close that a cell outgrows the screen, leaving one line
  // standing and single lines flashing past.
  float dy = max(min(hz, .58) - p.y, 1e-3);
  // past the hero the cells shrink, so the grid behind the content stays a grid
  float z = .3 / dy * mix(1., 3., smoothstep(.3, 1.3, u_scroll));
  vec2 g = vec2((p.x - (u_pointer.x - .5) * .25) * z * 1.6, z + t * 1.4);
  vec2 a = abs(fract(g - .5) - .5) / max(fwidth(g), 1e-4);
  vec3 col;
  if (p.y > hz) {
    float h = p.y - hz;
    col = mix(vec3(.4, .05, .32), vec3(.05, .01, .13), smoothstep(0., .45, h));
    col += vec3(.75, .85, 1.) * stars(p, 40., .12, t) * smoothstep(.05, .35, h) * .7;
    vec2 c = vec2(aspect * .27, hz + .2);
    float r = .13;
    float d = length(p - c);
    float y = (p.y - c.y) / r;
    float cut = step(.5, fract(y * 5.5 + t * .35)) + step(.15, y);
    float sun = smoothstep(r + PX * 2., r - PX * 2., d) * min(cut + step(-.05, y), 1.);
    vec3 sunCol = mix(vec3(1., .2, .55), vec3(1., .86, .32), smoothstep(-r, r, p.y - c.y));
    col = mix(col, sunCol, sun);
    col += vec3(1., .3, .5) * exp(-max(d - r, 0.) * 7.) * .35;
  } else {
    float line = 1. - min(min(a.x, a.y), 1.);
    float glow = exp(-min(a.x, a.y) * .25) * .35;
    float fade = smoothstep(0., .22, dy);
    col = vec3(.035, .0, .07) + vec3(.25, .05, .3) * exp(-dy * 6.);
    col += mix(vec3(1., .2, .75), vec3(.25, .8, 1.), smoothstep(.0, .5, dy)) * (line + glow) * fade * .8;
  }
  col += vec3(1., .35, .7) * exp(-abs(p.y - hz) * 22.) * .55;
  return col;
}`),

  // Deep sea: caustic light near the surface, slanted god rays, bubbles
  // rising; the water darkens as the page scrolls deeper.
  abyss: shader(`
float caustic(vec2 uv, float time) {
  vec2 p = uv * 6.28318 - 250.;
  vec2 i = p;
  float c = 1.;
  float inten = .005;
  for (int n = 0; n < 4; n++) {
    float tt = time * (1. - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1. / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 4.;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.);
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float sc = u_scroll;
  float depth = max(.5 - p.y + sc * .55, 0.);
  vec3 col = mix(vec3(.02, .17, .24), vec3(.0, .01, .025), smoothstep(0., 1.7, depth));
  float c = caustic(p * .9 + vec2(0., sc * .5), t * .35 + 23.);
  col += vec3(.3, .85, 1.) * min(c, 1.2) * exp(-depth * 2.) * .35;
  float slant = p.x + p.y * .35;
  float rays = smoothstep(.45, .9, fbm(vec2(slant * 5., t * .1)));
  col += vec3(.2, .6, .75) * rays * exp(-depth * 1.3) * .3;
  // bubbles in three depths, tiny and many far off, few and large up close.
  // Each column has one size, so one rise speed: bigger bubbles climb faster
  // and sway wider, and the biggest flatten and wobble as they go. An air
  // bubble in water mirrors the lit water at its edge, so the rim is a bright
  // silver that fades inward, with a sharp window of light at the top and a
  // soft crescent where that light leaves at the bottom. The near layer is out
  // of focus. Some columns are streams, strings of small bubbles on one path.
  float lit = .3 + .7 * exp(-depth * .7) + rays * .6;
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float s = 20. / (1. + fl * 1.6);
    vec2 q = p * s;
    float cx = floor(q.x);
    float hc = hash(vec2(cx, fl * 13.));
    float stream = step(.86, hash(vec2(cx, fl * 13. + 5.)));
    // radius in cell units, mostly small
    float r = mix(.09 + .2 * pow(hc, 3.), .07 + .04 * hc, stream);
    float rw = r / s;
    float speed = (.04 + .5 * sqrt(rw)) * (1. + fl * .15);
    float yShift = t * speed * s + sc * s * (.2 + fl * .13);
    q.y -= yShift;
    vec2 id = vec2(cx, floor(q.y));
    float h = hash(id + fl * 31.);
    if (h > mix(.13, .62, stream)) continue;
    float blur = fl * fl * .025;
    float wob = smoothstep(.012, .05, rw);
    float room = .5 - r * (1.25 + blur);
    // where along its own wavering path the bubble is
    float yw = id.y + .5 + yShift;
    float ph = yw * mix((2.2 - 1.2 * wob) / (1. + r * 4.), .35, stream) + hc * 40. + t * .5 * stream;
    float sway = min(room, mix(.03 + r * .7, .22, stream));
    vec2 c = vec2(.5 + sin(ph) * sway, .5 + (hash(id + 3.3) - .5) * room * mix(1.6, .5, stream));
    r *= mix(.9 + .2 * hash(id + 7.), .6 + .8 * hash(id + 7.), stream);
    vec2 e = (fract(q) - c) / r;
    // big ones flatten, tilt with the sway and quiver
    e = rot(cos(ph) * .35 * wob) * e;
    float squash = 1. + wob * (.14 + .07 * sin(t * 9. + h * 60.));
    e *= vec2(1. / squash, squash);
    float n = length(e);
    float aa = PX * s / r * 1.4 + blur;
    float inside = smoothstep(1. + aa * .5, 1. - aa * .5, n);
    if (inside <= 0.) continue;
    float rim = pow(min(n, 1.), 6.) + .55 * smoothstep(1. - aa - .12, 1. - aa * .3, n);
    float window = smoothstep(.2 + aa * .4, .08, length((e - vec2(-.32, .44)) * vec2(1., 1.5)));
    float crescent = smoothstep(.45, .9, n) * smoothstep(1., .8, n) * smoothstep(-.1, -.75, e.y);
    float glint = smoothstep(.1 + aa * .3, .03, length(e - vec2(.42, -.5)));
    float fade = (.5 + fl * .25) * lit * (1. - blur * 2.);
    col *= 1. - inside * .18;
    col += vec3(.45, .8, .95) * inside * (rim * .55 + crescent * .5) * fade;
    col += vec3(.85, .97, 1.) * (window + glint * .35) * inside * fade * (1. - blur * 3.);
  }
  // marine snow
  col += vec3(.5, .75, .8) * stars(p + vec2(t * .006, t * .012 - sc * .4), 46., .12, t * .3) * .35;
  return col;
}`),

  // Nebula: clouds of violet and rose gas, four layers of stars at their own
  // depths, a shooting star now and then; the gas brightens near the pointer.
  cosmos: shader(`
vec3 theme(vec2 uv, vec2 p, float t) {
  float sc = u_scroll;
  vec2 np = p * 1.5 + vec2(t * .012, -sc * .1);
  float w1 = fbm(np + vec2(t * .015, 0.));
  float w2 = fbm(np * 1.3 + w1 * 1.8 + vec2(-t * .012, t * .008));
  float neb = smoothstep(.28, .78, w2);
  vec3 nebCol = mix(vec3(.12, .3, .85), vec3(.42, .14, .7), smoothstep(.3, .7, w1));
  nebCol = mix(nebCol, vec3(.95, .32, .55), smoothstep(.62, .9, w2));
  vec3 col = vec3(.008, .006, .022) + nebCol * neb * .75 + nebCol * pow(neb, 4.) * .5;
  col *= .55 + .45 * smoothstep(.2, .6, fbm(np * 2.4 + 5.));
  col += mix(vec3(.05, .03, .14), vec3(.12, .03, .1), smoothstep(.3, .7, w1)) * smoothstep(.2, .7, w1);
  col += nebCol * neb * .3 * exp(-length(p - pointerP()) * 2.6);
  col += vec3(.85, .9, 1.) * stars(p - vec2(0., sc * .05), 22., .12, t);
  col += vec3(.8, .85, 1.) * stars(p - vec2(0., sc * .12) + 1.7, 44., .16, t) * .65;
  col += vec3(.75, .8, 1.) * stars(p - vec2(0., sc * .24) + 4.3, 84., .22, t) * .4;
  // a few nearer, brighter ones
  col += vec3(.95, .9, 1.) * stars(p - vec2(0., sc * .08) + 9.1, 9., .18, t);
  // shooting star
  float period = 7.;
  float seed = floor(t / period);
  float ph = fract(t / period);
  vec2 dir = normalize(vec2(-.85, -.42));
  vec2 start = vec2((hash(vec2(seed, 1.)) * .9 + .1) * u_res.x / u_res.y * .5, .25 + .2 * hash(vec2(seed, 2.)));
  float run = ph / .12;
  if (run < 1.) {
    vec2 head = start + dir * run * .9;
    vec2 tail = head - dir * .28;
    vec2 pa = p - tail, ba = head - tail;
    float k = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.);
    float d = length(pa - ba * k);
    col += vec3(.85, .9, 1.) * exp(-d / max(PX * 1.2, .0015)) * k * k * sin(run * 3.14159) * 1.2;
  }
  return col;
}`),

  // Code rain: columns of flickering glyphs falling, brightest at the head;
  // the glyphs under the pointer light up.
  terminal: shader(`
vec3 theme(vec2 uv, vec2 p, float t) {
  vec3 col = vec3(.002, .012, .006);
  vec2 cell = vec2(.014, .02);
  vec2 q = vec2(p.x, .5 - p.y + u_scroll * .5) / cell;
  vec2 id = floor(q);
  vec2 f = fract(q);
  float cs = hash(vec2(id.x, 3.7));
  float live = step(.3, hash(vec2(id.x, 5.1)));
  float speed = 10. + 18. * cs;
  float len = 14. + 30. * hash(vec2(id.x, 9.1));
  float period = 70. + 60. * hash(vec2(id.x, 1.3));
  float head = mod(t * speed + cs * 300., period + len);
  float d = head - mod(id.y, period + len);
  float trail = (d >= 0. && d < len) ? pow(1. - d / len, 1.7) : 0.;
  vec2 g = floor(f * vec2(5., 7.));
  float flip = floor(t * (1.5 + 5. * hash(id + 1.)) + hash(id) * 10.);
  float on = step(.5, hash(id * 1.31 + g * 7.17 + flip * .37));
  on *= step(.12, f.x) * step(f.x, .88) * step(.1, f.y) * step(f.y, .9);
  vec3 green = vec3(.18, 1., .42);
  col += green * on * trail * live * .5;
  col += vec3(.75, 1., .82) * on * live * step(0., d) * step(d, 1.) * .85;
  col += green * on * .028;
  col += green * on * .3 * exp(-length(p - pointerP()) * 9.);
  col += green * .025 * exp(-abs(fract(uv.y + t * .06) - .5) * 30.);
  col *= .7 + .3 * smoothstep(.95, .2, length(p * vec2(.75, 1.)));
  return col;
}`),

  // Inferno: a lava field creeping toward the eye. Black crust broken into
  // plates, molten channels braided through it with a skin forming and
  // tearing, sparks lifting off into the smoke.
  inferno: shader(`
/* Inferno: a lava field creeping toward the eye, seen from above and a
   little ahead. Black crust broken into plates, molten channels braided
   through it, sparks lifting off into the smoke. */

/* How hot something glows: black, dull red, orange, yellow, near white. */
vec3 ifGlow(float T) {
  return vec3(clamp(T * 2.4, 0., 1.), clamp(T * T * 1.45, 0., 1.) * .95, clamp(pow(T, 5.) * .75, 0., 1.));
}

/* Sparks: one layer of them, rising and swaying, each drawn out along its
   path with a soft glow round it. */
float ifSparks(vec2 p, float t, float scale, float seed) {
  vec2 q = p * scale + vec2(seed * 7.3, -t * (.55 + .2 * seed));
  q.x += .25 * sin(q.y * .5 + seed * 4.);
  vec2 id = floor(q), f = fract(q) - .5;
  float h = hash(id + seed * 13.);
  if (h > .16) return 0.;
  vec2 d = f - (vec2(hash(id + 3.1), hash(id + 5.7)) - .5) * .5;
  float size = pow(hash(id + 8.), 2.5);
  float r = .018 + .04 * size + PX * scale * .8;
  // it flares and gutters as it rises
  float lit = .55 + .45 * sin(t * (3. + 5. * hash(id + 4.)) + h * 50.);
  lit *= smoothstep(0., .2, h / .16);
  float core = smoothstep(r, r * .25, length(d * vec2(1., .55)));
  float halo = exp(-dot(d, d) / (r * r * 9.)) * .35;
  return (core + halo) * lit * (.5 + size);
}

vec3 theme(vec2 uv, vec2 p, float t) {
  vec2 ptr = pointerP();
  // heat off the lava bends the view, more the further off
  vec2 ps = p + (.3 + uv.y) * .0035 * (vec2(inoise(p * 11. + vec2(0., -t * 1.4)), inoise(p * 11. + vec2(7., -t * 1.4))) - .5);
  // the eye: one unit over the field, tipped down
  const float F = 1.25, CS = .777, SN = .629;
  vec3 rd = vec3(ps.x + ptr.x * .03, ps.y * CS - F * SN + ptr.y * .02, ps.y * SN + F * CS);
  float k = 1. / -rd.y;
  vec2 wp = vec2(rd.x, rd.z) * k;
  float far = smoothstep(.5, 3.4, wp.y);
  float foot = k * PX * 1.6;
  // where the pointer rests on the field: the crust breaks open under it
  vec3 prd = vec3(ptr.x * 1.03, ptr.y * (CS + .02) - F * SN, ptr.y * SN + F * CS);
  vec2 away = wp - prd.xz / -prd.y;
  float stir = exp(-dot(away, away) / .07);
  // the whole field creeps toward the eye
  wp.y += t * .035 - u_scroll * .5;
  vec2 warp = vec2(ifbm(wp * 1.4), ifbm(wp * 1.4 + 5.2)) - .5;
  vec2 q = wp + warp * .5;
  // molten channels, braided along the flow
  float n1 = inoise(vec2(q.x * 1.15 + 11., q.y * .42));
  float n2 = inoise(vec2(q.x * 2.3 - 4., q.y * .85 + 3.));
  float ridge = 1. - abs(2. * n1 - 1.);
  float ridge2 = 1. - abs(2. * n2 - 1.);
  float H = smoothstep(.76, 1., ridge) + .4 * smoothstep(.8, 1., ridge2) * smoothstep(.4, .8, ridge);
  H *= .82 + .18 * sin(t * .5 + inoise(wp * .7) * 9.);
  H = clamp(H + stir * .3, 0., 1.);
  // the crust: plates with wandering edges, cracked finer inside
  float e = voronoiEdge(q * 3.6);
  float e2 = voronoiEdge(q * 11. + 3.);
  float cw = mix(.016, .52, pow(H, 1.3)) + foot * 3.6;
  float crack = 1. - smoothstep(cw * .55, cw, e);
  // what flows in the channels: bright threads drawn out along the stream, running faster than the crust
  float thread = ifbm(vec2(q.x * 4., q.y * 1.3 + t * .22) + warp * 2.);
  // heat comes down the cracks in slow surges
  float surge = smoothstep(.5, .85, inoise(wp * .9 - vec2(t * .04, t * .1)));
  float T = crack * mix(.3, .7, H) * (.58 + .52 * thread) * (1. + .7 * surge * (1. - H));
  // where it runs open a skin keeps forming and tearing: dull rafts, bright seams between them
  float open = smoothstep(.3, .85, H) * crack;
  vec2 sq = vec2(q.x * 12., q.y * 6.5 + t * .26) + warp * 5.;
  float se = voronoiEdge(sq);
  float raft = smoothstep(.03, .16, se) * smoothstep(.36, .6, ifbm(sq * .3 + 9.));
  T = mix(T, T * (.42 + .25 * thread), raft * open);
  T += open * (1. - smoothstep(0., .06 + foot * 20., se)) * .2 * (.4 + thread);
  // hairline cracks glow where the rock is still hot underneath
  float hair = (1. - smoothstep(.0, .035 + foot * 9., e2)) * (1. - far * .7);
  T = max(T, hair * (.16 + .5 * H) * (1. - crack));
  // the plates: dark, rough, their rims lit by the lava beside them
  float rough = ifbm(q * 9.);
  vec3 rock = vec3(.05, .04, .04) * (.35 + 1.1 * rough * rough) + vec3(.022, .024, .03) * smoothstep(.1, .5, e) * rough;
  float rim = smoothstep(cw * 3.2 + .05, cw, e) * (.25 + H);
  rock += vec3(.9, .22, .03) * rim * .34 * (.6 + .8 * rough);
  rock += vec3(.5, .06, .0) * H * H * .22;
  vec3 col = mix(rock, ifGlow(T), smoothstep(.02, .26, T));
  // smoke and glow hang over the far field
  float smoke = ifbm(vec2(p.x * 1.6 + t * .03, p.y * 2.4 - t * .05) + warp);
  vec3 haze = vec3(.32, .06, .012) * (.4 + .6 * H) + vec3(.03, .012, .01);
  col = mix(col, haze, far * (.3 + .45 * smoke));
  col *= 1. - .6 * smoothstep(.42, .75, smoke) * (.25 + .75 * far);
  // the far glow, through the smoke
  col += vec3(.34, .07, .015) * pow(far, 2.5) * (.35 + .65 * smoke);
  // sparks, near ones large and soft
  float sp = ifSparks(p, t, 5., 1.) + ifSparks(p + 3., t, 9., 2.) * .8 + ifSparks(p - 5., t, 15., 3.) * .6;
  col += vec3(1., .5, .12) * sp;
  col *= 1. - .32 * dot(p, p);
  return col;
}
`),

  // Frost: a frozen lake at blue hour. Clear black ice, its cracks hanging in
  // the depth like sheets of glass, snow in the air, a ring round the moon.
  // Scrolling tips the eye down until the ice fills the page.
  frost: shader(`
/* Frost: a frozen lake at blue hour, seen from a little over the ice. Clear
   black ice, its cracks hanging in the depth like sheets of glass, snow
   blowing across, a ring round the moon. */
const float FR_H = .5;    // the eye's height over the ice
const float FR_N = 1.31;  // how much ice bends light

float frRidge(float x, float seed) {
  float v = 0., a = .5;
  x += seed * 17.3;
  for (int i = 0; i < 5; i++) {
    float r = 1. - abs(2. * inoise(vec2(x, seed * 3.7 + float(i))) - 1.);
    v += a * r * r;
    x = x * 2.07 + 3.3;
    a *= .5;
  }
  return v;
}

/* How far x is from the nearest wall between two cells. */
float frEdge(vec2 x) {
  ivec2 n = ivec2(floor(x));
  vec2 f = fract(x);
  float m1 = 8., m2 = 8.;
  vec2 p1 = vec2(0.), p2 = vec2(0.);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      ivec2 g = ivec2(i, j);
      vec2 o = vec2(g) + vec2(ihash(n + g), ihash(n + g + ivec2(57, 113))) - f;
      float d = dot(o, o);
      if (d < m1) { m2 = m1; p2 = p1; m1 = d; p1 = o; } else if (d < m2) { m2 = d; p2 = o; }
    }
  }
  return (m2 - m1) / (2. * max(length(p2 - p1), 1e-3));
}

/* One family of cracks in the ice, straight runs meeting at corners. x is
   the crack on the surface, y its wall hanging below, seen through the ice in
   front of it: o is how far a ray runs on for each unit it sinks, D how deep
   the crack goes. */
vec3 frCrack(vec2 wp, vec2 o, float freq, float seed, float foot, float D) {
  vec2 q = rot(seed) * wp * freq + seed * 7.;
  q += .06 * (vec2(inoise(q * 4.), inoise(q * 4. + 9.)) - .5);
  vec2 oq = rot(seed) * o * freq;
  float e = frEdge(q);
  float line = smoothstep((.0016 + foot * 1.5) * freq, foot * .3 * freq, e);
  const float S = .035;
  float slope = (frEdge(q + oq * S) - e) / S;
  float wall = 0.;
  float ds = e / max(-slope, 1e-3);
  if (slope < -.03 && ds < D) {
    vec2 hit = q + oq * ds;
    float k = ds / D;
    // feathered like the inside of a crack: streaks running down it, ripples across
    float fine = smoothstep(.02, .004, foot);
    wall = smoothstep(.02, .2, -slope) * pow(1. - k, .7) * mix(.6, (.2 + .8 * inoise(hit * 34.)) * (.78 + .22 * sin(k * 24. + inoise(hit * 9.) * 6.)), fine);
  }
  // some runs of it are faint, some bright
  float strength = .15 + .85 * smoothstep(.35, .65, inoise(q * .7 + 40.));
  return vec3(line, wall, smoothstep(.16, 0., e)) * strength;
}

/* The sky and the mountains under it, y the height over the horizon. soft
   blurs it, for its reflection in the ice. */
vec3 frSky(vec2 p, float y, float t, float soft) {
  float A = u_res.x / u_res.y;
  vec2 moon = vec2(A * .27, .245);
  vec3 col = mix(vec3(.1, .23, .32), vec3(.012, .03, .07), smoothstep(0., .4, y));
  col += vec3(.09, .05, .13) * exp(-pow((y - .12) / .09, 2.));
  col += vec3(.2, .34, .38) * exp(-y * 13.) * (.35 + .65 * exp(-pow((p.x - moon.x) * 1.1, 2.)));
  col += vec3(.8, .9, 1.) * (stars(p, 24., .14, t) + .6 * stars(p + 7., 46., .12, t)) * smoothstep(.06, .3, y) * (1. - soft * 8.);
  // thin high cloud
  col += vec3(.1, .16, .2) * smoothstep(.5, .85, ifbm(vec2(p.x * 1.4 + t * .006, y * 9.))) * smoothstep(.02, .2, y) * .5;
  // the moon, and the ring the ice in the air draws round it
  vec2 dm = vec2(p.x - moon.x, y - moon.y);
  float dn = length(dm);
  col += vec3(.92, .96, 1.) * smoothstep(.022 + soft + PX, .022 - soft - PX, dn) * (.78 + .22 * smoothstep(.35, .6, inoise(dm * 90. + 5.)));
  col += vec3(.3, .46, .56) * (exp(-dn * 10.) * .7 + exp(-pow((dn - .15) / (.01 + soft), 2.)) * .13 + exp(-dn * 2.5) * .12);
  // far mountains, pale with the air between; nearer ones, moonlit snow on the faces turned to it
  float h1 = .025 + .12 * frRidge(p.x * 1.9, 1.);
  col = mix(col, mix(vec3(.05, .1, .15), vec3(.085, .16, .22), smoothstep(0., h1, y)), smoothstep(PX + soft, -PX - soft, y - h1));
  float dip = .3 + .7 * smoothstep(.1, .9, abs(p.x - moon.x * .45));
  float h2 = (.012 + .2 * frRidge(p.x * 2.1, 2.)) * dip;
  // its faces: spurs running down from the ridge, the side toward the moon lit
  vec2 mq = vec2(p.x * 11., (y - h2) * 12. + p.x * 2.);
  float m = ifbm(mq);
  float lit = smoothstep(-.012, .012, (m - ifbm(mq + vec2(.07 * sign(moon.x - p.x), .03))));
  float cover = smoothstep(.15, .6, y / max(h2, 1e-3) + .5 * m - .25);
  vec3 rock = mix(vec3(.012, .026, .04), mix(vec3(.05, .095, .13), vec3(.15, .24, .3), lit), cover);
  col = mix(col, rock, smoothstep(PX + soft, -PX - soft, y - h2));
  return col;
}

/* Snow in the air: one layer of flakes. */
float frFlakes(vec2 p, float t, float scale, float seed) {
  vec2 q = p * scale + vec2(t * .22 + seed * 5., t * (.45 + .15 * seed));
  q.x += .3 * sin(q.y * .8 + seed);
  vec2 id = floor(q), f = fract(q) - .5;
  float h = hash(id + seed * 17.);
  if (h > .3) return 0.;
  vec2 d = f - (vec2(hash(id + 1.3), hash(id + 2.7)) - .5) * .6;
  d.x += .07 * sin(t * (1. + h * 9.) + h * 40.);
  float r = .03 + .05 * hash(id + 4.) + PX * scale;
  return smoothstep(r, r * .3, length(d)) * (.35 + .65 * hash(id + 6.));
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float A = u_res.x / u_res.y;
  vec2 ptr = pointerP();
  // scrolling tips the eye down: the sky leaves and the ice fills the page
  float hz = .17 + min(u_scroll, 1.2) * .55;
  float y = p.y - hz;
  vec3 col;
  if (y >= 0.) {
    col = frSky(p, y, t, 0.);
  } else {
    float dy = -y;
    float z = FR_H / max(dy, 1e-3);
    vec3 v = normalize(vec3(p.x, -dy, 1.));
    // the eye drifts forward over the lake
    vec2 wp = vec2(p.x * z + ptr.x * .12, z + t * .018);
    float foot = z * PX;
    // which way, and how far, a ray runs on under the ice for each unit it sinks
    float si = length(v.xz) / FR_N;
    vec2 o = normalize(v.xz) * si / sqrt(1. - si * si);
    float near = smoothstep(11., 2.2, z);
    // milky ice down in the dark
    float cloud = ifbm(wp * 1.3 + o * .12);
    vec3 ice = mix(vec3(.003, .022, .038), vec3(.01, .075, .1), cloud * cloud * 1.6);
    // the cracks: long ones crossing the lake, shorter ones between them
    vec3 c1 = frCrack(wp, o, 1.5, 1., foot, .28);
    vec3 c2 = frCrack(wp, o, 3.4, 2.3, foot, .12) * .5;
    float line = max(c1.x, c2.x);
    float wall = max(c1.y, c2.y);
    ice += vec3(.012, .1, .14) * c1.z * near;
    ice += vec3(.15, .58, .74) * wall * near * 1.15;
    ice += vec3(.75, .93, 1.) * line * .85 * near;
    // air caught as it froze: beads stacked one under another
    for (int k = 0; k < 3; k++) {
      vec2 bq = wp * 13. + o * 13. * (.02 + .035 * float(k));
      vec2 id = floor(bq);
      if (hash(id) < .05) {
        vec2 d = fract(bq) - .5 - (vec2(hash(id + 1.), hash(id + 2.)) - .5) * .5;
        float r = (.13 - .03 * float(k)) * (.5 + hash(id + 3.));
        ice += vec3(.5, .75, .85) * smoothstep(r, r * .5, length(d)) * (.3 - .08 * float(k)) * near;
      }
    }
    // the pointer is a lamp held under the ice
    float pz = FR_H / max(hz - ptr.y, .03);
    vec2 away = wp - vec2(ptr.x * pz + ptr.x * .12, pz + t * .018);
    float lamp = exp(-dot(away, away) / .12) * smoothstep(.02, .12, hz - ptr.y);
    ice = ice * (1. + 1.4 * lamp) + vec3(.01, .06, .085) * lamp;
    // moonlight in the ice under the moon
    float path = exp(-pow((p.x - A * .27) / (.1 + dy * .7), 2.));
    ice *= .75 + 1.1 * path;
    // drifts of snow lying on it, more of them further out
    float sn = ifbm(vec2(wp.x * .8 + wp.y * .12, wp.y * .2) + 3.);
    float snow = smoothstep(.5, .66, sn + smoothstep(2., 16., z) * .22 - .03);
    vec3 snowCol = vec3(.16, .25, .32) * (.7 + .5 * inoise(wp * 9.)) * (.7 + .8 * path);
    snowCol += vec3(.8, .95, 1.) * step(.985, hash(floor(wp * 90.))) * (.5 + .5 * sin(t * 3. + hash(floor(wp * 90.) + 1.) * 40.)) * near * .5;
    col = mix(ice, snowCol, snow);
    // the sky in the ice, a mirror out toward the horizon
    float fres = .04 + .96 * pow(1. - (-v.y), 5.);
    vec3 refl = frSky(vec2(p.x, 0.), dy * .95, t, .004 + dy * .03);
    col = mix(col, refl, fres * (1. - snow * .85));
    // snow blowing over it in thin snakes
    float wisp = ifbm(vec2(wp.x * .6 - t * .3, wp.y * 1.4 + .3 * sin(wp.x * .7)));
    col += vec3(.4, .55, .64) * pow(smoothstep(.5, .9, wisp), 2.) * .22 * smoothstep(16., 3., z) * smoothstep(.3, 1.2, z);
    // the far shore lost in the cold air
    col = mix(col, vec3(.07, .15, .2), smoothstep(8., 60., z) * .7);
  }
  // snow in the air
  float fl = frFlakes(p, t, 6., 1.) + frFlakes(p + 2., t, 11., 2.) * .7 + frFlakes(p - 4., t, 19., 3.) * .5;
  col += vec3(.7, .85, .95) * fl * .5;
  col *= 1. - .3 * dot(p, p);
  return col;
}
`),

  // Note highway: an osu!mania playfield in perspective, notes streaming down
  // the lanes and lighting the keys as they land; it leans after the pointer.
  // With the player's replay skin it plays their keymode with their notes.
  highway: shader(`
// A player's replay skin, when they have one (use-highway-notes.ts): the lane
// count, each lane's tap note side by side in u_notes with its height over
// width, and each lane's note colour. Without one: 4 lanes, our own notes.
uniform float u_lanes;
uniform float u_noteArt;
uniform float u_noteColors;
uniform float u_noteAspect[10];
uniform vec3 u_noteColor[10];
uniform sampler2D u_notes;
// The playfield's colour: blue, or the colour of the player's notes.
uniform vec3 u_accent;
// A real chart (use-highway-chart.ts), when the owner switched it on: notes
// as (start, end) ms texels, lane after lane; per lane and bucket the first
// note still sounding; the loop's length; the bucket's ms and count; and
// where each lane's notes end.
uniform float u_chart;
uniform sampler2D u_chartNotes;
uniform sampler2D u_chartIndex;
uniform float u_chartPeriod;
uniform vec2 u_chartBucket;
uniform float u_chartLaneEnd[10];
// A visitor playing the chart (use-highway-play.ts): per lane, the key held,
// seconds since it went down and since it hit a note, and the start of the
// last note it hit, which is gone from the lane.
uniform float u_play;
uniform float u_keyDown[10];
uniform float u_pressAge[10];
uniform float u_hitAge[10];
uniform float u_hitUntil[10];

float noteAt(float lane, float n, float lanes) {
  return step(clamp(1. - 2. / lanes, .5, .8), hash(vec2(lane * 7.1 + 1., n)));
}

vec3 theme(vec2 uv, vec2 p, float t) {
  vec3 col = vec3(.008, .01, .03);
  // stage lights sweeping behind, where the window is
  float beam = pow(max(0., cos((p.x - .5 * sin(t * .3)) * 2.)), 30.) * smoothstep(-.5, .5, p.y);
  vec3 A = u_accent;
  col += A * .3 * beam * .25;
  // The playfield belongs to the hero: it sits in the hero's empty right
  // side, keys along its foot, and scrolls away with it.
  p.y -= u_scroll;
  float N = u_lanes > 0. ? u_lanes : 4.;
  float aspect = u_res.x / u_res.y;
  float vpY = .72, judge = .18, W = .16 * sqrt(N / 4.);
  float cx = aspect * .3;
  float vpX = aspect * .2 + (u_pointer.x - .5) * .2;
  float k = (vpY - p.y) / (vpY - judge);
  float u = (p.x - mix(vpX, cx, k)) / (W * k);
  float s = 1. / k - 1.;
  float fog = exp(-max(s, 0.) * .3);
  // the keys: a short strip under the judgement line, where the playfield ends
  float keys = judge - .045;
  if (abs(u) < 1. && p.y > keys) {
    float lane = min(floor((u + 1.) * .5 * N), N - 1.);
    float lx = (u + 1.) * .5 * N - lane - .5;
    int li = int(lane);
    col = mix(col, A * .06 + .01, .85) + A * .09 * fog;
    // our own colours mirror like a mania skin's: white, blue, ... and a yellow middle
    float mirror = min(lane, N - 1. - lane);
    vec3 noteCol = (mod(N, 2.) > .5 && lane == floor(N * .5)) ? vec3(1., .85, .35)
      : mod(mirror, 2.) < .5 ? vec3(.88, .92, 1.) : vec3(.35, .68, 1.);
    if (u_noteColors > .5) noteCol = u_noteColor[li];
    float dt = .19, speed = 2.1;
    // a note's half-length along the track: a skin's art keeps its proportions, our bars are flat
    float half_ = u_noteArt > .5 ? clamp(u_noteAspect[li] * (W / N) / (vpY - judge), .012, .17) : .055;
    float hit = 0.;
    // where this pixel's note head sits (along the track, from the pixel) and
    // whether a hold's body passes through it
    float headAt = 9., held = 0.;
    if (u_chart > .5) {
      // A real chart, looping: the lane's notes come from the index
      // (first note still sounding per bucket) and the notes texture.
      float now = mod(t * 1000., u_chartPeriod);
      float laneStart = li == 0 ? 0. : u_chartLaneEnd[li - 1];
      float laneEnd = u_chartLaneEnd[li];
      float age = 9.;
      int b0 = int(clamp(floor(now / u_chartBucket.x), 0., u_chartBucket.y - 1.));
      float i0 = texelFetch(u_chartIndex, ivec2(b0, li), 0).r;
      float from0 = i0 >= 0. ? i0 - 1. : laneEnd - 1.;
      for (int j = 0; j < 4; j++) {
        float idx = from0 + float(j);
        if (idx < laneStart || idx >= laneEnd) continue;
        vec2 note = texelFetch(u_chartNotes, ivec2(int(mod(idx, 1024.)), int(idx / 1024.)), 0).rg;
        if (note.x <= now) age = min(age, now < note.y ? 0. : (now - note.y) / 1000.);
      }
      hit = exp(-age * 7.);
      // played: the keys light when the visitor presses them, not when a note lands
      if (u_play > .5) hit = max(u_keyDown[li] * .75, exp(-u_pressAge[li] * 9.));
      if (s >= 0.) {
        float halfMs = half_ / speed * 1000.;
        float tp = now + s / speed * 1000.;
        if (tp >= u_chartPeriod) tp -= u_chartPeriod;
        int b1 = int(clamp(floor(max(tp - halfMs, 0.) / u_chartBucket.x), 0., u_chartBucket.y - 1.));
        float i1 = texelFetch(u_chartIndex, ivec2(b1, li), 0).r;
        if (i1 >= 0.) {
          for (int j = 0; j < 4; j++) {
            float idx = i1 + float(j);
            if (idx >= laneEnd) break;
            vec2 note = texelFetch(u_chartNotes, ivec2(int(mod(idx, 1024.)), int(idx / 1024.)), 0).rg;
            if (note.x - tp > halfMs) break;
            float off = (tp - note.x) / 1000. * speed;
            // a note the visitor already hit (a little early, so it is still above the line) is gone
            bool gone = u_play > .5 && note.x <= u_hitUntil[li] && note.x > now - 400.;
            if (!gone && abs(off) < abs(headAt)) headAt = off;
            if (note.y > note.x + 1. && tp >= note.x && tp <= note.y) held = 1.;
          }
        }
      }
    } else {
      // made-up notes: every lane, every dt, a coin toss
      float age = 9.;
      float n0 = floor(t / dt);
      for (int i = 0; i < 4; i++) {
        float n = n0 - float(i);
        if (noteAt(lane, n, N) > .5) { age = t - n * dt; break; }
      }
      hit = exp(-age * 7.);
      float n = floor((max(s, 0.) / speed + t) / dt + .5);
      float ns = (n * dt - t) * speed;
      if (ns >= -.01 && noteAt(lane, n, N) > .5) headAt = s - ns;
    }
    // the last note this lane hit lights the key and the lane above it
    col += noteCol * hit * exp(-max(s, 0.) * 2.2) * .35;
    // a hit bursts on the judgement line
    if (u_play > .5) col += mix(noteCol, vec3(1.), .55) * exp(-u_hitAge[li] * 11.) * exp(-abs(s) * 7.) * step(abs(lx), .47) * .9;
    // a hold's body, then the head over it
    col = mix(col, mix(noteCol, A, .3) * .55 * (.6 + .4 * fog), held * step(abs(lx), .36) * fog);
    float inside = step(abs(headAt), half_);
    if (u_noteArt > .5) {
      vec2 cell = vec2((lane + clamp(lx + .5, 0., 1.)) / N, .5 - headAt / (2. * half_));
      vec4 art = texture(u_notes, cell);
      col = mix(col, art.rgb * (.65 + .35 * fog), art.a * inside * fog);
    } else {
      col = mix(col, noteCol * (.6 + .4 * fog), inside * step(abs(lx), .4) * fog);
    }
    // lane lines, the judgement line and the keys
    float lw = PX / (2. * W * k / N);
    col += A * .8 * smoothstep(lw * 1.5, 0., .5 - abs(lx)) * .25 * fog;
    col += mix(A, vec3(1.), .6) * smoothstep(PX * 2., 0., abs(p.y - judge)) * .6;
    if (p.y < judge) {
      col = mix(col, A * .08 + .02 + noteCol * hit * .45, .8);
    }
  }
  float edge = abs(abs(u) - 1.) * W * k;
  float stage = step(keys, p.y);
  col += A * exp(-edge / max(PX * 2., .002)) * .6 * fog * stage;
  col += A * .6 * exp(-edge * 25.) * .15 * fog * stage;
  col += A * exp(-abs(p.y - keys) / max(PX * 2., .002)) * step(abs(u), 1.) * .4;
  return col;
}`),

  // Thunderstorm: a heavy storm deck over a dark ridge at night. The clouds
  // billow (warped noise eroding a ragged underside) and a strike lights them
  // from inside, brightest around it, so their structure shows only in the
  // flash; between strikes, sheet lightning glows somewhere in the deck. The
  // bolt drops out of the cloud base to the ridge in kinked segments with a
  // few dying branches, pulsing two or three times like a real return stroke.
  // Rain hangs in curtains far off and streaks past up close. The clouds rise
  // as the page scrolls.
  storm: shader(`
/* Piecewise-linear noise in -1..1: straight runs with sharp kinks, a bolt's shape. */
float jag(float y, float s) {
  float i = floor(y);
  int si = int(s);
  return mix(ihash(ivec2(int(i), si)), ihash(ivec2(int(i) + 1, si)), fract(y)) * 2. - 1.;
}

float boltX(float y, float s) {
  return .085 * jag(y * 7., s) + .03 * jag(y * 23., s + 1.) + .008 * jag(y * 61., s + 2.);
}

/* Four octaves of the integer noise, enough for cloud at this size. */
float cloudFbm(vec2 p) {
  float v = 0., a = .5;
  for (int i = 0; i < 4; i++) {
    v += a * inoise(p);
    p = p * 2.07 + 5.3;
    a *= .5;
  }
  return v;
}

/* A strike's brightness \`age\` seconds after it began: two or three return strokes, each fading fast. */
float strokes(float age, float s) {
  if (age < 0. || age > 1.2) return 0.;
  float f = exp(-age * 30.);
  float t2 = .07 + .06 * ihash(ivec2(int(s), 41));
  f += step(t2, age) * .8 * exp(-(age - t2) * 26.);
  float t3 = t2 + .12 + .1 * ihash(ivec2(int(s), 42));
  f += step(.4, ihash(ivec2(int(s), 43))) * step(t3, age) * .6 * exp(-(age - t3) * 14.);
  return f;
}

/* Distance to the bolt: a trunk from the cloud base to the ridge, and three branches that thin to nothing. */
float boltDist(vec2 p, float bx, float top, float ground, float lean, float s, out float fade) {
  fade = 1.;
  float y = clamp(p.y, ground, top);
  float x = bx + lean * (top - y) + boltX(y, s);
  float slope = (boltX(y + .002, s) - boltX(y - .002, s)) / .004 - lean;
  float d = length(vec2((p.x - x) / sqrt(1. + slope * slope), p.y - y));
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float h1 = ihash(ivec2(int(s), 50 + k)), h2 = ihash(ivec2(int(s), 60 + k)), h3 = ihash(ivec2(int(s), 70 + k));
    float yk = top - (.12 + .5 * h1) * (top - ground);
    float len = .06 + .12 * h2;
    float dir = h3 < .5 ? -1. : 1.;
    float spread = dir * (.7 + .9 * fract(h3 * 7.));
    float by = clamp(p.y, yk - len, yk);
    float xk = bx + lean * (top - yk) + boltX(yk, s);
    float bs = s + 10. + fk;
    float bxp = xk + spread * (yk - by) + .8 * (boltX(by * 1.7, bs) - boltX(yk * 1.7, bs));
    float bslope = -spread + .8 * 1.7 * (boltX(by * 1.7 + .003, bs) - boltX(by * 1.7 - .003, bs)) / .006;
    float bd = length(vec2((p.x - bxp) / sqrt(1. + bslope * bslope), p.y - by));
    float along = (yk - by) / len;
    bd += along * .004;
    if (bd < d) { d = bd; fade = 1. - along * .8; }
  }
  return d;
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float sc = u_scroll;
  float aspect = u_res.x / u_res.y;
  vec2 cp = p - vec2(0., sc * .32);
  vec2 gp = p - vec2(0., sc * .55);

  // a strike every six to nine seconds, somewhere across the width; one is
  // mid-flash at the swatches' still moment (6.5 s)
  float period = 7.3;
  float ts = t + .83;
  float si = floor(ts / period);
  float age = ts - si * period - 1.5 * ihash(ivec2(int(si), 1));
  float strike = strokes(age, si);
  float bx = (ihash(ivec2(int(si), 2)) - .5) * aspect * .8;
  float lean = (ihash(ivec2(int(si), 3)) - .5) * .25;
  // sheet lightning in between, inside the deck, no bolt
  float sp = 2.9;
  float ss = floor(t / sp) + 100.;
  float sheetOn = step(.45, ihash(ivec2(int(ss), 4)));
  float sheet = strokes(t - (ss - 100.) * sp - 1.4 * ihash(ivec2(int(ss), 5)), ss) * sheetOn * .55;
  vec2 sheetPos = vec2((ihash(ivec2(int(ss), 6)) - .5) * aspect, .1 + .25 * ihash(ivec2(int(ss), 7)));

  // the ridge, and the deck's ragged base above it
  float ridge = -.43 + .11 * inoise(vec2(gp.x * 1.3, 3.)) + .045 * inoise(vec2(gp.x * 4.1, 8.)) + .016 * inoise(vec2(gp.x * 13., 2.)) + .006 * inoise(vec2(gp.x * 41., 6.)) + .002 * inoise(vec2(gp.x * 130., 9.));
  float base = -.08 + .07 * inoise(vec2(cp.x * 1.1 + 3., 1.)) - .04 * inoise(vec2(cp.x * 2.9, 4.));

  // the sky between: near black, a low glow at the horizon
  vec3 col = mix(vec3(.085, .09, .13), vec3(.016, .018, .028), smoothstep(ridge - .02, base + .1, gp.y));

  // the clouds: warped billows, a ragged underside, relief from the noise's slope
  vec2 q = vec2(cp.x * 1.25 + t * .01, cp.y * 1.9);
  vec2 w = vec2(cloudFbm(q * 1.3 + vec2(t * .012, 0.)), cloudFbm(q * 1.3 + vec2(5.2, 1.3 - t * .01)));
  vec2 cq = q * 2.2 + w * 1.05;
  float n = cloudFbm(cq);
  // the light: the strike while it lasts, else the sheet, else the faint sky above
  vec2 fpos = vec2(bx, base + .06);
  vec2 lightPos = strike > sheet ? fpos : sheetPos;
  vec2 toLight = normalize(lightPos - cp + vec2(0., .001));
  float nL = cloudFbm(cq + toLight * vec2(1.25, 1.9) * .05);
  float nUp = cloudFbm(cq + vec2(0., .1));
  float m = smoothstep(-.05, .22, cp.y - base + (n - .5) * .4);
  float lit = strike * (exp(-length((cp - fpos) * vec2(.9, 1.4)) * 2.6) * 1.3 + .14);
  lit += sheet * exp(-length((cp - sheetPos) * vec2(.7, 1.1)) * 3.);
  // puffs facing the light catch it, the rest stays in shade
  float facing = clamp(.35 + (n - nL) * 9., 0., 1.);
  float top = clamp(.4 + (n - nUp) * 5., 0., 1.);
  vec3 cloud = vec3(.05, .055, .08) * (.35 + 1.1 * top) * (.45 + 1.1 * n);
  cloud += vec3(.035, .037, .055) * smoothstep(base + .3, base, cp.y) * (.5 + facing);
  cloud += vec3(.45, .5, .78) * lit * (.12 + 1.2 * facing * n) * (1.3 - .6 * m);
  col = mix(col, cloud, m);
  // the underside glows where light leaks out of it
  col += vec3(.3, .33, .55) * lit * smoothstep(.0, .15, m) * smoothstep(.75, .15, m) * .3;

  // rain curtains hanging from the base, far off
  float shaft = smoothstep(.42, .75, inoise(vec2(cp.x * 1.4 + t * .02, 7.)));
  float rx = p.x + p.y * .2;
  float streak = .45 + .55 * inoise(vec2(rx * 60., p.y * 1.2 + t * 4.)) * inoise(vec2(rx * 17. + 7., p.y * .7 + t * 2.));
  float curtain = shaft * streak * smoothstep(base + .04, base - .12, cp.y) * smoothstep(ridge - .01, ridge + .12, gp.y);
  col += vec3(.04, .045, .068) * curtain * (.6 + 3.5 * (strike + sheet * .5));

  // the bolt: a white core, a violet-blue bloom, hidden inside the cloud
  float fade;
  float d = boltDist(cp, bx, base + .03, ridge + sc * .23, lean, si * 7. + 3., fade);
  float bolt = clamp(strike * 1.4, 0., 1.) * step(age, .5);
  float core = smoothstep(max(PX * 1.1, .0012) * (.6 + .4 * fade), 0., d) * (.5 + .5 * fade);
  vec3 boltCol = vec3(1.) * core + vec3(.55, .6, 1.) * (exp(-d / .008) * .55 + exp(-d / .05) * .16) * fade;
  col += boltCol * bolt * (1. - .9 * smoothstep(.15, .6, m));

  // the ridge: a black silhouette with a rim where the flash catches it
  float land = smoothstep(ridge + PX, ridge - PX, gp.y);
  vec3 ground = vec3(.008, .009, .014) + vec3(.03, .033, .05) * strike * smoothstep(-.6, ridge, gp.y);
  ground += vec3(.35, .38, .6) * exp(-max(ridge - gp.y, 0.) / .004) * strike * .4 * (.15 + exp(-abs(gp.x - bx) * 2.5));
  col = mix(col, ground, land);

  // rain: long thin streaks falling at a slant, four depths. Each column has
  // its own speed and spacing so no rows line up; a streak is brightest at
  // its head and fades up its tail; the near ones are sparse, longer, softer
  // and quicker, the far ones fine and dense. They catch the flash.
  vec2 rp = vec2(p.x + p.y * .2, p.y);
  // a thumbnail's streaks are a few of its pixels wide, so they go lighter there
  float rainLit = (1. + (strike + sheet * .4) * 3.) * clamp(u_res.y / 700., .4, 1.);
  for (int l = 0; l < 4; l++) {
    float fl = float(l) / 3.;
    float s = mix(7., 55., fl * fl);
    float cx = rp.x * s;
    int ic = int(floor(cx)) + l * 4099;
    float speed = mix(2.8, 1.3, fl) * (.85 + .3 * ihash(ivec2(ic, 12)));
    float seg = mix(1.1, .45, fl) * (.8 + .4 * ihash(ivec2(ic, 13)));
    float v = (p.y + t * speed - sc * mix(.5, .2, fl)) / seg + 10. * ihash(ivec2(ic, 14));
    int vi = int(floor(v));
    float fv = fract(v);
    if (ihash(ivec2(ic, vi * 7 + l)) > mix(.5, .75, fl)) continue;
    float ox = .25 + .5 * ihash(ivec2(ic, vi * 7 + 3));
    float len = mix(.32, .14, fl) / seg * (.6 + .7 * ihash(ivec2(ic, vi * 7 + 5)));
    float tail = clamp(1. - fv / len, 0., 1.);
    float head = smoothstep(0., .02 / seg, fv);
    float width = PX * mix(1.7, .75, fl);
    float across = smoothstep(width, 0., abs(fract(cx) - ox) / s);
    col += vec3(.36, .4, .55) * across * tail * sqrt(tail) * head * mix(.38, .24, fl) * rainLit;
  }

  col *= 1. - .3 * dot(p * vec2(.55, .9), p * vec2(.55, .9));
  col += (ihash(ivec2(gl_FragCoord.xy) + ivec2(int(t * 24.) * 7, 0)) - .5) * .008;
  return col;
}`),

  // Noir: rain on a window at night. Drops slide down the glass in fits and
  // starts, wiping clear trails through the fogged pane and showing the street
  // sharp through themselves; behind it the city's lights blur at three depths.
  // The glass leans a little after the pointer, and the street sinks as the
  // page scrolls. Black and white, with film grain.
  noir: shader(`
vec4 rainLayer(vec2 UV, float t) {
  vec2 aspect = vec2(2., 1.);
  vec2 uv = UV * aspect;
  uv.y += t * .75;
  vec2 gv = fract(uv) - .5;
  vec2 id = floor(uv);
  float n = hash(id);
  t += n * 6.2831;
  float w = UV.y * 10.;
  float x = (n - .5) * .8;
  x += (.4 - abs(x)) * sin(3. * w) * pow(sin(w), 6.) * .45;
  float y = -sin(t + sin(t + sin(t) * .5)) * .45;
  y -= (gv.x - x) * (gv.x - x);
  vec2 dropPos = (gv - vec2(x, y)) / aspect;
  float drop = smoothstep(.05, .03, length(dropPos));
  vec2 trailPos = (gv - vec2(x, t * .25)) / aspect;
  trailPos.y = (fract(trailPos.y * 8.) - .5) / 8.;
  float trail = smoothstep(.03, .01, length(trailPos));
  float fogTrail = smoothstep(-.05, .05, dropPos.y);
  fogTrail *= smoothstep(.5, y, gv.y);
  trail *= fogTrail;
  fogTrail *= smoothstep(.05, .04, abs(dropPos.x));
  return vec4(drop * dropPos + trail * trailPos, fogTrail, max(drop, trail * .6));
}
float city(vec2 p, float t, float sharp) {
  // the street below: a glow rising from the bottom, and lights at three depths
  float v = .07 * smoothstep(.45, -.55, p.y);
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float s = 4. + fl * 4.;
    vec2 q = p * s + vec2(t * .012 * (fl + 1.), fl * 3.1);
    vec2 id = floor(q);
    vec2 c = fract(q) - .5;
    float h = hash(id + fl * 9.);
    if (h < .35) continue;
    vec2 o = c - (vec2(hash(id + 1.), hash(id + 2.)) - .5) * .55;
    float r = .1 + .16 * hash(id + 3.);
    float edge = mix(.25, .85, sharp);
    v += smoothstep(r, r * edge, length(o)) * (.1 + .35 * hash(id + 4.)) * (.85 + .15 * sin(t * .6 + h * 20.)) * smoothstep(.65, -.4, p.y + fl * .08);
  }
  return v;
}
vec3 theme(vec2 uv, vec2 p, float t) {
  vec2 UV = p * 1.4 - pointerP() * .03 + vec2(0., u_scroll * .15);
  float tt = t * .5;
  vec4 a = rainLayer(UV, tt);
  vec4 b = rainLayer(UV * 1.35 + 7.54, tt);
  vec2 offs = a.xy + b.xy;
  float clear = clamp(a.z + b.z, 0., 1.);
  float drops = clamp(a.w + b.w, 0., 1.);
  // through a drop the street shows sharp and upside down-ish (the offset), and a bit brighter
  float v = .014 + city(p + offs * 3. + vec2(0., u_scroll * .25), t, max(clear, drops)) * (.6 + .4 * clear + .35 * drops);
  // fogged glass: a pale haze except where the drops wiped it
  v = mix(v, v * .75 + .022, (1. - max(clear, drops)) * .55);
  // a thin bright rim on each drop, where it catches the light
  v += drops * (1. - drops) * .12;
  v *= 1. - .5 * dot(p * vec2(.75, 1.), p * vec2(.75, 1.));
  v += (hash(gl_FragCoord.xy + floor(t * 24.) * .731) - .5) * .028;
  return vec3(v);
}`),

  // Golden hour: the sun going down behind ridge after ridge of hills, cloud
  // lit gold from below, birds going home, wind moving through long grass in
  // front; the horizon scrolls away with the hero.
  sunset: shader(`
/* Golden hour: the sun going down behind ridge after ridge of hills, each
   paler with the air between, cloud lit gold from below, and wind moving
   through a field of long grass in front. */

float ghHills(float x, float seed) {
  return inoise(vec2(x, seed)) * .6 + inoise(vec2(x * 2.3 + 5., seed + 3.)) * .28 + inoise(vec2(x * 5.1 + 9., seed + 7.)) * .12;
}

/* A row of long grass standing on the line y = ground: x is how much of this
   point its blades cover (all of it below the line), y how far up a blade it
   is. across is blades to a unit, tall their height; each leans its own way
   and further when a gust (0..1) is on it. */
vec2 ghGrass(vec2 p, float ground, float across, float tall, float gust, float t, float seed) {
  float up = (p.y - ground) / tall;
  if (up < 0.) return vec2(1., 0.);
  if (up > 1.2) return vec2(0.);
  float cx = p.x * across, first = floor(cx), aa = PX * across * 1.2;
  vec2 res = vec2(0.);
  for (int i = -2; i <= 2; i++) {
    float id = first + float(i);
    float v = up / (.5 + .7 * hash(vec2(id, seed)));
    if (v > 1.) continue;
    float lean = (hash(vec2(id, seed + 1.)) - .5) * 1.3 + (.5 + .9 * gust) * (.6 + .4 * sin(t * 1.6 + id * .7 + seed));
    float mid = id + .5 + (hash(vec2(id, seed + 2.)) - .5) * .7 + lean * v * v;
    float cover = smoothstep(aa, -aa, abs(cx - mid) - (.03 + .26 * (1. - v)));
    if (cover > res.x) res = vec2(cover, v);
  }
  return res;
}

/* Dust and seed heads adrift in the low light: one layer. */
float ghMotes(vec2 p, float t, float scale, float seed) {
  vec2 q = p * scale + vec2(t * .05 + seed * 5., -t * (.04 + .02 * seed));
  q.x += .3 * sin(q.y * .9 + seed * 3. + t * .1);
  vec2 id = floor(q), f = fract(q) - .5;
  float h = hash(id + seed * 17.);
  if (h > .2) return 0.;
  vec2 d = f - (vec2(hash(id + 1.3), hash(id + 2.7)) - .5) * .6;
  float r = .025 + .07 * pow(hash(id + 4.), 3.) + PX * scale;
  return smoothstep(r, r * .2, length(d)) * (.3 + .7 * hash(id + 6.)) * (.6 + .4 * sin(t * (.6 + 2. * hash(id + 8.)) + h * 60.));
}

/* A few birds going home across the sun's side of the sky. */
float ghBirds(vec2 p, float t, vec2 sp) {
  float m = 0.;
  vec2 flock = sp + vec2(.55 - mod(t * .011, 1.9), .12 + .02 * sin(t * .13));
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    vec2 d = p - flock - vec2(abs(fi - 2.) * .028 + .01 * hash(vec2(fi, 3.)), (fi - 2.) * .013 + .006 * sin(t * .4 + fi));
    float span = .009 + .003 * hash(vec2(fi, 5.));
    if (abs(d.x) > span * 1.3 || abs(d.y) > span * 1.3) continue;
    float beat = sin(t * (3.4 + hash(vec2(fi, 7.))) + fi * 2.);
    float wing = d.y - (.25 + .55 * beat) * abs(d.x) + span * .12 * beat;
    m = max(m, smoothstep(.0011 + PX, .0004, abs(wing)) * smoothstep(span, span * .8, abs(d.x)));
  }
  return m;
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float A = u_res.x / u_res.y;
  vec2 ptr = pointerP();
  // the horizon sits along the foot of the hero and scrolls away with it
  float H = .15 + min(u_scroll, 1.5);
  float y = p.y - H;
  vec2 sp = vec2(A * .27, H + .06);
  vec2 ds = p - sp;
  float d = length(ds);
  vec3 col = mix(vec3(1., .56, .2), vec3(.86, .28, .34), smoothstep(-.02, .15, y));
  col = mix(col, vec3(.36, .12, .34), smoothstep(.1, .32, y));
  col = mix(col, vec3(.08, .045, .2), smoothstep(.28, .6, y));
  // the sun's warmth pooling round it, and shafts fanning out between the clouds
  col += vec3(1., .5, .18) * exp(-d * 3.2) * .5 + vec3(1., .75, .4) * exp(-d * 9.) * .5;
  float ang = atan(ds.y, ds.x);
  float shafts = inoise(vec2(ang * 7., t * .05)) * inoise(vec2(ang * 19. + 4., -t * .03));
  col += vec3(1., .6, .28) * shafts * exp(-d * 2.4) * smoothstep(.06, .22, d) * .45;
  // thin cloud high up, still pink
  float cirrus = smoothstep(.5, .8, ifbm(vec2(p.x * .9 + t * .008, y * 9. + p.x * .6))) * smoothstep(.12, .3, y);
  col = mix(col, mix(vec3(.75, .3, .4), vec3(1., .62, .45), exp(-d * 1.6)), cirrus * .45);
  // the sun, then a bank of cloud across it, its edges toward the sun lit gold
  col = mix(col, mix(vec3(1.3, 1.16, .8), vec3(1.25, .95, .5), smoothstep(0., .062, d)), smoothstep(.062 + PX * 1.5, .062 - PX * 1.5, d));
  vec2 cq = vec2(p.x * 1.25 + t * .012, y * 6.5);
  float cb = ifbm(cq);
  float bank = smoothstep(.46, .7, cb) * smoothstep(0., .06, y) * smoothstep(.34, .1, y);
  float edge = clamp((cb - ifbm(cq - normalize(ds) * vec2(1.25, 6.5) * .035)) * 7. + .35, 0., 1.);
  vec3 cloud = mix(vec3(.3, .1, .24), vec3(1., .7, .36), edge * (.35 + .65 * exp(-d * 1.8)));
  cloud += vec3(1., .85, .55) * pow(edge, 3.) * exp(-d * 3.) * .6;
  col = mix(col, cloud, bank * .85);
  col = mix(col, vec3(.06, .02, .05), ghBirds(p, t, sp) * .85);
  // ridge after ridge, the far ones pale with haze, mist lying at each one's foot
  float top = 0.;
  for (int i = 0; i < 4; i++) {
    float fi = float(i), near = fi / 3.;
    float x = p.x + ptr.x * .012 * (fi + 1.);
    top = H + .07 - fi * .033 + (.05 + .03 * near) * (ghHills(x * (1.2 + fi * .8) + fi * 31., fi) - .5) * 2.;
    float under = top - p.y;
    float sunward = exp(-abs(x - sp.x) * 2.2);
    vec3 hill = mix(vec3(.6, .25, .2), vec3(.05, .022, .045), pow(near, .6));
    hill += vec3(.5, .2, .04) * sunward * (1. - near) * .6;
    hill = mix(hill, vec3(.95, .5, .28), smoothstep(0., .08, under) * .3 * (1. - near));
    hill += vec3(1., .65, .3) * smoothstep(.006, 0., under) * sunward * .5;
    col = mix(col, hill, smoothstep(-PX, PX, under));
  }
  // the meadow in front: a few low rises one behind another, short grass along
  // each crest, and the sun's light lying on their shoulders where a gust has
  // laid the grass over
  float sheen = exp(-abs(p.x - sp.x) * 1.2);
  for (int k = 0; k < 4; k++) {
    float fk = float(k), near = fk / 3.;
    float ground = k == 0 ? top - .003 : H - .05 - fk * .105 + .075 * (ghHills(p.x * (1. + .25 * fk) + fk * 17. + ptr.x * .02 * fk, 10. + fk) - .5) * 2.;
    float tall = mix(.013, .03, near);
    if (p.y > ground + tall * 1.2) continue;
    float gust = smoothstep(.3, .7, ifbm(vec2(p.x * 1.3 - t * .2 + fk * 3.1, fk * 2.7 + t * .03)));
    vec2 blade = ghGrass(p, ground, mix(330., 190., near), tall, gust, t, fk * 5.);
    vec2 more = ghGrass(p + vec2(.37, 0.), ground, mix(250., 150., near), tall * .7, gust, t, fk * 5. + 2.5);
    if (more.x > blade.x) blade = more;
    float under = max(ground - p.y, 0.);
    float grain = .75 + .5 * (inoise(p * vec2(90., 130.) + fk * 9.) * .65 + inoise(p * vec2(190., 260.)) * .35);
    vec3 dark = vec3(.06, .027, .042) * (1. - .17 * near);
    vec3 lit = vec3(.62, .3, .09) * (.12 + .88 * sheen) * (.25 + .75 * gust) * (1. - .3 * near);
    vec3 body = dark + lit * grain * (exp(-under * 26.) * .7 + exp(-under * 7.) * .22);
    col = mix(col, mix(body, lit * 1.5 + dark, pow(blade.y, 1.5)), blade.x);
  }
  // dust and seeds adrift, lit where they cross the low sun
  float motes = ghMotes(p, t, 7., 1.) + ghMotes(p + 3., t, 13., 2.) * .7;
  col += vec3(1., .72, .4) * motes * (.12 + .5 * exp(-d * 2.)) * smoothstep(.5, .1, y);
  return col * .78;
}
`),

  // Judgement rain: MAX, 300, 200 and the rest drifting up the page like
  // embers in three layers, mostly the good ones, each glowing softly; the
  // player's own judgement art when they have a replay skin.
  judgements: shader(`
uniform sampler2D u_judgements;

/* A judgement sprite: kind 0..5 (MAX, 300, 200, 100, 50, MISS), local 0..1 with y up. */
vec4 sprite(vec2 local, float kind, float lod) {
  if (local.x < 0. || local.y < 0. || local.x > 1. || local.y > 1.) return vec4(0.);
  return textureLod(u_judgements, vec2((kind + local.x) / 6., 1. - local.y), lod);
}

vec3 theme(vec2 uv, vec2 p, float t) {
  vec3 col = mix(vec3(.02, .014, .02), vec3(.07, .045, .05), smoothstep(-.5, .6, p.y));
  col += vec3(.14, .09, .04) * exp(-length(p - vec2(.35, .3)) * 2.2);
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float s = 6. - fl * 1.6;
    vec2 q = p * s;
    q.y -= t * (.3 + fl * .12) + u_scroll * s * (.15 + fl * .12);
    q.x += sin(q.y * .5 + t * .4 + fl * 2.) * .3;
    vec2 id = floor(q);
    float h = hash(id + fl * 11.);
    if (h < .76) continue;
    float r = hash(id + 3.);
    float kind = r < .42 ? 0. : r < .72 ? 1. : r < .85 ? 2. : r < .93 ? 3. : r < .97 ? 4. : 5.;
    vec2 d = fract(q) - .5 - (vec2(hash(id + 1.), hash(id + 2.)) - .5) * .25;
    d = rot(sin(t * .8 + h * 9.) * .12) * d;
    // a pop as it appears low in the view, then a slow fade toward the top
    float life = smoothstep(-.55, -.3, p.y) * smoothstep(.6, .15, p.y - u_scroll * .2);
    vec2 box = vec2(.8, .8 * 112. / 256.) * (.85 + .3 * hash(id + 4.));
    vec4 core = sprite(d / box + .5, kind, 0.);
    // the glow: the sprite blurred, faded out well before its box's edge
    vec2 gl = d / (box * 1.5) + .5;
    vec4 glow = sprite(gl, kind, 3.5) * smoothstep(.5, .15, length((gl - .5) * vec2(1., 2.3)));
    float bright = (.45 + fl * .22) * (.6 + .4 * life);
    col += glow.rgb * .55 * bright;
    col = col * (1. - core.a * bright) + core.rgb * bright;
  }
  return col;
}`),

  // Koi pond, from straight above: light falls through leaves in pools and
  // the koi glow as they cross one; lily pads and lotus float on top, and a
  // ring spreads where a koi comes up. All drawn here, no sprite.
  koi: shader(`
/* Koi pond, from straight above: light falls through leaves in pools, and
   the koi glow as they cross one. */
const int KP_N = 7;
const float KP_TAU = 6.2831853;
const vec2 KP_SUN = vec2(-.53, .85);
/* Which variety koi i is: kohaku, ogon, tancho, showa, kohaku, asagi, ki utsuri.
   (Tables here are chains of ifs: a constant array read by a loop's index is
   rebuilt on every read by some drivers, and cost more than everything else.) */
int kpVariety(int i) {
  return i == 0 ? 0 : i == 1 ? 3 : i == 2 ? 2 : i == 3 ? 1 : i == 4 ? 0 : i == 5 ? 4 : 5;
}
/* Koi i's loop: where it is centred (in half widths of the pond, and
   heights), its radii (same units), which way it is turned (cos, sin), and
   its length, its pace, how often it changes pace and which way round it goes. */
void kpLoop(int i, out vec2 home, out vec2 rad, out vec2 turn, out vec4 gait) {
  if (i == 0) { home = vec2(-.5, .16); rad = vec2(.52, .3); turn = vec2(1., 0.); gait = vec4(.25, .27, .23, 1.); }
  else if (i == 1) { home = vec2(.12, .2); rad = vec2(.44, .37); turn = vec2(.454, .891); gait = vec4(.2, .22, .29, -1.); }
  else if (i == 2) { home = vec2(.5, -.1); rad = vec2(.66, .27); turn = vec2(-.589, .808); gait = vec4(.235, .3, .21, 1.); }
  else if (i == 3) { home = vec2(-.25, -.17); rad = vec2(.58, .34); turn = vec2(-.987, -.158); gait = vec4(.19, .24, .26, -1.); }
  else if (i == 4) { home = vec2(.3, .08); rad = vec2(.42, .39); turn = vec2(-.307, -.952); gait = vec4(.26, .2, .3, -1.); }
  else if (i == 5) { home = vec2(-.05, -.02); rad = vec2(.7, .25); turn = vec2(.709, -.706); gait = vec4(.215, .28, .24, 1.); }
  else { home = vec2(.62, .22); rad = vec2(.5, .32); turn = vec2(.95, .312); gait = vec4(.23, .25, .22, -1.); }
}

/* Koi i at time t: its head, its heading, how hard it is turning, where its
   tail beat is, and its length. */
void kpFrame(int i, float t, out vec2 c, out vec2 dir, out float kappa, out float beat, out float len) {
  float fi = float(i);
  float A = max(u_res.x / u_res.y, 1.15);
  vec2 home, rad, turn; vec4 gait;
  kpLoop(i, home, rad, turn, gait);
  len = gait.x * clamp(u_res.x / u_res.y / 1.3, .68, 1.);
  rad *= vec2(A * .5, 1.);
  // it glides, puts on a little speed, glides again
  float a = gait.w * (t * gait.y + .45 * sin(t * gait.z + fi * 3.)) + fi * 2.4;
  float s1 = sin(a), c1 = cos(a), s2 = sin(2. * a + fi * 1.7), c2 = cos(2. * a + fi * 1.7);
  // the same wobble a little out of step, for the other axis
  float s3 = -.416 * s2 + .909 * c2, c3 = -.416 * c2 - .909 * s2;
  vec2 e = rad * vec2(c1 + .07 * s2, s1 + .07 * s3);
  vec2 v = rad * vec2(-s1 + .14 * c2, c1 + .14 * c3);
  vec2 ac = rad * vec2(-c1 - .28 * s2, -s1 - .28 * s3);
  mat2 R = mat2(turn.x, turn.y, -turn.y, turn.x);
  c = home * vec2(A * .5, 1.) + R * e;
  v = R * v * gait.w;
  ac = R * ac;
  float speed = max(length(v), 1e-4);
  dir = v / speed;
  kappa = clamp((v.x * ac.y - v.y * ac.x) / (speed * speed * speed), -.75 / len, .75 / len);
  beat = a * gait.w * 11. + fi * 5.;
}

/* A point d from the head, in the koi's own frame: u from nose (0) to tail
   root (1), x sideways, both in body lengths, the spine straightened out. */
bool kpLocal(vec2 d, vec2 dir, float kappa, float beat, float len, out float u, out float x) {
  if (dot(d, d) > len * len * 2.7) return false;
  u = -dot(d, dir) / len;
  if (u < -.05 || u > 1.42) return false;
  float um = max(u, 0.);
  float spine = kappa * len * um * um * .5 + (.006 + .08 * um * um) * sin(beat - u * 4.6);
  x = dot(d, vec2(-dir.y, dir.x)) / len - spine;
  return true;
}

float kpWidth(float u) {
  float nose = 1. - min(u / .17, 1.);
  return .142 * sqrt(max(0., 1. - nose * nose)) * mix(.78, 1., smoothstep(.06, .38, u)) * mix(1., .2, pow(smoothstep(.38, 1., u), 1.7));
}

/* Koi i at (u, x): colour and cover. aa is the edge softness in body
   lengths, side how much its left flank faces the light. With shadow set,
   just its outline. */
vec4 kpKoi(int i, float u, float x, float beat, float aa, float side, bool shadow) {
  float fi = float(i), ax = abs(x);
  int variety = kpVariety(i);
  float W = kpWidth(clamp(u, 0., 1.));
  float body = smoothstep(aa, -aa, ax - W) * step(0., u) * step(u, 1.);
  vec3 finCol = variety == 3 ? vec3(1., .8, .42) : variety == 1 || variety == 5 ? vec3(.5, .46, .44) : variety == 4 ? vec3(.92, .62, .5) : vec3(.96, .94, .9);
  vec3 col = vec3(0.);
  float cover = 0.;
  // the tail: a forked fan, thin enough to see through, its rays spreading from the root
  float s = (u - .9) / .44;
  if (s > 0. && s < 1.1) {
    float spread = (.016 + .2 * pow(s, .82)) * (1. - .22 * smoothstep(.7, 1., s));
    float lobe = clamp(ax / spread, 0., 1.);
    float fin = smoothstep(aa, -aa, ax - spread) * smoothstep(aa * 2.3, -aa * 2.3, s - (.58 + .42 * pow(lobe, 1.25)));
    float rays = .8 + .2 * sin(x / (u - .84) * 44.);
    col = finCol * rays * (.95 - .3 * s);
    cover = fin * mix(.8, .32, s);
  }
  // the fins at its sides, fanning back and feathering as it swims
  for (int k = 0; k < 2; k++) {
    float u0 = k == 0 ? .27 : .58, L = k == 0 ? .25 : .11, hw = k == 0 ? .078 : .034;
    float th = (k == 0 ? .95 : .6) + .2 * sin(beat * .5 + float(k));
    vec2 d = vec2(u - u0, ax - kpWidth(u0) * .75);
    float f = dot(d, vec2(cos(th), sin(th))), g = dot(d, vec2(-sin(th), cos(th)));
    float fs = clamp(f / L, 0., 1.);
    float fin = smoothstep(aa, -aa, abs(g) - hw * sin(3.14159 * pow(fs, 1.35))) * step(0., f) * step(f, L);
    float rays = .82 + .18 * sin(g / (f + .04) * 26.);
    vec3 fc = finCol * rays * (1. - .25 * fs);
    float fa = fin * mix(.8, .4, fs);
    col = mix(col, fc, fa * (1. - cover * .5));
    cover = max(cover, fa);
  }
  if (shadow) return vec4(0., 0., 0., max(body, cover * .6));
  if (body > 0.) {
    float r = clamp(x / max(W, 1e-3), -1., 1.);
    float seed = fi * 7.31;
    vec2 pc = vec2(u * 4.4, x * 6.5) + seed;
    float n1 = inoise(pc) * .75 + inoise(pc * 2.3 + 9.) * .25;
    float n2 = inoise(pc * 1.3 + 31.);
    float e = .03 + aa * 4.;
    vec3 white = vec3(.97, .95, .9), red = vec3(.9, .2, .07), black = vec3(.05, .05, .06);
    vec3 b = white;
    if (variety == 0) {
      float m = smoothstep(.46 - e, .46 + e, n1 + .08 * sin(u * 9. + seed)) * smoothstep(.02, .09, u) * (1. - smoothstep(.84, .95, u));
      b = mix(white, red, m);
    } else if (variety == 1) {
      b = mix(black, red, smoothstep(.52 - e, .52 + e, n1));
      b = mix(b, white, smoothstep(.56 - e, .56 + e, n2) * (1. - smoothstep(.5 - e, .5 + e, n1)));
    } else if (variety == 2) {
      b = mix(white, red, smoothstep(.052 + e * .2, .052 - e * .2, length(vec2(u - .125, x * 1.15))));
    } else if (variety == 3) {
      b = mix(vec3(.96, .62, .14), vec3(1., .84, .42), smoothstep(.9, .1, abs(r)) * .7 + .3 * n2);
    } else if (variety == 4) {
      b = mix(vec3(.3, .42, .58), vec3(.93, .93, .9), smoothstep(.2, .1, u));
      b = mix(b, vec3(.93, .4, .2), smoothstep(.62, .9, abs(r)) * smoothstep(.12, .3, u));
    } else {
      b = mix(black, vec3(.98, .74, .16), smoothstep(.47 - e, .47 + e, n1));
    }
    // scales, row on row, faint except on the blue back that is known for them
    vec2 sq = vec2(u * 36., x * 36.);
    sq.y += .5 * mod(floor(sq.x), 2.);
    float scale = smoothstep(.62, .25, length(fract(sq) - vec2(.3, .5))) * smoothstep(.17, .3, u) * smoothstep(.006, .002, aa);
    b *= 1. - (variety == 4 ? .5 : .13) * (1. - scale) * smoothstep(1., .5, abs(r));
    // a round back: darker down the flanks, a wet sheen along the side that faces the light
    float nz = sqrt(1. - r * r);
    b *= .5 + .5 * nz + .22 * r * side;
    b += vec3(1., .98, .92) * exp(-pow((r - side * .42) / .2, 2.)) * .2 * smoothstep(.02, .2, u) * (1. - smoothstep(.6, .95, u));
    // the fin along its back, the gill covers, the eyes
    float dorsal = smoothstep(.009 + aa, .003, abs(x - .014 * sin(beat - u * 4.6 - .9))) * smoothstep(.34, .42, u) * (1. - smoothstep(.58, .7, u));
    b = mix(b, b * .7 + finCol * .1, dorsal * .6);
    b *= 1. - .3 * smoothstep(.007 + aa, 0., abs(u - .2 - .05 * r * r)) * smoothstep(.2, .5, abs(r));
    float eye = smoothstep(.013 + aa, .013 - aa, length(vec2(u - .105, ax - kpWidth(.105) * .76)));
    b = mix(b, vec3(.02), eye);
    col = mix(col, b, body);
    cover = max(cover, body);
  }
  return vec4(col, cover);
}

/* Light the surface gathers on what lies under it: bright wandering threads. */
float kpCaustic(vec2 x, float tm) {
  vec2 q = x * KP_TAU - 250.;
  vec2 i = q;
  float c = 1.;
  for (int n = 0; n < 4; n++) {
    float tt = tm * (1. - (3.5 / float(n + 1)));
    i = q + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1. / length(vec2(q.x / (sin(i.x + tt) / .005), q.y / (cos(i.y + tt) / .005)));
  }
  c = 1.17 - pow(c / 4., 1.4);
  return clamp(pow(abs(c), 8.), 0., 1.);
}

/* The surface's slope: slow swells that never quite line up, and the rings a
   koi leaves where it came up (ring: where, and how long ago). */
vec2 kpSlope(vec2 w, float t, vec3 ring[3]) {
  float b = inoise(w * 1.7 + t * .05) * 3.;
  vec2 g = vec2(.8, .3) * cos(dot(w, vec2(.8, .3)) * 11. + t * .7 + b) * .5;
  g += vec2(-.4, .9) * cos(dot(w, vec2(-.4, .9)) * 17. - t * .9 + b * 1.3) * .35;
  g += vec2(.6, -.7) * cos(dot(w, vec2(.6, -.7)) * 29. + t * 1.3 - b) * .22;
  for (int r = 0; r < 3; r++) {
    vec2 dl = w - ring[r].xy;
    float d = length(dl), age = ring[r].z;
    float x = d - (.015 + age * .075);
    float env = exp(-x * x * 420.) * exp(-age * .45) * smoothstep(0., .3, age);
    g += dl / max(d, 1e-4) * sin(x * 150.) * env * 1.5;
  }
  return g;
}

const int KP_PADS = 11;
/* Pad i: where (x in half widths of the page, y), how big, which way its notch points. */
vec4 kpPadAt(int i) {
  return i == 0 ? vec4(.60, .37, .1, .5) : i == 1 ? vec4(.79, .25, .07, 2.3) : i == 2 ? vec4(.93, .42, .085, 4.1) : i == 3 ? vec4(.71, .52, .06, 5.5)
    : i == 4 ? vec4(-.92, .45, .095, 1.2) : i == 5 ? vec4(-.74, .5, .06, 3.4) : i == 6 ? vec4(-.9, -.2, .08, 5.)
    : i == 7 ? vec4(.33, -.37, .1, 2.7) : i == 8 ? vec4(.51, -.46, .068, .9) : i == 9 ? vec4(.16, -.49, .056, 4.4) : vec4(-.38, -.62, .09, 3.);
}

/* A lily pad of radius R at q, its notch along +x: colour and cover. sun is
   the light's direction turned into the pad's frame. */
vec4 kpPad(vec2 q, float R, float fi, vec2 sun, float aa, bool shadow) {
  float r = length(q), th = atan(q.y, q.x);
  float edge = R * (1. + .028 * sin(th * 5. + fi * 3.) + .012 * sin(th * 13. + fi));
  float cover = smoothstep(aa, -aa, r - edge) * smoothstep(-aa, aa, r * (abs(th) - .13) + .012 * R);
  if (shadow || cover <= 0.) return vec4(0., 0., 0., cover);
  float k = r / R;
  vec3 col = mix(vec3(.06, .22, .11), vec3(.15, .36, .14), k * k);
  col = mix(col, vec3(.2, .3, .08), .5 * hash(vec2(fi, 3.)));
  col *= .85 + .3 * inoise(q / R * 3. + fi * 9.);
  // veins fanning from the stalk, a paler spot where it joins
  float vein = smoothstep(.04 + aa / R * 4., .0, abs(sin(th * 8. + fi)) * k) * smoothstep(1., .5, k);
  col += vec3(.12, .2, .08) * vein + vec3(.1, .15, .05) * smoothstep(.2, 0., k);
  // the rim turns up: lit where it faces the light, dark where it faces away
  float facing = dot(q / max(r, 1e-4), sun);
  col *= 1. + .22 * k * facing + smoothstep(.8, .97, k) * .8 * facing;
  col += vec3(.3, .42, .24) * smoothstep(.93, 1., k) * max(facing, 0.) * .6;
  // a bead or two of water sitting on it
  for (int j = 0; j < 2; j++) {
    vec2 bc = R * .55 * (vec2(hash(vec2(fi, 5. + float(j))), hash(vec2(fi, 8. + float(j)))) - .5) - vec2(.3 * R, 0.);
    float bd = length(q - bc) / (R * (.045 + .03 * hash(vec2(fi, 11. + float(j)))));
    col = mix(col, col * .55, smoothstep(1.2, .9, bd));
    col += vec3(.7, .85, .8) * smoothstep(.5, .1, length((q - bc) / (R * .06) - sun * .35)) * step(bd, 1.);
  }
  return vec4(col, cover);
}

/* A lotus of radius R at q: three rings of pointed petals round a gold heart. */
vec4 kpLotus(vec2 q, float R, float aa, float pale) {
  float r = length(q) / R, th = atan(q.y, q.x);
  if (r > 1.05) return vec4(0.);
  vec3 col = vec3(0.);
  float cover = 0.;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float pr = 1. - fk * .26;
    float c = abs(fract((th + fk * .41) / KP_TAU * 8.) - .5) * 2.;
    float inside = smoothstep(aa / R, -aa / R, r - pr * (1. - .5 * pow(c, 1.6)));
    vec3 pc = mix(vec3(1., .95, .93), mix(vec3(.98, .48, .64), vec3(1., .9, .86), pale), smoothstep(.25, 1., r / pr));
    // each petal cupped: dim at its edges and where the ring inside it shades it
    pc *= (.66 + .34 * smoothstep(1., .25, c)) * (.74 + fk * .13) * (fk < 2. ? .72 + .28 * smoothstep(pr * .62, pr * .95, r) : 1.);
    col = mix(col, pc, inside);
    cover = max(cover, inside);
  }
  col = mix(col, vec3(1., .8, .25) * (.8 + .2 * sin(th * 14.)), smoothstep(.2, .15, r));
  return vec4(col, cover);
}

/* The pads (and their blossoms) over w, and in shade how much of them lies over ws. */
vec4 kpPads(vec2 w, vec2 ws, float t, out float shade) {
  float A = u_res.x / u_res.y;
  float small = clamp(A / 1.6, .6, 1.);
  vec2 sun = normalize(KP_SUN);
  vec4 res = vec4(0.);
  shade = 0.;
  w.y = mod(w.y + .8, 1.6) - .8;
  ws.y = mod(ws.y + .8, 1.6) - .8;
  for (int i = 0; i < KP_PADS; i++) {
    vec4 pd = kpPadAt(i);
    float R = pd.z * small, reach = (R + .03) * (R + .03) * 1.3;
    vec2 c = vec2(pd.x * A * .5, pd.y);
    vec2 d = w - c, dsh = ws - c;
    bool on = dot(d, d) < reach, under = dot(dsh, dsh) < reach;
    if (!on && !under) continue;
    float fi = float(i);
    vec2 drift = .008 * vec2(sin(t * .23 + fi * 2.), cos(t * .19 + fi * 3.));
    mat2 turn = rot(-pd.w - .12 * sin(t * .11 + fi * 1.7));
    if (under) shade = max(shade, kpPad(turn * (dsh - drift), R, fi, sun, PX * 1.2 + .012, true).a);
    if (!on) continue;
    d -= drift;
    vec4 pad = kpPad(turn * d, R, fi, turn * sun, PX * 1.2, false);
    res.rgb = mix(res.rgb, pad.rgb, pad.a);
    res.a = max(res.a, pad.a);
    if (i == 0 || i == 7 || i == 4) {
      vec2 at = d - R * vec2(.25, -.3);
      vec4 lotus = kpLotus(rot(fi) * at, R * (i == 4 ? .4 : .52), PX * 1.2, i == 7 ? 1. : 0.);
      res.rgb = mix(res.rgb * (1. - .5 * smoothstep(R * .75, R * .4, length(at + sun * R * .08)) * (1. - lotus.a)), lotus.rgb, lotus.a);
      res.a = max(res.a, lotus.a);
    }
  }
  return res;
}

vec3 theme(vec2 uv, vec2 p, float t) {
  vec2 sun = normalize(KP_SUN);
  vec2 ptr = pointerP();
  float sc = u_scroll;
  // the surface drifts by as the page scrolls; the koi stay in view
  vec2 w = p + vec2(0., sc * .3) + ptr * .016;
  vec2 fp = p + vec2(0., sc * .06) + ptr * .008;
  vec2 shift = w - fp;
  // now and then a koi comes up, and a ring spreads from where it broke the surface
  vec3 ring[3];
  int riser[3], nextRiser[3];
  for (int r = 0; r < 3; r++) {
    float fr = float(r);
    float cyc = t / 6. + fr * .37;
    float id = floor(cyc);
    int k = int(hash(vec2(id, fr + 2.)) * float(KP_N)) % KP_N;
    vec2 c, dir; float kap, beat, len;
    kpFrame(k, (id - fr * .37) * 6., c, dir, kap, beat, len);
    ring[r] = vec3(c + shift, fract(cyc) * 6.);
    riser[r] = k;
    nextRiser[r] = int(hash(vec2(id + 1., fr + 2.)) * float(KP_N)) % KP_N;
  }
  vec2 g = kpSlope(w, t, ring);
  // light through the leaves overhead, in pools that sway a little
  vec2 lw = w + .03 * vec2(sin(t * .31 + w.y * 3.), cos(t * .27 + w.x * 3.));
  float pool = ifbm(lw * 1.45 + vec2(t * .012, 4.));
  float dap = smoothstep(.4, .64, pool);
  // the floor, seen bent through the surface: silt, and smooth stones
  vec2 fw = p + vec2(0., sc * .2) - ptr * .01 - g * .014;
  float silt = ifbm(fw * 2.6 + 3.);
  vec3 col = mix(vec3(.008, .035, .04), vec3(.03, .1, .09), silt);
  float caustic = kpCaustic(fw * .9, t * .25 + 31.);
  // shadows of the pads lie on the floor, further from the pad the deeper it is
  float padShade;
  vec4 pads = kpPads(w, w + sun * .035 - g * .01, t, padShade);
  float light = (.3 + .7 * dap) * (1. - .6 * padShade);
  col *= .35 + 1.5 * light;
  col += vec3(.2, .62, .5) * caustic * (.06 + dap) * (1. - padShade) * .7;
  vec3 deep = vec3(.008, .05, .058);
  // the koi, deepest first, each with its shadow on the floor
  for (int i = 0; i < KP_N; i++) {
    vec2 c, dir; float kap, beat, len;
    kpFrame(i, t, c, dir, kap, beat, len);
    float depth = .62 - .075 * float(i);
    for (int r = 0; r < 3; r++) {
      if (riser[r] == i) depth *= 1. - .8 * smoothstep(1.6, .2, ring[r].z);
      if (nextRiser[r] == i) depth *= 1. - .8 * smoothstep(1.4, 0., 6. - ring[r].z);
    }
    float u, x;
    // shadow
    if (kpLocal(fp - g * .012 + sun * (.012 + .05 * (1. - depth)) - c, dir, kap, beat, len, u, x)) {
      float sh = kpKoi(i, u, x, beat, .02 + .03 * (1. - depth), 0., true).a;
      col *= 1. - sh * (.2 + .5 * dap) * (1. - padShade);
    }
    if (kpLocal(fp - g * (.004 + .012 * depth) - c, dir, kap, beat, len, u, x)) {
      vec4 k = kpKoi(i, u, x, beat, PX / len * 1.1 + depth * .012, dot(vec2(-dir.y, dir.x), sun), false);
      if (k.a > 0.) {
        vec3 fish = k.rgb * (.3 + .8 * light) * (1. + caustic * dap * .5);
        fish = mix(fish * vec3(.82, .97, .95), deep * (1. + 2. * light), depth * .75);
        col = mix(col, fish, k.a);
      }
    }
  }
  // the surface: each swell faintly bright on the side tilted to the light, sparks where one catches it
  float tilt = dot(g, sun);
  col += vec3(.1, .2, .2) * min(max(tilt, 0.), 1.2) * .1 * (.4 + dap);
  col *= 1. - .16 * min(max(-tilt, 0.), 1.2);
  col += vec3(.8, .95, .95) * smoothstep(.7, 1.1, tilt) * smoothstep(.45, .8, inoise(w * 40. + t * .5)) * .3 * (.25 + dap);
  // lily pads lie on it, unbent, some with a lotus open
  col = mix(col, pads.rgb * (.62 + .9 * dap), pads.a);
  // a few fallen petals drifting across
  float A = max(u_res.x / u_res.y, 1.15);
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    vec2 pc = vec2(mod(hash(vec2(fi, 21.)) * A * 1.3 + t * (.004 + .004 * hash(vec2(fi, 22.))), A * 1.3) - A * .65, mod(hash(vec2(fi, 23.)) * 1.6 + .01 * sin(t * .2 + fi), 1.6) - .8);
    vec2 d = rot(fi * 2.1 + t * .05 + g.x * .1) * (vec2(w.x, mod(w.y + .8, 1.6) - .8) - pc);
    float pe = smoothstep(PX * 1.5, -PX * 1.5, length(d * vec2(1., 1.55 + 22. * d.x)) - .012);
    col = mix(col, mix(vec3(.95, .62, .7), vec3(1., .9, .9), smoothstep(-.012, .012, d.x)) * (.45 + .65 * dap), pe * (1. - pads.a));
  }
  col *= 1. - .3 * dot(p, p);
  return col;
}
`),

  // Hanabi: fireworks over a river on a summer festival night: shells climb
  // from the far bank and open as balls of stars (chrysanthemums, peonies with
  // a second colour at the heart, gold willows that hang), their smoke and
  // colours lying on the water; lights along the bank, paper lanterns adrift,
  // and a string of lanterns across the top of the hero (lantern.png).
  hanabi: shader(`
/* Hanabi: fireworks over a river on a summer festival night. Shells climb
   from the far bank and open as balls of stars: chrysanthemums that turn
   colour as they spread, peonies with a second colour at the heart, gold
   willows that hang and glitter; their smoke stays lit by the next ones, and
   the river holds it all in broken streaks. Lights along the far bank, paper
   lanterns adrift on the water, and a string of them across the top of the
   page (the sprite, lantern.png). */
uniform sampler2D u_sprite;

const float HB_HZ = -.2;     // the far bank's waterline
const int HB_STARS = 60;

vec3 hbColour(float h) {
  return h < .17 ? vec3(1., .3, .35) : h < .34 ? vec3(1., .78, .3) : h < .5 ? vec3(.35, .85, 1.)
    : h < .67 ? vec3(1., .45, .85) : h < .84 ? vec3(.45, 1., .55) : vec3(.75, .6, 1.);
}

/* Where a star thrown from the middle of a burst has got to after a
   seconds: out along dir, slowing in the air, and falling. */
vec2 hbStar(vec2 dir, float a, float reach, float fall) {
  a = max(a, 0.);
  return dir * reach * (1. - exp(-a * 2.7)) - vec2(0., fall * a * a);
}

/* A soft glow that is gone entirely by 12 w from its source. (A star's light
   has to end somewhere: each point only visits the stars thrown its way, and
   a glow that never quite reached nothing showed where the others stopped.) */
float hbGlow(float d, float w) {
  float k = max(1. - d / (12. * w), 0.);
  return k * k * k;
}

/* A streak of light from a to b at x, brightest at b. It dims back from b over
   its own length, or over its glow's reach when it is shorter than that: a
   short streak that dimmed over its length cut its glow off at a flat line. */
float hbStreak(vec2 x, vec2 a, vec2 b, float w) {
  vec2 pa = x - a, ba = b - a;
  float len = sqrt(max(dot(ba, ba), 1e-7));
  float along = dot(pa, ba) / len;
  float d = length(pa - ba * clamp(along / len, 0., 1.));
  float h = clamp(1. - (len - along) / max(len, 12. * w), 0., 1.);
  return (exp(-d / w) + hbGlow(d, w) * .22) * (.15 + .85 * h * h);
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  // the river scene sinks away slower than the page; the lantern string goes with it
  vec2 q = vec2(p.x, p.y - u_scroll * .5);
  float below = HB_HZ - q.y;

  // night sky, a little warm haze over the far bank
  vec3 col = mix(vec3(.035, .03, .09), vec3(.008, .008, .03), smoothstep(HB_HZ, .5, q.y));
  col += vec3(.1, .045, .06) * exp(-max(q.y - HB_HZ, 0.) * 9.);
  col += vec3(.8, .85, 1.) * stars(q, 40., .1, t) * .45 * smoothstep(HB_HZ + .05, .2, q.y);
  // the river, lying flat away from the eye: its ripples are fine lines out by
  // the far bank and broad swells up close. A light on it is a column under
  // the light, pushed side to side by the slope of each ripple (more the
  // nearer), and brightest on the faces that tilt toward the eye.
  float sway = 0., glint = 0.;
  if (below > 0.) {
    float z = .05 / (below + .01);
    vec2 wq = vec2(q.x * z, z) * 7.;
    float swell = noise(vec2(wq.x * 1.3, wq.y * 7. + t * .5)), chop = noise(vec2(wq.x * 3.6 + 5., wq.y * 21. - t * .8));
    // out by the bank they are finer than a pixel: let them even out there
    float calm = smoothstep(.004, .03, below);
    float slope = ((swell - .5) * 1.3 + (chop - .5) * .7) * calm;
    sway = slope * (.006 + below * .16);
    glint = mix(.5, smoothstep(.35, .75, chop * .7 + swell * .3), calm);
    col = mix(vec3(.03, .024, .07), vec3(.006, .006, .02), smoothstep(0., .3, below));
    col += vec3(.05, .025, .04) * exp(-below * 12.) * (.5 + slope) + vec3(.014, .012, .03) * glint * exp(-below * 4.);
  }

  // the shells: six going, each on its own clock
  for (int k = 0; k < 6; k++) {
    float fk = float(k);
    float period = 3.7 + .43 * fk;
    float run = (t + fk * 2.17) / period;
    float id = floor(run) * 6. + fk;
    float a = fract(run) * period;
    float kind = hash(vec2(id, 7.));           // < .4 chrysanthemum, < .72 peony, else willow
    bool willow = kind >= .72;
    vec2 B = vec2((hash(vec2(id, 1.)) - .44) * aspect * .78, .08 + .22 * hash(vec2(id, 2.)));
    vec3 c = willow ? vec3(1., .72, .32) : hbColour(hash(vec2(id, 3.)));
    vec3 c2 = hbColour(fract(hash(vec2(id, 3.)) + .37));
    const float RISE = .8;
    if (a < RISE) {
      // climbing from the bank, wavering, a short tail behind it
      float e = 1. - pow(1. - a / RISE, 2.2), e0 = 1. - pow(1. - max(a - .09, 0.) / RISE, 2.2);
      vec2 from = vec2(B.x + .06 * (hash(vec2(id, 5.)) - .5), HB_HZ);
      vec2 head = mix(from, B, e) + vec2(.004 * sin(a * 30. + id), 0.);
      vec2 tail = mix(from, B, e0) + vec2(.004 * sin((a - .09) * 30. + id), 0.);
      float w = max(PX * 1.3, .0012);
      col += vec3(1., .82, .55) * hbStreak(q, tail, head, w) * (1. - a / RISE * .5);
      // and its light on the water
      if (below > 0.) col += vec3(1., .8, .5) * exp(-abs(q.x - head.x + sway) * 90.) * exp(-below * 5.) * (.25 + .75 * glint) * .12;
      continue;
    }
    float age = a - RISE;
    float life = willow ? 3.8 : 2.8;
    if (age > life) continue;
    float reach = (willow ? .24 : .26 + .12 * hash(vec2(id, 4.))) * min(1., .25 + aspect * .6);
    float fall = willow ? .034 : .016;
    float fade = willow ? exp(-age * .6) * smoothstep(life, life - 1.2, age) : exp(-age * .95) * smoothstep(life, life - .8, age);
    vec2 dq = q - B;
    // the flash, and the smoke it leaves, lit by the burst as it thins and drifts
    col += mix(vec3(1.), c, .6) * exp(-length(dq) * 2.4) * exp(-age * 4.) * .3;
    float near = exp(-dot(dq, dq) / (reach * reach * 1.3));
    if (near > .02) {
      vec2 sq = dq * 5.5 + vec2(id, age * .12);
      col += (c * .5 + vec3(.25, .22, .3)) * (noise(sq) * .65 + noise(sq * 2.3 + 4.) * .35) * near * exp(-age * .8) * smoothstep(0., .25, age) * .1;
    }
    // on the water: its colours, pulled down into streaks
    if (below > 0.) {
      vec2 m = (q + vec2(sway * 1.6, 0.) - vec2(B.x, 2. * HB_HZ - B.y + fall * age * age)) / (vec2(1., 2.1) * (reach * (1. - exp(-age * 2.7)) + .05));
      col += mix(c, c2, .25) * exp(-dot(m, m) * 1.3) * (.18 + .82 * glint) * fade * .5;
    }
    // the burst's own frame, falling with its stars: there every star's head
    // lies on a straight line out from the middle
    vec2 sh = dq + vec2(0., fall * age * age);
    float rad = length(sh);
    if (rad > reach * 1.12 + .02 && sh.y < 0.) continue;
    if (rad > reach * 1.12 + (willow ? .2 : .06)) continue;
    float turn = hash(vec2(id, 9.)) * 6.28;
    // a chrysanthemum's stars draw lines out from the middle, a peony's are points, a willow's hang
    bool peony = !willow && kind >= .4;
    float tail = willow ? .6 : peony ? .07 : .42;
    // as it opens the stars are all on top of each other: hold them down, the flash is enough
    float open = smoothstep(0., .22, age);
    float w = max(PX * 1.25, .0012);
    float n = float(HB_STARS);
    float before = max(age - tail, 0.);
    float out1 = 1. - exp(-age * 2.7), out0 = 1. - exp(-before * 2.7);
    // how far above its head the far end of a star's tail hangs, in this frame
    vec2 lag = vec2(0., fall * (age * age - before * before));
    // the stars are dealt round the ball in order, so only those thrown this
    // point's way can reach it; near the middle, all of them
    int span = rad < max(willow ? .12 : .05, w * 44.) ? HB_STARS : willow ? 21 : 7;
    float first = span == HB_STARS ? 0. : floor((atan(sh.y, sh.x) - turn) / 6.2832 * n + .5) - float(span / 2);
    vec3 lit = vec3(0.);
    for (int j = 0; j < HB_STARS; j++) {
      if (j >= span) break;
      float fi = mod(first + float(j), n);
      float ang = (fi + (hash(vec2(fi, id + 2.)) - .5) * .7) / n * 6.2832 + turn;
      // spread over a ball, seen from the side: crowded at the rim, sparse in the middle
      float z = 2. * hash(vec2(fi, id + 5.)) - 1.;
      vec2 dir = sqrt(1. - z * z) * vec2(cos(ang), sin(ang));
      // a peony's heart: every fourth star stays in close, in the second colour
      bool heart = peony && mod(fi, 4.) < 1.;
      float r = reach * (heart ? .42 : .9 + .16 * hash(vec2(fi, id)));
      vec2 head = dir * r * out1, end = dir * r * out0 + lag;
      vec2 dh = sh - head;
      // a chrysanthemum's stars start white-gold and take their colour as they cool
      vec3 sc = heart ? c2 : mix(vec3(1., .9, .7), c, willow ? .2 : smoothstep(.05, .5, age));
      // near the end they gutter
      float gutter = age > life * .55 ? step(.35, hash(vec2(fi + id, floor(t * 18.)))) : 1.;
      float light = hbStreak(sh, end, head, peony ? w * 1.3 : w) * (.6 + .5 * z * z) * (peony ? 1.5 : 1.);
      // the star itself, a soft point at the streak's head
      light += hbGlow(length(dh), w * .8) * .5;
      if (willow) light += step(.72, hash(vec2(fi * 3. + id, floor(t * 14.)))) * exp(-length(sh - mix(end, head, hash(vec2(fi, floor(t * 14.))))) / (w * 1.4)) * .8;
      lit += sc * light * gutter;
    }
    // where the stars crowd together the light eases off, so the middle never burns out to a blob
    lit *= fade * open * 2.2;
    col += lit / (1. + .8 * max(lit.r, max(lit.g, lit.b)));
  }

  // the far bank: hills, then roofs and trees against them, lights strung along the water
  float land = q.y - HB_HZ;
  if (land > 0.) {
    float hills = .03 + .05 * noise(vec2(q.x * 1.6 + 3., 1.)) + .015 * noise(vec2(q.x * 7., 2.));
    col = mix(col, vec3(.014, .014, .04), smoothstep(PX, -PX, land - hills) * .85);
    float roofs = .008 + .02 * hash(vec2(floor(q.x * 46.), 3.)) * step(.45, hash(vec2(floor(q.x * 46.), 4.))) + .012 * noise(vec2(q.x * 30., 5.));
    col = mix(col, vec3(.006, .006, .016), smoothstep(PX, -PX, land - roofs));
  }
  float cellW = .028;
  for (int k = -1; k <= 1; k++) {
    float li = floor(q.x / cellW) + float(k);
    float h = hash(vec2(li, 11.));
    if (h > .62) continue;
    vec2 lp = vec2((li + .2 + .6 * hash(vec2(li, 12.))) * cellW, HB_HZ + .003 + .009 * hash(vec2(li, 13.)));
    vec3 lc = h < .12 ? vec3(1., .3, .25) : h < .2 ? vec3(.5, .9, 1.) : vec3(1., .72, .4);
    float tw = .7 + .3 * sin(t * (1. + 3. * h) + li);
    float d = length(q - lp);
    col += lc * (smoothstep(max(.0022, PX * 1.6), 0., d) + exp(-d * 120.) * .2) * tw * .8;
    if (below > 0.) col += lc * exp(-abs(q.x - lp.x + sway * .7) * 260.) * exp(-below * 16.) * (.3 + .7 * glint) * tw * .4;
  }

  // paper lanterns set adrift on the river, their light under them
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float near = hash(vec2(fi, 21.));
    float s = mix(.006, .017, near);
    float span = aspect + .3;
    vec2 lp = vec2(mod(hash(vec2(fi, 22.)) * span + t * mix(.004, .011, near), span) - span * .5, HB_HZ - .025 - .27 * near * near + .0015 * sin(t * 1.3 + fi));
    vec2 d = q - lp;
    if (abs(d.x) > .08 || d.y > .06 || d.y < -.14) continue;
    float flick = .85 + .15 * sin(t * (5. + fi) + fi * 3.);
    vec2 bx = abs(d) - vec2(s * .8, s);
    float box = smoothstep(PX, -PX, max(bx.x, bx.y));
    col = mix(col, vec3(1., .66, .3) * (1.1 - .4 * length(d / s)) * flick * (abs(d.y) > s * .78 ? .45 : 1.), box);
    col += vec3(1., .5, .2) * exp(-length(d) / (s * 2.4)) * .22 * flick;
    if (d.y < -s) col += vec3(1., .55, .22) * exp(-abs(d.x + sway * .5) / (s * .8)) * exp((d.y + s) / (s * 5.)) * (.35 + .65 * glint) * .5 * flick;
  }

  // paper lanterns (the sprite, 256x400, cord loop at the top middle) hung
  // from a sagging rope across the top of the hero, each swaying from its
  // hook, tinted red or orange, its candle flickering
  vec2 u = vec2(p.x, p.y - u_scroll);
  float halfW = aspect * .5;
  float ropeY = .46 - .03 * (1. - pow(u.x / halfW, 2.));
  col += vec3(.25, .12, .08) * smoothstep(PX * 2., 0., abs(u.y - ropeY)) * .5;
  float spacing = .17;
  float li = floor(u.x / spacing + .5);
  float lx = li * spacing;
  vec2 hook = vec2(lx, .46 - .03 * (1. - pow(lx / halfW, 2.)) + .004);
  float H = .12, W = H * .64;
  vec2 ld = rot(sin(t * 1.3 + li) * .08) * (u - hook);
  vec2 cell = vec2(.5 + ld.x / W, -ld.y / H);
  float inside = step(0., cell.x) * step(cell.x, 1.) * step(0., cell.y) * step(cell.y, 1.);
  vec4 lantern = texture(u_sprite, clamp(cell, 0., 1.)) * inside;
  vec3 warm = hash(vec2(li, 5.)) > .5 ? vec3(1., .34, .16) : vec3(1., .62, .24);
  float flicker = .88 + .08 * sin(t * 2. + li) + .04 * sin(t * 9.3 + li * 3.);
  col = col * (1. - lantern.a) + lantern.rgb * warm * flicker * 1.15;
  // each lantern's glow, from its own neighbours too, so it never ends at a cell's edge
  for (int k = -1; k <= 1; k++) {
    float lk = li + float(k);
    float gx = lk * spacing;
    vec2 gHook = vec2(gx, .46 - .03 * (1. - pow(gx / halfW, 2.)) + .004);
    vec2 centre = gHook + rot(-sin(t * 1.3 + lk) * .08) * vec2(0., -H * .42);
    float d = length(u - centre);
    vec3 gWarm = hash(vec2(lk, 5.)) > .5 ? vec3(1., .34, .16) : vec3(1., .62, .24);
    float gFlicker = .88 + .08 * sin(t * 2. + lk) + .04 * sin(t * 9.3 + lk * 3.);
    col += gWarm * exp(-d * 18.) * smoothstep(.22, .04, d) * .22 * gFlicker;
  }
  return col;
}
`),

  // Vaporwave: a pastel sunset over a calm sea, the sun's reflection
  // shimmering on the water, palms framing the hero; it all scrolls away
  // with the hero.
  vaporwave: shader(`
uniform sampler2D u_sprite;

/* A palm silhouette (the sprite, 519x880, trunk foot at the bottom middle)
   standing at base, height tall, mirrored when flip is -1. The trunk hardly
   moves; the wind is in the fronds, each turning about the crown on its own
   beat, further the nearer its tip, all leaning downwind when a gust comes
   through. seed tells the palms apart. */
float palm(vec2 q, vec2 base, float height, float flip, float t, float seed) {
  // The sprite's gradients, taken here while every pixel is still running: a
  // texture() after the early returns below gets no derivatives along the
  // sprite's box, picks a far mip there, and on phone GPUs that drew the box's
  // outline round each palm.
  vec2 scale = vec2(flip / (519. / 880.), -1.) / height;
  vec2 gx = dFdx(q) * scale, gy = dFdy(q) * scale;
  vec2 l = (q - base) / height;
  l.x *= flip;
  if (abs(l.x) > .34 || l.y < 0. || l.y > 1.02) return 0.;
  // gusts come and go, reaching each palm at its own time
  float gust = .35 + .65 * smoothstep(.25, .8, noise(vec2(t * .22 - base.x * .6, seed)));
  l.x -= (.002 + .005 * gust) * l.y * l.y * (.6 + .4 * sin(t * .5 + seed * 4.));
  // the crown: fronds fan out from here
  vec2 d = l - vec2(0., .705);
  float r = length(d), reach = min(r / .3, 1.2);
  float th = atan(d.y, d.x);
  // the trunk below the crown stays put (it leans a little, left of the crown at its foot)
  float trunk = smoothstep(.08, .05, abs(d.x - .05 * d.y)) * smoothstep(0., -.04, d.y);
  float frond = smoothstep(.02, .1, r) * (1. - smoothstep(.36, .43, r)) * (1. - trunk);
  float beat = 2.5 * sin(2. * th + seed) + 1.7 * sin(3. * th + 2. * seed);
  float turn = (.028 * sin(t * 1.15 + beat) + .012 * sin(t * 2.7 + beat * 1.7 + r * 14.)) * gust;
  turn += .006 * sin(t * 6.3 + th * 9. + r * 30.) * reach * gust;
  d = rot(turn * reach * frond) * d;
  d.x -= .02 * gust * reach * reach * frond;
  l = d + vec2(0., .705);
  vec2 cell = vec2(.5 + l.x / (519. / 880.), 1. - l.y);
  if (cell.x < 0. || cell.x > 1. || cell.y < 0. || cell.y > 1.) return 0.;
  return textureGrad(u_sprite, cell, gx, gy).a;
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  float H = .03 + min(u_scroll, 1.2);
  vec2 q = vec2(p.x, p.y);
  float y = q.y - H;
  vec3 col;
  vec2 sp = vec2(aspect * .27, H + .14);
  if (y > 0.) {
    col = mix(vec3(1., .66, .55), vec3(.9, .45, .68), smoothstep(0., .14, y));
    col = mix(col, vec3(.42, .22, .55), smoothstep(.12, .32, y));
    col = mix(col, vec3(.12, .07, .22), smoothstep(.3, .55, y));
    float d = length(q - sp);
    // the stripes slide down through the sun's lower half
    float cut = (q.y < sp.y - .02 && fract((sp.y - q.y) * 32. - t * .4) < .3 * smoothstep(sp.y, sp.y - .13, q.y) + .05) ? 0. : 1.;
    vec3 sunCol = mix(vec3(1., .5, .7), vec3(1., .9, .55), smoothstep(-.13, .13, q.y - sp.y));
    col = mix(col, sunCol, smoothstep(.13 + PX * 2., .13 - PX * 2., d) * cut);
    col += vec3(1., .6, .75) * exp(-max(d - .13, 0.) * 8.) * .25;
    // stars coming out high up
    col += vec3(1., .9, 1.) * stars(q, 40., .12, t) * smoothstep(.2, .45, y) * .8;
    // soft pastel clouds drifting by
    float cl = fbm(vec2(q.x * 1.5 + t * .04, y * 6. + sin(t * .1) * .2));
    col = mix(col, vec3(1., .8, .9), smoothstep(.55, .8, cl) * smoothstep(.04, .12, y) * .35);
  } else {
    // the sea, with the sun's broken reflection
    col = mix(vec3(.26, .14, .36), vec3(.07, .04, .12), smoothstep(0., -.35, y));
    // waves roll in toward the viewer: closer rows are wider apart and move faster
    float depth = .02 / max(-y, .002);
    float wave = sin(depth * 40. + t * 1.6 + noise(vec2(q.x * 6. * depth, depth * 3. + t * .3)) * 4.);
    float streak = .5 + .5 * wave;
    // the sun's reflection breaks into glints that flicker as the waves pass
    // flecks wider than tall, as sun on water breaks up
    float glint = smoothstep(.75, 1., streak) * step(.4, noise(vec2(q.x * 22., y * 140. + depth * 8. - t * 2.)));
    float column = exp(-abs(q.x - sp.x) / (.06 + -y * .3)) * exp(y * 10.);
    // Away from the horizon depth hardly changes, so the wave rows widen into
    // flat blotches and the glints into vertical bars: the light stays in the
    // thin rows near the horizon and the sea below settles into plain dark water.
    float near = smoothstep(-.14, -.03, y);
    col += vec3(1., .7, .75) * column * (smoothstep(.5, 1., streak) * .45 + glint * .8) * near;
    col += vec3(.6, .5, .9) * smoothstep(.85, 1., streak) * exp(y * 5.) * .18 * near;
  }
  col += vec3(1., .75, .85) * exp(-abs(y) * 60.) * .4;
  // palms framing the hero, their fronds stirring in the sea breeze
  float trees = palm(q, vec2(-aspect * .5 + .1, H - .03), .58, 1., t, 1.);
  trees = max(trees, palm(q, vec2(aspect * .5 - .12, H - .03), .62, -1., t, 2.7));
  trees = max(trees, palm(q, vec2(aspect * .5 - .32, H - .03), .4, 1., t, 4.3));
  col = mix(col, vec3(.08, .03, .12), trees);
  // a VHS line rolling down
  col += vec3(.6, .5, .8) * exp(-abs(fract(uv.y + t * .05) - .5) * 80.) * .04;
  return col * .72;
}`),

  // Shattered stars: a black void where six-pointed stars swell, flinch back,
  // turn red, throw out white beams and burst into shards, and red warning
  // lines (sometimes turning) snap into white slashes that crack diamonds
  // out along the cut; now and then a roar of red streaks rushes across it.
  // Flat white, red and mauve on black, on the game's low-res pixel grid.
  knight: shader(`
/* Signed distance to a six-pointed star of outer radius r. */
float hexagram(vec2 p, float r) {
  const vec4 k = vec4(-.5, .8660254, .5773503, 1.7320508);
  p = abs(p);
  p -= 2. * min(dot(k.xy, p), 0.) * k.xy;
  p -= 2. * min(dot(k.yx, p), 0.) * k.yx;
  p -= vec2(clamp(p.x, r * k.z, r * k.w), r);
  return length(p) * sign(p.y);
}

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0., 1.));
}

/* Signed distance to a small diamond pointing along d. */
float diamond(vec2 p, vec2 d, float len, float wid) {
  vec2 q = vec2(dot(p, d), dot(p, vec2(-d.y, d.x)));
  q = abs(q);
  return (q.x / len + q.y / wid - 1.) * min(len, wid) * .7;
}

vec3 theme(vec2 uv, vec2 p, float t) {
  // drawn on the game's low-res pixel grid
  p = (floor(p * 200.) + .5) / 200.;
  float sc = u_scroll;
  float aspect = u_res.x / u_res.y;
  float aa = .001;
  vec3 col = vec3(.006, .004, .01);
  // a low mauve haze, the colour of its starry beam, rising off as the page scrolls
  col += vec3(.16, .05, .16) * pow(max(0., 1. - (p.y + .5 + sc * .3) * 1.4), 3.) * (.55 + .45 * noise(vec2(p.x * 2. + t * .05, t * .1)));
  // fine white specks, far off
  col += vec3(.7, .65, .8) * stars(p - vec2(0., sc * .06), 60., .08, t) * .35;
  // the stars: each on its own cycle
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float period = 5. + 2. * hash(vec2(fi, 1.));
    float cyc = t / period + hash(vec2(fi, 2.));
    float id = floor(cyc), a = fract(cyc) * period;
    vec2 c = (vec2(hash(vec2(id, fi)), hash(vec2(id, fi + 7.))) - .5) * vec2(aspect * .9, .8);
    vec2 drift = normalize(vec2(hash(vec2(id, fi + 3.)) - .5, hash(vec2(id, fi + 4.)) - .5) + 1e-3) * .025;
    // swell and drift, a flinch back, red, beams, then shards
    float grow = smoothstep(0., 2.2, a);
    float back = smoothstep(2.4, 2.6, a) - smoothstep(2.6, 2.9, a);
    vec2 at = c + drift * (a - back * 1.5) - vec2(0., sc * .1);
    float r = mix(.008, .05, grow) * (1. - smoothstep(3.25, 3.3, a));
    bool red = a > 2.6;
    float spin = a * .3 + fi;
    vec2 q = rot(spin) * (p - at);
    if (r > .001) {
      float d = hexagram(q, r);
      float body = smoothstep(aa, -aa, d);
      float rim = smoothstep(aa, -aa, abs(d + r * .12) - r * .1);
      vec3 ink = red ? vec3(.95, .12, .16) : vec3(.95, .92, 1.);
      col = mix(col, vec3(.02, .0, .02), body);
      col = mix(col, ink, rim);
    }
    // beams from its six points just before it bursts
    if (a > 2.95 && a < 3.25) {
      float k = (a - 2.95) / .3;
      for (int j = 0; j < 6; j++) {
        vec2 dir = vec2(sin(spin + float(j) * 1.0472), cos(spin + float(j) * 1.0472));
        dir = vec2(dir.x, dir.y);
        float d = segDist(rot(-spin) * q, dir * .05, dir * (.05 + .6 * k));
        col = mix(col, vec3(1.), step(d, .004) * (1. - k * .5));
      }
    }
    // shards flying out
    if (a > 3.25 && a < 4.3) {
      float k = (a - 3.25) / 1.05;
      for (int j = 0; j < 6; j++) {
        vec2 dir = rot(-spin) * vec2(sin(float(j) * 1.0472), cos(float(j) * 1.0472));
        vec2 sp = at + dir * (.03 + .32 * (1. - (1. - k) * (1. - k)));
        float d = diamond(p - sp, dir, .024 * (1. - k * .5), .01 * (1. - k * .5));
        col = mix(col, vec3(.95, .2, .25), smoothstep(aa, -aa, d));
      }
    }
  }
  // slashes: a red warning line, then a white cut, then diamonds out of the cut
  for (int s = 0; s < 2; s++) {
    float fs = float(s);
    float period = 3.4 + fs * 1.3;
    float cyc = t / period + fs * .45;
    float id = floor(cyc), a = fract(cyc) * period;
    float turning = step(.66, hash(vec2(id, fs + 9.)));
    float ang0 = hash(vec2(id, fs + 1.)) * 3.1416;
    float ang = ang0 + turning * min(a, .6) * 1.4;
    vec2 n = vec2(-sin(ang), cos(ang));
    vec2 o = (vec2(hash(vec2(id, fs + 2.)), hash(vec2(id, fs + 3.))) - .5) * vec2(aspect * .6, .5);
    float across = dot(p - o, n);
    float along = dot(p - o, vec2(n.y, -n.x));
    if (a < .6) {
      // the warning: a thin red line, flickering
      float on = .55 + .45 * step(.5, fract(a * 14.));
      col = mix(col, vec3(.85, .08, .12), step(abs(across), .003) * on * smoothstep(0., .08, a));
    } else if (a < 1.05) {
      // the cut: a white blade of light, widest in the middle, tapering to the ends, then thinning out
      float k = (a - .6) / .45;
      float halfLen = aspect * .9;
      float taper = max(0., 1. - pow(along / halfLen, 2.));
      float width = (.012 * taper) * (1. - k) + PX * .5;
      col = mix(col, vec3(1.), smoothstep(width + aa, width, abs(across)) * (1. - k * k));
      // diamonds out of the cut, half each way
      for (int j = 0; j < 8; j++) {
        float fj = float(j);
        float pos = (hash(vec2(id + fj, fs + 4.)) - .5) * aspect * 1.4;
        float side = j < 4 ? 1. : -1.;
        float speed = .18 + .25 * hash(vec2(id + fj, fs + 5.));
        vec2 dp = o + vec2(n.y, -n.x) * pos + n * side * speed * k;
        float d = diamond(p - dp, n, .02, .009);
        col = mix(col, vec3(.95, .9, 1.), smoothstep(aa, -aa, d) * (1. - k));
      }
    }
  }
  // now and then the roar: red streaks rushing out from off to the right, the void flushing red
  float rc = t / 11. + .3;
  float ra = fract(rc) * 11.;
  if (ra < 1.2) {
    vec2 from = vec2(aspect * (.3 + .12 * hash(vec2(floor(rc), 1.))), .05 - sc * .2);
    vec2 d = p - from;
    float dist = length(d);
    col += vec3(.1, .0, .02) * (1. - ra / 1.2) * smoothstep(1.3, 0., dist);
    float bins = 56.;
    float ang = (atan(d.y, d.x) / 6.2832 + .5) * bins;
    float bin = floor(ang);
    float hb = hash(vec2(bin, floor(rc)));
    float head = (ra - hb * .25) * (1.1 + .9 * hash(vec2(bin, 3.)));
    float len = .1 + .25 * hash(vec2(bin, 4.));
    float on = step(.35, hb) * step(head - len, dist) * step(dist, head) * step(.08, dist);
    float thin = abs(fract(ang) - .5) * 6.2832 / bins * dist;
    float wid = (.0025 + .003 * hash(vec2(bin, 5.))) * (1. - ra / 1.2);
    col = mix(col, vec3(.92, .1, .16), on * smoothstep(wid + aa, wid, thin));
  }
  col *= 1. - .3 * dot(p * vec2(.7, 1.), p * vec2(.7, 1.));
  return col;
}`),

  // Bullet hell: a boss fight with no boss in it. A smoky glow turns from
  // violet to deep blue to the red of a roar, light streaming out of a
  // white-hot point in its middle (no figure there: one was tried and read as
  // an eye). Star bullets drift past, the far ones smeared into scanlines,
  // the near ones leaving the light one by one (they used to circle it,
  // which looked like a carousel round an empty point); now and then a flurry of
  // white shards falls; the red SOUL keeps dodging. All drawn here.
  // The bullets follow the fight they nod to: upright stars, much wider than
  // tall, ONE thick outline round a darker middle with a white diamond at the
  // heart, and a small barb standing off each of the four side points (ten
  // tips in all). No second outline inside and no spin: thin crossed lines
  // turning on the spot read as a different, unrelated symbol.
  knightfight: shader(`
float hexagram(vec2 p, float r) {
  const vec4 k = vec4(-.5, .8660254, .5773503, 1.7320508);
  p = abs(p);
  p -= 2. * min(dot(k.xy, p), 0.) * k.xy;
  p -= 2. * min(dot(k.yx, p), 0.) * k.yx;
  p -= vec2(clamp(p.x, r * k.z, r * k.w), r);
  return length(p) * sign(p.y);
}

/* A star bullet (its tips reach 2r up and down, 2.4r sideways): x = the
   thick outline, y = the darker middle inside it, z = the diamond at its heart. */
vec3 starParts(vec2 q, float r) {
  // the barb on each side point: a small spike off its flat edge, the same in all four corners
  vec2 a = abs(q) / r;
  float barb = step(.9, a.y) * step(.86 * (a.y - 1.) - .36 * (a.x - 1.1), 0.) * step(0., .2 * (a.y - 1.) - .36 * (a.x - 1.84));
  q.x /= 1.4;
  float d = hexagram(q, r);
  float rim = max(step(abs(d + r * .15), r * .15), barb);
  float inside = step(d, -r * .3);
  float core = step(abs(q.x) * 1.15 + abs(q.y), r * .4);
  return vec3(rim, inside, core);
}

/* The same as one coverage, for the far ones: the outline and the diamond. */
float starBullet(vec2 q, float r) {
  vec3 s = starParts(q, r);
  return max(s.x, s.z);
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float sc = u_scroll;
  float aspect = u_res.x / u_res.y;
  // the fight's three moods on a loop: violet, deep blue, then the red roar
  float cyc = mod(t, 30.);
  float wB = smoothstep(11., 13., cyc) * (1. - smoothstep(20., 21.5, cyc));
  float wR = smoothstep(20., 21.5, cyc) * (1. - smoothstep(28.5, 30., cyc));
  float wP = 1. - wB - wR;
  vec3 tint = vec3(.46, .14, .7) * wP + vec3(.1, .16, .78) * wB + vec3(.75, .05, .08) * wR;
  vec3 pale = vec3(.85, .74, 1.) * wP + vec3(.75, .82, 1.) * wB + vec3(1., .8, .8) * wR;
  vec2 kp = vec2(aspect * .2, .1 + sc * .35) + vec2(sin(t * .7) * .012, sin(t * 1.1) * .01);
  // smoke swirling round it, lit from the Knight
  vec2 d = p - kp;
  vec2 w = p * 1.6 + vec2(0., sc * .3);
  float smoke = fbm(w + vec2(fbm(w * 1.3 + t * .05), fbm(w * 1.3 + 4. - t * .04)) * 1.6 + t * .02);
  float glow = exp(-length(d * vec2(.8, 1.)) * 2.6);
  vec3 col = tint * (.05 + .55 * glow) * (.45 + 1.1 * smoke);
  col += tint * .12 * smoothstep(.45, .8, smoke);
  // light streaming out from behind it
  float ang = atan(d.y, d.x);
  float rays = pow(.5 + .5 * sin(ang * 11. + noise(vec2(ang * 3., t * .3)) * 4.), 5.) * exp(-length(d) * 3.2);
  col += mix(tint, pale, .5) * rays * .35 * smoothstep(0., .07, length(d));
  // the point it streams from: a small white-hot core and a thin flare across it
  float dl = length(d * vec2(.9, 1.));
  col += pale * (exp(-dl * 26.) * .85 + exp(-dl * 9.) * .22);
  col += pale * exp(-abs(d.y) * 90.) * exp(-abs(d.x) * 7.) * .3;
  // far star bullets, smeared sideways into scanlines
  for (int l = 0; l < 2; l++) {
    float fl = float(l);
    float cell = .36 - fl * .1;
    vec2 q = p * vec2(1., 1.) + vec2(t * (.03 + fl * .02), -t * .015 - sc * (.15 + fl * .1));
    vec2 home = floor(q / cell);
    float smear = 0.;
    // a star reaches past its own cell (tips at 2r, jitter, smear), so the
    // neighbours are checked too, or it gets clipped square at the cell edge
    for (int j = 0; j < 9; j++) {
      vec2 id = home + vec2(float(j - j / 3 * 3) - 1., float(j / 3) - 1.);
      if (hash(id + fl * 7.) < .72) continue;
      vec2 c = (id + .5 + (vec2(hash(id + 1.), hash(id + 2.)) - .5) * .5) * cell;
      float r = cell * (.15 + .08 * hash(id + 5.));
      if (length(q - c) > r * 3.3) continue;
      vec2 s = q - c;
      for (int k = 0; k < 4; k++) smear = max(smear, starBullet(s + vec2(float(k) * r * .22, 0.), r) * (1. - float(k) * .25));
    }
    float scan = step(.5, fract(gl_FragCoord.y / 3.));
    col = mix(col, pale * .8, smear * scan * (.22 + fl * .1));
  }
  vec2 pp = (floor(p * 210.) + .5) / 210.;
  // nearer star bullets streaming out of the light, crisp. Each of the
  // fourteen keeps its own clock and, every time it leaves, draws a new
  // heading, curl, reach and size (and sometimes sits a turn out), so no two
  // passes match and nothing lines up into a ring: rings of eight on one
  // clock read as a predictable pattern. They grow as they come and fade
  // before the edge. On a finer grid than the shards and the SOUL (the barbs
  // need the pixels), and light, not solid: the outline lets the glow through
  // and the middle is only a shade darker than what is behind it.
  vec2 ps = (floor(p * 330.) + .5) / 330.;
  for (int i = 0; i < 14; i++) {
    float fi = float(i);
    float cyc = t / (7. + 6. * hash(vec2(fi, 3.))) + hash(vec2(fi, 5.)) * 9.;
    float n = floor(cyc), u = fract(cyc);
    if (hash(vec2(fi + 40., n)) < .22) continue;
    float h1 = hash(vec2(fi, n)), h2 = hash(vec2(fi + 9., n)), h3 = hash(vec2(n, fi + 21.));
    float a = h1 * 6.2832 + (h2 - .5) * 1.8 * u;
    vec2 c = kp + vec2(cos(a) * 1.35, sin(a)) * (.03 + pow(u, .8 + .5 * h2) * (.7 + .5 * h3));
    float r = (.011 + .02 * u) * (.75 + .6 * h3);
    vec2 sd = ps - c;
    if (abs(sd.x) > r * 2.6 || abs(sd.y) > r * 2.2) continue;
    vec3 b = starParts(sd, r) * smoothstep(.02, .12, u) * (1. - smoothstep(.72, 1., u));
    col = mix(col, col * .55, b.y * .7);
    col = mix(col, pale, b.x * .62);
    col = mix(col, mix(pale, vec3(1.), .6), b.z * .85);
  }
  // now and then a flurry of white shards falls through
  float fz = mod(t, 30.);
  if (fz > 4. && fz < 9.5) {
    float k = fz - 4.;
    vec2 q = pp * vec2(1., 1.) + vec2(0., k * .25);
    vec2 id = floor(q / .15);
    if (hash(id + 11.) > .84) {
      vec2 f = fract(q / .15) - .5 - (vec2(hash(id + 12.), hash(id + 13.)) - .5) * .3;
      f = rot(hash(id) * 6.28 + k * (hash(id + 14.) - .5) * 3.) * f;
      // a chunky, jagged-edged shard, pointed at one end
      float blob = step(max(abs(f.x) * 1.6 + f.y * .9, -f.y * 1.4) + (noise(f * 22. + id * 3.) - .5) * .12, .2);
      float fade = smoothstep(4., 5., fz) * (1. - smoothstep(8.5, 9.5, fz));
      col = mix(col, vec3(1.), blob * fade);
    }
  }
  // the SOUL, dodging below and to the left
  vec2 hp = kp + vec2(-.3 + .05 * sin(t * 1.3), -.2 + .04 * sin(t * 1.9 + 1.));
  vec2 hq = (pp - hp) / .017;
  hq.y = -hq.y;
  float heart = step(length(vec2(abs(hq.x) - .5, hq.y + .2)), .62) + step(abs(hq.x) + hq.y * 1.1, 1.05) * step(-.2, hq.y);
  col = mix(col, vec3(1., 0., 0.), clamp(heart, 0., 1.));
  col *= 1. - .3 * dot(p * vec2(.6, 1.), p * vec2(.6, 1.));
  return col;
}`),

  // Black hole: a Schwarzschild hole, ray traced. Each pixel near it follows
  // its light back through the curved space (units of M: horizon at 2, photon
  // sphere at 3), so the far side of the disk arches over and under the
  // shadow, a thin photon ring rims it and the stars behind smear into arcs.
  // The disk turns at Kepler speed (inner streaks lap the outer ones), is
  // hotter inward, and is brighter and bluer on the side coming at us. Rays
  // that pass far away get the weak-field bend in closed form instead.
  blackhole: shader(`
const float BH_PI = 3.14159265, BH_TAU = 6.2831853;
const float BH_D = 55.;     // camera distance
const float BH_K = .72;     // ray angle (radians) per canvas height
const float BH_RIN = 6., BH_ROUT = 19.;
const float BH_TRACE = 23.; // impact parameter inside which rays are traced
// How much of the bend the starfield shows: all of it smears the stars into
// streaks half a screen away, as if the stars sat just behind the hole.
const float BH_SKYBEND = .4;

// fbm without its finest octave (1/32 of the whole), for the nebula: the
// thresholds it goes through wash that octave out, and the sky is drawn on
// nearly every pixel
float bhFbm4(vec2 p) {
  float v = 0., a = .5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + 7.1;
    a *= .5;
  }
  return v + .015;
}

// The sky behind the hole: blue and rose nebula, richest near the hole so
// the lensing has something to bend, and stars, a few of them bright.
vec3 bhSky(vec2 q, vec2 c, float t) {
  vec3 col = vec3(.006, .004, .012);
  float n1 = bhFbm4(q * 1.3 + vec2(t * .004, 0.));
  float n2 = bhFbm4(q * 2.7 - 3.1 + vec2(0., t * .003));
  float near = .45 + 1.3 * exp(-length(q - c) * 1.7);
  col += (vec3(.03, .09, .22) * smoothstep(.42, .85, n1) + vec3(.2, .05, .14) * smoothstep(.48, .9, n2) * n1) * near;
  vec2 sq = q - vec2(0., u_scroll * .05);
  col += vec3(.85, .9, 1.) * stars(sq, 36., .14, t);
  col += vec3(.8, .85, 1.) * stars(sq + 2.3, 80., .2, t) * .5;
  col += mix(vec3(1., .85, .7), vec3(.7, .85, 1.), step(.5, hash(floor(sq * 12.)))) * stars(sq - 5.7, 12., .05, t) * 1.8;
  return col;
}

// Glow colour for a relative temperature: ember red, orange, gold, white, blue-white.
vec3 bhHeat(float T) {
  vec3 c = mix(vec3(.3, .025, .008), vec3(1., .3, .05), smoothstep(.12, .45, T));
  c = mix(c, vec3(1., .66, .3), smoothstep(.4, .72, T));
  c = mix(c, vec3(1., .92, .8), smoothstep(.68, 1., T));
  return mix(c, vec3(.8, .88, 1.), smoothstep(1., 1.45, T));
}

// Disk streaks around the ring, seamless where the angle wraps.
float bhStreak(float a, float lr, vec2 f) {
  float w = (BH_PI - a) / BH_TAU;
  return mix(fbm(vec2(a, lr) * f), fbm(vec2(a + BH_TAU, lr) * f), w);
}

// The disk where a ray crosses its plane: light (premultiplied) and cover.
vec4 bhDisk(vec3 hit, vec3 dir, float t) {
  float r = length(hit.xz);
  if (r < BH_RIN * .92 || r > BH_ROUT) return vec4(0.);
  float a = atan(hit.z, hit.x) - t * 3.2 * pow(r, -1.5);
  a = mod(a + BH_PI, BH_TAU) - BH_PI;
  float lr = log(r);
  float coarse = bhStreak(a, lr, vec2(2., 11.));
  float fine = bhStreak(a, lr, vec2(5., 38.));
  float dens = smoothstep(.2, .85, coarse * .75 + fine * .45);
  float lane = smoothstep(.56, .7, fine) * smoothstep(.4, .6, coarse);
  // hot knots riding the flow
  float knot = smoothstep(.68, .88, bhStreak(a, lr, vec2(8., 70.))) * smoothstep(.45, .7, coarse);
  // brightest a little outside the inner edge, falling off outward
  float x = BH_RIN / r;
  float prof = pow(x, 3.) * max(1. - sqrt(x), 0.) / .057 + .25 * smoothstep(BH_RIN * .92, BH_RIN, r) * smoothstep(BH_RIN * 1.4, BH_RIN, r);
  // orbital speed seen by a static observer, Doppler shift and the climb out
  float beta = min(1. / sqrt(max(r - 2., 1.)), .55);
  float cosT = dot(normalize(vec3(-hit.z, 0., hit.x)), -dir);
  float g = sqrt(1. - 2. / r) / (inversesqrt(1. - beta * beta) * (1. - beta * cosT));
  float T = .8 * pow(prof, .25) * mix(1., g, .85);
  float beam = mix(1., g * g * g, .8);
  float edge = smoothstep(BH_ROUT, BH_ROUT - 6., r) * smoothstep(BH_RIN * .92, BH_RIN * 1.05, r);
  vec3 light = bhHeat(T + .25 * knot) * prof * beam * (.45 + 1.1 * dens + 1.6 * knot) * (1. - .7 * lane) * 2.;
  float cover = clamp(.4 + dens * .7 - lane * .3, 0., .97) * edge;
  return vec4(light * cover, cover);
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  // right of centre with the whole disk on screen, centred on a narrow one
  vec2 c = vec2(max(min(aspect * .2, aspect * .5 - .5), 0.), .24 + u_scroll);
  // the pointer turns the view a few degrees around the hole
  vec2 pp = pointerP();
  float incl = .1 + pp.y * .07;
  float yaw = pp.x * .08;
  float roll = -.2;
  vec2 q = rot(roll) * (p - c);
  float qLen = length(q);
  vec2 qDir = q / max(qLen, 1e-5);
  float b = qLen * BH_D * BH_K; // impact parameter
  // weak-field bend toward the hole, for a camera at BH_D
  float bb = max(b, 1.);
  float bend = (4. / bb + 11.8 / (bb * bb)) * .5 * (1. + BH_D / sqrt(BH_D * BH_D + bb * bb));
  vec2 bg = q - qDir * min(bend, 1.5) * BH_SKYBEND / BH_K;
  vec3 disk = vec3(0.);
  float cover = 0.;
  float dark = 0.;
  vec3 haze = vec3(0.);
  if (b < BH_TRACE) {
    vec3 cam = BH_D * vec3(sin(yaw) * cos(incl), sin(incl), -cos(yaw) * cos(incl));
    vec3 fwd = -cam / BH_D;
    vec3 right = normalize(cross(vec3(0., 1., 0.), fwd));
    vec3 up = cross(fwd, right);
    float a0 = qLen * BH_K;
    vec3 dir = fwd * cos(a0) + (qDir.x * right + qDir.y * up) * sin(a0);
    // straight in to r = 30, where the bending starts to matter
    vec3 pos = cam;
    float along = -dot(pos, dir);
    vec3 near = pos + dir * along;
    pos = near - dir * sqrt(max(900. - dot(near, near), 0.));
    vec3 hv = cross(pos, dir);
    float h2 = dot(hv, hv);
    bool out_ = false;
    for (int i = 0; i < 180; i++) {
      float r2 = dot(pos, pos);
      float r = sqrt(r2);
      float dt = clamp(.07 * r, .04, 2.) * mix(.4, 1., smoothstep(2.6, 5., r));
      vec3 prev = pos;
      // the light's path in Schwarzschild space, as a force in flat space:
      // a = -3 M h^2 x / r^5 (M = 1), stepped leapfrog
      // (r^5 multiplied out: pow() twice a step was most of the loop's cost)
      dir -= 1.5 * h2 * dt / (r2 * r2 * r) * pos;
      pos += dir * dt;
      r2 = dot(pos, pos);
      r = sqrt(r2);
      dir -= 1.5 * h2 * dt / (r2 * r2 * r) * pos;
      if (prev.y * pos.y < 0.) {
        vec4 d = bhDisk(mix(prev, pos, prev.y / (prev.y - pos.y)), normalize(dir), t);
        disk += (1. - cover) * d.rgb;
        cover += (1. - cover) * d.a;
      }
      // a thin warm haze hugging the disk, so it has some depth
      haze += (1. - cover) * vec3(1., .48, .18) * exp(-pos.y * pos.y * .9) * smoothstep(21., 8., r) * smoothstep(4.5, 7.5, r) * dt * .016;
      if (r < 2.02 || cover > .985) break;
      if (r > 31. && dot(pos, dir) > 0.) { out_ = true; break; }
    }
    if (!out_) dark = 1.;
    // haze on a ray that falls in would fog the shadow
    if (out_) disk += haze;
    // where the ray left for, in the same screen units
    vec3 v = normalize(dir);
    vec2 side = vec2(dot(v, right), dot(v, up));
    vec2 traced = side / max(length(side), 1e-5) * atan(length(side), dot(v, fwd)) / BH_K;
    bg = mix(q + (traced - q) * BH_SKYBEND, bg, smoothstep(BH_TRACE - 6., BH_TRACE - .5, b));
  }
  // the sky only where some of it shows: inside the shadow, or behind solid
  // disk, its two fbm fields and three star layers would be multiplied away
  float skyShows = (1. - dark) * (1. - cover);
  vec3 col = (skyShows > .002 ? bhSky(rot(-roll) * bg + c, c, t) * skyShows : vec3(0.)) + disk;
  // the photon ring: light that circled the hole before escaping piles up
  // just outside the shadow (b = 3 sqrt 3)
  col += vec3(1., .8, .55) * exp(-abs(b - 5.25) * 5.) * .5 * (1. - cover);
  // light spilling off the disk: a halo round the shadow and a flare along
  // the disk's plane, stronger on the side coming at us (left)
  col += vec3(1., .5, .2) * exp(-max(b - 5.2, 0.) * .18) * smoothstep(4.6, 5.3, b) * .09 * (1. - cover);
  vec2 qd = vec2(q.x, (q.y + .012) / max(sin(incl) + .06, .06)) * BH_D * BH_K;
  float flare = exp(-abs(qd.y) * .09) * exp(-abs(qd.x) * .08) * (1. - .45 * clamp(q.x * 6., -1., 1.));
  col += vec3(1., .55, .25) * flare * .1 * (1. - cover);
  // jets: thin blue plasma flowing out along the spin axis, both ways, behind
  // the disk where it crosses them
  float ay = abs(q.y);
  float jw = .008 + .045 * ay;
  float jflow = .45 + .9 * noise(vec2(q.x / jw * 1.5 + sign(q.y) * 7., ay * 9. - t * 2.2));
  float jet = exp(-q.x * q.x / (jw * jw)) * smoothstep(.1, .2, ay) * exp(-ay * 2.6) * jflow;
  col += vec3(.5, .72, 1.) * jet * .3 * (1. - cover) * (1. - dark * step(q.y, 0.));
  return 1. - exp(-col * 1.25);
}`),

  // Singularity: after the Parallel Universe Shifter jacket. A ray-marched
  // ball of cobalt glass, lit from the glare off to its right, whose front
  // falls in as a whirlpool: its skin is cut into three thick strips that
  // spiral down a funnel to a molten core, with the dark hollow inside showing
  // between them. The strips' cut edges are painted pink and blue, and the
  // core's red light reaches only the walls near it. Black paint bursts off
  // its dark side up and left; a drip hangs from its underside, swells and
  // lets go, with red drops falling past. Behind it a tunnel of light rushes
  // out, with arcs of light swirling in a pool below. It fades to deep blue
  // toward the rest of the page and scrolls away with the hero.
  singularity: shader(`
const float SG_PI = 3.14159265, SG_TAU = 6.2831853;
const float SG_R = .22; // the orb's radius, canvas heights
// The whirlpool's axis, tipped toward us and a little left; the core sits at
// the bottom of the funnel, just short of the ball's centre.
const vec3 SG_AX = vec3(-.46, .14, .877);
const vec3 SG_CORE = SG_AX * .2;
// the whirlpool's own frame round its axis, worked out once rather than per step
const vec3 SG_B1 = normalize(cross(SG_AX, vec3(0., 1., 0.)));
const vec3 SG_B2 = cross(SG_AX, SG_B1);
// How far the whole ball is turned from facing us, radians.
const float SG_YAW = .3;
// The key light: the glare off to the right.
const vec3 SG_KEY = vec3(.72, .3, .62);
// The march's step budget.
const int SG_STEPS = 80;

// Light rushing out past the orb, in direction ca at log-distance lr.
float sgStreaks(vec2 ca, float lr, float t) {
  vec2 flow = vec2(lr * 1.6 - t * 1.1, 0.);
  return pow(inoise(ca * 22. + flow), 3.) * .9 + pow(inoise(ca * 64. + flow * 1.4 + 3.), 6.) * 2.2 + pow(inoise(ca * 150. + flow * 1.8 + 7.), 9.) * 2.;
}

vec3 sgTunnel(vec2 d, float t) {
  vec2 o = d - vec2(.05, .03);
  float r = length(o);
  vec2 ca = o / max(r, 1e-4);
  vec3 col = mix(vec3(.006, .015, .1), vec3(.03, .2, .85), smoothstep(1.3, .15, r));
  float near = smoothstep(.12, .45, r) * (.2 + .8 * exp(-r * 1.3));
  col += vec3(.4, .75, 1.) * sgStreaks(ca, log(max(r, 1e-3)), t) * near;
  float sect = smoothstep(.35, .9, dot(ca, vec2(.8, .6)));
  col += vec3(1., .1, .3) * pow(inoise(ca * 30. + vec2(log(max(r, 1e-3)) * 1.9 - t * 1.3, 11.)), 4.) * 4. * sect * near;
  col += vec3(.8, .93, 1.) * exp(-length((d - vec2(.7, -.08)) * vec2(.7, 1.5)) * 2.6);
  // bright light right behind the ball, so it stands out dark against it
  col += vec3(.45, .75, 1.) * exp(-max(length(d) - SG_R, 0.) * 5.) * .45;
  return col;
}

// Arcs of light winding in a pool under the orb.
vec3 sgPool(vec2 d, float t) {
  vec2 f = d - vec2(-.02, -.5);
  f.y /= .34;
  float fr = length(f);
  float fa = atan(f.y, f.x);
  float u = fr * 3.2 + fa / SG_TAU * 3. + t * .12;
  float arc = exp(-abs(fract(u) - .5) * 18.) * smoothstep(1.4, .3, fr) * smoothstep(.05, .25, fr);
  // each arc brightens and fades along its length, never cut off, and fades
  // before the tight turns at the pool's ends, which read as corners
  arc *= smoothstep(.3, .8, inoise(vec2(cos(fa), sin(fa)) * 2. + vec2(fr * 1.5 - t * .3, 0.)));
  arc *= smoothstep(.97, .55, abs(cos(fa)));
  float pink = smoothstep(.55, .75, inoise(vec2(cos(fa), sin(fa)) * 1.5 + vec2(fr * 2. + 9., 0.)));
  return mix(vec3(.6, .9, 1.), vec3(1., .3, .62), pink) * arc * smoothstep(-.1, -.35, d.y);
}

// Where a point sits in the whirlpool: x = along the spiral (its fraction is
// across a strip), y = angle from the axis. Given the point's direction and
// that angle.
vec2 sgSwirlAt(vec3 pn, float th, float t) {
  float ph = atan(dot(pn, SG_B2), dot(pn, SG_B1));
  // (clamped short of the far pole, where tan blows up and the march would NaN)
  return vec2(ph * 2. / SG_TAU + log(clamp(tan(min(th, 2.9) * .5), 1e-3, 1e3)) * .55 - t * .05, th);
}

// The same, from the point alone.
vec2 sgSwirl(vec3 p, float t) {
  vec3 pn = normalize(p);
  return sgSwirlAt(pn, acos(clamp(dot(pn, SG_AX), -1., 1.)), t);
}

// The skin's radius at angle th from the axis: the ball's, falling in toward
// the core near the front.
float sgFunnel(float th) {
  return mix(.28, 1., smoothstep(.05, 1.15, th));
}

float sgRoundCone(vec3 p, vec3 a, vec3 b, float r1, float r2) {
  vec3 ba = b - a;
  float h = clamp(dot(p - a, ba) / dot(ba, ba), 0., 1.);
  return length(p - a - ba * h) - mix(r1, r2, h);
}

float sgSmin(float a, float b, float k) {
  float h = clamp(.5 + .5 * (b - a) / k, 0., 1.);
  return mix(b, a, h) - k * h * (1. - h);
}

// The angle round the ball, counted on past straight left: the ink spans it,
// so a seam there would cut through it.
float sgAngle(vec2 p) {
  float a = atan(p.y, p.x);
  return a < -1.5 ? a + SG_TAU : a;
}

// Value noise along the throw, x round the ball and y out from it, with each
// column of the grid slid outward by its own fraction of a cell. Value noise
// peaks on its grid, so unslid, the brightest stretch of every streak sits on
// the same ring, and the rings sweep outward as y scrolls.
float sgThrowColumn(int i, float y) {
  y += ihash(ivec2(i, 17));
  int j = int(floor(y));
  float g = fract(y);
  return mix(ihash(ivec2(i, j)), ihash(ivec2(i, j + 1)), g * g * (3. - 2. * g));
}

float sgThrowNoise(float x, float y) {
  int i = int(floor(x));
  float f = fract(x);
  return mix(sgThrowColumn(i, y), sgThrowColumn(i + 1, y), f * f * (3. - 2. * f));
}

// The ink: the ball's own liquid pulled out of its silhouette, up and left,
// and torn into chunks smeared outward along the throw, thick at the root and
// breaking up further out. A slab of the same liquid facing us, tapering
// toward its tips, unioned smoothly into the skin so the two are one surface
// under the same light. Returns a distance estimate (the outline is a noise
// field, bounded only loosely, so the march steps through it gently).
// Its outline as a field over the sheet, at rxy from the ball's middle and
// angle a round it: above zero inside the ink.
float sgInkField(float rxy, float a, float t) {
  float sect = smoothstep(1.75, 2.3, a) * smoothstep(3.75, 3.15, a);
  float al = rxy - 1.;
  float across = a * 1.3; // (by angle, so a chunk keeps its width as it flies)
  // (no finer than this: cells a few pixels wide by the ball cut every edge
  // there into a comb)
  float field = inoise(vec2(across * 8., al * 1.2 - t * .06)) * .6 + inoise(vec2(across * 13., al * 2.6 - t * .1) + 7.) * .3 + .05;
  return field - .34 - .4 * smoothstep(.04, 1.2, al) - .6 * (1. - sect) + .05 / rxy;
}

// Half the sheet's thickness at rxy.
float sgInkThick(float rxy) {
  return .03 + .22 * (1. - smoothstep(0., 1.1, rxy - 1.));
}

float sgInk(vec3 p, float t) {
  float rxy = length(p.xy);
  float a = sgAngle(p.xy);
  float ad = max(1.6 - a, a - 3.9);
  float bound = max(max(rxy - 2.6, .85 - rxy), max(ad > 0. ? rxy * sin(min(ad, 1.5)) : 0., abs(p.z + .05) - .3));
  if (bound > .06) return bound;
  return max(max(-sgInkField(rxy, a, t) * rxy / 16., abs(p.z + .05) - sgInkThick(rxy)), bound);
}

// The scene in ball radii: x = distance, y = what was hit (0 skin, 1 a
// strip's cut edge, 2 the core, 3 the drip, 4 the ink).
// The drip: a neck from the underside thinning to a strand, a drop swelling
// at its end until it lets go and falls; then the strand springs back up and
// a new drop beads, ending the cycle where it began. Its shape this frame,
// worked out once a pixel (sgDripAt) rather than at every step of the march.
const vec3 SG_DRIP_A = vec3(.06, -.93, .2);
vec3 sgDripB;
float sgDripBead, sgDropY;

void sgDripAt(float t) {
  float ph = fract(t / 6.);
  float swell = smoothstep(0., .8, ph) * (1. - smoothstep(.85, 1., ph));
  sgDripBead = ph < .85 ? .04 + .035 * smoothstep(0., .8, ph) : .04 * smoothstep(.85, 1., ph);
  sgDripB = SG_DRIP_A + vec3(.02, -.26 - .22 * swell, 0.);
  // the drop that let go, falling clear of the picture before the next
  // (none while the drop still hangs)
  float fall = max(ph - .85, 0.) / .15;
  sgDropY = fall > 0. ? -1.44 - fall * fall * 3.2 : 1e3;
}

// How far the march may step from the last point sgMap looked at: its
// distance, but measured truly over the ball's plain outside, where sgMap's
// own (halved, for the funnel) would crawl. The shading keeps sgMap's.
float sgStep;

vec2 sgMap(vec3 p, float t) {
  float r = length(p);
  // the skin, a shell sinking into the funnel at the front
  vec3 pn = p / r;
  float th = acos(clamp(dot(pn, SG_AX), -1., 1.));
  float shell = (abs(r - sgFunnel(th)) - .09) * .5;
  // cut into three strips spiralling down the funnel; the gaps close up over
  // the back so the hollow inside stays dark
  // (the gaps taper out to a sliver: closing them short leaves a blunt end)
  // (well clear of the skin the strips are never nearer than it, so the march
  // steps by the skin alone there and skips the spiral's sums)
  float strips = shell, cut = -1.;
  // (outside the ball over its back and sides the skin is a plain sphere)
  float outside = r > 1.09 && th > 1.25 ? 2. : 1.;
  float stripsStep = shell * outside;
  if (shell < .3) {
    vec2 sw = sgSwirlAt(pn, th, t);
    float w = mix(.6, 1.05, smoothstep(.75, 1.75, th));
    float q = fract(sw.x);
    float gd = q > w ? min(q - w, 1. - q) : -min(q, w - q);
    cut = gd * r * max(sin(th), .05) / .64 * .6;
    // the strips' edges rounded like liquid, not cut like blocks; open at the
    // throat onto the core
    strips = max(-sgSmin(-shell, -cut, .035), (.52 - th) * r);
    stripsStep = max(-sgSmin(-stripsStep, -cut, .035), (.52 - th) * r);
  }
  float core = length(p - SG_CORE) - .23;
  // (the drip from afar: past its reach, the distance to a ball round it)
  float drip = length(p - vec3(.07, -1.2, .2)) - .5;
  if (drip < .2) drip = sgSmin(sgRoundCone(p, SG_DRIP_A, sgDripB, .14, .03), length(p - sgDripB - vec3(0., -.03, 0.)) - sgDripBead, .05);
  drip = min(drip, length(p - vec3(.08, sgDropY, .2)) - .075);
  float ink = sgInk(p, t);
  float body = sgSmin(sgSmin(strips, drip, .06), ink, .12);
  sgStep = min(sgSmin(sgSmin(stripsStep, drip, .06), ink, .12), core);
  float m = core < body ? 2. : ink < min(strips, drip) ? 4. : drip < strips ? 3. : cut > shell - .02 ? 1. : 0.;
  return vec2(min(body, core), m);
}

/* The surface's normal at p, from the four corners of a tetrahedron round
   it, and in ao how open the space is a little way out along it. One call
   site for sgMap, in a loop the compiler can't unroll (its start isn't a
   constant): written out, sgMap was copied five more times into the
   program, which made it slow to compile. */
vec3 sgNormal(vec3 p, float t, out float ao) {
  vec3 n = vec3(0.);
  ao = 0.;
  for (int i = min(int(u_time), 0); i < 5; i++) {
    vec3 e = 2. * vec3((((i + 3) >> 1) & 1), ((i >> 1) & 1), (i & 1)) - 1.;
    vec3 q = i < 4 ? p + e * .003 : p + normalize(n) * .14;
    float d = sgMap(q, t).x;
    if (i < 4) n += e * d; else ao = clamp(.3 + 5.5 * d, 0., 1.);
  }
  return normalize(n);
}

// What the glass mirrors: near black below and left, deep cobalt toward the
// glare on the right, the glare itself, a cold light above, magenta below.
vec3 sgEnv(vec3 R, float t) {
  vec3 env = mix(vec3(0., .002, .025), vec3(.015, .1, 1.5), smoothstep(.15, 1.2, R.x * .8 + R.y * .1 - R.z * .25));
  // the tunnel's light smeared across the glass: soft patches, and long
  // bright streaks lying across it like studio light strips
  env += vec3(.3, .65, 1.) * pow(inoise(R.xy * 2.5 + vec2(R.z * 1.5 - t * .4, 0.)), 3.) * 1.2 * smoothstep(-.5, .5, R.x + R.y * .2);
  env += vec3(.55, .82, 1.) * pow(inoise(vec2(R.x * 2. - t * .3, R.y * 11. + R.z * 3.)), 5.) * 5. * smoothstep(-.3, .6, R.x + R.y * .3);
  float key = max(dot(R, SG_KEY), 0.);
  env += vec3(.85, .95, 1.) * (pow(key, 7.) * 1.2 + pow(key, 90.) * 6.);
  env += vec3(.55, .78, 1.) * pow(max(dot(R, normalize(vec3(-.15, .9, .4))), 0.), 30.) * 1.6;
  env += vec3(1., .12, .5) * pow(max(dot(R, normalize(vec3(-.45, -.8, .4))), 0.), 8.) * 1.2;
  return env;
}

// The torn ink's colour: near black navy, the glass's reflections dimmed,
// gloss streaked along the throw.
vec3 sgInkColor(vec3 p, vec3 n, vec3 env, float fres, float t) {
  float ia = sgAngle(p.xy);
  float il = length(p.xy);
  vec3 col = vec3(.003, .008, .05) + env * fres * .85;
  return col + vec3(.3, .58, 1.2) * pow(sgThrowNoise(ia * 30., il * 2. - t * .2), 6.) * 2.5 * fres * smoothstep(-.3, .6, dot(n, SG_KEY));
}

// The ball, ray marched: colour and coverage; past the edge, the glow a lens
// would bloom round it.
vec4 sgOrb(vec2 d, float t) {
  vec2 s = d / SG_R;
  float rs = length(s);
  if (rs > 2.7 && (s.y > -1. || abs(s.x) > .6)) return vec4(0.);
  // a ray that can reach nothing (clear of the ball, outside the ink's
  // sector and away from the drip) skips the march: its halo comes straight
  // from the ball's distance
  // (the drip and its strand hang within .3 of the middle, down to 1.6 below
  // it; past that only the falling drop, in its own band)
  float sa = sgAngle(s);
  sgDripAt(t);
  bool dripRay = s.y < -.85 && abs(s.x) < .45 && (rs < 1.4 || abs(s.x - .01) < .3 && (s.y > -1.65 || abs(s.y - sgDropY) < .25));
  if (rs > 1.2 && (sa < 1.5 || sa > 4. || rs > 2.7) && !dripRay) {
    return vec4(vec3(.5, .75, 1.) * exp(-(rs - 1.09) * .5 * 6.) * .55 * smoothstep(1.4, 1., rs), 0.);
  }
  vec3 ro = vec3(s, 3.), rd = vec3(0., 0., -1.);
  // the ball turned a little to its own right (our left), so it is seen
  // slightly from the side rather than square on
  mat2 yaw = rot(SG_YAW);
  ro.xz = yaw * ro.xz;
  rd.xz = yaw * rd.xz;
  vec3 V = -rd;
  // March only through the space the scene fills: the ball inside 1.2 of
  // its middle, the ink in a sheet from .4 in front of the middle to .45
  // behind it, the drip from .5 in front
  float pz = ro.z / -rd.z;
  float z = min(pz - (dripRay ? .5 : .4) / -rd.z, rs < 1.2 ? 3. - sqrt(1.44 - rs * rs) : 1e3);
  float zEnd = pz + (rs < 1.2 ? 1.15 : .45) / -rd.z;
  float near = 1e3, zNear = z, edge = PX * 1.5 / SG_R;
  vec2 h = vec2(1e3, 0.), hNear = h;
  for (int i = 0; i < SG_STEPS; i++) {
    h = sgMap(ro + rd * z, t);
    if (h.x < near) { near = h.x; zNear = z; hNear = h; }
    if (h.x < .0008 || z > zEnd) break;
    z += sgStep;
  }
  // a ray that only grazed an edge is shaded where it came closest, not
  // where it gave up: that point lies on the surface's edge
  z = zNear;
  h = hNear;
  // (only round the ball itself: the ink's loose bounds would spread it)
  vec3 halo = vec3(.5, .75, 1.) * exp(-near * 6.) * .55 * smoothstep(1.4, 1., rs);
  if (h.y > 3.5) {
    // The ink's distance is a loose one, its outline's field scaled by a
    // fixed slope. An edge taken from it comes out soft where the field is
    // shallow and jagged where it is steep, so past the root, where the ink
    // is its own outline, the edge is measured truly: the field over its
    // slope here, taken across half a pixel.
    vec3 pe = ro + rd * z;
    float e = .5 * PX / SG_R;
    float re = length(pe.xy);
    float v0 = sgInkField(re, sgAngle(pe.xy), t);
    vec2 ex = pe.xy + vec2(e, 0.), ey = pe.xy + vec2(0., e);
    vec2 slope = vec2(sgInkField(length(ex), sgAngle(ex), t), sgInkField(length(ey), sgAngle(ey), t)) - v0;
    float wall = -v0 * e / max(length(slope), 1e-6);
    near = mix(near, max(wall, abs(pe.z + .05) - sgInkThick(re)), smoothstep(1.1, 1.25, re));
  }
  float cover = smoothstep(edge, 0., near);
  if (cover <= 0.) return vec4(halo, 0.);
  vec3 p = ro + rd * z;
  float ao;
  vec3 n = sgNormal(p, t, ao);
  vec3 L = SG_CORE - p;
  float ld = length(L);
  L /= ld;
  if (h.y > 1.5 && h.y < 2.5) {
    // the core: a white-hot ball (its glow is added over everything later)
    return vec4(vec3(6.), cover);
  }
  // how close the skin is to where the ink leaves it: there the strips take
  // on the ink's colour, turn to face us as its sheet does (so the ball's
  // edge catches no glancing light), and lose their rim light and the shadow
  // of the crease, so the two meet with no line between them
  // (on the ink itself, only its root right by the ball)
  float join = h.y > 3.5 ? smoothstep(.25, 0., length(p.xy) - 1.) : h.y > 2.5 ? 0. : smoothstep(.22, 0., sgInk(p, t));
  n = normalize(mix(n, V, join * .85));
  // the liquid isn't perfectly smooth: slow ripples break up its reflections
  n = normalize(n + .14 * (vec3(inoise(p.xy * 5. + t * .1), inoise(p.yz * 5. - t * .1), inoise(p.zx * 5.)) - .5));
  vec3 R = reflect(rd, n);
  // what the glass mirrors, worked out once: every surface below reuses it
  vec3 env = sgEnv(R, t);
  float fres = .4 + .6 * pow(1. - max(dot(n, V), 0.), 2.);
  float key = max(dot(n, SG_KEY), 0.);
  vec3 col;
  if (h.y > .5 && h.y < 1.5) {
    // a strip's cut edge, painted: pink where a strip begins, blue where it ends
    vec2 sw = sgSwirl(p, t);
    vec3 paint = fract(sw.x) < .3 ? vec3(1., .1, .7) : vec3(.12, .3, 1.);
    col = paint * (.15 + .6 * key) + env * fres * .25;
    col = mix(col, sgInkColor(p, n, env, fres, t), join);
  } else {
    vec2 sw = sgSwirl(p, t);
    bool outside = length(p) > sgFunnel(sw.y) || h.y > 2.5;
    // the outer skin is cobalt glass; the inside of the hollow is near black
    col = outside ? vec3(.006, .02, .42) * (.03 + .97 * key * key) + env * fres : vec3(.002, .003, .012);
    if (!outside) {
      // inside the hollow: the core's red catches the strips' edges in thin lines
      float q = fract(sw.x);
      float w = mix(.6, 1.05, smoothstep(.75, 1.75, sw.y));
      float rim = exp(-q * 60.) + exp(-abs(w - q) * 60.);
      col += vec3(1., .1, .06) * rim * exp(-(ld - .23) * 2.5) * 1.4;
    }
    if (outside && h.y < 2.5) {
      // wet gloss in strokes running along the strips, brightest where the
      // glass faces the glare
      // (in sw.x around a circle: sw.x jumps by 2 where the angle wraps, so
      // anything not periodic in it would show a seam there)
      vec2 around = vec2(cos(SG_PI * sw.x), sin(SG_PI * sw.x));
      float stroke = pow(inoise(around * 8. + vec2(sw.y * 2.5 - t * .15, 0.)), 6.) * 4. + pow(inoise(around * 20. + vec2(0., sw.y * 6.) + 4.), 9.) * 5.;
      col += vec3(.3, .58, 1.2) * stroke * fres * smoothstep(-.2, .7, dot(n, SG_KEY)) * smoothstep(1.7, 1.1, sw.y);
      // broad bands of paint along each strip's edges: pink where it begins,
      // blue where it ends, fading out over the back
      float q = fract(sw.x);
      float w = mix(.6, 1.05, smoothstep(.75, 1.75, sw.y));
      float front = smoothstep(1.6, 1.1, sw.y);
      float pink = smoothstep(.0, .01, q) * smoothstep(.065, .045, q) * front;
      float blue = smoothstep(w, w - .015, q) * smoothstep(w - .11, w - .07, q) * front;
      // neon: hot at its middle
      float hot = exp(-abs(q - .028) * 90.);
      col = mix(col, vec3(1., .1, .7) * (.9 + .9 * key) + vec3(.9, .45, 1.) * hot * 1.8 + env * fres * .3, pink);
      col = mix(col, vec3(.06, .22, 1.) * (.3 + .8 * key) + env * fres * .3, blue);
    }
    if (h.y > 3.5) {
      // the torn ink: the same liquid, darker where it thins out, with gloss
      // streaked along the throw and embers of the core's red caught in it
      float ia = sgAngle(p.xy);
      float il = length(p.xy);
      col = sgInkColor(p, n, env, fres, t);
      col += vec3(1., .2, .05) * smoothstep(.74, .82, sgThrowNoise(ia * 40., il * 5. - t * .3)) * smoothstep(.3, -.4, p.y) * smoothstep(1.8, 1.05, il) * 1.4;
    } else if (outside && h.y < 2.5) {
      // where a strip runs into the ink it darkens into it, so the two read
      // as one pour of liquid rather than glass meeting a separate sheet
      col = mix(col, sgInkColor(p, n, env, fres, t), join);
    }
  }
  col *= mix(ao, 1., join);
  // the core's light: red, on the walls close to it only
  col += vec3(1., .3, .08) * (.15 + .85 * max(dot(n, L), 0.)) * exp(-(ld - .23) * 22.) * .5;
  // backlight: the tunnel behind wraps a thin rim of light round the edge
  col += vec3(.4, .65, 1.) * pow(1. - abs(dot(n, V)), 6.) * 1.3 * (1. - join);
  return vec4(col, cover);
}

// Drops of ink thrown past the sheets, streaked along the throw.
float sgSpray(vec2 d, float t) {
  vec2 s = d / SG_R;
  float r = length(s);
  if (r < 1.15 || r > 3.2 || s.x > .3 || s.y < -1.) return 0.;
  float aa = PX * 2. / SG_R;
  float a = sgAngle(s);
  float sect = smoothstep(1.75, 2.3, a) * smoothstep(3.75, 3.15, a);
  vec2 cell = vec2(a * 24., r * 6. - t * .3);
  vec2 id = floor(cell);
  vec2 g = fract(cell) - .5 - (vec2(hash(id + 1.), hash(id + 2.)) - .5) * .6;
  float size = .06 + .16 * hash(id + 3.);
  return step(hash(id), .2) * smoothstep(size, size - aa * 6., length(g * vec2(2.4, .6))) * smoothstep(3.2, 1.6, r) * sect;
}

// Red drops falling past the drip.
vec3 sgDrops(vec2 d, float t) {
  vec2 s = d / SG_R;
  vec3 col = vec3(0.);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float ph = fract(t * (.12 + .04 * fi) + hash(vec2(fi, 31.)));
    vec2 c = vec2(-.35 + .3 * fi + .15 * hash(vec2(fi, 32.)), -1.05 - ph * 1.4);
    float rad = .02 + .02 * hash(vec2(fi, 33.));
    float dd = length((s - c) * vec2(1., .75));
    col += vec3(1., .12, .3) * smoothstep(rad, rad * .6, dd) * smoothstep(0., .1, ph) * smoothstep(1., .8, ph) * 1.4;
  }
  return col;
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  vec2 c = vec2(max(min(aspect * .2, aspect * .5 - .45), 0.), .13 + u_scroll) + pointerP() * .025;
  vec2 d = p - c;
  // (once: splitting it red out and blue in cost three tunnels a pixel)
  vec3 col = sgTunnel(d, t);
  col += sgPool(d, t);
  vec4 orb = sgOrb(d, t);
  col = orb.a > 0. ? mix(col, orb.rgb, orb.a) : col + orb.rgb;
  // the spray: the ink's navy, with a glint of the glare
  float spray = sgSpray(d, t);
  col = mix(col, vec3(.01, .025, .11) + vec3(.3, .55, 1.) * .25, spray);
  col += sgDrops(d, t);
  // the core's glow, fitted to the jacket's (measured from its centre, in
  // ball radii): white to .25, peach, orange, red by .31, gone by .41. Each
  // channel falls off at its own rate, set through the tone curve below
  vec2 k = d - SG_CORE.xy * SG_R;
  float e = max(length(k) / SG_R, .2);
  col += vec3(2.2 * exp(-(e - .285) / .032), 2.2 * exp(-(e - .215) / .03), .9 * exp(-(e - .235) / .017));
  // fade to deep blue away from the orb, so the page below stays readable
  col = mix(col, vec3(.01, .02, .07), smoothstep(.25, 1.2, length(d * vec2(.75, 1.))) * .85);
  col = 1. - exp(-col * 1.1);
  // the jacket's colours are saturated: give back what the tone curve took
  return clamp(mix(vec3(dot(col, vec3(.299, .587, .114))), col, 1.3), 0., 1.);
}`),
  // Sketchbook: the Sketch crown's world, white dry brush on near-black paper.
  // Loose swooshes over the hero, a crown doodled inside a scribbled ring, a
  // patch of hatching in a corner, and little brush crosses and dots round the
  // page, one jumping now and then. Every line boils at 8 drawings a second,
  // as hand-drawn animation does.
  sketch: shader(`
const vec3 SK_INK = vec3(.965, .957, .94);

/* The paper moves under the lines 8 times a second: the same seed for a
   whole drawing, a new one for the next. */
vec2 skBoil(vec2 p, float t, float amt) {
  float s = floor(t * 8.);
  vec2 n = vec2(noise(p * 9. + s * 7.1), noise(p * 9. + s * 3.7 + 11.)) - .5;
  n += .5 * (vec2(noise(p * 60. + s * 5.3), noise(p * 60. + s * 2.9 + 4.)) - .5);
  return p + amt * n;
}

/* Dry brush: the stroke's body, eaten by bristle streaks running along it,
   more so as the brush runs dry toward the end (u = 0..1 along). */
float skBrush(float d, float w, float u, float seed) {
  if (w <= 0. || d > w * 1.5) return 0.;
  float x = d / w;
  float rag = .9 + .2 * noise(vec2(u * 14., seed));
  float body = smoothstep(rag, rag * .8, x);
  float streak = fbm(vec2(u * 5. + seed, x * 7. + seed * 1.7));
  float dryness = .2 + .4 * smoothstep(.5, 1., u) + .25 * x;
  return body * smoothstep(dryness, dryness + .1, streak + .2);
}

float skSeg(vec2 p, vec2 a, vec2 b, out float h) {
  vec2 pa = p - a, ba = b - a;
  h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.);
  return length(pa - ba * h);
}

/* A swoosh along y = c.y + a sin(k x + ph) between x0 and x1, pressing
   harder early and lifting off dry at the end. */
float skSwoosh(vec2 p, float x0, float x1, float cy, float a, float k, float ph, float w, float seed) {
  float u = (p.x - x0) / (x1 - x0);
  if (u < 0. || u > 1.) return 0.;
  float y = cy + a * sin(k * p.x + ph);
  float dy = a * k * cos(k * p.x + ph);
  float d = abs(p.y - y) / sqrt(1. + dy * dy);
  float press = smoothstep(0., .08, u) * mix(1., .35, smoothstep(.55, 1., u));
  return skBrush(d, w * press, u, seed);
}

/* A scribbled ring: three loose passes round an ellipse, none quite closing. */
float skRing(vec2 p, vec2 c, vec2 r, float w, float seed) {
  float v = 0.;
  vec2 q = (p - c) / r;
  float ang = atan(q.y, q.x);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float wob = 1. + .07 * sin(ang * 2. + fi * 2.1 + seed) + .03 * sin(ang * 5. + fi);
    float d = abs(length(q) - wob) * min(r.x, r.y);
    float u = fract((ang + 3.14159) / 6.28318 + fi * .31 + seed * .1);
    float lift = smoothstep(0., .05, u) * smoothstep(1., .85, u);
    v = max(v, skBrush(d, w * lift * (1. - fi * .25), u, seed + fi * 3.));
  }
  return v;
}

/* The crown, doodled: a band and five points in one zigzag. */
float skCrown(vec2 p, vec2 c, float s, float w, float seed) {
  vec2 P[7] = vec2[7](vec2(-.95, -.45), vec2(-1.1, .75), vec2(-.48, .05), vec2(0., 1.), vec2(.48, .05), vec2(1.1, .75), vec2(.95, -.45));
  float v = 0., h;
  for (int i = 0; i < 6; i++) {
    float d = skSeg((p - c) / s, P[i], P[i + 1], h) * s;
    v = max(v, skBrush(d, w, (float(i) + h) / 6., seed + float(i)));
  }
  float d = skSeg((p - c) / s, vec2(-1.02, -.45), vec2(1.06, -.47), h) * s;
  return max(v, skBrush(d, w * 1.15, h, seed + 9.));
}

/* A little brush cross: two quick strokes, the second a touch shorter. */
float skCross(vec2 p, vec2 c, float r, float w, float seed) {
  float h, v;
  vec2 a = vec2(r, r * (.85 + .3 * hash(vec2(seed, 1.))));
  float d = skSeg(p, c - a, c + a, h);
  v = skBrush(d, w, h, seed);
  vec2 b2 = vec2(r * .85, -r * (.9 + .2 * hash(vec2(seed, 2.))));
  d = skSeg(p, c - b2, c + b2, h);
  return max(v, skBrush(d, w * .9, h, seed + 1.));
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  // paper: near black, a fibre grain, a little lighter where the light falls
  vec3 col = vec3(.047, .043, .059);
  col += vec3(.014) * (fbm(p * vec2(260., 45.)) - .5);
  col += vec3(.016, .015, .018) * exp(-length(p - vec2(-.2 * aspect, .45)) * 1.6);
  vec2 h = vec2(p.x, p.y - u_scroll);
  vec2 b = skBoil(h, t, .007);
  float ink = 0.;
  // two swooshes over the hero and an underline below it
  ink = max(ink, skSwoosh(b, aspect * .04, aspect * .48, .37, .03, 4.2, .6, .022, 1.));
  ink = max(ink, skSwoosh(b, aspect * .14, aspect * .45, .3, .018, 6.1, 2.2, .012, 4.));
  ink = max(ink, skSwoosh(b, -aspect * .47, -aspect * .1, -.1, .012, 7.3, 1.1, .011, 7.) * .8);
  // a crown doodled inside a scribbled ring on the right
  vec2 rc = vec2(aspect * .34, .1);
  ink = max(ink, skRing(b, rc, vec2(.15, .1), .009, 2.));
  ink = max(ink, skCrown(b, rc - vec2(0., .006), .062, .0072, 5.));
  // hatching in the lower right: short parallel strokes, each its own length
  vec2 hq = rot(.75) * (b - vec2(aspect * .5, -.5)) * vec2(85., 9.);
  float line = floor(hq.x);
  float seg = fract(hq.y + hash(vec2(line, 1.)) * 3.);
  float hatch = skBrush(abs(fract(hq.x) - .5) / 85., .0016, seg, line) * step(.25, seg) * step(seg, .9);
  float corner = smoothstep(.0, .3, b.x - aspect * .18) * smoothstep(-.05, -.4, b.y);
  corner *= step(.42, noise(vec2(line * .3, 2.)) + corner * .3);
  ink = max(ink, hatch * corner * .7);
  // crosses and dots round the page; each jumps once a cycle
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    vec2 c = vec2((hash(vec2(fi, 1.)) - .5) * aspect * .95, mix(-.4, .46, hash(vec2(fi, 2.))));
    float k = fract(t / 7. + hash(vec2(fi, 3.)));
    float jump = smoothstep(0., .03, k) * smoothstep(.12, .04, k);
    c.y += .012 * jump;
    if (hash(vec2(fi, 5.)) < .6) ink = max(ink, skCross(b, c, .011 + .006 * hash(vec2(fi, 4.)), .0045, fi + 9.));
    else ink = max(ink, smoothstep(.0075, .0055, length(b - c)) * .9);
  }
  // the pointer carries a small cross
  ink = max(ink, skCross(skBoil(p, t, .004), pointerP(), .01, .0035, 21.) * .6);
  return mix(col, SK_INK, clamp(ink, 0., 1.) * .93);
}`),
  // Red tree: a tree of flat blocks on a mound in still dark water, a nod to
  // the blocky red trees of a certain dark world: a compact crimson and
  // magenta crown on a short dark trunk, mirrored below in broken rows, more
  // of them small and dim far off. Drawn on a coarse pixel grid; laid out by
  // foundry/designs/red-tree-slabs. No sprite.
  redtree: shader(`
/* Red tree: a tree of flat blocks standing on a mound in still dark water,
   a nod to the blocky red trees of a certain dark world. A compact crown of
   big blocks, crimson where the light reaches and magenta in its own shade,
   on a short dark trunk that leans a little; the water holds it upside down
   in broken rows; more of them stand far off on mounds of their own. Drawn on
   a coarse pixel grid like a sprite: the blocks shift a cell or two as the
   wind passes through, further in a gust, and part round the pointer; leaves
   come down to lie on the mound or float off, and bits are carried away
   across the dark. The blocks and the trunk's limbs are laid out by
   foundry/designs/red-tree-slabs/slab_tree.py, one call each (no tables). */
const vec3 RT_ROSE = vec3(1., .26, .36);
const float RT_WL = -9.;   // the waterline, in a tree's own cells
const float RT_HZ = 60.;   // the horizon, in the near tree's cells

/* How high the mound a tree stands on is at x. */
float rtMound(float x) {
  float d = (x - 4.) / 46.;
  return 3. - 12. * d * d;
}

/* One block of the crown at cell c: r is its corner and size in cells, w the
   wind (time, gust) and the pointer's cell. Sets k to its layer and which
   row of it this is. Its corners are knocked off.
   The wind crosses the crown as one slow wave, so neighbours move together:
   the top blocks give a cell either way, those by the trunk stay put, and a
   gust leans the whole crown downwind, most at the top. Now and then a block's
   downwind end flicks out a cell, as leaves do. */
void rtSlab(vec2 c, vec4 w, vec4 r, int layer, inout float k) {
  float lift = clamp((r.y + r.w * .5 - 30.) / 46., 0., 1.);
  vec2 mid = r.xy + r.zw * .5;
  float wave = sin(w.x * 1.15 - mid.x * .03 - mid.y * .022);
  float dx = lift * (.8 * wave + w.y * (2.4 + .45 * sin(w.x * 6.5 + mid.x * .2)));
  vec2 d = mid - w.zw;
  // the pointer parts them a cell, no more, and not at all where it sits right on one
  dx += 1.5 * (d.x / 14.) * exp(-dot(d, d) / 420.);
  float flick = step(.82, sin(w.x * 2.1 + r.x * 1.7 + r.y * 2.3)) * step(.25, lift);
  vec2 l = c - r.xy - vec2(floor(dx + .5), 0.);
  float wd = r.z + flick;
  if (l.x < 0. || l.y < 0. || l.x >= wd || l.y >= r.w) return;
  bool top = l.y >= r.w - 1., bottom = l.y < 1.;
  if ((l.x < 1. || l.x >= wd - 1.) && (top || bottom)) return;
  k = float(layer) * 4. + (top ? 1. : bottom ? 2. : 0.);
}

/* One limb of the trunk at x: from s.xy to s.zw, as thick as rr at each end.
   Sets side to how far across it x is, -1 (left) to 1 (right). */
void rtLimb(vec2 x, vec4 s, vec2 rr, inout float side) {
  vec2 d = s.zw - s.xy;
  float k = clamp(dot(x - s.xy, d) / dot(d, d), 0., 1.);
  vec2 pq = x - s.xy - d * k;
  float r = mix(rr.x, rr.y, k);
  if (dot(pq, pq) > r * r) return;
  float sd = (pq.x * d.y - pq.y * d.x) / (length(d) * r);
  if (abs(sd) < abs(side)) side = sd;
}

vec3 rtLeaf(float k) {
  int layer = int(k) / 4, row = int(k) - layer * 4;
  vec3 body = layer == 0 ? vec3(.35, .11, .385) : layer == 1 ? vec3(.705, .095, .5) : layer == 2 ? vec3(.885, .14, .25) : vec3(1., .425, .375);
  return row == 1 ? body * 1.16 + .035 : row == 2 ? body * .77 : body;
}

/* The trunk at cell c: dark, its right side catching the crown's light. */
vec4 rtTrunk(vec2 c) {
  if (c.x < -18. || c.x > 34. || c.y < -8. || c.y > 41.) return vec4(0.);
  float side = 9.;
  vec2 x = c + .5;
  rtLimb(x, vec4(0., 0., 2., 8.), vec2(6.4, 5.6), side);
  rtLimb(x, vec4(2., 8., 6., 16.), vec2(5.6, 4.8), side);
  rtLimb(x, vec4(6., 16., 9., 25.), vec2(4.8, 4.2), side);
  rtLimb(x, vec4(9., 25., 18., 38.), vec2(3.4, 2.0), side);
  rtLimb(x, vec4(8., 20., -9., 32.), vec2(3.2, 1.8), side);
  rtLimb(x, vec4(9., 22., 30., 33.), vec2(2.8, 1.6), side);
  rtLimb(x, vec4(0., 3., -13., -2.), vec2(3.4, 1.2), side);
  rtLimb(x, vec4(2., 3., 15., -3.), vec2(3.4, 1.2), side);
  rtLimb(x, vec4(0., 2., -4., -6.), vec2(3.0, 1.2), side);
  rtLimb(x, vec4(3., 2., 8., -6.), vec2(2.6, 1.0), side);
  if (side > 8.) return vec4(0.);
  return vec4(side > .45 ? vec3(.5, .16, .47) : side < -.5 ? vec3(.055, .042, .14) : vec3(.11, .088, .225), 1.);
}

/* The crown at cell c. */
vec4 rtCrown(vec2 c, vec4 w) {
  if (c.x < -43. || c.x > 65. || c.y < 25. || c.y > 87.) return vec4(0.);
  float k = -1.;
  rtSlab(c, w, vec4(-6., 27., 25., 9.), 0, k);
  rtSlab(c, w, vec4(-22., 31., 23., 8.), 0, k);
  rtSlab(c, w, vec4(-16., 33., 22., 8.), 0, k);
  rtSlab(c, w, vec4(-33., 42., 23., 10.), 0, k);
  rtSlab(c, w, vec4(-34., 49., 27., 8.), 0, k);
  rtSlab(c, w, vec4(19., 30., 22., 8.), 1, k);
  rtSlab(c, w, vec4(3., 30., 23., 10.), 1, k);
  rtSlab(c, w, vec4(7., 30., 21., 9.), 1, k);
  rtSlab(c, w, vec4(22., 34., 29., 9.), 1, k);
  rtSlab(c, w, vec4(13., 35., 29., 12.), 1, k);
  rtSlab(c, w, vec4(-24., 40., 37., 11.), 1, k);
  rtSlab(c, w, vec4(-17., 41., 36., 11.), 1, k);
  rtSlab(c, w, vec4(-7., 44., 32., 11.), 1, k);
  rtSlab(c, w, vec4(-7., 45., 43., 13.), 1, k);
  rtSlab(c, w, vec4(-11., 50., 32., 13.), 1, k);
  rtSlab(c, w, vec4(-16., 51., 42., 12.), 1, k);
  rtSlab(c, w, vec4(-27., 54., 35., 12.), 1, k);
  rtSlab(c, w, vec4(36., 44., 19., 10.), 2, k);
  rtSlab(c, w, vec4(14., 50., 32., 10.), 2, k);
  rtSlab(c, w, vec4(6., 51., 28., 11.), 2, k);
  rtSlab(c, w, vec4(15., 52., 28., 10.), 2, k);
  rtSlab(c, w, vec4(11., 57., 37., 12.), 2, k);
  rtSlab(c, w, vec4(27., 59., 29., 8.), 2, k);
  rtSlab(c, w, vec4(-13., 60., 26., 10.), 2, k);
  rtSlab(c, w, vec4(24., 61., 27., 10.), 2, k);
  rtSlab(c, w, vec4(-20., 65., 29., 10.), 2, k);
  rtSlab(c, w, vec4(2., 67., 24., 10.), 2, k);
  rtSlab(c, w, vec4(4., 68., 22., 10.), 2, k);
  rtSlab(c, w, vec4(22., 70., 22., 8.), 2, k);
  rtSlab(c, w, vec4(-5., 74., 27., 8.), 2, k);
  rtSlab(c, w, vec4(25., 75., 16., 10.), 2, k);
  return k < 0. ? vec4(0.) : vec4(rtLeaf(k), 1.);
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  float wide = smoothstep(.7, 1.4, aspect);
  // one cell of the grid, in canvas heights: coarser on a narrow screen, so the tree still fits across
  float px = min(1. / 172., aspect / 170.);
  // where the trunk meets the ground; the scene drifts up with the page, slower than it
  vec2 g = vec2(mix(-14. * px, aspect * .2, wide), mix(-.2, -.11, wide));
  vec2 q = vec2(p.x, p.y - u_scroll * .5);
  vec2 c = floor((q - g) / px);
  vec2 ptr = floor((pointerP() + vec2(0., -u_scroll * .5) - g) / px);
  // a gust every 11 s leans the crown over and lets it rock back
  float gk = fract(t / 11. + .3);
  float gust = smoothstep(0., .12, gk) * (1. - smoothstep(.12, .6, gk));
  // the crown moves in frames, six a second, like a sprite
  float tf = floor(t * 6.) / 6.;
  vec4 w = vec4(tf, gust, ptr);

  // night sky over still water, a paler band where they meet
  vec3 col;
  float off = (c.y - RT_HZ) * px;
  if (off >= 0.) {
    col = mix(vec3(.075, .028, .09), vec3(.02, .012, .03), smoothstep(0., .42, off));
    float star = ihash(ivec2(c) + 91);
    if (star > .9984) col += vec3(.5, .36, .6) * (.5 + .5 * sin(t * (.6 + 2. * fract(star * 731.)) + star * 900.));
  } else {
    col = mix(vec3(.06, .024, .075), vec3(.018, .01, .028), smoothstep(0., .5, -off));
    // glints lying on it, sliding slowly
    float glint = ihash(ivec2(int(floor((c.x + t * (1.5 + mod(c.y, 3.))) / 8.)), int(c.y)));
    if (glint > .95 && mod(c.y, 2.) < 1.) col += vec3(.05, .02, .07);
  }
  // a little of the crown's colour hangs in the air round it, and lies on the water under it
  vec2 crown = (c - vec2(14., 52.)) * px;
  col += vec3(.2, .035, .15) * .3 * exp(-length(crown * vec2(.8, 1.)) * 2.4);
  col += RT_ROSE * .09 * exp(-length(crown * vec2(.75, 1.2)) * 5.5);
  vec2 under = (c - vec2(14., RT_WL - 40.)) * px;
  col += RT_ROSE * .045 * exp(-length(under * vec2(.6, 1.3)) * 4.5);

  // which tree this cell belongs to: the near one, or one of those far off,
  // drawn at half or a third the size
  vec2 fc = c;
  float far = 0.;
  if (c.x < -92.) {
    if (c.x > -146.) { fc = (c - vec2(-118., 40.)) * 3.; far = .22; }
    else if (c.x > -232.) { fc = (c - vec2(-186., 14.)) * 2.; far = .36; }
    else { fc = (c - vec2(-268., 46.)) * 3.; far = .18; }
  }
  // below its waterline a tree is seen again upside down, its rows slipping sideways
  float mirror = 1.;
  if (fc.y < RT_WL) {
    float depth = RT_WL - fc.y;
    // (and squashed, as water seen from low down shows it)
    fc = vec2(fc.x + floor(1.7 * sin(depth * .5 + t * 1.4) * min(depth / 8., 1.) + .5), RT_WL + floor(depth * 1.5) - 1.);
    mirror = (mod(c.y, 2.) < 1. ? .55 : .36) * exp(-depth / 60.);
  }
  vec4 obj = vec4(0.);
  // the mound: dark earth, a skin of dull purple grass
  float top = rtMound(fc.x);
  if (fc.y >= RT_WL && fc.y < top) {
    float speck = ihash(ivec2(fc) + 400);
    obj = vec4((fc.y >= top - 2. ? vec3(.43, .19, .46) : fc.y >= top - 4. ? vec3(.3, .13, .34) : vec3(.17, .075, .21)) * (speck > .95 ? 1.2 : speck < .05 ? .82 : 1.), 1.);
  }
  // an egg, left at the foot of the near tree
  vec2 eg = fc - vec2(21., 1.);
  if (far == 0. && eg.x >= 0. && eg.x < 4. && eg.y >= 0. && eg.y < 5. && !((eg.x < 1. || eg.x >= 3.) && (eg.y < 1. || eg.y >= 4.))) {
    obj = vec4(eg.x >= 3. || eg.y < 1. ? vec3(.74, .66, .62) : eg.x == 1. && eg.y == 3. ? vec3(1.) : vec3(.95, .91, .84), 1.);
  }
  vec4 wood = rtTrunk(fc);
  obj = mix(obj, wood, wood.a);
  vec4 leaves = rtCrown(fc, far > 0. ? vec4(tf + far * 40., gust * .7, vec2(1e4)) : w);
  obj = mix(obj, leaves, leaves.a);
  col = mix(col, obj.rgb, obj.a * mirror * (far > 0. ? far : 1.));

  // leaves: some come down to lie on the mound or float off on the water, some are carried away across the dark
  for (int i = 0; i < 16; i++) {
    float fi = float(i);
    float period = (i < 7 ? 9. : 15.) + 7. * hash(vec2(fi, 1.));
    float run = t / period + hash(vec2(fi, 2.));
    float k = fract(run), cyc = floor(run);
    vec2 from = vec2(-24. + 80. * hash(vec2(fi, cyc + 3.)), 30. + 46. * hash(vec2(fi, cyc + 5.)));
    vec2 at;
    float lit = 1.;
    bool down = i < 7 && k > .55;
    if (i < 7) {
      // see-sawing down
      float lx = from.x - 34. + 22. * hash(vec2(fi, cyc + 6.));
      float ly = max(RT_WL, floor(rtMound(lx)));
      float kk = min(k / .55, 1.);
      at = mix(from, vec2(lx, ly), kk) + vec2(5. * sin(kk * 9. + fi * 2.) * (1. - kk), 0.);
      if (down && ly <= RT_WL) at.x -= (k - .55) * 30.;
      lit = smoothstep(0., .04, k) * (1. - smoothstep(.9, .97, k));
    } else {
      // away on the wind, dimming as it goes
      at = from + vec2(-k * (230. + 90. * hash(vec2(fi, 8.))), 9. * sin(k * 7. + fi * 3.) - 34. * k + 30. * k * k);
      lit = smoothstep(0., .04, k) * mix(.95, .2, k) * (1. - smoothstep(.9, 1., k));
    }
    vec2 l = c - floor(at);
    // two cells, lying flat or on end as it turns
    bool flat_ = down || mod(floor(t * 2.5 + fi), 2.) < 1.;
    if (l.x >= 0. && l.y >= 0. && l.x < (flat_ ? 2. : 1.) && l.y < (flat_ ? 1. : 2.)) {
      col = mix(col, mod(fi, 3.) < 1. ? vec3(.705, .095, .5) : vec3(.885, .14, .25), lit);
    }
  }

  // a soft vignette keeps the corners quiet under the page
  return col * (1. - .3 * smoothstep(.55, 1.4, length(p * vec2(.75, 1.))));
}
`),
  fireflies: shader(`
// Firefly forest: a blue-hour clearing (our own Blender render) with old
// mossy trees, ferns and grass, a stump and a log in warm pools of light,
// low mist and a gap of sky. Fireflies rise from the grass at real depths,
// hidden behind whatever stands nearer; the pools breathe with their swarms;
// every 5 s a wave of light ripples across the field, then rests.
// u_sprite (2048 x 1760): rows 0-1151 the render, 16:9; rows 1184-1759,
// columns 0-1023 its depth pass at half size (white near, ~3 m; black far,
// ~80 m and the sky; log scale).
uniform sampler2D u_sprite;

const float FF_IA = 16. / 9.;
const vec3 FF_WARM = vec3(1., .86, .5);
const vec3 FF_GLOW = vec3(.78, 1., .32);

/* The render at f (0..1 across it, y up). */
vec3 ffScene(vec2 f, float lod) {
  f = clamp(f, vec2(.001), vec2(.999, .996));
  return textureLod(u_sprite, vec2(f.x, (1. - f.y) * 1152. / 1760.), lod).rgb;
}

/* Its depth at f: 1 near, 0 far. */
float ffDepth(vec2 f, float lod) {
  f = clamp(f, vec2(.004), vec2(.996));
  return textureLod(u_sprite, vec2(f.x * .5, (1184. + (1. - f.y) * 576.) / 1760.), lod).r;
}

/* The wave: 0 at rest, rising as it passes x (0..1 across the field). */
float ffWave(float x, float t) {
  float k = (fract((t - 5.3) / 5.) - x * .3) * 5.;
  return step(0., k) * smoothstep(0., .25, k) * exp(-max(k - .25, 0.) * 1.1);
}

/* A swarm's breathing: slow, never quite out. */
float ffSwarm(float ph, float t) {
  return .5 + .3 * sin(t * .55 + ph) + .2 * sin(t * 1.3 + ph * 2.7);
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  // cover-fit, a touch zoomed so it can drift; a phone keeps the stump, its
  // glow and the gap of sky in view
  float s = max(1., aspect / FF_IA) * 1.035;
  float halfW = aspect / (2. * s * FF_IA);
  vec2 sc = vec2(s * FF_IA, s);
  vec2 ctr = vec2(clamp(.6, halfW + .012, 1. - halfW - .012), .5);
  ctr += vec2(.005 * sin(t * .045), .003 * sin(t * .037 + 1.));
  vec2 f0 = p / sc + ctr;
  // parallax: near things shift more than far ones with the pointer and scroll
  vec2 ptr = pointerP();
  vec2 par = ptr * vec2(.005, .004) + vec2(0., min(u_scroll, 1.) * .005);
  float dp = ffDepth(f0, 2.);
  vec2 f = f0 + par * (dp - .4);

  vec3 col = ffScene(f, 0.);
  float dS = ffDepth(f, .5);

  // the warm pools round the stump, the log and the grass on the left breathe
  // with the swarms in them, and swell as the wave passes
  float wave = ffWave(f.x, t);
  vec3 c4 = ffScene(f, 4.);
  float warm = smoothstep(.02, .14, c4.r - c4.b) * smoothstep(.12, .4, dot(c4, vec3(.3, .6, .1)));
  vec2 kA = (f - vec2(.655, .4)) * vec2(1., 1.6), kB = (f - vec2(.77, .37)) * vec2(1., 1.6), kC = (f - vec2(.33, .33)) * vec2(1., 1.6);
  float pulse = ffSwarm(0., t) * exp(-dot(kA, kA) * 60.) + ffSwarm(2.1, t) * exp(-dot(kB, kB) * 60.) + ffSwarm(4.4, t) * exp(-dot(kC, kC) * 60.);
  col *= 1. + warm * (.32 * (pulse - .5) + .22 * wave);

  // low mist drifting through the clearing, never over the near ferns, lit
  // warm near the pools
  float inClr = smoothstep(.12, .3, dS) * smoothstep(.78, .6, dS) * smoothstep(.26, .36, f.y) * smoothstep(.62, .46, f.y);
  float m = .6 * inoise(vec2(f.x * 6. - t * .03, f.y * 16. + t * .008)) + .4 * inoise(vec2(f.x * 13. + t * .02, f.y * 34.));
  vec3 c6 = ffScene(f, 6.);
  vec3 mistCol = vec3(.05, .07, .09) + FF_WARM * max(c6.r - c6.b, 0.) * (1.2 + .8 * pulse);
  col += mistCol * inClr * smoothstep(.38, .85, m) * .7;

  // fireflies, each at its own depth, hidden where something stands nearer:
  // swarms over the pools, others across the field, a few tiny far ones in
  // the trees, and a few drifting right past the eye, out of focus
  for (int i = 0; i < 52; i++) {
    float fi = float(i);
    float h1 = ihash(ivec2(i, 11)), h2 = ihash(ivec2(i, 12)), h3 = ihash(ivec2(i, 13)), h4 = ihash(ivec2(i, 14));
    vec3 home;
    if (i < 11) home = vec3(.655 + (h1 - .5) * .13, .4 + .045 * h2, .48 + .08 * h3);
    else if (i < 17) home = vec3(.77 + (h1 - .5) * .11, .37 + .04 * h2, .53 + .06 * h3);
    else if (i < 23) home = vec3(.33 + (h1 - .5) * .13, .335 + .045 * h2, .64 + .08 * h3);
    else if (i < 38) home = vec3(.22 + .74 * h1, .34 + .17 * h2 * h2, .36 + .24 * h3);
    // a few low among the ferns, close
    else if (i < 42) home = vec3(.15 + .8 * h1, .14 + .14 * h2, .8 + .08 * h3);
    else if (i < 48) home = vec3(.2 + .75 * h1, .47 + .13 * h2, .12 + .14 * h3);
    else home = vec3(.35 + .6 * h1, .3 + .35 * h2, .97);
    bool bokeh = i >= 48;
    // rising slowly from the grass, fading in as it leaves and out up high
    float life = bokeh ? .5 : fract(t / (14. + 10. * h4) + h2 * 3.);
    float rise = bokeh ? 0. : life * (.05 + .07 * h3) * (1.1 - home.z);
    float sp = bokeh ? .35 : 1.;
    vec2 at = home.xy + vec2(.012 * sin(t * (.2 + .1 * h3) * sp + fi * 2.1) + .004 * sin(t * .9 * sp + fi * 5.),
      rise + .006 * sin(t * (.25 + .1 * h4) * sp + fi * 1.3));
    vec2 pos = (at - ctr - par * (home.z - .4)) * sc;
    vec2 d = p - pos;
    // size from the distance (log scale, 3 m to 80 m)
    float meters = 3. * exp((1. - home.z) * 3.28);
    float R = bokeh ? .03 + .015 * h1 : max(.045 / meters * (.75 + .5 * h2), PX * 1.2);
    if (dot(d, d) > R * R * (bokeh ? 1.6 : 30.)) continue;
    float dd = length(d);
    float per = 2.5 + 3. * h4;
    float k = fract(t / per + h1 * 7.) * per;
    float own = smoothstep(0., .3, k) * exp(-max(k - .3, 0.) * 1.2);
    float lb = max(max(own, ffWave(at.x, t)), .12) * smoothstep(0., .12, life) * smoothstep(1., .75, life);
    if (bokeh) {
      // a soft out-of-focus glow, its edge split a touch: warm out, green in
      lb = .55 + .3 * sin(t * .3 + fi * 2.);
      vec3 e = dd / (R * vec3(1.05, 1., .95));
      col += mix(FF_GLOW, FF_WARM, .4) * exp(-e * e * 2.4) * lb * .22;
      continue;
    }
    // hidden behind anything nearer than it, softly so leaf edges do not alias
    float vis = smoothstep(-.06, -.01, home.z - dS);
    float haze = mix(.45, 1., smoothstep(.1, .6, home.z));
    col += vis * haze * lb * (vec3(.95, 1., .62) * smoothstep(R * .8, R * .1, dd) * 1.25 + FF_GLOW * exp(-dd / R * .9) * .45);
  }

  // quiet behind the name and avatar, up on the left
  vec2 ul = (p - vec2(-aspect * .5 + .2, .36)) * vec2(.75, 1.);
  col *= 1. - .35 * exp(-dot(ul, ul) * 4.);
  return col;
}
`),
  crystal: shader(`
// Crystal cave: a composed wall. One big cluster of amethyst points in the
// lower right, the brightest, a few medium ones, small ones receding up
// toward the dark upper left, among rounded, fractured masses of stone and an
// overhang; every cluster grows out of its own mass, and its light spills
// violet over the rock around it. Each point is a hexagonal prism with a pyramid tip: flat
// facets, a frosted smoky base clearing toward the tip, streaks and an
// earlier tip inside, back edges seen through it. A key light drifts and a
// few crystals breathe light; every 6.5 s a band of light crosses the wall,
// catching the facets one after another and leaving glints on the tips.
const float CC_SEG = 1.04719755; // a sixth of a turn: one prism face

// The scene, back to front by z, as two tables (chains of ifs: a constant
// array read by a loop's index is rebuilt on every read by some drivers). A: where the root sits (across the screen,
// -1..1 each way), size in canvas heights, the way the cluster grows. B: z,
// the rock mass's width and height over the size, how much light the
// cluster gives off (0: a bare rock mass). The first is the hero; the
// rest are rock: the floor, deep masses, two clusters hanging from the
// ceiling into the top of the page, and last the two slabs of that ceiling.
const int CC_N = 16;
vec4 ccA(int i) {
  return
    i == 0 ? vec4(.74, -.86, .56, 1.78) : i == 1 ? vec4(.1, -.66, .3, 1.5) : i == 2 ? vec4(.86, .04, .27, 2.05) : i == 3 ? vec4(-.56, -.8, .26, 1.36) :
    i == 4 ? vec4(.44, .3, .17, 1.82) : i == 5 ? vec4(-.14, -.16, .15, 1.45) : i == 6 ? vec4(-.78, -.34, .12, 1.25) : i == 7 ? vec4(.1, .4, .1, 1.7) :
    i == 8 ? vec4(-.4, .1, .085, 1.6) : i == 9 ? vec4(.62, .94, .36, -1.75) : i == 10 ? vec4(-1.02, -1., .5, 1.3) : i == 11 ? vec4(.36, -.22, .36, 1.62) :
    i == 12 ? vec4(-.72, .62, .42, 1.5) : i == 13 ? vec4(.1, .93, .3, -1.48) : i == 14 ? vec4(-.5, .93, .5, -1.5) : vec4(.55, 1.02, .5, -1.66);
}
vec4 ccB(int i) {
  return
    i == 0 ? vec4(10., 1.2, .85, 1.) : i == 1 ? vec4(8., 1.15, .9, .5) : i == 2 ? vec4(7., 1.1, 1.1, .45) : i == 3 ? vec4(7.5, 1.25, 1., .4) :
    i == 4 ? vec4(5., 1.3, 1.1, .28) : i == 5 ? vec4(5.5, 1.4, 1.2, .25) : i == 6 ? vec4(4.5, 1.5, 1.3, .28) : i == 7 ? vec4(4., 1.6, 1.4, .26) :
    i == 8 ? vec4(3.5, 1.7, 1.4, .24) : i == 9 ? vec4(6., 1.6, 1., .8) : i == 10 ? vec4(9., 1.3, 1.2, 0.) : i == 11 ? vec4(3., 1.5, 1.1, 0.) :
    i == 12 ? vec4(2., 1.5, 1.1, 0.) : i == 13 ? vec4(2.5, 1.7, 1., .6) : i == 14 ? vec4(1.2, 2.3, 1., 0.) : vec4(1.4, 2.2, 1., 0.);
}

// where the sweep has reached: 0 at the left edge, 1 at the right, leaning
float ccSweepAt(vec2 x, float aspect) { return (x.x / aspect + .5) * .85 + (x.y + .5) * .15; }

// how far from the dark upper left a point is: 0 there, 1 out at the rim
float ccWall(vec2 x, float aspect) {
  vec2 q = x / vec2(.5 * aspect, .5) - vec2(-.6, .52);
  return smoothstep(.35, 1.75, length(q * vec2(1., 1.05)));
}

// smooth stone: three octaves of integer value noise, each turned its own
// way so no grid shows, fine detail left out
float ccStone(vec2 x) {
  return inoise(x) * .55 + inoise(mat2(.8, -.6, .6, .8) * x * 2.1 + 3.1) * .3
       + inoise(mat2(-.5, -.87, .87, -.5) * x * 4.4 + 7.3) * .15;
}

// dust adrift in the cave, one layer: seen only where it crosses light
float ccMotes(vec2 p, float t, float scale, float seed) {
  vec2 q = p * scale + vec2(t * .03 + seed * 5., t * (.025 + .01 * seed));
  q.x += .3 * sin(q.y * .9 + seed * 3. + t * .07);
  vec2 id = floor(q), f = fract(q) - .5;
  float h = hash(id + seed * 17.);
  if (h > .22) return 0.;
  vec2 d = f - (vec2(hash(id + 1.3), hash(id + 2.7)) - .5) * .6;
  float r = .02 + .05 * pow(hash(id + 4.), 3.) + PX * scale;
  return smoothstep(r, r * .2, length(d)) * (.3 + .7 * hash(id + 6.)) * (.55 + .45 * sin(t * (.5 + 1.5 * hash(id + 8.)) + h * 60.));
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  vec2 x = p + vec2(0., u_scroll * .18);
  float wallHere = ccWall(p, aspect);
  // on a narrow screen everything is smaller, so the scene still fits across
  float sz = mix(.62, 1., smoothstep(.5, 1.4, aspect));
  vec2 qs = vec2(.5 * aspect - .02, .5);

  // the key light drifts slowly over the upper right
  float la = .85 + .5 * sin(t * .06) + .2 * sin(t * .023 + 1.);
  vec3 L = normalize(vec3(cos(la) * .42, sin(la) * .42, .9));
  // and a lower key from the same side shapes the facets, one lit, the next dark
  vec3 K = normalize(vec3(cos(la - .25) * .85, sin(la - .25) * .85, .4));

  // stone relief, shared by every mass and the far wall: a smooth height
  // and its slope
  vec2 sq = x * 2.6;
  float r0 = ccStone(sq);
  vec2 rg = vec2(ccStone(sq + vec2(.06, 0.)), ccStone(sq + vec2(0., .06))) - r0;
  vec2 fq = mat2(.6, .8, -.8, .6) * x * 11. + 1.7;
  float fine = inoise(fq);
  vec2 fg = vec2(inoise(fq + vec2(.12, 0.)), inoise(fq + vec2(0., .12))) - fine;
  vec2 rn = rg * 10. + fg * 3.4;

  // the sweep: every 6.5 s a band of light crosses the wall, then rests
  // phased so the reduced-motion still (t = 6.5) holds the band across the right of the wall
  float ph = fract((t + 2.2) / 6.5);
  float sweep = mix(-.3, 1.3, smoothstep(0., .55, ph));
  float band = exp(-pow((sweep - ccSweepAt(p, aspect)) / .09, 2.));

  // the pointer: crystals near it light up from within, as if a lamp passed by
  vec2 hp = p - pointerP();
  float hover = exp(-dot(hp, hp) / .07);

  // walk the scene: the frontmost rock or crystal under x, the light the
  // clusters throw on what is around them, the glints on their tips
  float bestZ = -1., hitD = 9., spark = 0., spZ = 0., glow = 0.;
  bool isRock = false;
  float mD[16];
  vec2 gdir = vec2(0.);
  vec4 F = vec4(0.); // the front crystal's shape: both ends grown, broken, where and how slanted
  vec4 A = vec4(0.), B = vec4(0.);
  vec2 C = vec2(0.), back = vec2(9.), mO = vec2(0., 1.);
  for (int i = 0; i < CC_N; i++) {
    vec4 a = ccA(i), b = ccB(i);
    vec2 root = a.xy * qs;
    float size = a.z * sz;
    vec2 md = vec2(cos(a.w), sin(a.w)), mp = vec2(-md.y, md.x);
    vec2 dr = x - root;
    glow += b.w * exp(-length(dr - md * size * .35) / (size * .9));

    // its rock: a rounded, fractured mass under the root, the root buried
    // a little in it; the stone's own relief bends its outline
    float rxm = size * b.y, rym = size * b.z;
    vec2 mq = dr + md * rym * .92;
    vec2 lq = vec2(dot(mq, mp) / rxm, dot(mq, md) / rym);
    float fi = float(i);
    float an = atan(lq.y, lq.x);
    float bl = length(lq) / (1. + .1 * sin(an * 3. + fi * 1.7) + .05 * sin(an * 5. + fi * 4.1));
    float d = (bl - 1.) * rym + (r0 - .5) * min(rym, .25) * .4 + (abs(fine - .5) - .25) * min(rym, .25) * .32;
    mD[i] = d;
    // the crystals' light falls on the rock from where they stand
    vec2 toC = root + md * size * .35 - x;
    float gl = b.w * exp(-length(toC) / (size * .9));
    gdir += toC / max(length(toC), .001) * gl;
    if (d < PX && b.x + .5 > bestZ) {
      bestZ = b.x + .5;
      isRock = true;
      hitD = d;
      mO = (mp * lq.x * rym / rxm + md * lq.y) / max(bl, .001);
      C = vec2(b.x, smoothstep(.45, 1., bl));
    }

    if (b.w == 0. || dot(dr, dr) > size * size * 1.15) continue;
    // a real cluster: a leader, a second about 1.3x shorter, a couple
    // leaning in across them, the rest fanning out, small ones at the foot;
    // a few lie loose with both ends grown, a few have broken tips
    int nk = i == 0 ? 9 : a.z > .2 ? 6 : 4;
    for (int k = 0; k < 9; k++) {
      if (k >= nk) break;
      float hk = ihash(ivec2(i * 16 + k, 19));
      float h2 = fract(hk * 17.3), h3 = fract(hk * 41.9), h4 = fract(hk * 7.9);
      float id = fract(hk * 5.3 + fi * .37);
      float side = h2 > .5 ? 1. : -1.;
      float fk = float(k);
      float len, ang, ro;
      if (k == 0) { len = size; ang = a.w + (h2 - .5) * .12; ro = 0.; }
      else if (k == 1) { len = size / 1.3; ang = a.w + side * (.22 + .12 * h4); ro = side * .1; }
      else if (k < 4) { len = size * (.45 + .2 * h4); ang = a.w - side * (.18 + .14 * h4); ro = side * (.2 + .1 * h4); }
      else { float sm = (fk - 4.) / max(float(nk) - 4., 1.); len = size * mix(.55, .2, sm) * (.8 + .4 * h4); ang = a.w + side * (.45 + .6 * sm + .25 * h3); ro = side * (.14 + .34 * h4); }
      float dbl = k >= 4 && h3 > .8 ? 1. : 0.;
      float cut = k >= 4 && dbl == 0. && fract(hk * 23.1) > .6 ? 1. : 0.;
      if (dbl > 0.) { ang = a.w + side * (1. + .4 * h4); len = size * (.22 + .12 * h4); }
      vec2 dir = vec2(cos(ang), sin(ang));
      float w = len * (k == 0 ? .12 : .12 + .08 * h3);
      // the roots spread along the rock; a loose one rests on it, lower tip showing
      vec2 dd = dr + dir * len * (dbl > 0. ? -.08 : .06) + mp * ro * size - md * dbl * size * .02;
      float u = dot(dd, dir), v = dot(dd, vec2(-dir.y, dir.x));
      float tl = w * (1.2 + .7 * fract(id * 7.7)), ts = len - tl;
      float wu = w * min(1., (len - u) / tl);
      if (dbl > 0.) wu = min(wu, w * u / tl);
      // a broken tip snaps off on a slant
      float slant = (h3 > .5 ? 1. : -1.) * (.9 + .8 * h4);
      float uc = cut > 0. ? ts - tl * .1 + v * slant : len;
      float e = max(abs(v) - wu, max(-u, u - uc));
      // the small ones at the foot stand nearest, the leaders further back
      float z = b.x + (fract(hk * 91.7) + dbl * 1.2 + (k >= 4 ? 1.5 : k >= 2 ? .8 : 0.)) * .03;
      // a glint on the tip, just after the sweep has passed it
      float ds = sweep - ccSweepAt(x - dd + dir * len * .9, aspect);
      if (h3 > .45 && cut == 0. && ds > 0. && ds < .3) {
        float r = length(dd - dir * len * .9) / (PX * (2.2 + 4. * a.z));
        float sp = smoothstep(0., .02, ds) * exp(-ds * 8.) * smoothstep(.3, .15, ds) * (smoothstep(1., .1, r) + exp(-r * .45) * .35) * b.w;
        if (sp > spark) { spark = sp; spZ = z; }
      }
      if (e < 0. && z <= bestZ && !isRock) back.x = min(back.x, -e);
      if (e < PX && z > bestZ) {
        back.x = min(back.x, max(-hitD, 0.));
        hitD = e;
        isRock = false;
        bestZ = z;
        A = vec4(u, v, w, len);
        B = vec4(dir, fract(hk * 63.1) * CC_SEG, id);
        C = vec2(b.x, b.w);
        F = vec4(dbl, cut, ts - tl * .1, slant);
      }
    }
  }
  glow = min(glow, 2.);
  // whatever is under x sits in the shadow of the rock in front of it
  float shade = 1.;
  for (int i = 0; i < CC_N; i++) {
    float ms = ccA(i).z * sz;
    if (ccB(i).x + .5 > bestZ) shade *= mix(.3, 1., smoothstep(0., .02 * ms + 2. * PX, mD[i])) * mix(.6, 1., smoothstep(0., .16 * ms, mD[i]));
  }

  // a pool of light rests on the hero and wanders a little around it
  vec2 pc = ccA(0).xy * qs + vec2(-.12 + .06 * sin(t * .05), .16 + .05 * cos(t * .041));
  float pool = exp(-length((p - pc) * vec2(.8, 1.)) * 1.8);
  vec3 violet = vec3(.24, .07, .42);

  // the far wall: faint rock everywhere, even in the dark upper left
  vec2 gd2 = gdir / max(length(gdir), .001);
  vec3 wn = normalize(vec3(rn, 1.));
  float litW = max(dot(wn, normalize(K + vec3(0., .3, .5))), 0.);
  vec3 col = vec3(.014, .01, .022) * (.55 + .9 * r0) + vec3(.045, .032, .06) * pow(litW, 4.) * r0;
  col += violet * glow * .07 * (.4 + .6 * r0) * (.5 + .8 * max(dot(wn.xy, gd2), 0.));
  col += vec3(.05, .016, .085) * exp(-length((p - vec2(.42 * aspect, -.38)) * vec2(.7, 1.)) * 2.2);

  if (bestZ > -.5 && isRock) {
    // a rock mass: rounded, turning away at its edge, smooth stone relief,
    // lit mostly by the violet light of the crystals near it and a little
    // by the key; a few druzy points glitter where that light is strong
    vec3 bn = normalize(vec3(mO * C.y * 1.5 + rn, 1.));
    float lit = max(dot(bn, normalize(K + vec3(0., .3, .5))), 0.);
    float spill = .4 + .6 * max(dot(bn.xy, gd2), 0.);
    float tone = .35 + 1.1 * r0 + .5 * (fine - .5);
    vec3 rock = vec3(.014, .01, .02) * tone + vec3(.05, .04, .065) * pow(lit, 3.) * tone;
    rock += violet * glow * pow(spill, 1.5) * .55 * tone;
    rock *= mix(1., .45, smoothstep(.7, 1., C.y) * smoothstep(.2, -.6, mO.y));
    rock += vec3(.62, .48, 1.) * stars(x + 5.1, 110., .12, t * .4) * min(glow, 1.) * spill * .8;
    rock += vec3(.12, .26, .38) * smoothstep(-3. * PX, -.5 * PX, hitD) * smoothstep(.5, .95, mO.y) * pow(lit, 3.) * smoothstep(.45, .7, r0) * (.2 + 1.2 * band);
    rock += vec3(.05, .025, .09) * band * tone * .5 * smoothstep(-.3, .5, mO.y);
    rock *= mix(.55, 1., smoothstep(3., 10., C.x)) * mix(.75, 1.05, pool);
    // the ceiling's lip catches the light of what hangs from it and stands under it
    rock += violet * (.08 + .6 * min(glow, 1.)) * pow(C.y, 2.) * tone * smoothstep(.1, -.5, mO.y);
    col = mix(col, rock, smoothstep(PX, -PX, hitD));
  }

  if (bestZ > -.5 && !isRock) {
    float px = PX;
    float cover = smoothstep(px, -px, hitD);
    float u = A.x, v = A.y, w = A.z, len = A.w;
    vec2 dir = B.xy;
    float phi = B.z, id = B.w;
    vec2 perp = vec2(-dir.y, dir.x);
    float tl = w * (1.2 + .7 * fract(id * 7.7)), ts = len - tl;
    bool tip = u > ts, foot = F.x > 0. && u < tl;
    float wu = w * min(1., (len - u) / tl);
    if (foot) wu = min(wu, w * u / tl);
    float s = clamp(v / wu, -1., 1.);
    float alpha = acos(s);
    float fa = (alpha - phi) / CC_SEG;
    float fi = floor(fa), fr = fa - fi;
    float th = phi + (fi + .5) * CC_SEG;
    vec3 nrm = normalize(vec3(perp * cos(th), max(sin(th), .05)));
    float tb = w / tl;
    if (tip) nrm = normalize(nrm * (.55 + .25 * tb) + vec3(dir, 0.) * .62);
    if (foot) nrm = normalize(nrm * (.55 + .25 * tb) - vec3(dir, 0.) * .62);
    // flat facets: lit as planes, a glint when one turns to the light
    float lam = max(dot(nrm, K), 0.);
    // facets are not quite flat mirrors: the reflection bends a little
    // along each, so a glint slides over it as the light drifts
    float along = u / len;
    vec3 R = reflect(vec3(0., 0., -1.), nrm);
    R = normalize(R + vec3(dir * (along - .6) * .5 + perp * s * .15, 0.));
    float rr = max(dot(R, L), 0.);
    float spec = pow(rr, 40.) + pow(rr, 6.) * .25;
    float bounce = pow(max(dot(R, normalize(vec3(-.5, -.7, .5))), 0.), 5.);
    float fres = pow(1. - nrm.z, 3.);

    // most are amethyst, redder or bluer, richer or paler; one in twenty is teal ice
    float teal = step(.95, id);
    float hue = fract(id * 13.1), sat = .65 + .45 * fract(id * 29.7);
    vec3 deep = mix(mix(vec3(.05, .01, .1), vec3(.032, .012, .11), hue), vec3(.012, .06, .09), teal);
    vec3 mid = mix(mix(vec3(.55, .12, .76), vec3(.34, .16, .88), hue), vec3(.2, .66, .85), teal);
    mid = mix(vec3(dot(mid, vec3(.33))), mid, sat);
    vec3 pale = mix(vec3(.88, .76, 1.), vec3(.68, .96, 1.), teal);
    float lum = (.55 + .65 * fract(id * 5.7)) * (1. + .5 * teal);

    // translucency: smoky and dark at the base, clearing toward a bright tip;
    // light let in by the lit side glows out of the middle, through veils
    float thick = sqrt(1. - s * s);
    float clear = smoothstep(.12, .95, along);
    float lsd = dot(L.xy, perp);
    // streaks run the length of the crystal, the way it grew
    float veil = inoise(vec2(along * 3.4 + id * 17., s * 4.6 + along * 1.5 + id * 31.));
    // the glowing core sways slowly from side to side, so light shifts inside
    float sway = .3 * sin(t * .33 + id * 40.);
    float inner = exp(-pow((s + lsd * .7 + sway) * 1.5, 2.)) * thick * (.35 + 1.3 * veil * veil);
    float tipGlow = smoothstep(.5, 1., along) * (1. - .6 * abs(s));
    vec3 smoke = vec3(.03, .022, .04);
    vec3 cc = mix(smoke, deep, clear) * (.6 + .6 * thick) * (.7 + .6 * veil);
    cc += mid * (inner * (.06 + .4 * clear) + tipGlow * .26) * lum;
    // veils and a phantom: the outline of an earlier tip, grown over
    cc += mix(mid, pale, .5) * smoothstep(.62, .85, veil) * thick * clear * .16 * lum;
    float phl = len * (.1 + .12 * fract(id * 3.3));
    float pw = w * (len - phl - u) / tl;
    float phantom = smoothstep(1.4 * px, 0., abs(abs(v) - pw)) * step(ts - phl, u) * step(0., pw) * step(.5, fract(id * 9.1));
    cc += mix(mid, pale, .5) * phantom * .1 * lum;
    // facets reflect as flat planes, a glint when one turns to the light
    cc += mix(mid, pale, .15) * pow(lam, 2.) * .5 * (.7 + .3 * lum) * (.5 + .5 * clear);
    cc += pale * fres * .06 + pale * spec * 1.1;
    cc += vec3(.1, .4, .5) * bounce * .12 * lum;
    // a few breathe slowly, light swelling and ebbing inside them
    float breathe = step(.65, fract(id * 21.3)) * pow(.5 + .5 * sin(t * .55 + id * 60.), 3.);
    cc += mix(mid, pale, .2) * breathe * (.3 + .7 * thick) * clear * .36 * lum;
    cc += mix(mid, pale, .4) * hover * (.45 + 2.2 * inner + 1.2 * tipGlow) * (.4 + .6 * clear) * (.5 + .5 * lum);
    // the back edges, and any crystal behind, seen through it
    float ink = 0.;
    for (int k = 0; k < 6; k++) {
      float g = phi + float(k) * CC_SEG;
      if (sin(g) < 0.) ink += smoothstep(1.5 * px, 0., abs(s - cos(g)) * wu);
    }
    ink += smoothstep(1.6 * px, 0., abs(back.x - 1.5 * px)) * .8;
    cc += mix(mid, pale, .3) * ink * .1 * (.3 + .7 * clear);
    // facet edges catch the light; the seam where the tip begins
    float ea = min(fr, 1. - fr) * CC_SEG * wu * max(thick, .12);
    float edge = smoothstep(1.3 * px, 0., ea);
    float uc = F.y > 0. ? F.z + v * F.w : len;
    edge = max(edge, smoothstep(1.3 * px, 0., abs(u - ts)) * step(abs(s), .995) * step(u, uc));
    if (F.x > 0.) edge = max(edge, smoothstep(1.3 * px, 0., abs(u - tl)) * step(abs(s), .995));
    // a broken tip: a rough pale fracture across the end
    float brk = smoothstep(2.5 * px, 0., uc - u) * F.y;
    edge = max(edge, brk);
    float sil = smoothstep(1.3 * px, 0., (wu - abs(v)) * .8);
    // a glinting edge splits a little, rose to ice along its length
    vec3 prism = mix(vec3(1., .62, .9), vec3(.62, .88, 1.), smoothstep(.2, .8, fract(along * 1.3 + id * 3.)));
    cc += pale * prism * edge * (.015 + .8 * pow(lam, 4.) + 1.4 * spec) * .55 + mid * sil * .04;

    // the sweep catches each facet in turn, and its light passes through
    // the crystal as a soft glow
    vec2 root = p - dir * u - perp * v;
    vec2 fc = root + dir * (tip ? ts + tl * .3 : ts * .55) + perp * cos(th) * w * .7;
    float sf = ccSweepAt(fc, aspect);
    float face = max(dot(nrm, normalize(vec3(-.3, .3, .9))), 0.);
    float catchL = exp(-pow((sweep - sf) / .06, 2.));
    float through = exp(-pow((sweep - ccSweepAt(root + dir * len * .6, aspect)) / .1, 2.));
    cc *= mix(.42, 1.05, pool);
    cc += mid * through * (.15 + .4 * thick) * clear * lum + mix(mid, pale, .7) * catchL * face * face * 1.05;

    // the root is frosted, rough and milky, clearing as it grows
    float frost = inoise(vec2(u, v) / w * 7. + id * 50.);
    float fAmt = smoothstep(min(.5 * len, 4. * w), .2 * w, u);
    cc = mix(cc, vec3(.085, .07, .115) * (.55 + .9 * frost) * (.45 + .7 * lam) * mix(.42, 1.05, pool), fAmt * .6);
    // it rises out of the rock's shadow; far clusters are dimmer, the hero brightest
    cc *= .3 + .7 * smoothstep(0., min(.2 * len, 1.6 * w), u);
    // each cluster glows from within by how much light it gives: the hero most
    cc += mid * (inner * .8 + tipGlow * .45) * clear * C.y * C.y * lum;
    cc *= mix(.75, 1., smoothstep(3., 10., C.x)) * (.85 + .2 * C.y);
    col = mix(col, cc, cover);
  }

  col *= shade;
  // a glint shows only if nothing stands in front of its tip
  col += vec3(.92, .84, 1.) * min(spark, 1.4) * .8 * step(bestZ, spZ + .001);
  // a faint violet haze in the air around the clusters
  col += violet * glow * .035;
  col += violet * hover * min(glow, 1.) * .14;
  // dust in the air, showing where it drifts through the crystals' light
  col += vec3(.72, .58, 1.) * (ccMotes(x, t, 8., 1.) + .7 * ccMotes(x + 3., t, 15., 2.)) * (.03 + .4 * min(glow, 1.3));

  // the edges fall into shadow, the upper left stays darkest
  vec2 e = (uv - .5) * 2.;
  col *= 1. - .5 * pow(clamp(length(e) * .72, 0., 1.), 2.5);
  col *= .4 + .6 * wallHere;
  return col;
}
`),
  maple: shader(`
// Autumn maple: a forest path in peak autumn, sunbeams slanting in from the
// upper right through warm haze. The forest is a scene built and rendered in
// Blender (u_sprite, maple-built-2.webp: the 2048 x 1152 render on top; below
// it at half size, its depth on the left and on the right a sway mask from
// the same scene, white on the leaves, faint on the maple limbs, black on the
// trunks and the ground). The crowns sway in the wind here, harder in a gust
// every few seconds, and the near ones more; the beams shimmer, and the
// falling leaves are real geometry, drawn over this by profile-theme-maple.ts.
uniform sampler2D u_sprite;

// The depth (x) and sway mask (y) at a point of the render.
vec2 mpLayers(vec2 f) {
  float y = (1184. + (1. - f.y) * 576.) / 1760.;
  return vec2(textureLod(u_sprite, vec2(f.x * .5, y), 1.).r, textureLod(u_sprite, vec2(.5 + f.x * .5, y), 1.).r);
}

// How hard the wind blows: a light breeze, and a gust every 7 s that rises in
// about a second and dies away over two.
float mpGust(float t) {
  float ph = fract(t / 7. + .3);
  return .3 + .7 * smoothstep(0., .14, ph) * smoothstep(.5, .16, ph);
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  float sc = min(u_scroll, 3.);
  float narrow = mix(.72, 1., smoothstep(.5, 1.3, aspect));

  // the photo, cover-fitted a touch larger than the screen (a phone shows
  // its middle, where the path glows); it drifts a little, and leans with
  // the page and the pointer
  float ph = max(1., aspect / 1.7778);
  float hw = .5 * aspect / (1.7778 * ph) / 1.05;
  float cx = clamp(.5, hw + .006, 1. - hw - .006);
  vec2 drift = vec2(sin(t * .05) * .004, cos(t * .037) * .003) + vec2(0., sc * .005) + pointerP() * .006;
  vec2 f = clamp(vec2(p.x / (1.7778 * ph), p.y / ph) / 1.05 + vec2(cx, .5) + drift, .001, .999);
  // the wind: each crown leans downwind and springs back as the gusts pass,
  // in slow swells that roll across the scene, with a finer flutter of the
  // leaves on top; the near crowns move the most, the far ones barely
  vec2 lay = mpLayers(f);
  float g = mpGust(t);
  float reach = lay.y * (.25 + .75 * lay.x);
  float swell = inoise(f * vec2(3.2, 2.4) + vec2(-t * .32, t * .05)) - .5;
  float flutter = inoise(f * vec2(26., 20.) + vec2(-t * 1.6, t * .4)) - .5;
  vec2 wind = vec2(g * .55 + swell * (.6 + g) + flutter * .35 * (.4 + g), swell * .25 * (.6 + g) + flutter * .3);
  // The ground, laid out in metres from the depth pass (2 m near to 70 m
  // far, on a log scale): the canopy's moving shadow falls across it, sun
  // spots breaking through the leaves that drift with the swell and slide
  // downwind in a gust, and the near litter stirs as a gust passes.
  float dist = 2. * pow(35., 1. - lay.x);
  float ground = (1. - lay.y) * smoothstep(.62, .44, f.y) * smoothstep(34., 10., dist);
  vec2 gq = vec2((f.x - .5) * 1.15 * dist, dist * 1.6);
  float stir = inoise(gq * 2.2 + vec2(-t * 1.1, t * .3)) - .5;
  f += ground * smoothstep(9., 3., dist) * g * stir * vec2(.0014, .0005);
  f = clamp(f - wind * reach * .003, .001, .999);
  // the render fills the top 1152 of the texture's 1760 rows
  vec3 col = texture(u_sprite, vec2(f.x, (1. - f.y) * (1152. / 1760.))).rgb;
  // and the sun flickers through the moving leaves
  col *= 1. + reach * flutter * .16 * (.5 + g);
  vec2 gs = gq * .8 + vec2(-t * .06 - g * .7 + swell * 1.4, t * .025 + swell * .5);
  float spots = smoothstep(.54, .74, inoise(gs) * .62 + inoise(gs * 2.4 + 4.1) * .38);
  col *= 1. + ground * (spots - .3) * .34;
  col += vec3(1., .72, .4) * ground * spots * .05 * (.6 + .4 * g);
  // graded gently golden
  col = mix(vec3(dot(col, vec3(.3, .55, .15))), col, 1.06) * vec3(1.04, 1., .93);

  // the sun above the frame, top right, its beams shimmering down through the haze
  vec2 sun = (vec2(.64, 1.12) - vec2(cx, .5) - drift) * 1.05 * vec2(1.7778 * ph, ph);
  vec2 sd = p - sun;
  float r = length(sd);
  float ray = inoise(sd / max(r, 1e-3) * 5. + vec2(t * .02, -t * .014));
  float rays = smoothstep(.42, .9, ray) * exp(-r * .9) * smoothstep(.3, -.5, sd.y / max(r, 1e-3));
  col += vec3(1., .8, .48) * rays * .12 * (.8 + .2 * sin(t * .31 - .45)) * (1. - col * .5);
  col += vec3(.9, .68, .4) * (inoise(p * 1.3 + vec2(t * .016, t * .005)) - .45) * .05 * exp(-r * 1.2);

  // shade behind the name and avatar, top left; a phone has the name across
  // most of its top, so it is shaded there too
  float ulz = smoothstep(.12, -.32, p.x / aspect) * smoothstep(-.22, .3, p.y);
  col *= (1. - .55 * ulz) * .86;
  col *= 1. - (1. - narrow * narrow) * .6 * smoothstep(.0, .42, p.y);
  return col;
}
`),
  chrome: shader(`
// Liquid chrome: a sheet of mirror-black metal rolling in slow, heavy swells.
// Long studio softboxes trace crisp lines along the crests, a thin film turns
// oil-slick where the surface tips away, and every 5 s a drop lands off-centre
// and one soft ring swells out, bending the reflections, before the sheet rests.
// The lights hang over the lower right, so the upper left stays dark; the
// lights lean after the pointer, and the sheet drifts as the page scrolls.
// No noise lookups: the surface and its slope are a handful of analytic waves.

// The swells: a few long waves with sharpened crests (exp of a sine), summed
// with their slope worked out alongside, so no extra surface evaluations.
vec3 lcSwell(vec2 q, vec2 k, float w, float ph, float a, float t) {
  float th = dot(q, k) + w * t + ph;
  float s = exp(sin(th) - 1.);
  return vec3(s, s * cos(th) * k) * a;
}

// The swells run as long folds across the sheet, their ridges along LC_R.
const vec2 LC_K = vec2(-.42, .91);
const vec2 LC_R = vec2(.91, .42);

// Height in x, slope in yz.
vec3 lcSurface(vec2 p, float t) {
  // a slow, smooth bend of the whole sheet, so the folds curve and never run straight
  vec2 q = p;
  q += .14 * LC_K * sin(dot(p, LC_R) * 2.6 + t * .1 + 1.3) + .05 * LC_R * sin(dot(p, LC_K) * 3.4 - t * .08);
  q += .018 * vec2(sin(q.y * 5.3 - t * .15), sin(q.x * 4.7 + t * .12 + 2.));
  vec3 h = lcSwell(q, rot(.07) * LC_K * 5.1, .3, 0., .18, t);
  h += lcSwell(q, rot(-.06) * LC_K * 7.3, -.24, 1.7, .1, t);
  h += lcSwell(q, rot(.12) * LC_K * 10.9, .37, 4.1, .017, t);
  h += lcSwell(q, rot(-.14) * LC_K * 16.8, -.45, 2.6, .004, t);
  return h;
}

// The drop: every 5 s one soft ring swells out from a point off-centre, gone before the next.
vec2 lcRipple(vec2 p, float t) {
  // timed so the still frame (t = 6.5) catches a late ring, wide and faint
  float k = floor((t + 1.7) / 5.);
  float tau = t + 1.7 - k * 5.;
  float aspect = u_res.x / u_res.y;
  vec2 c = vec2(mix(.1, .5, ihash(ivec2(int(k), 3))) * aspect, mix(-.38, -.05, ihash(ivec2(int(k), 21))));
  vec2 o = p - c;
  float r = length(o) + 1e-4;
  float R = .05 + .17 * tau;
  float d = r - R;
  // one broad, low swell running outward as a ring, with a gentler trough
  // behind it, quickly damped: so wide and soft that its curvature stays well
  // under the folds', and a line it crosses bends smoothly, never kinks
  float w = .18 + .04 * tau;
  float amp = .032 * smoothstep(0., 1.2, tau) * exp(-tau * .5) * smoothstep(4.9, 3.2, tau) / sqrt(1. + r * 2.);
  float x = d / w, y = x + 1.6;
  float dh = amp / w * (-2. * x * exp(-x * x) + .7 * y * exp(-y * y));
  // (and none at the very centre, where the ring's direction is undefined)
  return dh * smoothstep(0., .15, r) * o / r;
}

// A strip of light across x, centred on c with half-width hw, box-filtered
// over the pixel's footprint fw: crisp when it is wide, and a fine line
// thinner than a pixel dims rather than breaking into steps.
float lcStrip(float x, float c, float hw, float fw) {
  return clamp((x - c + hw) / fw + .5, 0., 1.) - clamp((x - c - hw) / fw + .5, 0., 1.);
}

// The studio, seen in direction r from a point at p. x: the key softbox,
// y: the room and a big dim panel, z: the two side strips and the far wall,
// met at steeper angles, where the film shows, w: the glow round the lights.
vec4 lcStudio(vec3 r, vec2 p, float hero) {
  // where the ray meets the ceiling, the lights hung nearer over the lower
  // right and leaning a little after the pointer
  vec2 s = r.xy / max(r.z, .15) - p * .3 - vec2(0., .45) - pointerP() * .12;
  // across and along the folds
  vec2 sk = vec2(dot(s, LC_K), dot(s, LC_R));
  // the pixel's footprint, widened: fwidth is shared by each 2x2 block of
  // pixels, and a bare footprint leaves steps along the steepest edges
  vec2 fw = fwidth(sk) * 1.75 + 1e-4;
  // every light is laid along the folds and fades toward its ends
  float len = smoothstep(1.8, .3, abs(sk.y - .2));
  // the room: black straight overhead, so the flat crests and troughs stay mirror-dark
  // the big soft light the folds' bodies catch: nothing facing straight up,
  // rising across each flank toward the key, so every fold shows its curve
  float body = smoothstep(-.32, .34, sk.x);
  float room = .002 + .15 * body * body * smoothstep(1.05, .6, sk.x) * smoothstep(3., .2, abs(sk.y - .3));
  // and on the far side a dimmer sheen rising toward the far strip, so its line sits on a body too
  float far = smoothstep(-.22, -.79, sk.x);
  room += .15 * far * far * smoothstep(-1.05, -.8, sk.x) * smoothstep(2.2, .4, abs(sk.y - .3));
  // the key: a wide softbox, hot along its far edge and falling away across
  // it, so each crest carries a broad sheet of light with one crisp bright
  // edge; a thin strip beyond it and one on the other side put a fine line
  // down the steeper flanks
  // over the hero fold the key hangs lowest, so that fold catches its hot edge squarely
  float kx = sk.x + .24 * hero;
  float ka = clamp((kx - .32) / .5, 0., 1.);
  float key = lcStrip(kx, .57, .25, fw.x + .008);
  // the softbox's frame bars show as two crisp dark bands across the sheet
  float bars = 1. - .85 * lcStrip(kx, .575, .012, fw.x + .004) - .6 * lcStrip(kx, .47, .008, fw.x + .004);
  // (its near edge has a faint frame, so even a broad, magnified sheet of it keeps a clean outline)
  float a = key * (.1 + .38 * ka * sqrt(ka)) * bars * (.75 + .5 * hero) + .5 * lcStrip(kx, .785, .035, fw.x + .012) + .07 * lcStrip(kx, .335, .01, fw.x + .004);
  // the hot spot: where the hero fold meets the key's hot edge most squarely, a
  // near-white glint and a small soft bloom round it
  float hx = (kx - .79) / .05;
  a += hero * hero * (2.2 * exp(-hx * hx) + .14 * exp(-abs(hx) * .5));
  float b = lcStrip(sk.x, -.8, .028, fw.x + .005);
  float c = lcStrip(sk.x, 1.22, .018, fw.x + .004);
  // the glow just past each light and the key's dim side, where the film's colour shows
  float halo = key * (.08 + .1 * hero) * (1. - ka) + .08 * exp(-abs(kx - .82) * 7.) + .07 * exp(-abs(sk.x - 1.22) * 11.) + .05 * exp(-abs(sk.x + .8) * 11.);
  // and a short one across them, for the odd cross glint
  float d = lcStrip(sk.y, 1.05, .03, fw.y + .005) * smoothstep(.6, .4, abs(sk.x - .1));
  float wall = smoothstep(1.2, 2.2, abs(sk.x)) * smoothstep(4.5, 2.6, abs(sk.x)) * .05;
  // the two side strips and the soft glow round them, met on the steep flanks, where the film shows
  float steep = b * 2.6 + c * 2.4 + (.1 + .08 * hero) * exp(-abs(sk.x - 1.22) * (5. - 2. * hero)) + .06 * exp(-abs(sk.x + .8) * 6.);
  return vec4((a * 6.5 + d * 2.5) * len, room, steep * len + wall, halo * len);
}

// The film's colour at thickness x: violet, teal and gold in turn.
vec3 lcFilm(float x) {
  vec3 w = .5 + .5 * cos(6.2832 * (x - vec3(0., .3333, .6667)));
  w *= w;
  return (vec3(.42, .26, .95) * w.x + vec3(.12, .78, .74) * w.y + vec3(1., .74, .3) * w.z) / (w.x + w.y + w.z);
}

vec3 theme(vec2 uv, vec2 p, float t) {
  // a portrait screen sees the sheet from further back, so it still gets two or three folds
  float zoom = mix(1.55, 1., smoothstep(.6, 1.5, u_res.x / u_res.y));
  vec2 P = p * zoom + vec2(0., u_scroll * .12);
  vec3 h = lcSurface(P, t);
  vec2 g = h.yz + lcRipple(P, t);
  vec3 n = normalize(vec3(-g, 1.));
  vec3 v = normalize(vec3(0., .22, -1.));
  vec3 r = reflect(v, n);
  float cosv = clamp(-dot(v, n), 0., 1.);
  float graze = 1. - cosv;
  // chrome: a high, slightly cool reflectance that climbs toward grazing
  float F = .62 + .38 * pow(graze, 5.);
  // the hero fold: the lights sit nearest over the lower right
  float hero = exp(-dot((uv - vec2(.78, .3)) * vec2(1.3, 1.), (uv - vec2(.78, .3)) * vec2(1.3, 1.)) * 4.5);
  vec4 env = lcStudio(r, P, hero);
  // a thin film over the metal, its thickness drifting with the swells; its
  // colour tints the glow round the lights, and the rest only where it tips away
  vec3 irid = lcFilm(h.x * 4.5 + length(g) * 1.2 + dot(P, LC_R) * .45 + t * .015);
  float sheen = smoothstep(.2, .65, length(g));
  vec3 col = vec3(.95, .97, 1.) * env.x * F;
  col += env.w * F * mix(vec3(.9), irid * 2., .45 + .55 * sheen);
  col += env.y * F * mix(vec3(1.), irid * 1.7, sheen * .7);
  col += env.z * F * mix(vec3(.95, .97, 1.), irid * 1.7, .14 + .46 * sheen);
  // the troughs sit in their own shadow, so the folds read as folds
  col *= mix(.4, 1., smoothstep(.045, .14, h.x));
  // the light falls away from the upper left, where the name sits
  float pool = smoothstep(.06, .95, dot(uv - vec2(.05, .95), normalize(vec2(1., -.8))));
  // a soft shoulder, so the hot lines roll off rather than clip
  col = 1. - exp(-col * 1.05);
  col *= .05 + .95 * pool;
  col *= 1. - .35 * dot(uv - .5, uv - .5);
  return col;
}
`),
  // Aero: Frutiger Aero, up close. Glossy green leaves beaded with water drops
  // against a soft aqua bokeh (our own Blender render, theme-aero/
  // build_aero_macro.py), graded down for the page. Glass bubbles with a
  // soap-film rim (rendered there too) rise at three depths, the far ones
  // passing behind the leaves; light ripples over the leaves as through
  // water; everything shifts with depth under the pointer and on scroll.
  // u_sprite (2048 x 1760): rows 0-1151 the render, 16:9; rows 1184-1759,
  // columns 0-1023 its depth pass at half size (white near, black far);
  // columns 1024-2047 eight bubbles in 256 px cells, 4 x 2, on black.
  aero: shader(`
uniform sampler2D u_sprite;

const float AE_IA = 16. / 9.;

vec3 aeScene(vec2 f, float lod) {
  f = clamp(f, vec2(.001), vec2(.999, .996));
  return textureLod(u_sprite, vec2(f.x, (1. - f.y) * 1152. / 1760.), lod).rgb;
}

float aeDepth(vec2 f, float lod) {
  f = clamp(f, vec2(.004), vec2(.996));
  return textureLod(u_sprite, vec2(f.x * .5, (1184. + (1. - f.y) * 576.) / 1760.), lod).r;
}

/* Bubble k (0..7) at q, the bubble's own disc running -1..1. */
vec3 aeBubble(float k, vec2 q) {
  if (dot(q, q) > 1.) return vec3(0.);
  vec2 c = vec2(mod(k, 4.), floor(k / 4.));
  vec2 g = q * .43 + .5;
  return texture(u_sprite, vec2((1024. + (c.x + g.x) * 256.) / 2048., (1184. + (c.y + 1. - g.y) * 256.) / 1760.)).rgb;
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  // cover-fit, a touch zoomed so it can drift
  float s = max(1., aspect / AE_IA) * 1.04;
  float halfW = aspect / (2. * s * AE_IA);
  vec2 sc = vec2(s * AE_IA, s);
  vec2 ctr = vec2(clamp(.55, halfW + .012, 1. - halfW - .012), .5);
  ctr += vec2(.006 * sin(t * .05), .004 * sin(t * .041 + 1.));
  vec2 f0 = p / sc + ctr;
  vec2 par = pointerP() * vec2(.007, .005) + vec2(0., min(u_scroll, 1.) * .008);
  float dp = aeDepth(f0, 2.);
  vec2 f = f0 + par * (dp - .35);
  vec3 col = aeScene(f, 0.);
  float d = aeDepth(f, .5);

  // light rippling over the leaves, as if through water above them
  float leaf = smoothstep(.35, .6, d);
  vec2 cq = f * vec2(9., 5.) + vec2(t * .05, -t * .04);
  float caustic = pow(abs(sin(cq.x + 1.7 * noise(cq * .8 + t * .1)) * sin(cq.y + 1.3 * noise(cq * .7 - t * .08))), 3.);
  col *= 1. + leaf * caustic * .35;

  // down for the page, cooler in the shadows
  col = col * .55;
  col = mix(col, col * vec3(.82, 1., 1.08), .6);

  // Soap bubbles rising at three depths; the far ones pass behind the leaves.
  // Each one wobbles as it rises (its outline squashing and stretching), sways
  // on its own slow path, bends the scene behind it like a lens, and its film
  // colours drift.
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float gs = 3.2 - fl * .9;
    vec2 q = p * gs;
    q.y -= t * (.05 + .035 * fl) + u_scroll * gs * (.1 + .08 * fl);
    vec2 id = floor(q + vec2(0., 0.));
    // sway: each column drifts on its own slow path
    float sway = sin(t * (.35 + .2 * hash(vec2(id.x, fl))) + q.y * 1.1 + hash(vec2(id.x, fl + 9.)) * 6.28) * .07;
    q.x += sway;
    id = floor(q);
    if (hash(id + fl * 31.) < .62) continue;
    vec2 c = id + .5 + (vec2(hash(id + 1.), hash(id + 2.)) - .5) * .4;
    float r = (.11 + .1 * hash(id + 3.)) * (.75 + .25 * fl);
    float ph = hash(id + 6.) * 6.28;
    // the wobble: a squash and stretch that turns slowly, plus a faint ripple of the rim
    float wa = t * (1.1 + .6 * hash(id + 7.)) + ph;
    float sq = .07 * sin(wa) + .03 * sin(wa * 2.3 + 1.);
    float ang = .6 * sin(t * .3 + ph);
    mat2 R = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
    vec2 bq = R * ((q - c) / r);
    bq *= vec2(1. + sq, 1. - sq);
    bq = transpose(R) * bq;
    float a = atan(bq.y, bq.x);
    bq *= 1. + .025 * sin(a * 3. + wa * 1.7) + .015 * sin(a * 5. - wa * 2.1);
    float rr = dot(bq, bq);
    if (rr > 1.) continue;
    bq.x *= hash(id + 5.) < .5 ? 1. : -1.;
    float k = floor(hash(id + 4.) * 8.);
    float layerDepth = .25 + .25 * fl;
    float hidden = l == 0 ? smoothstep(layerDepth, layerDepth + .15, d) : 0.;
    float show = (.55 + .2 * fl) * (1. - hidden);
    // the lens: the scene behind seen slightly magnified and bent toward the rim
    vec2 lensF = f - (bq * r / gs / sc) * (.35 + .5 * rr);
    vec3 behind = aeScene(lensF, 1.5) * .55;
    behind = mix(behind, behind * vec3(.82, 1., 1.08), .6);
    col = mix(col, behind, .5 * (1. - hidden) * smoothstep(1., .85, rr));
    // the film: the rendered bubble, its colours drifting a little
    vec3 b = aeBubble(k, bq);
    vec3 drift = .85 + .3 * cos(6.2832 * (t * .07 + ph * .2 + rr * .6 + vec3(0., .33, .67)));
    col += b * drift * show;
  }

  col *= 1. - .3 * dot(uv - .5, uv - .5);
  return col;
}`),

  // Aero glass: the other half of Frutiger Aero, the desktop itself. Ribbons of
  // light sweep up from the lower left over deep water blue, each a strip of
  // silk that twists (its width swings through zero), lit along one edge with
  // fine threads trailing it; now and then a glint runs a ribbon's length.
  // Glass orbs rise in front at three depths, each magnifying the ribbons
  // behind it, with the gloss cap of the era on top. All drawn here, no sprite.
  aeroglass: shader(`
const vec3 AG_GREEN = vec3(.40, .95, .28);
const vec3 AG_AQUA = vec3(.08, .82, .80);
const vec3 AG_BLUE = vec3(.14, .44, 1.);

/* A ribbon's colour along its length: aqua, turning green, then blue. */
vec3 agHue(float k) {
  float g = .5 + .5 * sin(k);
  float b = .5 + .5 * sin(k * .63 + 2.1);
  return mix(mix(AG_AQUA, AG_GREEN, g * g), AG_BLUE, b * b * .8);
}

/* Ribbon i (0..3) at q, whose x runs along the ribbons. */
vec3 agRibbon(vec2 q, float t, float i) {
  float h1 = ihash(ivec2(int(i), 3)), h2 = ihash(ivec2(int(i), 11)), h3 = ihash(ivec2(int(i), 29));
  float x = q.x;
  // the lit edge: the ribbons fan out to the right
  float lit = (i - 1.5) * (.085 + .11 * (x + .9))
    + .13 * sin(x * (1. + .5 * h1) + t * (.05 + .03 * h2) + h1 * 6.283)
    + .04 * sin(x * 2.9 - t * .07 + h2 * 6.283);
  float d = abs(q.y - lit);
  // nothing of it reaches this far
  if (d > .42) return vec3(0.);
  // the strip hangs off that edge; its width swinging through zero is a twist
  float full = .13 + .15 * h3;
  float w = full * sin(x * (1. + .7 * h2) - t * (.045 + .03 * h1) + h3 * 6.283);
  float aw = max(abs(w), 1e-4);
  float v = (q.y - lit) / (w >= 0. ? aw : -aw);
  vec3 hue = agHue(x * 1.4 + i * 1.9 + t * .04);
  // every other ribbon leans green
  hue = mix(hue, AG_GREEN, mod(i, 2.) * (.4 + .25 * sin(x * .8 + t * .03 + i)));
  // a glint runs the ribbon's length, then it rests
  float gx = mod(t * .11 + i * .61, 2.6) - 1.3;
  float glint = exp(-(x - gx) * (x - gx) * 39.);
  vec3 col = vec3(0.);
  if (v > 0. && v < 1.) {
    float aa = min(1.5 * PX / aw, .5);
    float silk = .72 + .28 * sin(v * 34. + i * 2.) * sin(v * 11. + 1.);
    // narrower is brighter, as the same cloth gathers
    float pinch = sqrt(full / (aw + .3 * full));
    float band = smoothstep(0., aa, v) * pow(1. - v, 1.7) * silk * pinch;
    // its back is bluer and dimmer
    col += (w >= 0. ? hue : mix(hue, AG_BLUE, .6) * .55) * band * (.62 + .4 * glint);
  }
  col += mix(hue, vec3(1.), .55) * exp(-d / (1.3 * PX)) * (.35 + .65 * glint);
  col += hue * exp(-d * 13.) * .1;
  // threads trailing the edge
  float above = q.y - lit;
  if (above > 0. && above < .075) {
    float gap = .014 + .008 * sin(x * 1.9 + i * 3.);
    for (int k = 1; k <= 3; k++) {
      float fk = float(k);
      col += hue * exp(-abs(above - fk * gap) / (1.1 * PX)) * .16 / fk;
    }
  }
  return col;
}

vec3 agScene(vec2 p, float t) {
  // deep water blue, lit from the lower right, a little green in the other corner
  vec3 col = mix(vec3(0., .055, .075), vec3(.004, .018, .034), smoothstep(-.55, .55, p.y));
  vec2 g1 = p - vec2(.42, -.34);
  col += vec3(0., .2, .25) * exp(-dot(g1, g1) * 2.2);
  vec2 g2 = p - vec2(-.5, -.6);
  col += vec3(.035, .12, .02) * exp(-dot(g2, g2) * 3.5);
  vec2 q = rot(.42) * (p - vec2(-.1, -.12));
  q.x += u_scroll * .06;
  vec3 rib = vec3(0.);
  for (int i = 0; i < 4; i++) rib += agRibbon(q, t, float(i));
  col += rib;
  return 1. - exp(-col * 1.2);
}

vec3 theme(vec2 uv, vec2 p, float t) {
  vec2 pp = pointerP();
  // The orbs first: which one covers this pixel (the nearest wins), and how
  // far it bends the view, so the scene behind is drawn once, through it.
  vec2 lens = vec2(0.), bn = vec2(0.);
  float ba = 0.;
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float gs = 5.2 - fl * 1.5;
    vec2 q = (p - pp * (.006 + .008 * fl)) * gs + vec2(fl * 17.3, 0.);
    q.x += .06 * sin(q.y * 1.3 + t * .25 + fl * 2.);
    float column = floor(q.x);
    q.y -= (t * (.018 + .012 * fl) * (.7 + .6 * ihash(ivec2(int(column), l + 50))) + u_scroll * (.12 + .1 * fl)) * gs;
    ivec2 id = ivec2(floor(q)) + ivec2(l * 37, 0);
    if (ihash(id) > .17 - .03 * fl) continue;
    float r = mix(.16, .4, pow(ihash(id + ivec2(5, 1)), 2.));
    vec2 c = floor(q) + .5 + (vec2(ihash(id + ivec2(9, 2)), ihash(id + ivec2(3, 7))) - .5) * (1. - 2. * r) * .9;
    vec2 bq = (q - c) / r;
    float rr = dot(bq, bq);
    if (rr >= 1.) continue;
    float rp = r / gs;
    // far ones sit out of focus
    float soft = max(3. * PX / rp, .12 - .06 * fl);
    float edge = smoothstep(1., 1. - soft, rr);
    lens = bq * rp * (.4 * rr - .4) * edge;
    bn = bq;
    ba = edge * (.55 + .2 * fl);
  }
  vec3 col = agScene(p + lens, t);
  if (ba > 0.) {
    float rr = dot(bn, bn);
    // the glass darkens toward its rim, which catches sky above and grass below
    col *= 1. - ba * .2 * smoothstep(.3, 1., rr);
    vec3 rim = mix(vec3(.45, 1., .5), vec3(.55, .85, 1.), smoothstep(-.6, .6, bn.y));
    // brightest where the light comes in and where it leaves
    float lit = .35 + .65 * pow(abs(dot(normalize(bn + 1e-4), normalize(vec2(-.6, .8)))), 2.);
    col += ba * rim * (pow(rr, 3.) * .22 + smoothstep(.86, .97, rr) * .32) * lit;
    // the gloss cap, tipped toward the upper left
    vec2 g = rot(.6) * bn;
    vec2 m = (g - vec2(0., .5)) / vec2(.6, .3);
    float cap = smoothstep(1., .55, length(m)) * (.35 + .65 * smoothstep(-1., 1., m.y));
    col += ba * vec3(.85, 1., 1.) * cap * .38;
    // light gathering on the far side, low
    float bounce = smoothstep(.35, .95, rr) * pow(max(dot(normalize(bn + 1e-4), normalize(vec2(.55, -.83))), 0.), 4.);
    col += ba * vec3(.3, .95, .7) * bounce * .22;
  }
  // darker toward the upper left, where the name sits
  float pool = smoothstep(-.25, .75, dot(uv - vec2(0., 1.), normalize(vec2(1., -.75))));
  col *= .3 + .7 * pool;
  col *= 1. - .3 * dot(uv - .5, uv - .5);
  return col;
}`),

  // Terminal: an amber screen split into panes, each running something: a
  // doughnut turning, shaded in characters (the pointer tips it), a log
  // scrolling by with its last line still being typed, and a spectrum of
  // bars keeping time. The characters are 5x7 dot patterns held in the shader.
  tty: shader(`
/* Terminal: an amber screen split into panes, each running something. A
   doughnut turning, shaded in characters; a log scrolling by, its last line
   still being typed; a spectrum of bars keeping time along the bottom. */
const float TT_ROWS = 44.;
const vec3 TT_AMBER = vec3(1., .62, .1);

/* The dots of character g, 5 across and 7 down, a bit each: rows 0 to 3 in x,
   4 to 6 in y. In order: space . , - ~ : ; = ! * # $ @ (the shades a doughnut
   is drawn in, dark to bright), 0 to 9, a to f, then x o n u t v > _ / [ ] |
   and a solid block. (A chain of ifs: a constant array read by a variable
   index is rebuilt on every read by some drivers.) */
ivec2 ttGlyph(int g) {
  return
    g == 0 ? ivec2(0, 0) : g == 1 ? ivec2(0, 6336) : g == 2 ? ivec2(0, 2246) : g == 3 ? ivec2(1015808, 0) :
    g == 4 ? ivec2(690176, 8) : g == 5 ? ivec2(6336, 198) : g == 6 ? ivec2(6336, 2246) : g == 7 ? ivec2(31744, 31) :
    g == 8 ? ivec2(135300, 4100) : g == 9 ? ivec2(1030816, 686) : g == 10 ? ivec2(359754, 10591) : g == 11 ? ivec2(464836, 4596) :
    g == 12 ? ivec2(718382, 30781) : g == 13 ? ivec2(714286, 14899) : g == 14 ? ivec2(135364, 14468) : g == 15 ? ivec2(279086, 31812) :
    g == 16 ? ivec2(266527, 14896) : g == 17 ? ivec2(305544, 8479) : g == 18 ? ivec2(539711, 14896) : g == 19 ? ivec2(492620, 14897) :
    g == 20 ? ivec2(139807, 2114) : g == 21 ? ivec2(476718, 14897) : g == 22 ? ivec2(1001006, 6416) : g == 23 ? ivec2(538624, 31294) :
    g == 24 ? ivec2(635937, 15921) : g == 25 ? ivec2(47104, 14881) : g == 26 ? ivec2(842256, 31281) : g == 27 ? ivec2(571392, 14399) :
    g == 28 ? ivec2(232012, 2114) : g == 29 ? ivec2(345088, 17732) : g == 30 ? ivec2(571392, 14897) : g == 31 ? ivec2(635904, 17969) :
    g == 32 ? ivec2(574464, 23345) : g == 33 ? ivec2(72770, 12866) : g == 34 ? ivec2(574464, 4433) : g == 35 ? ivec2(266305, 1092) :
    g == 36 ? ivec2(0, 31744) : g == 37 ? ivec2(139792, 1058) : g == 38 ? ivec2(67662, 14402) : g == 39 ? ivec2(270606, 14600) :
    g == 40 ? ivec2(135300, 4228) : g == 41 ? ivec2(1048575, 32767) :
    ivec2(0);
}

/* How lit the point f of a cell (0..1, y down) is when it shows character g:
   its dots, in rows with a dark line between like a tube's scan lines. */
float ttInk(int g, vec2 f) {
  vec2 q = f * vec2(6., 9.) - vec2(.5, 1.);
  ivec2 ip = ivec2(floor(q));
  if (ip.x < 0 || ip.x > 4 || ip.y < 0 || ip.y > 6) return 0.;
  ivec2 bits = ttGlyph(g);
  int n = ip.y * 5 + ip.x;
  if ((n < 20 ? (bits.x >> n) & 1 : (bits.y >> (n - 20)) & 1) == 0) return 0.;
  // too small to tell dots apart (a thumbnail): an even grey instead of a shimmer
  float fine = smoothstep(.9, 2.2, 1. / (TT_ROWS * 9. * PX));
  return mix(.5, smoothstep(.5, .28, abs(fract(q.y) - .5)), fine);
}

/* The doughnut at d (its own units, y up): which shade its surface shows
   there, 1 to 12, or 0 off it. The pointer tips it. */
float ttDoughnut(vec2 d, float t, vec2 ptr) {
  if (dot(d, d) > 2.2) return 0.;
  mat2 ra = rot(t * .55 + ptr.y * 2.5), rb = rot(t * .33 + ptr.x * 2.5);
  float s = 1.4;
  vec3 q = vec3(0.);
  bool hit = false;
  for (int i = 0; i < 26; i++) {
    q = vec3(d, s - 3.);
    q.yz = ra * q.yz;
    q.xy = rb * q.xy;
    float dist = length(vec2(length(q.xz) - 1., q.y)) - .45;
    if (dist < .012) { hit = true; break; }
    s += dist;
    if (s > 4.6) break;
  }
  if (!hit) return 0.;
  vec3 n = normalize(q - vec3(q.x, 0., q.z) / max(length(q.xz), 1e-4));
  vec3 light = normalize(vec3(0., 1., -1.));
  light.yz = ra * light.yz;
  light.xy = rb * light.xy;
  float lum = dot(n, light);
  return lum > 0. ? 1. + floor(min(lum * 12., 11.)) : 1.;
}

/* The prompt over the doughnut, "$ ./donut", a character at a time. */
int ttPrompt(int k) {
  return k == 0 ? 11 : k == 2 ? 1 : k == 3 ? 37 : k == 4 ? 26 : k == 5 ? 30 : k == 6 ? 31 : k == 7 ? 32 : k == 8 ? 33 : 0;
}

/* The outline of a pane from a to b (cells), at g. */
float ttFrame(vec2 g, vec2 a, vec2 b, vec2 cell) {
  vec2 c = (a + b) * .5, h = (b - a) * .5 - .5;
  vec2 d = (abs(g - c) - h) * cell;
  float sd = length(max(d, 0.)) + min(max(d.x, d.y), 0.) - cell.y * .35;
  return smoothstep(PX * 1.5 + .0006, .0003, abs(sd));
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float A = u_res.x / u_res.y;
  vec2 ptr = pointerP();
  vec2 cell = vec2(.6, 1.) / TT_ROWS;
  // the screen moves up a few lines as the page scrolls
  vec2 g = vec2((p.x + A * .5) / cell.x, (.5 - p.y) / cell.y + min(u_scroll, 1.5) * 8.);
  ivec2 c = ivec2(floor(g));
  vec2 f = fract(g);
  int cols = int(A / cell.x), rows = int(TT_ROWS);
  // a wide screen has the log beside the doughnut; a narrow one, the doughnut alone
  int split = cols >= 72 ? int(float(cols) * .4) : 0;
  int mid = 25;
  int glyph = 0;
  float lit = 0.;
  bool inTop = c.y >= 2 && c.y < mid - 1;
  if (inTop && c.x > split + 1 && c.x < cols - 2) {
    // the doughnut, in the middle of its pane
    vec2 centre = vec2(float(split + cols) * .5, float(mid + 1) * .5 + .5);
    float radius = min(10.5 * cell.y, float(cols - split - 4) * cell.x * .5);
    vec2 d = (vec2(c) + .5 - centre) * cell * vec2(1., -1.) / radius * 1.5;
    float shade = ttDoughnut(d, t, ptr);
    if (shade > 0.) { glyph = int(shade); lit = .4 + .75 * shade / 12.; }
    if (c.y == 2 && c.x - split - 3 >= 0 && c.x - split - 3 < 9) { glyph = ttPrompt(c.x - split - 3); lit = .55; }
  } else if (inTop && c.x > 1 && c.x < split - 1) {
    // the log: lines come up from the bottom, the newest still being written
    int k = c.x - 2, wide = split - 5;
    int line = c.y + int(floor(t * 1.7));
    float seed = ihash(ivec2(line, 7));
    float len = seed < .1 ? 0. : 6. + floor(ihash(ivec2(line, 11)) * float(wide - 16));
    bool newest = c.y == mid - 2;
    float typed = newest ? floor(fract(t * 1.7) * (len + 14.) * 1.5) : 1e4;
    lit = (ihash(ivec2(line, 3)) > .88 ? .85 : .36) * (newest ? 1.4 : 1.);
    if (float(k) < typed && len > 0.) {
      if (k == 0) glyph = 38;
      else if (k < 5) glyph = 13 + (line / (k == 1 ? 1000 : k == 2 ? 100 : k == 3 ? 10 : 1)) % 10;
      else if (k == 5) glyph = 1;
      else if (k < 9) glyph = 13 + int(ihash(ivec2(line, k)) * 9.99);
      else if (k == 9) glyph = 39;
      else if (k > 10 && float(k - 11) < len && (k - 11) % 5 != 4) glyph = 13 + int(ihash(ivec2(line, k + 20)) * 15.99);
    }
    if (newest && float(k) == min(typed, len + 11.) && fract(t * 1.2) < .6) { glyph = 41; lit = .9; }
  } else if (c.y > mid + 1 && c.y < rows - 2 && c.x > 1 && c.x < cols - 2) {
    // the spectrum: bars two cells wide, the low notes on the left kicking with the beat
    {
      int k = c.x - 3;
      float bar = floor(float(k) / 3.), along = bar / (float(cols - 6) / 3.);
      float room = float(rows - 3 - (mid + 3));
      float beat = exp(-fract(t * 2.9) * 5.);
      float h = .1 + .75 * pow(inoise(vec2(bar * .42, t * (1.6 + 3.5 * along))), 1.3) + .55 * beat * (1. - along) * (1. - along) * (.5 + .5 * ihash(ivec2(int(bar), int(floor(t * 2.9)))));
      h = min(h, 1.) * room;
      float level = float(rows - 3 - c.y);
      if (k >= 0 && k % 3 != 2) {
        if (level < floor(h)) { glyph = 41; lit = .3 + .6 * level / room; }
        else if (level < h) { float part = fract(h); glyph = part > .66 ? 10 : part > .33 ? 7 : 36; lit = .45 + .5 * level / room; }
      }
    }
  }
  float ink = glyph > 0 ? ttInk(glyph, f) : 0.;
  vec3 col = vec3(.022, .012, .004);
  // a lit character, the brightest of them nearly white, and the glow it throws round itself
  col += mix(TT_AMBER, vec3(1., .86, .55), smoothstep(.7, 1.2, lit)) * ink * lit;
  col += TT_AMBER * lit * (glyph > 0 ? .1 : 0.) * (1. - pow(2. * f.x - 1., 2.)) * (1. - pow(2. * f.y - 1., 2.));
  // the panes' outlines
  float frame = ttFrame(g, vec2(split > 0 ? float(split) + .5 : .5, 1.), vec2(float(cols) - .5, float(mid)), cell);
  if (split > 0) frame = max(frame, ttFrame(g, vec2(.5, 1.), vec2(float(split) - .5, float(mid)), cell));
  frame = max(frame, ttFrame(g, vec2(.5, float(mid) + 1.), vec2(float(cols) - .5, float(rows) - 1.), cell));
  col += TT_AMBER * frame * .2;
  // the tube: a band of the picture being redrawn rolls down it, and it is dimmer toward its corners
  col *= 1. + .12 * exp(-abs(fract(uv.y + t * .07) - .5) * 14.);
  col *= .96 + .04 * sin(t * 47.);
  col *= 1. - .4 * pow(length(p * vec2(.8 / max(A, 1.) * 1.6, 1.)), 2.4);
  return col;
}
`),

  // Galaxy: a spiral seen at a tilt, turning slowly: a warm bulge, two blue
  // arms with dust along their inner edges and pink knots of new stars, its
  // own stars a fine glitter. The pointer tips it.
  galaxy: shader(`
/* Galaxy: a spiral seen at a tilt, turning slowly. A warm bulge of old
   stars, two blue arms winding out of it with dark dust along their inner
   edges and pink knots where stars are being born, its own stars resolved
   as a fine glitter, the rest of space behind. The pointer tips it a
   little, never far enough to show it edge on. */
vec3 theme(vec2 uv, vec2 p, float t) {
  float A = u_res.x / u_res.y;
  vec2 ptr = pointerP();
  float sc = min(u_scroll, 2.);
  // smaller on a narrow screen, and in the middle of it
  float size = mix(.6, 1., smoothstep(.5, 1.4, A)) * 1.5;
  vec2 c = vec2(A * .17 * smoothstep(.8, 1.3, A), .1 + sc * .14);
  // space behind: stars at three depths, a few warm ones, a little far gas
  vec2 sp = p + vec2(0., sc * .05) + ptr * .006;
  vec3 col = vec3(.005, .006, .014) + vec3(.02, .012, .04) * smoothstep(.4, .8, ifbm(sp * 1.4 + 4.));
  col += vec3(.8, .87, 1.) * (stars(sp, 34., .16, t) * .8 + stars(sp + 3.7, 70., .22, t) * .45);
  col += vec3(1., .82, .65) * stars(sp + 9.1, 17., .05, t) * .9;
  // the disc, laid flat: how far out, and which way round
  float tip = 1.02 + ptr.y * .07;
  vec2 q = rot(.42 - ptr.x * .06) * (p - c) / size;
  vec2 d = vec2(q.x, q.y / cos(tip));
  float r = length(d), th = atan(d.y, d.x);
  float turn = t * .012;
  vec2 rd = rot(turn) * d;
  // two arms winding out, bent a little by the gas they are made of
  float warp = ifbm(rd * 5.) - .5;
  float clump = ifbm(rd * 26. + 7.);
  float ph = 2. * (th + turn) - 5.4 * log(r + .002) + 1.2 * warp;
  float out_ = smoothstep(.03, .15, r);
  float wave = .5 + .5 * cos(ph);
  float arm = pow(wave, 2.4) * out_;
  // the young blue stars keep to a narrow lane down each arm
  float spine = pow(wave, 9.) * out_;
  float spur = pow(.5 + .5 * cos(ph * 2. + 1.3 + 3. * warp), 4.) * out_ * .28;
  float disc = exp(-r / .19) * smoothstep(.66, .3, r);
  // dust lies along the inside of each arm, in lanes and knots
  float lane = pow(.5 + .5 * cos(ph + .95 + 1.8 * (clump - .5)), 7.) * out_ * smoothstep(.55, .2, r);
  float dust = min(lane * smoothstep(.28, .6, ifbm(rd * 15. + 3.)) * 1.5, 1.);
  vec3 old = vec3(1., .78, .55), young = mix(vec3(.26, .5, 1.), vec3(.76, .86, 1.), clump);
  // fine grain, so the arms read as stars and not as cloud
  float grain = .6 + .8 * inoise(rd * 90.) * inoise(rd * 47. + 3.);
  vec3 light = old * disc * .2 + young * disc * (arm + spur) * (.7 + .55 * clump) * grain * 1.7;
  light += vec3(.7, .84, 1.) * disc * spine * (.5 + clump) * grain * 1.2;
  // where stars are being born
  light += vec3(1., .3, .5) * (smoothstep(.55, .85, inoise(rd * 22.)) * .45 + stars(rd + 4.3, 30., .4, t * .3) * 3.) * arm * disc * 1.8;
  light *= 1. - .9 * dust;
  light += vec3(.45, .2, .1) * dust * disc * .22;
  // its own stars, too many to tell apart except as a glitter
  light += mix(young, vec3(1.), .4) * (stars(rd, 95., .55, t) + stars(rd + 2.2, 170., .5, t) * .7) * disc * (.5 + 2.2 * arm) * 2.6;
  // it has depth: old stars in a thicker layer than the arms, and a ball of
  // them at the middle, which the dust on the near side crosses in front of
  vec2 thick = vec2(q.x, q.y / mix(cos(tip), 1., .32));
  light += old * exp(-length(thick) / .12) * .13;
  vec2 b = vec2(q.x, q.y / mix(cos(tip), 1., .62));
  float rb = length(b);
  float nearSide = smoothstep(.01, -.05, q.y);
  light += vec3(1., .86, .66) * (exp(-rb * rb / .0009) * 1.2 + exp(-rb / .04) * .6) * (1. - .75 * dust * nearSide);
  // a faint halo round it all
  light += vec3(.2, .26, .45) * exp(-r / .34) * .05;
  // the brightest parts ease off instead of burning out
  col += light * 1.2 / (1. + light * .4);
  col *= 1. - .3 * dot(p, p);
  return col;
}
`),
};

/* The custom theme editor's yardstick for cost (custom-theme-editor-gl.ts):
   Black hole exactly as it was when the limit was set, 2026-10-30. The live
   Black hole has since been made cheaper; timing against it would move the
   limit for every custom theme, so the yardstick keeps the old one. Never edit. */
export const COST_REFERENCE_SHADER = shader(`
const float BH_PI = 3.14159265, BH_TAU = 6.2831853;
const float BH_D = 55.;     // camera distance
const float BH_K = .72;     // ray angle (radians) per canvas height
const float BH_RIN = 6., BH_ROUT = 19.;
const float BH_TRACE = 23.; // impact parameter inside which rays are traced
// How much of the bend the starfield shows: all of it smears the stars into
// streaks half a screen away, as if the stars sat just behind the hole.
const float BH_SKYBEND = .4;

// The sky behind the hole: blue and rose nebula, richest near the hole so
// the lensing has something to bend, and stars, a few of them bright.
vec3 bhSky(vec2 q, vec2 c, float t) {
  vec3 col = vec3(.006, .004, .012);
  float n1 = fbm(q * 1.3 + vec2(t * .004, 0.));
  float n2 = fbm(q * 2.7 - 3.1 + vec2(0., t * .003));
  float near = .45 + 1.3 * exp(-length(q - c) * 1.7);
  col += (vec3(.03, .09, .22) * smoothstep(.42, .85, n1) + vec3(.2, .05, .14) * smoothstep(.48, .9, n2) * n1) * near;
  vec2 sq = q - vec2(0., u_scroll * .05);
  col += vec3(.85, .9, 1.) * stars(sq, 36., .14, t);
  col += vec3(.8, .85, 1.) * stars(sq + 2.3, 80., .2, t) * .5;
  col += mix(vec3(1., .85, .7), vec3(.7, .85, 1.), step(.5, hash(floor(sq * 12.)))) * stars(sq - 5.7, 12., .05, t) * 1.8;
  return col;
}

// Glow colour for a relative temperature: ember red, orange, gold, white, blue-white.
vec3 bhHeat(float T) {
  vec3 c = mix(vec3(.3, .025, .008), vec3(1., .3, .05), smoothstep(.12, .45, T));
  c = mix(c, vec3(1., .66, .3), smoothstep(.4, .72, T));
  c = mix(c, vec3(1., .92, .8), smoothstep(.68, 1., T));
  return mix(c, vec3(.8, .88, 1.), smoothstep(1., 1.45, T));
}

// Disk streaks around the ring, seamless where the angle wraps.
float bhStreak(float a, float lr, vec2 f) {
  float w = (BH_PI - a) / BH_TAU;
  return mix(fbm(vec2(a, lr) * f), fbm(vec2(a + BH_TAU, lr) * f), w);
}

// The disk where a ray crosses its plane: light (premultiplied) and cover.
vec4 bhDisk(vec3 hit, vec3 dir, float t) {
  float r = length(hit.xz);
  if (r < BH_RIN * .92 || r > BH_ROUT) return vec4(0.);
  float a = atan(hit.z, hit.x) - t * 3.2 * pow(r, -1.5);
  a = mod(a + BH_PI, BH_TAU) - BH_PI;
  float lr = log(r);
  float coarse = bhStreak(a, lr, vec2(2., 11.));
  float fine = bhStreak(a, lr, vec2(5., 38.));
  float dens = smoothstep(.2, .85, coarse * .75 + fine * .45);
  float lane = smoothstep(.56, .7, fine) * smoothstep(.4, .6, coarse);
  // hot knots riding the flow
  float knot = smoothstep(.68, .88, bhStreak(a, lr, vec2(8., 70.))) * smoothstep(.45, .7, coarse);
  // brightest a little outside the inner edge, falling off outward
  float x = BH_RIN / r;
  float prof = pow(x, 3.) * max(1. - sqrt(x), 0.) / .057 + .25 * smoothstep(BH_RIN * .92, BH_RIN, r) * smoothstep(BH_RIN * 1.4, BH_RIN, r);
  // orbital speed seen by a static observer, Doppler shift and the climb out
  float beta = min(1. / sqrt(max(r - 2., 1.)), .55);
  float cosT = dot(normalize(vec3(-hit.z, 0., hit.x)), -dir);
  float g = sqrt(1. - 2. / r) / (inversesqrt(1. - beta * beta) * (1. - beta * cosT));
  float T = .8 * pow(prof, .25) * mix(1., g, .85);
  float beam = mix(1., g * g * g, .8);
  float edge = smoothstep(BH_ROUT, BH_ROUT - 6., r) * smoothstep(BH_RIN * .92, BH_RIN * 1.05, r);
  vec3 light = bhHeat(T + .25 * knot) * prof * beam * (.45 + 1.1 * dens + 1.6 * knot) * (1. - .7 * lane) * 2.;
  float cover = clamp(.4 + dens * .7 - lane * .3, 0., .97) * edge;
  return vec4(light * cover, cover);
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  // right of centre with the whole disk on screen, centred on a narrow one
  vec2 c = vec2(max(min(aspect * .2, aspect * .5 - .5), 0.), .24 + u_scroll);
  // the pointer turns the view a few degrees around the hole
  vec2 pp = pointerP();
  float incl = .1 + pp.y * .07;
  float yaw = pp.x * .08;
  float roll = -.2;
  vec2 q = rot(roll) * (p - c);
  float qLen = length(q);
  vec2 qDir = q / max(qLen, 1e-5);
  float b = qLen * BH_D * BH_K; // impact parameter
  // weak-field bend toward the hole, for a camera at BH_D
  float bb = max(b, 1.);
  float bend = (4. / bb + 11.8 / (bb * bb)) * .5 * (1. + BH_D / sqrt(BH_D * BH_D + bb * bb));
  vec2 bg = q - qDir * min(bend, 1.5) * BH_SKYBEND / BH_K;
  vec3 disk = vec3(0.);
  float cover = 0.;
  float dark = 0.;
  vec3 haze = vec3(0.);
  if (b < BH_TRACE) {
    vec3 cam = BH_D * vec3(sin(yaw) * cos(incl), sin(incl), -cos(yaw) * cos(incl));
    vec3 fwd = -cam / BH_D;
    vec3 right = normalize(cross(vec3(0., 1., 0.), fwd));
    vec3 up = cross(fwd, right);
    float a0 = qLen * BH_K;
    vec3 dir = fwd * cos(a0) + (qDir.x * right + qDir.y * up) * sin(a0);
    // straight in to r = 30, where the bending starts to matter
    vec3 pos = cam;
    float along = -dot(pos, dir);
    vec3 near = pos + dir * along;
    pos = near - dir * sqrt(max(900. - dot(near, near), 0.));
    vec3 hv = cross(pos, dir);
    float h2 = dot(hv, hv);
    bool out_ = false;
    for (int i = 0; i < 180; i++) {
      float r = length(pos);
      float dt = clamp(.07 * r, .04, 2.) * mix(.4, 1., smoothstep(2.6, 5., r));
      vec3 prev = pos;
      // the light's path in Schwarzschild space, as a force in flat space:
      // a = -3 M h^2 x / r^5 (M = 1), stepped leapfrog
      dir -= 3. * h2 * pos / pow(r, 5.) * dt * .5;
      pos += dir * dt;
      r = length(pos);
      dir -= 3. * h2 * pos / pow(r, 5.) * dt * .5;
      if (prev.y * pos.y < 0.) {
        vec4 d = bhDisk(mix(prev, pos, prev.y / (prev.y - pos.y)), normalize(dir), t);
        disk += (1. - cover) * d.rgb;
        cover += (1. - cover) * d.a;
      }
      // a thin warm haze hugging the disk, so it has some depth
      haze += (1. - cover) * vec3(1., .48, .18) * exp(-pos.y * pos.y * .9) * smoothstep(21., 8., r) * smoothstep(4.5, 7.5, r) * dt * .016;
      if (r < 2.02 || cover > .985) break;
      if (r > 31. && dot(pos, dir) > 0.) { out_ = true; break; }
    }
    if (!out_) dark = 1.;
    // haze on a ray that falls in would fog the shadow
    if (out_) disk += haze;
    // where the ray left for, in the same screen units
    vec3 v = normalize(dir);
    vec2 side = vec2(dot(v, right), dot(v, up));
    vec2 traced = side / max(length(side), 1e-5) * atan(length(side), dot(v, fwd)) / BH_K;
    bg = mix(q + (traced - q) * BH_SKYBEND, bg, smoothstep(BH_TRACE - 6., BH_TRACE - .5, b));
  }
  vec3 col = bhSky(rot(-roll) * bg + c, c, t) * (1. - dark) * (1. - cover) + disk;
  // the photon ring: light that circled the hole before escaping piles up
  // just outside the shadow (b = 3 sqrt 3)
  col += vec3(1., .8, .55) * exp(-abs(b - 5.25) * 5.) * .5 * (1. - cover);
  // light spilling off the disk: a halo round the shadow and a flare along
  // the disk's plane, stronger on the side coming at us (left)
  col += vec3(1., .5, .2) * exp(-max(b - 5.2, 0.) * .18) * smoothstep(4.6, 5.3, b) * .09 * (1. - cover);
  vec2 qd = vec2(q.x, (q.y + .012) / max(sin(incl) + .06, .06)) * BH_D * BH_K;
  float flare = exp(-abs(qd.y) * .09) * exp(-abs(qd.x) * .08) * (1. - .45 * clamp(q.x * 6., -1., 1.));
  col += vec3(1., .55, .25) * flare * .1 * (1. - cover);
  // jets: thin blue plasma flowing out along the spin axis, both ways, behind
  // the disk where it crosses them
  float ay = abs(q.y);
  float jw = .008 + .045 * ay;
  float jflow = .45 + .9 * noise(vec2(q.x / jw * 1.5 + sign(q.y) * 7., ay * 9. - t * 2.2));
  float jet = exp(-q.x * q.x / (jw * jw)) * smoothstep(.1, .2, ay) * exp(-ay * 2.6) * jflow;
  col += vec3(.5, .72, 1.) * jet * .3 * (1. - cover) * (1. - dark * step(q.y, 0.));
  return 1. - exp(-col * 1.25);
}`);
