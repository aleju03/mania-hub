/* The Note highway frame drawn live, so its chart never repeats: an endless
   4K chart is written a second ahead of the line as it plays (streams with no
   jacks, jumps, short LNs with taps under them, a breath now and then). The
   drawing is the design page's own (~/Projects/foundry/designs/note-highway),
   in the same 0..184 x -28..184 units, so it matches the exported still. */

const NS = "http://www.w3.org/2000/svg";
const TICK = 0.1; // a 1/4 at 150 BPM
const LINE = 30, TOP = -20, LANE = 19, LEFT = 92 - 2 * LANE;
const SPEED = 88; // units per second
const NW = 16, NH = 6;
const FRAME_MS = 1000 / 40;

interface Note { at: number; col: number; end: number | null }

const laneX = (c: number) => LEFT + c * LANE + LANE / 2;
const isBlue = (c: number) => c === 1 || c === 2;

function defs(id: (name: string) => string): string {
  return `
  <linearGradient id="${id("lane")}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#0b0f1c" stop-opacity="0.4"/><stop offset="0.45" stop-color="#0b0f1c" stop-opacity="0.2"/><stop offset="1" stop-color="#0b0f1c" stop-opacity="0"/></linearGradient>
  <linearGradient id="${id("sheen")}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0.07"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.02"/><stop offset="1" stop-color="#fff" stop-opacity="0.06"/></linearGradient>
  <linearGradient id="${id("laneEdge")}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0.3"/><stop offset="0.6" stop-color="#fff" stop-opacity="0.08"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <linearGradient id="${id("receptor")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="0.26"/></linearGradient>
  <linearGradient id="${id("fade")}" gradientUnits="userSpaceOnUse" x1="0" y1="-20" x2="0" y2="12"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>
  <mask id="${id("top")}" maskUnits="userSpaceOnUse" x="0" y="-28" width="184" height="212"><rect x="0" y="-28" width="184" height="212" fill="url(#${id("fade")})"/></mask>
  <linearGradient id="${id("nWhite")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#d9e1ef"/></linearGradient>
  <linearGradient id="${id("nBlue")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9fdbff"/><stop offset="1" stop-color="#3a9ff0"/></linearGradient>
  <linearGradient id="${id("lnBody")}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#a9dcff"/><stop offset="0.5" stop-color="#d8efff"/><stop offset="1" stop-color="#a9dcff"/></linearGradient>
  <linearGradient id="${id("beamWhite")}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0.6"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <linearGradient id="${id("beamBlue")}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#8fd2ff" stop-opacity="0.9"/><stop offset="1" stop-color="#6ec3ff" stop-opacity="0"/></linearGradient>
  <filter id="${id("drop")}" x="-40%" y="-60%" width="180%" height="220%"><feDropShadow dx="0" dy="1.2" stdDeviation="1" flood-color="#000" flood-opacity="0.55"/></filter>
  <filter id="${id("glow")}" x="-100%" y="-200%" width="300%" height="500%"><feGaussianBlur stdDeviation="2.2"/></filter>`;
}

/* The endless chart: one tick at a time, from the rules the loop used. */
function chartWriter() {
  let tick = 0, last = -1, prev = -1, jump: number[] = [], busyCol = -1, busyUntil = -1, rested = false;
  const pick = (from: number[]) => from[Math.floor(Math.random() * from.length)];
  return (): Note[] => {
    const k = tick++;
    const at = k * TICK;
    if (k > busyUntil) busyCol = -1;
    if (!rested && k > 4 && Math.random() < 0.07) {
      rested = true;
      return [];
    }
    rested = false;
    const open = [0, 1, 2, 3].filter((c) => c !== busyCol && c !== last && !jump.includes(c));
    jump = [];
    if (busyCol < 0 && Math.random() < 0.06 && open.length) {
      const col = pick(open);
      const length = 3 + Math.floor(Math.random() * 3);
      busyCol = col; busyUntil = k + length;
      prev = last; last = col;
      return [{ at, col, end: at + length * TICK }];
    }
    if (busyCol < 0 && Math.random() < 0.13) {
      const pair = [0, 3].includes(last) ? [1, 2] : [0, 3];
      prev = pair[0]; last = pair[1]; jump = pair;
      return pair.map((col) => ({ at, col, end: null }));
    }
    // a stream note: no jack, and mostly no trill back onto the one before last
    const pool = open.length ? open : [0, 1, 2, 3].filter((c) => c !== busyCol && c !== last);
    const away = pool.filter((c) => c !== prev);
    const col = pick(away.length && Math.random() < 0.8 ? away : pool);
    prev = last; last = col;
    return [{ at, col, end: null }];
  };
}

