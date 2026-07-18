import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { AuthViewer } from "../../lib/auth-shared";

// Real mania players sampled from a farm-helper peer band; shown as the
// neighbor nodes. Hover reveals the username, click opens the profile.
const PEERS: { id: number; name: string }[] = [
  { id: 13018117, name: "josiaxarg" },
  { id: 9895650, name: "XxNewson1234xX" },
  { id: 36327194, name: "_Myuka_" },
  { id: 13347579, name: "LeMarcinho" },
  { id: 20834055, name: "_yea" },
  { id: 5243536, name: "etterna in osu" },
  { id: 3262821, name: "[SPNG] Sim0" },
  { id: 16233256, name: "Yuna-" },
  { id: 16447598, name: "Earther06" },
  { id: 26853124, name: "osu mania gamer" },
  { id: 9169747, name: "Nathanial" },
  { id: 15944956, name: "MatchaLatte-" },
  { id: 13349388, name: "Achino" },
  { id: 18466725, name: "Apol-" },
  { id: 16492260, name: "parac0sm" },
  { id: 32565926, name: "resmis" },
  { id: 25847548, name: "baconpower008" },
  { id: 35678629, name: "TetoNotFound" },
  { id: 28282580, name: "Theangeloflie" },
  { id: 8474029, name: "wonder5193" },
  { id: 11488604, name: "CrewK" },
  { id: 17036965, name: "PouSlayer" },
  { id: 11183413, name: "CertifiedPinoy" },
  { id: 25263357, name: "rikan" },
];
const CROWD_COUNT = 44;
const GUEST_AVATAR = "https://osu.ppy.sh/images/layout/avatar-guest@2x.png";
const PULSE_MS = 2100;
const AUTO_SPIN = 0.09; // rad/s, paused while grabbing
const DRAG_SENSITIVITY = 0.006; // rad per px

type Mat3 = [number, number, number, number, number, number, number, number, number];

const rotX = (a: number): Mat3 => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const rotY = (a: number): Mat3 => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];

function mul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9) as Mat3;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
    }
  }
  return out;
}

interface GraphNode {
  peer: { id: number; name: string } | null;
  // rest position on the unit sphere, scaled by shell
  px: number;
  py: number;
  pz: number;
  size: number;
  driftPhase: number;
  driftSpeed: number;
  img: HTMLImageElement | null;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fibonacci sphere: evenly distributed points, organic once jittered.
function buildNodes(): GraphNode[] {
  const rng = mulberry32(727);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const nodes: GraphNode[] = PEERS.map((peer, i) => {
    const y = 1 - (2 * (i + 0.5)) / PEERS.length;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * golden + (rng() - 0.5) * 0.3;
    const shell = 0.82 + rng() * 0.22;
    return {
      peer,
      px: Math.cos(phi) * r * shell,
      py: y * shell,
      pz: Math.sin(phi) * r * shell,
      size: 12.5 + rng() * 3,
      driftPhase: rng() * Math.PI * 2,
      driftSpeed: 0.2 + rng() * 0.25,
      img: null,
    };
  });
  for (let i = 0; i < CROWD_COUNT; i++) {
    const y = 1 - 2 * rng();
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = rng() * Math.PI * 2;
    const shell = 0.7 + rng() * 0.5;
    nodes.push({
      peer: null,
      px: Math.cos(phi) * r * shell,
      py: y * shell,
      pz: Math.sin(phi) * r * shell,
      size: 1.3 + rng() * 1.4,
      driftPhase: rng() * Math.PI * 2,
      driftSpeed: 0.18 + rng() * 0.28,
      img: null,
    });
  }
  return nodes;
}

export function NeighborhoodGraph({ viewer }: { viewer: AuthViewer | null }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodes = useMemo(buildNodes, []);
  const navigate = useNavigate();
  const viewerAvatarUrl = viewer?.avatarUrl ?? null;

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rootStyles = getComputedStyle(document.documentElement);
    const hue = rootStyles.getPropertyValue("--theme-hue").trim() || "333";
    const sat = Number.parseFloat(rootStyles.getPropertyValue("--theme-sat")) || 1;
    const pink = `hsl(${hue}, ${100 * sat}%, 70%)`;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0;
    let height = 0;

    let staticDrawScheduled = false;
    const drawStatic = () => {
      if (!reducedMotion || staticDrawScheduled) return;
      staticDrawScheduled = true;
      requestAnimationFrame((now) => {
        staticDrawScheduled = false;
        draw(now);
      });
    };

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      drawStatic();
    };

    const loadImage = (src: string): HTMLImageElement => {
      const img = new Image();
      img.src = src;
      img.onload = drawStatic;
      return img;
    };
    for (const node of nodes) {
      if (node.peer && !node.img) node.img = loadImage(`https://a.ppy.sh/${node.peer.id}`);
    }
    const centerImg = loadImage(viewerAvatarUrl ?? GUEST_AVATAR);

    const avatarNodes = nodes.filter((n) => n.peer);

