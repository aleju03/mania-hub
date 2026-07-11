import JSZip from "jszip";

import {
  DEFAULT_REPLAY_SKIN_SETTINGS,
  EMPTY_REPLAY_SKIN_ASSETS,
  REPLAY_SKIN_MAX_COLUMNS,
  getReplaySkinProfile,
  normalizeReplaySkinSettings,
  osuManiaStagePositionToReplayPosition,
} from "./replay-skin";
import type {
  ReplaySkinColumnAssets,
  ReplaySkinImageAsset,
  ReplaySkinKeymodeAssets,
  ReplaySkinKeymodeProfile,
  ReplaySkinSettings,
} from "./replay-skin";

interface SkinIniData {
  name: string | null;
  author: string | null;
  fonts: Record<string, string>;
  mania: Array<Record<string, string>>;
}

interface ResolvedZipAsset {
  file: JSZip.JSZipObject;
  path: string;
  mime: string;
  scale: number;
}

export interface ReplaySkinImportSummary {
  name: string;
  author: string | null;
  keymodes: number[];
  selectedKeyCount: number | null;
  noteAssets: number;
  receptorAssets: number;
  judgementAssets: number;
  comboDigits: number;
  soundAssets: number;
}

export interface ReplaySkinImportResult {
  settings: ReplaySkinSettings;
  summary: ReplaySkinImportSummary;
  // Hitsound samples keyed by lowercased name without extension, only
  // populated when options.extractSounds is set.
  sounds: Record<string, ArrayBuffer>;
}

// The gameplay samples the replay viewer can play. Skins ship many more
// sounds (menu clicks, applause, ...) that are irrelevant here.
const SKIN_SOUND_NAMES = [
  ...["normal", "soft", "drum"].flatMap((bank) =>
    ["hitnormal", "hitwhistle", "hitfinish", "hitclap"].map((name) => `${bank}-${name}`),
  ),
  "combobreak",
];
const SKIN_SOUND_EXTENSIONS = ["wav", "ogg", "mp3"];
const MAX_SKIN_SOUND_BYTES = 1.5 * 1024 * 1024;

