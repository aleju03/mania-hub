// What "looks similar" means for two skins. The loudest fact about a mania
// skin is its note art - bars against circles against arrows - so the score
// leans on the visual signatures computed from the actual note images inside
// the .osk (src/skins/visual-signature.ts), one per keymode block, because a
// skin's 4K and 6K arts are routinely different skins to the eye. Two skins
// are as similar as their most alike shared keymode, and the match remembers
// which keymode that was so the strip can front that keymode's render instead
// of whatever cover the uploader chose. Note shape gates the visual term
// multiplicatively: a circle skin is never a lookalike of a bar skin however
// well their colours agree. Skins without a signature fall back to the accent
// colour sampled at preview time, which knows colour but nothing about shape
// and scores accordingly. Keymode overlap and a shared author are small
// additive nudges: they keep the strip playable and tie a skinner's series
// together, but they must never carry a visual mismatch over the floor.

// One keymode block's note-art digest. Everything in it is scale-free, so @2x
// art and downsized ports digest alike.
export interface SkinKeymodeVisual {
  // Trimmed tap-note width over height: bars run wide, circles square.
  aspect: number;
  // 8x8 alpha grid of the tap note, row-major, one opacity decile 0-9 per
  // cell. Shape beyond aspect: a circle's corners are 0s, a bar is all 9s.
  mask: string;
  // Mean opaque colour of each distinct tap image, column order, at most 4.
  colors: string[];
  // The colour the eye actually reads off each of those notes: the mean of
  // only their saturated pixels. Most mania notes are a white or grey body
  // with a coloured rim or core, and averaging the whole sprite washes that
  // rim out - which left every round white-bodied skin at the same point and
  // made their recommendations arbitrary. Empty for genuinely colourless art.
  accents: string[];
  // How much of the note art is saturated colour at all, 0-1. Separates a
  // white note with a thin coloured edge from a fully coloured one, and keeps
  // a monochrome skin from matching a neon one on rim colour alone.
  sat: number;
}

// The whole skin's digest, stored on the skins row as visual_json: one entry
// per keymode block whose note art could be read.
export interface SkinVisualSignature {
  v: 3;
  keymodes: Record<string, SkinKeymodeVisual>;
}

export interface SkinSimilarityFacts {
  author: string | null;
  keymodes: number[];
  accentColor: string | null;
  visual: SkinVisualSignature | null;
}

export interface SkinSimilarityMatch {
  score: number;
  // The candidate-side keymode of the best visual pairing, for fronting the
  // candidate's card with the render that actually matched. Null when the
  // score came from the accent fallback.
  matchKeys: number | null;
}

const VISUAL_WEIGHT = 0.7;
const KEYMODE_WEIGHT = 0.15;
const AUTHOR_WEIGHT = 0.15;

// Below this a pair shares no look worth showing; a slot in the strip would be
// filler, and an empty strip beats a misleading one.
export const SKIN_SIMILARITY_FLOOR = 0.35;

export function skinSimilarity(a: SkinSimilarityFacts, b: SkinSimilarityFacts): number {
  return skinSimilarityMatch(a, b).score;
}

// options.keys asks "similar at this keymode", which is what a skin page wants:
// the viewer is looking at one keymode's playfield, and a skin that matches
// only somewhere else in its range is not a lookalike of what is on screen.
// Skins routinely change shape between keymodes - bars at 7K, arrows at 4K -
// so the two questions have genuinely different answers.
export function skinSimilarityMatch(
  a: SkinSimilarityFacts,
  b: SkinSimilarityFacts,
  options?: { keys?: number | null },
): SkinSimilarityMatch {
  const visual = options?.keys != null ? visualMatchAt(a, b, options.keys) : visualMatch(a, b);
  return {
    score: VISUAL_WEIGHT * visual.sim
      + KEYMODE_WEIGHT * keymodeOverlap(a.keymodes, b.keymodes)
      + AUTHOR_WEIGHT * (sameAuthor(a.author, b.author) ? 1 : 0),
    matchKeys: visual.keys,
  };
}

// One keymode against the same keymode, and nothing else. A candidate that
// does not ship digested art for it scores zero rather than falling back to
// its other keymodes: at that point it is not comparable to what the viewer is
// looking at, and the floor drops it.
function visualMatchAt(a: SkinSimilarityFacts, b: SkinSimilarityFacts, keys: number): { sim: number; keys: number | null } {
  const artA = a.visual?.keymodes[String(keys)];
  // Nothing digested for the keymode on the page (an old upload, a screenshot
  // rather than a playfield render): the catalog-wide question is the only one
  // that can be answered, so answer that instead of nothing.
  if (!artA) return visualMatch(a, b);
  const artB = b.visual?.keymodes[String(keys)];
  if (!artB) return { sim: 0, keys: null };
  return { sim: keymodeVisualSimilarity(artA, artB), keys };
}