    // Mesh edges between neighbors that rest close together on the sphere.
    const meshEdges: [GraphNode, GraphNode][] = [];
    for (const a of avatarNodes) {
      const byDist = avatarNodes
        .filter((b) => b !== a)
        .map((b) => ({ b, d: Math.hypot(a.px - b.px, a.py - b.py, a.pz - b.pz) }))
        .sort((u, v) => u.d - v.d);
      for (const { b, d } of byDist.slice(0, 2)) {
        if (d > 0.85) continue;
        if (meshEdges.some(([u, v]) => (u === a && v === b) || (u === b && v === a))) continue;
        meshEdges.push([a, b]);
      }
    }
    const pulseOrder = avatarNodes.map((_, i) => (i * 7) % avatarNodes.length);

    // trackball rotation: drag turns the sphere around screen axes, grabbing
    // pauses the ambient spin, release keeps momentum then settles back
    let rotation = rotX(0.3);
    const vel = { pitch: 0, yaw: 0 };
    const drag = { active: false, moved: 0, lastX: 0, lastY: 0, pointerId: -1 };
    const cursor = { x: -1e4, y: -1e4, inside: false };

    interface Projected {
      x: number;
      y: number;
      depth: number; // 0 back .. 1 front
      r: number;
    }

    const project = (node: GraphNode, t: number): Projected => {
      const m = rotation;
      const x = m[0] * node.px + m[1] * node.py + m[2] * node.pz;
      const y = m[3] * node.px + m[4] * node.py + m[5] * node.pz;
      const z = m[6] * node.px + m[7] * node.py + m[8] * node.pz;
      const depth = (z + 1.25) / 2.5;
      const scale = 0.62 + 0.55 * depth;
      const wobble = (t / 1000) * node.driftSpeed + node.driftPhase;
      return {
        x: width * 0.5 + x * width * 0.42 + 2.5 * Math.sin(wobble),
        y: height * 0.5 + y * height * 0.42 + 2.5 * Math.cos(wobble * 0.85),
        depth,
        r: node.size * scale,
      };
    };

    const hitTest = (t: number): GraphNode | null => {
      if (!cursor.inside) return null;
      let bestNode: GraphNode | null = null;
      let bestDepth = -1;
      for (const node of avatarNodes) {
        const p = project(node, t);
        const d = Math.hypot(p.x - cursor.x, p.y - cursor.y);
        if (d <= p.r + 3 && p.depth > bestDepth) {
          bestDepth = p.depth;
          bestNode = node;
        }
      }
      return bestNode;
    };

    let lastFrameT = 0;

    const onPointerDown = (event: PointerEvent) => {
      drag.active = true;
      drag.moved = 0;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      drag.pointerId = event.pointerId;
      vel.pitch = 0;
      vel.yaw = 0;
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      cursor.x = event.clientX - rect.left;
      cursor.y = event.clientY - rect.top;
      cursor.inside = true;
      if (drag.active && event.pointerId === drag.pointerId) {
        const dx = event.clientX - drag.lastX;
        const dy = event.clientY - drag.lastY;
        drag.lastX = event.clientX;
        drag.lastY = event.clientY;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        // the sphere's front face follows the cursor
        const yaw = dx * DRAG_SENSITIVITY;
        const pitch = -dy * DRAG_SENSITIVITY;
        rotation = mul(rotX(pitch), mul(rotY(yaw), rotation));
        vel.yaw = 0.7 * vel.yaw + 0.3 * yaw;
        vel.pitch = 0.7 * vel.pitch + 0.3 * pitch;
      }
      drawStatic();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (drag.active && event.pointerId === drag.pointerId) {
        drag.active = false;
        if (drag.moved < 5) {
          const target = hitTest(lastFrameT);
          if (target?.peer) {
            navigate({ to: "/player/$username", params: { username: target.peer.name } });
          }
        }
      }
    };
    const onPointerLeave = () => {
      cursor.inside = false;
      cursor.x = -1e4;
      cursor.y = -1e4;
      drawStatic();
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);

