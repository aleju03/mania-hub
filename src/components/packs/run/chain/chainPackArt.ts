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
};

const CARDS = CHAIN_RULES.packSize;

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
    return baseStyle(skill, SKILL_ACCENT[offer.skill], `${skill} PLAYERS ONLY`, 2, "rays");
  }
  if (offer.kind === "key") {
    const key = `${offer.key ?? 7}K`;
    return baseStyle(key, accentOf("7k"), `${key} PLAYERS ONLY`, 2, offer.key === 4 ? "lanes4" : "lanes7");
  }
  if (offer.kind === "big") return baseStyle("BIG", accentOf("legend"), `KEEP ${offer.keep ?? 2}`, 3, "burst");
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

function draw(style: PackArtStyle): string | null {
  try {
    return getCachedPackFrontCanvas(style).toDataURL("image/png");
  } catch {
    return null;
  }
}

/* The wrapper's PNG now if it is ready (a country pack's needs its flag
   first), else null. */
export function chainPackArtUrl(art: ChainPackArt): string | null {
  if (typeof document === "undefined") return null;
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
