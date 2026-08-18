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
import { createCardBodyGeometry, createCardFaceGeometry, FACE_Z_OFFSET, OVERLAY_Z_OFFSET } from "./cardGeometry";
import { createEdgeMaterial, createFaceMaterial, createOverlayMaterial } from "./cardMaterials";
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
import { clamp, resolveQualityProfile, type QualityProfile } from "./layout";
import type { ManiaCardReadyData } from "./types";
import { CARD_WORLD_HEIGHT } from "./cardGeometry";

// The canvas extends past the host on every side by this factor so the card can
// rotate past the host's bounds without getting clipped. The renderer pushes
// the camera back to compensate, so the card keeps the same apparent size as
// at overscan = 1.0.
const CANVAS_OVERSCAN = 1.28;
const CAMERA_FOV_DEG = 35;

type DeviceOrientationEventWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<PermissionState>;
};

export interface ManiaCardRendererOptions {
  host: HTMLElement;
  data: ManiaCardReadyData;
  mobile: boolean;
  reducedMotion: boolean;
  devicePixelRatio: number;
  // Start with the card back facing the camera; playRevealFlip() spins it
  // front-side-out. Used by the pack opening reveal.
  startFaceDown?: boolean;
  // Disables the device-orientation tilt on mobile (pack reveals want a
  // steady card; touch drag still works).
  gyro?: boolean;
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
  private restBeta: number | null = null;
  private orientationAttached = false;
  private orientationPermissionRequested = false;
  private readyEmitted = false;
  private introRotationDeg = 0;
  private introAnim: IntroFlipAnimation | null = null;
  private backMesh: Mesh | null = null;
  private backOverrideCanvas: HTMLCanvasElement | null = null;
  private backOverrideTexture: CanvasTexture | null = null;

  constructor(options: ManiaCardRendererOptions) {
    if (options.startFaceDown) this.introRotationDeg = 180;
    this.host = options.host;
    this.gyroEnabled = options.mobile && options.gyro !== false;
    this.onReady = options.onReady;
    this.onError = options.onError;
    this.quality = resolveQualityProfile({
      mobile: options.mobile,
      reducedMotion: options.reducedMotion,
      devicePixelRatio: options.devicePixelRatio,
    });
    this.renderer = new WebGLRenderer({
      antialias: this.quality.antialias,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.applyCanvasSize();
    // The canvas is larger than the host so the card can rotate past the host's
    // bounds without getting clipped (mirrors how the CSS card overflows its
    // container when tilted). We keep the host's size for layout and position
    // the canvas absolutely, centered, larger by CANVAS_OVERSCAN on each axis.
    const canvas = this.renderer.domElement;
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
    const fovRad = (CAMERA_FOV_DEG * Math.PI) / 180;
    const cameraDistance = (CARD_WORLD_HEIGHT * CANVAS_OVERSCAN * 1.05) / (2 * Math.tan(fovRad / 2));
    this.camera.position.set(0, 0, cameraDistance);
    this.scene.add(new AmbientLight(0xffffff, 1.4));
    this.scene.add(this.group);
    this.attachPointerEvents();
    if (this.gyroEnabled && !this.getOrientationPermissionRequester()) this.attachOrientationListener();
    void this.setData(options.data);
  }

  async setData(data: ManiaCardReadyData) {
    const requestId = ++this.dataRequestId;
    this.readyEmitted = false;
    this.readyTextureRequestId = 0;
    let textures: CardTextureSet;
    try {
      // driftingMotif: the overlay below floats the granted image, so the
      // front is painted without a still copy of it underneath.
      textures = await createCardTextures(data, {
        textureScale: this.quality.textureScale,
        driftingMotif: true,
      });
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
      createOverlayMaterial(data, textures.layout, this.quality.shaderQuality, textures.motif),
    );
    this.overlay.position.z = OVERLAY_Z_OFFSET;

    this.group.add(body, front, back, this.overlay);
    this.start();
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
    const image = this.textures?.frontTexture.image;
    if (!(image instanceof HTMLCanvasElement)) return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.round(width * 1.4);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    try {
      return canvas.toDataURL("image/png");
    } catch {
      return null;
    }
  }

  resize() {
    this.applyCanvasSize();
    this.start();
  }

  private applyCanvasSize() {
    const hostWidth = Math.max(1, this.host.clientWidth);
    const hostHeight = Math.max(1, this.host.clientHeight);
    const canvasHeight = Math.max(1, Math.round(hostHeight * CANVAS_OVERSCAN));
    const canvasWidth = this.clampCanvasWidth(Math.round(hostWidth * CANVAS_OVERSCAN));
    this.renderer.setSize(canvasWidth, canvasHeight);
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
    const renderer = this.renderer;
    const canvas = this.renderer.domElement;
    this.textures = null;
    this.backOverrideTexture = null;
    canvas.remove();

    releaseRendererResources(() => {
      textures?.dispose();
      backOverrideTexture?.dispose();
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

    this.renderer.render(this.scene, this.camera);
    if (this.textures && !this.readyEmitted && this.readyTextureRequestId === this.dataRequestId) {
      this.readyEmitted = true;
      this.onReady?.();
    }
    return this.shouldKeepAnimating();
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

  private shouldKeepAnimating() {
    if (this.introAnim) return true;
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
