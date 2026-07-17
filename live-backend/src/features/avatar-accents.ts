import sharp from "sharp";
import type { Db } from "../db.js";
import { exec } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { logWarn, errorContext } from "../logger.js";

// Per-avatar accent colors for player names, computed here once per avatar URL and shipped inside
// the snapshot payloads the frontend already fetches (the legacy design computed these on Vercel per
// batch request and cached them in Turso). a.ppy.sh avatar URLs carry a cache-bust timestamp, so a
// URL's pixels never change: a computed accent is content-addressed and permanent. Retention prunes
// old rows only as a slow self-healing refresh.
//
// The extraction pipeline (quantize -> chromatic hue-bin vote -> normalize for text legibility) is
// ported verbatim from the legacy frontend src/lib/avatar.ts so colors do not shift mid-migration.

export const AVATAR_ACCENT_JOB = "compute_avatar_accent";

const AVATAR_FETCH_TIMEOUT_MS = 8_000;
const AVATAR_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const AVATAR_ACCENT_MAX_URL_LENGTH = 512;
// Failed fetches retry after a day (avatar CDN hiccups, deleted accounts); successful rows are
// permanent until retention's slow refresh window.
const AVATAR_ACCENT_ERROR_RETRY_MS = 24 * 60 * 60 * 1000;
const ENRICH_READ_BATCH = 100;
const ENRICH_MAX_URLS = 2_000;

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface ColorBucket {
  count: number;
  color: RgbColor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function rgbToHsl({ r, g, b }: RgbColor): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l };
  }

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;

  switch (max) {
    case rn:
      h = (gn - bn) / d + (gn < bn ? 6 : 0);
      break;
    case gn:
      h = (bn - rn) / d + 2;
      break;
    default:
      h = (rn - gn) / d + 4;
      break;
  }

  return { h: h / 6, s, l };
}

function hueToRgb(p: number, q: number, t: number): number {
  let next = t;
  if (next < 0) next += 1;
  if (next > 1) next -= 1;
  if (next < 1 / 6) return p + (q - p) * 6 * next;
  if (next < 1 / 2) return q;
  if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): RgbColor {
  if (s === 0) {
    const value = Math.round(l * 255);
    return { r: value, g: value, b: value };
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, h) * 255),
    b: Math.round(hueToRgb(p, q, h - 1 / 3) * 255),
  };
}

function toHex({ r, g, b }: RgbColor): string {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function getLuminance({ r, g, b }: RgbColor): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function getSaturation(color: RgbColor): number {
  return rgbToHsl(color).s;
}

function getLightness(color: RgbColor): number {
  return rgbToHsl(color).l;
}

// Raw dominant colors are unreadable as text on the dark theme; clamp saturation and lightness
// into the band that stays legible while keeping the avatar's hue.
export function normalizeForText(color: RgbColor): string {
  const { h, s, l } = rgbToHsl(color);
  if (s < 0.08) {
    return toHex(hslToRgb(0, 0, clamp(Math.max(l, 0.62), 0.58, 0.74)));
  }

  const normalized = hslToRgb(
    h,
    clamp(Math.max(s, 0.55), 0.55, 0.9),
    clamp(Math.max(l, 0.62), 0.58, 0.74),
  );

  return toHex(normalized);
}

function averageColors(entries: Array<{ color: RgbColor; weight: number }>): RgbColor | null {
  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) return null;

  const weighted = entries.reduce(
    (sum, entry) => ({
      r: sum.r + entry.color.r * entry.weight,
      g: sum.g + entry.color.g * entry.weight,
      b: sum.b + entry.color.b * entry.weight,
    }),
    { r: 0, g: 0, b: 0 },
  );

  return {
    r: Math.round(weighted.r / totalWeight),
    g: Math.round(weighted.g / totalWeight),
    b: Math.round(weighted.b / totalWeight),
  };
}

function pickNeutralAccentColor(buckets: ColorBucket[]): string | null {
  const neutralCandidates = buckets
    .filter(({ color }) => {
      const luminance = getLuminance(color);
      return getSaturation(color) < 0.18 && luminance > 24 && luminance < 235;
    })
    .map((bucket) => {
      const lightness = getLightness(bucket.color);
      const midtoneWeight = 1 - Math.min(Math.abs(lightness - 0.5) / 0.5, 1);
      return {
        color: bucket.color,
        weight: bucket.count * (0.35 + midtoneWeight),
      };
    });

  const averaged = averageColors(neutralCandidates)
    ?? averageColors(buckets.map((bucket) => ({ color: bucket.color, weight: bucket.count })));

  return averaged ? normalizeForText(averaged) : null;
}