export async function importReplaySkinFromOsk(
  file: File,
  options: {
    targetKeyCount: number;
    baseSettings?: ReplaySkinSettings;
    extractSounds?: boolean;
    // Parse progress over the asset references the skin.ini declares (the
    // slow part is extracting and decoding each image out of the zip).
    onProgress?: (done: number, total: number) => void;
  },
): Promise<ReplaySkinImportResult> {
  const zip = await JSZip.loadAsync(file);
  const skinIni = await readSkinIni(zip);
  if (!skinIni) throw new Error("No skin.ini was found in this .osk file.");

  const parsed = parseSkinIni(skinIni);
  const baseSettings = normalizeReplaySkinSettings(options.baseSettings ?? DEFAULT_REPLAY_SKIN_SETTINGS);
  let nextSettings = normalizeReplaySkinSettings({
    ...baseSettings,
    keymodeProfiles: { ...baseSettings.keymodeProfiles },
  });

  const lookup = buildZipLookup(zip);
  const assetCache = new Map<string, Promise<ReplaySkinImageAsset | undefined>>();
  const targetKeyCount = Math.max(1, Math.min(REPLAY_SKIN_MAX_COLUMNS, Math.round(options.targetKeyCount)));
  const maniaBlocks = parsed.mania
    .map((block) => ({ block, keys: parseInteger(block.Keys) }))
    .filter((entry): entry is { block: Record<string, string>; keys: number } =>
      entry.keys != null && entry.keys >= 1 && entry.keys <= REPLAY_SKIN_MAX_COLUMNS,
    );

  if (maniaBlocks.length === 0) {
    throw new Error("No [Mania] section with a valid Keys value was found.");
  }

  let selectedBlock = maniaBlocks.find((entry) => entry.keys === targetKeyCount) ?? maniaBlocks[0];
  const keymodeProfiles: Record<string, ReplaySkinKeymodeProfile> = { ...nextSettings.keymodeProfiles };
  let noteAssets = 0;
  let receptorAssets = 0;
  let judgementAssets = 0;
  let comboDigits = 0;

  // One tick per resolveAssetReference call; undefined references resolve
  // instantly, so the bar sprints through them and crawls on real decodes.
  const totalReferences = maniaBlocks.reduce((sum, { block, keys }) => {
    const comboPrefix = block.FontCombo || parsed.fonts.ComboPrefix || "";
    return sum + keys * 6 + 6 + (comboPrefix ? 11 : 0);
  }, 0);
  let doneReferences = 0;
  const onTick = options.onProgress
    ? () => options.onProgress?.((doneReferences += 1), totalReferences)
    : undefined;
  options.onProgress?.(0, totalReferences);

  for (const { block, keys } of maniaBlocks) {
    const imported = await buildProfileFromManiaBlock({
      zip,
      lookup,
      assetCache,
      block,
      fonts: parsed.fonts,
      baseProfile: getReplaySkinProfile(nextSettings, keys),
      keys,
      onTick,
    });
    keymodeProfiles[String(keys)] = imported.profile;
    noteAssets += imported.noteAssets;
    receptorAssets += imported.receptorAssets;
    judgementAssets += imported.judgementAssets;
    comboDigits += imported.comboDigits;
  }

  const selectedProfile = keymodeProfiles[String(selectedBlock.keys)];
  const selectedBlockSettings = settingsFromManiaBlock(selectedBlock.block);
  nextSettings = normalizeReplaySkinSettings({
    ...nextSettings,
    ...selectedBlockSettings,
    // The renderer only draws imported note/receptor art under the "bars"
    // style (circles/arrows are the synthetic shape styles), so a skin that
    // ships any assets must switch to it or it renders as flat shapes.
    style: hasAnyImportedAssets(selectedProfile.assets) ? "bars" : nextSettings.style,
    tapColor: selectedProfile.tapColor,
    tapColors: selectedProfile.tapColors,
    lnHeadColor: selectedProfile.lnHeadColor,
    lnHeadColors: selectedProfile.lnHeadColors,
    lnBodyColor: parseColor(selectedBlock.block.ColourHold) ?? nextSettings.lnBodyColor,
    columnWidth: selectedProfile.columnWidth,
    columnSpacing: selectedProfile.columnSpacing,
    noteHeightScale: selectedProfile.noteHeightScale,
    keymodeProfiles,
    version: 2,
  });

  const sounds = options.extractSounds ? await extractSkinSounds(lookup) : {};

  return {
    settings: nextSettings,
    summary: {
      name: parsed.name ?? stripExtension(file.name),
      author: parsed.author,
      keymodes: maniaBlocks.map((entry) => entry.keys),
      selectedKeyCount: selectedBlock.keys,
      noteAssets,
      receptorAssets,
      judgementAssets,
      comboDigits,
      soundAssets: Object.keys(sounds).length,
    },
    sounds,
  };
}

export interface ReplaySkinSoundsImportResult {
  name: string;
  sounds: Record<string, ArrayBuffer>;
}

// Sounds-only import used by the Audio tab: pulls the gameplay samples out of
// a .osk without touching the visual skin settings. skin.ini is optional here,
// it is only read for the skin's display name.
export async function importReplaySkinSoundsFromOsk(file: File): Promise<ReplaySkinSoundsImportResult> {
  const zip = await JSZip.loadAsync(file);
  const skinIni = await readSkinIni(zip);
  const parsed = skinIni ? parseSkinIni(skinIni) : null;
  const sounds = await extractSkinSounds(buildZipLookup(zip));
  return { name: parsed?.name ?? stripExtension(file.name), sounds };
}

async function extractSkinSounds(lookup: Map<string, JSZip.JSZipObject>): Promise<Record<string, ArrayBuffer>> {
  const sounds: Record<string, ArrayBuffer> = {};

  for (const name of SKIN_SOUND_NAMES) {
    for (const ext of SKIN_SOUND_EXTENSIONS) {
      const path = `${name}.${ext}`;
      const file = lookup.get(path)
        ?? [...lookup.entries()].find(([key]) => key.endsWith(`/${path}`))?.[1];
      if (!file) continue;
      try {
        const data = await file.async("arraybuffer");
        // A zero-byte sample is an intentional "silence this sound" override.
        if (data.byteLength > MAX_SKIN_SOUND_BYTES) continue;
        sounds[name] = data;
        break;
      } catch {
        // Skip unreadable entries; the sample falls back to the defaults.
      }
    }
  }

  return sounds;
}

