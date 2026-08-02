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
  ReplaySkinStageAssets,
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
  // Keymodes whose profile carries note or receptor art after the import,
  // including keymodes synthesized from stable's default filenames. The
  // declared `keymodes` list is what the skin.ini ships; this is what
  // actually renders skinned.
  assetKeymodes: number[];
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
    // Callers that need the archive after importing can open it once and pass
    // it here. Besides avoiding a second unzip, that same archive keeps the
    // decoded image promises populated by this import for later rehydration.
    archive?: OskArchive;
    // Parse progress over the asset references the skin.ini declares (the
    // slow part is extracting and decoding each image out of the zip).
    onProgress?: (done: number, total: number) => void;
  },
): Promise<ReplaySkinImportResult> {
  // Buffer-first when opening here so the same code runs in the browser and
  // under node (JSZip cannot read node's File/Blob objects directly).
  const archive = options.archive ?? await openOskArchive(await file.arrayBuffer());
  const { zip, lookup, assetCache } = archive;
  const skinIni = await readSkinIni(zip);
  if (!skinIni) throw new Error("No skin.ini was found in this .osk file.");

  const parsed = parseSkinIni(skinIni);
  const baseSettings = normalizeReplaySkinSettings(options.baseSettings ?? DEFAULT_REPLAY_SKIN_SETTINGS);
  let nextSettings = normalizeReplaySkinSettings({
    ...baseSettings,
    keymodeProfiles: { ...baseSettings.keymodeProfiles },
  });

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

  // Stable also plays keymodes the skin.ini never declares by resolving each
  // element from the default filenames (mania-note1/2/S and mania-key1/2/S in
  // the symmetric column layout), so a 4K-only skin still shows its art on a
  // 7K chart in game. Mirror that: undeclared keymodes import through an
  // empty block, and only keep the profile when it actually resolved art.
  const declaredKeys = new Set(maniaBlocks.map((entry) => entry.keys));
  const synthesizedKeys = Array.from({ length: REPLAY_SKIN_MAX_COLUMNS }, (_, index) => index + 1)
    .filter((keys) => !declaredKeys.has(keys));

  // One tick per resolveAssetReference call; undefined references resolve
  // instantly, so the bar sprints through them and crawls on real decodes.
  const totalReferences = maniaBlocks.reduce((sum, { block, keys }) => {
    const comboPrefix = block.FontCombo || parsed.fonts.ComboPrefix || "";
    return sum + keys * 6 + 6 + (comboPrefix ? 11 : 0);
  }, 0) + synthesizedKeys.reduce((sum, keys) => sum + keys * 6 + 6 + (parsed.fonts.ComboPrefix ? 11 : 0), 0);
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

  // The synthesized keymodes share the decode cache with the declared ones,
  // so this pass mostly re-reads already-decoded defaults. The summary
  // counters stay declared-only: they describe what the skin ships.
  for (const keys of synthesizedKeys) {
    const imported = await buildProfileFromManiaBlock({
      zip,
      lookup,
      assetCache,
      block: {},
      fonts: parsed.fonts,
      baseProfile: getReplaySkinProfile(nextSettings, keys),
      keys,
      onTick,
    });
    if (imported.noteAssets + imported.receptorAssets === 0) continue;
    keymodeProfiles[String(keys)] = imported.profile;
  }

  // The combo counter is the one thing players routinely resize and nudge in
  // lazer's HUD editor, and lazer keeps that outside skin.ini. Applied to
  // every keymode: the file has no per-keymode form.
  const hudCombo = await readLazerComboLayout(lookup);
  if (hudCombo?.scale != null) {
    for (const [key, profile] of Object.entries(keymodeProfiles)) {
      keymodeProfiles[key] = { ...profile, comboScale: hudCombo.scale };
    }
  }

  const selectedProfile = keymodeProfiles[String(selectedBlock.keys)];
  const selectedBlockSettings = settingsFromManiaBlock(selectedBlock.block);
  nextSettings = normalizeReplaySkinSettings({
    ...nextSettings,
    ...selectedBlockSettings,
    ...(hudCombo?.position != null ? { comboPosition: hudCombo.position } : {}),
    // The renderer only draws imported note/receptor art under the "bars"
    // style (circles/arrows are the synthetic shape styles), so a skin that
    // ships any assets must switch to it or it renders as flat shapes.
    style: hasAnyImportedAssets(selectedProfile.assets) ? "bars" : nextSettings.style,
    // A full import should look like the skin, so its own judgement art and
    // digit font win over whichever built-in set the base settings carried.
    // "skin" routes getJudgementAsset to the imported art, and "set1" is the
    // sentinel renderComboImages accepts for skin combo digits.
    judgementSet: judgementAssets > 0 ? "skin" : nextSettings.judgementSet,
    comboFontSet: comboDigits > 0 ? "set1" : nextSettings.comboFontSet,
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
      // Deduped and sorted to match what the server derives from the same
      // skin.ini: a file may repeat a [Mania] block for the same key count,
      // and each keymode is one preview, one tile, one render.
      keymodes: [...new Set(maniaBlocks.map((entry) => entry.keys))].sort((a, b) => a - b),
      assetKeymodes: Object.entries(keymodeProfiles)
        .filter(([, profile]) => hasAnyImportedAssets(profile.assets))
        .map(([key]) => Number(key))
        .sort((a, b) => a - b),
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

// Name, author and keymodes without decoding a single image: the bulk
// uploader lists a queue of .osk files long before it renders any of them, and
// a full import of forty skins up front would take minutes and a lot of
// memory. Only skin.ini comes out of the archive here.
export interface OskManifest {
  name: string;
  author: string | null;
  keymodes: number[];
}

export async function readOskManifest(file: File): Promise<OskManifest> {
  const zip = await JSZip.loadAsync(file);
  const skinIni = await readSkinIni(zip);
  if (!skinIni) throw new Error("No skin.ini was found in this .osk file.");
  const parsed = parseSkinIni(skinIni);
  const keymodes = [...new Set(
    parsed.mania
      .map((block) => parseInteger(block.Keys))
      .filter((keys): keys is number => keys != null && keys >= 1 && keys <= REPLAY_SKIN_MAX_COLUMNS),
  )].sort((a, b) => a - b);
  if (keymodes.length === 0) throw new Error("The skin.ini has no [Mania] section, so this skin has no mania keymodes.");
  return { name: parsed.name ?? stripExtension(file.name), author: parsed.author, keymodes };
}

// skin.ini HitPosition / ScorePosition / ComboPosition per keymode, straight
// out of an opened archive. Skins saved before the viewer kept these per
// keymode have them missing from their stored payload, and rehydration fills
// them from here rather than making the owner re-import the skin.
export interface OskStagePositions {
  hitPosition: number | null;
  scorePosition: number | null;
  comboPosition: number | null;
  comboHidden: boolean;
}

export async function readOskStagePositions(
  archive: OskArchive,
): Promise<Map<number, OskStagePositions>> {
  const out = new Map<number, OskStagePositions>();
  const skinIni = await readSkinIni(archive.zip);
  if (!skinIni) return out;
  for (const block of parseSkinIni(skinIni).mania) {
    const keys = parseInteger(block.Keys);
    if (keys == null || keys < 1 || keys > REPLAY_SKIN_MAX_COLUMNS || out.has(keys)) continue;
    out.set(keys, {
      hitPosition: parseStagePosition(block.HitPosition),
      scorePosition: parseStagePosition(block.ScorePosition),
      comboPosition: parseStagePosition(block.ComboPosition),
      comboHidden: isOffStagePosition(block.ComboPosition),
    });
  }
  return out;
}

// A .osk opened once and queried many times: the owner-skin flows resolve
// stored asset paths and picker choices against the same archive without
// re-unzipping per asset.
export interface OskArchive {
  zip: JSZip;
  lookup: Map<string, JSZip.JSZipObject>;
  // Decode results by lowercased zip path. Rehydration references the same
  // file once per keymode/column that uses it; without this every reference
  // re-inflates and re-decodes the image, which stalls the page for seconds
  // on asset-heavy skins.
  assetCache: Map<string, Promise<ReplaySkinImageAsset | undefined>>;
}

export async function openOskArchive(file: Blob | ArrayBuffer): Promise<OskArchive> {
  const zip = await JSZip.loadAsync(file);
  return { zip, lookup: buildZipLookup(zip), assetCache: new Map() };
}

// Loads one image out of an already-open archive by its exact zip path; the
// rehydration path for stored replay-skin configs, which reference assets by
// path instead of embedding them. Scale re-derives from the filename's @2x
// marker, matching what buildAssetCandidates assigned at import time.
export function loadOskImageAssetByPath(archive: OskArchive, path: string): Promise<ReplaySkinImageAsset | undefined> {
  const clean = cleanReference(path);
  if (!clean) return Promise.resolve(undefined);
  const key = clean.toLowerCase();
  const cached = archive.assetCache.get(key);
  if (cached) return cached;
  const file = archive.lookup.get(key);
  if (!file) return Promise.resolve(undefined);
  const extension = /\.([a-z0-9]+)$/i.exec(clean)?.[1]?.toLowerCase();
  const mime = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : "image/png";
  const scale = /@2x\.[a-z0-9]+$/i.test(clean) ? 2 : 1;
  const promise = readImageAsset(archive.zip, { file, path: file.name, mime, scale });
  archive.assetCache.set(key, promise);
  return promise;
}

// Loads a skin element by its stable filename (extension, @2x and animation
// frame 0 all resolved the way an import does). Stored configs only name the
// assets that existed when they were saved, so this is how a skin saved before
// the viewer understood an element still gets it.
export async function resolveOskAssetByName(
  archive: OskArchive,
  name: string,
): Promise<ReplaySkinImageAsset | undefined> {
  return (await resolveAssetReference(archive.zip, archive.lookup, archive.assetCache, name))
    ?? (await resolveAssetReference(archive.zip, archive.lookup, archive.assetCache, `${name}-0`));
}

export async function extractSkinSoundsFromArchive(archive: OskArchive): Promise<Record<string, ArrayBuffer>> {
  return extractSkinSounds(archive.lookup);
}

export interface OskImageEntry {
  path: string;
  name: string;
}

// Every image the archive could offer as a replacement asset, for the
// customization picker. Paths only; the picker decodes previews lazily.
export function listOskImageEntries(archive: OskArchive): OskImageEntry[] {
  const entries: OskImageEntry[] = [];
  for (const file of archive.lookup.values()) {
    const path = normalizeZipPath(file.name);
    if (!/\.(png|jpe?g)$/i.test(path)) continue;
    entries.push({ path, name: basename(path) });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
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

interface LazerComboLayout {
  // Multiplier on the drawn digit size.
  scale?: number;
  // Replay 768-space, measured from the bottom edge, like every other stage
  // position in the settings.
  position?: number;
}

// osu!lazer stores HUD-editor tweaks in MainHUDComponents.json, which stable
// ignores entirely - so a player who shrank their mania combo counter in lazer
// has that size recorded nowhere else. The mania list holds the ruleset's own
// components; only the combo counter is on screen during a replay here.
//
// Its space is lazer's 768-tall HUD, matching the 768-space the viewer already
// uses for HitPosition and friends: the anchor picks the origin edge and
// Position.y offsets from it, downwards.
export async function readLazerComboLayout(lookup: Map<string, JSZip.JSZipObject>): Promise<LazerComboLayout | null> {
  const file = lookup.get("mainhudcomponents.json")
    ?? [...lookup.entries()].find(([path]) => path.endsWith("/mainhudcomponents.json"))?.[1];
  if (!file) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(await file.async("string")));
  } catch {
    return null;
  }
  const mania = (parsed as { DrawableInfo?: { mania?: unknown } } | null)?.DrawableInfo?.mania;
  if (!Array.isArray(mania)) return null;
  const entry = mania.find((item): item is Record<string, unknown> => (
    Boolean(item)
    && typeof item === "object"
    && typeof (item as { Type?: unknown }).Type === "string"
    && (item as { Type: string }).Type.includes("LegacyManiaComboCounter")
  ));
  if (!entry) return null;

  const layout: LazerComboLayout = {};
  const scale = entry.Scale as { x?: unknown; y?: unknown } | undefined;
  const scaleY = typeof scale?.y === "number" ? scale.y : typeof scale?.x === "number" ? scale.x : null;
  if (scaleY != null && Number.isFinite(scaleY) && scaleY > 0 && scaleY !== 1) {
    layout.scale = Math.max(0.1, Math.min(4, scaleY));
  }

  const positionY = (entry.Position as { y?: unknown } | undefined)?.y;
  const anchor = typeof entry.Anchor === "number" ? entry.Anchor : 0;
  if (typeof positionY === "number" && Number.isFinite(positionY)) {
    // osu!framework anchor bits: 1 top, 2 vertical centre, 4 bottom.
    const originY = (anchor & 4) !== 0 ? LAZER_HUD_HEIGHT : (anchor & 2) !== 0 ? LAZER_HUD_HEIGHT / 2 : 0;
    const fromBottom = LAZER_HUD_HEIGHT - (originY + positionY);
    if (fromBottom > 0 && fromBottom < LAZER_HUD_HEIGHT) layout.position = Math.round(fromBottom);
  }

  return layout.scale == null && layout.position == null ? null : layout;
}

const LAZER_HUD_HEIGHT = 768;

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
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
  stageAssets: number;
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
  // ColumnStart is the stage's left edge in osu!pixels from the screen's left
  // edge (853.33 units wide at 16:9); LightPosition is the column light's
  // bottom edge, top-down in the 480 space like HitPosition. Both stay null
  // when unset so the renderer applies stable's defaults (136 / 413).
  const columnStartValue = parseNumber(block.ColumnStart);
  const columnStart = columnStartValue == null ? null : Math.max(0, Math.min(853, columnStartValue));
  const lightPositionValue = parseNumber(block.LightPosition);
  const lightPosition = lightPositionValue == null ? null : Math.max(0, Math.min(480, lightPositionValue));
  // HitPosition and the two HUD positions belong to the block as much as the
  // column widths do: a skin can put its 4K hit line at 440 and its 7K one at
  // 393, and its key art is padded to land on whichever applies. Kept per
  // keymode as well as in the settings-wide values below, which stay as the
  // fallback for keymodes the skin never declared.
  const hitPosition = parseStagePosition(block.HitPosition);
  const scorePosition = parseStagePosition(block.ScorePosition);
  const comboPosition = parseStagePosition(block.ComboPosition);
  const comboHidden = isOffStagePosition(block.ComboPosition);
  // KeysUnderNotes puts the key area below the notes, which is how arrow and
  // deck skins keep their receptors from covering the hit.
  const keysUnderNotes = parseNumber(block.KeysUnderNotes) === 1;
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
  // ...but the playfield wants them: Colour{n} with its alpha is what decides
  // whether the map art shows through a column, so it is kept on its own field
  // for the stage to fill with.
  const columnBackgrounds = Array.from({ length: keys }, (_, index) =>
    parseColorWithAlpha(block[`Colour${index + 1}`]) ?? "");
  const lightColors = Array.from({ length: keys }, (_, index) =>
    parseColor(block[`ColourLight${index + 1}`]) ?? "");
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
    // often blank the static copy but keep the animation). A declared
    // reference also gets the -0 frame retry: lazer edits routinely point
    // Hit300 at a folder that only ships mania-hit300-0.png.
    const asset = (await resolveAssetReference(zip, lookup, assetCache, block[skinKey]))
      ?? (block[skinKey] ? await resolveAssetReference(zip, lookup, assetCache, `${block[skinKey]}-0`) : undefined)
      ?? (await resolveAssetReference(zip, lookup, assetCache, `mania-${outputKey}-0`))
      ?? (await resolveAssetReference(zip, lookup, assetCache, `mania-${outputKey}`));
    onTick?.();
    if (asset) {
      judgements[outputKey] = asset;
      judgementAssets += 1;
    }
  }

  // Stage furniture: the frame, deck, hint line, column light and hit glow.
  // Stable resolves each from its default filename when the block is silent,
  // and the animated first frame outranks the static image the same way the
  // note art does.
  const resolveStage = async (reference: string | undefined, fallback: string): Promise<ReplaySkinImageAsset | undefined> =>
    (await resolveTracked(reference))
      ?? (reference ? await resolveTracked(`${reference}-0`) : undefined)
      ?? (await resolveTracked(fallback))
      ?? (await resolveTracked(`${fallback}-0`));
  const stage: ReplaySkinStageAssets = {
    left: await resolveStage(block.StageLeft, "mania-stage-left"),
    right: await resolveStage(block.StageRight, "mania-stage-right"),
    bottom: await resolveStage(block.StageBottom, "mania-stage-bottom"),
    hint: await resolveStage(block.StageHint, "mania-stage-hint"),
    light: await resolveStage(block.StageLight, "mania-stage-light"),
    // LightingN is the note glow and LightingL the hold glow; skins often ship
    // only one, and either reads as "the hit glow" on a still preview.
    lighting: (await resolveStage(block.LightingN, "lightingN"))
      ?? (await resolveStage(block.LightingL, "lightingL")),
    // The HP bar art. Global filenames (no [Mania] key), animated frame 0
    // stands in for a missing static image like the rest of the furniture;
    // scorebar-ki is the classic marker name older skins ship.
    scorebarBg: await resolveStage(undefined, "scorebar-bg"),
    scorebarColour: await resolveStage(undefined, "scorebar-colour"),
    scorebarMarker: (await resolveStage(undefined, "scorebar-marker"))
      ?? (await resolveStage(undefined, "scorebar-ki")),
    // The pause screen. Most skins ship the buttons and leave the backdrop to
    // the default skin, so the overlay is optional and the buttons are what
    // decide whether the skin has a pause screen at all.
    pauseOverlay: await resolveStage(undefined, "pause-overlay"),
    pauseContinue: await resolveStage(undefined, "pause-continue"),
    pauseRetry: await resolveStage(undefined, "pause-retry"),
    pauseBack: await resolveStage(undefined, "pause-back"),
    lightingWidths: parseNumberList(block.LightingNWidth).slice(0, keys),
    lightColors,
  };
  const stageAssets = [stage.left, stage.right, stage.bottom, stage.hint, stage.light, stage.lighting]
    .filter(Boolean).length;

  // Stable's [Fonts] ComboPrefix defaults to "score", so skins that ship only
  // score-* digit art still get a combo font. A block FontCombo that points
  // at digits which do not exist (moved folders are common in lazer edits)
  // must not kill the combo font either: fall through the candidates until
  // one resolves, which is the font the game actually shows.
  const comboOverlap = clampInteger(parseNumber(fonts.ComboOverlap) ?? 0, -80, 80);
  const comboPrefixCandidates = [...new Set([block.FontCombo, fonts.ComboPrefix, "score"].filter((value): value is string => Boolean(value)))];
  let comboPrefix = comboPrefixCandidates[0] ?? "score";
  let comboDigitsAssets: Array<ReplaySkinImageAsset | undefined> = [];
  let comboX: ReplaySkinImageAsset | undefined;
  for (const candidate of comboPrefixCandidates) {
    const digitsAssets = await Promise.all(Array.from({ length: 10 }, (_, digit) =>
      resolveTracked(`${candidate}-${digit}`),
    ));
    const x = await resolveTracked(`${candidate}-x`);
    if (digitsAssets.some(Boolean) || x) {
      comboPrefix = candidate;
      comboDigitsAssets = digitsAssets;
      comboX = x;
      break;
    }
  }
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
      columnStart,
      lightPosition,
      hitPosition,
      scorePosition,
      comboPosition,
      comboHidden,
      keysUnderNotes,
      noteHeightScale,
      columnBackgrounds,
      assets: {
        columns,
        judgements,
        combo,
        stage,
      },
    },
    noteAssets,
    receptorAssets,
    judgementAssets,
    comboDigits,
    stageAssets,
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

// skin.ini stage positions are measured in the 480-unit stage space, and a
// value outside it cannot mean a spot on the stage: the Teto edit sets its 7K
// ComboPosition to 800, and clamping that into range turned "off the screen"
// into "pinned to the bottom edge". Treated as undeclared instead, so the
// value the rest of the skin uses stands.
function parseStagePosition(raw: string | undefined): number | null {
  const value = parseNumber(raw);
  if (value == null || value < 0 || value > 480) return null;
  return osuManiaStagePositionToReplayPosition(value);
}

// A position the skin deliberately pushed past the bottom of the stage, which
// is how a skin turns the combo counter off.
function isOffStagePosition(raw: string | undefined): boolean {
  const value = parseNumber(raw);
  return value != null && value > 480;
}

function settingsFromManiaBlock(block: Record<string, string>): Partial<ReplaySkinSettings> {
  const patch: Partial<ReplaySkinSettings> = {};
  const hitPosition = parseStagePosition(block.HitPosition);
  const scorePosition = parseStagePosition(block.ScorePosition);
  const comboPosition = parseStagePosition(block.ComboPosition);
  if (hitPosition != null) patch.hitPosition = hitPosition;
  if (scorePosition != null) patch.scorePosition = scorePosition;
  if (comboPosition != null) patch.comboPosition = comboPosition;
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
  let capped = false;
  // Some skins ship TIFFs renamed to .png (Percy-style LN bodies especially;
  // osu!stable decodes by content, so they work in game). Browsers cannot
  // decode TIFF at all, so transcode the common Photoshop flavour to PNG here.
  // "SUkq" / "TU0AK" are the base64 spellings of the II*/MM* TIFF magic.
  if (data.startsWith("SUkq") || data.startsWith("TU0AK")) {
    const decoded = decodeUncompressedTiff(base64ToBytes(data));
    // Capped before the canvas, not after: these are the 138x40000 LN body
    // strips, and browsers refuse a canvas that tall outright (Chrome stops
    // at 32767), so transcoding one at full size produced nothing at all.
    const plan = decoded ? planTextureCap(decoded.width, decoded.height) : null;
    const transcoded = decoded ? rgbaToPngDataUrl(plan ? applyTextureCap(decoded, plan) : decoded) : null;
    if (decoded && transcoded) {
      src = transcoded;
      size = plan?.crop ? { width: plan.width, height: plan.height } : { width: decoded.width, height: decoded.height };
      capped = true;
    }
  }
  if (!size) size = await readImageSize(src).catch(() => null);
  const plan = capped || !size ? null : planTextureCap(size.width, size.height);
  if (plan) {
    const shrunk = await capImageDataUrl(src, size!, plan).catch(() => null);
    if (shrunk) {
      src = shrunk;
      // A cropped strip really is shorter now; a scaled-down image is not.
      if (plan.crop) size = { width: plan.width, height: plan.height };
    }
  }
  return {
    name: basename(resolved.path),
    path: normalizeZipPath(resolved.path),
    src,
    width: size?.width,
    height: size?.height,
    scale: resolved.scale,
  };
}

// WebGL rejects a texture past its max size (16384 on desktop, half that on
// plenty of phones) and the upload silently fails, which is how a skin ends up
// with invisible long notes. A canvas that big is refused outright well before
// that, so the transcode of a renamed TIFF produces nothing at all.
const MAX_SKIN_TEXTURE_PX = 4096;

// Past this ratio the art is a strip, not a picture, and the only strips this
// long in a mania skin are Percy-style LN bodies.
const TEXTURE_STRIP_ASPECT = 8;

interface TextureCapPlan {
  width: number;
  height: number;
  // Keep the leading rows/columns at full resolution instead of scaling the
  // whole thing down.
  crop: boolean;
}

// How to bring an oversized texture under the cap.
//
// Percy-style LN bodies are a 138x40000 strip whose art - the rounded cap and
// the transparent lead-in that makes the hold read shorter than it is - lives
// in the first rows, followed by tens of thousands of rows of one colour. They
// have to be CROPPED: stable cascades a body at natural aspect from the tail
// end, so scaling the strip down would shrink that cap by the same factor and
// start repeating the whole pattern within a single hold. Cropping keeps the
// cap pixel-for-pixel and only shortens the uniform run, which no realistic
// hold reaches (4096 rows of a 138-wide strip cascade past 2000px on screen).
//
// Anything that is not a strip has no such convention about where its art
// sits, so it scales down instead and keeps all of it.
export function planTextureCap(width: number, height: number): TextureCapPlan | null {
  if (!(width > MAX_SKIN_TEXTURE_PX || height > MAX_SKIN_TEXTURE_PX)) return null;
  const longest = Math.max(width, height);
  const shortest = Math.max(1, Math.min(width, height));
  return {
    width: Math.min(width, MAX_SKIN_TEXTURE_PX),
    height: Math.min(height, MAX_SKIN_TEXTURE_PX),
    crop: longest / shortest >= TEXTURE_STRIP_ASPECT,
  };
}

// Nearest-neighbour when scaling, because the images that reach here are long
// gradients and stretches of flat colour where a box filter buys nothing for
// the extra passes.
export function applyTextureCap(decoded: DecodedTiff, plan: TextureCapPlan): DecodedTiff {
  const { width, height } = plan;
  if (width === decoded.width && height === decoded.height) return decoded;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = plan.crop ? y : Math.min(decoded.height - 1, Math.floor((y * decoded.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = plan.crop ? x : Math.min(decoded.width - 1, Math.floor((x * decoded.width) / width));
      const from = (sourceY * decoded.width + sourceX) * 4;
      const to = (y * width + x) * 4;
      rgba[to] = decoded.rgba[from];
      rgba[to + 1] = decoded.rgba[from + 1];
      rgba[to + 2] = decoded.rgba[from + 2];
      rgba[to + 3] = decoded.rgba[from + 3];
    }
  }
  return { width, height, rgba };
}

function capImageDataUrl(
  src: string,
  size: { width: number; height: number },
  plan: TextureCapPlan,
): Promise<string | null> {
  if (typeof document === "undefined" || typeof Image === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = plan.width;
        canvas.height = plan.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(null);
          return;
        }
        // Cropping takes the leading region 1:1; scaling takes the whole image.
        const sourceWidth = plan.crop ? plan.width : size.width;
        const sourceHeight = plan.crop ? plan.height : size.height;
        ctx.drawImage(img, 0, 0, sourceWidth, sourceHeight, 0, 0, plan.width, plan.height);
        resolve(canvas.toDataURL("image/png"));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
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

export function hasAnyImportedAssets(assets: ReplaySkinKeymodeAssets | undefined): boolean {
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
