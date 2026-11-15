// Song titles and artists in their own language (osu!'s title_unicode /
// artist_unicode) for readers who turn the setting on. Most payloads carry
// only the romanized text, so the original is looked up by beatmapset id:
// ids asked for in the same moment go out as one request, answers are kept
// in memory and in localStorage, and a set whose romanized text is already
// the original is remembered as such, so each set is asked about once.

import { useEffect, useSyncExternalStore } from "react";
import { getLiveBackendUrl } from "./live-backend";
import { useOriginalTitles } from "../store";

export interface OriginalTitle {
  title?: string;
  artist?: string;
}

const STORAGE_KEY = "mania-hub-original-titles-v1";
// Newest answers kept across visits; the rest are asked again when seen.
const STORAGE_MAX = 4000;
const BATCH_MAX = 100;
const BATCH_DELAY_MS = 30;

// null: the romanized text is the original.
const known = new Map<number, OriginalTitle | null>();
const queued = new Set<number>();
const inFlight = new Set<number>();
const listeners = new Set<() => void>();
let version = 0;
let loaded = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): void {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const entries = raw ? (JSON.parse(raw) as Array<[number, OriginalTitle | null]>) : [];
    for (const [id, entry] of entries) if (Number.isSafeInteger(id)) known.set(id, entry);
  } catch {
    // Unreadable or blocked storage: start empty.
  }
}

function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      // Map order is insertion order, so the newest answers are the tail.
      const entries = [...known.entries()].slice(-STORAGE_MAX);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // Full or blocked storage: the answers still hold for this page.
    }
  }, 1000);
}

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

async function flush(): Promise<void> {
  flushTimer = null;
  const base = getLiveBackendUrl();
  const ids = [...queued];
  queued.clear();
  if (!base || ids.length === 0) return;
  for (let start = 0; start < ids.length; start += BATCH_MAX) {
    const chunk = ids.slice(start, start + BATCH_MAX);
    for (const id of chunk) inFlight.add(id);
    try {
      const response = await fetch(`${base}/api/snapshots/original-titles?ids=${chunk.join(",")}`, { credentials: "omit" });
      if (!response.ok) continue;
      const payload = (await response.json()) as { titles?: Record<string, OriginalTitle> };
      for (const id of chunk) known.set(id, payload.titles?.[String(id)] ?? null);
      save();
      notify();
    } catch {
      // Offline or backend down: show romanized; asked again on a later view.
    } finally {
      for (const id of chunk) inFlight.delete(id);
    }
  }
}

function request(id: number): void {
  if (known.has(id) || queued.has(id) || inFlight.has(id)) return;
  queued.add(id);
  flushTimer ??= setTimeout(() => void flush(), BATCH_DELAY_MS);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getVersion = () => version;
const getServerVersion = () => 0;

export interface SongText {
  title: string;
  artist: string;
}

/** The title and artist to show: the original-language ones when the reader
 *  turned that on and the set has them, else the romanized ones given.
 *  `titleUnicode`/`artistUnicode` from an osu! API object skip the lookup. */
export function useSongText(
  beatmapsetId: number | null | undefined,
  romanized: SongText,
  inline?: { titleUnicode?: string | null; artistUnicode?: string | null },
): SongText {
  const enabled = useOriginalTitles();
  useSyncExternalStore(subscribe, getVersion, getServerVersion);
  const id = typeof beatmapsetId === "number" && Number.isSafeInteger(beatmapsetId) && beatmapsetId > 0 ? beatmapsetId : null;
  const hasInline = Boolean(inline?.titleUnicode || inline?.artistUnicode);
  useEffect(() => {
    if (!enabled || id == null || hasInline) return;
    load();
    request(id);
  }, [enabled, id, hasInline]);
  if (!enabled) return romanized;
  if (hasInline) {
    return { title: inline?.titleUnicode || romanized.title, artist: inline?.artistUnicode || romanized.artist };
  }
  if (id == null) return romanized;
  load();
  const entry = known.get(id);
  if (!entry) return romanized;
  return { title: entry.title ?? romanized.title, artist: entry.artist ?? romanized.artist };
}

/** Just the title, for places that show no artist. */
export function useSongTitle(beatmapsetId: number | null | undefined, title: string, titleUnicode?: string | null): string {
  return useSongText(beatmapsetId, { title, artist: "" }, { titleUnicode }).title;
}

/** Text components for spots that render inside a list item without hooks of their own. */
export function SongTitle({ beatmapsetId, title, titleUnicode }: { beatmapsetId: number | null | undefined; title: string | null | undefined; titleUnicode?: string | null }) {
  return <>{useSongTitle(beatmapsetId, title ?? "", titleUnicode)}</>;
}

export function SongArtist({ beatmapsetId, artist, artistUnicode }: { beatmapsetId: number | null | undefined; artist: string | null | undefined; artistUnicode?: string | null }) {
  return <>{useSongText(beatmapsetId, { title: "", artist: artist ?? "" }, { artistUnicode }).artist}</>;
}

/** Any osu!-shaped beatmapset: its id, romanized text and, when osu! sent
 *  them, the original-language fields. */
export type SongSet = {
  id?: number | null;
  title?: string | null;
  artist?: string | null;
  title_unicode?: string | null;
  artist_unicode?: string | null;
} | null | undefined;

export function SetTitle({ set }: { set: SongSet }) {
  return <>{useSongText(set?.id, { title: set?.title ?? "", artist: "" }, { titleUnicode: set?.title_unicode }).title}</>;
}

export function SetArtist({ set }: { set: SongSet }) {
  return <>{useSongText(set?.id, { title: "", artist: set?.artist ?? "" }, { artistUnicode: set?.artist_unicode }).artist}</>;
}