async function readSkinIni(zip: JSZip): Promise<string | null> {
  const file = Object.values(zip.files).find((entry) => {
    const name = normalizeZipPath(entry.name).toLowerCase();
    return !entry.dir && name === "skin.ini";
  }) ?? Object.values(zip.files).find((entry) => {
    const name = normalizeZipPath(entry.name).toLowerCase();
    return !entry.dir && name.endsWith("/skin.ini");
  });
  return file ? file.async("string") : null;
}

function parseSkinIni(content: string): SkinIniData {
  const data: SkinIniData = {
    name: null,
    author: null,
    fonts: {},
    mania: [],
  };
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
    } else if (section === "Fonts") {
      data.fonts[key] = value;
    } else if (section === "Mania" && currentMania) {
      currentMania[key] = value;
    }
  }

  return data;
}

async function buildProfileFromManiaBlock({
  zip,
  lookup,
  assetCache,
  block,
  fonts,
  baseProfile,
  keys,
  onTick,
}: {
  zip: JSZip;
  lookup: Map<string, JSZip.JSZipObject>;
  assetCache: Map<string, Promise<ReplaySkinImageAsset | undefined>>;
  block: Record<string, string>;
  fonts: Record<string, string>;
  baseProfile: ReplaySkinKeymodeProfile;
  keys: number;
  onTick?: () => void;
}): Promise<{
  profile: ReplaySkinKeymodeProfile;
  noteAssets: number;
  receptorAssets: number;
  judgementAssets: number;
  comboDigits: number;
}> {
  const columnWidths = parseNumberList(block.ColumnWidth);
  const columnSpacings = parseNumberList(block.ColumnSpacing);
  // keys+1 boundary lines, outer stage edges included. Absent means stable's
  // default (2-unit lines everywhere); stable also keeps the 2-unit default
  // for boundaries the list does not reach, so pad short lists with 2s.
  const parsedLineWidths = parseNumberList(block.ColumnLineWidth);
  const columnLineWidths = block.ColumnLineWidth != null
    ? Array.from({ length: keys + 1 }, (_, index) => clampInteger(parsedLineWidths[index] ?? 2, 0, 20))
    : [];
  const columnLineColor = parseColorWithAlpha(block.ColourColumnLine) ?? "";
  const judgementLineValue = parseNumber(block.JudgementLine);
  const judgementLine = judgementLineValue == null ? true : judgementLineValue !== 0;
  const columnWidth = clampInteger(columnWidths[0] ?? parseNumber(block.ColumnWidth) ?? baseProfile.columnWidth, 20, 160);
  const columnSpacing = clampInteger(columnSpacings[0] ?? parseNumber(block.ColumnSpacing) ?? baseProfile.columnSpacing, 0, 40);
  const noteHeightScale = clampInteger(
    parseNumber(block.WidthForNoteHeightScale) ?? (columnWidths.length > 0 ? Math.min(...columnWidths) : columnWidth),
    10,
    200,
  );
  // Colour{n} is the column BACKGROUND colour and ColourLight{n} the column
  // light tint — neither is a note colour (skins routinely set them black,
  // which used to paint the flat-fallback notes invisible). Keep the viewer's
  // own palette for the no-note-art fallback instead.
  const tapColors = Array.from({ length: keys }, (_, index) => baseProfile.tapColors[index] ?? "");
  const lnHeadColors = Array.from({ length: keys }, (_, index) => baseProfile.lnHeadColors[index] ?? "");
  const columns: ReplaySkinColumnAssets[] = [];
  let noteAssets = 0;
  let receptorAssets = 0;

  const resolveTracked = async (reference: string | undefined): Promise<ReplaySkinImageAsset | undefined> => {
    const asset = await resolveAssetReference(zip, lookup, assetCache, reference);
    onTick?.();
    return asset;
  };

  for (let col = 0; col < keys; col += 1) {
    const column: ReplaySkinColumnAssets = {};
    // Stable resolves elements the block does not declare (or whose file is
    // missing) from the default filenames — mania-note1/2/S and mania-key1/2/S
    // per the symmetric column layout — so skins that ship default-named art
    // with a bare skin.ini (the o2jam ports especially) still get their notes.
    // Animated variants ship as "-0..N" frames; frame 0 stands in for the
    // static image, same as the Hit* fallback below.
    const suffix = defaultManiaImageSuffix(keys, col);
    const resolveWithDefaults = async (reference: string | undefined, fallback: string): Promise<ReplaySkinImageAsset | undefined> =>
      (await resolveTracked(reference))
        ?? (reference ? await resolveTracked(`${reference}-0`) : undefined)
        ?? (await resolveTracked(fallback))
        ?? (await resolveTracked(`${fallback}-0`));
    const tap = await resolveWithDefaults(block[`NoteImage${col}`], `mania-note${suffix}`);
    const lnHead = await resolveWithDefaults(block[`NoteImage${col}H`], `mania-note${suffix}H`);
    const lnBody = await resolveWithDefaults(block[`NoteImage${col}L`], `mania-note${suffix}L`);
    const lnTail = await resolveWithDefaults(block[`NoteImage${col}T`], `mania-note${suffix}T`);
    const receptor = await resolveWithDefaults(block[`KeyImage${col}`], `mania-key${suffix}`);
    const receptorPressed = await resolveWithDefaults(block[`KeyImage${col}D`], `mania-key${suffix}D`);
    if (tap) column.tap = tap;
    if (lnHead) column.lnHead = lnHead;
    if (lnBody) column.lnBody = lnBody;
    if (lnTail) column.lnTail = lnTail;
    if (receptor) column.receptor = receptor;
    if (receptorPressed) column.receptorPressed = receptorPressed;
    if (tap || lnHead || lnBody || lnTail) noteAssets += [tap, lnHead, lnBody, lnTail].filter(Boolean).length;
    if (receptor || receptorPressed) receptorAssets += [receptor, receptorPressed].filter(Boolean).length;
    columns.push(column);
  }

  const judgements: ReplaySkinKeymodeAssets["judgements"] = {};
  let judgementAssets = 0;
  for (const [skinKey, outputKey] of [
    ["Hit0", "hit0"],
    ["Hit50", "hit50"],
    ["Hit100", "hit100"],
    ["Hit200", "hit200"],
    ["Hit300", "hit300"],
    ["Hit300g", "hit300g"],
  ] as const) {
    // Stable falls back to the default filenames when the block sets no Hit*
    // reference; the animated first frame outranks the static image (skinners
    // often blank the static copy but keep the animation).
    const asset = (await resolveAssetReference(zip, lookup, assetCache, block[skinKey]))
      ?? (await resolveAssetReference(zip, lookup, assetCache, `mania-${outputKey}-0`))
      ?? (await resolveAssetReference(zip, lookup, assetCache, `mania-${outputKey}`));
    onTick?.();
    if (asset) {
      judgements[outputKey] = asset;
      judgementAssets += 1;
    }
  }

  // Stable's [Fonts] ComboPrefix defaults to "score", so skins that ship only
  // score-* digit art still get a combo font.
  const comboPrefix = block.FontCombo || fonts.ComboPrefix || "score";
  const comboOverlap = clampInteger(parseNumber(fonts.ComboOverlap) ?? 0, -80, 80);
  const comboDigitsAssets = comboPrefix
    ? await Promise.all(Array.from({ length: 10 }, (_, digit) =>
        resolveTracked(`${comboPrefix}-${digit}`),
      ))
    : [];
  const comboX = comboPrefix ? await resolveTracked(`${comboPrefix}-x`) : undefined;
  const comboDigits = comboDigitsAssets.filter(Boolean).length;
  const combo = comboDigits > 0 || comboX
    ? {
        prefix: comboPrefix,
        overlap: comboOverlap,
        digits: Array.from({ length: 10 }, (_, index) => comboDigitsAssets[index] ?? null),
        x: comboX,
      }
    : null;

  return {
    profile: {
      ...baseProfile,
      tapColor: firstColor(tapColors) ?? baseProfile.tapColor,
      tapColors,
      lnHeadColor: firstColor(lnHeadColors) ?? baseProfile.lnHeadColor,
      lnHeadColors,
      columnWidth,
      columnSpacing,
      columnWidths,
      columnSpacings,
      columnLineWidths,
      columnLineColor,
      judgementLine,
      noteHeightScale,
      assets: {
        columns,
        judgements,
        combo,
      },
    },
    noteAssets,
    receptorAssets,
    judgementAssets,
    comboDigits,
  };
}