function visualMatch(a: SkinSimilarityFacts, b: SkinSimilarityFacts): { sim: number; keys: number | null } {
  const entriesA = a.visual ? Object.entries(a.visual.keymodes) : [];
  const entriesB = b.visual ? Object.entries(b.visual.keymodes) : [];
  if (entriesA.length > 0 && entriesB.length > 0) {
    // Keymodes are compared like with like, and every shared one counts: the
    // score is their weighted mean, not their best. Taking the best let a
    // single agreeable keymode carry a pair that matches nowhere else, and
    // low keymodes agree constantly - 1K is one sprite in one column, so
    // almost any two skins look alike there. The weights say the same thing
    // more quietly: 4K and 7K are what a mania skin is judged by, 1K-3K
    // barely count.
    const shared = entriesA
      .map(([keys, visual]) => ({ keys: Number(keys), visual, other: b.visual?.keymodes[keys] }))
      .filter((entry): entry is { keys: number; visual: SkinKeymodeVisual; other: SkinKeymodeVisual } => entry.other != null);
    if (shared.length > 0) {
      let weighted = 0;
      let weights = 0;
      for (const entry of shared) {
        const weight = keymodeJudgeWeight(entry.keys);
        weighted += weight * keymodeVisualSimilarity(entry.visual, entry.other);
        weights += weight;
      }
      return { sim: weights > 0 ? weighted / weights : 0, keys: displayKeymode(shared.map((entry) => entry.keys)) };
    }
    // Nothing in common to compare at (rare - most skins ship the whole
    // range), so the closest arts across keymodes stand in.
    let best: { sim: number; keys: number | null } = { sim: 0, keys: null };
    for (const [, visual] of entriesA) {
      for (const [keys, other] of entriesB) {
        const sim = keymodeVisualSimilarity(visual, other);
        if (sim > best.sim) best = { sim, keys: Number(keys) };
      }
    }
    return best;
  }
  // Accent-only fallback: colour without shape can neither fully confirm nor
  // fully deny a resemblance, so its range stays inside [0.25, 0.75] and two
  // unknowns sit at the middle of it.
  const colorA = parseHexColor(a.accentColor);
  const colorB = parseHexColor(b.accentColor);
  if (!colorA || !colorB) return { sim: 0.5, keys: null };
  return { sim: 0.25 + 0.5 * colorSimilarity(colorA, colorB), keys: null };
}

// How much a keymode says about what a skin looks like. 4K and 7K are the
// keymodes a mania skin is made for and judged by; the low ones draw one or
// two columns of a single sprite, which agrees across skins that have nothing
// else in common.
function keymodeJudgeWeight(keys: number): number {
  if (keys === 4 || keys === 7) return 1;
  if (keys === 5 || keys === 6 || keys === 8) return 0.6;
  if (keys === 9 || keys === 10) return 0.5;
  return 0.2;
}

// Which shared keymode the strip should front when the viewer has expressed no
// preference: the one a skin is recognised by, same convention as the card
// cover.
function displayKeymode(shared: number[]): number | null {
  return shared.find((keys) => keys === 4)
    ?? shared.find((keys) => keys === 7)
    ?? [...shared].sort((a, b) => keymodeJudgeWeight(b) - keymodeJudgeWeight(a) || a - b)[0]
    ?? null;
}

// Shape multiplies rather than adds: with it near zero, no colour agreement
// can rescue the pair, which is exactly the circles-recommended-for-bars
// failure this term exists to prevent.
//
// Colour then decides among everything shape cannot separate, which on a real
// catalog is most of it: round notes of near-identical proportions are the
// single largest family a mania catalog holds, so colour carries most of the
// range here rather than the token half it used to.
function keymodeVisualSimilarity(a: SkinKeymodeVisual, b: SkinKeymodeVisual): number {
  const shape = aspectSimilarity(a.aspect, b.aspect) * maskSimilarity(a.mask, b.mask);
  return shape * (0.25 + 0.75 * colorSimilarityOf(a, b));
}

function colorSimilarityOf(a: SkinKeymodeVisual, b: SkinKeymodeVisual): number {
  // How colourful the two are, before what colour they are: a white skin with
  // a hairline rim and a fully saturated one are not lookalikes even when the
  // rim happens to match.
  const chroma = 1 - Math.abs(a.sat - b.sat);
  // The rim/core colours when both sides have them, since that is what reads
  // at playfield size; the whole-sprite averages otherwise.
  const hues = a.accents.length > 0 && b.accents.length > 0
    ? paletteSimilarity(a.accents, b.accents)
    : paletteSimilarity(a.colors, b.colors);
  // Hue carries most of it: which colour a skin is separates far more of the
  // catalog than how much of the note is coloured, and weighting the two
  // evenly let a blue skin outrank a green one for a green skin purely
  // because their coloured area matched better.
  return 0.3 * chroma + 0.7 * hues;
}

