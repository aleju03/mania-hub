declare module "three" {
  export class Quaternion {}

  export class Object3D {
    children: Object3D[];
    position: { x: number; y: number; z: number; set: (...args: any[]) => void };
    rotation: { x: number; y: number; z: number; set: (...args: any[]) => void };
    scale: { x: number; y: number; z: number; setScalar: (value: number) => void };
    quaternion: Quaternion;
    renderOrder: number;
    add(...objects: Object3D[]): void;
    remove(...objects: Object3D[]): void;
    traverse(callback: (object: Object3D) => void): void;
    getWorldPosition(target: Vector3): Vector3;
    worldToLocal(vector: Vector3): Vector3;
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
    attributes: {
      position: {
        count: number;
        getX(index: number): number;
        getY(index: number): number;
        setZ(index: number, z: number): void;
      };
    };
    constructor(...args: any[]);
    computeBoundingBox(): void;
    computeVertexNormals(): void;
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
    x: number;
    y: number;
    constructor(...args: any[]);
    set(x: number, y: number): this;
  }

  export class Vector3 {
    x: number;
    y: number;
    z: number;
    constructor(...args: any[]);
    set(x: number, y: number, z: number): this;
    applyQuaternion(quaternion: Quaternion): this;
  }

  export class Vector4 {
    constructor(...args: any[]);
  }

  export class Plane {
    constructor(...args: any[]);
    setFromNormalAndCoplanarPoint(normal: Vector3, point: Vector3): this;
  }

  export class Raycaster {
    ray: { intersectPlane(plane: Plane, target: Vector3): Vector3 | null };
    constructor(...args: any[]);
    setFromCamera(coords: Vector2, camera: PerspectiveCamera): void;
  }

  export class MeshBasicMaterial {
    constructor(...args: any[]);
    dispose(): void;
  }

  export class MeshStandardMaterial {
    map: Texture | null;
    transparent: boolean;
    opacity: number;
    alphaTest: number;
    depthWrite: boolean;
    side: unknown;
    roughness: number;
    metalness: number;
    envMapIntensity: number;
    needsUpdate: boolean;
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

  export class DirectionalLight extends Object3D {
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
    background: unknown;
    environment: Texture | null;
    constructor(...args: any[]);
    add(...objects: Object3D[]): void;
  }

  export class WebGLRenderer {
    domElement: HTMLElement;
    capabilities: { getMaxAnisotropy(): number };
    constructor(...args: any[]);
    setSize(...args: any[]): void;
    setPixelRatio(...args: any[]): void;
    render(...args: any[]): void;
    compile(...args: any[]): void;
    dispose(): void;
  }

  export class PMREMGenerator {
    constructor(renderer: WebGLRenderer);
    fromScene(scene: Scene, sigma?: number): { texture: Texture };
    dispose(): void;
  }

  export class Texture {
    dispose(): void;
  }

  export class CanvasTexture extends Texture {
    image: HTMLCanvasElement;
    minFilter: unknown;
    magFilter: unknown;
    colorSpace: unknown;
    anisotropy: number;
    needsUpdate: boolean;
    constructor(...args: any[]);
  }

  export const LinearFilter: unknown;
  export const SRGBColorSpace: unknown;
  export const DoubleSide: unknown;
}

declare module "three/*";