export function pickAccentColor(buckets: ColorBucket[]): string | null {
  if (buckets.length === 0) return null;

  const totalPixels = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const chromaticBuckets = buckets.filter(({ color }) => {
    const luminance = getLuminance(color);
    const saturation = getSaturation(color);
    return luminance > 55 && luminance < 248 && saturation >= 0.2;
  });
  const chromaticPixels = chromaticBuckets.reduce((sum, bucket) => sum + bucket.count, 0);

  // Avatars that are almost entirely grayscale should stay neutral instead of
  // latching onto a tiny colored patch.
  if (chromaticPixels / Math.max(totalPixels, 1) < 0.12) {
    return pickNeutralAccentColor(buckets);
  }

  const hueGroups = new Map<number, Array<{ color: RgbColor; weight: number }>>();

  chromaticBuckets.forEach((bucket) => {
    const { h, s, l } = rgbToHsl(bucket.color);
    const hueBin = Math.floor(h * 12) % 12;
    const lightnessWeight = 1 - Math.min(Math.abs(l - 0.58) / 0.58, 1);
    const weight = bucket.count * (0.4 + s) * (0.35 + lightnessWeight);
    const existing = hueGroups.get(hueBin);

    if (existing) {
      existing.push({ color: bucket.color, weight });
    } else {
      hueGroups.set(hueBin, [{ color: bucket.color, weight }]);
    }
  });

  const bestGroup = [...hueGroups.values()]
    .sort((a, b) => {
      const aWeight = a.reduce((sum, entry) => sum + entry.weight, 0);
      const bWeight = b.reduce((sum, entry) => sum + entry.weight, 0);
      return bWeight - aWeight;
    })[0];

  const chosen = bestGroup
    ? averageColors(bestGroup)
    : averageColors(buckets.map((bucket) => ({ color: bucket.color, weight: bucket.count })));

  return chosen ? normalizeForText(chosen) : null;
}

export function extractDominantColors(pixelData: Uint8Array | Buffer, channels: number): ColorBucket[] {
  const buckets = new Map<string, ColorBucket>();

  for (let i = 0; i < pixelData.length; i += channels) {
    const r = pixelData[i] ?? 0;
    const g = pixelData[i + 1] ?? 0;
    const b = pixelData[i + 2] ?? 0;
    const quantized: RgbColor = {
      r: clamp(Math.round(r / 16) * 16, 0, 255),
      g: clamp(Math.round(g / 16) * 16, 0, 255),
      b: clamp(Math.round(b / 16) * 16, 0, 255),
    };
    const key = `${quantized.r},${quantized.g},${quantized.b}`;
    const existing = buckets.get(key);

    if (existing) {
      existing.count += 1;
    } else {
      buckets.set(key, {
        count: 1,
        color: quantized,
      });
    }
  }

  return [...buckets.values()].sort((a, b) => b.count - a.count);
}

export function normalizeAvatarAccentUrl(url: unknown): string | null {
  if (typeof url !== "string" || url.length === 0 || url.length > AVATAR_ACCENT_MAX_URL_LENGTH) return null;

  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "a.ppy.sh") {
      return null;
    }
    parsedUrl.hash = "";
    return parsedUrl.href;
  } catch {
    return null;
  }
}

async function readImageBufferWithLimit(response: Response, limitBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const length = Number(contentLength);
    if (!Number.isFinite(length) || length < 0 || length > limitBytes) {
      throw new Error(`Avatar image is too large (${contentLength} bytes)`);
    }
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limitBytes) {
      throw new Error(`Avatar image is too large (${buffer.length} bytes)`);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Avatar image is too large (>${limitBytes} bytes)`);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks, total);
}

// Direct CDN fetch (a.ppy.sh), deliberately off the osu! API token bucket: avatars are public
// static content and this must never compete with score/roster refreshes for budget.
export async function extractAvatarAccent(url: string): Promise<string | null> {
  const normalizedUrl = normalizeAvatarAccentUrl(url);
  if (!normalizedUrl) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AVATAR_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(normalizedUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch avatar: ${response.status}`);
    }

    const buffer = await readImageBufferWithLimit(response, AVATAR_MAX_IMAGE_BYTES);
    const { data, info } = await sharp(buffer, { animated: false })
      .resize(24, 24, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const buckets = extractDominantColors(data, info.channels);
    return pickAccentColor(buckets);
  } finally {
    clearTimeout(timeout);
  }
}

