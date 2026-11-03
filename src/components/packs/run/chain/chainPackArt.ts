import { useEffect, useState } from "react";
import { CHAIN_RULES, type ChainOffer, type ChainPackReason, type ChainSkill } from "#/lib/chain-run";
import { getCountryFlagGradient, getCountryFlagLargeUrl, getCountryName, UNKNOWN_FLAG_URL } from "#/lib/country";
import { PACK_TYPES } from "#/lib/packs";
import { getCachedPackFrontCanvas, type PackArtStyle } from "../../packArt";

/* The chain run's own pack wrappers, drawn by the site's pack art pipeline
   (packArt.ts) with the run's own terms printed on them: what each pack
   actually deals and keeps, never a /packs pack type's. A country pack
   carries its flag in the seal, its colours on the stock, ribbons and band,
   and its name on the band. Full size (600 x 1000), so it stays crisp at 2x;
   one PNG per wrapper, made on first use. */

export interface ChainPackArt {
  reason: ChainPackReason;
  offer?: Pick<ChainOffer, "kind" | "cc" | "skill" | "key" | "keep"> | null;
  round?: number;
}

type Rgb = { r: number; g: number; b: number };

const accentOf = (id: string): Rgb => PACK_TYPES.find((type) => type.id === id)?.accent ?? { r: 167, g: 139, b: 250 };

/* One colour per skillset pack, each its own. */
const SKILL_ACCENT: Record<ChainSkill, Rgb> = {
  Stream: { r: 96, g: 196, b: 255 },
  Jumpstream: { r: 255, g: 170, b: 72 },
  Handstream: { r: 255, g: 110, b: 110 },
  Stamina: { r: 110, g: 231, b: 160 },
  Jack: { r: 186, g: 160, b: 255 },
  Chordjack: { r: 255, g: 128, b: 200 },
  Tech: { r: 255, g: 212, b: 90 },
  Speed: { r: 120, g: 224, b: 230 },
  Chordstream: { r: 120, g: 150, b: 255 },
  Bracket: { r: 243, g: 194, b: 74 },
  Delay: { r: 95, g: 184, b: 201 },
};

const CARDS = CHAIN_RULES.packSize;

/* Each skillset pack's own wrapper: its colour, its own stock pattern, and
   in the seal the skillset itself as a strip of notes on a little playfield
   (a stream's staircase, a jack's stacked column, a delay's off-grid rows),
   so two pattern packs side by side never look alike. */
const SKILL_MOTIF: Record<ChainSkill, PackArtStyle["motif"]> = {
  Stream: "lanes4",
  Jumpstream: "scatter",
  Handstream: "ribbons",
  Stamina: "rays",
  Jack: "triangles",
  Chordjack: "burst",
  Tech: "ribbons",
  Speed: "rays",
  Chordstream: "lanes7",
  Bracket: "ribbons",
  Delay: "scatter",
};

/* Rows of notes, top to bottom, each a lane mask and an optional row
   position (in rows) where the pattern is off the grid. */
type NoteRow = [mask: string, at?: number];
const SKILL_NOTES: Record<ChainSkill, NoteRow[]> = {
  Stream: [["1000"], ["0100"], ["0010"], ["0001"], ["0010"], ["0100"], ["1000"]],
  Jumpstream: [["1010"], ["0100"], ["0101"], ["1000"], ["0110"], ["0001"], ["1001"]],
  Handstream: [["1101"], ["0010"], ["1011"], ["0100"], ["0111"], ["1000"], ["1110"]],
  Stamina: [["1000"], ["0010"], ["0100"], ["0001"], ["1000"], ["0010"], ["0100"], ["0001"], ["1000"], ["0010"]],
  Jack: [["0100"], ["0100"], ["0100"], ["0010"], ["0010"], ["0010"], ["0100"]],
  Chordjack: [["1101"], ["1101"], ["0110"], ["1011"], ["1011"], ["0110"], ["1101"]],
  Tech: [["1000", 0], ["0100", 0.6], ["0001", 1.8], ["0110", 2.3], ["1000", 3.5], ["0010", 4.1], ["0101", 5.6]],
  Speed: [["1000"], ["0100"], ["1000"], ["0100"], ["1000"], ["0100"], ["1000"], ["0100"], ["1000"]],
  Chordstream: [["1010100"], ["0101010"], ["1001001"], ["0110110"], ["1010101"], ["0101010"]],
  /* Prism's bracket: chords back to back across both hands, each sharing no
     column with the one before and never rolling. */
  Bracket: [["1010010"], ["0101001"], ["1010100"], ["0100011"], ["1001100"], ["0110001"]],
  Delay: [["1000000", 0], ["0010000", 0.7], ["0000100", 1.3], ["0100000", 2.6], ["0001000", 3.2], ["0000010", 4.5]],
};

