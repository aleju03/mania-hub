export const cardOverlayVertexShader = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const cardOverlayFragmentShader = `
precision highp float;

uniform float uTime;
uniform float uIntensity;
uniform float uFoil;
// An active supporter's card: the holo turns into a fine holographic foil,
// on every tier including common (whose uFoil is 0).
uniform float uSupporter;
// Which supporter foil (SUPPORTER_FOILS order in supporter-foils.ts): 0 holo
// lattice, 1 cracked ice, 2 glitter, 3 sunburst, 4 caustics, 5 note rain,
// 6 scanline, 7 aurora. Every one is light laid over the card, white or a
// pale spectrum, so no foil recolours a card.
uniform float uFoilStyle;
// 0 leaves out the tier's own sparkle (triangles or stars), for the /supporter
// swatches that show a foil on its own; 1 on every card.
uniform float uTierLayer;
uniform float uStarfield;
uniform vec2 uLight;
uniform vec3 uTierColor;
// Color of the starfield's bright cores, and how much of the holo flow stays a
// full rainbow (lower values pull it toward the tier color).
uniform vec3 uStarTint;
uniform float uRainbow;
// A granted card floats an image where its tier would have drifted triangles
// or stars: the sprite, how large one copy is in grid cells (aspect baked in),
// how strongly it reads, and whether there is one at all.
uniform sampler2D uMotif;
uniform float uMotifOn;
uniform vec2 uMotifSize;
uniform float uMotifOpacity;
uniform vec4 uAvatarMask;
uniform vec2 uTextureSize;
uniform float uAvatarRadius;
// A second picture the foil dims over (a team card's flag); off the texture
// on every other card.
uniform vec4 uFlagMask;
uniform float uFlagRadius;
// The pack run's edition on this copy: 0 none, 1 foil, 2 holo, 3 polychrome.
// Laid over everything, the portrait included, and lit even on a common card.
uniform float uEdition;
varying vec2 vUv;

float roundedRectMaskPx(vec2 uv, vec4 rectUv, float radiusPx, vec2 textureSize) {
  vec2 p = uv * textureSize;
  vec2 rectMin = rectUv.xy * textureSize;
  vec2 rectSize = rectUv.zw * textureSize;
  vec2 center = rectMin + rectSize * 0.5;

  vec2 q = abs(p - center) - rectSize * 0.5 + vec2(radiusPx);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radiusPx;

  return 1.0 - smoothstep(0.0, 2.0, d);
}

vec3 screen(vec3 base, vec3 blend) {
  return 1.0 - (1.0 - base) * (1.0 - blend);
}

float random(vec2 value) {
  return fract(sin(dot(value, vec2(12.9898, 78.233))) * 43758.5453);
}

// Contribution of the triangle owned by grid cell id, evaluated in absolute
// grid space so a shape can extend past its own cell without being cut.
float triangleCell(vec2 p, vec2 id) {
  float variant = random(id);
  // Higher threshold than the old sliced version (0.22): whole triangles lit
  // by the 3x3 scan cover more area each, so fewer cells keep the overall
  // sparkle density where it was tuned.
  float sparse = step(0.5, variant);
  vec2 center = id + vec2(
    0.22 + random(id + vec2(7.1, 2.9)) * 0.58,
    0.18 + random(id + vec2(3.7, 9.4)) * 0.62
  );
  float scale = 0.44 + random(id + vec2(11.2, 5.8)) * 0.24;
  vec2 local = vec2((p.x - center.x) / scale, (p.y - center.y) / (scale * 1.18));
  float tri = max(abs(local.x) * 0.92 + local.y * 0.82, -local.y * 0.56);
  float shape = 1.0 - smoothstep(0.46, 0.51, tri);
  return shape * sparse * mix(0.45, 1.0, variant);
}

float triangleWave(vec2 uv, vec2 grid, float offset) {
  vec2 p = uv * grid;
  p.y -= offset;
  vec2 id = floor(p);
  // Triangles are larger than their cells, so a fragment can be covered by a
  // neighbor cell's shape. Scanning the 3x3 neighborhood keeps every triangle
  // whole instead of slicing it at the fract() cell boundary.
  float value = 0.0;
  for (int dy = -1; dy <= 1; dy += 1) {
    for (int dx = -1; dx <= 1; dx += 1) {
      value = max(value, triangleCell(p, id + vec2(float(dx), float(dy))));
    }
  }
  return value;
}

// Drifting, twinkling starfield (replaces the triangle flecks on World
// Class). One star at most per grid cell; the y distance is scaled by the
// card texture's 1000x1400 aspect so points stay round.
float starLayer(vec2 uv, vec2 grid, float drift, float time) {
  vec2 p = uv * grid;
  p.y -= drift;
  vec2 id = floor(p);
  float variant = random(id);
  float sparse = step(0.5, variant);
  vec2 center = vec2(
    0.18 + random(id + vec2(5.2, 1.7)) * 0.64,
    0.18 + random(id + vec2(8.4, 3.3)) * 0.64
  );
  vec2 offset = (fract(p) - center) / grid;
  offset.y *= 1.4;
  float dist = length(offset) * grid.x;
  float size = 0.030 + random(id + vec2(2.8, 6.1)) * 0.045;
  float core = 1.0 - smoothstep(size * 0.35, size, dist);
  float halo = exp(-dist * dist * 90.0) * 0.30;
  float twinkle = 0.30 + 0.70 * (0.5 + 0.5 * sin(time * (0.7 + variant * 1.8) + variant * 41.0));
  return (core + halo) * sparse * twinkle * mix(0.55, 1.0, random(id + vec2(9.9, 7.7)));
}

/* One copy of the motif, owned by grid cell id.

   A jittered grid, which is the one placement that is both even and unruly:
   every cell carries exactly one copy so no part of the card is left bare,
   and each copy roams most of its own cell, tilts, and takes its own size, so
   no two land in step. The triangles' rule (skip 42% of cells outright) is
   what this must not do - at fleck size a missing cell is sparkle, at picture
   size it is a hole.

   Returns the sampled pixel: rgb tints the glow, a is the shape. */
vec4 motifCell(vec2 p, vec2 id) {
  float variant = random(id);
  vec2 center = id + 0.5 + (vec2(
    random(id + vec2(7.1, 2.9)),
    random(id + vec2(3.7, 9.4))
  ) - 0.5) * 0.78;
  vec2 halfSize = uMotifSize * (0.76 + random(id + vec2(11.2, 5.8)) * 0.48) * 0.5;
  /* Cells are square in card pixels (1000/3 by 1400/4.2), so an angle here is
     a true rotation and not a shear. */
  float angle = (random(id + vec2(4.3, 8.9)) - 0.5) * 0.62;
  vec2 rel = p - center;
  vec2 turned = vec2(rel.x * cos(angle) + rel.y * sin(angle), rel.y * cos(angle) - rel.x * sin(angle));
  vec2 local = turned / max(halfSize, vec2(0.0001));
  if (abs(local.x) > 1.0 || abs(local.y) > 1.0) return vec4(0.0);
  /* Grid y and texture v both run up the card: the sprite texture is uploaded
     flipped (three's default), so v = 1 is the picture's top row, and local.y
     is +1 at the top of the quad. Negating either one lands the image on its
     head. */
  vec2 spriteUv = vec2(local.x, local.y) * 0.5 + 0.5;
  vec4 texel = texture2D(uMotif, spriteUv);
  /* Shape is alpha weighted by brightness, not alpha alone. A cut-out PNG is
     the motif this was built for and alpha carries it, but a photograph or any
     other fully opaque image has alpha 1 across the whole quad, and lighting
     that as-is would drift a glowing rectangle over the card instead of a
     picture. Luminance keeps its dark parts dark. */
  float luma = dot(texel.rgb, vec3(0.299, 0.587, 0.114));
  float shape = texel.a * (0.35 + 0.65 * luma);
  /* Strength varies per copy, but not so far that a faint one reads as a gap
     in the coverage. The colour stays the picture's own. */
  return vec4(texel.rgb, shape * mix(0.62, 1.0, variant));
}

/* Strongest copy covering this fragment. Same 3x3 neighbourhood scan as the
   triangles: a sprite is larger than its own cell, so a fragment can belong to
   a neighbour's shape. */
vec4 motifWave(vec2 uv, vec2 grid, float offset) {
  vec2 p = uv * grid;
  // up and to the right, the way the painted layer drifts
  p -= vec2(offset * 0.55, offset);
  vec2 id = floor(p);
  vec4 best = vec4(0.0);
  for (int dy = -1; dy <= 1; dy += 1) {
    for (int dx = -1; dx <= 1; dx += 1) {
      vec4 sampled = motifCell(p, id + vec2(float(dx), float(dy)));
      if (sampled.a > best.a) best = sampled;
    }
  }
  return best;
}

float roundedCardMask(vec2 uv) {
  vec2 halfSize = vec2(0.5, 0.5);
  float radius = 0.055;
  vec2 p = abs(uv - 0.5) - halfSize + vec2(radius);
  float d = length(max(p, 0.0)) + min(max(p.x, p.y), 0.0) - radius;
  return 1.0 - smoothstep(0.0, 0.006, d);
}

// A single foil beam projected along an arbitrary direction. axis is a unit
// vector; everything perpendicular to it shares the same band coordinate.
// center is the band offset along that axis (where the bright streak lies).
// Returns vec2(sharp, wide) - sharp is the bright specular core, wide is the
// rainbow halo around it.
vec2 beam(vec2 uv, vec2 axis, float center, float sharpFalloff, float wideFalloff) {
  float coord = dot(uv, axis);
  float d = coord - center;
  return vec2(exp(-d * d * sharpFalloff), exp(-d * d * wideFalloff));
}

/* The supporter foil's surface: a fine diamond lattice (the embossed grid a
   real holo sheet has) whose facets each catch the light at their own angle,
   so a few of them flash as the card tilts while the rest stay matte. Cells
   are square in card pixels. Returns vec2(lattice lines, facet glint). */
vec2 foilSurface(vec2 uv, vec2 light) {
  vec2 px = uv * uTextureSize / 14.0;
  vec2 diag = vec2(px.x + px.y, px.x - px.y) * 0.70710678;
  vec2 cell = floor(diag);
  vec2 f = abs(fract(diag) - 0.5);
  float line = smoothstep(0.40, 0.5, max(f.x, f.y));
  float facet = random(cell);
  float angle = facet * 6.28318 + light.x * 7.0 - light.y * 5.0;
  float glint = pow(max(0.0, cos(angle)), 40.0) * step(0.86, random(cell + vec2(3.1, 7.7)));
  return vec2(line, glint);
}

/* Cracked ice: the sheet is shattered into shards, each tilted its own way,
   so as the card turns whole shards flash at once and the cracks between
   them catch a thin line of light. Returns vec3(flash, edge, shard hue). */
vec3 crackedIce(vec2 uv, vec2 light) {
  vec2 p = uv * uTextureSize / 110.0;
  vec2 id = floor(p);
  float f1 = 8.0;
  float f2 = 8.0;
  vec2 best = id;
  for (int dy = -1; dy <= 1; dy += 1) {
    for (int dx = -1; dx <= 1; dx += 1) {
      vec2 cell = id + vec2(float(dx), float(dy));
      vec2 point = cell + 0.15 + 0.7 * vec2(random(cell), random(cell + vec2(4.1, 1.7)));
      float d = length(p - point);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        best = cell;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  float tilt = random(best + vec2(9.3, 2.2)) * 6.28318;
  float flash = pow(max(0.0, cos(tilt + light.x * 6.5 - light.y * 4.5)), 5.0);
  float edge = 1.0 - smoothstep(0.0, 0.06, f2 - f1);
  return vec3(flash, edge, random(best + vec2(1.3, 6.6)));
}

/* Glitter: a fine flake per 7px cell, each angled at random, so a scatter of
   points flares as the light crosses their angle and twinkles at rest. */
float glitter(vec2 uv, vec2 light, float time) {
  vec2 p = uv * uTextureSize / 7.0;
  vec2 id = floor(p);
  float angle = random(id) * 6.28318;
  float facing = cos(angle + light.x * 9.0 - light.y * 7.0 + sin(time * 0.6 + random(id + 3.3) * 6.28) * 0.35);
  float flare = smoothstep(0.94, 1.0, facing);
  vec2 local = fract(p) - 0.5;
  float point = 1.0 - smoothstep(0.1, 0.48, length(local));
  return flare * point * step(0.25, random(id + vec2(7.7, 0.4)));
}

/* Sunburst: rays fanning out from a point that follows the light, turning
   slowly, brightest near the source. */
float sunburst(vec2 uv, vec2 light, float time) {
  vec2 source = mix(vec2(0.5, 0.64), light, 0.55);
  vec2 rel = (uv - source) * vec2(1.0, 1.4);
  float angle = atan(rel.y, rel.x);
  float rays = pow(0.5 + 0.5 * cos(angle * 18.0 + time * 0.25 + light.x * 2.0), 5.0);
  float fine = pow(0.5 + 0.5 * cos(angle * 46.0 - time * 0.4), 9.0) * 0.5;
  float reach = exp(-length(rel) * 1.9);
  return (rays + fine) * reach;
}

/* Caustics: the rippling light at the bottom of a pool, run through a few
   rounds of warped sines. */
float caustics(vec2 uv, vec2 light, float time) {
  vec2 p = mod((uv + (light - 0.5) * 0.12) * vec2(1.0, 1.4) * 6.28318 * 1.1, 6.28318) - 250.0;
  vec2 i = p;
  float c = 1.0;
  for (int n = 0; n < 4; n += 1) {
    float t = time * 0.32 * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + t) / 0.005), p.y / (cos(i.y + t) / 0.005)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return clamp(pow(abs(c), 8.0), 0.0, 1.0);
}

/* Note rain: osu!mania notes falling down seven lanes, each catching the light
   as it passes through the beam. Returns vec2(note, lane). */
vec2 noteRain(vec2 uv, float time) {
  vec2 grid = vec2(7.0, 9.0);
  vec2 p = uv * grid;
  float lane = floor(p.x);
  p.y += time * (0.55 + random(vec2(lane, 3.0)) * 0.5);
  vec2 id = vec2(lane, floor(p.y));
  vec2 local = fract(p) - 0.5;
  float on = step(0.6, random(id + vec2(2.4, 8.1)));
  vec2 halfSize = vec2(0.36, 0.11);
  vec2 q = abs(local) - halfSize + 0.06;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.06;
  float note = (1.0 - smoothstep(0.0, 0.03, d)) * on;
  float across = fract(uv.x * grid.x);
  float rail = 1.0 - smoothstep(0.0, 0.025, min(across, 1.0 - across));
  return vec2(note, rail);
}

/* Scanline: fine CRT lines, a bright band rolling down the card, and now and
   then a slice of the band jumping sideways. Returns vec3(lines, band, slip). */
vec3 scanline(vec2 uv, float time) {
  float lines = 0.5 + 0.5 * sin(uv.y * uTextureSize.y * 1.5708);
  float head = 1.0 - fract(time * 0.11);
  float band = exp(-pow((uv.y - head) * 9.0, 2.0)) + exp(-pow((uv.y - head + 1.0) * 9.0, 2.0));
  float row = floor(uv.y * 46.0);
  float slip = step(0.965, random(vec2(row, floor(time * 7.0)))) * band;
  return vec3(lines, band, slip);
}

/* Aurora: soft curtains hanging from the top of the card, folding as they
   sway. */
float aurora(vec2 uv, float time) {
  float x = uv.x * 3.0 + sin(uv.y * 2.2 + time * 0.22) * 0.55;
  float folds = 0.5 + 0.5 * sin(x * 3.1 + time * 0.31) * sin(x * 1.7 - time * 0.17 + 1.3);
  float curtain = smoothstep(0.4, 0.95, folds);
  // Fine vertical rays along each fold, the way an aurora hangs in streaks.
  float streaks = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(x * 38.0 + sin(uv.y * 4.0 + time * 0.5) * 2.5), 2.0);
  float drape = smoothstep(0.02, 0.8, uv.y);
  return curtain * streaks * drape;
}

void main() {
  vec2 light = clamp(uLight, vec2(0.0), vec2(1.0));
  vec2 lightOffset = light - 0.5;
  float dist = distance(vUv, light);
  float glare = 1.0 - smoothstep(0.0, 0.58, dist);

  // Slow idle drift so the foil keeps shimmering even with no pointer input.
  float drift1 = sin(uTime * 0.35) * 0.18;
  float drift2 = cos(uTime * 0.27 + 1.3) * 0.18;

  /* A motif replaces the tier's own drifting layer rather than joining it, so
     both of those fade out by exactly as much as it fades in. That holds even
     for a palette card that keeps its stars: the ones it keeps are painted
     into the texture, and this layer on top of them read as blooming bubbles
     around every copy of the emblem rather than as dust behind it. */
  float patternGain = (1.0 - uMotifOn) * uTierLayer;

  /* A card shows triangles or stars, never both, and neither under a motif:
     the branches are uniform across the draw, so the hidden layer is skipped
     rather than computed and multiplied by zero. */
  bool showTriangles = patternGain > 0.0 && uStarfield < 0.5;
  bool showStars = patternGain > 0.0 && uStarfield >= 0.5;
  float triangles = 0.0;
  float stars = 0.0;
#if MC_MEDIUM
  if (showTriangles) triangles = triangleWave(vUv, vec2(6.0, 8.0), uTime * 0.07) * (1.0 - uStarfield) * patternGain;
  if (showStars) stars = starLayer(vUv, vec2(6.0, 8.0), uTime * 0.065, uTime) * uStarfield * patternGain;
#else
  // Twinkling sparkle layer (drifts slowly upward).
  if (showTriangles) {
    triangles = (triangleWave(vUv, vec2(7.0, 9.0), uTime * 0.09) * 0.58
              + triangleWave(vUv + vec2(0.19, 0.11), vec2(5.0, 7.0), uTime * 0.052) * 0.42)
              * (1.0 - uStarfield) * patternGain;
  }

  // Two star depths: the larger near layer drifts faster than the finer far
  // layer for a slow parallax.
  if (showStars) {
    stars = (starLayer(vUv, vec2(6.0, 8.0), uTime * 0.085, uTime)
          + starLayer(vUv + vec2(0.37, 0.21), vec2(10.0, 14.0), uTime * 0.04, uTime) * 0.65)
          * uStarfield * patternGain;
  }
#endif

  /* Drifts upward at the triangles' own pace on a coarser grid, because one
     copy of a picture is several times a fleck. Skipped outright when there is
     no motif: the branch is uniform across the draw, so it costs nothing on
     the cards that do not have one. */
  vec4 motifSample = uMotifOn > 0.5 ? motifWave(vUv, vec2(3.0, 4.2), uTime * 0.05) : vec4(0.0);
  float motif = motifSample.a * uMotifOn * uMotifOpacity;

  // Primary beam: nearly vertical, like a Pokemon card tilted under a lamp.
  // Axis points roughly down-right, so the band sweeps top-left to bottom-right.
  // Anchor center on the card's middle (0.5, 0.5) so the band passes through
  // the center at rest instead of drifting toward the bottom.
  vec2 axisA = normalize(vec2(0.30, 1.0));
  vec2 axisB = normalize(vec2(1.0, -0.55));
  float restA = 0.5 * (axisA.x + axisA.y);
  float centerA = restA + lightOffset.y * 0.55 + lightOffset.x * 0.20 + drift1;
  vec2 beamA = beam(vUv, axisA, centerA, 24.0, 5.0);

  /* The tier's beams. The holo lattice foil rides on them, so it switches
     them on for a supporter's common card too; every other foil brings its
     own light and leaves the beams to the tier. */
  float foilOn = max(uFoil, uSupporter * step(uFoilStyle, 0.5));

#if MC_MEDIUM
  float bandSharp = beamA.x * foilOn;
  float bandWide = beamA.y * foilOn;
#else
  // Secondary beam at a contrasting angle so the two cross when the card moves.
  float restB = 0.5 * (axisB.x + axisB.y);
  float centerB = restB + lightOffset.x * 0.55 - lightOffset.y * 0.25 + drift2;
  vec2 beamB = beam(vUv, axisB, centerB, 22.0, 4.5);

  float bandSharp = max(beamA.x, beamB.x * 0.7) * foilOn;
  float bandWide = max(beamA.y, beamB.y * 0.85) * foilOn;
#endif
  glare *= foilOn;

  // Hue scrolls along each beam direction so the rainbow visibly shifts as
  // the bands move - that's the Pokemon holo "color flow".
  float coordA = dot(vUv, axisA);
  float coordB = dot(vUv, axisB);
  float hueShift = coordA * 1.4 + coordB * 0.9 + uTime * 0.08 + light.x * 0.4 - light.y * 0.2;
  vec3 rainbow = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + hueShift));
  // Warm/monochrome tiers keep the moving bands but shed most of the spectrum,
  // otherwise the rainbow reads as a color cast over the tier's own palette.
  rainbow = mix(uTierColor * 1.5 + 0.12, rainbow, uRainbow);

  /* Supporter foil, in the style the supporter picked. The holo lattice (0)
     is not more holo but a finer one: inside the same beams the one broad
     rainbow is swapped for a pastel spectrum several bands per card width that
     slides with the light, and the sheet gets a texture, the lattice plus the
     odd facet glinting at its own angle. The others (the functions above main)
     leave the tier's beams as they are and add their own light, brightest
     where the sheen follows the light. Spared on every other card by the
     uniforms, which are constant per draw. */
  float foilGrain = 1.0;
  vec3 supporterFoil = vec3(0.0);
  float supporterAlpha = 0.0;
  if (uSupporter > 0.5) {
    vec2 sheenBeam = beam(vUv, axisA, centerA, 24.0, 1.4);
    float sheen = 0.12 + 0.88 * sheenBeam.y;
    float fineHue = coordA * 4.2 - coordB * 1.6 + light.x * 1.5 - light.y * 1.1 + uTime * 0.03;
    vec3 spectrum = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + fineHue));
    spectrum = mix(vec3(0.94), spectrum, 0.62);
    // Pale light for the foils that are not a spectrum: white with a little colour, so it reads on every tier, gold included.
    vec3 paleLight = mix(vec3(1.0), spectrum, 0.35);
    if (uFoilStyle < 0.5) {
      vec2 surface = foilSurface(vUv, light);
      rainbow = spectrum;
      foilGrain = 0.74 + 0.26 * surface.x;
      supporterFoil = spectrum * sheen * foilGrain * 0.16 + vec3(surface.y * (0.25 + 0.75 * sheen) * 0.55);
      supporterAlpha = sheen * foilGrain * 0.05 + surface.y * (0.25 + 0.75 * sheen) * 0.14;
    } else if (uFoilStyle < 1.5) {
      vec3 ice = crackedIce(vUv, light);
      vec3 shardHue = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + ice.z + fineHue * 0.35));
      shardHue = mix(vec3(0.95), shardHue, 0.5);
      float lit = ice.x * (0.45 + 0.55 * sheen);
      supporterFoil = shardHue * lit * 0.9 + vec3(ice.y * (0.4 + 0.6 * sheen) * 0.8);
      supporterAlpha = lit * 0.32 + ice.y * (0.3 + 0.7 * sheen) * 0.22;
    } else if (uFoilStyle < 2.5) {
      float flake = glitter(vUv, light, uTime);
      supporterFoil = mix(vec3(1.0), spectrum, 0.45) * flake * 1.4;
      supporterAlpha = flake * (0.55 + 0.45 * sheen);
    } else if (uFoilStyle < 3.5) {
      float rays = sunburst(vUv, light, uTime);
      vec2 rel = (vUv - mix(vec2(0.5, 0.64), light, 0.55)) * vec2(1.0, 1.4);
      vec3 rayHue = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + atan(rel.y, rel.x) * 0.32 + uTime * 0.02));
      rayHue = mix(vec3(0.96), rayHue, 0.4);
      supporterFoil = rayHue * rays * 1.1;
      supporterAlpha = rays * 0.42;
    } else if (uFoilStyle < 4.5) {
      float ripple = caustics(vUv, light, uTime);
      supporterFoil = paleLight * ripple * (0.8 + 0.5 * sheen);
      supporterAlpha = ripple * (0.3 + 0.2 * sheen);
    } else if (uFoilStyle < 5.5) {
      vec2 rain = noteRain(vUv, uTime);
      float lit = rain.x * (0.45 + 0.55 * sheen);
      supporterFoil = mix(paleLight, spectrum, 0.5) * lit * 1.1 + vec3(rain.y * 0.3);
      supporterAlpha = lit * 0.42 + rain.y * 0.06;
    } else if (uFoilStyle < 6.5) {
      vec3 scan = scanline(vUv, uTime);
      float split = scan.y * 0.012 + scan.z * 0.03;
      vec3 fringe = vec3(
        0.5 + 0.5 * sin((vUv.y + split) * uTextureSize.y * 1.5708),
        scan.x,
        0.5 + 0.5 * sin((vUv.y - split) * uTextureSize.y * 1.5708)
      );
      float lines = scan.x * (0.45 + 0.55 * sheen);
      supporterFoil = mix(vec3(1.0), fringe, 0.6) * (lines * 0.35 + scan.y * 0.7 + scan.z * 0.8);
      supporterAlpha = lines * 0.09 + scan.y * 0.22 + scan.z * 0.3;
    } else {
      float veil = aurora(vUv, uTime);
      vec3 veilHue = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + vUv.x * 0.6 + vUv.y * 0.25 + uTime * 0.015));
      veilHue = mix(vec3(1.0), veilHue, 0.55);
      supporterFoil = veilHue * veil * (0.9 + 0.4 * sheen);
      supporterAlpha = veil * (0.34 + 0.14 * sheen);
    }
    // Every foil but the lattice (which has the tier's beams) also gets a
    // soft pale sheen following the light, since a foil sheet is foil edge to edge.
    if (uFoilStyle > 0.5) {
      float glow = sheenBeam.y;
      supporterFoil += mix(vec3(1.0), spectrum, 0.5) * glow * 0.35;
      supporterAlpha += glow * 0.07;
    }
  }

  // Holo: tier-tinted rainbow, lit only where the bands pass.
  vec3 holo = screen(uTierColor * 0.42, rainbow * 0.85)
              * (triangles * 0.32 + stars * 0.30 + motif * 0.30 + bandWide * 0.75 + 0.10)
              * foilGrain;

  // Specular streak (white core along the beam).
  vec3 sweep = vec3(bandSharp * 0.62 + glare * 0.22);

  // Tinted star cores so the starfield reads as light points rather than
  // rainbow blobs.
  vec3 starGlow = uStarTint * stars * 0.55;

  // The motif lights in its own colours, pulled a little toward the tier's
  // star tint so a garish picture still belongs to the card it floats on.
  vec3 motifGlow = mix(uStarTint, motifSample.rgb, 0.78) * motif * 0.5;

  float inAvatar = max(
    roundedRectMaskPx(vUv, uAvatarMask, uAvatarRadius, uTextureSize),
    roundedRectMaskPx(vUv, uFlagMask, uFlagRadius, uTextureSize)
  );
  float foilGain = mix(1.0, 0.30, inAvatar);
  // The supporter's foil stops at the picture: rays or notes over a face read as a smudge on it.
  float supporterGain = 1.0 - inAvatar;
  float mask = roundedCardMask(vUv);

  vec3 color = (holo + sweep + starGlow + motifGlow) * foilGain + supporterFoil * supporterGain;
  float alpha = clamp(
    (triangles * 0.12 + stars * 0.40 + motif * 0.34 + bandWide * 0.30 + bandSharp * 0.26 + glare * 0.12) * foilGain * uIntensity
      + supporterAlpha * supporterGain * uIntensity,
    0.0,
    0.55 + uSupporter * 0.05
  ) * mask;

  if (uEdition > 0.5) {
    // Read off the unscaled beam so a common card's edition still moves.
    float edBand = beamA.y;
    vec3 edColor;
    float edAlpha;
    if (uEdition < 1.5) {
      // Foil: a cold metallic wash with fine brushed lines that catch the beam.
      float brushed = 0.5 + 0.5 * sin(coordA * 220.0 + coordB * 14.0);
      float sheen = 0.22 + edBand * 0.95 + beamA.x * 0.6 + brushed * 0.10;
      edColor = mix(vec3(0.62, 0.74, 0.95), vec3(1.0), clamp(beamA.x, 0.0, 1.0)) * sheen;
      edAlpha = 0.16 + sheen * 0.24;
    } else if (uEdition < 2.5) {
      // Holo: a full spectrum in fine diagonal stripes, whatever the tier.
      vec3 spectrum = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + hueShift * 1.6));
      float stripes = 0.5 + 0.5 * sin(coordA * 110.0 + hueShift * 9.0);
      edColor = spectrum * (0.55 + stripes * 0.55);
      edAlpha = 0.12 + stripes * 0.18 + edBand * 0.30;
    } else {
      // Polychrome: the whole card cycles through hues in broad soft bands.
      vec3 poly = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + vUv.x * 0.9 - vUv.y * 0.7 + uTime * 0.12 + light.x * 0.3));
      edColor = mix(poly, vec3(1.0), edBand * 0.35);
      edAlpha = 0.28 + edBand * 0.22;
    }
    float edWeight = clamp(edAlpha * 1.4, 0.0, 1.0);
    color = mix(color, edColor, edWeight);
    alpha = max(alpha, clamp(edAlpha * uIntensity, 0.0, 0.62) * mask);
  }
  gl_FragColor = vec4(color, alpha);
}
`;