// Stable's default column layout: alternating 1/2 mirrored from the outer
// edges in, with the middle column of odd keymodes as the special "S" lane
// (mania-noteS / mania-keyS). 4K = 1,2,2,1; 7K = 1,2,1,S,1,2,1.
function defaultManiaImageSuffix(keys: number, column: number): "1" | "2" | "S" {
  if (keys % 2 === 1 && column === Math.floor(keys / 2)) return "S";
  const mirrored = column < keys / 2 ? column : keys - 1 - column;
  return mirrored % 2 === 0 ? "1" : "2";
}

function settingsFromManiaBlock(block: Record<string, string>): Partial<ReplaySkinSettings> {
  const patch: Partial<ReplaySkinSettings> = {};
  const hitPosition = parseNumber(block.HitPosition);
  const scorePosition = parseNumber(block.ScorePosition);
  const comboPosition = parseNumber(block.ComboPosition);
  if (hitPosition != null) patch.hitPosition = osuManiaStagePositionToReplayPosition(hitPosition);
  if (scorePosition != null) patch.scorePosition = osuManiaStagePositionToReplayPosition(scorePosition);
  if (comboPosition != null) patch.comboPosition = osuManiaStagePositionToReplayPosition(comboPosition);
  if (block.UpsideDown === "1") patch.upscroll = true;
  if (block.UpsideDown === "0") patch.upscroll = false;
  return patch;
}

