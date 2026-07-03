import {
  AmbientLight,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  PMREMGenerator,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Texture } from "three";
import { PACK_ASPECT, PACK_CRIMP_FRACTION } from "./packArt";

// World size of the pack; bulge depths are fractions of the width. A real
// booster is a thin lens: ~5 cards plus air is roughly 9% of the width in
// total, front slightly puffier than back.
const PACK_WORLD_WIDTH = 6;
const PACK_WORLD_HEIGHT = PACK_WORLD_WIDTH / PACK_ASPECT;
const FRONT_BULGE = PACK_WORLD_WIDTH * 0.055;
const BACK_BULGE = PACK_WORLD_WIDTH * 0.035;
// The canvas extends past the host so the pack can tilt and the torn strip
// can fly off without getting clipped (same trick as ManiaCardRenderer).
const CANVAS_OVERSCAN = 1.8;
const CAMERA_FOV_DEG = 30;
// Rip choreography, matching the old DOM animation: the strip flies up-right
// and fades, then the body drops away. Distances are world units.
const STRIP_MS = 620;
const STRIP_TRAVEL_Y = 3.0;
const STRIP_TRAVEL_X = 1.6;
const STRIP_SPIN_RAD = -0.24;
const BODY_DELAY_MS = 220;
const BODY_MS = 500;
const BODY_DROP_Y = 0.92;
const REDUCED_RIP_MS = 180;

function clamp01(t: number) {
  return Math.min(1, Math.max(0, t));
}

function smooth01(t: number) {
  return t * t * (3 - 2 * t);
}

/* Height field of the foil pouch: flat crimp tabs top and bottom with a
   slight backward curl, a card-stack plateau between them that rolls off
   toward all four edges, and a faint baked wrinkle so the foil never reads
   as machine-perfect. u is 0..1 across the width, v is 0..1 down the
   height. Negative bulge builds the back surface; the tabs stay on the same
   side for both so the two shells meet at the crimps. */
function packSurfaceZ(u: number, v: number, bulge: number) {
  const crimp = PACK_CRIMP_FRACTION;
  if (v < crimp || v > 1 - crimp) {
    const tab = v < crimp ? (crimp - v) / crimp : (v - (1 - crimp)) / crimp;
    const curl = -Math.abs(bulge) * 0.12 * tab * tab;
    // Tiny setback keeps the back shell's tab from z-fighting the front's.
    return curl + (bulge < 0 ? -0.02 : 0);
  }
  const t = (v - crimp) / (1 - crimp * 2);
  const profileY = smooth01(Math.min(1, t / 0.1)) * smooth01(Math.min(1, (1 - t) / 0.1));
  // Lens cross-section: flat-ish across the middle, tapering to ZERO at the
  // sides so the front and back shells meet in a sharp crease (the foil
  // fold line every real pack has edge-on).
  const profileX = Math.pow(Math.sin(Math.PI * clamp01(u)), 0.6);
  const wrinkle =
    1 +
    0.05 * Math.sin(u * 21.3 + 2.1) * Math.sin(v * 17.7 + 0.6) +
    0.035 * Math.sin(u * 9.1 - 1.2) * Math.sin(v * 6.3 + 2.8);
  return bulge * profileX * profileY * wrinkle;
}

function createPouchGeometry(bulge: number) {
  const geometry = new PlaneGeometry(PACK_WORLD_WIDTH, PACK_WORLD_HEIGHT, 72, 96);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    const u = positions.getX(index) / PACK_WORLD_WIDTH + 0.5;
    const v = 0.5 - positions.getY(index) / PACK_WORLD_HEIGHT;
    positions.setZ(index, packSurfaceZ(u, v, bulge));
  }
  geometry.computeVertexNormals();
  return geometry;
}

/* Minimal studio for PMREM: an overhead softbox and two vertical side
   strips. Foil reflections read as long streaks sweeping over the bulge as
   the pack tilts, which is the whole point of the environment map. */
