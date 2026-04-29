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
  createInteractionState,
  orientationToRotation,
  pointerToLight,
  pointerToRotation,
  settleRotation,
  type InteractionState,
} from "./interactions";
import { resolveQualityProfile, type QualityProfile } from "./layout";
import type { ManiaCardReadyData } from "./types";

export interface ManiaCardRendererOptions {
  host: HTMLElement;
  data: ManiaCardReadyData;
  mobile: boolean;
  reducedMotion: boolean;
  devicePixelRatio: number;
}

export class ManiaCardRenderer {
  private readonly host: HTMLElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(35, 5 / 7, 0.1, 100);
  private readonly group = new Group();
  private readonly quality: QualityProfile;
  private readonly interaction: InteractionState = createInteractionState();
  private textures: CardTextureSet | null = null;
  private frameId: number | null = null;
  private disposed = false;
  private dataRequestId = 0;
  private dragStart: { x: number; y: number } | null = null;
  private overlay: Mesh | null = null;
  private restBeta: number | null = null;
  private orientationAttached = false;

  constructor(options: ManiaCardRendererOptions) {
    this.host = options.host;
    this.quality = resolveQualityProfile({
      mobile: options.mobile,
      reducedMotion: options.reducedMotion,
      devicePixelRatio: options.devicePixelRatio,
    });
    this.renderer = new WebGLRenderer({ antialias: this.quality.antialias, alpha: true });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.setSize(this.host.clientWidth, this.host.clientHeight, false);
    this.host.appendChild(this.renderer.domElement);
    this.camera.position.set(0, 0, 7);
    this.scene.add(new AmbientLight(0xffffff, 1.4));
    this.scene.add(this.group);
    this.attachPointerEvents();
    if (options.mobile && typeof window !== "undefined" && "DeviceOrientationEvent" in window) {
      window.addEventListener("deviceorientation", this.onDeviceOrientation);
      this.orientationAttached = true;
    }
    void this.setData(options.data);
  }

  async setData(data: ManiaCardReadyData) {
    const requestId = ++this.dataRequestId;
    const textures = await createCardTextures(data);
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
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
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
      this.frameId = requestAnimationFrame(tick);
      this.tick(time * 0.001);
    };
    this.frameId = requestAnimationFrame(tick);
  }

  private tick(time: number) {
    if (!this.interaction.dragging && this.quality.idleMotion !== "continuous") {
      this.interaction.rotation = settleRotation(this.interaction.rotation, 0.08);
    } else if (this.quality.idleMotion === "continuous") {
      this.interaction.rotation.x += Math.sin(time * 0.9) * 0.005;
      this.interaction.rotation.y += Math.sin(time * 0.7) * 0.01;
    }

    const frontFacingOffset = this.interaction.flipped ? Math.PI : 0;
    this.group.rotation.x = (this.interaction.rotation.x * Math.PI) / 180;
    this.group.rotation.y = frontFacingOffset + (this.interaction.rotation.y * Math.PI) / 180;

    if (this.overlay?.material && "uniforms" in this.overlay.material) {
      const uniforms = this.overlay.material.uniforms;
      uniforms.uTime.value = time;
      uniforms.uLight.value.set(this.interaction.light.x, this.interaction.light.y);
    }

    this.renderer.render(this.scene, this.camera);
  }

  private onPointerDown = (event: PointerEvent) => {
    this.dragStart = { x: event.clientX, y: event.clientY };
    this.interaction.dragging = true;
    this.renderer.domElement.setPointerCapture(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent) => {
    if (!this.dragStart) return;
    const rotation = pointerToRotation({
      deltaX: event.clientX - this.dragStart.x,
      deltaY: event.clientY - this.dragStart.y,
    });
    this.interaction.rotation = rotation;
    this.interaction.light = pointerToLight(rotation);
    this.interaction.lastInputAt = performance.now();
  };

  private onPointerUp = (event: PointerEvent) => {
    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) {
      this.renderer.domElement.releasePointerCapture(event.pointerId);
    }
    if (this.dragStart) {
      const dx = Math.abs(event.clientX - this.dragStart.x);
      const dy = Math.abs(event.clientY - this.dragStart.y);
      if (dx < 8 && dy < 8) this.interaction.flipped = !this.interaction.flipped;
    }
    this.dragStart = null;
    this.interaction.dragging = false;
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
  };

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
}
