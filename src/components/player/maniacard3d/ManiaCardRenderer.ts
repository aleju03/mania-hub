import {
  AmbientLight,
  Group,
  Mesh,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "three";
import { createCardBodyGeometry, createCardFaceGeometry, FACE_Z_OFFSET, OVERLAY_Z_OFFSET } from "./cardGeometry";
import { createEdgeMaterial, createFaceMaterial, createOverlayMaterial } from "./cardMaterials";
import { createCardTextures, type CardTextureSet } from "./cardTexture";
import {
  addRotation,
  createInteractionState,
  orientationToRotation,
  pointerToLight,
  pointerToRotation,
  type InteractionState,
  type Rotation2D,
} from "./interactions";
import { resolveQualityProfile, type QualityProfile } from "./layout";
import type { ManiaCardReadyData } from "./types";

type DeviceOrientationEventWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<PermissionState>;
};

export interface ManiaCardRendererOptions {
  host: HTMLElement;
  data: ManiaCardReadyData;
  mobile: boolean;
  reducedMotion: boolean;
  devicePixelRatio: number;
  onError?: (error: unknown) => void;
}

export class ManiaCardRenderer {
  private readonly host: HTMLElement;
  private readonly renderer: WebGLRenderer;
  private readonly mobile: boolean;
  private readonly onError?: (error: unknown) => void;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(35, 5 / 7, 0.1, 100);
  private readonly group = new Group();
  private readonly quality: QualityProfile;
  private readonly interaction: InteractionState = createInteractionState();
  private textures: CardTextureSet | null = null;
  private frameId: number | null = null;
  private disposed = false;
  private dataRequestId = 0;
  private dragStart: { x: number; y: number; rotation: Rotation2D } | null = null;
  private overlay: Mesh | null = null;
  private restBeta: number | null = null;
  private orientationAttached = false;
  private orientationPermissionRequested = false;

  constructor(options: ManiaCardRendererOptions) {
    this.host = options.host;
    this.mobile = options.mobile;
    this.onError = options.onError;
    this.quality = resolveQualityProfile({
      mobile: options.mobile,
      reducedMotion: options.reducedMotion,
      devicePixelRatio: options.devicePixelRatio,
    });
    this.renderer = new WebGLRenderer({ antialias: this.quality.antialias, alpha: true });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.setSize(this.host.clientWidth, this.host.clientHeight);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.host.appendChild(this.renderer.domElement);
    this.camera.position.set(0, 0, 7);
    this.scene.add(new AmbientLight(0xffffff, 1.4));
    this.scene.add(this.group);
    this.attachPointerEvents();
    if (options.mobile && !this.getOrientationPermissionRequester()) this.attachOrientationListener();
    void this.setData(options.data);
  }

  async setData(data: ManiaCardReadyData) {
    const requestId = ++this.dataRequestId;
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
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
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
    this.group.traverse((object) => {
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
      const uniforms = this.overlay.material.uniforms;
      uniforms.uTime.value = time;
      uniforms.uLight.value.set(this.interaction.light.x, this.interaction.light.y);
    }

    this.renderer.render(this.scene, this.camera);
    return this.shouldKeepAnimating();
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
    this.interaction.lastInputAt = performance.now();
    this.start();
  };

  private onDeviceOrientation = (event: DeviceOrientationEvent) => {
    if (event.beta === null || event.gamma === null) return;
    if (this.restBeta === null) this.restBeta = event.beta;
    if (this.interaction.dragging) return;

    const rotation = orientationToRotation({
      beta: event.beta,
      gamma: event.gamma,
      restBeta: this.restBeta,
    });
    this.interaction.rotation = rotation;
    this.interaction.light = pointerToLight(rotation);
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
