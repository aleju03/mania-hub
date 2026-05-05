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
  keymodes: number[];
  selectedKeyCount: number | null;
  noteAssets: number;
  receptorAssets: number;
  judgementAssets: number;
  comboDigits: number;
}

export interface ReplaySkinImportResult {
  settings: ReplaySkinSettings;
  summary: ReplaySkinImportSummary;
}

export async function importReplaySkinFromOsk(
  file: File,
  options: {
    targetKeyCount: number;
    baseSettings?: ReplaySkinSettings;
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

  for (const { block, keys } of maniaBlocks) {
    const imported = await buildProfileFromManiaBlock({
      zip,
      lookup,
      assetCache,
      block,
      fonts: parsed.fonts,
      baseProfile: getReplaySkinProfile(nextSettings, keys),
      keys,
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
    style: hasAnyImportedAssets(selectedProfile.assets) ? nextSettings.style : nextSettings.style,
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

  return {
    settings: nextSettings,
    summary: {
      name: parsed.name ?? stripExtension(file.name),
      keymodes: maniaBlocks.map((entry) => entry.keys),
      selectedKeyCount: selectedBlock.keys,
      noteAssets,
      receptorAssets,
      judgementAssets,
      comboDigits,
    },
  };
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
}: {
  zip: JSZip;
  lookup: Map<string, JSZip.JSZipObject>;
  assetCache: Map<string, Promise<ReplaySkinImageAsset | undefined>>;
  block: Record<string, string>;
  fonts: Record<string, string>;
  baseProfile: ReplaySkinKeymodeProfile;
  keys: number;
}): Promise<{
  profile: ReplaySkinKeymodeProfile;
  noteAssets: number;
  receptorAssets: number;
  judgementAssets: number;
  comboDigits: number;
}> {
  const columnWidths = parseNumberList(block.ColumnWidth);
  const columnSpacings = parseNumberList(block.ColumnSpacing);
  const columnWidth = clampInteger(columnWidths[0] ?? parseNumber(block.ColumnWidth) ?? baseProfile.columnWidth, 20, 160);
  const columnSpacing = clampInteger(columnSpacings[0] ?? parseNumber(block.ColumnSpacing) ?? baseProfile.columnSpacing, 0, 40);
  const noteHeightScale = clampInteger(
    parseNumber(block.WidthForNoteHeightScale) ?? (columnWidths.length > 0 ? Math.min(...columnWidths) : columnWidth),
    10,
    200,
  );
  const tapColors = Array.from({ length: keys }, (_, index) =>
    parseColor(block[`Colour${index + 1}`]) ?? baseProfile.tapColors[index] ?? "",
  );
  const lnHeadColors = Array.from({ length: keys }, (_, index) =>
    parseColor(block[`ColourLight${index + 1}`]) ?? baseProfile.lnHeadColors[index] ?? "",
  );
  const columns: ReplaySkinColumnAssets[] = [];
  let noteAssets = 0;
  let receptorAssets = 0;

  for (let col = 0; col < keys; col += 1) {
    const column: ReplaySkinColumnAssets = {};
    const tap = await resolveAssetReference(zip, lookup, assetCache, block[`NoteImage${col}`]);
    const lnHead = await resolveAssetReference(zip, lookup, assetCache, block[`NoteImage${col}H`]);
    const lnBody = await resolveAssetReference(zip, lookup, assetCache, block[`NoteImage${col}L`]);
    const lnTail = await resolveAssetReference(zip, lookup, assetCache, block[`NoteImage${col}T`]);
    const receptor = await resolveAssetReference(zip, lookup, assetCache, block[`KeyImage${col}`]);
    const receptorPressed = await resolveAssetReference(zip, lookup, assetCache, block[`KeyImage${col}D`]);
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
    const asset = await resolveAssetReference(zip, lookup, assetCache, block[skinKey]);
    if (asset) {
      judgements[outputKey] = asset;
      judgementAssets += 1;
    }
  }

  const comboPrefix = block.FontCombo || fonts.ComboPrefix || "";
  const comboOverlap = clampInteger(parseNumber(fonts.ComboOverlap) ?? 0, -80, 80);
  const comboDigitsAssets = comboPrefix
    ? await Promise.all(Array.from({ length: 10 }, (_, digit) =>
        resolveAssetReference(zip, lookup, assetCache, `${comboPrefix}-${digit}`),
      ))
    : [];
  const comboX = comboPrefix ? await resolveAssetReference(zip, lookup, assetCache, `${comboPrefix}-x`) : undefined;
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
  if (block.KeysUnderNotes === "1") patch.keysUnderNotes = true;
  if (block.KeysUnderNotes === "0") patch.keysUnderNotes = false;
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
  const src = `data:${resolved.mime};base64,${data}`;
  const size = await readImageSize(src).catch(() => null);
  return {
    name: basename(resolved.path),
    path: normalizeZipPath(resolved.path),
    src,
    width: size?.width,
    height: size?.height,
    scale: resolved.scale,
  };
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
