import JSZip from "jszip";

// --- Types ---

export interface ManiaSkinConfig {
  columnWidth: number[];       // per-column widths (pixels)
  hitPosition: number;         // judgment line offset from bottom (pixels)
  keysUnderNotes: boolean;     // draw keys below notes
  columnColors: string[];      // per-column background colors (rgba)
  columnLightColors: string[]; // per-column light colors (rgba)
  // Per-column image overrides (index → image filename stem)
  noteImageOverrides: (string | null)[];
  noteImageHOverrides: (string | null)[];
  noteImageLOverrides: (string | null)[];
  noteImageTOverrides: (string | null)[];
  keyImageOverrides: (string | null)[];
  keyImageDOverrides: (string | null)[];
}

export interface ManiaSkinImages {
  // Notes (per-pattern: 1=outer, 2=inner, S=special)
  note1: HTMLImageElement | null;
  note2: HTMLImageElement | null;
  noteS: HTMLImageElement | null;
  // Hold heads
  note1H: HTMLImageElement | null;
  note2H: HTMLImageElement | null;
  noteSH: HTMLImageElement | null;
  // Hold bodies
  note1L: HTMLImageElement | null;
  note2L: HTMLImageElement | null;
  noteSL: HTMLImageElement | null;
  // Hold tails
  note1T: HTMLImageElement | null;
  note2T: HTMLImageElement | null;
  noteST: HTMLImageElement | null;
  // Keys (unpressed / pressed)
  key1: HTMLImageElement | null;
  key1D: HTMLImageElement | null;
  key2: HTMLImageElement | null;
  key2D: HTMLImageElement | null;
  keyS: HTMLImageElement | null;
  keySD: HTMLImageElement | null;
  // Stage
  stageHint: HTMLImageElement | null;
  stageLight: HTMLImageElement | null;
  stageLeft: HTMLImageElement | null;
  stageRight: HTMLImageElement | null;
  // Judgments
  hit300g: HTMLImageElement | null;
  hit300: HTMLImageElement | null;
  hit200: HTMLImageElement | null;
  hit100: HTMLImageElement | null;
  hit50: HTMLImageElement | null;
  hit0: HTMLImageElement | null;
  // Hit lighting
  lightingN: HTMLImageElement | null;
  // Per-column overrides (column index → image)
  columnNotes: (HTMLImageElement | null)[];
  columnNotesH: (HTMLImageElement | null)[];
  columnNotesL: (HTMLImageElement | null)[];
  columnNotesT: (HTMLImageElement | null)[];
  columnKeys: (HTMLImageElement | null)[];
  columnKeysD: (HTMLImageElement | null)[];
}

export interface ManiaSkin {
  name: string;
  config: ManiaSkinConfig;
  images: ManiaSkinImages;
  keyCount: number; // the key count this config targets
}

// --- skin.ini parser ---

// osu! skin.ini color format: "R,G,B" or "R,G,B,A" → "rgba(R,G,B,A)"
function parseIniColor(val: string): string {
  const parts = val.split(",").map((s) => s.trim());
  if (parts.length >= 3) {
    const r = parseInt(parts[0]) || 0;
    const g = parseInt(parts[1]) || 0;
    const b = parseInt(parts[2]) || 0;
    const a = parts.length >= 4 ? (parseInt(parts[3]) || 0) / 255 : 1;
    return `rgba(${r},${g},${b},${a})`;
  }
  return "rgba(0,0,0,0)";
}

