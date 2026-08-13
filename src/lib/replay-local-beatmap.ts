import JSZip from "jszip";

import { md5Hex } from "./md5";

// Local files never leave the browser, but they are unzipped in memory, so
// keep an upper bound on what gets read.
const MAX_LOCAL_BEATMAP_FILE_BYTES = 400 * 1024 * 1024;

export type LocalBeatmapMatch = {
  content: string;
  osuFilename: string;
  audioBlob: Blob | null;
  audioFilename: string | null;
  backgroundBlob: Blob | null;
  backgroundFilename: string | null;
};

// .olz is what osu!lazer's own Export writes when the compatibility (.osz)
// option isn't picked; it is the same zip with another extension, and the MD5
// check below is what decides whether the contents are the right map anyway.
export function isLocalBeatmapFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".osz") || lower.endsWith(".olz") || lower.endsWith(".zip") || lower.endsWith(".osu");
}

function parseAudioFilename(content: string): string | null {
  const match = content.match(/^AudioFilename\s*:\s*(.+)$/im);
  const value = match?.[1]?.trim().replace(/\\/g, "/");
  return value || null;
}

function parseBackgroundFilename(content: string): string | null {
  const match = content.match(/^0\s*,\s*0\s*,\s*"(.+?)"/m);
  const value = match?.[1]?.trim().replace(/\\/g, "/");
  return value || null;
}

function findArchiveEntry(zip: JSZip, filename: string): JSZip.JSZipObject | null {
  const lower = filename.replace(/\\/g, "/").toLowerCase();
  const baseName = lower.split("/").pop() ?? lower;
  let byBaseName: JSZip.JSZipObject | null = null;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const path = entry.name.replace(/\\/g, "/").toLowerCase();
    if (path === lower) return entry;
    if (!byBaseName && path.split("/").pop() === baseName) byBaseName = entry;
  }
  return byBaseName;
}

async function extractArchiveBlob(zip: JSZip, filename: string | null): Promise<Blob | null> {
  if (!filename) return null;
  const entry = findArchiveEntry(zip, filename);
  if (!entry) return null;
  return entry.async("blob").catch(() => null);
}

async function buildMatch(zip: JSZip | null, content: string, osuFilename: string): Promise<LocalBeatmapMatch> {
  const audioFilename = parseAudioFilename(content);
  const backgroundFilename = parseBackgroundFilename(content);
  return {
    content,
    osuFilename,
    audioFilename,
    backgroundFilename,
    audioBlob: zip ? await extractArchiveBlob(zip, audioFilename) : null,
    backgroundBlob: zip ? await extractArchiveBlob(zip, backgroundFilename) : null,
  };
}

/** Finds the difficulty matching the replay's beatmap MD5 inside a local .osz
 *  archive (or checks a bare .osu file), and pulls the map's audio/background
 *  out of the archive so the viewer can play an unsubmitted map offline. */
export async function matchLocalBeatmapFile(file: File, beatmapChecksum: string): Promise<LocalBeatmapMatch> {
  const checksum = beatmapChecksum.trim().toLowerCase();
  const name = file.name.toLowerCase();

  if (file.size > MAX_LOCAL_BEATMAP_FILE_BYTES) {
    throw new Error("That file is too large to open in the browser.");
  }

  if (name.endsWith(".osu")) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (md5Hex(bytes) !== checksum) {
      throw new Error("That .osu file doesn't match this replay. It's a different version of the map.");
    }
    return buildMatch(null, new TextDecoder().decode(bytes), file.name);
  }

  if (!name.endsWith(".osz") && !name.endsWith(".olz") && !name.endsWith(".zip")) {
    throw new Error("Drop the map's .osz archive, or its exact .osu file.");
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw new Error("Couldn't read that archive. Make sure it's a valid .osz file.");
  }

  const difficulties = Object.values(zip.files).filter(
    (entry) => !entry.dir && entry.name.toLowerCase().endsWith(".osu"),
  );
  if (difficulties.length === 0) {
    throw new Error("That archive contains no .osu difficulty files.");
  }

  for (const entry of difficulties) {
    const bytes = await entry.async("uint8array");
    if (md5Hex(bytes) !== checksum) continue;
    return buildMatch(zip, new TextDecoder().decode(bytes), entry.name);
  }

  throw new Error(
    difficulties.length === 1
      ? "The difficulty in that archive doesn't match this replay. It's a different version of the map."
      : `None of the ${difficulties.length} difficulties in that archive match this replay. It's a different version of the map.`,
  );
}
