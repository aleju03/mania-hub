import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseManiaBeatmap } from "../../lib/beatmap-parser";
import { filterBeatmapSearchResults } from "../../lib/beatmap-search";
import { estimateDan } from "../../lib/dan-estimator";
import { getBeatmapFile, searchBeatmaps, searchBeatmapsByMappers } from "../../lib/osu";
import type { DanEstimate } from "../../lib/dan-estimator";
import type { OsuBeatmap, OsuBeatmapset } from "../../lib/types";

const DAN_IMAGE_EXTENSIONS: Record<string, "png" | "svg"> = {
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
  alpha: "png",
  beta: "png",
  gamma: "png",
  delta: "png",
  epsilon: "png",
  zeta: "png",
  eta: "png",
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
      if (!beatmapsetsById.has(beatmapset.id)) beatmapsetsById.set(beatmapset.id, beatmapset);
    }
  }
  return [...beatmapsetsById.values()];
}

function getDanImageSrc(label: string): string | null {
  const extension = DAN_IMAGE_EXTENSIONS[label];
  return extension ? `/images/dans/reform/${label}.${extension}` : null;
}

function isNumericDanLabel(label: string): boolean {
  return /^(10|[1-9])$/.test(label);
}

export const Route = createFileRoute("/admin/dan-classifier")({
  head: () => ({
    meta: [
      { title: "Dan Classifier - dev" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: () => {
    if (typeof window !== "undefined") {
      const host = window.location.hostname;
      const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
      const isDevMode = import.meta.env.VITE_DEV_MODE === "1";
      if (!isLocal && !isDevMode) throw notFound();
    } else if (process.env.VITE_DEV_MODE !== "1" && process.env.NODE_ENV === "production") {
      throw notFound();
    }
  },
  component: DanClassifierPage,
});

function DanClassifierPage() {
  const [query, setQuery] = useState("");
  const [rate, setRate] = useState(1);
  const [results, setResults] = useState<OsuBeatmapset[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedSet, setSelectedSet] = useState<OsuBeatmapset | null>(null);
  const [selectedBeatmap, setSelectedBeatmap] = useState<OsuBeatmap | null>(null);
  const [estimate, setEstimate] = useState<DanEstimate | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        const response = await searchBeatmaps({
          data: {
            query,
            sort: "relevance_desc",
            status: "any",
          },
        });
        const mapperCandidates = extractMapperCandidates(query);
        const mapperResponse = mapperCandidates.length > 0
          ? await searchBeatmapsByMappers({ data: { usernames: mapperCandidates } })
          : { beatmapsets: [] };
        setResults(filterBeatmapSearchResults(
          mergeBeatmapsets(response.beatmapsets, mapperResponse.beatmapsets),
          query,
        ).slice(0, 12));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not search beatmaps.");
      } finally {
        setSearchLoading(false);
      }
    }, 300);

    return () => clearTimeout(timerRef.current);
  }, [query]);

  const selectedTitle = useMemo(() => {
    if (!selectedSet || !selectedBeatmap) return null;
    return `${selectedSet.artist} - ${selectedSet.title} [${selectedBeatmap.version}]`;
  }, [selectedBeatmap, selectedSet]);

  async function analyzeBeatmap(beatmapset: OsuBeatmapset, beatmap: OsuBeatmap) {
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

      setEstimate(estimateDan(parsed, {
        starRating: beatmap.difficulty_rating,
        totalLength: beatmap.total_length,
        title: beatmapset.title,
        version: beatmap.version,
        rate,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not analyze this beatmap.");
    } finally {
      setAnalysisLoading(false);
    }
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-osu-b5 text-osu-c1">
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
                        <a
                          href={`https://osu.ppy.sh/beatmapsets/${beatmapset.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] font-bold text-osu-l2 hover:text-white transition-colors"
                        >
                          osu!
                        </a>
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

              {query.trim().length < 2 && (
                <div className="py-12 text-center text-sm text-osu-f1">Start typing to search osu!mania maps.</div>
              )}
            </div>
          </section>

          <aside className="min-w-0 rounded-lg border border-osu-b3/30 bg-osu-b4/35 p-4 sm:p-5 lg:sticky lg:top-24">
            <div className="text-[11px] uppercase tracking-[0.14em] text-osu-f1 font-bold">Estimate</div>
            {analysisLoading ? (
              <div className="mt-8 flex flex-col items-center gap-3 py-10">
                <div className="w-7 h-7 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
                <div className="text-sm text-osu-f1">Analyzing .osu file...</div>
              </div>
            ) : estimate ? (
              <div className="mt-4 min-w-0">
                <div className="text-sm text-osu-f1 truncate">{selectedTitle}</div>
                <div className="mt-4 flex items-center gap-4">
                  {getDanImageSrc(estimate.label) ? (
                    <img
                      src={getDanImageSrc(estimate.label) ?? undefined}
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
                  SR proxy {estimate.estimatedSr.toFixed(2)} · raw dan {estimate.rawDan.toFixed(2)} · confidence {Math.round(estimate.confidence * 100)}%
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
