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
  vec2 local = vec2((cell.x - center.x) / scale, (cell.y - center.y) / (scale * 0.88));
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

void main() {
  vec2 light = clamp(uLight, vec2(0.0), vec2(1.0));
  float dist = distance(vUv, light);
  float glare = 1.0 - smoothstep(0.0, 0.58, dist);
  float triangles = triangleWave(vUv, vec2(7.0, 9.0), uTime * 0.09) * 0.58 + triangleWave(vUv + vec2(0.19, 0.11), vec2(5.0, 7.0), uTime * 0.052) * 0.42;
  float softFoil = smoothstep(0.2, 0.9, vUv.x * 0.72 + (1.0 - vUv.y) * 0.34 + light.x * 0.18);
  vec3 rainbow = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + vUv.x * 0.35 + vUv.y * 0.22));
  vec3 holo = screen(uTierColor * 0.42, rainbow * 0.58) * (triangles * 0.42 + softFoil * 0.18);

  vec2 avatarMin = uAvatarMask.xy;
  vec2 avatarMax = uAvatarMask.xy + uAvatarMask.zw;
  float inAvatar = step(avatarMin.x, vUv.x) * step(avatarMin.y, vUv.y) * step(vUv.x, avatarMax.x) * step(vUv.y, avatarMax.y);
  float avatarShine = inAvatar * glare * 0.18;
  float contentMask = 1.0 - inAvatar;
  float mask = roundedCardMask(vUv);

  vec3 color = (holo * (0.24 + glare * 0.34) + vec3(glare * 0.18)) * contentMask + vec3(avatarShine);
  float alpha = clamp((triangles * 0.12 + glare * 0.18) * contentMask * uIntensity + avatarShine, 0.0, 0.42) * mask;
  gl_FragColor = vec4(color, alpha);
}
`;