    const edgeLine = (
      from: { x: number; y: number },
      to: { x: number; y: number },
      gapFrom: number,
      gapTo: number,
      alpha: number,
      color: string,
      lineWidth: number,
    ) => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const d = Math.hypot(dx, dy);
      if (d < gapFrom + gapTo + 2) return;
      const ux = dx / d;
      const uy = dy / d;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(from.x + ux * gapFrom, from.y + uy * gapFrom);
      ctx.lineTo(to.x - ux * gapTo, to.y - uy * gapTo);
      ctx.stroke();
      ctx.restore();
    };

    const circleImage = (img: HTMLImageElement, x: number, y: number, r: number, alpha = 1) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
      ctx.restore();
    };

    const draw = (now: number) => {
      const dt = Math.min(64, Math.max(0, now - lastFrameT));
      lastFrameT = now;

      // momentum + ambient spin, both only while the sphere isn't held
      if (!drag.active) {
        const spin = reducedMotion ? 0 : (AUTO_SPIN * dt) / 1000;
        const yaw = vel.yaw + spin;
        if (Math.abs(yaw) > 1e-6 || Math.abs(vel.pitch) > 1e-6) {
          rotation = mul(rotX(vel.pitch), mul(rotY(yaw), rotation));
        }
        vel.yaw *= 0.94;
        vel.pitch *= 0.94;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const t = reducedMotion ? 0 : now;
      const center = { x: width * 0.5, y: height * 0.5 };
      const centerR = 26;

      const projected = new Map<GraphNode, Projected>();
      for (const node of nodes) projected.set(node, project(node, t));

      const hovered = drag.active ? null : hitTest(t);
      canvas.style.cursor = drag.active ? "grabbing" : hovered ? "pointer" : "grab";

      // edges under everything
      for (const [a, b] of meshEdges) {
        const pa = projected.get(a)!;
        const pb = projected.get(b)!;
        const depth = (pa.depth + pb.depth) / 2;
        edgeLine(pa, pb, pa.r + 3, pb.r + 3, 0.02 + 0.045 * depth, "#ffffff", 1);
      }
      for (const node of avatarNodes) {
        const p = projected.get(node)!;
        const emphasized = node === hovered;
        edgeLine(
          center,
          p,
          centerR + 5,
          p.r + 3,
          emphasized ? 0.35 : 0.03 + 0.08 * p.depth,
          emphasized ? pink : "#ffffff",
          emphasized ? 1.4 : 1,
        );
      }

      // travelling spark on one spoke at a time
      if (!reducedMotion && avatarNodes.length > 0) {
        const slot = Math.floor(now / PULSE_MS);
        const target = avatarNodes[pulseOrder[slot % pulseOrder.length]];
        if (target !== hovered) {
          const k = (now % PULSE_MS) / PULSE_MS;
          const p = projected.get(target)!;
          const dx = p.x - center.x;
          const dy = p.y - center.y;
          const d = Math.hypot(dx, dy);
          const from = centerR + 5;
          const to = d - p.r - 3;
          if (to > from) {
            const along = from + (to - from) * k;
            ctx.save();
            ctx.globalAlpha = (0.25 + 0.5 * p.depth) * Math.sin(Math.PI * k);
            ctx.fillStyle = pink;
            ctx.beginPath();
            ctx.arc(center.x + (dx / d) * along, center.y + (dy / d) * along, 1.8, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }
      }

      // nodes back-to-front, with "you" slotted in at mid depth
      const order: (GraphNode | null)[] = [...nodes].sort(
        (a, b) => projected.get(a)!.depth - projected.get(b)!.depth,
      );
      const centerIndex = order.findIndex((n) => projected.get(n!)!.depth >= 0.5);
      order.splice(centerIndex === -1 ? order.length : centerIndex, 0, null);

      for (const node of order) {
        if (node === null) {
          ctx.save();
          ctx.strokeStyle = pink;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(center.x, center.y, centerR + 2.5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
          if (centerImg.complete && centerImg.naturalWidth > 0) {
            circleImage(centerImg, center.x, center.y, centerR);
          }
          ctx.save();
          ctx.fillStyle = pink;
          ctx.font = "700 11px system-ui";
          ctx.textAlign = "center";
          ctx.fillText("you", center.x, center.y + centerR + 18);
          ctx.restore();
          continue;
        }
        const p = projected.get(node)!;
        if (!node.peer) {
          ctx.save();
          ctx.globalAlpha = 0.08 + 0.26 * p.depth;
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          continue;
        }
        const emphasized = node === hovered;
        const r = p.r + (emphasized ? 2 : 0);
        const alpha = emphasized ? 1 : 0.45 + 0.55 * p.depth;
        if (node.img?.complete && node.img.naturalWidth > 0) {
          circleImage(node.img, p.x, p.y, r, alpha);
        } else {
          ctx.save();
          ctx.globalAlpha = 0.25 * alpha;
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
        ctx.save();
        ctx.globalAlpha = emphasized ? 0.9 : 0.15 + 0.25 * p.depth;
        ctx.strokeStyle = emphasized ? pink : "#ffffff";
        ctx.lineWidth = emphasized ? 1.8 : 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 0.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // hovered username
      if (hovered) {
        const p = projected.get(hovered)!;
        ctx.save();
        ctx.font = "600 11px system-ui";
        ctx.textAlign = "center";
        ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
        ctx.shadowBlur = 5;
        ctx.fillStyle = "#ffffff";
        ctx.fillText(hovered.peer!.name, p.x, p.y - p.r - 9);
        ctx.restore();
      }
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);

    let rafId = 0;
    if (reducedMotion) {
      drawStatic();
    } else {
      const tick = (now: number) => {
        draw(now);
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [nodes, viewerAvatarUrl, navigate]);

  return (
    <div ref={wrapRef} className="relative h-[420px] w-full select-none">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Players near your pp"
        className="absolute inset-0 h-full w-full"
        style={{ touchAction: "pan-y" }}
      />
    </div>
  );
}
