import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { Check, Copy, Search, UserRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseManiaBeatmap } from "../../lib/beatmap-parser";
import { filterBeatmapSearchResults } from "../../lib/beatmap-search";
import { estimateDan } from "../../lib/dan-estimator";
import { estimateDanielDan } from "../../lib/daniel-estimator";
import { getBeatmapFile, getBeatmapset, getBeatmapsetForBeatmap, getUser, getUserScoresBestWindow, searchBeatmaps, searchBeatmapsByMappers } from "../../lib/osu";
import type { DanEstimate } from "../../lib/dan-estimator";
import type { OsuBeatmap, OsuBeatmapset, OsuScore } from "../../lib/types";
import { canUseDevFeatures } from "../../lib/auth-shared";

type DanClassifierId = "aleju" | "daniel";

const DAN_CLASSIFIERS: Array<{ id: DanClassifierId; label: string }> = [
  { id: "aleju", label: "aleju" },
  { id: "daniel", label: "Daniel" },
];

const DAN_IMAGE_EXTENSIONS: Record<string, "webp" | "svg"> = {
  "1": "svg",
  "2": "svg",
  "3": "svg",
  "4": "svg",
  "5": "svg",
  "6": "svg",
  "7": "svg",
  "8": "svg",
  "9": "svg",
  "10": "svg",
  alpha: "webp",
  beta: "webp",
  gamma: "webp",
  delta: "webp",
  epsilon: "webp",
  zeta: "webp",
  eta: "webp",
};
const NON_MAPPER_SEARCH_TOKENS = new Set([
  "4k",
  "7k",
  "9k",
  "dan",
  "map",
  "maps",
  "mania",
  "osu",
  "rate",
  "x",
]);

function extractMapperCandidates(query: string): string[] {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^[^\w[\]-]+|[^\w[\]-]+$/g, ""))
    .filter((token) => /^[\w[\]-]{3,24}$/.test(token))
    .filter((token) => !NON_MAPPER_SEARCH_TOKENS.has(token.toLowerCase()));
  const lastToken = tokens.at(-1);
  const likelyUserTokens = tokens.filter((token) => /[\d_[\]-]/.test(token));

  return [...new Set([...(lastToken ? [lastToken] : []), ...likelyUserTokens])].slice(0, 3);
}

function mergeBeatmapsets(...groups: OsuBeatmapset[][]): OsuBeatmapset[] {
  const beatmapsetsById = new Map<number, OsuBeatmapset>();
  for (const group of groups) {
    for (const beatmapset of group) {
      const existing = beatmapsetsById.get(beatmapset.id);
      if (!existing) {
        beatmapsetsById.set(beatmapset.id, beatmapset);
        continue;
      }

      const existingBeatmaps = existing.beatmaps ?? [];
      const beatmapsById = new Map(existingBeatmaps.map((beatmap) => [beatmap.id, beatmap]));
      for (const beatmap of beatmapset.beatmaps ?? []) {
        if (!beatmapsById.has(beatmap.id)) beatmapsById.set(beatmap.id, beatmap);
      }
      beatmapsetsById.set(beatmapset.id, {
        ...existing,
        beatmaps: [...beatmapsById.values()],
      });
    }
  }
  return [...beatmapsetsById.values()];
}

function topPlayScoresToBeatmapsets(scores: OsuScore[]): OsuBeatmapset[] {
  const beatmapsetsById = new Map<number, OsuBeatmapset>();
  const seenBeatmaps = new Set<number>();

  for (const score of scores) {
    const beatmap = score.beatmap;
    const beatmapset = score.beatmapset;
    if (!beatmap || !beatmapset || beatmap.mode !== "mania" || beatmap.cs !== 4 || seenBeatmaps.has(beatmap.id)) {
      continue;
    }

    seenBeatmaps.add(beatmap.id);
    const existing = beatmapsetsById.get(beatmapset.id);
    beatmapsetsById.set(beatmapset.id, {
      ...beatmapset,
      beatmaps: [...(existing?.beatmaps ?? []), beatmap],
    });
  }

  return [...beatmapsetsById.values()];
}

