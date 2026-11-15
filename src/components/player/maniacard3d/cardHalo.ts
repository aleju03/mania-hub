import { DoubleSide, Mesh, PlaneGeometry, ShaderMaterial, Vector2 } from "three";
import { CARD_WORLD_HEIGHT } from "./cardGeometry";
import { CARD_ASPECT, CARD_CORNER_RADIUS, CARD_TEXTURE_HEIGHT } from "./layout";

/* The halo a high-level card wears when it is opened: a glow hugging the
   card's edge with a brighter band travelling round it and a thin lit rim,
   breathing slowly. Silver from card level 3, gold from 5, a turning rainbow
   from 7 (the same steps as the level gem, packs/run/MasteryBadge.tsx). It is a
   plane in the card's own group, so it tilts and turns with the card; inside
   the card's outline it draws nothing. */

export type CardHaloLook = "silver" | "gold" | "prism";

export function cardHaloLook(level: number): CardHaloLook | null {
  if (level >= 7) return "prism";
  if (level >= 5) return "gold";
  if (level >= 3) return "silver";
  return null;
}

/* How far the plane reaches past the card on every side, in card heights.
   The glow has faded to nothing well inside it. */
export const CARD_HALO_BLEED = 0.16;
/* How long it takes to come up. */
const FADE_S = 0.7;

const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform float uTime; uniform float uFade; uniform vec2 uSize; uniform float uRadius; uniform int uLook;
float sdBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
vec3 hsv(float h, float s, float v){ vec3 k = clamp(abs(mod(h*6.+vec3(0,4,2),6.)-3.)-1.,0.,1.); return v*mix(vec3(1),k,s); }
void main(){
  // card half-height units, y up, card centre at 0
  vec2 p = (vUv - .5) * uSize;
  float t = uTime;
  float d = sdBox(p, vec2(${CARD_ASPECT.toFixed(5)}, 1.), uRadius);
  float ang = atan(p.y, p.x);
  float pulse = .75 + .25 * sin(t * 1.6);
  float band = .55 + .45 * sin(ang * 2. - t * 1.2);
  float glow = exp(-max(d, 0.) * 9.) * (.55 + .45 * band) * pulse;
  float rim = smoothstep(.03, 0., abs(d - .015)) * .8;
  float heat = clamp(glow * .8, 0., 1.);
  vec3 col;
  if (uLook == 2) {
    float h = ang / 6.2831 + t * .06 + p.y * .15;
    col = mix(hsv(h, .85, .55), hsv(h + .08, .45, 1.), heat);
  } else if (uLook == 1) {
    col = mix(vec3(.66, .36, .06), vec3(1., .86, .45), heat);
  } else {
    // polished steel: a cool blue base the glare runs over, so it reads as
    // metal rather than grey haze
    float glare = pow(.5 + .5 * sin(ang * 2. - t * 1.2), 10.);
    col = mix(vec3(.22, .36, .58), vec3(.78, .9, 1.), heat);
    col = mix(col, vec3(1.), glare * .75);
  }
  // fades out toward the plane's edge so it never shows a seam
  float edge = smoothstep(0., .08, min(min(vUv.x, 1. - vUv.x), min(vUv.y, 1. - vUv.y)));
  // nothing inside the face, with a soft edge so its outline stays smooth
  float outside = smoothstep(-.004, .004, d);
  float strength = uLook == 0 ? .7 : .85;
  float a = clamp(glow * strength + rim * pulse, 0., 1.) * outside * uFade * edge;
  gl_FragColor = vec4(col, a);
}`;

export interface CardHaloMesh {
  mesh: Mesh;
  update(time: number): void;
  dispose(): void;
}

export function createCardHaloMesh(look: CardHaloLook): CardHaloMesh {
  const height = CARD_WORLD_HEIGHT * (1 + 2 * CARD_HALO_BLEED);
  const width = CARD_WORLD_HEIGHT * (CARD_ASPECT + 2 * CARD_HALO_BLEED);
  const geometry = new PlaneGeometry(width, height);
  const material = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    // The faces are rectangles with see-through rounded corners that still
    // write depth; tested against them, the glow went missing at each corner.
    // Its own cut-out keeps it off the card instead.
    depthTest: false,
    side: DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uFade: { value: 0 },
      uSize: { value: new Vector2((width / CARD_WORLD_HEIGHT) * 2, (height / CARD_WORLD_HEIGHT) * 2) },
      // the face's painted corner, in half-heights
      uRadius: { value: (CARD_CORNER_RADIUS / CARD_TEXTURE_HEIGHT) * 2 },
      uLook: { value: look === "prism" ? 2 : look === "gold" ? 1 : 0 },
    },
  });
  const mesh = new Mesh(geometry, material);
  // drawn after the card's layers; its inside is empty, so it covers nothing
  // of the face
  mesh.renderOrder = 5;
  let startedAt: number | null = null;
  return {
    mesh,
    update(time) {
      if (startedAt === null) startedAt = time;
      const k = Math.min(1, (time - startedAt) / FADE_S);
      material.uniforms.uFade!.value = k * k * (3 - 2 * k);
      material.uniforms.uTime!.value = time;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
