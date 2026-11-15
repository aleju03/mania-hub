import { useEffect, useState } from "react";

import { HIGHWAY_MAX_LANES, rgbToHueSat, type HighwayNotes } from "../../lib/supporter-profile-themes";

/* A player's replay skin art for the profile themes that use it: the notes
   the Note highway streams down and the judgements Judgement rain floats.
   The notes: a player's replay skin (the
   one their replays play with, picked in the replay settings), so their
   profile's playfield wears the notes they play with. One keymode's lanes:
   the player's main keymode when the skin draws notes for it, otherwise a
   keymode it does draw (4K first, then 7K), otherwise their main keymode in
   the skin's note colours. Null for a player without a replay skin: the
   theme's own notes stay. Decoding reuses the replay viewer's cached path,
   so a skin the browser has already opened costs no .osk download. */

const CELL_WIDTH = 128;
const CELL_HEIGHT = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/* Keymodes whose stored profile names tap art for every column, read from the
   dehydrated payload so nothing is decoded to find out. */
function keymodesWithArt(payload: unknown): number[] {
  const settings = isRecord(payload) && isRecord(payload.settings) ? payload.settings : null;
  const profiles = settings && isRecord(settings.keymodeProfiles) ? settings.keymodeProfiles : {};
  return Object.entries(profiles).flatMap(([key, profile]) => {
    const keys = Number(key);
    const columns = isRecord(profile) && isRecord(profile.assets) && Array.isArray(profile.assets.columns) ? profile.assets.columns : [];
    const drawn = columns.slice(0, keys).filter((column) => isRecord(column) && isRecord(column.tap) && (column.tap.path || column.tap.src));
    return Number.isInteger(keys) && keys >= 1 && keys <= HIGHWAY_MAX_LANES && drawn.length === keys ? [keys] : [];
  });
}

export function pickHighwayKeymode(withArt: number[], preferred: number | null): { keys: number; art: boolean } {
  if (preferred != null && withArt.includes(preferred)) return { keys: preferred, art: true };
  for (const keys of [4, 7, ...withArt]) if (withArt.includes(keys)) return { keys, art: true };
  return { keys: preferred ?? 4, art: false };
}

function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/* The colour that stands out across the notes: an average of their pixels
   (or colours) weighted by how saturated each is, scaled to full brightness.
   Null when they are white or grey. */
function accentOf(samples: [number, number, number, number][]): [number, number, number] | null {
  let r = 0, g = 0, b = 0, total = 0;
  for (const [red, green, blue, weight] of samples) {
    const saturation = Math.max(red, green, blue) - Math.min(red, green, blue);
    const w = weight * (saturation * saturation + 0.002);
    r += red * w;
    g += green * w;
    b += blue * w;
    total += w;
  }
  if (total <= 0) return null;
  const mean: [number, number, number] = [r / total, g / total, b / total];
  const peak = Math.max(...mean);
  if (peak <= 0.05 || rgbToHueSat(mean).sat < 0.2) return null;
  return [mean[0] / peak, mean[1] / peak, mean[2] / peak];
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

export async function loadHighwayNotes(userId: number, preferredKeys: number | null): Promise<HighwayNotes | null> {
  const { fetchUserReplaySkin, loadOwnerReplaySkinCached } = await import("../../lib/replay-owner-skin");
  const record = await fetchUserReplaySkin(userId);
  if (!record) return null;
  const preferred = preferredKeys != null && preferredKeys >= 1 && preferredKeys <= HIGHWAY_MAX_LANES ? preferredKeys : null;
  const { keys, art } = pickHighwayKeymode(keymodesWithArt(record.settings), preferred);
  const loaded = await loadOwnerReplaySkinCached(record, undefined, keys);
  if (!loaded) return null;
  const { getReplaySkinProfile } = await import("../../lib/replay-skin");
  const profile = getReplaySkinProfile(loaded.settings, keys);
  const colors = Array.from({ length: keys }, (_, column): [number, number, number] => hexToRgb(profile.tapColors[column] || profile.tapColor) ?? [0.9, 0.92, 1]);
  const key = `${record.skin.id}:${record.updatedAt}:${keys}`;
  const colourAccent = accentOf(colors.map(([r, g, b]) => [r, g, b, 1]));
  // their judgements: the skin's own, or the built-in set they picked
  const [{ buildJudgementAtlas }, { getReplayJudgementSetAssets }] = await Promise.all([import("../../lib/judgement-atlas"), import("../../lib/replay-skin")]);
  const judgements = await buildJudgementAtlas(
    loaded.settings.judgementSet === "skin" ? profile.assets.judgements : getReplayJudgementSetAssets(loaded.settings.judgementSet) ?? {},
  ).catch(() => null);
  if (!art) return { lanes: keys, atlas: null, aspects: [], colors, key, accent: colourAccent, judgements };

  const images = await Promise.all(profile.assets.columns.slice(0, keys).map((column) => (column.tap ? loadImage(column.tap.src) : Promise.resolve(null))));
  if (images.some((image) => !image || !image.naturalWidth)) return { lanes: keys, atlas: null, aspects: [], colors, key, accent: colourAccent, judgements };
  const atlas = document.createElement("canvas");
  atlas.width = CELL_WIDTH * keys;
  atlas.height = CELL_HEIGHT;
  const context = atlas.getContext("2d");
  if (!context) return { lanes: keys, atlas: null, aspects: [], colors, key, accent: colourAccent, judgements };
  const aspects = images.map((image, lane) => {
    context.drawImage(image!, lane * CELL_WIDTH, 0, CELL_WIDTH, CELL_HEIGHT);
    return image!.naturalHeight / image!.naturalWidth;
  });
  // The art's own colour, from a coarse sample of its opaque pixels.
  const samples: [number, number, number, number][] = [];
  try {
    const { data } = context.getImageData(0, 0, atlas.width, atlas.height);
    for (let index = 0; index < data.length; index += 4 * 7) {
      const alpha = data[index + 3] / 255;
      if (alpha > 0.4) samples.push([data[index] / 255, data[index + 1] / 255, data[index + 2] / 255, alpha]);
    }
  } catch {
    // a tainted canvas: fall back to the skin's colours
  }
  return { lanes: keys, atlas, aspects, colors, key: `${key}:art`, accent: samples.length > 0 ? accentOf(samples) : colourAccent, judgements };
}

/* One load per player and keymode for the page's life: hovering the theme on
   /supporter turns this on and off, and a skin rarely changes mid-visit. */
const loads = new Map<string, Promise<HighwayNotes | null>>();

/* The notes for `userId`'s highway, once loaded; null without a skin, while
   loading, or when `enabled` is off (any theme but the highway). */
export function useHighwayNotes(userId: number | null | undefined, preferredKeys: number | null, enabled: boolean): HighwayNotes | null {
  const [notes, setNotes] = useState<{ for: string; value: HighwayNotes | null } | null>(null);
  const request = enabled && userId ? `${userId}:${preferredKeys ?? ""}` : null;
  useEffect(() => {
    if (!request || !userId) return;
    let alive = true;
    let load = loads.get(request);
    if (!load) {
      load = loadHighwayNotes(userId, preferredKeys).catch(() => null);
      loads.set(request, load);
    }
    load.then((value) => {
        if (alive) setNotes({ for: request, value });
      });
    return () => {
      alive = false;
    };
  }, [request]); // eslint-disable-line react-hooks/exhaustive-deps
  return request && notes?.for === request ? notes.value : null;
}