function aspectSimilarity(a: number, b: number): number {
  if (!(a > 0) || !(b > 0)) return 0;
  return Math.min(a, b) / Math.max(a, b);
}

function maskSimilarity(a: string, b: string): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff += Math.abs(a.charCodeAt(index) - b.charCodeAt(index));
  }
  return 1 - diff / (9 * a.length);
}

// Symmetric best-match over the two palettes: every colour of A scored against
// its closest in B and vice versa, so a white/blue skin matches a blue/white
// one no matter which columns carry which.
function paletteSimilarity(a: string[], b: string[]): number {
  const parsedA = a.map(parseHexColor).filter((color): color is Hsv => color != null);
  const parsedB = b.map(parseHexColor).filter((color): color is Hsv => color != null);
  if (parsedA.length === 0 || parsedB.length === 0) return 0.5;
  const directed = (from: Hsv[], to: Hsv[]) =>
    from.reduce((sum, color) => sum + Math.max(...to.map((other) => colorSimilarity(color, other))), 0) / from.length;
  return (directed(parsedA, parsedB) + directed(parsedB, parsedA)) / 2;
}

interface Hsv {
  h: number;
  s: number;
  v: number;
}

function parseHexColor(value: string | null): Hsv | null {
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) return null;
  const r = parseInt(value.slice(1, 3), 16) / 255;
  const g = parseInt(value.slice(3, 5), 16) / 255;
  const b = parseInt(value.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta + 6) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

// Compared by hue first, because hue is what a player names a skin by: the
// green skin and the dark green skin are the same skin to the eye, and any
// distance measured straight in RGB (redmean included, which this replaced)
// calls them as far apart as green and blue because it counts brightness as
// heavily as colour. That is what left a green skin's recommendations blue.
function colorSimilarity(a: Hsv, b: Hsv): number {
  const ds = Math.abs(a.s - b.s);
  const dv = Math.abs(a.v - b.v);
  // Below a little saturation there is no hue worth comparing - the angle of a
  // grey is noise - so those pairs are judged on brightness instead, which is
  // what tells a white note from a black one.
  if (Math.min(a.s, b.s) < 0.2) return 1 - Math.min(1, 0.3 * ds + 0.7 * dv);
  const dh = Math.min(Math.abs(a.h - b.h), 360 - Math.abs(a.h - b.h)) / 180;
  return 1 - Math.min(1, 0.75 * dh + 0.15 * ds + 0.10 * dv);
}

// Jaccard over the keymode sets, so a 4K+7K skin half-matches a 4K-only one
// instead of either full credit or none.
function keymodeOverlap(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const shared = a.filter((keys) => setB.has(keys)).length;
  return shared / (new Set([...a, ...b]).size);
}

function sameAuthor(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

// The read side of visual_json: anything that is not exactly a well-formed v3
// signature reads as no signature (the earlier formats included, which the
// bumped backfill re-digests), so a bad or outdated blob degrades to the
// accent fallback instead of skewing scores.
export function normalizeSkinVisualSignature(value: unknown): SkinVisualSignature | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== 3 || !raw.keymodes || typeof raw.keymodes !== "object") return null;
  const keymodes: Record<string, SkinKeymodeVisual> = {};
  for (const [key, entry] of Object.entries(raw.keymodes as Record<string, unknown>)) {
    const keys = Number(key);
    if (!Number.isInteger(keys) || keys < 1 || keys > 10) return null;
    const visual = normalizeKeymodeVisual(entry);
    if (!visual) return null;
    keymodes[key] = visual;
  }
  if (Object.keys(keymodes).length === 0) return null;
  return { v: 3, keymodes };
}

function normalizeKeymodeVisual(value: unknown): SkinKeymodeVisual | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const aspect = Number(raw.aspect);
  if (!Number.isFinite(aspect) || aspect <= 0) return null;
  if (typeof raw.mask !== "string" || !/^[0-9]{64}$/.test(raw.mask)) return null;
  const sat = Number(raw.sat);
  if (!Number.isFinite(sat) || sat < 0 || sat > 1) return null;
  const colors = hexList(raw.colors);
  const accents = hexList(raw.accents);
  // Colours are required (every readable sprite has an average); accents are
  // legitimately empty on colourless art, but a malformed list is not.
  if (!colors || colors.length === 0 || !accents) return null;
  return { aspect, mask: raw.mask, colors, accents, sat };
}

function hexList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.filter((color): color is string => typeof color === "string" && /^#[0-9a-f]{6}$/.test(color));
  return list.length === value.length ? list.slice(0, 4) : null;
}
