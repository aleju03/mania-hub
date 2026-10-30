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
  // Aurora: curtains of green and violet light over a starry night, swaying,
  // rising off as the page scrolls; they gather toward the pointer.
  aurora: shader(`
vec3 theme(vec2 uv, vec2 p, float t) {
  float sc = min(u_scroll, 3.);
  vec3 col = mix(vec3(.004, .012, .03), vec3(.012, .04, .065), smoothstep(-.5, .6, p.y));
  vec2 sp = p - vec2(0., sc * .12);
  col += vec3(.75, .85, 1.) * stars(sp, 30., .14, t) * .9;
  col += vec3(.75, .85, 1.) * stars(sp + 3.1, 64., .2, t) * .5;
  vec3 glow = vec3(0.);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float x = p.x * (1.1 + fi * .25) + fi * 1.7;
    float foot = .06 + fi * .11 + .1 * sin(x * 1.6 + t * .12 + fi) + .14 * (fbm(vec2(x * 1.2 + t * .04, fi * 3.1)) - .5);
    foot += sc * .22;
    float d = p.y - foot;
    // folds of light: broad swells with fine streaks running up through them
    float rays = .25 + .75 * fbm(vec2(x * 7. + t * .22, fi * 5. + t * .05));
    rays *= .55 + .45 * noise(vec2(x * 38. + fi * 11., t * .4));
    float curtain = smoothstep(-.012, .02, d) * exp(-max(d, 0.) * (3.6 - fi * .7)) * rays * 1.35;
    vec3 tint = mix(vec3(.12, 1., .6), vec3(.6, .32, 1.), clamp(smoothstep(0., .4, d) + fi * .2, 0., 1.));
    glow += tint * curtain * (.5 - fi * .11);
  }
  col += glow * (1. + .5 * exp(-length(p - pointerP()) * 3.));
  col += vec3(.015, .05, .06) * smoothstep(.0, -.5, p.y);
  return col;
}`),

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
  // the grid, worked out for every pixel so its derivatives hold at the horizon
  float dy = max(hz - p.y, 1e-3);
  float z = .3 / dy;
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

  // Inferno: a field of cooled black lava running to the horizon, its cracks
  // glowing orange and breathing hotter and cooler, the far ground lost in a
  // red haze under a smoky sky; embers drift up out of it at three depths. The
  // cracks run hotter under the pointer, and the field slides toward the view
  // as the page scrolls.
  inferno: shader(`
/* Embers at three depths drifting up and swaying, each a hot point with a soft halo, dying as they climb. */
vec3 embers(vec2 uv, vec2 p, float t, float sc) {
  vec3 acc = vec3(0.);
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float s = 5. + fl * 6.;
    vec2 e = p * s;
    e.y -= t * (.35 + fl * .25) + sc * s * .3;
    e.x += sin(e.y * .6 + t * .8 + fl * 2.) * .35 + (noise(vec2(e.y * .3, fl * 3.)) - .5) * .8;
    vec2 id = floor(e);
    vec2 c = fract(e) - .5;
    float hh = hash(id + fl * 13.);
    if (hh < .8) continue;
    vec2 o = c - (vec2(hash(id + 1.), hash(id + 2.)) - .5) * .6;
    float d = length(o);
    float r = max(.03, PX * s * 1.6);
    float core = smoothstep(r, 0., d);
    float halo = exp(-d * d / (r * r * 14.)) * .35;
    float flick = .6 + .4 * sin(t * (3. + hash(id + 4.) * 4.) + hh * 30.);
    float fade = smoothstep(1., .05, uv.y);
    vec3 ec = mix(vec3(1., .42, .08), vec3(1., .82, .45), hash(id + 6.));
    acc += ec * (core + halo) * flick * fade * (.45 + fl * .25);
  }
  return acc;
}
vec3 theme(vec2 uv, vec2 p, float t) {
  float sc = u_scroll;
  vec3 col = mix(vec3(.14, .03, .015), vec3(.015, .006, .008), smoothstep(-.25, .5, p.y));
  float horizon = -.16;
  vec2 q = vec2(p.x * 1.3, p.y * 1.4 - t * .05 - sc * .3);
  float smoke = fbm(q * 1.4 + vec2(fbm(q + t * .03), fbm(q + 3.1)) * 1.4);
  col = mix(col, vec3(.01, .004, .005), smoothstep(.5, .85, smoke) * .5);
  if (p.y < horizon) {
    float d = horizon - p.y;
    // the ground plane: x spreads and depth shrinks toward the horizon
    vec2 g = vec2(p.x / d, 1. / d) * .3;
    g.y += t * .04 + sc * .5;
    float e = voronoiEdge(g * 1.1);
    float e2 = voronoiEdge(g * 2.9 + 4.);
    float heat = .55 + .45 * sin(t * .8 + fbm(g * .7) * 6.);
    heat += .6 * exp(-length(p - pointerP()) * 5.);
    float seam = smoothstep(.08, 0., e) * heat + smoothstep(.04, 0., e2) * .3 * heat;
    vec3 rock = vec3(.035, .018, .016) * (.5 + fbm(g * 4.) * .9);
    vec3 lava = mix(vec3(.85, .16, .03), vec3(1., .72, .28), clamp(seam * seam, 0., 1.));
    vec3 ground = rock + lava * seam * 1.3;
    float fog = exp(-d * 5.);
    col = mix(ground, col + vec3(.45, .1, .02) * .5, fog * .9);
  }
  col += vec3(.85, .24, .04) * exp(-abs(p.y - horizon) * 10.) * .35;
  return col + embers(uv, p, t, sc) * .8;
}`),

  // Frost: snow falling in three layers, ice crystals growing in from the
  // edges, glinting; the frost melts back around the pointer.
  frost: shader(`
vec3 theme(vec2 uv, vec2 p, float t) {
  float sc = u_scroll;
  vec3 col = mix(vec3(.022, .035, .055), vec3(.065, .095, .13), smoothstep(-.5, .5, p.y));
  col += vec3(.08, .13, .18) * exp(-length(p - vec2(-.25, .65)) * 1.6);
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float s = 26. - fl * 6.;
    vec2 q = p * s;
    q.y += t * (.5 + fl * .25) - sc * s * (.15 + fl * .1);
    q.x += sin(t * .6 + q.y * .3 + fl * 2.) * .5;
    vec2 id = floor(q);
    vec2 f = fract(q) - .5;
    float h = hash(id + fl * 23.);
    if (h < .66) continue;
    float d = length(f - (vec2(hash(id + 1.), hash(id + 2.)) - .5) * .6);
    float r = .035 + .035 * hash(id + 3.);
    float blur = PX * s * 1.5 + fl * .015;
    col += vec3(.8, .9, 1.) * smoothstep(r + blur, r - blur * .3, d) * (.3 + fl * .2);
  }
  vec2 e = abs(uv - .5) * 2.;
  float edge = pow(e.x, 4.) + pow(e.y, 4.);
  vec2 fp = p + .05 * vec2(fbm(p * 5.), fbm(p * 5. + 3.));
  float crystals = (1. - smoothstep(0., .05, voronoiEdge(fp * 8.))) * .7 + (1. - smoothstep(0., .04, voronoiEdge(fp * 19. + 4.))) * .45;
  float mask = smoothstep(.25, 1., edge + .35 * (fbm(p * 3.5) - .5));
  mask *= smoothstep(.04, .3, length(p - pointerP()));
  col += vec3(.5, .72, .88) * (crystals * .45 + .08) * mask;
  col += vec3(.9, .97, 1.) * stars(p, 55., .12, t * 2.) * mask * 1.2;
  return col;
}`),

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
            if (abs(off) < abs(headAt)) headAt = off;
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

  // Golden hour: a low sun over distant hills, banded clouds lit from below,
  // warm dust drifting; the evening deepens as the page scrolls.
  sunset: shader(`
vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  // the horizon sits along the foot of the hero and scrolls away with it
  float H = .15 + min(u_scroll, 1.5);
  float y = p.y - H;
  vec3 col = mix(vec3(1., .48, .16), vec3(.78, .2, .36), smoothstep(0., .16, y));
  col = mix(col, vec3(.3, .08, .3), smoothstep(.1, .3, y));
  col = mix(col, vec3(.07, .03, .16), smoothstep(.26, .55, y));
  vec2 sp = vec2(aspect * .27, H + .06);
  float d = length(p - sp);
  col += vec3(1., .55, .25) * exp(-d * 5.) * .55;
  col = mix(col, vec3(1., .86, .55), smoothstep(.08 + PX * 2., .08 - PX * 2., d));
  float band = fbm(vec2(p.x * 1.3 + t * .015, y * 7.));
  float clouds = smoothstep(.5, .78, band) * smoothstep(.02, .08, y) * smoothstep(.45, .12, y);
  vec3 lit = mix(vec3(.42, .12, .28), vec3(1., .62, .42), exp(-length(p - sp) * 2.2) * 1.2);
  col = mix(col, lit, clouds * .75);
  float ridge = H + .025 + .05 * (fbm(vec2(p.x * 2.5, 1.)) - .5) + .015 * sin(p.x * 5.);
  vec3 ground = mix(vec3(.12, .035, .07), vec3(.035, .012, .03), smoothstep(0., .4, ridge - p.y));
  col = mix(col, ground, smoothstep(ridge + PX * 2., ridge - PX * 2., p.y));
  col += vec3(1., .75, .45) * stars(p + vec2(-t * .01, t * .006), 34., .1, t * .7) * .45;
  return col * .7;
}`),

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

  // Koi pond: real-looking koi gliding round the pond under the surface,
  // drawn in the shader so every part moves on its own: the body bends
  // through each turn and ripples back to a tail that beats in step with how
  // far the fish has swum, the pectoral fins open and close, the tail fin
  // fans. Each fish is shaded round (light along the back, darker flanks, a
  // wet sheen on the ridge) and wears its variety's markings: kohaku, sanke,
  // tancho, ogon or showa. Shadows fall on the floor below. The surface
  // bends the floor, its stones and caustics and the koi under it, and
  // catches the moon in glints; now and then a ripple spreads across it.
  // Lily pads and lotus (koi-pads.png) float on top, rocking as it passes.
  koi: shader(`
uniform sampler2D u_sprite;

const int KOI = 9;

/* Where koi i is on its loop at angle a, and how that changes (first and second derivative). */
void koiLoop(int i, float a, vec2 home, out vec2 c, out vec2 v, out vec2 acc) {
  float fi = float(i);
  float aspect = u_res.x / u_res.y;
  vec2 rad = vec2(aspect * (.12 + .16 * hash(vec2(fi, 1.))), .1 + .14 * hash(vec2(fi, 2.)));
  float ph = fi * 1.7, w1 = 2.3 + fi * .3, w2 = 1.7 + fi * .2;
  c = home + vec2(rad.x * cos(a) + .03 * sin(w1 * a + ph), rad.y * sin(a) + .025 * sin(w2 * a + ph));
  v = vec2(-rad.x * sin(a) + .03 * w1 * cos(w1 * a + ph), rad.y * cos(a) + .025 * w2 * cos(w2 * a + ph));
  acc = vec2(-rad.x * cos(a) - .03 * w1 * w1 * sin(w1 * a + ph), -rad.y * sin(a) - .025 * w2 * w2 * sin(w2 * a + ph));
}

/* Where koi i's head is at time t. */
vec2 koiHead(int i, float t) {
  float fi = float(i);
  float aspect = u_res.x / u_res.y;
  vec2 home = vec2((hash(vec2(fi, 3.)) - .5) * aspect * .7, (hash(vec2(fi, 4.)) - .5) * .5);
  float dirSign = hash(vec2(fi, 5.)) > .5 ? 1. : -1.;
  float a = dirSign * (t * (.13 + .06 * hash(vec2(fi, 6.))) + .25 * sin(t * (.35 + .2 * hash(vec2(fi, 11.))) + fi * 3.) + fi * 2.4);
  vec2 c, v, acc;
  koiLoop(i, a, home, c, v, acc);
  return c;
}

/* Koi i at point q: rgb and coverage (fins partly see-through). With shadow set, only a soft
   coverage of the body for its shadow on the floor. */
vec4 koi(int i, vec2 q, float t, bool shadow) {
  float fi = float(i);
  float aspect = u_res.x / u_res.y;
  float len = .085 + .035 * hash(vec2(fi, 7.));
  vec2 home = vec2((hash(vec2(fi, 3.)) - .5) * aspect * .7, (hash(vec2(fi, 4.)) - .5) * .5);
  float dirSign = hash(vec2(fi, 5.)) > .5 ? 1. : -1.;
  // it glides, then puts on a little speed, then glides again
  float a = dirSign * (t * (.13 + .06 * hash(vec2(fi, 6.))) + .25 * sin(t * (.35 + .2 * hash(vec2(fi, 11.))) + fi * 3.) + fi * 2.4);
  vec2 c, v, acc;
  koiLoop(i, a, home, c, v, acc);
  v *= dirSign;
  vec2 d = q - c;
  if (dot(d, d) > len * len * 1.6) return vec4(0.);
  float speed = max(length(v), 1e-4);
  vec2 dir = v / speed, n = vec2(-dir.y, dir.x);
  float along = -dot(d, dir), side = dot(d, n);
  float u = along / len;
  if (u < -.02 || u > 1.17) return vec4(0.);
  // the spine: bent round the turn, and a wave running back to the tail, its beats tied to the
  // distance swum so a gliding fish barely moves its tail
  float kappa = clamp((v.x * acc.y - v.y * acc.x) / (speed * speed * speed), -.9 / len, .9 / len);
  float beat = a * dirSign * 16. + fi * 5.;
  float spine = kappa * along * max(along, 0.) * .5 + len * (.004 + .075 * u * u) * sin(beat - u * 5.5);
  float x = side - spine;
  // the body's outline: a rounded head, widest a quarter of the way back, then a long taper
  float W = len * .175;
  float fa = clamp(u / .26, 0., 1.);
  float wid = W * sqrt(max(0., 1. - (1. - fa) * (1. - fa))) * (1. - .8 * smoothstep(.3, .88, u));
  float aa = PX * 1.2;
  float body = u > 0. && u < .9 ? smoothstep(aa, -aa, abs(x) - wid) : 0.;
  if (shadow) return vec4(0., 0., 0., smoothstep(len * .05, -len * .03, abs(x) - wid) * step(0., u) * step(u, .9) * .5);
  float variety = floor(hash(vec2(fi, 9.)) * 4.99);
  float seed = fi * 7.31;
  vec3 col = vec3(0.);
  float cover = 0.;
  // fins first, under the body: pale, half see-through, fine rays
  vec3 finCol = variety == 3. ? vec3(.95, .74, .36) : variety == 4. ? vec3(.3, .28, .3) : vec3(.92, .9, .86);
  // the tail fin: two lobes fanning out behind, a notch between them
  if (u > .8 && u < 1.16) {
    float fw = len * (.022 + .27 * smoothstep(.8, 1.1, u));
    float notch = u > 1.01 ? (u - 1.01) * 1.4 * len : -1.;
    float tf = smoothstep(aa, -aa, abs(x) - fw) * (1. - smoothstep(-aa, aa, notch - abs(x))) * (1. - smoothstep(1.11, 1.16, u));
    float rays = .9 + .1 * sin(x / len * 70.);
    tf *= 1. - .5 * smoothstep(.98, 1.14, u);
    col = mix(col, finCol * rays, tf); cover = max(cover, tf * .5);
  }
  // the pectoral fins: either side just behind the head, opening and closing
  float flap = .5 + .5 * sin(t * (2.2 + hash(vec2(fi, 12.))) + fi * 2.);
  for (int s = 0; s < 2; s++) {
    float sgn = s == 0 ? 1. : -1.;
    float u0 = .21;
    float w0 = W * sqrt(max(0., 1. - (1. - clamp(u0 / .26, 0., 1.)) * (1. - clamp(u0 / .26, 0., 1.))));
    vec2 base = vec2(u0 * len, sgn * w0 * .8);
    float ang = radians(30. + 40. * flap);
    vec2 e1 = vec2(cos(ang), sgn * sin(ang));
    vec2 p = vec2(along, x) - base;
    float lf = len * .2, wf = len * .068;
    vec2 pe = vec2(dot(p, e1), dot(p, vec2(-e1.y, e1.x)));
    float inFin = smoothstep(1.02, .96, length(vec2((pe.x - lf * .5) / (lf * .5), pe.y / wf))) * step(0., pe.x);
    float rays = .9 + .1 * sin(pe.y / wf * 8.);
    inFin *= 1. - .45 * smoothstep(lf * .55, lf, pe.x);
    col = mix(col, finCol * rays, inFin); cover = max(cover, inFin * .5);
  }
  if (body > 0.) {
    float xn = clamp(x / max(wid, 1e-5), -1., 1.);
    // its markings, fixed to the body so they bend with it
    vec2 bp = vec2(u * 5.5 + seed, xn * 1.5 + seed);
    float markings = fbm(bp) + .12 * (1. - smoothstep(.08, .24, u));
    float red = smoothstep(.5, .53, markings) * smoothstep(.04, .09, u) * (1. - smoothstep(.7, .8, u));
    float sumi = smoothstep(.74, .77, noise(vec2(u * 16. + seed, xn * 3.5)));
    vec3 white = vec3(.96, .93, .87), scarlet = vec3(.82, .2, .1), ink = vec3(.09, .08, .085);
    vec3 skin = white;
    if (variety == 0.) skin = mix(white, scarlet, red);
    else if (variety == 1.) skin = mix(mix(white, scarlet, red), ink, sumi * smoothstep(.15, .3, u) * (1. - smoothstep(.75, .82, u)));
    else if (variety == 2.) skin = mix(white, scarlet, smoothstep(.042 * len, .036 * len, length(vec2((u - .11) * len, x))));
    else if (variety == 3.) skin = mix(vec3(.86, .6, .2), vec3(1., .86, .46), .5 + .5 * xn * 0.);
    else skin = mix(mix(ink, scarlet, red), white, smoothstep(.6, .63, fbm(bp * 1.3 + 9.)) * .9);
    // scales: a faint net, more on the back than the flanks
    vec2 sc = vec2(along / len * 60., x / len * 60.);
    float net = abs(fract(sc.x + sc.y * .55) - .5) + abs(fract(sc.x - sc.y * .55) - .5);
    skin *= 1. - .07 * smoothstep(.62, .82, net) * (1. - abs(xn));
    // shaded round: light down the back, darker flanks, a wet sheen along the ridge
    float round = sqrt(1. - xn * xn);
    float lit = .48 + .52 * round + .12 * xn * dot(n, normalize(vec2(-.5, .8)));
    skin *= lit;
    skin += (variety == 3. ? .4 : .22) * exp(-xn * xn * 20.) * (1. - u) * vec3(1., .98, .94);
    // the dorsal fin, a thin dark ridge down the middle of the back
    skin *= 1. - .25 * smoothstep(.12, 0., abs(xn)) * smoothstep(.3, .36, u) * (1. - smoothstep(.62, .7, u));
    // eyes, set at the sides of the head
    skin = mix(skin, vec3(.05), smoothstep(.016 * len, .01 * len, length(vec2((u - .075) * len, abs(x) - wid * .62))));
    col = mix(col, skin, body); cover = max(cover, body);
  }
  return vec4(col, cover);
}

vec4 padSample(float cell, vec2 c) {
  vec2 at = vec2(mod(cell, 4.), floor(cell / 4.));
  return texture(u_sprite, vec2((at.x + c.x) / 4., (at.y + 1. - c.y) / 2.));
}

/* Light focused by the surface onto the floor: soft, wandering bright
   threads. 0..1. */
float pondCaustic(vec2 uv, float time) {
  vec2 p = uv * 6.28318 - 250.;
  vec2 i = p;
  float c = 1.;
  for (int n = 0; n < 3; n++) {
    float tt = time * (1. - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1. / length(vec2(p.x / (sin(i.x + tt) / .005), p.y / (cos(i.y + tt) / .005)));
  }
  c /= 3.;
  c = 1.17 - pow(c, 1.4);
  return clamp(pow(abs(c), 7.), 0., 1.);
}

/* The surface's slope at w: a few long slow swells, and the ripples a koi
   leaves when it comes up, each a short train of waves spreading and dying
   away. Ripple i of 3 is at ring[i] (centre, radius, strength). */
vec2 pondSlope(vec2 w, float t, vec4 ring[3]) {
  vec2 g = vec2(.8, .3) * cos(dot(w, vec2(.8, .3)) * 9. + t * .6) * .09;
  g += vec2(-.4, .9) * cos(dot(w, vec2(-.4, .9)) * 14. - t * .75) * .07;
  g += vec2(.6, -.7) * cos(dot(w, vec2(.6, -.7)) * 23. + t * 1.1) * .05;
  for (int r = 0; r < 3; r++) {
    vec2 dl = (w - ring[r].xy) * vec2(1., 1.25);
    float d = length(dl), x = d - ring[r].z;
    float env = exp(-x * x * 900.) * ring[r].w;
    g += dl / max(d, 1e-4) * cos(x * 120.) * env * 1.6;
  }
  return g;
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  // the pond floor and surface scroll by; the koi stay in view
  vec2 w = p + vec2(0., u_scroll * .35);
  // now and then a koi comes up to the surface, and a ring spreads from
  // where its head broke it; the ring stays where it started as the fish
  // swims on
  vec4 ring[3];
  // which koi broke the surface (and when), and which will next (and in how long)
  int riser[3], nextRiser[3];
  float riseAge[3];
  for (int r = 0; r < 3; r++) {
    float fr = float(r);
    float cyc = t / 4.5 + fr * .37;
    float id = floor(cyc), age = fract(cyc);
    int k = int(hash(vec2(id, fr + 2.)) * float(KOI)) % KOI;
    vec2 at = koiHead(k, (id - fr * .37) * 4.5) + vec2(0., u_scroll * .35);
    ring[r] = vec4(at, .03 + age * .19, pow(1. - age, 1.6) * smoothstep(0., .12, age));
    riser[r] = k;
    nextRiser[r] = int(hash(vec2(id + 1., fr + 2.)) * float(KOI)) % KOI;
    riseAge[r] = age * 4.5;
  }
  vec2 g = pondSlope(w, t, ring);
  // everything under the surface is seen bent by it
  vec2 fw = w - g * .035;
  // the floor: deep hollows and shallow banks, smooth stones lying in the shallows
  float deep = smoothstep(.36, .66, fbm(fw * .9 + 3.));
  vec3 col = mix(vec3(.045, .135, .12), vec3(.012, .045, .055), deep);
  vec2 sq = fw * 13.;
  vec2 sid = floor(sq);
  vec2 sf = fract(sq) - .5 - (vec2(hash(sid + 1.), hash(sid + 2.)) - .5) * .4;
  float sr = .2 + .16 * hash(sid + 3.);
  float stone = smoothstep(sr, sr - .07, length(sf * vec2(1., 1.3))) * step(.45, hash(sid)) * (1. - deep);
  vec3 stoneCol = mix(vec3(.1, .14, .12), vec3(.17, .18, .14), hash(sid + 4.)) * (.7 + .6 * smoothstep(.1, -.2, sf.x + sf.y));
  col = mix(col, stoneCol, stone * .9);
  // caustics: the surface's light gathered into soft wandering threads, brightest in the shallows
  float caustic = pondCaustic(fw * .55, t * .22 + 31.);
  col += vec3(.2, .52, .46) * caustic * (.09 + .2 * (1. - deep));
  vec3 water = col;
  // shadows on the floor first, then the koi
  vec2 kp = p - g * .03;
  for (int i = 0; i < KOI; i++) col *= 1. - koi(i, kp - vec2(.014, -.02), t, true).a;
  for (int i = 0; i < KOI; i++) {
    vec4 k = koi(i, kp, t, false);
    if (k.a <= 0.) continue;
    // seen through the water: a cool tint, deeper ones more so, the surface light playing on them
    float depth = .12 + .3 * hash(vec2(float(i), 10.));
    // the one coming up rises to just under the surface and sinks back
    float shallow = 0.;
    for (int r = 0; r < 3; r++) {
      if (nextRiser[r] == i) shallow = max(shallow, smoothstep(1.2, 0., 4.5 - riseAge[r]));
      if (riser[r] == i) shallow = max(shallow, smoothstep(1.4, .2, riseAge[r]));
    }
    depth *= 1. - .85 * shallow;
    vec3 fish = mix(k.rgb * vec3(.86, .95, .95), water * 1.5 + vec3(0., .03, .04), depth);
    fish *= 1. + caustic * .3;
    col = mix(col, fish, k.a);
  }
  // the surface, lit from the upper left: each swell and ripple bright on the
  // side tilted toward the light and dim on the far side, so the rings read
  // as raised crests, and crisp sparks where a slope catches it squarely
  vec2 lightDir = normalize(vec2(-.35, .55));
  float tilt = clamp(dot(g, lightDir), -.6, .6);
  col += vec3(.1, .22, .23) * max(tilt, 0.) * 1.2;
  col *= 1. - .9 * max(-tilt, 0.);
  float spark = smoothstep(.15, .2, tilt) * smoothstep(.55, .75, noise(w * 34. + t * .4));
  col += vec3(.72, .9, .92) * spark * .45;
  // moonlight lying on the water, a soft column broken up by the swells
  vec2 mq = w - vec2(aspect * .3, .25 + u_scroll * .35) + g * .6;
  float moon = exp(-mq.x * mq.x * 60.) * exp(-mq.y * mq.y * 3.);
  col += vec3(.4, .55, .58) * moon * (.06 + .5 * smoothstep(.08, .16, tilt));
  // lily pads on the surface, over the water and its ripples, some with a lotus
  // open on them, each casting a faint shadow; a passing ripple rocks them.
  // The art is pale, so the night pond darkens it.
  vec2 lq = w * 5. + vec2(t * .02, 0.);
  vec2 lid = floor(lq);
  if (hash(lid + 7.) > .78) {
    vec2 centre = (lid + .5 + (vec2(hash(lid + 1.), hash(lid + 2.)) - .5) * .16 - vec2(t * .02, 0.)) / 5.;
    vec2 bob = pondSlope(centre, t, ring);
    vec2 ld = fract(lq) - .5 - (vec2(hash(lid + 1.), hash(lid + 2.)) - .5) * .16 + bob * .06;
    ld = rot(t * .04 + hash(lid) * 6.28 + bob.x * .3) * ld;
    float sz = .26 + .1 * hash(lid + 3.);
    float pick = floor(hash(lid + 4.) * 5.99);
    vec2 sc = (ld - vec2(.03, -.04)) / sz * .5 + .5;
    if (sc.x > 0. && sc.x < 1. && sc.y > 0. && sc.y < 1.) col *= 1. - padSample(pick, sc).a * .35;
    vec2 c = ld / sz * .5 + .5;
    if (c.x > 0. && c.x < 1. && c.y > 0. && c.y < 1.) {
      vec4 k = padSample(pick, c);
      col = mix(col, k.rgb / max(k.a, 1e-3) * vec3(.42, .5, .44), k.a * .97);
    }
    if (hash(lid + 5.) > .62) {
      vec2 bc = (ld - (vec2(hash(lid + 8.), hash(lid + 9.)) - .5) * sz * .7) / (sz * .42) * .5 + .5;
      if (bc.x > 0. && bc.x < 1. && bc.y > 0. && bc.y < 1.) {
        vec4 k = padSample(6. + step(.5, hash(lid + 6.)), bc);
        col = mix(col, k.rgb / max(k.a, 1e-3) * .8, k.a);
      }
    }
  }
  col *= 1. - .35 * dot(p, p);
  return col;
}`),

  // Hanabi: a summer festival night, lanterns strung across the top of the
  // hero and fireworks bursting over it.
  hanabi: shader(`
uniform sampler2D u_sprite;

vec3 burstColour(float h) {
  vec3 palette[6] = vec3[6](vec3(1., .3, .35), vec3(1., .78, .3), vec3(.35, .85, 1.), vec3(1., .45, .85), vec3(.45, 1., .55), vec3(1., .95, .9));
  return palette[int(h * 5.99)];
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  vec2 q = vec2(p.x, p.y - u_scroll);
  vec3 col = mix(vec3(.008, .008, .03), vec3(.04, .03, .1), smoothstep(-.5, .55, p.y));
  col += vec3(.8, .85, 1.) * stars(p - vec2(0., u_scroll * .1), 40., .1, t) * .5;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float cycle = (t + fk * 1.1) / 3.3;
    float id = floor(cycle) * 3. + fk;
    float a = fract(cycle) * 3.3;
    vec2 B = vec2((hash(vec2(id, 1.)) - .5) * aspect * .85, .22 + .2 * hash(vec2(id, 2.)));
    vec3 c = burstColour(hash(vec2(id, 3.)));
    if (a < .7) {
      // the shell climbing
      vec2 pos = mix(vec2(B.x + .05, -.1), B, 1. - pow(1. - a / .7, 2.));
      float d = length(q - pos);
      col += vec3(1., .85, .6) * exp(-d / max(PX * 1.5, .0015)) * .8;
      continue;
    }
    float age = a - .7;
    float fade = exp(-age * 1.3);
    col += c * exp(-length(q - B) * 2.5) * exp(-age * 3.5) * .25;
    if (length(q - B) > .6) continue;
    float v = .3 + .1 * hash(vec2(id, 4.));
    for (int i = 0; i < 28; i++) {
      float fi = float(i);
      float ang = fi / 28. * 6.2832 + hash(vec2(id, fi)) * .2;
      vec2 dir = vec2(cos(ang), sin(ang)) * (.85 + .3 * hash(vec2(fi, id)));
      float reach = v * (1. - exp(-age * 2.8)) / 2.8 * 2.;
      vec2 head = B + dir * reach - vec2(0., .035 * age * age);
      float reachBefore = v * (1. - exp(-max(age - .15, 0.) * 2.8)) / 2.8 * 2.;
      vec2 tail = B + dir * reachBefore - vec2(0., .035 * max(age - .15, 0.) * max(age - .15, 0.));
      vec2 pa = q - tail, ba = head - tail;
      float hseg = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0., 1.);
      float d = length(pa - ba * hseg);
      float flicker = age > 1.2 ? step(.4, hash(vec2(fi, floor(t * 20.)))) : 1.;
      float w = max(PX * 1.4, .0014);
      col += c * (exp(-d / w) * 1.6 + exp(-d / (w * 5.)) * .35) * fade * (.25 + .75 * hseg) * flicker;
    }
  }
  // paper lanterns (the sprite, 256x400, cord loop at the top middle) hung
  // from a sagging rope across the top of the hero, each swaying from its
  // hook, tinted red or orange, its candle flickering
  float halfW = aspect * .5;
  float ropeY = .46 - .03 * (1. - pow(q.x / halfW, 2.));
  col += vec3(.25, .12, .08) * smoothstep(PX * 2., 0., abs(q.y - ropeY)) * .5;
  float spacing = .17;
  float li = floor(q.x / spacing + .5);
  float lx = li * spacing;
  vec2 hook = vec2(lx, .46 - .03 * (1. - pow(lx / halfW, 2.)) + .004);
  float H = .12, W = H * .64;
  vec2 ld = rot(sin(t * 1.3 + li) * .08) * (q - hook);
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
    float d = length(q - centre);
    vec3 gWarm = hash(vec2(lk, 5.)) > .5 ? vec3(1., .34, .16) : vec3(1., .62, .24);
    float gFlicker = .88 + .08 * sin(t * 2. + lk) + .04 * sin(t * 9.3 + lk * 3.);
    col += gWarm * exp(-d * 18.) * smoothstep(.22, .04, d) * .22 * gFlicker;
  }
  return col;
}`),

  // Vaporwave: a pastel sunset over a calm sea, the sun's reflection
  // shimmering on the water, palms framing the hero; it all scrolls away
  // with the hero.
  vaporwave: shader(`
uniform sampler2D u_sprite;

/* A palm silhouette (the sprite, 519x880, trunk foot at the bottom middle)
   standing at base, height tall, mirrored when flip is -1, its crown
   swaying a little more than its trunk. */
float palm(vec2 q, vec2 base, float height, float flip, float sway) {
  vec2 l = (q - base) / height;
  float v = l.y;
  l.x -= sway * v * v;
  vec2 cell = vec2(.5 + flip * l.x / (519. / 880.), 1. - v);
  if (cell.x < 0. || cell.x > 1. || cell.y < 0. || cell.y > 1.) return 0.;
  return texture(u_sprite, cell).a;
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
    float column = exp(-abs(q.x - sp.x) / (.06 + -y * .3)) * exp(y * 3.);
    // Far below the horizon (behind the page once it scrolls past the hero)
    // depth hardly changes, so the waves stretch into big blobs and the glints
    // into vertical bars: the sea settles into plain dark water there.
    float near = smoothstep(-.3, -.1, y);
    col += vec3(1., .7, .75) * column * (smoothstep(.5, 1., streak) * .45 + glint * .8) * near;
    col += vec3(.6, .5, .9) * smoothstep(.85, 1., streak) * exp(y * 5.) * .18 * near;
  }
  col += vec3(1., .75, .85) * exp(-abs(y) * 60.) * .4;
  // palms framing the hero, swaying a little
  float sway = sin(t * .9) * .03 + sin(t * 2.3) * .008;
  float trees = palm(q, vec2(-aspect * .5 + .1, H - .03), .58, 1., sway + .02);
  trees = max(trees, palm(q, vec2(aspect * .5 - .12, H - .03), .62, -1., sway - .02));
  trees = max(trees, palm(q, vec2(aspect * .5 - .32, H - .03), .4, 1., sway * 1.4));
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

  // Bullet hell: a boss fight with no boss in it. A smoky glow
  // where it would hang turns from violet to deep blue to the red of its
  // roar, light streaming out from behind it; six-pointed star bullets drift
  // past, the far ones smeared into scanlines, the near ones circling the
  // empty middle; now and then a flurry of white shards falls; the red SOUL
  // keeps dodging. All drawn here.
  knightfight: shader(`
float hexagram(vec2 p, float r) {
  const vec4 k = vec4(-.5, .8660254, .5773503, 1.7320508);
  p = abs(p);
  p -= 2. * min(dot(k.xy, p), 0.) * k.xy;
  p -= 2. * min(dot(k.yx, p), 0.) * k.yx;
  p -= vec2(clamp(p.x, r * k.z, r * k.w), r);
  return length(p) * sign(p.y);
}

/* A star bullet: a six-pointed outline with a diamond in the middle; 0..1 coverage. */
float starBullet(vec2 q, float r) {
  float d = hexagram(q, r);
  float rim = step(abs(d + r * .12), r * .11);
  float inner = step(abs(hexagram(q, r * .62) + r * .07), r * .06);
  float core = step(abs(q.x) + abs(q.y), r * .2);
  return max(max(rim, inner * .8), core);
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
  col += mix(tint, pale, .5) * rays * .35 * smoothstep(.02, .16, length(d));
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
      if (length(q - c) > r * 2.8) continue;
      vec2 s = rot(t * (.2 + .3 * hash(id + 3.)) * (hash(id + 4.) > .5 ? 1. : -1.)) * (q - c);
      for (int k = 0; k < 4; k++) smear = max(smear, starBullet(s + vec2(float(k) * r * .22, 0.), r) * (1. - float(k) * .25));
    }
    float scan = step(.5, fract(gl_FragCoord.y / 3.));
    col = mix(col, pale * .8, smear * scan * (.22 + fl * .1));
  }
  // nearer star bullets circling the Knight, crisp, on a pixel grid
  vec2 pp = (floor(p * 210.) + .5) / 210.;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float a = t * (.25 + .05 * fi) + fi * 1.047;
    float rad = .2 + .08 * sin(t * .4 + fi * 2.);
    vec2 c = kp + vec2(cos(a) * rad * 1.5, sin(a) * rad);
    float b = starBullet(rot(t * .8 + fi) * (pp - c), .028 + .006 * sin(fi * 3.));
    col = mix(col, pale, b * .85);
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
// How far the whole ball is turned from facing us, radians.
const float SG_YAW = .3;
// The key light: the glare off to the right.
const vec3 SG_KEY = vec3(.72, .3, .62);

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
// across a strip), y = angle from the axis.
vec2 sgSwirl(vec3 p, float t) {
  vec3 pn = normalize(p);
  vec3 b1 = normalize(cross(SG_AX, vec3(0., 1., 0.)));
  vec3 b2 = cross(SG_AX, b1);
  float th = acos(clamp(dot(pn, SG_AX), -1., 1.));
  float ph = atan(dot(pn, b2), dot(pn, b1));
  // (clamped short of the far pole, where tan blows up and the march would NaN)
  return vec2(ph * 2. / SG_TAU + log(clamp(tan(min(th, 2.9) * .5), 1e-3, 1e3)) * .55 - t * .05, th);
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
float sgInk(vec3 p, float t) {
  float rxy = length(p.xy);
  float a = sgAngle(p.xy);
  float ad = max(1.6 - a, a - 3.9);
  float bound = max(max(rxy - 2.6, .85 - rxy), max(ad > 0. ? rxy * sin(min(ad, 1.5)) : 0., abs(p.z + .05) - .3));
  if (bound > .06) return bound;
  float sect = smoothstep(1.75, 2.3, a) * smoothstep(3.75, 3.15, a);
  float al = rxy - 1.;
  float across = a * 1.3; // (by angle, so a chunk keeps its width as it flies)
  float field = inoise(vec2(across * 8., al * 1.2 - t * .06)) * .6 + inoise(vec2(across * 19., al * 2.6 - t * .1) + 7.) * .3 + inoise(vec2(across * 40., al * 5.) + 3.) * .1;
  float v = field - .34 - .4 * smoothstep(.04, 1.2, al) - .6 * (1. - sect);
  float th = .03 + .22 * (1. - smoothstep(0., 1.1, al));
  return max(max(-v * rxy / 16., abs(p.z + .05) - th), bound);
}

// The scene in ball radii: x = distance, y = what was hit (0 skin, 1 a
// strip's cut edge, 2 the core, 3 the drip, 4 the ink).
vec2 sgMap(vec3 p, float t) {
  float r = length(p);
  vec2 sw = sgSwirl(p, t);
  float th = sw.y;
  // the skin, a shell sinking into the funnel at the front
  float shell = (abs(r - sgFunnel(th)) - .09) * .5;
  // cut into three strips spiralling down the funnel; the gaps close up over
  // the back so the hollow inside stays dark
  // (the gaps taper out to a sliver: closing them short leaves a blunt end)
  float w = mix(.6, 1.05, smoothstep(.75, 1.75, th));
  float q = fract(sw.x);
  float gd = q > w ? min(q - w, 1. - q) : -min(q, w - q);
  float cut = gd * r * max(sin(th), .05) / .64 * .6;
  // the strips' edges rounded like liquid, not cut like blocks; open at the
  // throat onto the core
  float strips = -sgSmin(-shell, -cut, .035);
  strips = max(strips, (.52 - th) * r);
  float core = length(p - SG_CORE) - .23;
  // the drip: a neck from the underside thinning to a strand, a drop swelling
  // at its end until it lets go and falls; then the strand springs back up
  // and a new drop beads, ending the cycle where it began
  float ph = fract(t / 6.);
  float swell = smoothstep(0., .8, ph) * (1. - smoothstep(.85, 1., ph));
  float bead = ph < .85 ? .04 + .035 * smoothstep(0., .8, ph) : .04 * smoothstep(.85, 1., ph);
  vec3 a = vec3(.06, -.93, .2);
  vec3 b = a + vec3(.02, -.26 - .22 * swell, 0.);
  float drip = sgSmin(sgRoundCone(p, a, b, .14, .03), length(p - b - vec3(0., -.03, 0.)) - bead, .05);
  // the drop that let go, falling clear of the picture before the next
  float fall = max(ph - .85, 0.) / .15;
  if (fall > 0.) drip = min(drip, length(p - vec3(.08, -1.44 - fall * fall * 3.2, .2)) - .075);
  float ink = sgInk(p, t);
  float body = sgSmin(sgSmin(strips, drip, .06), ink, .12);
  float m = core < body ? 2. : ink < min(strips, drip) ? 4. : drip < strips ? 3. : cut > shell - .02 ? 1. : 0.;
  return vec2(min(body, core), m);
}

vec3 sgNormal(vec3 p, float t) {
  const vec2 e = vec2(.003, -.003);
  return normalize(e.xyy * sgMap(p + e.xyy, t).x + e.yyx * sgMap(p + e.yyx, t).x + e.yxy * sgMap(p + e.yxy, t).x + e.xxx * sgMap(p + e.xxx, t).x);
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
vec3 sgInkColor(vec3 p, vec3 n, vec3 R, float fres, float t) {
  float ia = sgAngle(p.xy);
  float il = length(p.xy);
  vec3 col = vec3(.003, .008, .05) + sgEnv(R, t) * fres * .85;
  return col + vec3(.3, .58, 1.2) * pow(sgThrowNoise(ia * 30., il * 2. - t * .2), 6.) * 2.5 * fres * smoothstep(-.3, .6, dot(n, SG_KEY));
}

// The ball, ray marched: colour and coverage; past the edge, the glow a lens
// would bloom round it.
vec4 sgOrb(vec2 d, float t) {
  vec2 s = d / SG_R;
  if (length(s) > 2.7 && (s.y > -1. || abs(s.x) > .6)) return vec4(0.);
  vec3 ro = vec3(s, 3.), rd = vec3(0., 0., -1.);
  // the ball turned a little to its own right (our left), so it is seen
  // slightly from the side rather than square on
  mat2 yaw = rot(SG_YAW);
  ro.xz = yaw * ro.xz;
  rd.xz = yaw * rd.xz;
  vec3 V = -rd;
  float z = 0., near = 1e3, zNear = 0., edge = PX * 1.5 / SG_R;
  vec2 h = vec2(1e3, 0.), hNear = h;
  for (int i = 0; i < 130; i++) {
    h = sgMap(ro + rd * z, t);
    if (h.x < near) { near = h.x; zNear = z; hNear = h; }
    if (h.x < .0008 || z > 6.) break;
    z += h.x;
  }
  // a ray that only grazed an edge is shaded where it came closest, not
  // where it gave up: that point lies on the surface's edge
  z = zNear;
  h = hNear;
  float cover = smoothstep(edge, 0., near);
  // (only round the ball itself: the ink's loose bounds would spread it)
  vec3 halo = vec3(.5, .75, 1.) * exp(-near * 6.) * .55 * smoothstep(1.4, 1., length(s));
  if (cover <= 0.) return vec4(halo, 0.);
  vec3 p = ro + rd * z;
  vec3 n = sgNormal(p, t);
  vec3 L = SG_CORE - p;
  float ld = length(L);
  L /= ld;
  if (h.y > 1.5 && h.y < 2.5) {
    // the core: a white-hot ball (its glow is added over everything later)
    return vec4(vec3(6.), cover);
  }
  float ao = clamp(.3 + 4. * sgMap(p + n * .1, t).x + 2. * sgMap(p + n * .25, t).x, 0., 1.);
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
  float fres = .4 + .6 * pow(1. - max(dot(n, V), 0.), 2.);
  float key = max(dot(n, SG_KEY), 0.);
  vec3 col;
  if (h.y > .5 && h.y < 1.5) {
    // a strip's cut edge, painted: pink where a strip begins, blue where it ends
    vec2 sw = sgSwirl(p, t);
    vec3 paint = fract(sw.x) < .3 ? vec3(1., .1, .7) : vec3(.12, .3, 1.);
    col = paint * (.15 + .6 * key) + sgEnv(R, t) * fres * .25;
    col = mix(col, sgInkColor(p, n, R, fres, t), join);
  } else {
    vec2 sw = sgSwirl(p, t);
    bool outside = length(p) > sgFunnel(sw.y) || h.y > 2.5;
    // the outer skin is cobalt glass; the inside of the hollow is near black
    col = outside ? vec3(.006, .02, .42) * (.03 + .97 * key * key) + sgEnv(R, t) * fres : vec3(.002, .003, .012);
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
      col = mix(col, vec3(1., .1, .7) * (.9 + .9 * key) + vec3(.9, .45, 1.) * hot * 1.8 + sgEnv(R, t) * fres * .3, pink);
      col = mix(col, vec3(.06, .22, 1.) * (.3 + .8 * key) + sgEnv(R, t) * fres * .3, blue);
    }
    if (h.y > 3.5) {
      // the torn ink: the same liquid, darker where it thins out, with gloss
      // streaked along the throw and embers of the core's red caught in it
      float ia = sgAngle(p.xy);
      float il = length(p.xy);
      col = sgInkColor(p, n, R, fres, t);
      col += vec3(1., .2, .05) * smoothstep(.74, .82, sgThrowNoise(ia * 40., il * 5. - t * .3)) * smoothstep(.3, -.4, p.y) * smoothstep(1.8, 1.05, il) * 1.4;
    } else if (outside && h.y < 2.5) {
      // where a strip runs into the ink it darkens into it, so the two read
      // as one pour of liquid rather than glass meeting a separate sheet
      col = mix(col, sgInkColor(p, n, R, fres, t), join);
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
  // the tunnel splits a little at the edges, red out and blue in
  float ca = .005 + .012 * length(d);
  vec3 col = vec3(sgTunnel(d * (1. - ca), t).r, sgTunnel(d, t).g, sgTunnel(d * (1. + ca), t).b);
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
  // Red tree: a lone crimson tree on a violet night meadow, after the red
  // trees of a certain dark world, kept cosy rather than eerie: a dusky rose
  // sky with soft cloud and stars, far hills of more trees, the tree's own
  // glow warming the ground, leaves drifting down into a still pool that
  // mirrors it, and fireflies blinking about (they lean toward the pointer).
  // The tree is a painted sprite (red-tree.webp); the crown sways in the
  // breeze and catches a gust now and then.
  redtree: shader(`
uniform sampler2D u_sprite;

// where the trunk meets the ground in the sprite (x, and y from the top)
const vec2 RT_BASE = vec2(.547, .915);
const vec3 RT_ROSE = vec3(1., .3, .38);

/* Sprite uv (y from the top) of a point q, for a tree of height \`size\`
   standing at g. */
vec2 rtUV(vec2 q, vec2 g, float size) {
  return vec2(RT_BASE.x + (q.x - g.x) / size, RT_BASE.y - (q.y - g.y) / size);
}

/* The breeze: the crown sways, the trunk does not; leaves shiver on top,
   and every 13 s a gust leans it over and lets it rock back. */
vec2 rtSway(vec2 s, float t) {
  float w = smoothstep(.62, .06, s.y);
  float k = fract(t / 13. + .3);
  float gust = smoothstep(0., .08, k) * (1. - smoothstep(.08, .5, k));
  float dx = .0045 * sin(t * .7 + s.y * 2.) + .002 * sin(t * 1.7 + s.x * 4.)
    + gust * (.009 + .004 * sin(t * 4.2 + s.x * 3.));
  dx += .003 * (noise(s * 13. + vec2(t * .8, t * .3)) - .5);
  float dy = .002 * (noise(s * 13. + vec2(7., t * .6)) - .5);
  return s - w * vec2(dx, dy);
}

vec4 rtTree(vec2 s) {
  if (s.x < 0. || s.x > 1. || s.y < 0. || s.y > 1.) return vec4(0.);
  return texture(u_sprite, s);
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  float wide = smoothstep(.7, 1.4, aspect);
  float size = mix(.6, .82, wide);
  vec2 g = vec2(mix(.02, aspect * .25, wide), mix(-.24, -.32, wide));
  // the scene drifts up with the page, slower than it
  vec2 q = vec2(p.x, p.y - u_scroll * .5);
  float hz = g.y + .16 * size;

  // sky: plum low, deep indigo high, a rose dusk along the horizon
  float sy = q.y - hz;
  vec3 col = mix(vec3(.085, .036, .11), vec3(.03, .018, .07), smoothstep(-.02, .85, sy));
  col += vec3(.1, .028, .065) * exp(-max(sy, 0.) * 6.);
  float cloud = fbm(vec2(q.x * 1.3 + t * .006, q.y * 4.6 + 3.));
  col += vec3(.045, .018, .05) * smoothstep(.52, .78, cloud) * smoothstep(.02, .25, sy) * smoothstep(.95, .35, sy);
  vec2 sp = vec2(p.x, p.y - u_scroll * .15);
  col += vec3(1., .86, .9) * (stars(sp, 70., .09, t) + .7 * stars(sp + 3.1, 130., .07, t)) * smoothstep(.06, .4, sy);
  // the crown's glow in the air round it
  vec2 crown = g + size * vec2(.5 - RT_BASE.x, RT_BASE.y - .3);
  float halo = exp(-length((q - crown) / (size * vec2(.62, .48))) * 2.2);
  col += RT_ROSE * .1 * halo;

  // far hills, tufted with trees, then nearer ones, both hazed toward the sky
  float tuft = pow(noise(vec2(q.x * 46., 2.)), 2.) * .016 + pow(noise(vec2(q.x * 17., 5.)), 3.) * .02;
  float h1 = hz + .03 + .022 * sin(q.x * 2.7 + 1.) + .012 * sin(q.x * 6.1 + 2.) + tuft;
  col = mix(col, mix(vec3(.12, .048, .14), col, .35) + RT_ROSE * .03 * halo, smoothstep(h1 + PX, h1 - PX, q.y));
  float h2 = hz + .008 + .014 * sin(q.x * 4.3 + 4.) + .008 * sin(q.x * 9.7) + tuft * .6;
  col = mix(col, vec3(.075, .03, .095) + RT_ROSE * .03 * halo, smoothstep(h2 + PX, h2 - PX, q.y));

  // the meadow: violet, streaked by the brush, warmed near the tree
  if (q.y < hz) {
    float near = smoothstep(hz, g.y - .3, q.y);
    vec3 ground = mix(vec3(.07, .03, .09), vec3(.1, .042, .13), near);
    ground += vec3(.022, .01, .03) * (fbm(vec2(q.x * 3.5, q.y * 38.)) - .5);
    ground += RT_ROSE * .1 * exp(-length((q - g) * vec2(1., 3.2)) / size * 3.);
    col = mix(col, ground, smoothstep(hz - PX * 2., hz - PX * 6., q.y) * step(q.y, h2));
  }

  // the pool under the tree, still enough to hold it upside down
  vec2 pq = (q - g - vec2(-.03, -.045) * size) / (vec2(.6, .1) * size);
  float streak = fbm(vec2(q.x * 2.6 / size, q.y * 60. / size));
  float pool = smoothstep(1., .78, length(pq) + .4 * (streak - .5));
  if (pool > 0.) {
    vec3 water = mix(vec3(.17, .075, .26), vec3(.3, .14, .42), smoothstep(1., .1, length(pq))) * (.85 + .3 * streak);
    water += RT_ROSE * .12 * smoothstep(1., .2, length(pq));
    vec2 rq = vec2(q.x, g.y + (g.y - q.y) * 1.6);
    rq.x += .0025 * sin(q.y * 220. / size + t * 1.6) * smoothstep(g.y, g.y - .05 * size, q.y);
    vec4 refl = textureLod(u_sprite, rtSway(rtUV(rq, g, size), t), 1.5);
    water = water * (1. - refl.a * .7) + refl.rgb * vec3(.62, .48, .75);
    col = mix(col, water, pool);
  }

  // the tree
  vec4 tree = rtTree(rtSway(rtUV(q, g, size), t));
  col = col * (1. - tree.a) + tree.rgb * .94;

  // leaves let go of the crown and see-saw down to the pool
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    float period = 10. + 6. * hash(vec2(fi, 1.));
    float run = t / period + hash(vec2(fi, 2.));
    float k = fract(run), cyc = floor(run);
    vec2 start = g + size * vec2(.62 * hash(vec2(fi, cyc + 3.)) - .36, .42 + .16 * hash(vec2(fi, cyc + 5.)));
    float drop = start.y - g.y + .03 * size * hash(vec2(fi, cyc + 6.));
    vec2 pos = start + vec2(.1 * size * k + .03 * size * sin(k * 8. + fi * 2.), -drop * k);
    vec2 lp = q - pos;
    float r = max(.017 * size, PX * 4.);
    if (dot(lp, lp) > r * r * 2.) continue;
    // it turns over as it falls: narrow edge-on, full face-on
    float flip = abs(cos(k * 11. + fi));
    lp = rot(k * 4. + fi) * lp / r;
    float e = abs(lp.x) / max(.4 * (.2 + .8 * flip) * (1. - lp.y * lp.y), 1e-3);
    float a = smoothstep(1., .75, e) * smoothstep(1., .85, abs(lp.y)) * smoothstep(0., .05, k) * smoothstep(1., .9, k);
    col = mix(col, mix(vec3(.55, .06, .2), vec3(1., .33, .3), flip * flip), a * .95);
  }

  // fireflies over the meadow, blinking slowly, drawn to the pointer
  vec2 ptr = pointerP() + vec2(0., -u_scroll * .5);
  for (int i = 0; i < 14; i++) {
    float fi = float(i);
    vec2 home = vec2((hash(vec2(fi, 7.)) - .5) * aspect * .96, mix(g.y - .08, g.y + size * .85, hash(vec2(fi, 8.))));
    vec2 pos = home + .05 * vec2(sin(t * .21 + fi * 2.), sin(t * .29 + fi * 1.3));
    pos += (ptr - pos) * .12 * exp(-length(ptr - pos) * 5.);
    float blink = smoothstep(.25, 1., .5 + .5 * sin(t * (.45 + .4 * hash(vec2(fi, 9.))) + fi * 4.));
    float d = length(q - pos);
    float r = max(.003, PX * 2.);
    col += vec3(1., .74, .46) * (smoothstep(r, r * .3, d) * .9 + exp(-d * 70.) * .16) * blink;
  }

  // a soft vignette keeps the corners quiet under the page
  return col * (1. - .3 * smoothstep(.55, 1.4, length(p * vec2(.75, 1.))));
}`),
};