interface AvatarAccentRow {
  accent: string | null;
  status: string;
  computedAt: number;
}

async function readAvatarAccentRows(db: Db, urls: string[]): Promise<Map<string, AvatarAccentRow>> {
  const out = new Map<string, AvatarAccentRow>();
  for (let i = 0; i < urls.length; i += ENRICH_READ_BATCH) {
    const batch = urls.slice(i, i + ENRICH_READ_BATCH);
    const placeholders = batch.map(() => "?").join(",");
    const result = await exec(
      db,
      `select avatar_url, accent, status, computed_at from avatar_accents where avatar_url in (${placeholders})`,
      batch,
    );
    for (const row of result.rows) {
      out.set(String(row.avatar_url), {
        accent: row.accent == null ? null : String(row.accent),
        status: String(row.status ?? "ok"),
        computedAt: Number(row.computed_at ?? 0),
      });
    }
  }
  return out;
}

async function upsertAvatarAccent(db: Db, url: string, accent: string | null, status: "ok" | "error"): Promise<void> {
  await exec(
    db,
    `insert into avatar_accents (avatar_url, accent, status, computed_at)
     values (?, ?, ?, ?)
     on conflict(avatar_url) do update set
       accent = excluded.accent,
       status = excluded.status,
       computed_at = excluded.computed_at`,
    [url, accent, status, Date.now()],
  );
}

function avatarAccentJobKey(url: string): string {
  return `avatar-accent:${url}`;
}

export async function enqueueAvatarAccentJobs(queue: JobQueue, urls: Iterable<string>): Promise<void> {
  for (const url of urls) {
    try {
      // Low priority: accents are cosmetic. replaceDone so a pruned/retried URL can recompute.
      await queue.enqueue(AVATAR_ACCENT_JOB, avatarAccentJobKey(url), { url }, { priority: 20, replaceDone: true });
    } catch (error) {
      logWarn("avatar_accent_enqueue_failed", { url, ...errorContext(error) });
    }
  }
}

export async function computeAvatarAccentJob(db: Db, payload: unknown): Promise<void> {
  const url = normalizeAvatarAccentUrl((payload as { url?: unknown })?.url);
  if (!url) return;
  try {
    const accent = await extractAvatarAccent(url);
    await upsertAvatarAccent(db, url, accent, "ok");
  } catch (error) {
    await upsertAvatarAccent(db, url, null, "error");
    logWarn("avatar_accent_compute_failed", { url, ...errorContext(error) });
  }
}

// Look up a single URL's accent (SSE emit path: one user per event). Misses enqueue a compute job
// and return null; the accent then rides every later payload.
export async function getAvatarAccentForUrl(db: Db, queue: JobQueue | null, url: unknown): Promise<string | null> {
  const normalized = normalizeAvatarAccentUrl(url);
  if (!normalized) return null;
  const rows = await readAvatarAccentRows(db, [normalized]);
  const row = rows.get(normalized);
  if (row && (row.status === "ok" || Date.now() - row.computedAt < AVATAR_ACCENT_ERROR_RETRY_MS)) {
    return row.accent;
  }
  if (queue) await enqueueAvatarAccentJobs(queue, [normalized]);
  return null;
}

export const AVATAR_ACCENT_LOOKUP_MAX_URLS = 100;

