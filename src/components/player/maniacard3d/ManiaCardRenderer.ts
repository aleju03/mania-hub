import {
  AmbientLight,
  Group,
  Mesh,
  PerspectiveCamera,
  Scene,
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
import { resolveQualityProfile, type QualityProfile } from "./layout";
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
  onReady?: () => void;
  onError?: (error: unknown) => void;
}

export class ManiaCardRenderer {
  private readonly host: HTMLElement;
  private readonly renderer: WebGLRenderer;
  private readonly mobile: boolean;
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
  private dataRequestId = 0;
  private dragStart: { x: number; y: number; rotation: Rotation2D } | null = null;
  private manualRotation: Rotation2D = { x: 0, y: 0 };
  private orientationRotation: Rotation2D = { x: 0, y: 0 };
  private overlay: Mesh | null = null;
  private restBeta: number | null = null;
  private orientationAttached = false;
  private orientationPermissionRequested = false;
  private readyEmitted = false;

  constructor(options: ManiaCardRendererOptions) {
    this.host = options.host;
    this.mobile = options.mobile;
    this.onReady = options.onReady;
    this.onError = options.onError;
    this.quality = resolveQualityProfile({
      mobile: options.mobile,
      reducedMotion: options.reducedMotion,
      devicePixelRatio: options.devicePixelRatio,
    });
    this.renderer = new WebGLRenderer({ antialias: this.quality.antialias, alpha: true });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.setSize(
      Math.max(1, Math.round(this.host.clientWidth * CANVAS_OVERSCAN)),
      Math.max(1, Math.round(this.host.clientHeight * CANVAS_OVERSCAN)),
    );
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
    canvas.style.pointerEvents = "auto";
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
    if (options.mobile && !this.getOrientationPermissionRequester()) this.attachOrientationListener();
    void this.setData(options.data);
  }

  async setData(data: ManiaCardReadyData) {
    const requestId = ++this.dataRequestId;
    this.readyEmitted = false;
    let textures: CardTextureSet;
    try {
      textures = await createCardTextures(data);
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
    this.clearGroup();

    const body = new Mesh(createCardBodyGeometry(), createEdgeMaterial(data));
    const front = new Mesh(createCardFaceGeometry(), createFaceMaterial(textures.frontTexture));
    front.position.z = FACE_Z_OFFSET;

    const back = new Mesh(createCardFaceGeometry(), createFaceMaterial(textures.backTexture));
    back.position.z = -FACE_Z_OFFSET;
    back.rotation.y = Math.PI;

    this.overlay = new Mesh(createCardFaceGeometry(), createOverlayMaterial(data, textures.layout));
    this.overlay.position.z = OVERLAY_Z_OFFSET;

    this.group.add(body, front, back, this.overlay);
    this.start();
  }

  resize() {
    const hostWidth = Math.max(1, this.host.clientWidth);
    const hostHeight = Math.max(1, this.host.clientHeight);
    const overscan = CANVAS_OVERSCAN;
    const canvasWidth = Math.round(hostWidth * overscan);
    const canvasHeight = Math.round(hostHeight * overscan);
    this.renderer.setSize(canvasWidth, canvasHeight);
    this.camera.aspect = canvasWidth / canvasHeight;
    this.camera.updateProjectionMatrix();
    this.start();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.dataRequestId += 1;
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.detachPointerEvents();
    if (this.orientationAttached && typeof window !== "undefined") {
      window.removeEventListener("deviceorientation", this.onDeviceOrientation);
      this.orientationAttached = false;
    }
    this.textures?.dispose();
    this.group.traverse((object: Object3D) => {
      const mesh = object as Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) material.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private clearGroup() {
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
    const tick = (time: number) => {
      if (this.disposed) return;
      this.frameId = null;
      if (this.tick(time * 0.001)) this.start();
    };
    this.frameId = requestAnimationFrame(tick);
  }

  private tick(time: number) {
    const frontFacingOffset = this.interaction.flipped ? Math.PI : 0;
    this.group.rotation.x = (this.interaction.rotation.x * Math.PI) / 180;
    this.group.rotation.y = frontFacingOffset + (this.interaction.rotation.y * Math.PI) / 180;

    if (this.overlay?.material && "uniforms" in this.overlay.material) {
      const uniforms = this.overlay.material.uniforms as any;
      uniforms.uTime.value = time;
      uniforms.uLight.value.set(this.interaction.light.x, this.interaction.light.y);
    }

    this.renderer.render(this.scene, this.camera);
    if (this.textures && !this.readyEmitted) {
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
    this.renderer.domElement.setPointerCapture(event.pointerId);
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
    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) {
      this.renderer.domElement.releasePointerCapture(event.pointerId);
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
    if (this.quality.idleMotion === "continuous") return true;
    if (this.interaction.dragging) return true;
    const inputAge = performance.now() - this.interaction.lastInputAt;
    if (this.quality.idleMotion === "wake-on-input" && inputAge < 900) return true;
    return false;
  }

  private getOrientationPermissionRequester() {
    if (!this.mobile || typeof window === "undefined" || !("DeviceOrientationEvent" in window)) return null;

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
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.addEventListener("pointercancel", this.onPointerUp);
  }

  private detachPointerEvents() {
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.removeEventListener("pointercancel", this.onPointerUp);
  }

  private attachOrientationListener() {
    if (
      this.disposed ||
      this.orientationAttached ||
      !this.mobile ||
      typeof window === "undefined" ||
      !("DeviceOrientationEvent" in window)
    ) {
      return;
    }
    window.addEventListener("deviceorientation", this.onDeviceOrientation);
    this.orientationAttached = true;
  }
}