function createStudioEnvironment() {
  const studio = new Scene();
  studio.background = new Color(0x07060d);
  const disposables: Array<{ dispose: () => void }> = [];
  const panel = (width: number, height: number, color: number) => {
    const geometry = new PlaneGeometry(width, height);
    const material = new MeshBasicMaterial({ color });
    disposables.push(geometry, material);
    const mesh = new Mesh(geometry, material);
    studio.add(mesh);
    return mesh;
  };
  const ceiling = panel(10, 10, 0xffffff);
  ceiling.position.set(0, 6, 2);
  ceiling.rotation.x = Math.PI / 2;
  const left = panel(2.5, 12, 0xf3ecff);
  left.position.set(-7, 0, 1);
  left.rotation.y = Math.PI / 2;
  const right = panel(1.6, 12, 0x8f86ad);
  right.position.set(7, 0, 1);
  right.rotation.y = -Math.PI / 2;
  const floor = panel(10, 10, 0x141020);
  floor.position.set(0, -6, 2);
  floor.rotation.x = -Math.PI / 2;
  return { studio, dispose: () => disposables.forEach((item) => item.dispose()) };
}

export interface PackSceneOptions {
  host: HTMLElement;
  /* Live 2D canvas PackStage keeps redrawing (art + cut + gape); used as the
     front texture. Call markArtDirty() after each redraw. */
  textureCanvas: HTMLCanvasElement;
  backCanvas: HTMLCanvasElement;
  reducedMotion: boolean;
}

export class PackScene {
  private readonly host: HTMLElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(CAMERA_FOV_DEG, PACK_ASPECT, 0.1, 100);
  /* packGroup carries tilt + float; bodyGroup (front + back shells) and the
     strip mesh animate separately during the rip. */
  private readonly packGroup = new Group();
  private readonly bodyGroup = new Group();
  private readonly raycaster = new Raycaster();
  private readonly pointerNdc = new Vector2();
  private readonly planeNormal = new Vector3();
  private readonly planePoint = new Vector3();
  private readonly cutPlane = new Plane();
  private readonly frontMaterial: MeshStandardMaterial;
  private readonly backMaterial: MeshStandardMaterial;
  private readonly frontTexture: CanvasTexture;
  private readonly backTexture: CanvasTexture;
  private readonly frontGeometry: PlaneGeometry;
  private readonly backGeometry: PlaneGeometry;
  private stripMesh: Mesh | null = null;
  private stripMaterial: MeshStandardMaterial | null = null;
  private ripTextures: CanvasTexture[] = [];
  private environmentTexture: Texture | null = null;
  private tiltTarget = { x: 0, y: 0 };
  private tiltCurrent = { x: 0, y: 0 };
  private reducedMotion: boolean;
  private windowActive = true;
  private frameId: number | null = null;
  private disposed = false;
  private rip: { startedAt: number | null } | null = null;

  constructor(options: PackSceneOptions) {
    this.host = options.host;
    this.reducedMotion = options.reducedMotion;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const canvas = this.renderer.domElement;
    canvas.style.display = "block";
    canvas.style.position = "absolute";
    canvas.style.left = "50%";
    canvas.style.top = "50%";
    canvas.style.transform = "translate(-50%, -50%)";
    canvas.style.pointerEvents = "none";
    this.host.appendChild(canvas);

    const fovRad = (CAMERA_FOV_DEG * Math.PI) / 180;
    const cameraDistance = (PACK_WORLD_HEIGHT * CANVAS_OVERSCAN * 1.04) / (2 * Math.tan(fovRad / 2));
    this.camera.position.set(0, 0, cameraDistance);

    const pmrem = new PMREMGenerator(this.renderer);
    const studio = createStudioEnvironment();
    const environment = pmrem.fromScene(studio.studio, 0.06);
    this.environmentTexture = environment.texture;
    this.scene.environment = environment.texture;
    pmrem.dispose();
    studio.dispose();

    // Mostly-diffuse lighting: high metalness would take its color from the
    // (dark) environment and crush the print. The env map is only there for
    // the glossy streaks that sweep the bulge on tilt.
    this.scene.add(new AmbientLight(0xffffff, 0.9));
    const key = new DirectionalLight(0xffffff, 1.4);
    key.position.set(-3, 4, 5);
    this.scene.add(key);
    const rim = new DirectionalLight(0xcfc4f5, 0.6);
    rim.position.set(2.5, 1, -4);
    this.scene.add(rim);

    this.frontTexture = this.makeTexture(options.textureCanvas);
    this.backTexture = this.makeTexture(options.backCanvas);
    // alphaTest: the live cut canvas leaves the slit transparent, so the cut
    // is a real hole in the front shell - the dark inside (the back shell)
    // shows through it with true parallax. Cutout via alphaTest keeps the
    // material on the opaque path (no sorting artifacts).
    this.frontMaterial = new MeshStandardMaterial({
      map: this.frontTexture,
      roughness: 0.4,
      metalness: 0.18,
      envMapIntensity: 1.0,
      alphaTest: 0.5,
    });
    // Matte: its inner face shows through the cut slit as the dark inside
    // of the pack, and a glossy inside sparkles with env-map glints.
    this.backMaterial = new MeshStandardMaterial({
      map: this.backTexture,
      roughness: 0.6,
      metalness: 0.1,
      envMapIntensity: 0.35,
    });

    this.frontGeometry = createPouchGeometry(FRONT_BULGE);
    this.backGeometry = createPouchGeometry(-BACK_BULGE);
    const frontMesh = new Mesh(this.frontGeometry, this.frontMaterial);
    frontMesh.renderOrder = 1;
    // DoubleSide: the inside of the back shell shows through the torn gap.
    this.backMaterial.side = DoubleSide;
    const backMesh = new Mesh(this.backGeometry, this.backMaterial);
    this.bodyGroup.add(backMesh, frontMesh);
    this.packGroup.add(this.bodyGroup);
    this.scene.add(this.packGroup);

    this.resize();
    this.start();
  }

