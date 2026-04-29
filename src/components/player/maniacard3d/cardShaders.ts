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

float diagonalBands(vec2 uv, float offset) {
  float coord = uv.x * 1.25 + uv.y * 0.72 + offset;
  return smoothstep(0.08, 0.16, fract(coord * 8.0)) * (1.0 - smoothstep(0.18, 0.34, fract(coord * 8.0)));
}

void main() {
  vec2 light = clamp(uLight, vec2(0.0), vec2(1.0));
  float dist = distance(vUv, light);
  float glare = 1.0 - smoothstep(0.0, 0.62, dist);
  float bands = diagonalBands(vUv, uTime * 0.035 + light.x * 0.22);
  vec3 rainbow = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + vUv.x + vUv.y + uTime * 0.025));
  vec3 holo = screen(uTierColor * 0.55, rainbow) * bands;

  vec2 avatarMin = uAvatarMask.xy;
  vec2 avatarMax = uAvatarMask.xy + uAvatarMask.zw;
  float inAvatar = step(avatarMin.x, vUv.x) * step(avatarMin.y, vUv.y) * step(vUv.x, avatarMax.x) * step(vUv.y, avatarMax.y);
  float avatarShine = inAvatar * glare * 0.28;

  vec3 color = holo * (0.32 + glare * 0.72) + vec3(glare * 0.42) + vec3(avatarShine);
  float alpha = clamp((bands * 0.22 + glare * 0.28 + avatarShine) * uIntensity, 0.0, 0.72);
  gl_FragColor = vec4(color, alpha);
}
`;