const skillEmblems = new Map<ChainSkill, HTMLCanvasElement>();

/* The seal's picture for a skillset pack: its notes on a dark playfield. */
function skillEmblem(skill: ChainSkill, accent: Rgb): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const cached = skillEmblems.get(skill);
  if (cached) return cached;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const rows = SKILL_NOTES[skill];
  const lanes = rows[0][0].length;
  const ground = context.createLinearGradient(0, 0, 0, size);
  ground.addColorStop(0, "#0b0912");
  ground.addColorStop(1, `rgb(${Math.round(accent.r * 0.22)},${Math.round(accent.g * 0.22)},${Math.round(accent.b * 0.22)})`);
  context.fillStyle = ground;
  context.fillRect(0, 0, size, size);
  // The playfield: a column of lanes in the disc's middle.
  const fieldW = lanes === 4 ? 172 : 206;
  const left = (size - fieldW) / 2;
  const lane = fieldW / lanes;
  context.fillStyle = "rgba(255,255,255,0.05)";
  context.fillRect(left, 0, fieldW, size);
  context.strokeStyle = "rgba(255,255,255,0.12)";
  context.lineWidth = 1.5;
  for (let index = 0; index <= lanes; index += 1) {
    context.beginPath();
    context.moveTo(left + index * lane, 0);
    context.lineTo(left + index * lane, size);
    context.stroke();
  }
  // Notes fall toward the judgement line near the bottom.
  const judge = size * 0.82;
  const step = Math.min(34, (judge - 30) / Math.max(1, rows.length - 1 + 0.5));
  const noteH = Math.max(10, Math.min(20, step * 0.62));
  rows.forEach(([mask, at], index) => {
    const y = judge - 10 - (at ?? index) * step;
    for (let column = 0; column < lanes; column += 1) {
      if (mask[column] !== "1") continue;
      const x = left + column * lane + lane * 0.1;
      const w = lane * 0.8;
      context.fillStyle = `rgb(${accent.r},${accent.g},${accent.b})`;
      context.beginPath();
      context.roundRect(x, y - noteH, w, noteH, Math.min(4, noteH / 2));
      context.fill();
      context.fillStyle = "rgba(255,255,255,0.55)";
      context.fillRect(x + 2, y - noteH + 2, w - 4, Math.max(2, noteH * 0.22));
    }
  });
  context.fillStyle = "rgba(255,255,255,0.85)";
  context.fillRect(left - 6, judge, fieldW + 12, 3);
  skillEmblems.set(skill, canvas);
  return canvas;
}

const shade = (c: Rgb, k: number): Rgb => ({ r: Math.round(c.r * k), g: Math.round(c.g * k), b: Math.round(c.b * k) });

function baseStyle(name: string, accent: Rgb, poolLabel: string, rank: number, motif: PackArtStyle["motif"]): PackArtStyle {
  return { accent, name, cardCount: CARDS, poolLabel, rank, motif };
}

/* The wrapper for a pack that needs no flag. */
function plainStyle(art: ChainPackArt): PackArtStyle {
  const offer = art.offer;
  if (art.reason === "start") return baseStyle("STARTER", accentOf("standard"), "KEEP 2", 1, "triangles");
  if (art.reason === "round") return baseStyle(art.round ? `ROUND ${art.round}` : "ROUND", accentOf("standard"), "THIS ROUND", 1, "triangles");
  if (!offer || offer.kind === "pack") return baseStyle("PACK", accentOf("standard"), "KEEP 1", 1, "triangles");
  if (offer.kind === "skill" && offer.skill) {
    const skill = offer.skill.toUpperCase();
    const accent = SKILL_ACCENT[offer.skill];
    const emblem = skillEmblem(offer.skill, accent);
    return {
      ...baseStyle(skill, accent, `${skill} PLAYERS ONLY`, 2, SKILL_MOTIF[offer.skill]),
      ribbons: [accent, shade(accent, 0.45), shade(accent, 0.75)],
      ...(emblem ? { emblem, emblemKey: `skill:${offer.skill}` } : {}),
    };
  }
  if (offer.kind === "key") {
    const key = `${offer.key ?? 7}K`;
    return baseStyle(key, accentOf("7k"), `${key} PLAYERS ONLY`, 2, offer.key === 4 ? "lanes4" : "lanes7");
  }
  if (offer.kind === "big") return baseStyle("BIG", accentOf("legend"), `KEEP ${offer.keep ?? 2}`, 3, "burst");
  if (offer.kind === "chart") return baseStyle("MAP", accentOf("legend"), "MAP + WHO PLAYED IT", 2, "triangles");
  return baseStyle("PACK", accentOf("standard"), "KEEP 1", 1, "triangles");
}

