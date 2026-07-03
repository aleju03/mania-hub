// Categorizes the files inside a .osk by osu!'s well-known asset names so the
// skin page can show what ships in the archive (stage pieces, pause overlay,
// alternate note sets, sounds) without any server-side processing. Pure
// functions over the zip listing; extraction stays in the component.

export type SkinAssetKind = "image" | "sound";

export interface SkinArchiveFile {
  // Normalized zip path (forward slashes, no leading ./).
  path: string;
  size: number;
}

export interface SkinAssetEntry {
  // Display name: basename without extension, @2x marker, or frame number.
  name: string;
  kind: SkinAssetKind;
  // All zip paths belonging to this entry; animations collapse their frames
  // (mania-hit300-0/-1/... ) into one entry, @2x wins over the SD copy.
  paths: string[];
  // The path to actually show/play: the entry's largest file, so a blank 1x1
  // placeholder still never hides the real animation art next to it.
  primaryPath: string;
  frameCount: number;
  totalBytes: number;
}

export interface SkinAssetGroup {
  key: string;
  title: string;
  entries: SkinAssetEntry[];
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg"]);
const SOUND_EXTENSIONS = new Set(["wav", "ogg", "mp3"]);

interface CategoryRule {
  key: string;
  title: string;
  test: (base: string, path: string) => boolean;
}

// Order matters: first match wins. Names follow the osu! wiki's skinnable
// file lists; the catch-alls at the end keep unknown art discoverable.
const CATEGORY_RULES: CategoryRule[] = [
  { key: "notes", title: "Notes", test: (base) => /^mania-note/.test(base) },
  { key: "keys", title: "Keys", test: (base) => /^mania-key/.test(base) },
  { key: "stage", title: "Stage", test: (base, path) => /^mania-stage/.test(base) || /stage/.test(base) || /stage/.test(path) },
  { key: "judgements", title: "Judgements", test: (base, path) => /^mania-hit(0|50|100|200|300|300g)$/.test(base) || /judgement/.test(path) },
  {
    key: "gameplay",
    title: "Gameplay screens",
    test: (base) =>
      /^(pause-|fail-|play-(skip|warningarrow|unranked)|section-(pass|fail)|count(down|1|2|3|go)?$|go$|ready$|arrow-|inputoverlay-|spinner-)/.test(base)
      || base === "pause-overlay" || base === "fail-background",
  },
  {
    key: "hud",
    title: "HUD and fonts",
    test: (base) => /^(scorebar-|score-|combo-|default-|hit(0|50|100|200|300)|ranking-|selection-mode)/.test(base),
  },
  { key: "lighting", title: "Lighting", test: (base) => /^lighting/.test(base) },
];

const OTHER_IMAGES: CategoryRule = {
  key: "other",
  title: "Other images",
  test: () => true,
};

export function normalizeSkinArchivePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function extensionOf(path: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return match ? match[1].toLowerCase() : "";
}

function basenameOf(path: string): string {
  const normalized = normalizeSkinArchivePath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

// Entry identity: directory + basename minus extension, @2x, and a trailing
// animation frame index. "aleju/inst@2x.png" and "aleju/inst.png" merge, as
// do "mania-hit300-0.png" ... "mania-hit300-15.png".
interface ParsedName {
  entryKey: string;
  displayName: string;
  frame: number | null;
  scaled: boolean;
}

function parseAssetName(path: string): ParsedName {
  const normalized = normalizeSkinArchivePath(path).toLowerCase();
  const directory = normalized.slice(0, normalized.lastIndexOf("/") + 1);
  let base = basenameOf(normalized).replace(/\.[a-z0-9]+$/, "");
  const scaled = /@2x$/.test(base);
  if (scaled) base = base.slice(0, -3);
  let frame: number | null = null;
  const frameMatch = /^(.*?)-(\d{1,3})$/.exec(base);
  // Frame suffixes only make sense on animatable art; treat "-0"/"-12" as a
  // frame index but keep single-image names like "hit300" intact. Font digits
  // ("score-5", "combo-3") are separate glyphs, not animation frames.
  if (frameMatch && !/^(score|combo|default|fonts?)/.test(frameMatch[1])) {
    base = frameMatch[1];
    frame = Number(frameMatch[2]);
  }
  return { entryKey: `${directory}${base}`, displayName: base, frame, scaled };
}

export function buildSkinAssetGroups(files: SkinArchiveFile[]): SkinAssetGroup[] {
  interface Accumulator {
    name: string;
    kind: SkinAssetKind;
    totalBytes: number;
    frames: Map<number, { path: string; scaled: boolean }>;
    still: { path: string; scaled: boolean } | null;
    // Biggest file of the entry: skins ship 1x1 transparent stills next to
    // real animation frames (blanked mania-hit300.png + mania-hit300-0.png),
    // so the largest variant is the representative image worth showing.
    largest: { path: string; size: number } | null;
    paths: string[];
  }
  const accumulators = new Map<string, Accumulator>();

  for (const file of files) {
    const path = normalizeSkinArchivePath(file.path);
    const ext = extensionOf(path);
    const kind: SkinAssetKind | null = IMAGE_EXTENSIONS.has(ext) ? "image" : SOUND_EXTENSIONS.has(ext) ? "sound" : null;
    if (!kind || file.size <= 0) continue;
    const parsed = parseAssetName(path);
    const key = `${kind}:${parsed.entryKey}`;
    let entry = accumulators.get(key);
    if (!entry) {
      entry = { name: parsed.displayName, kind, totalBytes: 0, frames: new Map(), still: null, largest: null, paths: [] };
      accumulators.set(key, entry);
    }
    entry.totalBytes += file.size;
    entry.paths.push(path);
    if (!entry.largest || file.size > entry.largest.size) entry.largest = { path, size: file.size };
    if (parsed.frame != null) {
      const existing = entry.frames.get(parsed.frame);
      if (!existing || (parsed.scaled && !existing.scaled)) entry.frames.set(parsed.frame, { path, scaled: parsed.scaled });
    } else if (!entry.still || (parsed.scaled && !entry.still.scaled)) {
      entry.still = { path, scaled: parsed.scaled };
    }
  }

  const grouped = new Map<string, SkinAssetEntry[]>();
  for (const [key, acc] of accumulators) {
    const frameNumbers = [...acc.frames.keys()].sort((a, b) => a - b);
    if (!acc.largest) continue;
    const entry: SkinAssetEntry = {
      name: acc.name,
      kind: acc.kind,
      paths: acc.paths,
      primaryPath: acc.largest.path,
      frameCount: frameNumbers.length > 0 ? frameNumbers.length : 1,
      totalBytes: acc.totalBytes,
    };
    const entryPath = key.slice(key.indexOf(":") + 1);
    const rule = acc.kind === "sound"
      ? { key: "sounds", title: "Sounds" }
      : CATEGORY_RULES.find((candidate) => candidate.test(acc.name, entryPath)) ?? OTHER_IMAGES;
    const list = grouped.get(rule.key) ?? [];
    list.push(entry);
    grouped.set(rule.key, list);
  }

  const order = [...CATEGORY_RULES.map((rule) => rule), OTHER_IMAGES, { key: "sounds", title: "Sounds", test: () => false }];
  const groups: SkinAssetGroup[] = [];
  for (const rule of order) {
    const entries = grouped.get(rule.key);
    if (!entries || entries.length === 0) continue;
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.primaryPath.localeCompare(b.primaryPath));
    groups.push({ key: rule.key, title: rule.title, entries });
  }
  return groups;
}

// Pulls the stage/overlay references straight out of skin.ini's [Mania]
// blocks so pieces with custom paths (StageBottom: 4k\stagehint) surface even
// when their filenames say nothing. Commented-out lines ("//StageBottom: ...")
// are skipped like the game does.
export interface SkinIniStageReference {
  keys: number | null;
  property: string;
  reference: string;
}

const STAGE_PROPERTIES = new Set([
  "stageleft",
  "stageright",
  "stagebottom",
  "stagehint",
  "stagelight",
  "warningarrow",
]);

export function extractSkinIniStageReferences(iniContent: string): SkinIniStageReference[] {
  const references: SkinIniStageReference[] = [];
  let inMania = false;
  let currentKeys: number | null = null;
  for (const rawLine of iniContent.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const commentIndex = rawLine.indexOf("//");
    const line = (commentIndex >= 0 ? rawLine.slice(0, commentIndex) : rawLine).trim();
    if (!line) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      inMania = sectionMatch[1].trim() === "Mania";
      currentKeys = null;
      continue;
    }
    if (!inMania) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key || !value) continue;
    if (key === "Keys") {
      const parsed = Number(value);
      currentKeys = Number.isInteger(parsed) ? parsed : null;
      continue;
    }
    if (STAGE_PROPERTIES.has(key.toLowerCase())) {
      references.push({ keys: currentKeys, property: key, reference: normalizeSkinArchivePath(value) });
    }
  }
  return references;
}