function buildZipLookup(zip: JSZip): Map<string, JSZip.JSZipObject> {
  const lookup = new Map<string, JSZip.JSZipObject>();
  for (const file of Object.values(zip.files)) {
    if (file.dir) continue;
    lookup.set(normalizeZipPath(file.name).toLowerCase(), file);
  }
  return lookup;
}

async function resolveAssetReference(
  zip: JSZip,
  lookup: Map<string, JSZip.JSZipObject>,
  cache: Map<string, Promise<ReplaySkinImageAsset | undefined>>,
  reference: string | undefined,
): Promise<ReplaySkinImageAsset | undefined> {
  const resolved = resolveZipAsset(lookup, reference);
  if (!resolved) return undefined;
  const cacheKey = normalizeZipPath(resolved.path).toLowerCase();
  let promise = cache.get(cacheKey);
  if (!promise) {
    promise = readImageAsset(zip, resolved);
    cache.set(cacheKey, promise);
  }
  return promise;
}

function resolveZipAsset(lookup: Map<string, JSZip.JSZipObject>, reference: string | undefined): ResolvedZipAsset | null {
  const clean = cleanReference(reference);
  if (!clean) return null;
  const candidates = buildAssetCandidates(clean);
  for (const candidate of candidates) {
    const file = lookup.get(candidate.path.toLowerCase());
    if (file) return { file, path: file.name, mime: candidate.mime, scale: candidate.scale };
  }
  return null;
}

