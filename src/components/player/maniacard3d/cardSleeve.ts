import {
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  FrontSide,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  Path,
  PlaneGeometry,
  ShaderMaterial,
  Shape,
  SRGBColorSpace,
  Vector2,
} from "three";
import { CARD_WORLD_HEIGHT } from "./cardGeometry";
import { CARD_ASPECT } from "./layout";
import type { ManiaCardReadyData } from "./types";
import { drawSlabLabel, drawSlabLabelBack, type SlabLabelInfo } from "./slabLabel";
import type { SupporterCardSleeveId } from "#/lib/supporter-pack-style";

/* The case a supporter keeps the cards they own in, built around the 3D card
   (lib/supporter-pack-style.ts). Each is clear plastic or acrylic drawn by one
   shader: a faint body, edges that catch the light like thick acrylic does,
   and a highlight that slides across the face as the card tilts or the
   pointer moves the light. The renderer scales the card and case together
   so a case taller than the card still fits the frame. */

const CARD_W = CARD_WORLD_HEIGHT * CARD_ASPECT;
const CARD_H = CARD_WORLD_HEIGHT;

interface SleeveSpec {
  /** Outer size of the case, and how far the card sits below its centre. */
  width: number;
  height: number;
  depth: number;
  radius: number;
  bevel: number;
  cardOffsetY: number;
  /** 0 rigid and clear, 1 soft and crinkled. */
  soft: number;
  /** The body's own haze, and the edges' strength. */
  haze: number;
  edge: number;
  /** A tint of the acrylic, seen most at the edges. */
  tint: [number, number, number];
}

const SPECS: Record<SupporterCardSleeveId, SleeveSpec> = {
  // A soft sleeve, a size up from the card, open at the top.
  penny: { width: CARD_W + 0.1, height: CARD_H + 0.22, depth: 0.06, radius: 0.12, bevel: 0.01, cardOffsetY: -0.08, soft: 1, haze: 0.05, edge: 0.35, tint: [0.92, 0.96, 1] },
  // Rigid PVC with a thick rim and a lip at the opening.
  toploader: { width: CARD_W + 0.3, height: CARD_H + 0.36, depth: 0.12, radius: 0.16, bevel: 0.03, cardOffsetY: -0.06, soft: 0, haze: 0.035, edge: 0.75, tint: [0.88, 0.97, 1] },
  // A one-touch magnetic holder, measured off a real one card for card: UV
  // acrylic (blue at the edges), a milky frosted frame inside a clear rim, the
  // card in a window with relief tabs at its corners, and a gold magnet in a
  // clear well in the deeper band across the top.
  onetouch: { width: CARD_W * (520 / 446), height: CARD_H * (795 / 618), depth: 0.24, radius: 0.07, bevel: 0.03, cardOffsetY: -(9.5 / 446) * CARD_W, soft: 0, haze: 0.03, edge: 1, tint: [0.66, 0.66, 0.98] },
  // A graded slab in a magnetic display case: the outer acrylic block, with a
  // chrome magnet in each corner, holds the slab, which holds the label above
  // the card. Proportions from a real PSA slab in its case, card for card.
  slab: { width: CARD_W * 1.623, height: CARD_W * 2.447, depth: 0.46, radius: 0.24, bevel: 0.05, cardOffsetY: -0.8, soft: 0, haze: 0.02, edge: 0.85, tint: [0.9, 0.97, 1] },
};

/** The case's height over the card's, for the renderer's fit. */
export function sleeveFit(sleeve: SupporterCardSleeveId): { scale: number; cardOffsetY: number } {
  const spec = SPECS[sleeve];
  return { scale: CARD_H / spec.height, cardOffsetY: spec.cardOffsetY };
}

function roundedRectShape(width: number, height: number, radius: number, y = 0): Shape {
  const shape = new Shape();
  traceRoundedRect(shape, width, height, radius, y);
  return shape;
}

function traceRoundedRect(path: Shape | Path, width: number, height: number, radius: number, y = 0) {
  const x0 = -width / 2;
  const y0 = -height / 2 + y;
  path.moveTo(x0 + radius, y0);
  path.lineTo(x0 + width - radius, y0);
  path.quadraticCurveTo(x0 + width, y0, x0 + width, y0 + radius);
  path.lineTo(x0 + width, y0 + height - radius);
  path.quadraticCurveTo(x0 + width, y0 + height, x0 + width - radius, y0 + height);
  path.lineTo(x0 + radius, y0 + height);
  path.quadraticCurveTo(x0, y0 + height, x0, y0 + height - radius);
  path.lineTo(x0, y0 + radius);
  path.quadraticCurveTo(x0, y0, x0 + radius, y0);
}