/* ------------------------------------------------------------ flags */

function hexes(text: string): Rgb[] {
  return Array.from(text.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi), (match) => {
    const hex = match[1].length === 3 ? match[1].replace(/./g, (c) => c + c) : match[1];
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
  });
}

const light = (c: Rgb) => (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) / 255;
const chroma = (c: Rgb) => (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255;
const distance = (a: Rgb, b: Rgb) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

/* A flag's main colours, most area first: from its pixels when the image is
   readable, else from the site's flag gradient table. */
function flagColors(image: HTMLImageElement | null, cc: string): Rgb[] {
  const counts = new Map<string, { color: Rgb; n: number }>();
  if (image) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 48;
      canvas.height = 32;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context) {
        context.drawImage(image, 0, 0, 48, 32);
        const data = context.getImageData(0, 0, 48, 32).data;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 200) continue;
          const color = { r: data[i] & 0xf0, g: data[i + 1] & 0xf0, b: data[i + 2] & 0xf0 };
          const key = `${color.r},${color.g},${color.b}`;
          const entry = counts.get(key);
          if (entry) entry.n += 1;
          else counts.set(key, { color: { r: data[i], g: data[i + 1], b: data[i + 2] }, n: 1 });
        }
      }
    } catch {
      counts.clear();
    }
  }
  let ranked = [...counts.values()].sort((a, b) => b.n - a.n).map((entry) => entry.color);
  if (!ranked.length) ranked = hexes(getCountryFlagGradient(cc) ?? "");
  // Fold near-duplicates (antialiased edges) into the first of them.
  const out: Rgb[] = [];
  for (const color of ranked) if (!out.some((kept) => distance(kept, color) < 70)) out.push(color);
  return out.slice(0, 4);
}

/* Stock tint and band: the flag's most-area saturated colour tints the
   stock, the next distinct colour (white counts) fills the band. */
function flagPalette(colors: Rgb[]): { accent: Rgb; band: Rgb; ribbons: Rgb[] } | null {
  if (!colors.length) return null;
  const accent = colors.find((c) => chroma(c) > 0.3 && light(c) > 0.12) ?? colors[0];
  const band = colors.find((c) => c !== accent && distance(c, accent) > 90 && light(c) > 0.15) ?? { r: 255, g: 255, b: 255 };
  return { accent, band, ribbons: colors };
}

function loadFlag(cc: string): Promise<HTMLImageElement | null> {
  const url = getCountryFlagLargeUrl(cc);
  if (url === UNKNOWN_FLAG_URL) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    // flagcdn serves CORS, so the canvas stays readable for toDataURL.
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/* The country's everyday English name ("South Korea" rather than the site
   list's "Korea (South)"), for the band. */
function countryWord(cc: string): string {
  try {
    const name = new Intl.DisplayNames(["en-US"], { type: "region" }).of(cc);
    if (name && name !== cc) return name;
  } catch {
    // Fall through to the site's list.
  }
  return getCountryName(cc);
}

function countryStyle(cc: string, image: HTMLImageElement | null): PackArtStyle {
  const name = countryWord(cc).toUpperCase();
  const palette = flagPalette(flagColors(image, cc));
  return {
    accent: palette?.accent ?? accentOf("wild"),
    name,
    cardCount: CARDS,
    poolLabel: `${cc} PLAYERS ONLY`,
    rank: 2,
    motif: "ribbons",
    ...(palette ? { band: palette.band, ribbons: palette.ribbons } : {}),
    ...(image ? { emblem: image, emblemKey: `flag:${cc}` } : {}),
  };
}

/* ------------------------------------------------------------ cache */

const urls = new Map<string, string>();
const accents = new Map<string, Rgb>();
const pending = new Map<string, Promise<string | null>>();

export function chainPackArtKey(art: ChainPackArt): string {
  const offer = art.offer;
  if (art.reason !== "shop" || !offer) return `${art.reason}:${art.round ?? ""}`;
  return `shop:${offer.kind}:${offer.cc ?? ""}:${offer.skill ?? ""}:${offer.key ?? ""}:${offer.keep ?? ""}`;
}

/* The rendered foil pouch the printed art is wrapped in: a base with the
   outline, a mask for where print goes, a multiply pass for the puff and
   crinkles, and a highlight pass. Loaded once; until it is in, wrappers
   wait for it rather than showing flat and then swapping. */
interface PouchLayers {
  base: HTMLImageElement;
  mask: HTMLImageElement;
  shade: HTMLImageElement;
  spec: HTMLImageElement;
}
let pouch: PouchLayers | null = null;
let pouchFailed = false;
let pouchJob: Promise<PouchLayers | null> | null = null;

function loadPouch(): Promise<PouchLayers | null> {
  if (pouch || pouchFailed) return Promise.resolve(pouch);
  if (!pouchJob) {
    const one = (layer: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = `/images/packs/run/pouch-${layer}-v1.webp`;
      });
    pouchJob = Promise.all([one("base"), one("mask"), one("shade"), one("spec")])
      .then(([base, mask, shade, spec]) => (pouch = { base, mask, shade, spec }))
      .catch(() => {
        pouchFailed = true;
        return null;
      });
  }
  return pouchJob;
}

