import { Color, LinearSRGBColorSpace, ShaderMaterial, Vector3, type Material, type Mesh, type Object3D } from "three";

/* Cel shading for companion models exported from Blender with toon settings
   in their material extras (material.userData.toon in three.js): two bands
   split on N.L, a cool shadow tint, a rim sliver on the shadow side and a
   narrow highlight band. It uses the model's own baked light direction, not
   the scene's lights, so the look matches the Blender render. Outline shells
   (extras.outline) are unlit already; they only skip tone mapping so their
   line colours come out exact. Ported from the 3d-modelling repo's
   tools/web/toon.js. */

interface ToonParams {
  shadow_tint: [number, number, number];
  shadow_at: number;
  hi_at: number;
  hi_mix: number;
  rim_at: number;
  rim_mix: number;
  light_dir: [number, number, number];
  light_gain: number;
}

const vertexShader = /* glsl */ `
  #include <common>
  #include <color_pars_vertex>
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    #include <color_vertex>
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <color_pars_fragment>
  uniform vec3 lightDir;     // world space, pointing toward the light
  uniform float lightGain;
  uniform vec3 shadowTint;   // linear
  uniform float shadowAt, hiAt, hiMix, rimAt, rimMix;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vec3 base = vColor.rgb;
    vec3 N = normalize(vN);
    if (!gl_FrontFacing) N = -N;
    vec3 L = normalize((viewMatrix * vec4(lightDir, 0.0)).xyz);
    float v = max(dot(N, L), 0.0) * lightGain;
    float lit = step(shadowAt, v);
    float hi = step(hiAt, v);
    float facing = 1.0 - abs(dot(N, normalize(vV)));
    float rim = step(rimAt, facing) * (1.0 - lit) * rimMix;
    vec3 c = mix(base * shadowTint, base, lit);
    c = mix(c, base, rim);
    c = mix(c, mix(base, vec3(1.0), hiMix), hi);
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
  }
`;

function isToonParams(value: unknown): value is ToonParams {
  const p = value as Partial<ToonParams> | null;
  return !!p && Array.isArray(p.shadow_tint) && Array.isArray(p.light_dir) && typeof p.shadow_at === "number" && typeof p.light_gain === "number";
}

function toonMaterial(p: ToonParams): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    vertexColors: true,
    uniforms: {
      lightDir: { value: new Vector3(...p.light_dir).normalize() },
      lightGain: { value: p.light_gain },
      shadowTint: { value: new Color().setRGB(...p.shadow_tint, LinearSRGBColorSpace) },
      shadowAt: { value: p.shadow_at },
      hiAt: { value: p.hi_at },
      hiMix: { value: p.hi_mix },
      rimAt: { value: p.rim_at },
      rimMix: { value: p.rim_mix },
    },
  });
}

/* Swaps every toon-tagged material under `root` for the cel shader; a model
   without toon extras is left as it was. */
export function applyCompanionToon(root: Object3D): void {
  const swapped = new Map<Material, Material>();
  const swap = (material: Material): Material => {
    if (material.userData?.outline) {
      material.toneMapped = false;
      return material;
    }
    const params = material.userData?.toon;
    if (!isToonParams(params)) return material;
    let toon = swapped.get(material);
    if (!toon) {
      toon = toonMaterial(params);
      swapped.set(material, toon);
      material.dispose();
    }
    return toon;
  };
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => swap(m as Material)) : swap(mesh.material as Material);
  });
}
