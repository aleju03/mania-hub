import {
  AmbientLight,
  CanvasTexture,
  Group,
  LinearFilter,
  Mesh,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from "three";
import type { Object3D } from "three";
import { CONTENT_Z_OFFSET, createCardBodyGeometry, createCardFaceGeometry, FACE_Z_OFFSET, MOTIF_Z_OFFSET, OVERLAY_Z_OFFSET } from "./cardGeometry";
import { createEdgeMaterial, createFaceMaterial, createMotifPaintMaterial, createOverlayMaterial } from "./cardMaterials";
import { createCardTextures, type CardTextureSet } from "./cardTexture";
import {
  addRotation,
  createInteractionState,
  orientationToRotation,
  pointerToLight,
  pointerToRotation,
  subtractRotation,
  type InteractionState,
  type Rotation2D,
} from "./interactions";
import { CARD_ASPECT, clamp, resolveQualityProfile, type QualityProfile } from "./layout";
import type { ManiaCardReadyData } from "./types";
import { supporterFoilIndex, type SupporterFoilId } from "#/lib/supporter-foils";
import { mirrorGlCanvas, type GlMirror } from "#/lib/gl-mirror";
import type { SupporterCardSleeveId } from "#/lib/supporter-pack-style";
import { buildCardSleeve, sleeveFit, sleeveReach, type CardSleeveMeshes } from "./cardSleeve";
import { CARD_WORLD_HEIGHT } from "./cardGeometry";
import { createCardHaloMesh, type CardHaloLook, type CardHaloMesh } from "./cardHalo";

// The canvas extends past the host on every side by this factor so the card can
// rotate past the host's bounds without getting clipped. The renderer pushes
// the camera back to compensate, so the card keeps the same apparent size as
// at overscan = 1.0.
const CANVAS_OVERSCAN = 1.28;
/* With a level halo on, the canvas reaches far enough to show it whole. */
const HALO_OVERSCAN = 1.5;
const CAMERA_FOV_DEG = 35;
/* While the card only idles (foil shimmer, halo, slow drift) it draws at
   about 30 fps: the motion is slow enough that 60 or 120 looks the same. A
   drag, the flip, a fit or recent input still draw every frame. */
const IDLE_FRAME_MS = 30;

type DeviceOrientationEventWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<PermissionState>;
};

export interface ManiaCardRendererOptions {
  host: HTMLElement;
  data: ManiaCardReadyData;
  mobile: boolean;
  reducedMotion: boolean;
  devicePixelRatio: number;
  // Keeps the idle foil shimmer running for a single foreground card while
  // retaining the cheaper mobile quality profile. Reduced Motion still wins.
  continuousIdle?: boolean;
  // Antialiasing and up to 2x on phones, for a card shown alone.
  sharp?: boolean;
  // Start with the card back facing the camera; playRevealFlip() spins it
  // front-side-out. Used by the pack opening reveal.
  startFaceDown?: boolean;
  // Disables the device-orientation tilt on mobile (pack reveals want a
  // steady card; touch drag still works).
  gyro?: boolean;
  /* A case grows around the card, which keeps its size, instead of card and
     case shrinking together into the card's frame. The host must leave room
     for it (sleeveReach). */
  sleeveGrows?: boolean;
  /* Paints the back after the card shows instead of before (createCardTextures):
     for a card opened face up, or one whose back is overridden (a reveal shows
     the stack's neutral back, not the card's own). */
  lazyBack?: boolean;
  onReady?: () => void;
  onError?: (error: unknown) => void;
}

interface IntroFlipAnimation {
  fromDeg: number;
  startTime: number | null;
  durationMs: number;
  resolve: () => void;
}

interface RendererDisposeOptions {
  deferGpuRelease?: boolean;
}

type IdleDeadlineLike = {
  didTimeout: boolean;
  timeRemaining: () => number;
};

type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (
    callback: (deadline: IdleDeadlineLike) => void,
    options?: { timeout?: number },
  ) => number;
};

function releaseRendererResources(callback: () => void, defer: boolean) {
  if (!defer || typeof window === "undefined") {
    callback();
    return;
  }

  const idleWindow = window as WindowWithIdleCallback;
  if (idleWindow.requestIdleCallback) {
    idleWindow.requestIdleCallback(callback, { timeout: 900 });
    return;
  }

  window.setTimeout(callback, 360);
}