function parseSkinIni(content: string, keyCount: number): ManiaSkinConfig {
  const config: ManiaSkinConfig = {
    columnWidth: new Array(keyCount).fill(30),
    hitPosition: 402,
    keysUnderNotes: false,
    columnColors: [],
    columnLightColors: [],
    noteImageOverrides: new Array(keyCount).fill(null),
    noteImageHOverrides: new Array(keyCount).fill(null),
    noteImageLOverrides: new Array(keyCount).fill(null),
    noteImageTOverrides: new Array(keyCount).fill(null),
    keyImageOverrides: new Array(keyCount).fill(null),
    keyImageDOverrides: new Array(keyCount).fill(null),
  };

  // Find the [Mania] section for this key count
  const lines = content.split(/\r?\n/);
  let inManiaSection = false;
  let matchedKeyCount = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Section headers
    if (line.startsWith("[")) {
      if (inManiaSection && matchedKeyCount) break; // done with our section
      inManiaSection = line.toLowerCase() === "[mania]";
      matchedKeyCount = false;
      continue;
    }

    if (!inManiaSection) continue;

    // Key-value pairs
    const eqIdx = line.indexOf(":");
    if (eqIdx < 0) continue;
    const key = line.substring(0, eqIdx).trim();
    const val = line.substring(eqIdx + 1).trim();

    if (key === "Keys") {
      matchedKeyCount = parseInt(val) === keyCount;
      if (!matchedKeyCount) inManiaSection = false; // skip until next [Mania]
      continue;
    }

    if (!matchedKeyCount) continue;

    // Parse known keys
    if (key === "ColumnWidth") {
      const widths = val.split(",").map((s) => parseInt(s.trim()) || 30);
      for (let i = 0; i < keyCount && i < widths.length; i++) {
        config.columnWidth[i] = widths[i];
      }
    } else if (key === "HitPosition") {
      config.hitPosition = parseInt(val) || 402;
    } else if (key === "KeysUnderNotes") {
      config.keysUnderNotes = val === "1";
    } else if (key.startsWith("Colour") && !key.startsWith("ColourLight")) {
      // Colour1, Colour2, ...
      const idx = parseInt(key.replace("Colour", "")) - 1;
      if (idx >= 0 && idx < keyCount) {
        config.columnColors[idx] = parseIniColor(val);
      }
    } else if (key.startsWith("ColourLight")) {
      const idx = parseInt(key.replace("ColourLight", "")) - 1;
      if (idx >= 0 && idx < keyCount) {
        config.columnLightColors[idx] = parseIniColor(val);
      }
    } else {
      // Per-column image overrides: NoteImage0, NoteImage0H, NoteImage0L, NoteImage0T,
      // KeyImage0, KeyImage0D (0-indexed column numbers)
      let match: RegExpMatchArray | null;
      if ((match = key.match(/^NoteImage(\d+)$/))) {
        const idx = parseInt(match[1]);
        if (idx >= 0 && idx < keyCount) config.noteImageOverrides[idx] = val;
      } else if ((match = key.match(/^NoteImage(\d+)H$/))) {
        const idx = parseInt(match[1]);
        if (idx >= 0 && idx < keyCount) config.noteImageHOverrides[idx] = val;
      } else if ((match = key.match(/^NoteImage(\d+)L$/))) {
        const idx = parseInt(match[1]);
        if (idx >= 0 && idx < keyCount) config.noteImageLOverrides[idx] = val;
      } else if ((match = key.match(/^NoteImage(\d+)T$/))) {
        const idx = parseInt(match[1]);
        if (idx >= 0 && idx < keyCount) config.noteImageTOverrides[idx] = val;
      } else if ((match = key.match(/^KeyImage(\d+)$/))) {
        const idx = parseInt(match[1]);
        if (idx >= 0 && idx < keyCount) config.keyImageOverrides[idx] = val;
      } else if ((match = key.match(/^KeyImage(\d+)D$/))) {
        const idx = parseInt(match[1]);
        if (idx >= 0 && idx < keyCount) config.keyImageDOverrides[idx] = val;
      }
    }
  }

  return config;
}

// --- Image loading helpers ---

async function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image"));
    };
    img.src = url;
  });
}

// osu! skins can have .png or .jpg, and filenames are case-insensitive.
// Also try @2x variants first for higher quality.
// Paths from skin.ini use backslashes (e.g. "aleju\down") but zip uses forward slashes.
function findFileInZip(zip: JSZip, name: string): JSZip.JSZipObject | null {
  // Normalize backslashes to forward slashes (skin.ini uses Windows-style paths)
  const normalized = name.replace(/\\/g, "/");
  const baseName = normalized.replace(/\.[^./]+$/, "");
  const ext = normalized.includes(".") ? normalized.substring(normalized.lastIndexOf(".")) : ".png";
  const candidates = [
    `${baseName}@2x${ext}`,
    `${baseName}@2x.png`,
    normalized,
    `${baseName}.png`,
    `${baseName}.jpg`,
  ];

  // Normalize zip paths for case-insensitive lookup (also normalize backslashes)
  const zipFiles = new Map<string, JSZip.JSZipObject>();
  zip.forEach((path, file) => {
    zipFiles.set(path.replace(/\\/g, "/").toLowerCase(), file);
  });

  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const match = zipFiles.get(lower);
    if (match) return match;

    // Some skins nest files in a subfolder
    for (const [path, file] of zipFiles) {
      if (path.endsWith("/" + lower)) {
        return file;
      }
    }
  }

  return null;
}

async function tryLoadImage(zip: JSZip, filename: string): Promise<HTMLImageElement | null> {
  const file = findFileInZip(zip, filename);
  if (!file) return null;
  try {
    const blob = await file.async("blob");
    return await loadImageFromBlob(blob);
  } catch {
    return null;
  }
}

