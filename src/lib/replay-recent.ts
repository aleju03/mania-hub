// Locally remembered replays, so returning to /replay offers the last few
// replays you watched instead of an empty search box. Kept in its own small
// localStorage key (never the persisted store blob) since it is a preference,
// not cached API data, and must survive cache-version bumps and quota evictions.

export const RECENT_REPLAYS_STORAGE_KEY = "mania-hub-replay-recent-v1";
export const RECENT_REPLAYS_LIMIT = 12;

export interface RecentReplayMod {
  acronym: string;
  rate?: number;
}

export interface RecentReplayEntry {
  /** "score:<id>" or "upload:<id>"; the identity used for dedupe and removal. */
  key: string;
  scoreId?: number;
  uploadId?: string;
  beatmapsetId?: number;
  title: string;
  artist?: string;
  version?: string;
  keyCount?: number;
  playerName: string;
  coverUrl?: string;
  grade?: string;
  accuracy?: number;
  pp?: number;
  mods?: RecentReplayMod[];
  viewedAt: number;
  /** Who shared the file, for lists of uploads where the player in the replay
      is not necessarily the person who uploaded it. Never persisted. */
  uploadedBy?: { userId: number | null; username: string };
}

export function recentReplayScoreKey(scoreId: number): string {
  return `score:${scoreId}`;
}

export function recentReplayUploadKey(uploadId: string): string {
  return `upload:${uploadId}`;
}

function normalizeMods(value: unknown): RecentReplayMod[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const mods: RecentReplayMod[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const mod = raw as Record<string, unknown>;
    if (typeof mod.acronym !== "string" || !mod.acronym) continue;
    const rate = typeof mod.rate === "number" && Number.isFinite(mod.rate) ? mod.rate : undefined;
    mods.push(rate == null ? { acronym: mod.acronym } : { acronym: mod.acronym, rate });
  }
  return mods.length > 0 ? mods : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Entries are user data that survives releases, so every field is re-validated
// on read: a shape change or a hand-edited key drops the bad rows, not the list.
export function normalizeRecentReplayEntry(value: unknown): RecentReplayEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const scoreId = optionalNumber(raw.scoreId);
  const uploadId = optionalString(raw.uploadId);
  if (scoreId == null && !uploadId) return null;
  const key = scoreId != null ? recentReplayScoreKey(scoreId) : recentReplayUploadKey(uploadId!);
  const viewedAt = optionalNumber(raw.viewedAt);
  if (viewedAt == null) return null;

  return {
    key,
    ...(scoreId != null ? { scoreId } : {}),
    ...(scoreId == null && uploadId ? { uploadId } : {}),
    beatmapsetId: optionalNumber(raw.beatmapsetId),
    title: optionalString(raw.title) ?? "Unknown beatmap",
    artist: optionalString(raw.artist),
    version: optionalString(raw.version),
    keyCount: optionalNumber(raw.keyCount),
    playerName: optionalString(raw.playerName) ?? "Unknown player",
    coverUrl: optionalString(raw.coverUrl),
    grade: optionalString(raw.grade),
    accuracy: optionalNumber(raw.accuracy),
    pp: optionalNumber(raw.pp),
    mods: normalizeMods(raw.mods),
    viewedAt,
  };
}

function sortAndCap(entries: RecentReplayEntry[]): RecentReplayEntry[] {
  return entries
    .slice()
    .sort((a, b) => b.viewedAt - a.viewedAt)
    .slice(0, RECENT_REPLAYS_LIMIT);
}

export function readRecentReplays(): RecentReplayEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_REPLAYS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const entries: RecentReplayEntry[] = [];
    for (const item of parsed) {
      const entry = normalizeRecentReplayEntry(item);
      if (!entry || seen.has(entry.key)) continue;
      seen.add(entry.key);
      entries.push(entry);
    }
    return sortAndCap(entries);
  } catch {
    return [];
  }
}

function writeRecentReplays(entries: RecentReplayEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    if (entries.length === 0) {
      window.localStorage.removeItem(RECENT_REPLAYS_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(RECENT_REPLAYS_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // A full quota just means the list stops growing; watching still works.
  }
}

/** Adds (or refreshes) one entry and returns the list the UI should render. */
export function recordRecentReplay(entry: Omit<RecentReplayEntry, "key">): RecentReplayEntry[] {
  const normalized = normalizeRecentReplayEntry(entry);
  if (!normalized) return readRecentReplays();
  const next = sortAndCap([normalized, ...readRecentReplays().filter((item) => item.key !== normalized.key)]);
  writeRecentReplays(next);
  return next;
}

export function removeRecentReplay(key: string): RecentReplayEntry[] {
  const next = readRecentReplays().filter((entry) => entry.key !== key);
  writeRecentReplays(next);
  return next;
}

export function clearRecentReplays(): RecentReplayEntry[] {
  writeRecentReplays([]);
  return [];
}
