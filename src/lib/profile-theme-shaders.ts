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
const PRELUDE = `#version 300 es
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

mat2 rot(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

vec2 pointerP() {
  return (u_pointer - .5) * vec2(u_res.x / u_res.y, 1.);
}

/* Twinkling points: \`scale\` cells per unit, \`density\` the share of cells lit. */
float stars(vec2 p, float scale, float density, float t) {
  vec2 cell = p * scale;
  vec2 id = floor(cell);
  vec2 f = fract(cell) - .5;
  float h = hash(id);
  if (h > density) return 0.;
  vec2 o = (vec2(hash(id + 1.3), hash(id + 2.7)) - .5) * .7;
  float r = max(.08, 1.4 * PX * scale);
  float tw = .55 + .45 * sin(t * (1. + 3. * hash(id + 5.)) + h * 40.);
  return smoothstep(r, 0., length(f - o)) * tw * (.35 + .65 * hash(id + 9.1)) * min(1., .08 / r * 1.6);
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

const MAIN = `
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

const shader = (body: string) => `${PRELUDE}\n${body}\n${MAIN}`;

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

  // Sakura: cherry blossom petals drifting down through dusk in four layers,
  // the nearest and farthest out of focus, under a soft blossom canopy along
  // the top of the hero. Each petal is a cupped surface tumbling in 3D: it
  // foreshortens whichever way it turns, catches a warm light from above,
  // glows when the light comes through it, and shows fine veins fanning
  // from its base. Each one flutters on its own; gusts sweep through now
  // and then.
  sakura: shader(`
const vec3 LIGHT = vec3(.45, .7, .55);

/* Signed distance to a petal, in petal units: base at y = -1, tip at y = 1. */
float petalShape(vec2 q) {
  float y = q.y;
  float hw = .64 * sqrt(max(0., 1. - y * y)) * (.58 + .42 * smoothstep(-1., .3, y));
  float side = abs(q.x) - hw;
  float notch = y - (1. - .2 * max(0., 1. - abs(q.x) / .17));
  return max(side, max(notch, -1. - y));
}

mat3 rotAxis(vec3 a, float angle) {
  a = normalize(a);
  float s = sin(angle), c = cos(angle), oc = 1. - c;
  return mat3(
    oc * a.x * a.x + c, oc * a.x * a.y + a.z * s, oc * a.z * a.x - a.y * s,
    oc * a.x * a.y - a.z * s, oc * a.y * a.y + c, oc * a.y * a.z + a.x * s,
    oc * a.z * a.x + a.y * s, oc * a.y * a.z - a.x * s, oc * a.z * a.z + c);
}

/* One layer of petals: colour premultiplied by coverage, and the coverage. */
vec4 petals(vec2 p, float t, float layer, float s, float focus, float bright, float density) {
  float gust = smoothstep(.55, 1., sin(t * .23 + layer)) * 1.4;
  vec2 q = p * s;
  q.y += t * (.3 + layer * .09) * (s / 9.) - u_scroll * s * (.12 + layer * .1);
  q.x += t * (.1 + layer * .04) * (s / 9.) + gust * (s / 9.) * sin(t * .5) + sin(q.y * .4 + t * .45 + layer * 2.) * .4;
  vec2 id = floor(q);
  float h = hash(id + layer * 17.);
  if (h > density) return vec4(0.);
  float size = .13 + .07 * hash(id + 8.);
  // its own flutter: a sway and a bob, kept inside its cell
  float f1 = .7 + .8 * hash(id + 11.), f2 = 1.1 + hash(id + 12.);
  vec2 centre = (vec2(hash(id + 1.7), hash(id + 3.3)) - .5) * .3
    + vec2(sin(t * f1 + h * 6.28) * .1, cos(t * f2 + h * 4.) * .05);
  vec2 d = fract(q) - .5 - centre;
  // tumbling in 3D: the petal plane's axes as seen from the front
  vec3 axis = vec3(hash(id + 13.) - .5, hash(id + 14.) - .5, hash(id + 15.) - .5) + vec3(.0, .0, .2);
  mat3 R = rotAxis(axis, t * (.6 + .9 * hash(id + 5.1)) * (hash(id + 6.) > .5 ? 1. : -1.) + h * 20.);
  vec3 u = R[0], v = R[1];
  float det = u.x * v.y - v.x * u.y;
  // edge-on it is a sliver of its true length, never a streak
  float sdet = det < 0. ? min(det, -1e-3) : max(det, 1e-3);
  vec2 local = vec2(v.y * d.x - v.x * d.y, -u.y * d.x + u.x * d.y) / sdet / size;
  // curled: the petal bends along its length, so its outline is a crescent,
  // and it flexes as it falls
  float curl = (hash(id + 16.) - .5) * 1.1 + .25 * sin(t * 1.7 + h * 13.);
  vec2 straight = local;
  local.x += curl * (local.y * local.y - .35);
  float squash = sqrt(max(abs(det), .02));
  float sd = petalShape(local) * size * squash;
  float aa = PX * s * 1.2 + focus;
  float cover = smoothstep(aa, -aa, sd);
  if (focus > 0.) {
    float r = length(vec2(straight.x / .62, straight.y * .95));
    cover = smoothstep(1. + focus / (size * squash), 1. - focus / (size * squash), r) * .85;
  }
  // a petal edge-on is a thin sliver that hardly catches the light
  cover *= smoothstep(.03, .3, abs(det));
  if (cover <= 0.) return vec4(0.);
  // a cupped, curled surface: its normal leans hard toward the rims and
  // across the bend, so one flank catches the light and the other falls
  // into the fold
  vec3 n = normalize(R * vec3(-1.5 * local.x + 1.6 * curl * local.y, -.45 * local.y, 1.));
  vec3 facing = n * sign(n.z);
  vec3 L = normalize(LIGHT);
  float lit = max(dot(facing, L), 0.);
  float through = max(dot(-facing, L), 0.);
  float sheen = pow(max(dot(reflect(-L, facing), vec3(0., 0., 1.)), 0.), 10.);
  float along = clamp(local.y * .5 + .5, 0., 1.);
  vec3 base = mix(vec3(.93, .38, .58), vec3(1., .6, .74), hash(id + 9.));
  vec3 albedo = mix(base, vec3(1., .88, .92), smoothstep(.0, .85, along));
  albedo = n.z > 0. ? albedo : mix(albedo, vec3(1., .92, .95), .25);
  // fine veins fanning out from the base
  float fan = atan(local.x, local.y + 1.15);
  float vein = .5 + .5 * cos(fan * 46. + 2.5 * noise(vec2(fan * 9., along * 3. + h * 20.)));
  albedo *= 1. - .045 * vein * smoothstep(1., .15, along) * smoothstep(-.9, -.5, local.y);
  // shade stays rosy: light still passes through a petal turned away
  // deeper pink along the rim, paler and pearly in the middle
  float inner = smoothstep(0., -.4, petalShape(local));
  albedo = mix(albedo * vec3(.97, .8, .88), albedo, .45 + .55 * inner);
  albedo = mix(albedo, vec3(1., .96, .97), .25 * inner * smoothstep(.2, .8, along));
  vec3 c = albedo * mix(vec3(.5, .3, .42), vec3(1.12), pow(lit, .8)) + albedo * vec3(1., .82, .78) * through * .45;
  c += vec3(1., .97, .98) * sheen * .32;
  c += vec3(1., .82, .88) * smoothstep(-.02, 0., sd) * .12;
  return vec4(c * bright * cover, cover);
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  vec3 col = mix(vec3(.04, .012, .03), vec3(.11, .035, .075), smoothstep(-.5, .55, p.y));
  col += vec3(.17, .05, .1) * exp(-length(p - vec2(.35, .45)) * 1.8);
  // a blossom canopy far out of focus along the top of the hero, thickest
  // in its right corner, riding away with it: just a soft pink haze
  float top = p.y - u_scroll - .5;
  float clump = fbm(vec2(p.x * 1.8 + t * .01, (p.y - u_scroll) * 1.8));
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
  vec4 l0 = petals(p, t, 0., 22., .025, .6, .2);
  vec4 l1 = petals(p + 1.3, t, 1., 13., 0., .72, .22);
  vec4 l2 = petals(p + 2.9, t, 2., 7.5, 0., .92, .22);
  vec4 l3 = petals(p + 5.1, t, 3., 5., .06, .92, .18);
  col = col * (1. - l0.a * .8) + mix(l0.rgb, vec3(.55, .25, .38) * l0.a, .35);
  col = col * (1. - l1.a * .9) + l1.rgb;
  col = col * (1. - l2.a * .92) + l2.rgb;
  col = col * (1. - l3.a * .75) + l3.rgb * .85;
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
  // bubbles
  for (int l = 0; l < 2; l++) {
    float fl = float(l);
    float s = 6. + fl * 5.;
    vec2 q = p * s;
    q.y -= t * (1.1 + fl * .6) + sc * s * .3;
    q.x += sin(q.y * 1.3 + t * 2. + fl) * .12;
    vec2 id = floor(q);
    vec2 f = fract(q) - .5;
    float h = hash(id + fl * 31.);
    if (h < .84) continue;
    vec2 o = (vec2(hash(id + 2.1), hash(id + 4.2)) - .5) * .5;
    float r = .07 + .09 * hash(id + 7.);
    float d = length(f - o);
    float aa = PX * s * 1.5;
    float ring = smoothstep(r + aa, r, d) * smoothstep(r - .025 - aa, r - .025, d);
    float spec = smoothstep(.03 + aa, 0., length(f - o - vec2(-.35, .35) * r));
    col += vec3(.55, .9, 1.) * (ring * .6 + spec * .8) * (.25 + fl * .2) * (.4 + .6 * exp(-depth * .6));
  }
  // marine snow
  col += vec3(.5, .75, .8) * stars(p + vec2(t * .006, t * .012 - sc * .4), 46., .12, t * .3) * .35;
  return col;
}`),

  // Nebula: clouds of violet and rose gas, three layers of stars at their own
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
  // a few bright stars with spikes
  vec2 bq = (p - vec2(0., sc * .08)) * 4.;
  vec2 bid = floor(bq);
  vec2 bd = fract(bq) - .5 - (vec2(hash(bid + 3.), hash(bid + 6.)) - .5) * .6;
  float big = step(.8, hash(bid + 11.));
  float flare = exp(-length(bd) * 40.) + (exp(-abs(bd.x) * 260.) * exp(-abs(bd.y) * 14.) + exp(-abs(bd.y) * 260.) * exp(-abs(bd.x) * 14.)) * .5;
  col += vec3(.9, .85, 1.) * flare * big * (.6 + .4 * sin(t * 1.3 + hash(bid) * 30.));
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

  // Inferno: drawn fire, not a glow. Flame tongues lick up from the bottom of
  // the view in four hard colour bands (cel-shaded, like 2D game fire), their
  // tips tearing off as loose licks; a few sharp sparks streak up through the
  // smoke above. No soft glow bands or round bokeh embers.
  inferno: shader(`
float flameField(vec2 p, float t) {
  float y = p.y + .5;
  // how far up the fire reaches here: a few wandering crests along the bottom
  float crest = .75 + .35 * sin(p.x * 4.5 + noise(vec2(p.x * 1.5, t * .4)) * 4. + t * .3);
  float grad = 1. - y / (.42 * crest);
  // tall noise rising fast; near the base it barely matters, near the top only
  // its low spots stay lit, which tears the fire into separate pointed licks
  vec2 q = vec2(p.x * 6.5, y * 3.2 - t * 2.6);
  q.x += (noise(vec2(y * 4. - t * 1.5, p.x * 2.)) - .5) * 1.2;
  float n = smoothstep(.22, .78, fbm(q + (vec2(fbm(q * .7 + t * .2), 0.) - .5) * 1.2));
  return grad * 1.3 - n * 1.5 + .45;
}
vec3 theme(vec2 uv, vec2 p, float t) {
  float sc = u_scroll;
  vec3 col = mix(vec3(.05, .016, .01), vec3(.018, .008, .007), smoothstep(-.5, .45, p.y));
  // heavy smoke rolling up, darker than the sky behind it
  float smoke = fbm(vec2(p.x * 1.6 + t * .025, p.y * 1.1 - t * .1 - sc * .4));
  col = mix(col, vec3(.012, .006, .006), smoothstep(.5, .8, smoke) * .6);
  float f = flameField(p, t);
  float aa = PX * 6.;
  // hard bands: ember red at the rim, orange, then a yellow core
  col = mix(col, vec3(.42, .06, .03), smoothstep(0., aa, f));
  col = mix(col, vec3(.86, .2, .05), smoothstep(.2, .2 + aa, f));
  col = mix(col, vec3(1., .52, .1), smoothstep(.48, .48 + aa, f));
  col = mix(col, vec3(1., .86, .42), smoothstep(.9, .9 + aa, f));
  // a thin dark outline where the fire meets the dark, like an inked edge
  col *= 1. - .55 * smoothstep(aa * 2., 0., abs(f + .03)) * step(f, .1);
  // sparks: short sharp streaks along their climb, a few at a time
  for (int l = 0; l < 2; l++) {
    float fl = float(l);
    float s = 6. + fl * 5.;
    vec2 q = p * s;
    q.y -= t * (1.6 + fl * .6) + sc * s * .35;
    float sway = sin(q.y * .9 + t * 2. + fl * 3.) * .2;
    q.x += sway;
    vec2 id = floor(q);
    vec2 c = fract(q) - .5;
    float h = hash(id + fl * 17.);
    if (h < .86) continue;
    vec2 o = c - (vec2(hash(id + 1.), hash(id + 2.)) - .5) * .5;
    // a streak leaning with the sway, longer than it is wide
    o.x -= o.y * cos(q.y * .9 + t * 2. + fl * 3.) * .2;
    float d = length(o * vec2(1., .22));
    float spark = smoothstep(max(.035, PX * s * 1.5), 0., d);
    float life = smoothstep(.55, -.3, p.y);
    float blink = step(.25, fract(t * (1.5 + hash(id + 3.) * 2.) + h * 7.));
    col = mix(col, vec3(1., .78, .35), spark * life * blink * (.7 + fl * .3));
  }
  return col;
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

  // Thunderstorm: rain sheeting past, heavy clouds, and now and then a bolt
  // that lights the whole sky.
  storm: shader(`
vec3 theme(vec2 uv, vec2 p, float t) {
  float sc = u_scroll;
  float aspect = u_res.x / u_res.y;
  float period = 5.;
  float seed = floor(t / period);
  float age = t - seed * period - (.5 + 3. * hash(vec2(seed, 1.)));
  float flash = 0.;
  if (age > 0. && age < .7) flash = exp(-age * 5.) * (.55 + .45 * step(.5, fract(age * 13.)));
  vec3 col = mix(vec3(.018, .022, .03), vec3(.045, .055, .07), smoothstep(-.5, .5, p.y));
  vec2 cp = vec2(p.x * 1.2 + t * .02, p.y * 2. - sc * .3);
  float cl = fbm(cp * 1.5 + fbm(cp + t * .01) * 1.2);
  float cloudMask = smoothstep(-.15, .35, p.y - sc * .25);
  col = mix(col, vec3(.13, .145, .18) + flash * vec3(.5, .55, .7), smoothstep(.36, .75, cl) * cloudMask);
  float bx = (hash(vec2(seed, 2.)) - .5) * aspect * .9;
  float x = bx + (fbm(vec2(p.y * 3., seed)) - .5) * .4 + (noise(vec2(p.y * 16., seed * 3.)) - .5) * .05;
  float dist = abs(p.x - x);
  float bolt = exp(-dist / max(PX * 1.5, .0012)) + exp(-dist * 22.) * .3;
  bolt *= smoothstep(-.25 - .25 * hash(vec2(seed, 4.)), .1, p.y);
  col += vec3(.75, .8, 1.) * bolt * flash * 1.3;
  col += vec3(.16, .18, .26) * flash;
  vec2 rp = p;
  rp.x += rp.y * .18;
  for (int l = 0; l < 2; l++) {
    float fl = float(l);
    float s = 34. + fl * 26.;
    vec2 q = vec2(rp.x * s, rp.y * s * .09 + t * (2.2 + fl * .8) - sc * s * .05);
    vec2 id = floor(q);
    vec2 f = fract(q);
    float h = hash(id + fl * 9.);
    if (h < .8) continue;
    float o = .2 + .6 * hash(id + 3.);
    float streak = smoothstep(PX * s * 1.2, 0., abs(f.x - o)) * smoothstep(0., .6, f.y) * smoothstep(1., .7, f.y);
    col += vec3(.5, .56, .68) * streak * (.2 + fl * .08 + flash * .35);
  }
  return col;
}`),

  // Noir: light through venetian blinds, dust turning in it, smoke drifting,
  // film grain; the light leans after the pointer.
  noir: shader(`
vec3 theme(vec2 uv, vec2 p, float t) {
  vec2 ptr = pointerP();
  vec2 r = rot(.38) * (p - ptr * .06);
  float bars = smoothstep(.25, .6, abs(fract(r.y * 12. + .25) - .5) * 2.);
  float pool = smoothstep(.75, .05, length((r - vec2(.42, .12)) * vec2(.7, 1.3)));
  float light = bars * pool;
  float v = .02 + light * .15 + pool * .025;
  v += stars(p - vec2(t * .008, t * .006 - u_scroll * .2), 38., .12, t * .5) * pool * .9;
  float sm = fbm(vec2(p.x * 2. - t * .05, p.y * 2.5 - t * .07) + fbm(p * 3. + t * .03));
  v += smoothstep(.55, .9, sm) * .05 * (.4 + pool);
  v *= 1. - .55 * dot(p * vec2(.8, 1.), p * vec2(.8, 1.));
  v += (hash(gl_FragCoord.xy + floor(t * 24.) * .731) - .5) * .03;
  v *= .97 + .03 * sin(t * 17.) * sin(t * 7.3);
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

  // Koi pond: koi gliding beneath dappled light, bending through their
  // turns, lily pads drifting on top; the koi come toward the pointer.
  koi: shader(`
uniform sampler2D u_sprite;

/* Where koi i is at path time tau: a loop round the pond, pulled toward
   wherever the pointer rests, as if coming to be fed. */
vec2 koiPath(float i, float tau, float aspect, vec2 lure) {
  float a = .7 + .25 * i, b = .9 + .17 * i, phase = i * 2.1;
  vec2 roam = vec2(cos(tau * a + phase) * aspect * .4, sin(tau * b + phase * 1.3) * .36);
  return mix(roam, lure + (roam - lure) * .35, .45);
}

vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  vec2 w = p + vec2(0., u_scroll * .35);
  vec3 col = mix(vec3(.01, .05, .06), vec3(.03, .11, .12), fbm(w * 1.5 + t * .02));
  vec2 lure = pointerP() + vec2(0., u_scroll * .35);
  vec2 bent = w;
  float caustic = 1. - smoothstep(0., .03, voronoiEdge(bent * 4.5 + vec2(t * .12, t * .08) + fbm(bent * 1.6 + t * .1) * 1.4));
  col += vec3(.25, .5, .45) * caustic * .045 * (.4 + fbm(bent * 3. - t * .05));
  // koi, under the surface: the sprite (head to the left, drawn straight)
  // laid along the curve each fish has just swum, so its body bends through
  // turns, with a tail beat that grows toward the tail
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float tau = t * (.09 + .02 * fi);
    float len = .26 + .07 * hash(vec2(fi, 3.));
    float thick = len * 150. / 424.;
    // path time per body length, from how fast the head is moving
    float speed = length(koiPath(fi, tau + .01, aspect, lure) - koiPath(fi, tau, aspect, lure)) / .01;
    float step_ = len / 6. / max(speed, .05);
    float beat = t * (4.5 + hash(vec2(fi, 4.))) + fi * 2.;
    vec2 spine[7];
    for (int j = 0; j < 7; j++) {
      float fj = float(j);
      vec2 c = koiPath(fi, tau - fj * step_, aspect, lure);
      vec2 ahead = normalize(koiPath(fi, tau - fj * step_ + .002, aspect, lure) - c + 1e-6);
      float u = fj / 6.;
      // the beat: little at the head, a free swing at the tail
      spine[j] = c + vec2(-ahead.y, ahead.x) * sin(beat - u * 3.2) * len * (.015 + .11 * u * u);
    }
    float best = 1e9, u = 0., side = 0.;
    for (int j = 0; j < 6; j++) {
      vec2 a = spine[j], b = spine[j + 1];
      vec2 pa = w - a, ba = b - a;
      float hseg = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0., 1.);
      vec2 off = pa - ba * hseg;
      float d = dot(off, off);
      if (d < best) {
        best = d;
        // past the tail the projection runs on, so nothing beyond it maps onto the sprite
        float along = j == 5 ? dot(pa, ba) / max(dot(ba, ba), 1e-8) : hseg;
        u = (float(j) + along) / 6.;
        side = (ba.x * pa.y - ba.y * pa.x) / max(length(ba), 1e-6);
      }
    }
    // the head reaches a little past the front of the spine
    vec2 front = w - spine[0];
    vec2 headDir = normalize(spine[0] - spine[1] + 1e-6);
    float lead = dot(front, headDir);
    if (lead > 0.) {
      u = -lead / len;
      side = headDir.x * front.y - headDir.y * front.x;
    }
    // only near the body: further out, the nearest segment says nothing useful
    if (sqrt(best) > thick * .9 && lead <= 0.) continue;
    vec2 cell = vec2(u * .92 + .06, .5 + side / thick);
    vec2 shade = cell + vec2(-.03, -.12);
    float shadow = 0.;
    if (shade.x > 0. && shade.x < 1. && shade.y > 0. && shade.y < 1.) shadow = textureLod(u_sprite, shade, 2.).a;
    col *= 1. - shadow * .35;
    if (cell.x > 0. && cell.x < 1. && cell.y > 0. && cell.y < 1.) {
      vec4 koi = texture(u_sprite, cell);
      vec3 fish = koi.rgb / max(koi.a, 1e-3);
      // some are gold rather than red
      float redness = clamp((fish.r - fish.g) * 1.5, 0., 1.);
      if (hash(vec2(fi, 9.)) > .55) fish = mix(fish, vec3(1., .55, .12), redness);
      fish = mix(fish, col, .18);
      col = mix(col, fish, koi.a * .95);
    }
  }
  // lily pads on the surface
  vec2 lq = w * 3. + vec2(t * .015, 0.);
  vec2 lid = floor(lq);
  if (hash(lid + 7.) > .72) {
    vec2 ld = fract(lq) - .5 - (vec2(hash(lid + 1.), hash(lid + 2.)) - .5) * .3;
    ld = rot(t * .05 + hash(lid) * 6.28) * ld;
    float pad = length(ld) - .22;
    float notch = step(abs(atan(ld.x, ld.y)), .25);
    float cover = smoothstep(PX * 6., -PX * 6., pad) * (1. - notch);
    vec3 green = mix(vec3(.05, .16, .07), vec3(.11, .27, .11), smoothstep(.22, .02, length(ld) + .05 * noise(ld * 20.)));
    green *= .85 + .15 * smoothstep(-.1, .2, ld.x - ld.y);
    col = mix(col, green, cover * .8);
    if (hash(lid + 5.) > .6) {
      float bloom = smoothstep(.07, .03, length(ld - vec2(.06, -.04)));
      col = mix(col, vec3(1., .72, .82), bloom * .9);
    }
  }
  col *= 1. - .35 * dot(p, p);
  return col;
}`),

  // Hanabi: a summer festival night, lanterns strung across the top of the
  // hero and fireworks bursting over it.
  hanabi: shader(`
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
  // lanterns strung across the top of the hero, swaying
  float ropeY = .46 - .03 * (1. - pow(q.x / (aspect * .5), 2.));
  col += vec3(.25, .12, .08) * smoothstep(PX * 2., 0., abs(q.y - ropeY)) * .5;
  float spacing = .13;
  float li = floor(q.x / spacing + .5);
  float lx = li * spacing;
  float ly = .46 - .03 * (1. - pow(lx / (aspect * .5), 2.)) - .045;
  vec2 ld = rot(sin(t * 1.3 + li) * .08) * (q - vec2(lx, ly));
  float body = length(vec2(ld.x / .022, ld.y / .03)) - 1.;
  float lantern = smoothstep(.08, -.08, body);
  float ribs = .85 + .15 * sin(ld.y * 160.);
  vec3 warm = hash(vec2(li, 5.)) > .5 ? vec3(1., .32, .14) : vec3(1., .6, .2);
  col = mix(col, warm * ribs * (.7 + .3 * sin(t * 2. + li)), lantern);
  col += warm * exp(-length(q - vec2(lx, ly)) * 22.) * .25;
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
    float glint = smoothstep(.75, 1., streak) * step(.4, noise(vec2(q.x * 60., depth * 8. - t * 2.)));
    float column = exp(-abs(q.x - sp.x) / (.06 + -y * .3)) * exp(y * 3.);
    col += vec3(1., .7, .75) * column * (smoothstep(.5, 1., streak) * .45 + glint * .8);
    col += vec3(.6, .5, .9) * smoothstep(.85, 1., streak) * exp(y * 5.) * .18;
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

  // Black hole: a spinning accretion disk bending the starlight around a
  // dark shadow, the far side of the disk lensed up and over it.
  blackhole: shader(`
vec3 theme(vec2 uv, vec2 p, float t) {
  float aspect = u_res.x / u_res.y;
  vec2 c = vec2(aspect * .27, .27 + u_scroll);
  vec2 d = p - c;
  float r = length(d);
  float Rs = .055;
  vec2 dir = d / max(r, 1e-4);
  // the background, sampled through the bend
  vec2 bentP = p - dir * (Rs * Rs * 2.4) / max(r, Rs * .5);
  vec3 col = vec3(.006, .004, .01);
  float neb = fbm(bentP * 1.6 + vec2(t * .005, 0.));
  col += mix(vec3(.08, .03, .12), vec3(.2, .07, .05), neb) * smoothstep(.35, .8, neb) * .5;
  col += vec3(.85, .9, 1.) * stars(bentP - vec2(0., u_scroll * .05), 36., .14, t);
  col += vec3(.8, .85, 1.) * stars(bentP + 2.3, 80., .2, t) * .5;
  // the disk, in its own tilted plane
  vec2 dd = vec2(d.x, d.y / .2);
  float rd = length(dd);
  float ang = atan(dd.y, dd.x);
  float swirl = fbm(vec2(ang * 2.5 - t * .5 + rd * 25., rd * 12.));
  float band = smoothstep(Rs * 1.5, Rs * 2.2, rd) * smoothstep(Rs * 6., Rs * 3., rd);
  float doppler = 1. + .75 * cos(ang + .4);
  vec3 disk = mix(vec3(1., .42, .1), vec3(1., .88, .65), swirl) * band * (.35 + .9 * swirl) * doppler;
  // the far side of the disk, bent up and over the shadow
  float halo = smoothstep(Rs * 1.3, Rs * 1.65, r) * smoothstep(Rs * 2.7, Rs * 1.8, r);
  float haloSwirl = fbm(vec2(atan(d.y, d.x) * 2. - t * .5, r * 30.));
  col += mix(vec3(1., .45, .12), vec3(1., .85, .6), haloSwirl) * halo * (.25 + .75 * abs(dir.y)) * (.5 + haloSwirl) * .9;
  col += disk * step(0., dd.y) * .9;
  // the shadow and the thin photon ring at its edge
  col *= smoothstep(Rs * 1.18, Rs * 1.28, r);
  col += vec3(1., .8, .55) * exp(-abs(r - Rs * 1.3) / max(PX * 1.5, .0012)) * .8;
  // the near side of the disk passes in front of it all
  col = mix(col, col + disk, step(dd.y, 0.));
  col += vec3(1., .5, .2) * exp(-r / Rs * .45) * .06;
  return col;
}`),
};