function buildAssetCandidates(reference: string): Array<{ path: string; mime: string; scale: number }> {
  const extensionMatch = /\.([a-z0-9]+)$/i.exec(reference);
  const extensions = extensionMatch ? [extensionMatch[1].toLowerCase()] : ["png", "jpg", "jpeg"];
  const base = extensionMatch ? reference.slice(0, -extensionMatch[0].length) : reference;
  const alreadyScaled = /@2x$/i.test(base);
  const candidates: Array<{ path: string; mime: string; scale: number }> = [];
  for (const ext of extensions) {
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
    if (!alreadyScaled) candidates.push({ path: `${base}@2x.${ext}`, mime, scale: 2 });
    candidates.push({ path: `${base}.${ext}`, mime, scale: alreadyScaled ? 2 : 1 });
  }
  return candidates.map((candidate) => ({
    ...candidate,
    path: normalizeZipPath(candidate.path),
  }));
}

async function readImageAsset(_zip: JSZip, resolved: ResolvedZipAsset): Promise<ReplaySkinImageAsset | undefined> {
  const data = await resolved.file.async("base64");
  if (!data) return undefined;
  let src = `data:${resolved.mime};base64,${data}`;
  let size: { width: number; height: number } | null = null;
  // Some skins ship TIFFs renamed to .png (Percy-style LN bodies especially;
  // osu!stable decodes by content, so they work in game). Browsers cannot
  // decode TIFF at all, so transcode the common Photoshop flavour to PNG here.
  // "SUkq" / "TU0AK" are the base64 spellings of the II*/MM* TIFF magic.
  if (data.startsWith("SUkq") || data.startsWith("TU0AK")) {
    const decoded = decodeUncompressedTiff(base64ToBytes(data));
    const transcoded = decoded ? rgbaToPngDataUrl(decoded) : null;
    if (decoded && transcoded) {
      src = transcoded;
      size = { width: decoded.width, height: decoded.height };
    }
  }
  if (!size) size = await readImageSize(src).catch(() => null);
  return {
    name: basename(resolved.path),
    path: normalizeZipPath(resolved.path),
    src,
    width: size?.width,
    height: size?.height,
    scale: resolved.scale,
  };
}

interface DecodedTiff {
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

// Minimal TIFF reader for the skin case above: 8-bit RGB/RGBA, chunky layout,
// uncompressed strips (what Photoshop writes by default). Anything fancier
// returns null and the asset stays as-is.
export function decodeUncompressedTiff(bytes: Uint8Array): DecodedTiff | null {
  if (bytes.length < 8) return null;
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  if (!little && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, little) !== 42) return null;

  const readTag = (entry: number): number[] | null => {
    const type = view.getUint16(entry + 2, little);
    const count = view.getUint32(entry + 4, little);
    const sizes: Record<number, number> = { 1: 1, 3: 2, 4: 4 };
    const size = sizes[type];
    if (!size || count === 0 || count > 65536) return null;
    const total = size * count;
    const at = total <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
    if (at + total > bytes.length) return null;
    const values: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const offset = at + i * size;
      values.push(size === 1 ? view.getUint8(offset) : size === 2 ? view.getUint16(offset, little) : view.getUint32(offset, little));
    }
    return values;
  };

  const ifd = view.getUint32(4, little);
  if (ifd + 2 > bytes.length) return null;
  const entryCount = view.getUint16(ifd, little);
  const tags = new Map<number, number[]>();
  for (let i = 0; i < entryCount; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > bytes.length) return null;
    const values = readTag(entry);
    if (values) tags.set(view.getUint16(entry, little), values);
  }

  const width = tags.get(256)?.[0] ?? 0;
  const height = tags.get(257)?.[0] ?? 0;
  const bits = tags.get(258) ?? [];
  const compression = tags.get(259)?.[0] ?? 1;
  const photometric = tags.get(262)?.[0] ?? 2;
  const samples = tags.get(277)?.[0] ?? bits.length;
  const planar = tags.get(284)?.[0] ?? 1;
  const premultiplied = tags.get(338)?.[0] === 1;
  const stripOffsets = tags.get(273) ?? [];
  const stripCounts = tags.get(279) ?? [];
  const rowsPerStrip = tags.get(278)?.[0] ?? height;

  if (compression !== 1 || photometric !== 2 || planar !== 1) return null;
  if ((samples !== 3 && samples !== 4) || bits.some((b) => b !== 8)) return null;
  if (width <= 0 || height <= 0 || width > 65000 || height > 65000 || width * height > 50_000_000) return null;
  if (stripOffsets.length === 0 || stripOffsets.length !== stripCounts.length) return null;

  const rgba = new Uint8ClampedArray(width * height * 4);
  const bytesPerRow = width * samples;
  let row = 0;
  for (let strip = 0; strip < stripOffsets.length && row < height; strip += 1) {
    const start = stripOffsets[strip];
    const available = Math.min(stripCounts[strip], bytes.length - start);
    const rows = Math.min(Math.floor(available / bytesPerRow), rowsPerStrip, height - row);
    if (rows <= 0) return null;
    for (let r = 0; r < rows; r += 1) {
      let source = start + r * bytesPerRow;
      let target = (row + r) * width * 4;
      for (let x = 0; x < width; x += 1) {
        rgba[target] = bytes[source];
        rgba[target + 1] = bytes[source + 1];
        rgba[target + 2] = bytes[source + 2];
        rgba[target + 3] = samples === 4 ? bytes[source + 3] : 255;
        source += samples;
        target += 4;
      }
    }
    row += rows;
  }
  if (row < height) return null;

  if (premultiplied && samples === 4) {
    for (let i = 0; i < rgba.length; i += 4) {
      const alpha = rgba[i + 3];
      if (alpha > 0 && alpha < 255) {
        rgba[i] = Math.min(255, Math.round((rgba[i] * 255) / alpha));
        rgba[i + 1] = Math.min(255, Math.round((rgba[i + 1] * 255) / alpha));
        rgba[i + 2] = Math.min(255, Math.round((rgba[i + 2] * 255) / alpha));
      }
    }
  }

  return { width, height, rgba };
}

