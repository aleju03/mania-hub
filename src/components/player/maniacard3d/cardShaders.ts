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
uniform vec2 uLight;
uniform vec3 uTierColor;
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

float triangleWave(vec2 uv, vec2 grid, float offset) {
  vec2 p = uv * grid;
  p.y -= offset;
  vec2 id = floor(p);
  float variant = random(id);
  float sparse = step(0.22, variant);
  vec2 center = vec2(
    0.22 + random(id + vec2(7.1, 2.9)) * 0.58,
    0.18 + random(id + vec2(3.7, 9.4)) * 0.62
  );
  vec2 cell = fract(p);
  float scale = 0.44 + random(id + vec2(11.2, 5.8)) * 0.24;
  vec2 local = vec2((cell.x - center.x) / scale, (cell.y - center.y) / (scale * 1.18));
  float tri = max(abs(local.x) * 0.92 + local.y * 0.82, -local.y * 0.56);
  float shape = 1.0 - smoothstep(0.46, 0.51, tri);
  return shape * sparse * mix(0.45, 1.0, variant);
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

  // Twinkling sparkle layer (drifts slowly upward).
  float triangles = triangleWave(vUv, vec2(7.0, 9.0), uTime * 0.09) * 0.58
                  + triangleWave(vUv + vec2(0.19, 0.11), vec2(5.0, 7.0), uTime * 0.052) * 0.42;

  // Primary beam: nearly vertical, like a Pokemon card tilted under a lamp.
  // Axis points roughly down-right, so the band sweeps top-left to bottom-right.
  // Anchor center on the card's middle (0.5, 0.5) so the band passes through
  // the center at rest instead of drifting toward the bottom.
  vec2 axisA = normalize(vec2(0.30, 1.0));
  float restA = 0.5 * (axisA.x + axisA.y);
  float centerA = restA + lightOffset.y * 0.55 + lightOffset.x * 0.20 + drift1;
  vec2 beamA = beam(vUv, axisA, centerA, 24.0, 5.0);

  // Secondary beam at a contrasting angle so the two cross when the card moves.
  vec2 axisB = normalize(vec2(1.0, -0.55));
  float restB = 0.5 * (axisB.x + axisB.y);
  float centerB = restB + lightOffset.x * 0.55 - lightOffset.y * 0.25 + drift2;
  vec2 beamB = beam(vUv, axisB, centerB, 22.0, 4.5);

  float bandSharp = max(beamA.x, beamB.x * 0.7) * uFoil;
  float bandWide = max(beamA.y, beamB.y * 0.85) * uFoil;
  glare *= uFoil;

  // Hue scrolls along each beam direction so the rainbow visibly shifts as
  // the bands move - that's the Pokemon holo "color flow".
  float coordA = dot(vUv, axisA);
  float coordB = dot(vUv, axisB);
  float hueShift = coordA * 1.4 + coordB * 0.9 + uTime * 0.08 + light.x * 0.4 - light.y * 0.2;
  vec3 rainbow = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + hueShift));

  // Holo: tier-tinted rainbow, lit only where the bands pass.
  vec3 holo = screen(uTierColor * 0.42, rainbow * 0.85)
              * (triangles * 0.32 + bandWide * 0.75 + 0.10);

  // Specular streak (white core along the beam).
  vec3 sweep = vec3(bandSharp * 0.62 + glare * 0.22);

  float inAvatar = roundedRectMaskPx(vUv, uAvatarMask, uAvatarRadius, uTextureSize);
  float foilGain = mix(1.0, 0.30, inAvatar);
  float mask = roundedCardMask(vUv);

  vec3 color = (holo + sweep) * foilGain;
  float alpha = clamp(
    (triangles * 0.12 + bandWide * 0.30 + bandSharp * 0.26 + glare * 0.12) * foilGain * uIntensity,
    0.0,
    0.55
  ) * mask;
  gl_FragColor = vec4(color, alpha);
}
`;