export function startNoteHighway(svg: SVGSVGElement): () => void {
  const uid = `nh${Math.random().toString(36).slice(2, 8)}`;
  const id = (name: string) => `${uid}-${name}`;
  const url = (name: string) => `url(#${id(name)})`;
  svg.innerHTML = `<defs>${defs(id)}</defs><g mask="${url("top")}"></g><g></g>`;
  const field = svg.children[1] as SVGGElement, front = svg.children[2] as SVGGElement;

  const el = (tag: string, attrs: Record<string, string | number>, parent: Element) => {
    const node = document.createElementNS(NS, tag);
    for (const key in attrs) node.setAttribute(key, String(attrs[key]));
    parent.appendChild(node);
    return node;
  };

  function note(parent: Element, cx: number, bottom: number, col: number) {
    const x = cx - NW / 2, y = bottom - NH;
    const g = el("g", { filter: url("drop") }, parent);
    el("rect", { x: x - 0.8, y: y - 0.8, width: NW + 1.6, height: NH + 1.6, rx: 3.2, fill: "#10131f", "fill-opacity": 0.7 }, g);
    el("rect", { x: x + 0.5, y: y + 0.5, width: NW - 1, height: NH - 1, rx: 2.1, fill: isBlue(col) ? url("nBlue") : url("nWhite"), stroke: "#fff", "stroke-width": 1 }, g);
    el("rect", { x: x + 2.4, y: y + 1.3, width: NW - 4.8, height: 1.3, rx: 0.65, fill: "#fff", opacity: isBlue(col) ? 0.75 : 0.95 }, g);
    if (!isBlue(col)) el("rect", { x: x + 2, y: y + NH - 1.9, width: NW - 4, height: 0.8, rx: 0.4, fill: "#9aa6bd", opacity: 0.5 }, g);
  }

  function lnBody(parent: Element, cx: number, top: number, bottom: number) {
    if (bottom - top < 1) return;
    const w = 9, x = cx - w / 2;
    const g = el("g", { filter: url("drop") }, parent);
    el("rect", { x: x - 0.8, y: top - 0.8, width: w + 1.6, height: bottom - top + 1.6, rx: 4.5, fill: "#10131f", "fill-opacity": 0.6 }, g);
    el("rect", { x, y: top, width: w, height: bottom - top, rx: 3.8, fill: url("lnBody"), stroke: "#fff", "stroke-width": 0.8, "stroke-opacity": 0.9 }, g);
  }

  function hitFlash(col: number, k: number, held: boolean) {
    const cx = laneX(col);
    const beam = held ? 0.55 + 0.12 * Math.sin(k * 60) : Math.exp(-k * 11);
    if (beam > 0.02) el("rect", { x: cx - 8, y: LINE - 34, width: 16, height: 34, fill: isBlue(col) ? url("beamBlue") : url("beamWhite"), opacity: (beam * 0.8).toFixed(3) }, field);
    if (held) {
      el("ellipse", { cx, cy: LINE, rx: 9.5, ry: 2.8, fill: isBlue(col) ? "#bfe6ff" : "#fff", opacity: (0.75 + 0.15 * Math.sin(k * 47)).toFixed(3), filter: url("glow") }, front);
      el("rect", { x: cx - 8.5, y: LINE - 0.8, width: 17, height: 1.6, rx: 0.8, fill: "#fff", opacity: 0.9 }, front);
      return;
    }
    if (k > 0.3) return;
    const fl = Math.exp(-k * 16);
    el("ellipse", { cx, cy: LINE, rx: 9 + 5 * (1 - fl), ry: 3.2, fill: isBlue(col) ? "#bfe6ff" : "#fff", opacity: fl.toFixed(3), filter: url("glow") }, front);
    el("rect", { x: cx - 9, y: LINE - 0.9, width: 18, height: 1.8, rx: 0.9, fill: "#fff", opacity: Math.min(1, fl * 1.4).toFixed(3) }, front);
    const r = 1 - Math.pow(1 - Math.min(1, k / 0.2), 3);
    if (k < 0.2) el("ellipse", { cx, cy: LINE, rx: 5 + 9 * r, ry: 1.8 + 3.6 * r, fill: "none", stroke: isBlue(col) ? "#d4efff" : "#fff", "stroke-width": (1.3 * (1 - r) + 0.15).toFixed(3), opacity: (1 - r).toFixed(3) }, front);
  }

  const write = chartWriter();
  let chart: Note[] = [];
  let written = 0; // chart time written up to
  // start a little into the chart, so the field is already full
  const origin = performance.now() / 1000 - 0.8;

  function draw(t: number) {
    while (written < t + 1.2) {
      chart.push(...write());
      written += TICK;
    }
    chart = chart.filter((n) => (n.end ?? n.at) > t - 0.5);
    field.replaceChildren();
    front.replaceChildren();
    el("rect", { x: LEFT, y: TOP, width: 4 * LANE, height: LINE - TOP, fill: url("lane") }, field);
    el("rect", { x: LEFT, y: TOP, width: 4 * LANE, height: LINE - TOP, fill: url("sheen") }, field);
    for (let c = 0; c <= 4; c++) el("rect", { x: LEFT + c * LANE - 0.22, y: TOP, width: 0.44, height: LINE - TOP, fill: url("laneEdge"), opacity: c === 0 || c === 4 ? 1 : 0.7 }, field);
    el("rect", { x: LEFT, y: LINE - 4, width: 4 * LANE, height: 4, fill: url("receptor") }, field);
    el("rect", { x: LEFT - 2, y: LINE - 0.65, width: 4 * LANE + 4, height: 1.3, rx: 0.65, fill: "#fff", opacity: 0.75, filter: url("drop") }, front);
    const notes = el("g", {}, field);
    for (const n of chart) {
      const cx = laneX(n.col);
      const d = n.at - t;
      if (n.end !== null) {
        const tailY = LINE - (n.end - t) * SPEED;
        if (t < n.end && tailY < LINE && tailY > TOP - 60) {
          const headBottom = d > 0 ? LINE - d * SPEED : LINE;
          if (headBottom > TOP - NH) {
            lnBody(notes, cx, tailY - 3, headBottom - NH / 2);
            note(notes, cx, headBottom, n.col);
          }
        }
        if (t >= n.at && t < n.end) hitFlash(n.col, t - n.at, true);
        if (t >= n.end && t - n.end < 0.4) hitFlash(n.col, t - n.end, false);
      } else {
        const bottom = LINE - d * SPEED;
        if (d > 0 && bottom > TOP - NH) note(notes, cx, bottom, n.col);
        if (t >= n.at && t - n.at < 0.4) hitFlash(n.col, t - n.at, false);
      }
    }
  }

  let frame = 0, lastDrawn = 0, visible = true;
  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    if (!visible || now - lastDrawn < FRAME_MS) return;
    lastDrawn = now;
    draw(now / 1000 - origin);
  };
  // only while it is on screen
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
  });
  observer.observe(svg);
  draw(performance.now() / 1000 - origin);
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
  };
}