  private makeTexture(canvas: HTMLCanvasElement) {
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    return texture;
  }

  markArtDirty() {
    if (this.disposed) return;
    this.frontTexture.needsUpdate = true;
    this.start();
  }

  setTiltTarget(xDeg: number, yDeg: number) {
    this.tiltTarget = { x: xDeg, y: yDeg };
    this.start();
  }

  setReducedMotion(reduced: boolean) {
    this.reducedMotion = reduced;
    if (reduced) this.packGroup.position.y = 0;
    this.start();
  }

  setWindowActive(active: boolean) {
    if (this.disposed || this.windowActive === active) return;
    this.windowActive = active;
    if (active) {
      this.start();
    } else if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
  }

  /* Maps a client point onto the pack's front plane (through the pack's
     current tilt and float) and returns pack-space fractions: u 0..1 across
     the width, v 0..1 down the height. Values outside 0..1 mean the pointer
     is off the pack, which the slash slack rules rely on. */
  pointerToPack(clientX: number, clientY: number): { u: number; v: number } | null {
    if (this.disposed) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.pointerNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1),
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    this.planeNormal.set(0, 0, 1).applyQuaternion(this.packGroup.quaternion);
    this.packGroup.getWorldPosition(this.planePoint);
    this.cutPlane.setFromNormalAndCoplanarPoint(this.planeNormal, this.planePoint);
    const hit = this.raycaster.ray.intersectPlane(this.cutPlane, new Vector3());
    if (!hit) return null;
    const local = this.packGroup.worldToLocal(hit);
    return {
      u: local.x / PACK_WORLD_WIDTH + 0.5,
      v: 0.5 - local.y / PACK_WORLD_HEIGHT,
    };
  }

  /* Starts the tear-off: both shells swap to body-only textures (a slash
     goes through both foil layers, so the whole top empties out) and a strip
     mesh (same bulged geometry, strip-only texture) flies away. */
  beginRip(clips: { strip: HTMLCanvasElement; body: HTMLCanvasElement; backBody: HTMLCanvasElement }) {
    if (this.disposed || this.rip) return;
    const bodyTexture = this.makeTexture(clips.body);
    const stripTexture = this.makeTexture(clips.strip);
    const backBodyTexture = this.makeTexture(clips.backBody);
    this.ripTextures.push(bodyTexture, stripTexture, backBodyTexture);

    this.frontMaterial.map = bodyTexture;
    this.frontMaterial.transparent = true;
    this.frontMaterial.alphaTest = 0.01;
    this.frontMaterial.needsUpdate = true;
    this.backMaterial.map = backBodyTexture;
    this.backMaterial.transparent = true;
    this.backMaterial.alphaTest = 0.01;
    this.backMaterial.needsUpdate = true;

    this.stripMaterial = new MeshStandardMaterial({
      map: stripTexture,
      roughness: 0.4,
      metalness: 0.18,
      envMapIntensity: 1.0,
      transparent: true,
      alphaTest: 0.01,
      depthWrite: false,
    });
    this.stripMesh = new Mesh(this.frontGeometry, this.stripMaterial);
    this.stripMesh.position.set(0, 0, 0.03);
    this.stripMesh.renderOrder = 2;
    this.packGroup.add(this.stripMesh);

    this.tiltTarget = { x: 0, y: 0 };
    this.rip = { startedAt: null };
    this.start();
  }

  resize() {
    if (this.disposed) return;
    const hostWidth = Math.max(1, this.host.clientWidth);
    const hostHeight = Math.max(1, this.host.clientHeight);
    const canvasWidth = Math.round(hostWidth * CANVAS_OVERSCAN);
    const canvasHeight = Math.round(hostHeight * CANVAS_OVERSCAN);
    this.renderer.setSize(canvasWidth, canvasHeight);
    this.camera.aspect = canvasWidth / canvasHeight;
    this.camera.updateProjectionMatrix();
    this.start();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
    this.renderer.domElement.remove();
    this.frontTexture.dispose();
    this.backTexture.dispose();
    for (const texture of this.ripTextures) texture.dispose();
    this.frontGeometry.dispose();
    this.backGeometry.dispose();
    this.frontMaterial.dispose();
    this.backMaterial.dispose();
    this.stripMaterial?.dispose();
    this.environmentTexture?.dispose();
    this.renderer.dispose();
  }

  private start() {
    if (this.frameId !== null || this.disposed || !this.windowActive) return;
    const tick = (timeMs: number) => {
      this.frameId = null;
      if (this.disposed) return;
      this.tick(timeMs);
      this.start();
    };
    this.frameId = requestAnimationFrame(tick);
  }

  private tick(timeMs: number) {
    const damp = this.reducedMotion ? 1 : 0.16;
    this.tiltCurrent.x += (this.tiltTarget.x - this.tiltCurrent.x) * damp;
    this.tiltCurrent.y += (this.tiltTarget.y - this.tiltCurrent.y) * damp;
    this.packGroup.rotation.x = (this.tiltCurrent.x * Math.PI) / 180;
    this.packGroup.rotation.y = (this.tiltCurrent.y * Math.PI) / 180;

    if (!this.reducedMotion && !this.rip) {
      this.packGroup.position.y = Math.sin((timeMs / 3600) * Math.PI * 2) * 0.12;
    }

    if (this.rip) {
      if (this.rip.startedAt === null) this.rip.startedAt = timeMs;
      const elapsed = timeMs - this.rip.startedAt;
      if (this.reducedMotion) {
        const fade = 1 - clamp01(elapsed / REDUCED_RIP_MS);
        this.frontMaterial.opacity = fade;
        this.backMaterial.opacity = fade;
        if (this.stripMaterial) this.stripMaterial.opacity = fade;
      } else {
        const stripProgress = clamp01(elapsed / STRIP_MS);
        const stripEase = 1 - Math.pow(1 - stripProgress, 3);
        if (this.stripMesh && this.stripMaterial) {
          this.stripMesh.position.y = stripEase * STRIP_TRAVEL_Y;
          this.stripMesh.position.x = stripEase * STRIP_TRAVEL_X;
          this.stripMesh.rotation.z = stripEase * STRIP_SPIN_RAD;
          this.stripMaterial.opacity = 1 - stripEase;
        }
        const bodyProgress = clamp01((elapsed - BODY_DELAY_MS) / BODY_MS);
        const bodyEase = bodyProgress * bodyProgress;
        this.bodyGroup.position.y = -bodyEase * BODY_DROP_Y;
        this.bodyGroup.scale.setScalar(1 - 0.1 * bodyEase);
        this.frontMaterial.opacity = 1 - bodyEase;
        this.backMaterial.opacity = 1 - bodyEase;
      }
    }

    this.renderer.render(this.scene, this.camera);
  }
}
