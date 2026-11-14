// Finds the files inside a .osk that osu! never loads, so the upload form can
// say how much of the archive is dead weight and offer to leave it out. Pure
// over the zip listing plus the text of skin.ini (and any lazer .json), so it
// runs in the browser on the archive the form already opened.
//
// Only files that are certainly unused are flagged: another archive inside the
// archive, editor and OS leftovers, files in subfolders that skin.ini never
// points at, and root files with copy names ("x (1).png", "x - Copy.wav").
// Left alone on purpose: SD images next to their @2x, and a root sound that
// ships in several formats, since one copy is often a 0-byte silencer and
// which one osu! plays decides whether the custom sound is heard.

import JSZip from "jszip";

export type SkinDeadWeightKind = "archive" | "leftover" | "unreferenced" | "copy";

export interface SkinDeadWeightFile {
  path: string;
  // Bytes the entry takes inside the .osk (compressed), which is what leaving
  // it out saves.
  bytes: number;
  kind: SkinDeadWeightKind;
}

export interface SkinDeadWeight {
  files: SkinDeadWeightFile[];
  bytes: number;
}

export interface SkinZipEntry {
  path: string;
  bytes: number;
}

const ARCHIVE_EXTENSIONS = new Set(["osk", "olz", "zip", "rar", "7z", "tar", "gz"]);
// Project files from image and audio editors, OS metadata, and executables:
// nothing osu! reads, at any path.
const LEFTOVER_EXTENSIONS = new Set([
  "psd", "psb", "kra", "xcf", "ai", "clip", "sai", "sai2", "mdp", "pdn", "aep", "blend",
  "pkf", "sfk", "asd", "reapeaks", "flp", "als",
  "bak", "tmp", "exe", "lnk", "url",
]);
const LEFTOVER_NAMES = new Set(["thumbs.db", "desktop.ini", ".ds_store"]);
const COPY_NAME = /(\s?\(\d+\)|\s?-\s?copy(\s?\(\d+\))?|\scopy|_old|\.old|_backup|\sbackup)$/i;

export function findSkinDeadWeight(entries: SkinZipEntry[], textFiles: Record<string, string>): SkinDeadWeight {
  const files = entries.map((entry) => ({ ...entry, path: normalizePath(entry.path) })).filter((entry) => entry.path && !entry.path.endsWith("/"));
  // The skin lives where its shallowest skin.ini is; an archive wrapped in one
  // folder is still one skin. Without a skin.ini nothing can be called unused.
  const ini = files
    .filter((entry) => basename(entry.path).toLowerCase() === "skin.ini")
    .sort((a, b) => depth(a.path) - depth(b.path))[0];
  if (!ini) return { files: [], bytes: 0 };
  const root = ini.path.slice(0, ini.path.length - "skin.ini".length).toLowerCase();

  const references = collectReferences(textFiles[ini.path] ?? "");
  // Lazer layouts can name a sprite anywhere, so any string in a .json counts.
  for (const [path, text] of Object.entries(textFiles)) {
    if (path.toLowerCase().endsWith(".json")) for (const value of jsonStrings(text)) references.add(cleanReference(value));
  }

  const flagged: SkinDeadWeightFile[] = [];
  for (const entry of files) {
    const lower = entry.path.toLowerCase();
    const base = basename(lower);
    const ext = extension(base);
    if (ARCHIVE_EXTENSIONS.has(ext)) {
      flagged.push({ ...entry, kind: "archive" });
      continue;
    }
    if (LEFTOVER_EXTENSIONS.has(ext) || LEFTOVER_NAMES.has(base) || base.endsWith("~") || lower.includes("__macosx/") || /-autosave\.[a-z0-9]+$/.test(base)) {
      flagged.push({ ...entry, kind: "leftover" });
      continue;
    }
    if (!lower.startsWith(root)) {
      flagged.push({ ...entry, kind: "unreferenced" });
      continue;
    }
    const relative = lower.slice(root.length);
    const referenced = isReferenced(relative, references);
    if (relative.includes("/")) {
      // osu! reads only the skin's root for its named elements; a subfolder
      // file is loaded only when skin.ini points at it.
      if (!referenced && !isLazerFile(relative)) flagged.push({ ...entry, kind: "unreferenced" });
      continue;
    }
    if (referenced) continue;
    const stem = stripExtension(relative);
    if (COPY_NAME.test(stem.replace(/@2x$/, ""))) flagged.push({ ...entry, kind: "copy" });
  }
  flagged.sort((a, b) => b.bytes - a.bytes);
  return { files: flagged, bytes: flagged.reduce((total, entry) => total + entry.bytes, 0) };
}

