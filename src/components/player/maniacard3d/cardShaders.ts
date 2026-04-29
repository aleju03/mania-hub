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
uniform vec2 uLight;
uniform vec3 uTierColor;
uniform vec4 uAvatarMask;
varying vec2 vUv;

vec3 screen(vec3 base, vec3 blend) {
  return 1.0 - (1.0 - base) * (1.0 - blend);
}

float triangleWave(vec2 uv, float offset) {
  vec2 grid = vec2(9.0, 12.0);
  vec2 cell = fract(vec2(uv.x * grid.x, uv.y * grid.y + offset));
  float tri = max(abs(cell.x - 0.5) * 1.45 + (cell.y - 0.16) * 1.55, cell.y * 0.18);
  return 1.0 - smoothstep(0.42, 0.48, tri);
}

float roundedCardMask(vec2 uv) {
  vec2 halfSize = vec2(0.5, 0.5);
  float radius = 0.055;
  vec2 p = abs(uv - 0.5) - halfSize + vec2(radius);
  float d = length(max(p, 0.0)) + min(max(p.x, p.y), 0.0) - radius;
  return 1.0 - smoothstep(0.0, 0.006, d);
}

void main() {
  vec2 light = clamp(uLight, vec2(0.0), vec2(1.0));
  float dist = distance(vUv, light);
  float glare = 1.0 - smoothstep(0.0, 0.58, dist);
  float triangles = triangleWave(vUv, uTime * 0.08);
  float softFoil = smoothstep(0.2, 0.9, vUv.x * 0.72 + (1.0 - vUv.y) * 0.34 + light.x * 0.18);
  vec3 rainbow = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + vUv.x * 0.35 + vUv.y * 0.22));
  vec3 holo = screen(uTierColor * 0.42, rainbow * 0.58) * (triangles * 0.42 + softFoil * 0.18);

  vec2 avatarMin = uAvatarMask.xy;
  vec2 avatarMax = uAvatarMask.xy + uAvatarMask.zw;
  float inAvatar = step(avatarMin.x, vUv.x) * step(avatarMin.y, vUv.y) * step(vUv.x, avatarMax.x) * step(vUv.y, avatarMax.y);
  float avatarShine = inAvatar * glare * 0.18;
  float mask = roundedCardMask(vUv);

  vec3 color = holo * (0.24 + glare * 0.34) + vec3(glare * 0.18) + vec3(avatarShine);
  float alpha = clamp((triangles * 0.12 + glare * 0.18 + avatarShine) * uIntensity, 0.0, 0.42) * mask;
  gl_FragColor = vec4(color, alpha);
}
`;
