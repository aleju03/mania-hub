import type { Db } from "../db.js";
import { exec } from "../db.js";
import { parseManiaBeatmap, type ManiaBeatmap, type ManiaNote } from "../dan/beatmap-parser.js";
import { readCachedBeatmapFile } from "../osu/beatmap-file-cache.js";

// The chart snippets behind rendered skin previews. A skin preview is a frozen
// playfield, and it used to be a synthetic pattern seeded by the key count
// alone, so every skin on the browse page showed the same dozen notes in the
// same places. These snippets are cut out of real charts instead: the densest
// showcase moment of a high-star map we already have the .osu for, complete
// with a hold running through the judgement line so the receptor under it
// renders pressed.
//
// Nothing here downloads anything. Candidates come from the .osu files already
// in beatmap_osu_files, and a chart with no cached copy is simply not a
// candidate, so a draw costs a gunzip and a parse rather than an osu! API
// round trip.

export interface SkinPreviewPatternNote {
  column: number;
  // Milliseconds from the frozen instant sitting on the judgement line.
  // Negative only for a hold already being held at that instant.
  time: number;
  // Same as `time` for a tap.
  endTime: number;
}

export interface SkinPreviewPatternSnippet {
  beatmapId: number;
  keys: number;
  // "Artist - Title [Difficulty]", for the picker's tooltip.
  label: string;
  stars: number;
  notes: SkinPreviewPatternNote[];
}

// How much chart the snippet carries. The card only ever shows the first few
// hundred milliseconds of it (the client picks a scroll speed that keeps notes
// from overlapping, so a dense chart shows less time than a sparse one); the
// rest is headroom so a slow chart still fills the field.
export const SNIPPET_SPAN_MS = 2200;

// The stretch of chart the anchor is scored over: roughly what a comfortable
// scroll speed puts on screen at once. Notes past it barely register on the
// card, so they should not decide where the snippet is cut from.
const SCORE_WINDOW_MS = 700;

// A same-column gap tighter than this is vibro or a stack, and a still frame of
// it is a smear rather than a pattern. Anchors that lead with one are pushed
// down the list, not banned: some charts are nothing but.
const TIGHT_GAP_MS = 45;

// Snippets thinner than this leave the field looking empty next to the
// synthetic pattern they replace, so the caller moves on to another chart.
const MIN_SNIPPET_NOTES = 7;

function isHold(note: ManiaNote): boolean {
  return note.endTime > note.time;
}

// Where a column is next free after this note: a tap occupies its own instant,
// a hold occupies through its tail.
function occupiedUntil(note: ManiaNote): number {
  return Math.max(note.time, note.endTime);
}

interface ScoredAnchor {
  time: number;
  score: number;
}

// Scores every note time in the chart as a candidate "now" and returns the best
// one. The score is what the card actually shows: notes near the line, columns
// in play, a hold crossing the line (pressed receptor plus a body), and holds
// close enough to still be on screen.
function pickAnchor(notes: ManiaNote[], keys: number): ScoredAnchor | null {
  if (notes.length === 0) return null;
  let best: ScoredAnchor | null = null;
  // Sliding bound over the scoring window; it only ever moves forward.
  let windowEnd = 0;
  for (let index = 0; index < notes.length; index += 1) {
    const anchor = notes[index].time;
    if (index > 0 && anchor === notes[index - 1].time) continue;
    while (windowEnd < notes.length && notes[windowEnd].time <= anchor + SCORE_WINDOW_MS) windowEnd += 1;

    const columns = new Set<number>();
    const rows = new Set<number>();
    let visible = 0;
    let holds = 0;
    let tightest = Number.POSITIVE_INFINITY;
    // Last note seen per column, to measure how tightly the window jacks.
    const lastInColumn = new Map<number, number>();
    for (let scan = index; scan < windowEnd; scan += 1) {
      const note = notes[scan];
      if (note.column < 0 || note.column >= keys) continue;
      visible += 1;
      columns.add(note.column);
      rows.add(note.time);
      if (isHold(note)) holds += 1;
      const previous = lastInColumn.get(note.column);
      if (previous != null) tightest = Math.min(tightest, note.time - previous);
      lastInColumn.set(note.column, occupiedUntil(note));
    }
    if (visible === 0) continue;

    // A hold that started earlier and has not ended is the one being held at
    // this instant, which is what puts a lit receptor on the card.
    let held = 0;
    for (let scan = index - 1; scan >= 0; scan -= 1) {
      const note = notes[scan];
      if (anchor - note.time > SNIPPET_SPAN_MS) break;
      if (isHold(note) && note.endTime > anchor && note.column >= 0 && note.column < keys) held += 1;
    }

    // Distinct rows count for more than raw notes: a wall of chords fills a
    // card with the same shape repeated, while the same note budget spread
    // over more rows reads as an actual pattern.
    const score = rows.size * 2
      + visible * 0.6
      + columns.size * 1.5
      + Math.min(holds, 4) * 2.5
      // A hold crossing the line is the whole reason a preview can show a lit
      // receptor with a body running out of it, so it outweighs a couple of
      // extra notes - but not a genuinely busier frame.
      + Math.min(held, 2) * 9
      + (tightest < TIGHT_GAP_MS ? -8 : 0);
    if (!best || score > best.score) best = { time: anchor, score };
  }
  return best;
}