function extractBeatmapsetId(query: string): number | null {
  const beatmapsetUrlMatch = query.match(/beatmapsets\/(\d+)/i);
  const numericQueryMatch = query.trim().match(/^(\d{5,})$/);
  const id = Number(beatmapsetUrlMatch?.[1] ?? numericQueryMatch?.[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function extractBeatmapId(query: string): number | null {
  const beatmapUrlMatch = query.match(/(?:beatmaps\/|#mania\/)(\d+)/i);
  const numericQueryMatch = query.trim().match(/^(\d{5,})$/);
  const id = Number(beatmapUrlMatch?.[1] ?? numericQueryMatch?.[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function getDanImageSrc(label: string, family?: string): string | null {
  if (family === "ln" && /^(1[0-6]|[1-9])$/.test(label)) {
    return `/images/dans/ln/${label}.svg`;
  }

  const extension = DAN_IMAGE_EXTENSIONS[label];
  return extension ? `/images/dans/reform/${label}.${extension}` : null;
}

function isNumericDanLabel(label: string): boolean {
  return /^(10|[1-9])$/.test(label);
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false;

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const Route = createFileRoute("/admin/dan-classifier")({
  head: () => ({
    meta: [
      { title: "Dan Classifier - dev" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseDevFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: DanClassifierPage,
});

function DanClassifierPage() {
  const [query, setQuery] = useState("");
  const [playerQuery, setPlayerQuery] = useState("");
  const [rate, setRate] = useState(1);
  const [classifier, setClassifier] = useState<DanClassifierId>("aleju");
  const [results, setResults] = useState<OsuBeatmapset[]>([]);
  const [showingPlayerMaps, setShowingPlayerMaps] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [playerMapsLoading, setPlayerMapsLoading] = useState(false);
  const [loadedPlayerName, setLoadedPlayerName] = useState<string | null>(null);
  const [selectedSet, setSelectedSet] = useState<OsuBeatmapset | null>(null);
  const [selectedBeatmap, setSelectedBeatmap] = useState<OsuBeatmap | null>(null);
  const [estimate, setEstimate] = useState<DanEstimate | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [copiedBeatmapId, setCopiedBeatmapId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (query.trim().length < 2) {
      if (!showingPlayerMaps) {
        setResults([]);
      }
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        const directBeatmapsetId = extractBeatmapsetId(query);
        const directBeatmapId = extractBeatmapId(query);
        const [relevanceResponse, updatedResponse, directBeatmapset, directBeatmapParentSet] = await Promise.all([
          searchBeatmaps({
            data: {
              query,
              sort: "relevance_desc",
              status: "any",
            },
          }),
          searchBeatmaps({
            data: {
              query,
              sort: "updated_desc",
              status: "any",
            },
          }).catch(() => ({ beatmapsets: [] })),
          directBeatmapsetId
            ? getBeatmapset({ data: { beatmapsetId: directBeatmapsetId } }).catch(() => null)
            : Promise.resolve(null),
          directBeatmapId
            ? getBeatmapsetForBeatmap({ data: { beatmapId: directBeatmapId } }).catch(() => null)
            : Promise.resolve(null),
        ]);
        const mapperCandidates = extractMapperCandidates(query);
        const mapperResponse = mapperCandidates.length > 0
          ? await searchBeatmapsByMappers({ data: { usernames: mapperCandidates } })
          : { beatmapsets: [] };
        const searchedResults = filterBeatmapSearchResults(
          mergeBeatmapsets(relevanceResponse.beatmapsets, updatedResponse.beatmapsets, mapperResponse.beatmapsets),
          query,
        );
        setResults(mergeBeatmapsets(
          directBeatmapset ? [directBeatmapset] : [],
          directBeatmapParentSet ? [directBeatmapParentSet] : [],
          searchedResults,
        ).slice(0, 12));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not search beatmaps.");
      } finally {
        setSearchLoading(false);
      }
    }, 300);

    return () => clearTimeout(timerRef.current);
  }, [query, showingPlayerMaps]);

  useEffect(() => () => clearTimeout(copiedTimerRef.current), []);

  const selectedTitle = useMemo(() => {
    if (!selectedSet || !selectedBeatmap) return null;
    return `${selectedSet.artist} - ${selectedSet.title} [${selectedBeatmap.version}]`;
  }, [selectedBeatmap, selectedSet]);

  async function analyzeBeatmap(beatmapset: OsuBeatmapset, beatmap: OsuBeatmap, classifierId = classifier) {
    setSelectedSet(beatmapset);
    setSelectedBeatmap(beatmap);
    setEstimate(null);
    setError(null);
    setAnalysisLoading(true);

    try {
      const file = await getBeatmapFile({ data: { beatmapId: beatmap.id } });
      const parsed = parseManiaBeatmap(file.content);
      if (parsed.keyCount !== 4) {
        setError("Dan estimates are currently only supported for 4K beatmaps.");
        return;
      }

      const estimateInput = {
        starRating: beatmap.difficulty_rating,
        totalLength: beatmap.total_length,
        title: beatmapset.title,
        version: beatmap.version,
        rate,
      };
      setEstimate(classifierId === "daniel"
        ? estimateDanielDan(parsed, estimateInput)
        : estimateDan(parsed, estimateInput));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not analyze this beatmap.");
    } finally {
      setAnalysisLoading(false);
    }
  }

  async function loadPlayerTopPlayMaps() {
    const key = playerQuery.trim();
    if (key.length < 2) {
      setError("Enter a player username or ID.");
      return;
    }

    setPlayerMapsLoading(true);
    setError(null);

    try {
      const user = await getUser({ data: { key } });
      const scores = await getUserScoresBestWindow({ data: { userId: user.id, totalLimit: 100 } });
      const beatmapsets = topPlayScoresToBeatmapsets(scores);
      setLoadedPlayerName(user.username);
      setShowingPlayerMaps(true);
      setResults(beatmapsets);
      setQuery("");
      if (beatmapsets.length === 0) {
        setError(`${user.username} has no 4K mania maps in their top plays.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this player's top plays.");
    } finally {
      setPlayerMapsLoading(false);
    }
  }

  async function copyBeatmapId(beatmapId: number) {
    const copied = await copyTextToClipboard(String(beatmapId));
    if (!copied) return;

    setCopiedBeatmapId(beatmapId);
    clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopiedBeatmapId(null), 1200);
  }

  return (
    <main className="min-h-screen overflow-x-clip bg-osu-b5 text-osu-c1">
      <div className="max-w-[1200px] mx-auto px-4 py-7 sm:px-5 sm:py-10">
        <div className="pb-6 border-b border-osu-b3/30">
          <div className="text-[11px] uppercase tracking-[0.16em] text-osu-yellow font-bold">
            Admin
          </div>
          <h1 className="mt-1 text-2xl sm:text-3xl font-black text-white">
            Dan Classifier
          </h1>
          <div className="mt-2 text-sm text-osu-f1">
            Search a mania beatmap, fetch its .osu file, and estimate the dan range from chart pressure.
          </div>
        </div>

        <div className="mt-6 grid min-w-0 lg:grid-cols-[minmax(0,1fr)_360px] gap-6 items-start">
          <section className="min-w-0 rounded-lg border border-osu-b3/30 bg-osu-b4/35 p-4 sm:p-5">
            <div className="relative">
              <input
                type="text"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLoadedPlayerName(null);
                  setShowingPlayerMaps(false);
                  setError(null);
                }}
                placeholder="Search beatmap..."
                className="w-full px-4 py-3 rounded-lg bg-osu-b5 text-osu-c1 text-sm placeholder:text-osu-f1 border border-osu-b3/50 focus:border-osu-h1/40 focus:outline-none transition-colors shadow-[inset_0_1px_3px_rgba(0,0,0,0.3)]"
              />
              {searchLoading && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <div className="w-4 h-4 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                </div>
              )}
            </div>

            <div className="mt-3 flex items-center gap-3">
              <label className="text-[11px] uppercase tracking-wide text-osu-f1 font-bold" htmlFor="dan-rate">
                Rate
              </label>
              <input
                id="dan-rate"
                type="number"
                min="0.5"
                max="2"
                step="0.05"
                value={rate}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next)) setRate(Math.max(0.5, Math.min(2, next)));
                }}
                className="w-24 px-3 py-2 rounded-md bg-osu-b5 text-osu-c1 text-xs border border-osu-b3/50 focus:border-osu-h1/40 focus:outline-none"
              />
              <div className="text-xs text-osu-f1">x</div>
            </div>

            <div className="mt-3 flex items-center gap-3">
              <label className="text-[11px] uppercase tracking-wide text-osu-f1 font-bold" htmlFor="dan-classifier">
                Classifier
              </label>
              <select
                id="dan-classifier"
                value={classifier}
                onChange={(event) => {
                  const next = event.target.value as DanClassifierId;
                  setClassifier(next);
                  if (selectedSet && selectedBeatmap) void analyzeBeatmap(selectedSet, selectedBeatmap, next);
                }}
                className="w-32 px-3 py-2 rounded-md bg-osu-b5 text-osu-c1 text-xs border border-osu-b3/50 focus:border-osu-h1/40 focus:outline-none"
              >
                {DAN_CLASSIFIERS.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </div>

            <div className="mt-4 rounded-lg border border-osu-b3/30 bg-osu-b5/60 p-3">
              <label className="text-[11px] uppercase tracking-wide text-osu-f1 font-bold" htmlFor="dan-player-top-plays">
                Player top plays
              </label>
              <div className="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row">
                <div className="relative min-w-0 flex-1">
                  <UserRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-osu-f1" />
                  <input
                    id="dan-player-top-plays"
                    type="text"
                    value={playerQuery}
                    onChange={(event) => {
                      setPlayerQuery(event.target.value);
                      setError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void loadPlayerTopPlayMaps();
                    }}
                    placeholder="Username or ID..."
                    className="w-full rounded-md border border-osu-b3/50 bg-osu-b5 py-2 pl-9 pr-3 text-sm text-osu-c1 shadow-[inset_0_1px_3px_rgba(0,0,0,0.3)] transition-colors placeholder:text-osu-f1 focus:border-osu-h1/40 focus:outline-none"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void loadPlayerTopPlayMaps()}
                  disabled={playerMapsLoading}
                  className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-osu-pink/30 bg-osu-pink/20 px-3 text-xs font-black text-white transition-colors hover:border-osu-pink/60 hover:bg-osu-pink/30 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {playerMapsLoading ? (
                    <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                  Load 4K maps
                </button>
              </div>
              {loadedPlayerName && !playerMapsLoading ? (
                <div className="mt-2 text-[11px] text-osu-f1">
                  Showing 4K maps from {loadedPlayerName}'s top plays.
                </div>
              ) : null}
            </div>

            {error && (
              <div className="mt-4 rounded-lg border border-osu-red/30 bg-osu-red/10 px-4 py-3 text-sm text-osu-red">
                {error}
              </div>
            )}

            <div className="mt-5 space-y-3">
              {results.map((beatmapset) => {
                const maniaDiffs = (beatmapset.beatmaps ?? [])
                  .filter((beatmap) => beatmap.mode === "mania")
                  .sort((a, b) => a.cs - b.cs || a.difficulty_rating - b.difficulty_rating);
                const coverUrl = beatmapset.covers?.["cover@2x"] || beatmapset.covers?.cover;
                const copiedMapId = beatmapset.id;

                return (
                  <div key={beatmapset.id} className="relative min-w-0 overflow-hidden rounded-lg border border-osu-b3/30 bg-osu-b5">
                    {coverUrl && (
                      <img src={coverUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-35" loading="lazy" />
                    )}
                    <div className="absolute inset-0 bg-gradient-to-r from-osu-b5 via-osu-b5/90 to-osu-b5/65" />
                    <div className="relative p-4">
                      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-black text-white truncate">{beatmapset.title}</div>
                          <div className="mt-1 text-[11px] text-osu-f1 truncate">
                            {beatmapset.artist} // {beatmapset.creator}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void copyBeatmapId(copiedMapId)}
                            className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-white/10 bg-black/35 text-osu-l2 backdrop-blur-sm transition-colors hover:border-osu-l2/40 hover:bg-black/55 hover:text-white"
                            title={`Copy beatmapset ID ${copiedMapId}`}
                            aria-label={`Copy beatmapset ID ${copiedMapId}`}
                          >
                            {copiedBeatmapId === copiedMapId ? (
                              <Check className="h-3.5 w-3.5" strokeWidth={3} />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <a
                            href={`https://osu.ppy.sh/beatmapsets/${beatmapset.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] font-bold text-osu-l2 hover:text-white transition-colors"
                          >
                            osu!
                          </a>
                        </div>
                      </div>

                      <div className="mt-3 flex min-w-0 flex-wrap gap-1.5 overflow-hidden">
                        {maniaDiffs.map((beatmap) => (
                          <button
                            key={beatmap.id}
                            type="button"
                            onClick={() => analyzeBeatmap(beatmapset, beatmap)}
                            className={`inline-flex max-w-full min-w-0 items-center gap-1 overflow-hidden px-2.5 py-1 rounded-md text-left text-[11px] cursor-pointer transition-colors border backdrop-blur-sm ${
                              selectedBeatmap?.id === beatmap.id
                                ? "bg-osu-pink/30 border-osu-pink/60 text-white"
                                : "bg-black/40 hover:bg-black/60 border-white/10 text-white/90"
                            }`}
                          >
                            <span className="shrink-0 text-osu-yellow font-semibold">{beatmap.cs}K</span>
                            <span className="min-w-0 truncate">{beatmap.version.replace(/\s*\[\d+[Kk]\]\s*/g, " ").trim()}</span>
                            <span className="shrink-0 text-osu-l2">&#9733;{beatmap.difficulty_rating.toFixed(2)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}

              {!searchLoading && query.trim().length >= 2 && results.length === 0 && (
                <div className="py-12 text-center text-sm text-osu-f1">No mania beatmaps found.</div>
              )}

              {query.trim().length < 2 && results.length === 0 && (
                <div className="py-12 text-center text-sm text-osu-f1">Start typing to search osu!mania maps.</div>
              )}
            </div>
          </section>

          <aside className="min-w-0 rounded-lg border border-osu-b3/30 bg-osu-b4/35 p-4 sm:p-5 lg:sticky lg:top-24">
            <div className="text-[11px] uppercase tracking-[0.14em] text-osu-f1 font-bold">Estimate</div>
            <div className="mt-1 text-[11px] font-bold text-osu-yellow">
              {DAN_CLASSIFIERS.find((option) => option.id === classifier)?.label}
            </div>
            {analysisLoading ? (
              <div className="mt-8 flex flex-col items-center gap-3 py-10">
                <div className="w-7 h-7 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                <div className="text-sm text-osu-f1">Analyzing .osu file...</div>
              </div>
            ) : estimate ? (
              <div className="mt-4 min-w-0">
                <div className="text-sm text-osu-f1 truncate">{selectedTitle}</div>
                <div className="mt-4 flex items-center gap-4">
                  {getDanImageSrc(estimate.label, estimate.family) ? (
                    <img
                      src={getDanImageSrc(estimate.label, estimate.family) ?? undefined}
                      alt=""
                      className="h-16 w-16 shrink-0 object-contain drop-shadow-[0_10px_24px_rgba(0,0,0,0.45)] sm:h-20 sm:w-20"
                    />
                  ) : null}
                  <div className="min-w-0">
                    {!isNumericDanLabel(estimate.label) && (
                      <div className="truncate text-3xl font-black leading-none text-white sm:text-4xl">{estimate.displayName}</div>
                    )}
                    <div className={`${isNumericDanLabel(estimate.label) ? "" : "mt-2"} text-sm font-bold text-osu-yellow`}>
                      {estimate.family}
                    </div>
                  </div>
                </div>
                <div className="mt-2 text-sm text-osu-f1">
                  SR proxy {estimate.estimatedSr.toFixed(2)} · raw dan {estimate.rawDan.toFixed(2)}
                </div>

                <div className="mt-5 grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
                  <Metric label="Notes" value={estimate.metrics.noteCount.toLocaleString()} />
                  <Metric label="Keys" value={`${estimate.metrics.keyCount}K`} />
                  <Metric label="Peak 5s" value={`${estimate.metrics.peakNps5s.toFixed(1)} n/s`} />
                  <Metric label="Sustain 10s" value={`${estimate.metrics.sustainedNps10s.toFixed(1)} n/s`} />
                  <Metric label="Chords" value={`${Math.round(estimate.metrics.chordRatio * 100)}%`} />
                  <Metric label="LNs" value={`${Math.round(estimate.metrics.holdRatio * 100)}%`} />
                </div>

                <div className="mt-5 space-y-2">
                  {(() => {
                    const scores = Object.entries(estimate.skillScores)
                      .filter(([skill]) => skill !== "dan") as Array<[string, number]>;
                    const values = scores.map(([, score]) => score);
                    const minScore = Math.min(...values);
                    const maxScore = Math.max(...values);
                    const spread = Math.max(0.001, maxScore - minScore);

                    return scores.map(([skill, score]) => (
                      <div key={skill}>
                        <div className="flex justify-between text-[11px] font-bold text-osu-f1">
                          <span className="capitalize">{skill}</span>
                          <span>{score.toFixed(2)}</span>
                        </div>
                        <div className="mt-1 h-1.5 rounded-full bg-osu-b5 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-osu-pink"
                            style={{ width: `${Math.min(100, Math.max(4, ((score - minScore) / spread) * 96 + 4))}%` }}
                          />
                        </div>
                      </div>
                    ));
                  })()}
                </div>

                {estimate.warnings.length > 0 && (
                  <div className="mt-5 rounded-lg border border-osu-yellow/25 bg-osu-yellow/10 px-3 py-2 text-[11px] text-osu-yellow">
                    {estimate.warnings.join(" ")}
                  </div>
                )}

                {selectedSet && selectedBeatmap && (
                  <Link
                    to="/replay"
                    search={{ tab: "beatmap" }}
                    className="mt-5 block text-center px-3 py-2 rounded-lg bg-osu-b5 text-[11px] font-bold text-osu-l2 border border-osu-b3/40 hover:text-white hover:border-osu-b3 transition-colors"
                  >
                    Find replays for this map
                  </Link>
                )}
              </div>
            ) : (
              <div className="mt-8 py-10 text-center text-sm text-osu-f1">
                Pick a difficulty to estimate its dan.
              </div>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-osu-b5 border border-osu-b3/30 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-osu-f1 font-bold">{label}</div>
      <div className="mt-1 truncate text-sm font-black text-white">{value}</div>
    </div>
  );
}