const shellVertex = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec3 vLocal;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPos = world.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vLocal = position;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const shellFragment = /* glsl */ `
  uniform vec2 uLight;
  uniform float uTime;
  uniform vec2 uSize;
  uniform float uSoft;
  uniform float uHaze;
  uniform float uEdge;
  uniform vec3 uTint;
  uniform float uLip;
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec3 vLocal;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }

  void main() {
    vec3 n = normalize(vWorldNormal);
    vec3 view = normalize(cameraPosition - vWorldPos);
    float facing = abs(dot(n, view));
    float fresnel = pow(1.0 - facing, 3.0);
    // The caps face the camera; the rim and bevel turn away and catch light.
    float side = 1.0 - smoothstep(0.55, 0.9, abs(n.z));

    vec2 uv = vLocal.xy / uSize + 0.5;
    // Soft plastic crinkles: the highlight bends through it.
    float crinkle = (fbm(uv * vec2(5.0, 7.0)) - 0.5) * uSoft;

    // A broad sheen and a tight streak, both sliding with the light and the tilt.
    vec2 dir = normalize(vec2(0.82, 0.57));
    float along = dot(uv - 0.5, dir) + crinkle * 0.35;
    float tilt = dot(view.xy, vec2(0.9, 0.6));
    // At rest the glint sits up by the top corner; tilting or moving the
    // light walks it across the face.
    float center = 0.42 + (uLight.x - 0.5) * 1.5 + (uLight.y - 0.5) * 0.7 - tilt * 1.4;
    float sheen = exp(-pow((along - center) * 4.0, 2.0)) * 0.07;
    float streak = exp(-pow((along - center - 0.05) * 34.0, 2.0)) * 0.42;
    float streak2 = exp(-pow((along - center + 0.16) * 60.0, 2.0)) * 0.16;
    float light = (sheen + streak + streak2) * (1.0 - side);

    // Fine scuffs that only show where the light sweeps over them.
    float scratch = smoothstep(0.985, 1.0, noise(vec2(dot(uv, vec2(41.0, 13.0)), dot(uv, vec2(-3.0, 9.0)) * 0.6)));
    light += scratch * (sheen * 3.0 + streak) * (1.0 - uSoft) * 0.8;

    // The opening of a toploader: a slightly thicker band along the top.
    float lip = uLip * smoothstep(0.93, 0.955, uv.y) * (1.0 - smoothstep(0.985, 1.0, uv.y));

    // Acrylic edges read bright and a touch tinted, not grey.
    vec3 color = uTint * (0.8 + light * 1.2 + side * 0.35) + vec3(fresnel * 0.5);
    float alpha = uHaze + light + fresnel * 0.22 + side * uEdge * (0.3 + fresnel * 0.5) + lip * 0.16 + abs(crinkle) * 0.08;
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.92));
  }
`;

function createShellMaterial(spec: SleeveSpec, lip: number, size?: { width: number; height: number }): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: shellVertex,
    fragmentShader: shellFragment,
    transparent: true,
    depthWrite: false,
    side: FrontSide,
    blending: NormalBlending,
    uniforms: {
      uLight: { value: new Vector2(0.5, 0.5) },
      uTime: { value: 0 },
      uSize: { value: new Vector2(size?.width ?? spec.width, size?.height ?? spec.height) },
      uSoft: { value: spec.soft },
      uHaze: { value: spec.haze },
      uEdge: { value: spec.edge },
      uTint: { value: new Color(...spec.tint) },
      uLip: { value: lip },
    },
  });
}

/* One side of a graded slab's label (slabLabel.ts draws both). */
function createSlabLabel(data: ManiaCardReadyData, width: number, height: number, side: "front" | "back"): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = Math.round((height / width) * canvas.width);
  const info: SlabLabelInfo = {
    userId: Number(data.user.id) || 0,
    username: data.user.username,
    tier: data.tierStyle.label,
    rank: data.user.statistics?.global_rank ?? null,
    accent: data.edgeColor,
    year: new Date().getFullYear(),
  };
  (side === "front" ? drawSlabLabel : drawSlabLabelBack)(canvas.getContext("2d")!, canvas.width, canvas.height, info);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = 8;
  return texture;
}

type Metal = "chrome" | "gold";

/* A spun-metal face: the fine circular grain of a turned disc throws the
   light back as a bright bow tie through its middle, which turns as the
   light and the tilt move. */
const spunVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const spunFragment = /* glsl */ `
  uniform vec2 uLight;
  uniform float uTime;
  uniform vec3 uDark;
  uniform vec3 uBright;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv - 0.5;
    float r = length(p) * 2.0;
    float a = atan(p.y, p.x);
    float turn = (uLight.x - 0.5) * 2.4 + (uLight.y - 0.5) * 1.2 + 0.9;
    float bow = pow(abs(cos(a - turn)), 5.0);
    float grain = 0.5 + 0.5 * sin(a * 90.0 + sin(a * 7.0) * 3.0);
    float sheen = bow * 0.85 + 0.15 + grain * 0.06;
    vec3 col = mix(uDark, uBright, clamp(sheen, 0.0, 1.0));
    // the face's edge is turned down a little and catches less light
    col *= 1.0 - 0.3 * smoothstep(0.88, 1.0, r);
    gl_FragColor = vec4(col, 1.0);
  }
`;

/* A round magnet set through a case at (x, y): a metal face on each side and the barrel between. */
function addMagnet(group: Group, materials: ShaderMaterial[], disposables: { dispose: () => void }[], metal: Metal, radius: number, depth: number, spots: [number, number][]) {
  const faceGeometry = new CircleGeometry(radius, 48);
  const sideGeometry = new CylinderGeometry(radius, radius, depth - 0.02, 48, 1, true).rotateX(Math.PI / 2);
  const faceMaterial = new ShaderMaterial({
    vertexShader: spunVertex,
    fragmentShader: spunFragment,
    uniforms: {
      uLight: { value: new Vector2(0.5, 0.5) },
      uTime: { value: 0 },
      uDark: { value: metal === "gold" ? new Color(0.62, 0.45, 0.12) : new Color(0.42, 0.44, 0.48) },
      uBright: { value: metal === "gold" ? new Color(1, 0.93, 0.62) : new Color(0.97, 0.98, 1) },
    },
  });
  const sideMaterial = new MeshBasicMaterial({ color: metal === "gold" ? 0x8a6420 : 0x6d7077, side: DoubleSide });
  for (const [x, y] of spots) {
    const barrel = new Mesh(sideGeometry, sideMaterial);
    barrel.position.set(x, y, 0);
    group.add(barrel);
    for (const z of [1, -1]) {
      const face = new Mesh(faceGeometry, faceMaterial);
      face.position.set(x, y, z * (depth / 2 - 0.004));
      if (z < 0) face.rotation.y = Math.PI;
      group.add(face);
    }
  }
  materials.push(faceMaterial);
  disposables.push(faceGeometry, sideGeometry, faceMaterial, sideMaterial);
}

/* A rounded-rect outline whose long sides have half-round finger notches
   bitten outward at the given heights (centred, before `y`), grown by `grow`. */
function tracePocket(path: Shape | Path, width: number, height: number, radius: number, notch: number, notchYs: number[], grow: number, y = 0) {
  const w = width / 2 + grow, h = height / 2 + grow, r = radius + grow, n = notch + grow;
  const ys = [...notchYs].sort((a, b) => a - b);
  path.moveTo(-w + r, -h + y);
  path.lineTo(w - r, -h + y);
  path.quadraticCurveTo(w, -h + y, w, -h + r + y);
  for (const ny of ys) {
    path.lineTo(w, ny - n + y);
    path.absarc(w, ny + y, n, -Math.PI / 2, Math.PI / 2, false);
  }
  path.lineTo(w, h - r + y);
  path.quadraticCurveTo(w, h + y, w - r, h + y);
  path.lineTo(-w + r, h + y);
  path.quadraticCurveTo(-w, h + y, -w, h - r + y);
  for (const ny of [...ys].reverse()) {
    path.lineTo(-w, ny + n + y);
    path.absarc(-w, ny + y, n, Math.PI / 2, Math.PI * 1.5, false);
  }
  path.lineTo(-w, -h + r + y);
  path.quadraticCurveTo(-w, -h + y, -w + r, -h + y);
}

export interface CardSleeveMeshes {
  group: Group;
  update: (time: number, light: { x: number; y: number }) => void;
  dispose: () => void;
}