// Batch lookup for surfaces whose data never passes through
// enrichPayloadAvatarAccents (osu!-API-sourced rankings on home and /rankings):
// the browser asks for accents by avatar URL after render. Misses enqueue a
// compute job, same as enrichment, so unknown avatars color on a later visit.
export async function lookupAvatarAccents(db: Db, queue: JobQueue | null, urls: unknown): Promise<Record<string, string>> {
  if (!Array.isArray(urls)) return {};
  const normalizedByRaw = new Map<string, string>();
  for (const raw of urls.slice(0, AVATAR_ACCENT_LOOKUP_MAX_URLS)) {
    if (typeof raw !== "string") continue;
    const normalized = normalizeAvatarAccentUrl(raw);
    if (normalized) normalizedByRaw.set(raw, normalized);
  }
  if (normalizedByRaw.size === 0) return {};

  const uniqueUrls = [...new Set(normalizedByRaw.values())];
  const rows = await readAvatarAccentRows(db, uniqueUrls);
  const missing = uniqueUrls.filter((url) => {
    const row = rows.get(url);
    return !row || (row.status !== "ok" && Date.now() - row.computedAt >= AVATAR_ACCENT_ERROR_RETRY_MS);
  });
  if (queue && missing.length > 0) {
    await enqueueAvatarAccentJobs(queue, missing);
  }

  const accents: Record<string, string> = {};
  for (const [raw, normalized] of normalizedByRaw) {
    const accent = rows.get(normalized)?.accent;
    if (accent) accents[raw] = accent;
  }
  return accents;
}

function isPlainObjectOrArray(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

// Walk a snapshot payload and collect every object that carries an avatar URL, in either of the two
// spellings the payloads use (osu-shaped score objects are snake_case, projection rows camelCase).
function collectAvatarCarriers(payload: unknown, carriers: Array<{ holder: Record<string, unknown>; key: "avatar_url" | "avatarUrl"; url: string }>): void {
  if (!isPlainObjectOrArray(payload)) return;
  if (Array.isArray(payload)) {
    for (const item of payload) collectAvatarCarriers(item, carriers);
    return;
  }
  const record = payload;
  for (const key of ["avatar_url", "avatarUrl"] as const) {
    const url = record[key];
    if (typeof url === "string" && url.length > 0) {
      carriers.push({ holder: record, key, url });
    }
  }
  for (const value of Object.values(record)) {
    collectAvatarCarriers(value, carriers);
  }
}

// Attach accents in place: `avatar_accent` next to `avatar_url`, `avatarAccent` next to
// `avatarUrl`. Unknown URLs get null now and a compute job for next time. Payloads are the
// response objects about to be serialized, so mutation is safe and cheap.
export async function enrichPayloadAvatarAccents(db: Db, queue: JobQueue | null, payload: unknown): Promise<void> {
  const carriers: Array<{ holder: Record<string, unknown>; key: "avatar_url" | "avatarUrl"; url: string }> = [];
  try {
    collectAvatarCarriers(payload, carriers);
    if (carriers.length === 0) return;

    const normalizedByRaw = new Map<string, string | null>();
    for (const carrier of carriers) {
      if (!normalizedByRaw.has(carrier.url)) {
        normalizedByRaw.set(carrier.url, normalizeAvatarAccentUrl(carrier.url));
      }
    }
    const uniqueUrls = [...new Set([...normalizedByRaw.values()].filter((url): url is string => url !== null))].slice(0, ENRICH_MAX_URLS);
    const rows = await readAvatarAccentRows(db, uniqueUrls);

    const missing: string[] = [];
    for (const url of uniqueUrls) {
      const row = rows.get(url);
      if (!row || (row.status !== "ok" && Date.now() - row.computedAt >= AVATAR_ACCENT_ERROR_RETRY_MS)) {
        missing.push(url);
      }
    }

    for (const carrier of carriers) {
      const normalized = normalizedByRaw.get(carrier.url);
      const accent = normalized ? rows.get(normalized)?.accent ?? null : null;
      carrier.holder[carrier.key === "avatar_url" ? "avatar_accent" : "avatarAccent"] = accent;
    }

    if (queue && missing.length > 0) {
      await enqueueAvatarAccentJobs(queue, missing);
    }
  } catch (error) {
    // Enrichment is strictly additive; a failure must never break the snapshot response.
    logWarn("avatar_accent_enrich_failed", { carriers: carriers.length, ...errorContext(error) });
  }
}

// Slow self-healing refresh: rows older than the window are pruned and recompute on next sight.
// Also bounds the table against churn from avatar changes (each change is a new URL).
export const AVATAR_ACCENT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

export async function pruneAvatarAccents(db: Db): Promise<number> {
  const result = await exec(db, "delete from avatar_accents where computed_at < ?", [Date.now() - AVATAR_ACCENT_RETENTION_MS]);
  return result.rowsAffected ?? 0;
}