function draw(style: PackArtStyle): string | null {
  try {
    const art = getCachedPackFrontCanvas(style);
    if (!pouch) return art.toDataURL("image/png");
    const { width, height } = art;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return art.toDataURL("image/png");
    // The print, cut to the pouch's printable face.
    const print = document.createElement("canvas");
    print.width = width;
    print.height = height;
    const printContext = print.getContext("2d");
    if (!printContext) return art.toDataURL("image/png");
    printContext.drawImage(art, 0, 0, width, height);
    printContext.globalCompositeOperation = "destination-in";
    printContext.drawImage(pouch.mask, 0, 0, width, height);
    context.drawImage(pouch.base, 0, 0, width, height);
    context.drawImage(print, 0, 0);
    // Puff, folds and crinkle, kept to the pouch.
    context.globalCompositeOperation = "multiply";
    context.drawImage(pouch.shade, 0, 0, width, height);
    context.globalCompositeOperation = "destination-in";
    context.drawImage(pouch.base, 0, 0, width, height);
    context.globalCompositeOperation = "source-over";
    context.drawImage(pouch.spec, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/* The wrapper's PNG now if it is ready (a country pack's needs its flag
   first), else null. */
export function chainPackArtUrl(art: ChainPackArt): string | null {
  if (typeof document === "undefined") return null;
  if (!pouch && !pouchFailed) {
    void loadPouch();
    return null;
  }
  const key = chainPackArtKey(art);
  const known = urls.get(key);
  if (known) return known;
  if (art.reason === "shop" && art.offer?.kind === "country" && art.offer.cc) return null;
  const url = draw(plainStyle(art));
  if (url) urls.set(key, url);
  return url;
}

/* Draws a country pack's wrapper once its flag has loaded (cached per
   country; a flag that cannot load prints the colours from the site's flag
   table with the plain seal). */
export function loadChainPackArt(art: ChainPackArt): Promise<string | null> {
  const key = chainPackArtKey(art);
  const known = urls.get(key);
  if (known) return Promise.resolve(known);
  if (!pouch && !pouchFailed) return loadPouch().then(() => loadChainPackArt(art));
  const ready = chainPackArtUrl(art);
  if (ready) return Promise.resolve(ready);
  const cc = art.offer?.cc?.toUpperCase() ?? "";
  let job = pending.get(key);
  if (!job) {
    job = loadFlag(cc).then((image) => {
      const style = countryStyle(cc, image);
      accents.set(key, style.accent);
      const url = draw(style) ?? (image ? draw(countryStyle(cc, null)) : null);
      if (url) urls.set(key, url);
      pending.delete(key);
      return url;
    });
    pending.set(key, job);
  }
  return job;
}

/* The wrapper for a pack, re-rendering once a country pack's flag is in. */
export function useChainPackArt(art: ChainPackArt | null): string | null {
  const key = art ? chainPackArtKey(art) : "";
  const [url, setUrl] = useState<string | null>(() => (art ? chainPackArtUrl(art) : null));
  useEffect(() => {
    if (!art) {
      setUrl(null);
      return;
    }
    const now = chainPackArtUrl(art);
    setUrl(now);
    if (now) return;
    let live = true;
    void loadChainPackArt(art).then((loaded) => {
      if (live) setUrl(loaded);
    });
    return () => {
      live = false;
    };
    // Keyed on the wrapper, not the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return url;
}

/* The pack's accent for the table's glow and tear: a country pack's flag
   colour, else the wrapper's. */
export function chainPackArtAccent(art: ChainPackArt): Rgb {
  const loaded = accents.get(chainPackArtKey(art));
  if (loaded) return loaded;
  if (art.reason === "shop" && art.offer?.kind === "country" && art.offer.cc) {
    return flagPalette(flagColors(null, art.offer.cc.toUpperCase()))?.accent ?? accentOf("wild");
  }
  return plainStyle(art).accent;
}
