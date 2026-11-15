import {
  Color,
  CustomBlending,
  DoubleSide,
  LinearSRGBColorSpace,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Quaternion,
  ShaderMaterial,
  Vector3,
  type Material,
  type Mesh,
  type Object3D,
} from "three";

/* Materials and motion for companion models exported from Blender (the
   3d-modelling repo's tools/web_export.py), read from their glTF extras
   (userData in three.js).

   Toon materials (extras.toon) get cel shading: two bands split on N.L, a
   cool shadow tint, a rim sliver on the shadow side and a narrow highlight
   band. It uses the model's own baked light direction, not the scene's
   lights, so the look matches the Blender render. Outline shells
   (extras.outline) are unlit already; they only skip tone mapping so their
   line colours come out exact. Ported from tools/web/toon.js.

   A fairy is light, not a surface. Its light shell (extras.light) is one
   sphere whose shader reads each pixel's distance from the centre off the
   view angle: a white-hot orb that takes the fairy's colour toward its edge,
   then a glow fading smoothly to nothing at the shell's outline. Its wings
   (extras.wing) are near-clear sheets whose vertex colours carry wing
   coordinates, from which the shader draws a pixel-thin rim and faint veins.
   Both write premultiplied colour, so they blend the same over a dark cover
   or a bright one and in a thumbnail. The wings draw first and the light
   over them, hiding their roots.

   Motion is data too (companionMotion): wings beat about their roots
   (extras.flap on their nodes), a node can ask the whole model to hover
   (extras.hover), and a light breathes (extras.light.breathe). */

type Vec3 = [number, number, number];

interface ToonParams {
  shadow_tint: Vec3;
  shadow_at: number;
  hi_at: number;
  hi_mix: number;
  rim_at: number;
  rim_mix: number;
  light_dir: Vec3;
  light_gain: number;
}

interface LightParams {
  core: Vec3;
  edge: Vec3;
  glow: Vec3;
  glow_outer: Vec3;
  orb: number;
  glow_alpha: number;
  breathe?: { amount: number; period: number };
}