export interface ShowcaseSnippet {
  keys: number;
  notes: SkinPreviewPatternNote[];
}

// Cuts the showcase moment out of a parsed chart. Null when the chart has no
// usable key count or is too thin to fill a card.
export function extractShowcaseSnippet(beatmap: ManiaBeatmap): ShowcaseSnippet | null {
  const keys = Math.floor(beatmap.keyCount);
  if (!Number.isFinite(keys) || keys < 1 || keys > 18) return null;
  const notes = [...beatmap.notes]
    .filter((note) => note.column >= 0 && note.column < keys && Number.isFinite(note.time))
    .sort((a, b) => a.time - b.time || a.column - b.column);
  if (notes.length < MIN_SNIPPET_NOTES) return null;

  const anchor = pickAnchor(notes, keys);
  if (!anchor) return null;

  const cut: SkinPreviewPatternNote[] = [];
  for (const note of notes) {
    const time = note.time - anchor.time;
    const endTime = Math.max(note.endTime, note.time) - anchor.time;
    if (time > SNIPPET_SPAN_MS) break;
    // Everything already past the line is gone from the field, except the hold
    // still being held through it. The tap sitting exactly on the line is the
    // one being hit, and it is why the anchor is a note time at all.
    if (endTime > time ? endTime <= 0 : time < 0) continue;
    cut.push({ column: note.column, time: Math.round(time), endTime: Math.round(endTime) });
  }
  if (cut.length < MIN_SNIPPET_NOTES) return null;
  return { keys, notes: cut };
}

interface PatternCandidate {
  beatmapId: number;
  keys: number;
  stars: number;
  label: string;
}

// Charts worth cutting from: the star floor keeps the pool on maps dense enough
// to have a showcase moment at all, and ranked/loved keeps it on charts people
// recognise. Both are relaxed in turn when a keymode has too few (5K and 9K
// barely exist ranked), because a thin pool is what made the previews
// repetitive in the first place.
const CANDIDATE_TIERS = [
  { minStars: 5, rankedOnly: true },
  { minStars: 5, rankedOnly: false },
  { minStars: 3.5, rankedOnly: false },
] as const;

const CANDIDATE_POOL_SIZE = 300;
const CANDIDATE_MIN_POOL = 40;
const CANDIDATE_TTL_MS = 30 * 60_000;

interface CandidateCacheEntry {
  candidates: PatternCandidate[];
  loadedAt: number;
}

const candidateCache = new Map<number, CandidateCacheEntry>();

async function queryCandidates(db: Db, keys: number, tier: (typeof CANDIDATE_TIERS)[number]): Promise<PatternCandidate[]> {
  const result = await exec(
    db,
    `select f.beatmap_id as beatmap_id,
            b.difficulty_rating as stars,
            b.version as version,
            s.artist as artist,
            s.title as title
       from beatmap_osu_files f
       join maps_beatmaps b on b.beatmap_id = f.beatmap_id
       left join maps_beatmapsets s on s.beatmapset_id = b.beatmapset_id
      where f.error is null
        and b.mode = 'mania'
        and cast(b.cs as int) = ?
        and b.difficulty_rating >= ?
        ${tier.rankedOnly ? "and b.status in ('ranked', 'loved')" : ""}
      order by random()
      limit ?`,
    [keys, tier.minStars, CANDIDATE_POOL_SIZE],
  ).catch(() => ({ rows: [] as Record<string, unknown>[] }));

  return result.rows.map((row) => {
    const artist = row.artist == null ? "" : String(row.artist);
    const title = row.title == null ? "" : String(row.title);
    const version = row.version == null ? "" : String(row.version);
    const song = [artist, title].filter(Boolean).join(" - ");
    return {
      beatmapId: Number(row.beatmap_id),
      keys,
      stars: Number(row.stars) || 0,
      label: version ? `${song} [${version}]`.trim() : song,
    };
  }).filter((candidate) => Number.isFinite(candidate.beatmapId) && candidate.beatmapId > 0);
}

