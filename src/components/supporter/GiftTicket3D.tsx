import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";

import { mountFoilSource } from "./FoilPreview";

/* The gift ticket on /support as a real object: a thick ticket in 3D with its
   two notches and a gap where it tears, floating and swaying, tipping toward
   the pointer, its stub printed on the live holo foil (the same shader as the
   card foils, its light following the tilt) and a faint wash of the same foil
   across the body, with a soft gloss where the tilt catches the light. It drops in the first time
   it scrolls into view and the code's characters spin and land one by one; a
   click flicks the ticket round and rolls the code again. Draws only while on
   screen. It can be grabbed: spun round side to side and tipped a little, and let go it spins on
   the speed it had until it slows onto its front or its back, which is
   printed too. `fallback` shows instead where WebGL is missing. */

const W = 2.6;
const H = 1;
const STUB_X = 2.0;
const DEPTH = 0.035;
const CORNER = 0.08;
const NOTCH = 0.075;
const GAP = 0.012;
const FACE_W = 2048;
const FACE_H = Math.round((FACE_W * H) / W);
const CODE = "K7QDM2XP";
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LAND_MS = 110;
const SCRAMBLE_DELAY_MS = 450;
const DRAG_RADIANS_PER_PX = 0.011;
const MAX_SPIN = 28;
/* Below this speed (radians a second) a let-go ticket starts settling onto a face. */
const SETTLE_SPEED = 2.2;
/* How far it tips forward or back (radians). It spins freely side to side,
   but tipping over the long edge would land it upside down. */
const MAX_TILT = 0.55;

const VERTEX = `
uniform vec2 uSize;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vView;
varying float vBack;
void main() {
  vUv = uv / uSize;
  vBack = normal.z < -0.5 ? 1.0 : 0.0;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = normalize(-mv.xyz);
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT = `
uniform sampler2D uFace;
uniform sampler2D uFoil;
uniform sampler2D uBack;
uniform float uStubX;
uniform vec2 uLight;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vView;
varying float vBack;
void main() {
  vec4 face = texture2D(uFace, vUv);
  vec3 col;
  if (vBack > 0.5) {
    // the back, seen from behind: the whole of it on the foil, under its own print
    vec2 flipped = vec2(1.0 - vUv.x, vUv.y);
    vec4 foil = texture2D(uFoil, flipped);
    vec4 back = texture2D(uBack, flipped);
    col = mix(vec3(0.13, 0.1, 0.2), foil.rgb, foil.a * 0.9);
    col = mix(col, back.rgb, back.a);
  } else if (vUv.x > uStubX) {
    vec4 foil = texture2D(uFoil, vec2((vUv.x - uStubX) / (1.0 - uStubX), vUv.y));
    col = mix(vec3(0.165, 0.141, 0.251), foil.rgb, foil.a);
    col = mix(col, face.rgb, face.a);
  } else {
    vec4 foil = texture2D(uFoil, vec2(vUv.x / uStubX, vUv.y));
    col = 1.0 - (1.0 - face.rgb) * (1.0 - foil.rgb * foil.a * 0.3);
  }
  float fresnel = pow(1.0 - max(dot(vNormal, vView), 0.0), 2.0);
  // a soft light where the tilt points, like a lamp caught in the gloss
  vec2 toLight = (vUv - uLight) * vec2(${(W / H).toFixed(2)}, 1.0);
  float gloss = exp(-dot(toLight, toLight) * 2.2);
  col += gloss * 0.16 + fresnel * 0.18;
  gl_FragColor = vec4(col, 1.0);
}
`;

interface Labels {
  gift: string;
  title: string;
  days: string;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/* The ticket's print: the body in pink with its label, title and
   code slots, and the stub's "7 days" over nothing, so the foil shows. */
function drawFace(ctx: CanvasRenderingContext2D, labels: Labels, font: string, heart: HTMLImageElement | null, chars: string, flashes: number[]) {
  const stub = Math.round((STUB_X / W) * FACE_W);
  ctx.clearRect(0, 0, FACE_W, FACE_H);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, stub, FACE_H);
  ctx.clip();
  const fill = ctx.createLinearGradient(0, 0, stub, FACE_H);
  fill.addColorStop(0, "#ff7ab6");
  fill.addColorStop(0.45, "#ff4f9a");
  fill.addColorStop(1, "#c2357a");
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, stub, FACE_H);

  const left = 96;
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "alphabetic";
  if (heart) {
    ctx.save();
    ctx.filter = "brightness(0) invert(1)";
    ctx.globalAlpha = 0.85;
    ctx.drawImage(heart, left, 120, 56, 56);
    ctx.restore();
  }
  ctx.globalAlpha = 0.85;
  ctx.font = `700 44px ${font}`;
  ctx.letterSpacing = "10px";
  ctx.fillText(labels.gift.toUpperCase(), left + 76, 164);
  ctx.globalAlpha = 1;
  ctx.letterSpacing = "0px";
  ctx.font = `900 108px ${font}`;
  ctx.fillText(labels.title, left, 310);

  const slotW = 140, slotH = 172, gap = 18, dash = 58;
  let x = left;
  const y = 396;
  ctx.font = `700 100px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < chars.length; i++) {
    if (i === chars.length / 2) {
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      roundRect(ctx, x + 2, y + slotH / 2 - 4, dash - 4 - gap, 8, 4);
      ctx.fill();
      x += dash;
    }
    const flash = flashes[i] ?? 0;
    ctx.fillStyle = `rgba(0,0,0,${0.25 * (1 - flash)})`;
    roundRect(ctx, x, y, slotW, slotH, 18);
    ctx.fill();
    if (flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${0.5 * flash})`;
      ctx.fill();
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillText(chars[i], x + slotW / 2, y + slotH / 2 + 4);
    x += slotW + gap;
  }
  ctx.textAlign = "left";
  ctx.restore();

  const mid = stub + (FACE_W - stub) / 2;
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 4;
  ctx.font = `900 250px ${font}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText("7", mid, FACE_H / 2 + 70);
  ctx.font = `700 46px ${font}`;
  ctx.letterSpacing = "10px";
  ctx.fillText(labels.days.toUpperCase(), mid + 5, FACE_H / 2 + 160);
  ctx.restore();
}

