import crypto from "node:crypto";
// Type-only: jszip's runtime is loaded on demand inside validateOskBuffer so
// .osk uploads (a rare admin-ish action) don't put the library in the boot
// module graph of the serving process.
import type JSZip from "jszip";

// skin.ini discovery and parsing are a port of src/lib/replay-skin-import.ts
// (readSkinIni / parseSkinIni) so uploads validate against the same rules the
// replay viewer applies when importing an .osk. Kept as a copy on purpose: the
// two packages have separate module systems (precedent: the dan estimator).

const MAX_ZIP_ENTRIES = 15_000;
const MAX_SKIN_INI_BYTES = 1024 * 1024;
const MAX_KEYMODE = 10;

export interface OskInfo {
  name: string | null;
  author: string | null;
  keymodes: number[];
  // Keymodes whose layout is really (N-1)+1: the block draws a separator line
  // against the first or last column, the way 7K+1 skins mark the scratch
  // lane inside their 8K block.
  specialKeymodes: number[];
  accentColor: string | null;
  sha256: string;
}

export type OskValidation =
  | { ok: true; info: OskInfo }
  | { ok: false; error: string };

export async function validateOskBuffer(buffer: Buffer): Promise<OskValidation> {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
    return { ok: false, error: "not_a_zip" };
  }

  // Outside the try: a failed module load is an environment bug that should
  // surface as an error, not be misreported as a bad upload.
  const { default: JSZipRuntime } = await import("jszip");
  let zip: JSZip;
  try {
    zip = await JSZipRuntime.loadAsync(buffer);
  } catch {
    return { ok: false, error: "zip_unreadable" };
  }

  const entries = Object.values(zip.files);
  if (entries.length > MAX_ZIP_ENTRIES) return { ok: false, error: "too_many_entries" };
  for (const entry of entries) {
    if (normalizeZipPath(entry.name).split("/").includes("..")) return { ok: false, error: "unsafe_paths" };
  }

  const skinIniFile = findSkinIni(entries);
  if (!skinIniFile) return { ok: false, error: "missing_skin_ini" };

  let skinIni: string;
  try {
    // Only skin.ini is ever decompressed server-side; the capped read keeps a
    // crafted archive from expanding past MAX_SKIN_INI_BYTES in memory.
    skinIni = (await readZipEntryCapped(skinIniFile, MAX_SKIN_INI_BYTES)).toString("utf8");
  } catch (error) {
    return { ok: false, error: error instanceof EntryTooLargeError ? "skin_ini_too_large" : "zip_unreadable" };
  }

  const parsed = parseSkinIni(skinIni);
  const keymodes = [...new Set(
    parsed.mania
      .map((block) => parseInteger(block.Keys))
      .filter((keys): keys is number => keys != null && keys >= 1 && keys <= MAX_KEYMODE),
  )].sort((a, b) => a - b);
  if (keymodes.length === 0) return { ok: false, error: "no_mania_keymodes" };

  return {
    ok: true,
    info: {
      name: parsed.name,
      author: parsed.author,
      keymodes,
      specialKeymodes: detectSpecialKeymodes(parsed.mania),
      accentColor: pickAccentColor(parsed.mania),
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    },
  };
}

export function detectSpecialKeymodes(maniaBlocks: Array<Record<string, string>>): number[] {
  return [...new Set(
    maniaBlocks
      .map((block) => ({ keys: parseInteger(block.Keys), block }))
      .filter((entry): entry is { keys: number; block: Record<string, string> } =>
        entry.keys != null && entry.keys >= 1 && entry.keys <= MAX_KEYMODE)
      .filter(({ keys, block }) => hasSpecialColumnSeparator(block, keys))
      .map(({ keys }) => keys),
  )].sort((a, b) => a - b);
}

// ColumnLineWidth is keys+1 boundary line widths (outer stage edges included);
// absent entries keep stable's 2-unit default. An (N-1)+1 skin marks its
// special column by drawing the line on that column's inside edge - the right
// side of the first column or the left side of the last - clearly heavier than
// every other line between columns. A uniform grid (every boundary equal, the
// default) never qualifies.
export function hasSpecialColumnSeparator(block: Record<string, string>, keys: number): boolean {
  if (keys < 3 || block.ColumnLineWidth == null) return false;
  const parsed = block.ColumnLineWidth.split(",").map((part) => Number(part.trim()));
  const widths = Array.from({ length: keys + 1 }, (_, index) =>
    Number.isFinite(parsed[index]) ? clampInteger(parsed[index], 0, 20) : 2);
  for (const edge of [1, keys - 1]) {
    let othersMax = 0;
    for (let index = 1; index < keys; index += 1) {
      if (index !== edge) othersMax = Math.max(othersMax, widths[index]);
    }
    if (widths[edge] >= 2 && widths[edge] >= othersMax + 2) return true;
  }
  return false;
}

export function sniffImage(buffer: Buffer): { ext: "png" | "jpeg" | "webp"; mime: string } | null {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { ext: "png", mime: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: "jpeg", mime: "image/jpeg" };
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  return null;
}

interface SkinIniData {
  name: string | null;
  author: string | null;
  mania: Array<Record<string, string>>;
}

export function parseSkinIni(content: string): SkinIniData {
  const data: SkinIniData = { name: null, author: null, mania: [] };
  let section = "";
  let currentMania: Record<string, string> | null = null;

  for (const rawLine of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const commentIndex = rawLine.indexOf("//");
    const line = (commentIndex >= 0 ? rawLine.slice(0, commentIndex) : rawLine).trim();
    if (!line) continue;

    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      currentMania = section === "Mania" ? {} : null;
      if (currentMania) data.mania.push(currentMania);
      continue;
    }

    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) continue;

    if (section === "General") {
      if (key === "Name") data.name = value || data.name;
      if (key === "Author") data.author = value || data.author;
    } else if (section === "Mania" && currentMania) {
      currentMania[key] = value;
    }
  }

  return data;
}

function findSkinIni(entries: JSZip.JSZipObject[]): JSZip.JSZipObject | null {
  return entries.find((entry) => !entry.dir && normalizeZipPath(entry.name).toLowerCase() === "skin.ini")
    ?? entries.find((entry) => !entry.dir && normalizeZipPath(entry.name).toLowerCase().endsWith("/skin.ini"))
    ?? null;
}

class EntryTooLargeError extends Error {}

function readZipEntryCapped(file: JSZip.JSZipObject, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const stream = file.nodeStream("nodebuffer");
    stream.on("data", (chunk: Buffer | string) => {
      if (done) return;
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += piece.length;
      if (total > maxBytes) {
        done = true;
        stream.pause();
        reject(new EntryTooLargeError("zip entry exceeds size cap"));
        return;
      }
      chunks.push(piece);
    });
    stream.on("error", (error) => {
      if (done) return;
      done = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    stream.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

function pickAccentColor(maniaBlocks: Array<Record<string, string>>): string | null {
  // Prefer the lit note colour over the column background, and skip
  // near-black values that would render as an invisible accent.
  const candidates: string[] = [];
  for (const block of maniaBlocks) {
    for (const key of ["ColourLight1", "Colour1"]) {
      const parsed = parseColor(block[key]);
      if (parsed) candidates.push(parsed);
    }
  }
  return candidates.find((color) => !isNearBlack(color)) ?? null;
}

function isNearBlack(color: string): boolean {
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return r < 24 && g < 24 && b < 24;
}

function parseColor(value: string | undefined): string | null {
  if (!value) return null;
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
  return `#${parts.slice(0, 3).map((part) => clampInteger(part, 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

function parseInteger(value: string | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeZipPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}
