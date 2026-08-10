import { getLiveBackendUrl } from "./live-backend";

// The pool of chart snippets a rendered skin preview can be drawn from.
//
// Every preview used to be the same synthetic pattern seeded by the key count,
// so a page of browse cards was the same notes in the same places under
// different art. The backend cuts these snippets out of the .osu files it
// already caches - the showcase moment of a high-star chart, taps and holds and
// a receptor being pressed - and an uploader picks the one their skin looks
// best under. The synthetic layout stays as the fallback for when the backend
// has nothing for a keymode (`null` everywhere a snippet is expected).

export interface SkinPreviewChartNote {
  column: number;
  // Milliseconds from the frozen instant on the judgement line. Negative only
  // for a hold already being held there.
  time: number;
  // Same as `time` for a tap.
  endTime: number;
}

export interface SkinPreviewChartSnippet {
  beatmapId: number;
  keys: number;
  // "Artist - Title [Difficulty]", for the picker's tooltip.
  label: string;
  stars: number;
  notes: SkinPreviewChartNote[];
}

// How many snippets the picker offers per draw. Smaller than the backdrop pool:
// each one is a chart parse on the backend, and the thumbnails are big enough
// to read that a dozen would crowd the row.
export const SKIN_PATTERN_POOL_SIZE = 8;

export interface DrawSkinPreviewPatternsOptions {
  keys: number;
  count?: number;
  // Charts already on offer, so a shuffle hands back different ones.
  exclude?: Iterable<number>;
  signal?: AbortSignal;
}

// Draws a pool for one keymode. Every failure mode (no backend configured,
// unreachable, rate limited, a keymode nothing is cached for) is an empty pool,
// which leaves the synthetic pattern in place.
export async function drawSkinPreviewPatterns(
  options: DrawSkinPreviewPatternsOptions,
): Promise<SkinPreviewChartSnippet[]> {
  const base = getLiveBackendUrl();
  if (!base) return [];
  const keys = Math.floor(options.keys);
  if (!Number.isFinite(keys) || keys < 1 || keys > 18) return [];
  const query = new URLSearchParams({
    keys: String(keys),
    count: String(Math.max(1, options.count ?? SKIN_PATTERN_POOL_SIZE)),
  });
  const exclude = [...(options.exclude ?? [])].filter((id) => Number.isInteger(id) && id > 0).slice(0, 64);
  if (exclude.length) query.set("exclude", exclude.join(","));
  try {
    const response = await fetch(`${base}/api/skins/preview-patterns?${query.toString()}`, {
      credentials: "omit",
      signal: options.signal,
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { patterns?: SkinPreviewChartSnippet[] };
    return Array.isArray(body.patterns) ? body.patterns.filter((snippet) => snippet?.notes?.length > 0) : [];
  } catch {
    return [];
  }
}

// Hands out one snippet at a time per keymode without repeating until the pool
// runs dry, the way BackdropDealer does with covers: a bulk upload of twenty
// skins should not land on the same three charts.
export class PatternDealer {
  private readonly decks = new Map<number, SkinPreviewChartSnippet[]>();
  private readonly pools = new Map<number, SkinPreviewChartSnippet[]>();
  private readonly draws = new Map<number, Promise<SkinPreviewChartSnippet[]>>();

  // The pool for a keymode is drawn once and shared by everything that asks
  // for it afterwards, including the calls racing the first one.
  private async pool(keys: number): Promise<SkinPreviewChartSnippet[]> {
    const loaded = this.pools.get(keys);
    if (loaded) return loaded;
    const pending = this.draws.get(keys);
    if (pending) return pending;
    const drawing = drawSkinPreviewPatterns({ keys })
      .then((pool) => {
        this.pools.set(keys, pool);
        return pool;
      })
      .finally(() => this.draws.delete(keys));
    this.draws.set(keys, drawing);
    return drawing;
  }

  async next(keys: number): Promise<SkinPreviewChartSnippet | null> {
    const pool = await this.pool(keys);
    if (pool.length === 0) return null;
    let deck = this.decks.get(keys);
    // Reshuffled on each pass, so a queue longer than the pool does not repeat
    // the same order twice.
    if (!deck || deck.length === 0) {
      deck = shuffle(pool);
      this.decks.set(keys, deck);
    }
    return deck.pop() ?? null;
  }
}

export function shuffleSnippets(snippets: readonly SkinPreviewChartSnippet[]): SkinPreviewChartSnippet[] {
  return shuffle(snippets);
}

function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
}