interface WingParams {
  root: Vec3;
  tip: Vec3;
  rim: Vec3;
  vein: Vec3;
  alpha: number;
  rim_alpha: number;
  vein_alpha: number;
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

const lightFragmentShader = /* glsl */ `
  uniform vec3 core, edge, glow, glowOuter;   // linear
  uniform float orb;         // orb radius over shell radius
  uniform float glowAlpha, breath;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    // distance from the centre over the shell radius: 0 facing the camera, 1 at the outline
    float facing = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
    float r = sqrt(1.0 - facing * facing);
    float x = r / orb;
    float body = 1.0 - smoothstep(0.86, 1.04, x);
    vec3 bodyColor = mix(core, edge, smoothstep(0.35, 1.0, x));
    float t = clamp((r - orb * 0.9) / (1.0 - orb * 0.9), 0.0, 1.0);
    float halo = glowAlpha * (1.0 + breath) * pow(1.0 - t, 1.4);
    vec3 haloColor = mix(glow, glowOuter, smoothstep(0.0, 0.8, t));
    vec3 b = linearToOutputTexel(vec4(bodyColor, 1.0)).rgb;
    vec3 h = linearToOutputTexel(vec4(haloColor, 1.0)).rgb;
    float under = 1.0 - body;
    gl_FragColor = vec4(b * body + h * halo * under, body + halo * under);
  }
`;

const wingVertexShader = /* glsl */ `
  #include <common>
  #include <color_pars_vertex>
  void main() {
    #include <color_vertex>
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const wingFragmentShader = /* glsl */ `
  #include <common>
  #include <color_pars_fragment>
  uniform vec3 rootColor, tipColor, rimColor, veinColor;   // linear
  uniform float alpha, rimAlpha, veinAlpha;
  // a line about a pixel wide where x crosses at, whatever the wing's size on screen
  float line(float x, float at, float width) {
    float d = abs(x - at) / max(fwidth(x), 1e-4);
    return 1.0 - smoothstep(width, width + 1.0, d);
  }
  vec4 layer(vec3 color, float a) {
    return vec4(linearToOutputTexel(vec4(color, 1.0)).rgb * a, a);
  }
  vec4 over(vec4 top, vec4 under) {
    return top + under * (1.0 - top.a);
  }
  void main() {
    float s = vColor.r;                  // 0 mid-wing, 1 on the outline
    float along = vColor.g;              // 0 at the root, 1 at the tip
    float across = vColor.b * 2.0 - 1.0; // 0 on the midline, 1 on the leading edge
    float rim = 1.0 - smoothstep(1.0, 2.0, (1.0 - s) / max(fwidth(s), 1e-4));
    float veins = max(line(across, 0.0, 0.35), 0.7 * line(across, 0.55, 0.25))
      * smoothstep(0.08, 0.22, along) * (1.0 - smoothstep(0.55, 0.9, along));
    vec3 tint = mix(rootColor, tipColor, smoothstep(0.15, 0.95, along));
    vec4 c = layer(tint, alpha * (0.45 + 0.55 * smoothstep(0.25, 1.0, s)));
    c = over(layer(veinColor, veinAlpha * veins), c);
    c = over(layer(rimColor, rimAlpha * rim), c);
    gl_FragColor = c;
  }
`;

/* Premultiplied colour over whatever is drawn; the separate alpha factors keep
   the transparent canvas's alpha right. */
const premultiplied = {
  transparent: true,
  depthWrite: false,
  blending: CustomBlending,
  blendSrc: OneFactor,
  blendDst: OneMinusSrcAlphaFactor,
  blendSrcAlpha: OneFactor,
  blendDstAlpha: OneMinusSrcAlphaFactor,
};

/* Light materials made here: they draw last, and they breathe. */
const lights = new WeakSet<object>();
const materialsOf = (mesh: Mesh) => ([] as Material[]).concat((mesh.material ?? []) as Material | Material[]);

const isVec3 = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number");
const linear = (rgb: Vec3) => new Color().setRGB(...rgb, LinearSRGBColorSpace);

function isToonParams(value: unknown): value is ToonParams {
  const p = value as Partial<ToonParams> | null;
  return !!p && Array.isArray(p.shadow_tint) && Array.isArray(p.light_dir) && typeof p.shadow_at === "number" && typeof p.light_gain === "number";
}

function isLightParams(value: unknown): value is LightParams {
  const p = value as Partial<LightParams> | null;
  return !!p && isVec3(p.core) && isVec3(p.edge) && isVec3(p.glow) && isVec3(p.glow_outer) && typeof p.orb === "number" && typeof p.glow_alpha === "number";
}

function isWingParams(value: unknown): value is WingParams {
  const p = value as Partial<WingParams> | null;
  return !!p && isVec3(p.root) && isVec3(p.tip) && isVec3(p.rim) && isVec3(p.vein) && typeof p.alpha === "number" && typeof p.rim_alpha === "number" && typeof p.vein_alpha === "number";
}

function toonMaterial(p: ToonParams): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    vertexColors: true,
    uniforms: {
      lightDir: { value: new Vector3(...p.light_dir).normalize() },
      lightGain: { value: p.light_gain },
      shadowTint: { value: linear(p.shadow_tint) },
      shadowAt: { value: p.shadow_at },
      hiAt: { value: p.hi_at },
      hiMix: { value: p.hi_mix },
      rimAt: { value: p.rim_at },
      rimMix: { value: p.rim_mix },
    },
  });
}

function lightMaterial(p: LightParams): ShaderMaterial {
  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader: lightFragmentShader,
    ...premultiplied,
    uniforms: {
      core: { value: linear(p.core) },
      edge: { value: linear(p.edge) },
      glow: { value: linear(p.glow) },
      glowOuter: { value: linear(p.glow_outer) },
      orb: { value: p.orb },
      glowAlpha: { value: p.glow_alpha },
      breath: { value: 0 },
    },
  });
  if (p.breathe) material.userData.breathe = p.breathe;
  lights.add(material);
  return material;
}

function wingMaterial(p: WingParams): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: wingVertexShader,
    fragmentShader: wingFragmentShader,
    vertexColors: true,
    side: DoubleSide,
    ...premultiplied,
    uniforms: {
      rootColor: { value: linear(p.root) },
      tipColor: { value: linear(p.tip) },
      rimColor: { value: linear(p.rim) },
      veinColor: { value: linear(p.vein) },
      alpha: { value: p.alpha },
      rimAlpha: { value: p.rim_alpha },
      veinAlpha: { value: p.vein_alpha },
    },
  });
}

/* Swaps every tagged material under `root` for its shader; a model without
   these extras is left as it was. */
export function applyCompanionToon(root: Object3D): void {
  const swapped = new Map<Material, Material>();
  const swap = (material: Material): Material => {
    if (material.userData?.outline) {
      material.toneMapped = false;
      return material;
    }
    const { toon, light, wing } = material.userData ?? {};
    const make = isToonParams(toon) ? () => toonMaterial(toon) : isLightParams(light) ? () => lightMaterial(light) : isWingParams(wing) ? () => wingMaterial(wing) : null;
    if (!make) return material;
    let next = swapped.get(material);
    if (!next) {
      next = make();
      swapped.set(material, next);
      material.dispose();
    }
    return next;
  };
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => swap(m as Material)) : swap(mesh.material as Material);
    // the light goes over the wings, hiding their roots
    if (materialsOf(mesh).some((material) => lights.has(material))) mesh.renderOrder = 1;
  });
}

/* --- Motion -------------------------------------------------------------- */

interface FlapParams {
  pivot: Vec3;
  axis: Vec3;
  amplitude: number;
  hz: number;
  phase: number;
}

function isFlapParams(value: unknown): value is FlapParams {
  const p = value as Partial<FlapParams> | null;
  return !!p && isVec3(p.pivot) && isVec3(p.axis) && typeof p.amplitude === "number" && typeof p.hz === "number" && typeof p.phase === "number";
}

function isPeriodic(value: unknown, key: "height" | "amount"): value is { period: number } & Record<typeof key, number> {
  const p = value as Record<string, unknown> | null;
  return !!p && typeof p[key] === "number" && typeof p.period === "number" && p.period > 0;
}

/* Returns what poses the model at a time in seconds, or null when it asks for
   no motion. Its rest pose is the still. Call it once the model is placed:
   the hover moves its root up and down about where it stands. A wing turns
   rigidly about its pivot in the model's own space, so it works whatever
   transform the node carries (quantised meshes carry one). */
export function companionMotion(root: Object3D): ((seconds: number) => void) | null {
  const flaps: { node: Object3D; params: FlapParams; pivot: Vector3; axis: Vector3; position: Vector3; rest: Quaternion }[] = [];
  const breathing: { material: ShaderMaterial; amount: number; period: number }[] = [];
  let hover = null as { height: number; period: number } | null;
  root.traverse((node) => {
    const { flap, hover: bob } = node.userData ?? {};
    if (isFlapParams(flap)) {
      flaps.push({
        node,
        params: flap,
        pivot: new Vector3(...flap.pivot),
        axis: new Vector3(...flap.axis).normalize(),
        position: new Vector3(node.position.x, node.position.y, node.position.z),
        rest: new Quaternion().copy(node.quaternion),
      });
    }
    if (isPeriodic(bob, "height")) hover = bob;
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    for (const material of materialsOf(mesh)) {
      const breathe = material.userData?.breathe;
      if (lights.has(material) && isPeriodic(breathe, "amount")) breathing.push({ material: material as ShaderMaterial, amount: breathe.amount, period: breathe.period });
    }
  });
  if (!flaps.length && !breathing.length && !hover) return null;
  const ground = root.position.y;
  const turn = new Quaternion();
  const offset = new Vector3();
  const tau = 2 * Math.PI;
  return (seconds) => {
    // each beat swings a wing from its rest pose out to its amplitude and back
    for (const { node, params, pivot, axis, position, rest } of flaps) {
      turn.setFromAxisAngle(axis, params.amplitude * (0.5 - 0.5 * Math.cos(tau * params.hz * seconds + params.phase)));
      node.quaternion.multiplyQuaternions(turn, rest);
      node.position.copy(offset.copy(position).sub(pivot).applyQuaternion(turn).add(pivot));
    }
    if (hover) root.position.y = ground + hover.height * root.scale.y * Math.sin((tau * seconds) / hover.period);
    for (const { material, amount, period } of breathing) material.uniforms.breath.value = amount * Math.sin((tau * seconds) / period);
  };
}