function rgbaToPngDataUrl(decoded: DecodedTiff): string | null {
  if (typeof document === "undefined") return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.putImageData(new ImageData(decoded.rgba, decoded.width, decoded.height), 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function readImageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    if (typeof Image === "undefined") {
      reject(new Error("Image decoding is not available."));
      return;
    }
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
    img.onerror = () => reject(new Error("Failed to decode image."));
    img.src = src;
  });
}

function cleanReference(reference: string | undefined): string | null {
  if (!reference) return null;
  const clean = normalizeZipPath(reference.trim().replace(/^["']|["']$/g, ""));
  if (!clean || clean.includes("..")) return null;
  return clean;
}

function normalizeZipPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function parseNumber(value: string | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseInteger(value: string | undefined): number | null {
  const parsed = parseNumber(value);
  return parsed == null ? null : Math.round(parsed);
}

function parseNumberList(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => Math.round(Number(part.trim())))
    .filter((part) => Number.isFinite(part));
}

function parseColor(value: string | undefined): string | null {
  if (!value) return null;
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
  return `#${parts.slice(0, 3).map((part) => clampInteger(part, 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

// Like parseColor but keeps a non-opaque alpha channel as #rrggbbaa; column
// lines commonly rely on skin.ini alpha (e.g. "255,255,255,150").
function parseColorWithAlpha(value: string | undefined): string | null {
  const rgb = parseColor(value);
  if (!rgb || !value) return rgb;
  const alphaPart = Number(value.split(",")[3]?.trim());
  if (!Number.isFinite(alphaPart)) return rgb;
  const alpha = clampInteger(alphaPart, 0, 255);
  return alpha >= 255 ? rgb : `${rgb}${alpha.toString(16).padStart(2, "0")}`;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function firstColor(colors: string[]): string | null {
  return colors.find((color) => color) ?? null;
}

function hasAnyImportedAssets(assets: ReplaySkinKeymodeAssets | undefined): boolean {
  const normalized = assets ?? EMPTY_REPLAY_SKIN_ASSETS;
  return normalized.columns.some((column) => Object.values(column).some(Boolean)) ||
    Object.values(normalized.judgements).some(Boolean) ||
    Boolean(normalized.combo);
}

function basename(path: string): string {
  const normalized = normalizeZipPath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function stripExtension(path: string): string {
  const name = basename(path);
  return name.replace(/\.[^.]+$/, "");
}
