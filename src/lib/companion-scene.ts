import {
  Box3,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  NeutralToneMapping,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { applyCompanionToon, companionMotion } from "./companion-toon";

/* A 3D companion (supporter-companions.ts) in its own small canvas. Loaded on
   demand. The model stands on the floor of its box, scaled to fill its
   height, and faces the viewer; dragging sideways turns it left or right, and
   only that way: it never tips forward or back. Let go and it spins on a
   little, then eases back to face front. A model can carry its own motion
   (a fairy's beating wings and hover, companion-toon.ts); reduced motion
   shows its rest pose. Draws only while on screen. The canvas can swap
   models (the /supporter preview, as the pointer moves down the list),
   keeping its context and compiled shaders. */

const FOV = 28;
const DRAG_TURN = 0.012;
const IDLE_SWAY = 0.1;

const loader = new GLTFLoader();
/* The file's bytes, fetched once; every use parses its own copy, so disposing
   one never pulls textures out from under another. */
const files = new Map<string, Promise<ArrayBuffer>>();

function loadModel(url: string): Promise<Object3D> {
  let pending = files.get(url);
  if (!pending) {
    pending = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`companion ${response.status}`);
      return response.arrayBuffer();
    });
    // a failed load is tried again next time
    pending.catch(() => files.delete(url));
    files.set(url, pending);
  }
  return pending
    .then((bytes) => loader.parseAsync(bytes.slice(0), ""))
    .then((gltf) => {
      // models exported with cel-shading settings get their toon look
      applyCompanionToon(gltf.scene);
      return gltf.scene;
    });
}

function lights(scene: Scene) {
  scene.add(new HemisphereLight(0xfff4f8, 0x2a2638, 1.7));
  const key = new DirectionalLight(0xffffff, 2.1);
  key.position.set(1.6, 2.6, 3);
  scene.add(key);
  const rim = new DirectionalLight(0xb9c8ff, 1.1);
  rim.position.set(-2.5, 1.5, -2);
  scene.add(rim);
}

/* Stands the model on y = 0, centred, one unit tall; returns its width over height. */
function fit(model: Object3D): number {
  const box = new Box3().setFromObject(model);
  const size = box.getSize(new Vector3());
  const scale = 1 / Math.max(size.y, 1e-6);
  model.scale.setScalar(scale);
  const centre = box.getCenter(new Vector3());
  model.position.set(-centre.x * scale, -box.min.y * scale, -centre.z * scale);
  return Math.max(size.x, size.z) / Math.max(size.y, 1e-6);
}

function frame(camera: PerspectiveCamera, aspect: number, spread: number) {
  camera.aspect = aspect;
  const half = (FOV * Math.PI) / 360;
  // far enough back to fit its height, and its width as it turns
  const byHeight = 0.58 / Math.tan(half);
  const byWidth = (Math.max(spread, 0.4) * 0.62) / (Math.tan(half) * aspect);
  camera.position.set(0, 0.52, Math.max(byHeight, byWidth));
  camera.lookAt(0, 0.48, 0);
  camera.updateProjectionMatrix();
}

/* Takes the shine off: no metal, full roughness, whatever the maps said. */
function makeMatte(root: Object3D) {
  root.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    for (const material of ([] as Material[]).concat(node.material ?? [])) {
      const standard = material as Material & { roughness?: number; metalness?: number; roughnessMap?: unknown; metalnessMap?: unknown; needsUpdate?: boolean };
      if (standard.roughness === undefined) continue;
      standard.roughness = 1;
      standard.metalness = 0;
      standard.roughnessMap = null;
      standard.metalnessMap = null;
      standard.needsUpdate = true;
    }
  });
}

function dispose(root: Object3D) {
  root.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    node.geometry?.dispose();
    for (const material of ([] as Material[]).concat(node.material ?? [])) {
      for (const value of Object.values(material)) if (value && typeof value === "object" && "isTexture" in value) (value as unknown as Material).dispose();
      material.dispose();
    }
  });
}

export interface CompanionScene {
  /* Shows another model once it has loaded; the current one stays until then.
     `onShow` runs as it swaps in, before the canvas is measured, so the host
     can take the new model's size in the same frame. */
  setModel(url: string, options?: { facing?: number; matte?: boolean; onShow?: () => void }): void;
  dispose(): void;
}