/* A supporter's painted doodles, drifting between the card's background and
   everything printed on it (ManiaCardRenderer stacks the meshes). The same
   jittered grid and drift as the overlay's motifWave, but drawn as paint: the
   sprite's own colour at its own alpha, not light. */
export const cardMotifPaintFragmentShader = `
precision highp float;

uniform float uTime;
uniform sampler2D uMotif;
uniform vec2 uMotifSize;
uniform float uMotifOpacity;
varying vec2 vUv;

float random(vec2 value) {
  return fract(sin(dot(value, vec2(12.9898, 78.233))) * 43758.5453);
}

vec4 paintCell(vec2 p, vec2 id) {
  float variant = random(id);
  vec2 center = id + 0.5 + (vec2(random(id + vec2(7.1, 2.9)), random(id + vec2(3.7, 9.4))) - 0.5) * 0.78;
  vec2 halfSize = uMotifSize * (0.76 + random(id + vec2(11.2, 5.8)) * 0.48) * 0.5;
  // a slow sway on top of each copy's own tilt, so the drift is not rigid
  float angle = (random(id + vec2(4.3, 8.9)) - 0.5) * 0.62 + sin(uTime * 0.6 + variant * 6.28) * 0.08;
  vec2 rel = p - center;
  vec2 turned = vec2(rel.x * cos(angle) + rel.y * sin(angle), rel.y * cos(angle) - rel.x * sin(angle));
  vec2 local = turned / max(halfSize, vec2(0.0001));
  if (abs(local.x) > 1.0 || abs(local.y) > 1.0) return vec4(0.0);
  vec4 texel = texture2D(uMotif, local * 0.5 + 0.5);
  return vec4(texel.rgb, texel.a * mix(0.85, 1.0, variant));
}

float roundedCardMask(vec2 uv) {
  vec2 p = abs(uv - 0.5) - vec2(0.5) + vec2(0.055);
  float d = length(max(p, 0.0)) + min(max(p.x, p.y), 0.0) - 0.055;
  return 1.0 - smoothstep(0.0, 0.006, d);
}

void main() {
  float offset = uTime * 0.05;
  vec2 p = vUv * vec2(3.0, 4.2) - vec2(offset * 0.55, offset);
  vec2 id = floor(p);
  vec4 best = vec4(0.0);
  for (int dy = -1; dy <= 1; dy += 1) {
    for (int dx = -1; dx <= 1; dx += 1) {
      vec4 sampled = paintCell(p, id + vec2(float(dx), float(dy)));
      if (sampled.a > best.a) best = sampled;
    }
  }
  gl_FragColor = vec4(best.rgb, best.a * uMotifOpacity * roundedCardMask(vUv));
}
`;