async function loadCandidates(db: Db, keys: number): Promise<PatternCandidate[]> {
  const cached = candidateCache.get(keys);
  if (cached && Date.now() - cached.loadedAt < CANDIDATE_TTL_MS) return cached.candidates;

  let candidates: PatternCandidate[] = [];
  for (const tier of CANDIDATE_TIERS) {
    candidates = await queryCandidates(db, keys, tier);
    if (candidates.length >= CANDIDATE_MIN_POOL) break;
  }
  candidateCache.set(keys, { candidates, loadedAt: Date.now() });
  return candidates;
}

// Extracted snippets, keyed by beatmap. A snippet is a few hundred bytes and
// the extraction is a gunzip plus a parse, so the same chart coming back around
// in a later draw costs nothing.
const snippetCache = new Map<number, SkinPreviewPatternSnippet | null>();
const SNIPPET_CACHE_MAX = 400;

function rememberSnippet(beatmapId: number, snippet: SkinPreviewPatternSnippet | null): void {
  if (snippetCache.size >= SNIPPET_CACHE_MAX) {
    const oldest = snippetCache.keys().next().value;
    if (oldest !== undefined) snippetCache.delete(oldest);
  }
  snippetCache.set(beatmapId, snippet);
}

async function snippetFor(db: Db, candidate: PatternCandidate): Promise<SkinPreviewPatternSnippet | null> {
  if (snippetCache.has(candidate.beatmapId)) return snippetCache.get(candidate.beatmapId) ?? null;
  const content = await readCachedBeatmapFile(db, candidate.beatmapId).catch(() => null);
  if (!content) {
    rememberSnippet(candidate.beatmapId, null);
    return null;
  }
  let snippet: SkinPreviewPatternSnippet | null = null;
  try {
    const extracted = extractShowcaseSnippet(parseManiaBeatmap(content));
    // The catalog's key count and the chart's own can disagree (a converted or
    // mis-tagged diff); the chart wins, and a mismatch drops out of this draw.
    if (extracted && extracted.keys === candidate.keys) {
      snippet = {
        beatmapId: candidate.beatmapId,
        keys: extracted.keys,
        label: candidate.label,
        stars: Math.round(candidate.stars * 100) / 100,
        notes: extracted.notes,
      };
    }
  } catch {
    snippet = null;
  }
  rememberSnippet(candidate.beatmapId, snippet);
  return snippet;
}

export interface DrawPreviewPatternsOptions {
  keys: number;
  count: number;
  // Beatmap ids already on offer, so a reshuffle hands back different charts.
  exclude?: Iterable<number>;
}

// Deals `count` snippets for a keymode. Charts whose cached .osu turns out to
// be unparseable or too thin are skipped, so the pool is as long as the draw
// allows rather than padded.
export async function drawPreviewPatterns(db: Db, options: DrawPreviewPatternsOptions): Promise<SkinPreviewPatternSnippet[]> {
  const keys = Math.floor(options.keys);
  if (!Number.isFinite(keys) || keys < 1 || keys > 18) return [];
  const count = Math.max(1, Math.min(24, Math.floor(options.count) || 1));
  const exclude = new Set(options.exclude ?? []);
  const candidates = await loadCandidates(db, keys);
  if (candidates.length === 0) return [];

  const order = shuffled(candidates.filter((candidate) => !exclude.has(candidate.beatmapId)));
  const snippets: SkinPreviewPatternSnippet[] = [];
  // Bounded so a run of unparseable charts cannot turn one request into three
  // hundred gunzips.
  const attempts = Math.min(order.length, count * 4);
  for (let index = 0; index < attempts && snippets.length < count; index += 1) {
    const snippet = await snippetFor(db, order[index]);
    if (snippet) snippets.push(snippet);
  }
  return snippets;
}

function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
}

// Test seam: both caches are process-wide and would otherwise leak between
// cases.
export function resetPreviewPatternCaches(): void {
  candidateCache.clear();
  snippetCache.clear();
}