export function mountCompanionScene(host: HTMLElement, url: string, { facing: initialFacing = 0, matte = false, onReady }: { facing?: number; matte?: boolean; onReady?: () => void } = {}): CompanionScene {
  const renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;
  const canvas = renderer.domElement;
  canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:pan-y;cursor:grab;opacity:0;transition:opacity .4s ease";
  host.appendChild(canvas);

  const scene = new Scene();
  lights(scene);
  const turntable = new Group();
  scene.add(turntable);
  const camera = new PerspectiveCamera(FOV, 1, 0.05, 20);
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let model: Object3D | null = null;
  let motion: ((seconds: number) => void) | null = null;
  let facing = initialFacing;
  let loading = 0;
  let spread = 0.8;
  let disposed = false;
  let visible = true;
  let raf = 0;
  let yaw = initialFacing;
  let velocity = 0;
  let dragging: { id: number; x: number; at: number } | null = null;
  let releasedAt = -1e9;
  const start = performance.now();

  const resize = () => {
    const width = host.clientWidth, height = host.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    frame(camera, width / height, spread);
  };

  const tick = (now: number) => {
    raf = 0;
    if (disposed) return;
    if (!dragging) {
      yaw += velocity;
      velocity *= 0.93;
      // after a moment at rest it turns back to face front, swaying a little
      const settle = Math.min(1, Math.max(0, (now - releasedAt - 1400) / 1600));
      const sway = still ? 0 : Math.sin((now - start) / 1700) * IDLE_SWAY;
      const home = facing + sway;
      // the nearest turn that faces front, so it never unwinds whole spins
      const target = home + Math.round((yaw - home) / (Math.PI * 2)) * Math.PI * 2;
      if (Math.abs(velocity) < 0.002) yaw += (target - yaw) * 0.05 * settle;
    }
    turntable.rotation.y = yaw;
    if (motion && !still) motion((now - start) / 1000);
    renderer.render(scene, camera);
    if (visible && (!still || dragging || Math.abs(velocity) > 0.001)) raf = requestAnimationFrame(tick);
  };
  const wake = () => {
    if (!raf && !disposed && model) raf = requestAnimationFrame(tick);
  };

  const onDown = (event: PointerEvent) => {
    dragging = { id: event.pointerId, x: event.clientX, at: event.timeStamp };
    velocity = 0;
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = "grabbing";
    wake();
  };
  const onMove = (event: PointerEvent) => {
    if (!dragging || event.pointerId !== dragging.id) return;
    const dx = event.clientX - dragging.x;
    const dt = Math.max(1, event.timeStamp - dragging.at);
    yaw += dx * DRAG_TURN;
    velocity = ((dx * DRAG_TURN) / dt) * 16;
    dragging = { ...dragging, x: event.clientX, at: event.timeStamp };
  };
  const onUp = (event: PointerEvent) => {
    if (!dragging || event.pointerId !== dragging.id) return;
    dragging = null;
    releasedAt = performance.now();
    canvas.style.cursor = "grab";
    wake();
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);

  const resizer = new ResizeObserver(() => {
    resize();
    if (model) renderer.render(scene, camera);
  });
  resizer.observe(host);
  const watcher = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) wake();
  });
  watcher.observe(host);

  const show = (next: string, nextFacing: number, nextMatte: boolean, onShow?: () => void) => {
    const ticket = ++loading;
    void loadModel(next).then((loaded) => {
      if (disposed || ticket !== loading) {
        dispose(loaded);
        return;
      }
      if (model) {
        turntable.remove(model);
        dispose(model);
      }
      model = loaded;
      if (nextMatte) makeMatte(loaded);
      spread = fit(loaded);
      motion = companionMotion(loaded);
      turntable.add(loaded);
      facing = nextFacing;
      yaw = nextFacing;
      velocity = 0;
      onShow?.();
      resize();
      renderer.render(scene, camera);
      canvas.style.opacity = "1";
      onReady?.();
      wake();
    }).catch(() => {});
  };
  show(url, initialFacing, matte);

  return {
    setModel(next, options = {}) {
      show(next, options.facing ?? 0, options.matte ?? false, options.onShow);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      resizer.disconnect();
      watcher.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      if (model) dispose(model);
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}

/* --- Thumbnails ---------------------------------------------------------- */

/* One shared renderer draws every list tile's still, so a grid of models costs
   one WebGL context, not one each. */
let thumbRenderer: WebGLRenderer | null = null;
const thumbs = new Map<string, Promise<string>>();
const THUMB_SIZE = 192;
/* Drawn this many times larger and scaled down: at tile size a scan's UV
   seams pick the texture's tiniest mip and show as lines, which the larger
   draw keeps a fraction of a pixel wide. */
const THUMB_SUPERSAMPLE = 3;

export function companionThumbnail(url: string, facing = 0, matte = false): Promise<string> {
  const key = `${url}#${facing}#${matte}`;
  let pending = thumbs.get(key);
  if (pending) return pending;
  pending = loadModel(url).then((model) => {
    thumbRenderer ??= new WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    thumbRenderer.setPixelRatio(1);
    thumbRenderer.setSize(THUMB_SIZE * THUMB_SUPERSAMPLE, THUMB_SIZE * THUMB_SUPERSAMPLE, false);
    thumbRenderer.outputColorSpace = SRGBColorSpace;
    thumbRenderer.toneMapping = NeutralToneMapping;
    const scene = new Scene();
    lights(scene);
    if (matte) makeMatte(model);
    const turntable = new Group();
    turntable.add(model);
    turntable.rotation.y = facing;
    scene.add(turntable);
    const camera = new PerspectiveCamera(FOV, 1, 0.05, 20);
    frame(camera, 1, fit(model));
    thumbRenderer.render(scene, camera);
    const still = document.createElement("canvas");
    still.width = THUMB_SIZE;
    still.height = THUMB_SIZE;
    const g = still.getContext("2d")!;
    g.imageSmoothingQuality = "high";
    g.drawImage(thumbRenderer.domElement, 0, 0, THUMB_SIZE, THUMB_SIZE);
    const data = still.toDataURL("image/png");
    dispose(model);
    return data;
  });
  pending.catch(() => thumbs.delete(key));
  thumbs.set(key, pending);
  return pending;
}
