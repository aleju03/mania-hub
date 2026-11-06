import type { PackSpell } from "#/lib/pack-pending";

/* The look a blade's easter egg leaves on a card (PackStage): Ember's burn or
   Frost's ice. One drawing for both places a card shows: the DOM faces of the
   reveal and summary (BurntFace, FrozenFace) lay it over the face, and the
   card texture (cardTexture.ts) bakes it into the front, so the collection's
   thumbnails and the 3D card wear it too. In a 100 x 140 box, stretched to
   the card. `seed` gives each card its own (spellSeed: the player's id, so
   the card looks the same in the reveal and in the collection). */

export function spellSeed(cardUserId: number): number {
  return (Math.abs(Math.floor(cardUserId)) % 997) + 1;
}

/* How the face under it is coloured: scorched brown, or cold and pale. */
export const SPELL_TINT: Record<PackSpell, string> = {
  burnt: "sepia(0.55) saturate(0.75) brightness(0.72) contrast(1.12)",
  frozen: "saturate(0.55) brightness(1.04) contrast(0.92)",
};

/* Frost's cold glaze, laid over the face in screen. */
export const FROST_GLAZE: readonly [number, string][] = [
  [0, "rgba(214, 238, 255, 0.34)"],
  [0.6, "rgba(120, 180, 240, 0.2)"],
  [1, "rgba(90, 150, 220, 0.26)"],
];