export function buildCardSleeve(sleeve: SupporterCardSleeveId, data: ManiaCardReadyData): CardSleeveMeshes {
  const spec = SPECS[sleeve];
  const group = new Group();
  const shellOffsetY = -spec.cardOffsetY;
  const materials: ShaderMaterial[] = [];
  const disposables: { dispose: () => void }[] = [];

  // The shell, centred on the case: the card sits cardOffsetY below it.
  const shellGeometry = new ExtrudeGeometry(roundedRectShape(spec.width - spec.bevel * 2, spec.height - spec.bevel * 2, spec.radius), {
    depth: spec.depth,
    bevelEnabled: true,
    bevelThickness: spec.bevel,
    bevelSize: spec.bevel,
    bevelSegments: 4,
    curveSegments: 10,
  });
  shellGeometry.translate(0, shellOffsetY, -spec.depth / 2);
  const shellMaterial = createShellMaterial(spec, sleeve === "toploader" || sleeve === "penny" ? 1 : 0);
  const shell = new Mesh(shellGeometry, shellMaterial);
  shell.renderOrder = 8;
  group.add(shell);
  materials.push(shellMaterial);
  disposables.push(shellGeometry, shellMaterial);

  if (sleeve === "onetouch") {
    const up = -spec.cardOffsetY;
    const unit = CARD_W / 446; // one pixel of the reference photo, where the card is 446 wide
    // The frosted frame: inside a clear rim, with the card's window (and its
    // corner relief tabs) and the magnet's well cut out of it.
    const rim = 0.035;
    const frameShape = roundedRectShape(spec.width - spec.bevel * 2 - rim * 2, spec.height - spec.bevel * 2 - rim * 2, 0.03, up);
    const opening = new Path();
    const ww = CARD_W / 2 + 0.015, wh = CARD_H / 2 + 0.015, tab = 11 * unit, tabH = 22 * unit;
    const outline: [number, number][] = [
      [-ww - tab, -wh], [ww + tab, -wh], [ww + tab, -wh + tabH], [ww, -wh + tabH], [ww, wh - tabH], [ww + tab, wh - tabH],
      [ww + tab, wh], [-ww - tab, wh], [-ww - tab, wh - tabH], [-ww, wh - tabH], [-ww, -wh + tabH], [-ww - tab, -wh + tabH],
    ];
    outline.forEach(([x, y], i) => (i === 0 ? opening.moveTo(x, y) : opening.lineTo(x, y)));
    opening.lineTo(outline[0][0], outline[0][1]);
    frameShape.holes.push(opening);
    const magnetY = up + (547.5 - 193) * unit;
    const well = new Path();
    well.absellipse(0, magnetY, 43 * unit, 29 * unit, 0, Math.PI * 2, false, 0);
    frameShape.holes.push(well);
    const frameDepth = spec.depth - 0.06;
    const frameGeometry = new ExtrudeGeometry(frameShape, { depth: frameDepth, bevelEnabled: false, curveSegments: 10 });
    frameGeometry.translate(0, 0, -frameDepth / 2);
    const frameMaterial = createShellMaterial({ ...spec, haze: 0.82, edge: 0.4, tint: [0.98, 1.02, 1.12] }, 0);
    const frame = new Mesh(frameGeometry, frameMaterial);
    frame.renderOrder = 7;
    group.add(frame);
    materials.push(frameMaterial);
    disposables.push(frameGeometry, frameMaterial);

    // The step inside the well, a smaller oval around the magnet.
    const stepShape = new Shape();
    stepShape.absellipse(0, magnetY, 29 * unit, 21 * unit, 0, Math.PI * 2, false, 0);
    const stepHole = new Path();
    stepHole.absellipse(0, magnetY, 27.5 * unit, 19.5 * unit, 0, Math.PI * 2, true, 0);
    stepShape.holes.push(stepHole);
    const stepGeometry = new ExtrudeGeometry(stepShape, { depth: frameDepth * 0.7, bevelEnabled: false, curveSegments: 32 });
    stepGeometry.translate(0, 0, -frameDepth * 0.35);
    const stepMaterial = createShellMaterial({ ...spec, haze: 0.3, edge: 1, tint: [1, 1, 1] }, 0);
    const step = new Mesh(stepGeometry, stepMaterial);
    step.renderOrder = 7;
    group.add(step);
    materials.push(stepMaterial);
    disposables.push(stepGeometry, stepMaterial);

    // The well's floor is the back plate: clear, with a little haze so it reads as acrylic on a dark page.
    const floorShape = new Shape();
    floorShape.absellipse(0, magnetY, 43 * unit, 29 * unit, 0, Math.PI * 2, false, 0);
    const floorGeometry = new ExtrudeGeometry(floorShape, { depth: 0.01, bevelEnabled: false, curveSegments: 32 });
    floorGeometry.translate(0, 0, -frameDepth / 2);
    const floorMaterial = createShellMaterial({ ...spec, haze: 0.32, edge: 0, tint: [0.92, 0.94, 1] }, 0);
    const floor = new Mesh(floorGeometry, floorMaterial);
    floor.renderOrder = 6;
    group.add(floor);
    materials.push(floorMaterial);
    disposables.push(floorGeometry, floorMaterial);

    addMagnet(group, materials, disposables, "gold", 19 * unit, spec.depth, [[0, magnetY]]);
  }

  if (sleeve === "slab") {
    // Everything below is measured from the card's centre; the case is centred `up` above it.
    const up = -spec.cardOffsetY;
    const unit = CARD_W / 570; // one pixel of the reference photo, where the card is 570 wide
    const slabW = 740 * unit, slabH = 1220 * unit, slabDepth = 0.3;
    const ring = (outline: (path: Shape | Path, grow: number) => void, depth: number, order: number, edge = 0.9) => {
      const shape = new Shape();
      outline(shape, 0.022);
      const hole = new Path();
      outline(hole, 0);
      shape.holes.push(hole);
      const geometry = new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 12 });
      geometry.translate(0, 0, -depth / 2);
      const material = createShellMaterial({ ...spec, haze: 0.05, edge }, 0, { width: slabW, height: slabH });
      const mesh = new Mesh(geometry, material);
      mesh.renderOrder = order;
      group.add(mesh);
      materials.push(material);
      disposables.push(geometry, material);
    };

    // The case's pocket, the slab's shape with two finger notches a side.
    ring((path, grow) => tracePocket(path, slabW + 0.04, slabH + 0.04, 0.14, 0.24, [-0.12, -1.25], grow, up), spec.depth - 0.1, 9, 1);

    // The slab: its own clear shell.
    const slabGeometry = new ExtrudeGeometry(roundedRectShape(slabW - 0.06, slabH - 0.06, 0.12, up), {
      depth: slabDepth - 0.06, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 3, curveSegments: 10,
    });
    slabGeometry.translate(0, 0, -(slabDepth - 0.06) / 2);
    const slabMaterial = createShellMaterial({ ...spec, haze: 0.03 }, 0, { width: slabW, height: slabH });
    const slab = new Mesh(slabGeometry, slabMaterial);
    slab.renderOrder = 8;
    group.add(slab);
    materials.push(slabMaterial);
    disposables.push(slabGeometry, slabMaterial);

    // The label's well and the card's well, a frosted plate behind the card.
    const labelWidth = 625 * unit, labelHeight = 210 * unit;
    const labelY = up + (892 - 445) * unit;
    ring((path, grow) => traceRoundedRect(path, labelWidth + 0.12 + grow * 2, labelHeight + 0.12 + grow * 2, 0.05 + grow, labelY), slabDepth * 0.6, 7, 0.5);
    const wellW = 655 * unit, wellH = 900 * unit;
    ring((path, grow) => traceRoundedRect(path, wellW + grow * 2, wellH + grow * 2, 0.08 + grow, 0), slabDepth * 0.6, 7, 0.5);
    const plateGeometry = new PlaneGeometry(wellW, wellH);
    const plateMaterial = new MeshBasicMaterial({ color: 0xe4e8ed, transparent: true, opacity: 0.38, depthWrite: false });
    const plate = new Mesh(plateGeometry, plateMaterial);
    plate.position.set(0, 0, -0.06);
    plate.renderOrder = 6;
    group.add(plate);
    disposables.push(plateGeometry, plateMaterial);

    // The label, and its back with the QR code, readable through the back of the slab.
    const labelGeometry = new PlaneGeometry(labelWidth, labelHeight);
    for (const side of ["front", "back"] as const) {
      const texture = createSlabLabel(data, labelWidth, labelHeight, side);
      const material = new MeshBasicMaterial({ map: texture, toneMapped: false });
      const label = new Mesh(labelGeometry, material);
      label.position.set(0, labelY, side === "front" ? 0.02 : -0.02);
      if (side === "back") label.rotation.y = Math.PI;
      group.add(label);
      disposables.push(material, texture);
    }
    disposables.push(labelGeometry);

    // A chrome magnet in each corner of the case, through its whole depth.
    const inset = 0.3;
    const corners: [number, number][] = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) corners.push([sx * (spec.width / 2 - inset), up + sy * (spec.height / 2 - inset)]);
    addMagnet(group, materials, disposables, "chrome", 0.13, spec.depth, corners);
  }

  return {
    group,
    update(time, light) {
      for (const material of materials) {
        material.uniforms.uTime.value = time;
        (material.uniforms.uLight.value as Vector2).set(light.x, light.y);
      }
    },
    dispose() {
      for (const item of disposables) item.dispose();
    },
  };
}
