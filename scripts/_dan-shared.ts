import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

export interface BeatmapMeta {
  beatmapId: number | null;
  source: string;
  starRating: number | null;
  text: string;
}

export interface CatboyBeatmapset {
  ChildrenBeatmaps?: Array<{
    BeatmapID?: number;
    DifficultyRating?: number;
    DiffName?: string;
  }>;
}

export async function fetchWithTimeout(input: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // catboy.best 403s requests with undici's default User-Agent.
    return await fetch(input, {
      signal: controller.signal,
      headers: { Accept: "*/*", "User-Agent": "mania-hub-dan-benchmark/1.0 (+https://mania-tracker.com)" },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readCachedBuffer(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function downloadBeatmapset(beatmapsetId: number, cacheDir: string): Promise<Buffer> {
  const dir = path.resolve(process.cwd(), cacheDir);
  const filePath = path.join(dir, `${beatmapsetId}.osz`);
  const cached = await readCachedBuffer(filePath);
  if (cached) return cached;

  await mkdir(dir, { recursive: true });
  const res = await fetchWithTimeout(`https://catboy.best/d/${beatmapsetId}`, 60_000);
  if (!res.ok) throw new Error(`Failed to download beatmapset ${beatmapsetId}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(filePath, buffer);
  return buffer;
}

export async function fetchCatboyBeatmapset(beatmapsetId: number): Promise<CatboyBeatmapset | null> {
  const res = await fetchWithTimeout(`https://catboy.best/api/search?query=${encodeURIComponent(String(beatmapsetId))}&mode=3`, 20_000);
  if (!res.ok) return null;
  const data = await res.json() as Array<CatboyBeatmapset & { SetID?: number }>;
  return data.find((set) => set.SetID === beatmapsetId) ?? null;
}

export async function fetchCatboyBeatmapsetByTitle(beatmapsetId: number, title: string): Promise<CatboyBeatmapset | null> {
  const res = await fetchWithTimeout(`https://catboy.best/api/search?query=${encodeURIComponent(title)}&mode=3`, 20_000);
  if (!res.ok) return null;
  const data = await res.json() as Array<CatboyBeatmapset & { SetID?: number }>;
  return data.find((set) => set.SetID === beatmapsetId) ?? null;
}

export async function fetchBeatmapFile(beatmapId: number): Promise<string> {
  const res = await fetchWithTimeout(`https://osu.ppy.sh/osu/${beatmapId}`, 20_000);
  if (!res.ok) throw new Error(`Failed to fetch beatmap ${beatmapId}: ${res.status}`);
  return res.text();
}

export function parseBeatmapId(content: string): number | null {
  const match = content.match(/^BeatmapID\s*:\s*(\d+)/m);
  return match ? Number(match[1]) : null;
}

export function parseUrlSource(source: string): { beatmapsetId: number | null; beatmapId: number | null } {
  const beatmapset = source.match(/beatmapsets\/(\d+)/)?.[1];
  const hashBeatmap = source.match(/#mania\/(\d+)/)?.[1];
  const beatmap = source.match(/\/(?:b|beatmaps)\/(\d+)/)?.[1];
  return {
    beatmapsetId: beatmapset ? Number(beatmapset) : null,
    beatmapId: hashBeatmap || beatmap ? Number(hashBeatmap ?? beatmap) : null,
  };
}

export function starForBeatmap(beatmapId: number | null, apiData: CatboyBeatmapset | null): number | null {
  if (!beatmapId || !apiData?.ChildrenBeatmaps) return null;
  return apiData.ChildrenBeatmaps.find((child) => child.BeatmapID === beatmapId)?.DifficultyRating ?? null;
}

export async function extractOsz(buffer: Buffer, source: string, apiData: CatboyBeatmapset | null): Promise<BeatmapMeta[]> {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith(".osu"));
  const beatmaps: BeatmapMeta[] = [];

  for (const entry of entries) {
    const text = await entry.async("string");
    const beatmapId = parseBeatmapId(text);
    beatmaps.push({
      beatmapId,
      source: `${source}:${entry.name}`,
      starRating: starForBeatmap(beatmapId, apiData),
      text,
    });
  }

  return beatmaps;
}