// --- Column pattern mapping ---

// osu!mania maps columns to patterns: 1=outer, 2=inner, S=special (center)
// This determines which note/key image each column uses by default
function getColumnPattern(col: number, keyCount: number): "1" | "2" | "S" {
  // Standard osu! patterns for each key mode
  const patterns: Record<number, string[]> = {
    1: ["S"],
    2: ["1", "1"],
    3: ["1", "S", "1"],
    4: ["1", "2", "2", "1"],
    5: ["1", "2", "S", "2", "1"],
    6: ["1", "2", "1", "1", "2", "1"],
    7: ["1", "2", "1", "S", "1", "2", "1"],
    8: ["1", "2", "1", "2", "2", "1", "2", "1"],
    9: ["1", "2", "1", "2", "S", "2", "1", "2", "1"],
    10: ["1", "2", "1", "2", "1", "1", "2", "1", "2", "1"],
  };

  const pat = patterns[keyCount];
  if (!pat || col >= pat.length) return "1";
  return pat[col] as "1" | "2" | "S";
}

// --- Main parser ---

export async function parseSkinFile(
  file: File | ArrayBuffer,
  keyCount: number,
): Promise<ManiaSkin> {
  const zip = await JSZip.loadAsync(file);

  // Parse skin.ini
  let skinName = "Custom Skin";
  let config: ManiaSkinConfig;

  const iniFile = findFileInZip(zip, "skin.ini");
  if (iniFile) {
    const iniContent = await iniFile.async("text");
    config = parseSkinIni(iniContent, keyCount);

    // Extract skin name from [General] section
    const nameMatch = iniContent.match(/\[General\][\s\S]*?Name:\s*(.+)/i);
    if (nameMatch) skinName = nameMatch[1].trim();
  } else {
    config = parseSkinIni("", keyCount);
  }

  // Load standard images in parallel
  const imageNames = {
    // Notes
    note1: "mania-note1.png",
    note2: "mania-note2.png",
    noteS: "mania-noteS.png",
    // Hold heads
    note1H: "mania-note1H.png",
    note2H: "mania-note2H.png",
    noteSH: "mania-noteSH.png",
    // Hold bodies
    note1L: "mania-note1L.png",
    note2L: "mania-note2L.png",
    noteSL: "mania-noteSL.png",
    // Hold tails
    note1T: "mania-note1T.png",
    note2T: "mania-note2T.png",
    noteST: "mania-noteST.png",
    // Keys
    key1: "mania-key1.png",
    key1D: "mania-key1D.png",
    key2: "mania-key2.png",
    key2D: "mania-key2D.png",
    keyS: "mania-keyS.png",
    keySD: "mania-keySD.png",
    // Stage
    stageHint: "mania-stage-hint.png",
    stageLight: "mania-stage-light.png",
    stageLeft: "mania-stage-left.png",
    stageRight: "mania-stage-right.png",
    // Judgments
    hit300g: "mania-hit300g.png",
    hit300: "mania-hit300.png",
    hit200: "mania-hit200.png",
    hit100: "mania-hit100.png",
    hit50: "mania-hit50.png",
    hit0: "mania-hit0.png",
    // Lighting
    lightingN: "lightingN.png",
  } as const;

  type ImageKey = keyof typeof imageNames;
  const entries = Object.entries(imageNames) as [ImageKey, string][];
  const loaded = await Promise.all(entries.map(([, file]) => tryLoadImage(zip, file)));

  const images: ManiaSkinImages = {
    note1: null, note2: null, noteS: null,
    note1H: null, note2H: null, noteSH: null,
    note1L: null, note2L: null, noteSL: null,
    note1T: null, note2T: null, noteST: null,
    key1: null, key1D: null, key2: null, key2D: null, keyS: null, keySD: null,
    stageHint: null, stageLight: null, stageLeft: null, stageRight: null,
    hit300g: null, hit300: null, hit200: null, hit100: null, hit50: null, hit0: null,
    lightingN: null,
    columnNotes: new Array(keyCount).fill(null),
    columnNotesH: new Array(keyCount).fill(null),
    columnNotesL: new Array(keyCount).fill(null),
    columnNotesT: new Array(keyCount).fill(null),
    columnKeys: new Array(keyCount).fill(null),
    columnKeysD: new Array(keyCount).fill(null),
  };

  entries.forEach(([key], i) => {
    (images as unknown as Record<string, HTMLImageElement | null>)[key] = loaded[i];
  });

  // Load per-column overrides from skin.ini
  const overrideLoads: Promise<void>[] = [];
  for (let col = 0; col < keyCount; col++) {
    if (config.noteImageOverrides[col]) {
      overrideLoads.push(
        tryLoadImage(zip, config.noteImageOverrides[col]! + ".png").then((img) => { images.columnNotes[col] = img; }),
      );
    }
    if (config.noteImageHOverrides[col]) {
      overrideLoads.push(
        tryLoadImage(zip, config.noteImageHOverrides[col]! + ".png").then((img) => { images.columnNotesH[col] = img; }),
      );
    }
    if (config.noteImageLOverrides[col]) {
      overrideLoads.push(
        tryLoadImage(zip, config.noteImageLOverrides[col]! + ".png").then((img) => { images.columnNotesL[col] = img; }),
      );
    }
    if (config.noteImageTOverrides[col]) {
      overrideLoads.push(
        tryLoadImage(zip, config.noteImageTOverrides[col]! + ".png").then((img) => { images.columnNotesT[col] = img; }),
      );
    }
    if (config.keyImageOverrides[col]) {
      overrideLoads.push(
        tryLoadImage(zip, config.keyImageOverrides[col]! + ".png").then((img) => { images.columnKeys[col] = img; }),
      );
    }
    if (config.keyImageDOverrides[col]) {
      overrideLoads.push(
        tryLoadImage(zip, config.keyImageDOverrides[col]! + ".png").then((img) => { images.columnKeysD[col] = img; }),
      );
    }
  }
  await Promise.all(overrideLoads);

  return { name: skinName, config, images, keyCount };
}

