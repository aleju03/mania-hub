declare module "three" {
  export class Object3D {
    children: Object3D[];
    position: { x: number; y: number; z: number; set: (...args: any[]) => void };
    rotation: { x: number; y: number; z: number };
    add(...objects: Object3D[]): void;
    remove(...objects: Object3D[]): void;
    traverse(callback: (object: Object3D) => void): void;
  }

  export class Mesh extends Object3D {
    geometry?: { dispose: () => void };
    material?: { dispose: () => void } | Array<{ dispose: () => void }>;
    constructor(...args: any[]);
  }

  export class ExtrudeGeometry {
    boundingBox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null;
    constructor(...args: any[]);
    computeBoundingBox(): void;
    translate(...args: any[]): void;
    dispose(): void;
  }

  export class PlaneGeometry {
    boundingBox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null;
    constructor(...args: any[]);
    computeBoundingBox(): void;
    dispose(): void;
  }

  export class Shape {
    constructor(...args: any[]);
    moveTo(...args: any[]): void;
    lineTo(...args: any[]): void;
    quadraticCurveTo(...args: any[]): void;
  }

  export class Color {
    constructor(...args: any[]);
  }

  export class Vector2 {
    constructor(...args: any[]);
  }

  export class Vector3 {
    constructor(...args: any[]);
  }

  export class Vector4 {
    constructor(...args: any[]);
  }

  export class MeshBasicMaterial {
    constructor(...args: any[]);
    dispose(): void;
  }

  export class MeshStandardMaterial {
    constructor(...args: any[]);
    dispose(): void;
  }

  export class ShaderMaterial {
    uniforms: any;
    constructor(...args: any[]);
    dispose(): void;
  }

  export class AmbientLight extends Object3D {
    constructor(...args: any[]);
  }

  export class Group extends Object3D {
    constructor(...args: any[]);
  }

  export class PerspectiveCamera extends Object3D {
    aspect: number;
    constructor(...args: any[]);
    updateProjectionMatrix(): void;
  }

  export class Scene extends Object3D {
    constructor(...args: any[]);
    add(...objects: Object3D[]): void;
  }

  export class WebGLRenderer {
    domElement: HTMLElement;
    constructor(...args: any[]);
    setSize(...args: any[]): void;
    setPixelRatio(...args: any[]): void;
    render(...args: any[]): void;
    dispose(): void;
  }

  export class Texture {
    dispose(): void;
  }

  export class CanvasTexture extends Texture {
    minFilter: unknown;
    magFilter: unknown;
    colorSpace: unknown;
    needsUpdate: boolean;
    constructor(...args: any[]);
  }

  export const LinearFilter: unknown;
  export const SRGBColorSpace: unknown;
}

declare module "three/*";