// Every value in skin.ini that could name a file: "NoteImage0: 7K\note",
// "ScorePrefix: fonts/score", "Hit300: judge/300". Keys are not checked, so a
// new or misspelled key still protects the file it names.
function collectReferences(ini: string): Set<string> {
  const references = new Set<string>();
  for (const line of ini.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("[")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const value = cleanReference(trimmed.slice(colon + 1));
    if (/[a-z]/i.test(value)) references.add(value);
  }
  return references;
}

// Some skin.ini values carry the @2x themselves ("mania-stage-Left4k@2x");
// osu! still finds the file, so the marker is dropped on both sides.
function cleanReference(value: string): string {
  return stripExtension(normalizePath(value.trim().replace(/^["']|["']$/g, "")).toLowerCase().replace(/^\/+|\/+$/g, "")).replace(/@2x/g, "");
}

// A file is referenced when its path, minus extension and @2x, is a named
// value or one of its frames/glyphs: "7k/note" covers 7k/note.png,
// 7k/note@2x.png, 7k/note-0.png and 7k/note1.png, and a font prefix covers
// its digits plus score-comma, -dot, -percent and -x. 7k/note-old does not.
function isReferenced(relative: string, references: Set<string>): boolean {
  const stem = stripExtension(relative).replace(/@2x/g, "");
  if (references.has(stem)) return true;
  for (const reference of references) {
    if (!stem.startsWith(reference)) continue;
    const rest = stem.slice(reference.length);
    if (/^-?\d+$/.test(rest) || /^-(comma|dot|percent|x)$/.test(rest)) return true;
  }
  return false;
}

function isLazerFile(relative: string): boolean {
  return relative.endsWith(".json");
}

function jsonStrings(text: string): string[] {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1].replace(/\\\\/g, "/"));
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "");
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extension(base: string): string {
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

function stripExtension(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash + 1 ? path.slice(0, dot) : path;
}

function depth(path: string): number {
  return path.split("/").length;
}

// The same check over an opened archive: compressed sizes from the zip's
// central directory, and the text of every skin.ini and .json in it.
export async function findSkinDeadWeightInZip(zip: JSZip): Promise<SkinDeadWeight> {
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  const textFiles: Record<string, string> = {};
  for (const entry of files) {
    const lower = entry.name.toLowerCase();
    if (lower.endsWith("skin.ini") || lower.endsWith(".json")) textFiles[normalizePath(entry.name)] = await entry.async("string");
  }
  return findSkinDeadWeight(
    files.map((entry) => {
      const data = (entry as unknown as { _data?: { compressedSize?: number; uncompressedSize?: number } })._data;
      return { path: entry.name, bytes: data?.compressedSize ?? data?.uncompressedSize ?? 0 };
    }),
    textFiles,
  );
}

// A copy of the .osk without the flagged files, under the same name. The
// archive passed in is left as it was.
export async function trimSkinArchive(zip: JSZip, deadWeight: SkinDeadWeight, file: File): Promise<File> {
  const dead = new Set(deadWeight.files.map((entry) => entry.path));
  const trimmed = new JSZip();
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || dead.has(normalizePath(entry.name))) continue;
    trimmed.file(entry.name, await entry.async("uint8array"), { date: entry.date, binary: true });
  }
  const blob = await trimmed.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return new File([blob], file.name, { type: file.type || "application/octet-stream" });
}

// Programs, scripts, shortcuts and archives inside the archive. The backend
// refuses an .osk holding any of them (backend/src/skins/blocked-files.ts, the
// list this copies), so the form strips them before anything else reads the
// file. osu! loads none of them.
const BLOCKED_EXTENSIONS = new Set([
  "exe", "dll", "scr", "com", "pif", "cpl", "msi", "msp", "msix", "appx", "sys", "drv", "ocx",
  "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "reg", "lnk", "url", "scf", "jar",
  "sh", "command", "app", "dmg", "pkg", "deb", "rpm", "apk", "appimage", "iso", "vhd", "vhdx",
  "osk", "olz", "osz", "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "cab",
]);

export function isBlockedSkinFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.endsWith("/")) return false;
  if (/(^|\/)[^/]+\.app\//i.test(normalized)) return true;
  const base = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot > 0 && BLOCKED_EXTENSIONS.has(base.slice(dot + 1));
}

// The picked .osk without its blocked files, and the names it left out. An
// archive with none comes back as the same File.
export async function stripBlockedSkinFiles(file: File): Promise<{ file: File; removed: string[] }> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const blocked = Object.values(zip.files).filter((entry) => !entry.dir && isBlockedSkinFile(entry.name));
  if (blocked.length === 0) return { file, removed: [] };
  const deadWeight: SkinDeadWeight = {
    files: blocked.map((entry) => ({ path: normalizePath(entry.name), bytes: 0, kind: "leftover" })),
    bytes: 0,
  };
  const removed = blocked.map((entry) => basename(normalizePath(entry.name)));
  return { file: await trimSkinArchive(zip, deadWeight, file), removed };
}