// --- Resolve which image a column should use ---

export function getNoteImage(skin: ManiaSkin, col: number): HTMLImageElement | null {
  if (skin.images.columnNotes[col]) return skin.images.columnNotes[col];
  const pattern = getColumnPattern(col, skin.keyCount);
  if (pattern === "S") return skin.images.noteS ?? skin.images.note1;
  if (pattern === "2") return skin.images.note2 ?? skin.images.note1;
  return skin.images.note1;
}

export function getHoldHeadImage(skin: ManiaSkin, col: number): HTMLImageElement | null {
  if (skin.images.columnNotesH[col]) return skin.images.columnNotesH[col];
  const pattern = getColumnPattern(col, skin.keyCount);
  if (pattern === "S") return skin.images.noteSH ?? skin.images.note1H;
  if (pattern === "2") return skin.images.note2H ?? skin.images.note1H;
  return skin.images.note1H;
}

export function getHoldBodyImage(skin: ManiaSkin, col: number): HTMLImageElement | null {
  if (skin.images.columnNotesL[col]) return skin.images.columnNotesL[col];
  const pattern = getColumnPattern(col, skin.keyCount);
  if (pattern === "S") return skin.images.noteSL ?? skin.images.note1L;
  if (pattern === "2") return skin.images.note2L ?? skin.images.note1L;
  return skin.images.note1L;
}

export function getHoldTailImage(skin: ManiaSkin, col: number): HTMLImageElement | null {
  if (skin.images.columnNotesT[col]) return skin.images.columnNotesT[col];
  const pattern = getColumnPattern(col, skin.keyCount);
  if (pattern === "S") return skin.images.noteST ?? skin.images.note1T;
  if (pattern === "2") return skin.images.note2T ?? skin.images.note1T;
  return skin.images.note1T;
}

export function getKeyImage(skin: ManiaSkin, col: number, pressed: boolean): HTMLImageElement | null {
  if (pressed) {
    if (skin.images.columnKeysD[col]) return skin.images.columnKeysD[col];
    const pattern = getColumnPattern(col, skin.keyCount);
    if (pattern === "S") return skin.images.keySD ?? skin.images.key1D;
    if (pattern === "2") return skin.images.key2D ?? skin.images.key1D;
    return skin.images.key1D;
  }
  if (skin.images.columnKeys[col]) return skin.images.columnKeys[col];
  const pattern = getColumnPattern(col, skin.keyCount);
  if (pattern === "S") return skin.images.keyS ?? skin.images.key1;
  if (pattern === "2") return skin.images.key2 ?? skin.images.key1;
  return skin.images.key1;
}

// --- IndexedDB persistence ---

const DB_NAME = "mania-hub-skins";
const STORE_NAME = "skins";
const DB_VERSION = 1;

function openSkinDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveSkinToIDB(file: ArrayBuffer, name: string): Promise<void> {
  const db = await openSkinDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put({ data: file, name, savedAt: Date.now() }, "current");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadSkinFromIDB(): Promise<{ data: ArrayBuffer; name: string } | null> {
  try {
    const db = await openSkinDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get("current");
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function removeSkinFromIDB(): Promise<void> {
  try {
    const db = await openSkinDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.delete("current");
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore
  }
}
