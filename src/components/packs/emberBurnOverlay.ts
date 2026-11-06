/* The char on a pack Ember has set alight (PackStage's burn easter egg): an
   SVG laid over the pack, drawn in the pack's own box so it scrolls and
   shakes with it. A radial heat field around where the blade rested, broken
   up by noise, is cut at one level into ragged soot and just under it into a
   thin glowing line: the burn front. Growing the field's radius moves the
   front out over the pack. The flames themselves are particles thrown off
   that front (packBlades emberBurn). */

const SVG = "http://www.w3.org/2000/svg";
let overlays = 0;

export interface BurnOverlay {
  /* Moves the front: `radius` in px of the pack's box, from the origin. */
  setRadius(radius: number): void;
  /* The px the visible front sits at for a given radius (the cut level). */
  frontAt(radius: number): number;
  /* Fades away (the pack is ripping open). */
  fade(): void;
  remove(): void;
}

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/* `origin` in px of the pack's box. */
export function mountBurnOverlay(pack: HTMLElement, origin: { x: number; y: number }): BurnOverlay {
  const id = `burn${(overlays += 1)}`;
  const width = Math.max(1, pack.clientWidth);
  const height = Math.max(1, pack.clientHeight);
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", "aria-hidden": "true" });
  svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;transition:opacity 260ms ease-out";
  const defs = el("defs", {});
  const gradient = el("radialGradient", { id: `${id}g`, gradientUnits: "userSpaceOnUse", cx: origin.x, cy: origin.y, r: 1 });
  gradient.append(el("stop", { offset: 0, "stop-color": "#fff" }), el("stop", { offset: 0.5, "stop-color": "#fff" }), el("stop", { offset: 1, "stop-color": "#000" }));
  const filter = el("filter", { id: `${id}f`, x: 0, y: 0, width: "100%", height: "100%", "color-interpolation-filters": "sRGB" });
  filter.append(
    el("feTurbulence", { type: "fractalNoise", baseFrequency: "0.022 0.018", numOctaves: 5, seed: Math.floor(Math.random() * 1000), result: "noise" }),
    el("feComposite", { in: "SourceGraphic", in2: "noise", operator: "arithmetic", k1: 0, k2: 1.6, k3: 0.8, k4: -0.65, result: "mix" }),
    el("feColorMatrix", { in: "mix", type: "luminanceToAlpha", result: "heat" }),
  );
  const soot = el("feComponentTransfer", { in: "heat", result: "char" });
  soot.append(el("feFuncA", { type: "discrete", tableValues: "0 0 0 0 0 0 0 0.9 0.9 0.9" }));
  const scorch = el("feComponentTransfer", { in: "heat", result: "scorch" });
  scorch.append(el("feFuncA", { type: "discrete", tableValues: "0 0 0 0 0 0.35 0 0 0 0" }));
  const front = el("feComponentTransfer", { in: "heat", result: "front" });
  front.append(el("feFuncA", { type: "discrete", tableValues: "0 0 0 0 0 0 1 0 0 0" }));
  filter.append(
    soot,
    scorch,
    front,
    el("feFlood", { "flood-color": "#120703", result: "sootColor" }),
    el("feComposite", { in: "sootColor", in2: "char", operator: "in", result: "charred" }),
    el("feFlood", { "flood-color": "#3a1606", result: "scorchColor" }),
    el("feComposite", { in: "scorchColor", in2: "scorch", operator: "in", result: "scorched" }),
    el("feFlood", { "flood-color": "#ff8a2a", result: "emberColor" }),
    el("feComposite", { in: "emberColor", in2: "front", operator: "in", result: "lit" }),
    el("feGaussianBlur", { in: "lit", stdDeviation: 2.2, result: "glow" }),
    el("feFlood", { "flood-color": "#ffe2a0", result: "hotColor" }),
    el("feComposite", { in: "hotColor", in2: "front", operator: "in", result: "hot" }),
  );
  const merge = el("feMerge", {});
  for (const node of ["scorched", "charred", "glow", "glow", "hot"]) merge.append(el("feMergeNode", { in: node }));
  filter.append(merge);
  defs.append(gradient, filter);
  // the pouch, with its corners rounded off
  svg.append(defs, el("rect", { width, height, rx: Math.min(width, height) * 0.04, fill: `url(#${id}g)`, filter: `url(#${id}f)` }));
  pack.append(svg);
  return {
    setRadius(radius) {
      gradient.setAttribute("r", String(Math.max(1, radius)));
    },
    // the soot starts where 1.6 x gradient + 0.8 x noise - 0.65 passes 0.7
    // of the heat: with the gradient flat to half the radius and falling to
    // nothing at it, that is about 0.72 of the radius out on average noise.
    // Well inside, the heat is past 0.7 whatever the noise, so what has
    // burnt is char all the way through.
    frontAt(radius) {
      return radius * 0.72;
    },
    fade() {
      svg.style.opacity = "0";
    },
    remove() {
      svg.remove();
    },
  };
}