/* The back's print, laid out as seen from behind: the heart, the label and
   the title over nothing, so the foil shows through all of it. */
function drawBack(ctx: CanvasRenderingContext2D, labels: Labels, font: string, heart: HTMLImageElement | null) {
  ctx.clearRect(0, 0, FACE_W, FACE_H);
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 16;
  if (heart) {
    ctx.save();
    ctx.filter = "brightness(0) invert(1)";
    ctx.drawImage(heart, FACE_W / 2 - 110, 150, 220, 220);
    ctx.restore();
  }
  ctx.font = `700 50px ${font}`;
  ctx.letterSpacing = "14px";
  ctx.fillText(labels.gift.toUpperCase(), FACE_W / 2 + 7, 480);
  ctx.letterSpacing = "0px";
  ctx.font = `900 72px ${font}`;
  ctx.globalAlpha = 0.9;
  ctx.fillText(labels.title, FACE_W / 2, 580);
  ctx.restore();
}

function easeOutBack(p: number) {
  const c = 1.5;
  return 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2;
}

export function GiftTicket3D({ fallback }: { fallback: ReactNode }) {
  const { t } = useLingui();
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const labels: Labels = { gift: t`Gift`, title: t`One week of supporter`, days: t`days` };
  const labelsRef = useRef(labels);
  labelsRef.current = labels;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void import("three").then((THREE) => {
      if (disposed) return;
      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try {
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
      } catch {
        setFailed(true);
        return;
      }
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const canvas = renderer.domElement;
      canvas.style.cssText = "display:block;width:100%;height:100%";
      host.appendChild(canvas);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);

      const face = document.createElement("canvas");
      face.width = FACE_W;
      face.height = FACE_H;
      const faceCtx = face.getContext("2d")!;
      const faceTexture = new THREE.CanvasTexture(face);
      faceTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

      const back = document.createElement("canvas");
      back.width = FACE_W;
      back.height = FACE_H;
      const backCtx = back.getContext("2d")!;
      const backTexture = new THREE.CanvasTexture(back);
      backTexture.anisotropy = faceTexture.anisotropy;

      const foil = document.createElement("canvas");
      foil.width = 360;
      foil.height = 504;
      const foilSource = mountFoilSource(foil, "holo");
      const foilTexture = new THREE.CanvasTexture(foil);

      const material = new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: {
          uFace: { value: faceTexture },
          uFoil: { value: foilTexture },
          uBack: { value: backTexture },
          uSize: { value: new THREE.Vector2(W, H) },
          uStubX: { value: STUB_X / W },
          uLight: { value: new THREE.Vector2(0.5, 0.5) },
        },
      });
      const bodyEdge = new THREE.MeshBasicMaterial({ color: new THREE.Color("#a82a63") });
      const stubEdge = new THREE.MeshBasicMaterial({ color: new THREE.Color("#3a3350") });

      // The body and the stub, cut apart at the tear with a notch bitten out at each end.
      const bite = Math.acos(GAP / NOTCH);
      const lift = NOTCH * Math.sin(bite);
      const body = new THREE.Shape();
      body.moveTo(CORNER, 0);
      body.lineTo(STUB_X - NOTCH, 0);
      body.absarc(STUB_X, 0, NOTCH, Math.PI, Math.PI - bite, true);
      body.lineTo(STUB_X - GAP, H - lift);
      body.absarc(STUB_X, H, NOTCH, Math.PI + bite, Math.PI, true);
      body.lineTo(CORNER, H);
      body.absarc(CORNER, H - CORNER, CORNER, Math.PI / 2, Math.PI, false);
      body.lineTo(0, CORNER);
      body.absarc(CORNER, CORNER, CORNER, Math.PI, Math.PI * 1.5, false);
      const stub = new THREE.Shape();
      stub.moveTo(STUB_X + NOTCH, 0);
      stub.lineTo(W - CORNER, 0);
      stub.absarc(W - CORNER, CORNER, CORNER, -Math.PI / 2, 0, false);
      stub.lineTo(W, H - CORNER);
      stub.absarc(W - CORNER, H - CORNER, CORNER, 0, Math.PI / 2, false);
      stub.lineTo(STUB_X + NOTCH, H);
      stub.absarc(STUB_X, H, NOTCH, 0, -bite, true);
      stub.lineTo(STUB_X + GAP, lift);
      stub.absarc(STUB_X, 0, NOTCH, bite, 0, true);
      const extrude = { depth: DEPTH, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 2, curveSegments: 16 };
      const bodyGeometry = new THREE.ExtrudeGeometry(body, extrude);
      const stubGeometry = new THREE.ExtrudeGeometry(stub, extrude);
      bodyGeometry.translate(-W / 2, -H / 2, -DEPTH / 2);
      stubGeometry.translate(-W / 2, -H / 2, -DEPTH / 2);
      const ticket = new THREE.Group();
      ticket.add(new THREE.Mesh(bodyGeometry, [material, bodyEdge]), new THREE.Mesh(stubGeometry, [material, stubEdge]));
      scene.add(ticket);

      const font = getComputedStyle(document.body).fontFamily || "sans-serif";
      let heart: HTMLImageElement | null = null;
      let chars = CODE;
      let flashes: number[] = [];
      const paint = () => {
        drawFace(faceCtx, labelsRef.current, font, heart, chars, flashes);
        faceTexture.needsUpdate = true;
      };
      const paintBack = () => {
        drawBack(backCtx, labelsRef.current, font, heart);
        backTexture.needsUpdate = true;
      };
      const image = new Image();
      image.onload = () => {
        heart = image;
        paint();
        paintBack();
      };
      image.src = "/images/icons/supporter-heart.svg";
      void document.fonts.ready.then(() => {
        if (disposed) return;
        paint();
        paintBack();
      });
      paint();
      paintBack();

      const resize = () => {
        const width = host.clientWidth, height = host.clientHeight;
        if (!width || !height) return;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        // Far enough back that the ticket, with room to sway, fits the box.
        camera.position.set(0, 0, Math.max((W * 1.22) / camera.aspect, H * 1.5) / (2 * Math.tan((15 * Math.PI) / 180)));
        camera.updateProjectionMatrix();
      };
      const resizer = new ResizeObserver(resize);
      resizer.observe(host);
      resize();

      let visible = false;
      let entered = 0;
      let scramble = 0;
      // Where the ticket is turned to and how fast it turns (radians, radians a second).
      const rot = { x: 0, y: 0 };
      const vel = { x: 0, y: 0 };
      const hover = { x: 0, y: 0, tx: 0, ty: 0 };
      let drag: { id: number; x: number; y: number; at: number; moved: number } | null = null;
      const watcher = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        foilSource.setVisible(visible);
        if (visible && !entered) {
          entered = performance.now();
          scramble = entered + SCRAMBLE_DELAY_MS;
        }
        if (visible) queue();
      }, { threshold: 0.25 });
      watcher.observe(host);

      /* Dragging turns it under the pointer; letting go leaves it spinning
         on the speed it had, slowing until it settles face up or face down.
         A press without a drag flicks it round and rolls the code again. */
      const onDown = (event: PointerEvent) => {
        if (event.button !== 0) return;
        try {
          host.setPointerCapture(event.pointerId);
        } catch {
          // Capture only keeps the drag when the pointer leaves the box.
        }
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now(), moved: 0 };
        vel.x = 0;
        vel.y = 0;
        host.style.cursor = "grabbing";
      };
      const onMove = (event: PointerEvent) => {
        const box = host.getBoundingClientRect();
        hover.tx = ((event.clientX - box.left) / box.width - 0.5) * 2;
        hover.ty = ((event.clientY - box.top) / box.height - 0.5) * 2;
        if (!drag || event.pointerId !== drag.id) return;
        const now = performance.now();
        const dt = Math.max(1, now - drag.at) / 1000;
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        // Seen from behind, the long axis points the other way, so a drag down still tips the near edge down.
        const facing = Math.cos(rot.y) < 0 ? -1 : 1;
        const turnY = dx * DRAG_RADIANS_PER_PX, turnX = dy * DRAG_RADIANS_PER_PX * facing;
        // Tipping further out gets stiffer, like bending card stock.
        const outward = Math.sign(turnX) === Math.sign(rot.x);
        const give = outward ? Math.max(0, 1 - (Math.abs(rot.x) / MAX_TILT) ** 2) : 1;
        const nextX = Math.max(-MAX_TILT, Math.min(MAX_TILT, rot.x + turnX * give));
        const movedX = nextX - rot.x;
        rot.y += turnY;
        rot.x = nextX;
        vel.y = vel.y * 0.4 + (turnY / dt) * 0.6;
        vel.x = vel.x * 0.4 + (movedX / dt) * 0.6;
        drag.x = event.clientX;
        drag.y = event.clientY;
        drag.at = now;
        queue();
      };
      const onUp = (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.id) return;
        const flick = drag.moved < 6 && event.type === "pointerup";
        // A pointer held still before letting go has no speed left.
        if (performance.now() - drag.at > 80) {
          vel.x = 0;
          vel.y = 0;
        }
        drag = null;
        host.style.cursor = "";
        if (flick) {
          vel.y += 11;
          scramble = performance.now() + 150;
        }
        vel.x = Math.max(-6, Math.min(6, vel.x));
        vel.y = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, vel.y));
        queue();
      };
      const onLeave = () => {
        hover.tx = 0;
        hover.ty = 0;
      };
      host.addEventListener("pointerdown", onDown);
      host.addEventListener("pointermove", onMove);
      host.addEventListener("pointerup", onUp);
      host.addEventListener("pointercancel", onUp);
      host.addEventListener("pointerleave", onLeave);

      let frame = 0;
      let last = performance.now();
      const start = last;
      const queue = () => {
        if (!frame && !disposed) frame = requestAnimationFrame(tick);
      };
      const tick = (now: number) => {
        frame = 0;
        if (disposed || !visible) return;
        const time = (now - start) / 1000;
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;

        // The code: random characters until each lands in turn, each landing flashing its slot.
        if (scramble && now >= scramble) {
          const landed = Math.floor((now - scramble) / LAND_MS);
          chars = Array.from(CODE, (ch, i) => (i < landed ? ch : CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)])).join("");
          flashes = Array.from(CODE, (_, i) => (i < landed ? Math.max(0, 1 - (now - scramble - (i + 1) * LAND_MS) / 350) : 0));
          paint();
          if (landed >= CODE.length && flashes.every((f) => f === 0)) scramble = 0;
        }

        if (!drag) {
          rot.x += vel.x * dt;
          if (Math.abs(rot.x) > MAX_TILT) {
            rot.x = Math.sign(rot.x) * MAX_TILT;
            vel.x *= -0.3;
          }
          rot.y += vel.y * dt;
          const friction = Math.exp(-dt * 1.1);
          vel.x *= friction;
          vel.y *= friction;
          // Slow enough, it springs to the nearest face (either side) and upright.
          if (Math.abs(vel.y) < SETTLE_SPEED) vel.y += ((Math.round(rot.y / Math.PI) * Math.PI - rot.y) * 26 - vel.y * 6) * dt;
          // Tipped, it always comes back level.
          vel.x += (-rot.x * 30 - vel.x * 7) * dt;
        }

        // At rest it sways and leans toward the pointer; while it is handled, it does not.
        const calm = drag ? 0 : Math.max(0, 1 - (Math.abs(vel.x) + Math.abs(vel.y)) / 2.5);
        hover.x += (hover.tx - hover.x) * 0.08;
        hover.y += (hover.ty - hover.y) * 0.08;
        const sway = reduced ? 0 : calm;
        let rotY = rot.y + (hover.x * 0.32 + Math.sin(time * 0.7) * 0.14) * sway;
        let rotX = rot.x + (hover.y * 0.28 + Math.cos(time * 0.55) * 0.07) * sway;
        let y = Math.sin(time * 1.1) * 0.035 * sway;
        let scale = 1;
        if (entered && !reduced) {
          const p = Math.min(1, (now - entered) / 1100);
          const e = easeOutBack(p);
          rotY += (1 - e) * -1.1;
          rotX += (1 - e) * 0.7;
          y += (1 - e) * 0.6;
          scale = 0.6 + 0.4 * Math.min(1, e);
        }
        ticket.rotation.set(rotX, rotY, Math.sin(time * 0.4) * 0.025 * sway - 0.02 * calm);
        ticket.position.set(0, y, 0);
        ticket.scale.setScalar(scale);

        material.uniforms.uLight.value.set(0.5 + Math.sin(rotY) * 0.9, 0.55 - Math.sin(rotX) * 0.9);
        foilSource.setPointer([0.5 + rotY * 1.1, 0.5 - rotX * 1.1]);
        foilTexture.needsUpdate = true;
        renderer.render(scene, camera);
        queue();
      };

      cleanup = () => {
        cancelAnimationFrame(frame);
        watcher.disconnect();
        resizer.disconnect();
        host.removeEventListener("pointerdown", onDown);
        host.removeEventListener("pointermove", onMove);
        host.removeEventListener("pointerup", onUp);
        host.removeEventListener("pointercancel", onUp);
        host.removeEventListener("pointerleave", onLeave);
        foilSource.dispose();
        bodyGeometry.dispose();
        stubGeometry.dispose();
        material.dispose();
        bodyEdge.dispose();
        stubEdge.dispose();
        faceTexture.dispose();
        backTexture.dispose();
        foilTexture.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        canvas.remove();
      };
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  if (failed) return <>{fallback}</>;
  return <div ref={hostRef} className="mx-auto aspect-[2.25/1] w-full max-w-[640px] cursor-grab touch-pan-y select-none" role="img" aria-label={`${labels.title}: ${CODE.slice(0, 4)}-${CODE.slice(4)}`} />;
}
