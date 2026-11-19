import {
  AVATAR_RADIUS,
  AVATAR_SIZE,
  DOC_CENTRE,
  emptyDoc,
  newShapeLayer,
  newTextLayer,
  type FrameDoc,
  type Layer,
} from "./doc";

/* Starting points for the frame editor. Each is plain layers, so nothing
   about a starter is special once it is open. */

export type StarterId = "blank" | "ring" | "double" | "corners" | "name" | "orbit";
export const STARTERS: readonly StarterId[] = ["blank", "ring", "double", "corners", "name", "orbit"];

export interface StarterNames {
  outline: string;
  inner: string;
  outer: string;
  corner: string;
  name: string;
  dots: string;
}

const PINK = "#ff66ab";
const BLUE = "#66ccff";

function both(square: Layer[], round: Layer[], name: string): FrameDoc {
  return { ...emptyDoc(name), boards: { square, round } };
}

/* An outline hugging the avatar, square with the site's corner radius or round. */
function hug(name: string, gap: number, width: number, round: boolean, overrides: Parameters<typeof newShapeLayer>[3] = {}) {
  const size = AVATAR_SIZE + gap * 2 + width;
  return newShapeLayer(name, round ? "ellipse" : "rect", PINK, {
    width: size,
    height: size,
    radius: round ? 0 : AVATAR_RADIUS + gap + width / 2,
    style: "outline",
    lineWidth: width,
    ...overrides,
  });
}

export function makeStarter(id: StarterId, names: StarterNames, label: string): FrameDoc {
  switch (id) {
    case "blank":
      return emptyDoc("");
    case "ring": {
      const ring = (round: boolean) => {
        const layer = hug(names.outline, 6, 16, round, { fill: { kind: "conic", color: PINK, color2: BLUE, angle: 0 } });
        layer.effects.glow = { ...layer.effects.glow, on: true, color: PINK, size: 28, opacity: 0.7 };
        return layer;
      };
      return both([ring(false)], [ring(true)], label);
    }
    case "double": {
      const pair = (round: boolean) => [
        hug(names.inner, 4, 6, round, { fill: { kind: "solid", color: "#ffffff", color2: "#ffffff", angle: 0 } }),
        hug(names.outer, 22, 8, round, { dash: 18, gap: 12, fill: { kind: "linear", color: PINK, color2: "#ffd166", angle: 45 } }),
      ];
      return both(pair(false), pair(true), label);
    }
    case "corners": {
      const reach = AVATAR_SIZE / 2 + 20;
      const arm = 70;
      const corner = (horizontal: boolean) => {
        const layer = newShapeLayer(names.corner, "line", "#ffffff", {
          width: arm,
          height: 0,
          lineWidth: 12,
          cap: "round",
        });
        layer.transform = horizontal
          ? { x: DOC_CENTRE - reach + arm / 2, y: DOC_CENTRE - reach, rotation: 0, scaleX: 1, scaleY: 1 }
          : { x: DOC_CENTRE - reach, y: DOC_CENTRE - reach + arm / 2, rotation: 90, scaleX: 1, scaleY: 1 };
        layer.effects.repeat = { count: 4, mirror: false };
        layer.effects.glow = { ...layer.effects.glow, on: true, color: BLUE, size: 18, opacity: 0.8 };
        return layer;
      };
      const ring = hug(names.outline, 6, 4, true, { fill: { kind: "solid", color: "#ffffff", color2: "#ffffff", angle: 0 }, dash: 4, gap: 10 });
      return both([corner(true), corner(false)], [ring], label);
    }
    case "name": {
      const arcText = () => {
        const text = newTextLayer(names.name, names.name.toUpperCase(), "#ffffff", { size: 44, weight: 900, spacing: 4, arc: AVATAR_SIZE / 2 + 34 });
        text.effects.stroke = { on: true, color: "#1a0d14", width: 6, opacity: 1 };
        return text;
      };
      const band = (round: boolean) => hug(names.outline, 6, 14, round, { fill: { kind: "linear", color: PINK, color2: "#a35cff", angle: 90 } });
      const roundRing = band(true);
      return both([band(false), arcText()], [roundRing, arcText()], label);
    }
    case "orbit": {
      const ring = (round: boolean) => hug(names.outline, 8, 6, round, { fill: { kind: "solid", color: BLUE, color2: BLUE, angle: 0 } });
      const dots = () => {
        const layer = newShapeLayer(names.dots, "ellipse", PINK, { width: 26, height: 26 });
        layer.transform = { x: DOC_CENTRE, y: DOC_CENTRE - AVATAR_SIZE / 2 - 34, rotation: 0, scaleX: 1, scaleY: 1 };
        layer.effects.repeat = { count: 8, mirror: false };
        layer.effects.glow = { ...layer.effects.glow, on: true, color: PINK, size: 20, opacity: 0.9 };
        layer.motion = { kind: "orbit", speed: 1, amount: 0.5, phase: 0 };
        return layer;
      };
      return both([ring(false), dots()], [ring(true), dots()], label);
    }
  }
}
