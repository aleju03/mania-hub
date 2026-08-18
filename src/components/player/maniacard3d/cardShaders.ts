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
  p.y -= offset;
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

void main() {
  vec2 light = clamp(uLight, vec2(0.0), vec2(1.0));
  vec2 lightOffset = light - 0.5;
  float dist = distance(vUv, light);
  float glare = 1.0 - smoothstep(0.0, 0.58, dist);

  // Slow idle drift so the foil keeps shimmering even with no pointer input.
  float drift1 = sin(uTime * 0.35) * 0.18;
  float drift2 = cos(uTime * 0.27 + 1.3) * 0.18;

  // A motif replaces the tier's own drifting layer rather than joining it, so
  // both of those fade out by exactly as much as it fades in.
  float patternGain = 1.0 - uMotifOn;

#if MC_MEDIUM
  float triangles = triangleWave(vUv, vec2(6.0, 8.0), uTime * 0.07) * (1.0 - uStarfield) * patternGain;
  float stars = starLayer(vUv, vec2(6.0, 8.0), uTime * 0.065, uTime) * uStarfield * patternGain;
#else
  // Twinkling sparkle layer (drifts slowly upward).
  float triangles = (triangleWave(vUv, vec2(7.0, 9.0), uTime * 0.09) * 0.58
                  + triangleWave(vUv + vec2(0.19, 0.11), vec2(5.0, 7.0), uTime * 0.052) * 0.42)
                  * (1.0 - uStarfield);

  // Two star depths: the larger near layer drifts faster than the finer far
  // layer for a slow parallax.
  float stars = (starLayer(vUv, vec2(6.0, 8.0), uTime * 0.085, uTime)
              + starLayer(vUv + vec2(0.37, 0.21), vec2(10.0, 14.0), uTime * 0.04, uTime) * 0.65)
              * uStarfield;

  triangles *= patternGain;
  stars *= patternGain;
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

#if MC_MEDIUM
  float bandSharp = beamA.x * uFoil;
  float bandWide = beamA.y * uFoil;
#else
  // Secondary beam at a contrasting angle so the two cross when the card moves.
  float restB = 0.5 * (axisB.x + axisB.y);
  float centerB = restB + lightOffset.x * 0.55 - lightOffset.y * 0.25 + drift2;
  vec2 beamB = beam(vUv, axisB, centerB, 22.0, 4.5);

  float bandSharp = max(beamA.x, beamB.x * 0.7) * uFoil;
  float bandWide = max(beamA.y, beamB.y * 0.85) * uFoil;
#endif
  glare *= uFoil;

  // Hue scrolls along each beam direction so the rainbow visibly shifts as
  // the bands move - that's the Pokemon holo "color flow".
  float coordA = dot(vUv, axisA);
  float coordB = dot(vUv, axisB);
  float hueShift = coordA * 1.4 + coordB * 0.9 + uTime * 0.08 + light.x * 0.4 - light.y * 0.2;
  vec3 rainbow = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + hueShift));
  // Warm/monochrome tiers keep the moving bands but shed most of the spectrum,
  // otherwise the rainbow reads as a color cast over the tier's own palette.
  rainbow = mix(uTierColor * 1.5 + 0.12, rainbow, uRainbow);

  // Holo: tier-tinted rainbow, lit only where the bands pass.
  vec3 holo = screen(uTierColor * 0.42, rainbow * 0.85)
              * (triangles * 0.32 + stars * 0.30 + motif * 0.30 + bandWide * 0.75 + 0.10);

  // Specular streak (white core along the beam).
  vec3 sweep = vec3(bandSharp * 0.62 + glare * 0.22);

  // Tinted star cores so the starfield reads as light points rather than
  // rainbow blobs.
  vec3 starGlow = uStarTint * stars * 0.55;

  // The motif lights in its own colours, pulled a little toward the tier's
  // star tint so a garish picture still belongs to the card it floats on.
  vec3 motifGlow = mix(uStarTint, motifSample.rgb, 0.78) * motif * 0.5;

  float inAvatar = roundedRectMaskPx(vUv, uAvatarMask, uAvatarRadius, uTextureSize);
  float foilGain = mix(1.0, 0.30, inAvatar);
  float mask = roundedCardMask(vUv);

  vec3 color = (holo + sweep + starGlow + motifGlow) * foilGain;
  float alpha = clamp(
    (triangles * 0.12 + stars * 0.40 + motif * 0.34 + bandWide * 0.30 + bandSharp * 0.26 + glare * 0.12) * foilGain * uIntensity,
    0.0,
    0.55
  ) * mask;
  gl_FragColor = vec4(color, alpha);
}
`;