// easeOutBack with a softened overshoot so the card snaps a few degrees past
// front-facing and settles, instead of wobbling.
function easeOutBackSoft(t: number) {
  const c1 = 1.10158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

export class ManiaCardRenderer {
  private readonly host: HTMLElement;
  private readonly renderer: WebGLRenderer;
  /* The renderer draws off the page; this 2D copy is what shows (gl-mirror.ts). */
  private readonly mirror: GlMirror;
  private readonly gyroEnabled: boolean;
  private readonly onReady?: () => void;
  private readonly onError?: (error: unknown) => void;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(CAMERA_FOV_DEG, 5 / 7, 0.1, 100);
  private readonly group = new Group();
  private readonly quality: QualityProfile;
  private readonly interaction: InteractionState = createInteractionState();
  private textures: CardTextureSet | null = null;
  private frameId: number | null = null;
  private disposed = false;
  private windowActive = true;
  private dataRequestId = 0;
  private readyTextureRequestId = 0;
  private dragStart: { x: number; y: number; rotation: Rotation2D } | null = null;
  private manualRotation: Rotation2D = { x: 0, y: 0 };
  private orientationRotation: Rotation2D = { x: 0, y: 0 };
  private overlay: Mesh | null = null;
  /* The drifting painted motif, on a card that has one (see createCardTextures). */
  private motifLayer: Mesh | null = null;
  // The supporter foil the overlay draws: set by setData, or alone by
  // setSupporterFoil, which needs no new textures.
  private supporterFoil: SupporterFoilId | null = null;
  private restBeta: number | null = null;
  private orientationAttached = false;
  private orientationPermissionRequested = false;
  private readyEmitted = false;
  private introRotationDeg = 0;
  private introAnim: IntroFlipAnimation | null = null;
  private backMesh: Mesh | null = null;
  private backOverrideCanvas: HTMLCanvasElement | null = null;
  private backOverrideTexture: CanvasTexture | null = null;
  /* The case the card's holder keeps it in (cardSleeve.ts), outside the card
     group so a new card does not rebuild it, turned with it every frame. */
  private sleeve: SupporterCardSleeveId | null = null;
  private sleeveMeshes: CardSleeveMeshes | null = null;
  private readonly sleeveGroup = new Group();
  /* The card level's halo (cardHalo.ts), in its own group for the same
     reason, turned with the card every frame. */
  private halo: CardHaloMesh | null = null;
  private lastDrawAt = 0;
  private compiledOnce = false;
  /* Cards painted ahead by prepare(), by their data. */
  private readonly prepared = new Map<string, { textures: Promise<CardTextureSet>; now: () => void }>();
  private fitting = false;
  private readonly haloGroup = new Group();
  private lastData: ManiaCardReadyData | null = null;
  /* Card and case ease to their fit instead of jumping when a case goes on or off. */
  private fit = { scale: 1, offsetY: 0 };
  private fitTarget = { scale: 1, offsetY: 0 };
  private sleeveIn = 1;
  private readonly sleeveGrows: boolean;
  private readonly lazyBack: boolean;
  /* How much larger than the host the canvas is: the tilt's room, and a
     growing case's. */
  private overscan = CANVAS_OVERSCAN;

  constructor(options: ManiaCardRendererOptions) {
    if (options.startFaceDown) this.introRotationDeg = 180;
    this.sleeveGrows = options.sleeveGrows ?? false;
    this.lazyBack = options.lazyBack === true;
    this.host = options.host;
    this.gyroEnabled = options.mobile && options.gyro !== false;
    this.onReady = options.onReady;
    this.onError = options.onError;
    this.quality = resolveQualityProfile({
      mobile: options.mobile,
      reducedMotion: options.reducedMotion,
      devicePixelRatio: options.devicePixelRatio,
      continuousIdle: options.continuousIdle,
      sharp: options.sharp,
    });
    this.renderer = new WebGLRenderer({
      antialias: this.quality.antialias,
      alpha: true,
      // One card's worth of drawing: the integrated GPU is plenty, and asking
      // for the discrete one wakes it on dual-GPU laptops.
      powerPreference: "default",
    });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    // drawn off the page, shown as a 2D copy that never flashes a lost context's white box
    this.mirror = mirrorGlCanvas(this.renderer.domElement);
    this.applyCanvasSize();
    // The canvas is larger than the host so the card can rotate past the host's
    // bounds without getting clipped (mirrors how the CSS card overflows its
    // container when tilted). We keep the host's size for layout and position
    // the canvas absolutely, centered, larger by CANVAS_OVERSCAN on each axis.
    const canvas = this.mirror.canvas;
    canvas.style.display = "block";
    canvas.style.position = "absolute";
    canvas.style.left = "50%";
    canvas.style.top = "50%";
    canvas.style.transform = "translate(-50%, -50%)";
    canvas.style.pointerEvents = "none";
    this.host.appendChild(canvas);
    // Distance derived from FOV + overscan so the card fills the host's height
    // (not the oversized canvas). Without this the card would appear larger
    // because the canvas covers more world space than the host. The 1.05
    // factor preserves the small breathing-room margin the card had before.
    this.placeCamera();
    this.scene.add(new AmbientLight(0xffffff, 1.4));
    this.scene.add(this.group);
    this.scene.add(this.sleeveGroup);
    this.scene.add(this.haloGroup);
    this.attachPointerEvents();
    if (this.gyroEnabled && !this.getOrientationPermissionRequester()) this.attachOrientationListener();
    void this.setData(options.data);
  }

  async setData(data: ManiaCardReadyData) {
    const requestId = ++this.dataRequestId;
    this.supporterFoil = data.supporterFoil ?? null;
    this.readyEmitted = false;
    this.readyTextureRequestId = 0;
    let textures: CardTextureSet;
    try {
      // driftingMotif: the overlay below floats the granted image, so the
      // front is painted without a still copy of it underneath. shaderFoil
      // likewise: the overlay draws a supporter's foil moving, so the front
      // does not bake the still one.
      const signature = JSON.stringify(data);
      const prepared = this.prepared.get(signature);
      this.prepared.delete(signature);
      // Still waiting for an idle moment to paint it: it is wanted now.
      prepared?.now();
      textures = prepared ? await prepared.textures.catch(() => this.paintTextures(data)) : await this.paintTextures(data);
    } catch (error) {
      if (!this.disposed && requestId === this.dataRequestId) this.onError?.(error);
      return;
    }
    if (this.disposed || requestId !== this.dataRequestId) {
      textures.dispose();
      return;
    }

    this.textures?.dispose();
    this.textures = textures;
    this.readyTextureRequestId = requestId;
    this.clearGroup();

    const body = new Mesh(createCardBodyGeometry(), createEdgeMaterial(data));
    const front = new Mesh(createCardFaceGeometry(), createFaceMaterial(textures.frontTexture));
    front.position.z = FACE_Z_OFFSET;

    const back = new Mesh(createCardFaceGeometry(), createFaceMaterial(this.resolveBackTexture(textures)));
    back.position.z = -FACE_Z_OFFSET;
    back.rotation.y = Math.PI;
    this.backMesh = back;

    this.overlay = new Mesh(
      createCardFaceGeometry(),
      createOverlayMaterial(data, textures.layout, this.quality.shaderQuality, textures.motif, textures.spellMask),
    );
    this.overlay.position.z = OVERLAY_Z_OFFSET;
    // A setSupporterFoil that came in while the textures were painting wins.
    this.applySupporterFoil();

    this.group.add(body, front, back, this.overlay);
    this.lastData = data;
    // The slab's label names the card, so a new card reprints it.
    if (this.sleeve) this.buildSleeve();
    this.motifLayer = null;
    if (textures.contentTexture && textures.motif) {
      // background, then the paint drifting over it, then everything printed
      // on the card, then the overlay's light; drawn in that order
      this.motifLayer = new Mesh(createCardFaceGeometry(), createMotifPaintMaterial(textures.motif));
      this.motifLayer.position.z = MOTIF_Z_OFFSET;
      const content = new Mesh(createCardFaceGeometry(), createFaceMaterial(textures.contentTexture));
      content.position.z = CONTENT_Z_OFFSET;
      front.renderOrder = 1;
      this.motifLayer.renderOrder = 2;
      content.renderOrder = 3;
      this.overlay.renderOrder = 4;
      this.group.add(this.motifLayer, content);
    }
    // A back painted after the card showed needs a frame to upload it, even
    // when the card is sitting still.
    void textures.backReady.then(() => {
      if (!this.disposed && this.textures === textures) this.start();
    });
    // Compiles the shaders off the main thread where the browser can
    // (KHR_parallel_shader_compile) instead of stalling the first frame.
    // Without it, compileAsync only warns and compiles on the spot. Only the
    // first card needs it: a renderer reused for the next card (the pack
    // reveal) has its programs already, and waiting on the check delayed
    // every "Next card".
    if (!this.compiledOnce && this.renderer.getContext().getExtension("KHR_parallel_shader_compile")) {
      this.compiledOnce = true;
      try {
        await this.renderer.compileAsync(this.scene, this.camera);
      } catch {
        // The first render compiles them the usual way.
      }
    }
    if (this.disposed || requestId !== this.dataRequestId) return;
    this.start();
  }

  private paintTextures(data: ManiaCardReadyData) {
    return createCardTextures(data, {
      textureScale: this.quality.textureScale,
      driftingMotif: true,
      shaderFoil: true,
      lazyBack: this.lazyBack,
    });
  }

  /* Paints a card that is about to be shown and uploads it to the GPU while
     the browser is idle, so the setData that shows it only swaps meshes. The
     pack reveal readies the next card this way: painting and uploading it on
     "Next card" froze the page for a beat. */
  prepare(data: ManiaCardReadyData) {
    const signature = JSON.stringify(data);
    if (this.disposed || this.prepared.has(signature)) return;
    // the one or two cards ahead, never a pile
    for (const [key, entry] of this.prepared) {
      if (this.prepared.size < 2) break;
      this.prepared.delete(key);
      void entry.textures.then((textures) => textures.dispose(), () => {});
    }
    let start = () => {};
    const pending = new Promise<void>((resolve) => {
      start = resolve;
      if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(() => resolve(), { timeout: 400 });
      else window.setTimeout(resolve, 60);
    })
      .then(() => this.paintTextures(data))
      .then((textures) => {
        if (this.disposed) return textures;
        for (const texture of [textures.frontTexture, textures.backTexture, textures.contentTexture]) {
          if (texture) this.renderer.initTexture(texture);
        }
        return textures;
      });
    // a failed paint is tried again by setData
    pending.catch(() => this.prepared.delete(signature));
    this.prepared.set(signature, { textures: pending, now: () => start() });
  }

  /* Swaps the supporter foil on the card already drawn: two uniforms, where
     setData would repaint every texture. */
  setSupporterFoil(foil: SupporterFoilId | null) {
    this.supporterFoil = foil;
    this.applySupporterFoil();
    this.start();
  }

  private applySupporterFoil() {
    const material = this.overlay?.material;
    if (!material || !("uniforms" in material)) return;
    const uniforms = material.uniforms as Record<string, { value: number }>;
    uniforms.uSupporter.value = this.supporterFoil ? 1 : 0;
    uniforms.uFoilStyle.value = this.supporterFoil ? supporterFoilIndex(this.supporterFoil) : 0;
  }

  /* Lights the card level's halo, or (null) puts it out. */
  setHalo(look: CardHaloLook | null) {
    this.halo?.dispose();
    this.halo = null;
    while (this.haloGroup.children.length > 0) this.haloGroup.remove(this.haloGroup.children[0]!);
    if (look) {
      this.halo = createCardHaloMesh(look);
      this.haloGroup.add(this.halo.mesh);
    }
    if (!this.sleeve) this.setOverscan(this.baseOverscan());
    this.start();
  }

  private baseOverscan() {
    return this.halo ? HALO_OVERSCAN : CANVAS_OVERSCAN;
  }

  /* Puts the card in its holder's case, or (null) takes it out. */
  setSleeve(sleeve: SupporterCardSleeveId | null) {
    if (this.sleeve === sleeve) return;
    this.sleeve = sleeve;
    this.buildSleeve();
    this.start();
  }

  private buildSleeve() {
    this.sleeveMeshes?.dispose();
    this.sleeveMeshes = null;
    while (this.sleeveGroup.children.length > 0) this.sleeveGroup.remove(this.sleeveGroup.children[0]!);
    if (!this.sleeve || !this.lastData) {
      this.fitTarget = { scale: 1, offsetY: 0 };
      this.setOverscan(this.baseOverscan());
      return;
    }
    this.sleeveMeshes = buildCardSleeve(this.sleeve, this.lastData);
    this.sleeveGroup.add(this.sleeveMeshes.group);
    if (this.sleeveGrows) {
      // The card stays where and how big it was; the canvas widens to show
      // the case around it, with the same room to tilt as before.
      const reach = sleeveReach(this.sleeve);
      const tall = 1 + 2 * Math.max(reach.top, reach.bottom);
      const wide = 1 + (2 * reach.side) / CARD_ASPECT;
      this.fitTarget = { scale: 1, offsetY: 0 };
      this.setOverscan(Math.max(tall, wide) * this.baseOverscan());
      this.sleeveIn = 0;
      return;
    }
    // Card and case shrink together so the case fills the frame the card did,
    // and both shift so the case, not the card, sits in the middle. The case
    // drops on from a little larger.
    const fit = sleeveFit(this.sleeve);
    this.fitTarget = { scale: fit.scale, offsetY: fit.cardOffsetY * fit.scale };
    this.sleeveIn = 0;
  }

  private applyFit(): boolean {
    const ease = (from: number, to: number) => (Math.abs(to - from) < 0.0005 ? to : from + (to - from) * 0.16);
    this.fit = { scale: ease(this.fit.scale, this.fitTarget.scale), offsetY: ease(this.fit.offsetY, this.fitTarget.offsetY) };
    this.sleeveIn = this.sleeveIn >= 0.999 ? 1 : this.sleeveIn + (1 - this.sleeveIn) * 0.14;
    this.group.scale.setScalar(this.fit.scale);
    this.group.position.set(0, this.fit.offsetY, 0);
    const drop = 1 + (1 - this.sleeveIn) * 0.12;
    this.haloGroup.scale.setScalar(this.fit.scale);
    this.haloGroup.position.set(0, this.fit.offsetY, 0);
    this.sleeveGroup.scale.setScalar(this.fit.scale * drop);
    this.sleeveGroup.position.set(0, this.fit.offsetY, (1 - this.sleeveIn) * 0.8);
    return this.fit.scale !== this.fitTarget.scale || this.fit.offsetY !== this.fitTarget.offsetY || this.sleeveIn < 1;
  }

  // Replaces the card-back art with an external canvas. The pack reveal uses
  // a tier-neutral back so the face-down card never spoils the pull. Pass
  // null to restore the card's own tier-styled back.
  setBackOverride(canvas: HTMLCanvasElement | null) {
    if (this.backOverrideCanvas === canvas) return;
    this.backOverrideCanvas = canvas;
    this.backOverrideTexture?.dispose();
    this.backOverrideTexture = null;
    if (this.backMesh && this.textures) {
      const material = this.backMesh.material;
      if (material && !Array.isArray(material)) material.dispose();
      this.backMesh.material = createFaceMaterial(this.resolveBackTexture(this.textures));
      this.start();
    }
  }

  private resolveBackTexture(textures: CardTextureSet) {
    if (!this.backOverrideCanvas) return textures.backTexture;
    if (!this.backOverrideTexture) {
      const texture = new CanvasTexture(this.backOverrideCanvas);
      texture.colorSpace = SRGBColorSpace;
      texture.minFilter = LinearFilter;
      texture.magFilter = LinearFilter;
      texture.needsUpdate = true;
      this.backOverrideTexture = texture;
    }
    return this.backOverrideTexture;
  }

  // Re-arms the face-down pose for the next reveal when a single renderer is
  // reused across cards. Call before setData so the new card never flashes
  // front-side-out.
  setFaceDown() {
    this.finishIntroAnim();
    this.introRotationDeg = 180;
    this.start();
  }

  playRevealFlip(durationMs = 950): Promise<void> {
    if (this.disposed || this.introRotationDeg === 0) return Promise.resolve();
    this.finishIntroAnim();
    return new Promise((resolve) => {
      this.introAnim = {
        fromDeg: this.introRotationDeg,
        startTime: null,
        durationMs: Math.max(1, durationMs),
        resolve,
      };
      this.start();
    });
  }

  private finishIntroAnim() {
    const pending = this.introAnim;
    this.introAnim = null;
    pending?.resolve();
  }

  /* Downscales the front texture the renderer already drew to a data URL.
     Far cheaper than rebuilding the textures from scratch; the pack reveal
     uses it for tray thumbnails after the flip lands. */
  snapshotFrontCanvas(width = 280): string | null {
    if (!this.textures?.avatarLoaded) return null;
    const image = this.textures?.composeFront();
    if (!(image instanceof HTMLCanvasElement)) return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.round(width * 1.4);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    try {
      // WebP like every other thumbnail: the shared pool only takes WebP, so
      // a PNG here was cached locally but always refused on upload.
      return canvas.toDataURL("image/webp", 0.86);
    } catch {
      return null;
    }
  }

  resize() {
    this.applyCanvasSize();
    this.start();
  }

  /* Pulls the camera back in step with the canvas, so the card keeps the
     same apparent size whatever the overscan. */
  private placeCamera() {
    const fovRad = (CAMERA_FOV_DEG * Math.PI) / 180;
    const cameraDistance = (CARD_WORLD_HEIGHT * this.overscan * 1.05) / (2 * Math.tan(fovRad / 2));
    this.camera.position.set(0, 0, cameraDistance);
  }

  private setOverscan(overscan: number) {
    if (Math.abs(overscan - this.overscan) < 0.001) return;
    this.overscan = overscan;
    this.applyCanvasSize();
    this.placeCamera();
  }

  private applyCanvasSize() {
    const hostWidth = Math.max(1, this.host.clientWidth);
    const hostHeight = Math.max(1, this.host.clientHeight);
    const canvasHeight = Math.max(1, Math.round(hostHeight * this.overscan));
    const canvasWidth = this.clampCanvasWidth(Math.round(hostWidth * this.overscan));
    this.renderer.setSize(canvasWidth, canvasHeight);
    this.mirror.canvas.style.width = `${canvasWidth}px`;
    this.mirror.canvas.style.height = `${canvasHeight}px`;
    this.camera.aspect = canvasWidth / canvasHeight;
    this.camera.updateProjectionMatrix();
  }

  // The canvas is centered on the host, so anything wider than twice the
  // distance from the host's center to the nearest viewport edge pokes past
  // the page edge and turns into horizontal page scroll on mobile. The FOV is
  // vertical, so losing width only crops the horizontal tilt bleed.
  private clampCanvasWidth(ideal: number): number {
    if (typeof document === "undefined") return Math.max(1, ideal);
    const viewportWidth = document.documentElement.clientWidth;
    if (!viewportWidth) return Math.max(1, ideal);
    const rect = this.host.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const available = Math.floor(2 * Math.min(centerX, viewportWidth - centerX));
    if (available <= 0) return Math.max(1, ideal);
    return Math.max(1, Math.min(ideal, available));
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

  dispose(options: RendererDisposeOptions = {}) {
    if (this.disposed) return;
    this.disposed = true;
    this.finishIntroAnim();
    this.dataRequestId += 1;
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.detachPointerEvents();
    if (this.orientationAttached && typeof window !== "undefined") {
      window.removeEventListener("deviceorientation", this.onDeviceOrientation);
      this.orientationAttached = false;
    }
    const textures = this.textures;
    const backOverrideTexture = this.backOverrideTexture;
    const group = this.group;
    const sleeveMeshes = this.sleeveMeshes;
    this.sleeveMeshes = null;
    const halo = this.halo;
    this.halo = null;
    for (const entry of this.prepared.values()) void entry.textures.then((textures) => textures.dispose(), () => {});
    this.prepared.clear();
    const renderer = this.renderer;
    const canvas = this.mirror.canvas;
    this.textures = null;
    this.backOverrideTexture = null;
    this.mirror.dispose();
    canvas.remove();

    releaseRendererResources(() => {
      textures?.dispose();
      backOverrideTexture?.dispose();
      sleeveMeshes?.dispose();
      halo?.dispose();
      group.traverse((object: Object3D) => {
        const mesh = object as Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
        for (const material of materials) material.dispose();
      });
      renderer.dispose();
      // dispose() alone leaves the WebGL context alive until the canvas is
      // garbage collected. Lingering contexts count against the browser's
      // per-page cap (~16), and hitting it force-loses the oldest live
      // context, which is the long-lived pack scene singleton.
      renderer.forceContextLoss();
    }, options.deferGpuRelease === true);
  }

  private clearGroup() {
    this.backMesh = null;
    this.motifLayer = null;
    while (this.group.children.length > 0) {
      const child = this.group.children[0];
      if (!child) continue;
      this.group.remove(child);
      const mesh = child as Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) material.dispose();
    }
  }

  private start() {
    if (this.frameId !== null) return;
    if (!this.windowActive) return;
    const tick = (time: number) => {
      if (this.disposed) return;
      this.frameId = null;
      if (this.onlyIdling() && time - this.lastDrawAt < IDLE_FRAME_MS) {
        this.start();
        return;
      }
      this.lastDrawAt = time;
      if (this.tick(time * 0.001)) this.start();
    };
    this.frameId = requestAnimationFrame(tick);
  }

  private tick(time: number) {
    if (this.introAnim) {
      const anim = this.introAnim;
      if (anim.startTime === null) anim.startTime = time;
      const progress = Math.min(1, ((time - anim.startTime) * 1000) / anim.durationMs);
      const eased = easeOutBackSoft(progress);
      this.introRotationDeg = anim.fromDeg * (1 - eased);
      // Sweep the foil light across the face while the card turns so the
      // reveal lands with a glint instead of a flat frame. The tail of the
      // sweep blends into the resting light so the foil pattern never snaps
      // on the final frame.
      const rest = pointerToLight(this.interaction.rotation);
      const sweepX = clamp(0.85 - eased * 0.7, 0.08, 0.92);
      const blendIn = clamp((progress - 0.72) / 0.28, 0, 1);
      const blend = blendIn * blendIn * (3 - 2 * blendIn);
      this.interaction.light = {
        x: sweepX + (rest.x - sweepX) * blend,
        y: 0.35 + (rest.y - 0.35) * blend,
      };
      if (progress >= 1) {
        this.introRotationDeg = 0;
        this.introAnim = null;
        this.interaction.light = pointerToLight(this.interaction.rotation);
        anim.resolve();
      }
    }

    const frontFacingOffset = this.interaction.flipped ? Math.PI : 0;
    this.group.rotation.x = (this.interaction.rotation.x * Math.PI) / 180;
    this.group.rotation.y =
      frontFacingOffset + ((this.interaction.rotation.y + this.introRotationDeg) * Math.PI) / 180;

    if (this.overlay?.material && "uniforms" in this.overlay.material) {
      const uniforms = this.overlay.material.uniforms as any;
      uniforms.uTime.value = time;
      uniforms.uLight.value.set(this.interaction.light.x, this.interaction.light.y);
    }
    if (this.motifLayer?.material && "uniforms" in this.motifLayer.material) {
      (this.motifLayer.material.uniforms as any).uTime.value = time;
    }
    const fitting = this.applyFit();
    this.fitting = fitting;
    if (this.halo) {
      this.haloGroup.rotation.x = this.group.rotation.x;
      this.haloGroup.rotation.y = this.group.rotation.y;
      this.halo.update(time);
    }
    if (this.sleeveMeshes) {
      this.sleeveGroup.rotation.x = this.group.rotation.x;
      this.sleeveGroup.rotation.y = this.group.rotation.y;
      this.sleeveMeshes.update(time, this.interaction.light);
    }

    this.renderer.render(this.scene, this.camera);
    this.mirror.copy();
    if (this.textures && !this.readyEmitted && this.readyTextureRequestId === this.dataRequestId) {
      this.readyEmitted = true;
      this.onReady?.();
    }
    return fitting || this.shouldKeepAnimating();
  }

  private setRotation(rotation: Rotation2D) {
    this.interaction.rotation = rotation;
    this.interaction.light = pointerToLight(rotation);
  }

  private applyOrientationRotation() {
    this.setRotation(addRotation(this.manualRotation, this.orientationRotation));
  }

  private onPointerDown = (event: PointerEvent) => {
    event.preventDefault();
    void this.requestOrientationPermission();
    this.dragStart = {
      x: event.clientX,
      y: event.clientY,
      rotation: { ...this.interaction.rotation },
    };
    this.interaction.dragging = true;
    this.interaction.lastInputAt = performance.now();
    this.host.setPointerCapture(event.pointerId);
    this.start();
  };

  private onPointerMove = (event: PointerEvent) => {
    if (!this.dragStart) return;
    const deltaRotation = pointerToRotation({
      deltaX: event.clientX - this.dragStart.x,
      deltaY: event.clientY - this.dragStart.y,
    });
    const rotation = addRotation(this.dragStart.rotation, deltaRotation);
    this.interaction.rotation = rotation;
    this.interaction.light = pointerToLight(rotation);
    this.interaction.lastInputAt = performance.now();
    this.start();
  };

  private onPointerUp = (event: PointerEvent) => {
    if (this.host.hasPointerCapture(event.pointerId)) {
      this.host.releasePointerCapture(event.pointerId);
    }
    this.dragStart = null;
    this.interaction.dragging = false;
    this.manualRotation = subtractRotation(this.interaction.rotation, this.orientationRotation);
    this.interaction.lastInputAt = performance.now();
    this.start();
  };

  private onDeviceOrientation = (event: DeviceOrientationEvent) => {
    if (event.beta === null || event.gamma === null) return;
    if (this.restBeta === null) this.restBeta = event.beta;
    if (this.interaction.dragging) return;

    this.orientationRotation = orientationToRotation({
      beta: event.beta,
      gamma: event.gamma,
      restBeta: this.restBeta,
    });
    this.applyOrientationRotation();
    this.interaction.lastInputAt = performance.now();
    this.start();
  };

  private onlyIdling() {
    if (!this.readyEmitted || this.introAnim || this.fitting || this.interaction.dragging) return false;
    return performance.now() - this.interaction.lastInputAt > 900;
  }

  private shouldKeepAnimating() {
    if (this.introAnim) return true;
    if (this.halo) return true;
    if (this.quality.idleMotion === "continuous") return true;
    if (this.interaction.dragging) return true;
    const inputAge = performance.now() - this.interaction.lastInputAt;
    if (this.quality.idleMotion === "wake-on-input" && inputAge < 900) return true;
    return false;
  }

  private getOrientationPermissionRequester() {
    if (!this.gyroEnabled || typeof window === "undefined" || !("DeviceOrientationEvent" in window)) return null;

    const OrientationEvent = window.DeviceOrientationEvent as DeviceOrientationEventWithPermission;
    return typeof OrientationEvent.requestPermission === "function" ? OrientationEvent.requestPermission.bind(OrientationEvent) : null;
  }

  private async requestOrientationPermission() {
    if (this.orientationPermissionRequested || this.orientationAttached) return;
    const requestPermission = this.getOrientationPermissionRequester();
    if (!requestPermission) return;

    this.orientationPermissionRequested = true;
    try {
      if ((await requestPermission()) === "granted") this.attachOrientationListener();
    } catch {
      // Touch drag remains the fallback when orientation permission is unavailable.
    }
  }

  private attachPointerEvents() {
    this.host.addEventListener("pointerdown", this.onPointerDown);
    this.host.addEventListener("pointermove", this.onPointerMove);
    this.host.addEventListener("pointerup", this.onPointerUp);
    this.host.addEventListener("pointercancel", this.onPointerUp);
  }

  private detachPointerEvents() {
    this.host.removeEventListener("pointerdown", this.onPointerDown);
    this.host.removeEventListener("pointermove", this.onPointerMove);
    this.host.removeEventListener("pointerup", this.onPointerUp);
    this.host.removeEventListener("pointercancel", this.onPointerUp);
  }

  private attachOrientationListener() {
    if (
      this.disposed ||
      this.orientationAttached ||
      !this.gyroEnabled ||
      typeof window === "undefined" ||
      !("DeviceOrientationEvent" in window)
    ) {
      return;
    }
    window.addEventListener("deviceorientation", this.onDeviceOrientation);
    this.orientationAttached = true;
  }
}