function random(seed: number) {
  return (n: number) => ((Math.sin((seed + 1) * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
}

/* The small lights in it, in % of the card: embers still glowing at the
   burnt edge, or glints on the ice. */
export function spellDots(spell: PackSpell, seed: number): { left: number; top: number; delay: number }[] {
  return [0, 1, 2].map((i) => {
    if (spell === "frozen") {
      const r = random(seed);
      return { left: 12 + r(10 + i) * 76, top: 10 + r(20 + i) * 80, delay: r(30 + i) * 2.4 };
    }
    const r = (n: number) => ((Math.sin((seed + 1) * 12.9898 + n * 78.233 + i * 37.719) * 43758.5453) % 1 + 1) % 1;
    const side = Math.floor(r(1) * 4);
    const along = 8 + r(2) * 84;
    const inset = 6 + r(3) * 8;
    const [left, top] = side === 0 ? [along, inset] : side === 1 ? [100 - inset, along] : side === 2 ? [along, 100 - inset] : [inset, along];
    return { left, top, delay: r(4) * 1.6 };
  });
}

/* The burn eaten in from the edges: an edge gradient plus noise, cut at one
   level for the char and just under it for a glowing line. */
function burntLayers(seed: number, uid: string): string {
  return `<defs>
    <radialGradient id="e${uid}" cx="50%" cy="50%" r="70%"><stop offset="0.3" stop-color="#000"/><stop offset="1" stop-color="#fff"/></radialGradient>
    <filter id="b${uid}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.07 0.05" numOctaves="3" seed="${seed}" result="noise"/>
      <feComposite in="SourceGraphic" in2="noise" operator="arithmetic" k1="0" k2="1.1" k3="0.7" k4="-0.36" result="mix"/>
      <feColorMatrix in="mix" type="luminanceToAlpha" result="heat"/>
      <feComponentTransfer in="heat" result="char"><feFuncA type="discrete" tableValues="0 0 0 0 0 0 1 1 1 1"/></feComponentTransfer>
      <feComponentTransfer in="heat" result="edge"><feFuncA type="discrete" tableValues="0 0 0 0 0 1 0 0 0 0"/></feComponentTransfer>
      <feFlood flood-color="#140904" result="soot"/>
      <feComposite in="soot" in2="char" operator="in" result="charred"/>
      <feFlood flood-color="#ff7a1f" result="ember"/>
      <feComposite in="ember" in2="edge" operator="in" result="lit"/>
      <feGaussianBlur in="lit" stdDeviation="0.5" result="glow"/>
      <feMerge><feMergeNode in="glow"/><feMergeNode in="charred"/></feMerge>
    </filter>
  </defs>
  <rect width="100" height="140" fill="url(#e${uid})" filter="url(#b${uid})"/>`;
}

/* Rime grown in from the edges in feathery spikes (the edge gradient plus
   noise, pushed about by sharp noise), a thinner pale band inside it with a
   blue line between, the glaze catching the light, and a crack in from one
   side with a branch off it. */
function frozenLayers(seed: number, uid: string, crackWidth: number): string {
  const r = random(seed);
  const fromLeft = r(1) < 0.5;
  const crack: [number, number][] = [[fromLeft ? 0 : 100, 30 + r(2) * 80]];
  for (let i = 1; i <= 4; i += 1) {
    const [x, y] = crack[i - 1];
    crack.push([x + (fromLeft ? 1 : -1) * (7 + r(40 + i) * 7), y + (r(50 + i) - 0.5) * 16]);
  }
  const fork = crack[2];
  const branch: [number, number][] = [fork, [fork[0] + (fromLeft ? 1 : -1) * (5 + r(60) * 5), fork[1] + (r(61) < 0.5 ? -1 : 1) * (8 + r(62) * 6)]];
  const line = (points: [number, number][]) => points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return `<defs>
    <radialGradient id="e${uid}" cx="50%" cy="50%" r="72%"><stop offset="0.35" stop-color="#000"/><stop offset="1" stop-color="#fff"/></radialGradient>
    <linearGradient id="s${uid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0.28" stop-color="#fff" stop-opacity="0"/><stop offset="0.36" stop-color="#fff" stop-opacity="0.22"/>
      <stop offset="0.4" stop-color="#fff" stop-opacity="0"/><stop offset="0.46" stop-color="#fff" stop-opacity="0.1"/>
      <stop offset="0.5" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <filter id="f${uid}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.07 0.05" numOctaves="3" seed="${seed}" result="noise"/>
      <feComposite in="SourceGraphic" in2="noise" operator="arithmetic" k1="0" k2="1.1" k3="0.7" k4="-0.38" result="mix"/>
      <feColorMatrix in="mix" type="luminanceToAlpha" result="cold"/>
      <feTurbulence type="turbulence" baseFrequency="0.16" numOctaves="2" seed="${seed + 7}" result="crystal"/>
      <feDisplacementMap in="cold" in2="crystal" scale="9" xChannelSelector="R" yChannelSelector="G" result="spiky"/>
      <feComponentTransfer in="spiky" result="rime"><feFuncA type="discrete" tableValues="0 0 0 0 0 0 0.92 0.92 0.92 0.92"/></feComponentTransfer>
      <feComponentTransfer in="spiky" result="thin"><feFuncA type="discrete" tableValues="0 0 0 0 0 0.45 0 0 0 0"/></feComponentTransfer>
      <feFlood flood-color="#f4fbff" result="white"/>
      <feComposite in="white" in2="rime" operator="in" result="frosted"/>
      <feFlood flood-color="#cfeaff" result="pale"/>
      <feComposite in="pale" in2="thin" operator="in" result="thinned"/>
      <feFlood flood-color="#6cc0ff" result="blue"/>
      <feComposite in="blue" in2="rime" operator="in" result="edge"/>
      <feMorphology in="edge" operator="dilate" radius="0.6" result="wide"/>
      <feComposite in="wide" in2="edge" operator="out" result="outline"/>
      <feGaussianBlur in="outline" stdDeviation="0.5" result="glow"/>
      <feMerge><feMergeNode in="thinned"/><feMergeNode in="glow"/><feMergeNode in="frosted"/></feMerge>
    </filter>
  </defs>
  <rect width="100" height="140" fill="url(#e${uid})" filter="url(#f${uid})"/>
  <rect width="100" height="140" fill="url(#s${uid})"/>
  <polyline points="${line(crack)}" fill="none" stroke="rgba(255,255,255,0.75)" stroke-width="${crackWidth}" stroke-linejoin="bevel" vector-effect="non-scaling-stroke"/>
  <polyline points="${line(branch)}" fill="none" stroke="rgba(255,255,255,0.6)" stroke-width="${crackWidth * 0.8}" vector-effect="non-scaling-stroke"/>`;
}

/* The drawing's inner markup (no <svg> element), ids made unique by `uid`.
   `crackWidth` is in px of whatever the box is shown at. */
export function spellLayersMarkup(spell: PackSpell, seed: number, uid: string, crackWidth = 1): string {
  return spell === "burnt" ? burntLayers(seed, uid) : frozenLayers(seed, uid, crackWidth);
}

/* The drawing at `width` x `height`, with its embers or glints held still,
   for a canvas. Null when the browser would not draw it. */
export async function rasterSpell(spell: PackSpell, seed: number, width: number, height: number): Promise<HTMLCanvasElement | null> {
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 100 140" preserveAspectRatio="none">${spellLayersMarkup(spell, seed, "c", width / 200)}</svg>`;
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  try {
    await image.decode();
  } catch {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(image, 0, 0, width, height);
  const unit = width / 100;
  for (const dot of spellDots(spell, seed)) {
    const x = (dot.left / 100) * width + unit * 0.75;
    const y = (dot.top / 100) * height + unit * 0.75;
    const glow = context.createRadialGradient(x, y, 0, x, y, unit * 3);
    const [core, halo] = spell === "burnt" ? ["rgba(255, 179, 71, 1)", "rgba(255, 122, 31, 0)"] : ["rgba(255, 255, 255, 1)", "rgba(190, 230, 255, 0)"];
    glow.addColorStop(0, core);
    glow.addColorStop(0.3, core);
    glow.addColorStop(1, halo);
    context.fillStyle = glow;
    context.fillRect(x - unit * 3, y - unit * 3, unit * 6, unit * 6);
  }
  return canvas;
}
