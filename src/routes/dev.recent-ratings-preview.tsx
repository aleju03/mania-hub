import { useEffect, useState } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { PageHeader } from "#/components/layout/PageHeader";
import { ScoreDetailModal, ScoreRow } from "#/components/player/ScoreRows";
import type { RecentPlayRatingView } from "#/components/player/recent-play-ratings";
import type { LiveRecentRatingMissingReason } from "#/lib/live-backend";
import type { OsuScore } from "#/lib/types";

// Local, interactive fixtures rendered by the real profile components.
// No score/rating API calls and no changes to the viewer's saved preferences.
export const Route = createFileRoute("/dev/recent-ratings-preview")({
  beforeLoad: () => { if (!import.meta.env.DEV) throw notFound(); },
  head: () => ({ meta: [{ title: "Recent ratings preview" }, { name: "robots", content: "noindex, nofollow" }] }),
  component: RecentRatingsPreview,
});

const READY: RecentPlayRatingView = { msd: 27.52, dan: { rawDan: 9.2, label: "9", side: "rc" } };
const PENDING: RecentPlayRatingView = { msd: null, dan: null, pending: true, missing: { msd: "pending", dan: "pending" } };
const PARTIAL: RecentPlayRatingView = { ...PENDING, dan: READY.dan, missing: { msd: "pending" } };
const UNAVAILABLE: RecentPlayRatingView = { msd: null, dan: null, missing: { msd: "not_retained", dan: "not_analyzed" } };
const REASONS: Array<{ value: LiveRecentRatingMissingReason; label: string }> = [
  { value: "not_retained", label: "Weaker repeat / no saved MSD" },
  { value: "below_floor", label: "Accuracy below the MSD minimum" },
  { value: "excluded", label: "Excluded from skill ratings" },
  { value: "failed_play", label: "Failed play" },
  { value: "chart_changed", label: "Chart changed after the play" },
  { value: "unsupported", label: "Unsupported chart or mods" },
  { value: "not_analyzed", label: "No analysis scheduled" },
];
const BUTTON = "rounded-lg border border-osu-b3 bg-osu-b4 px-3 py-2 text-xs font-semibold text-osu-l2 transition-colors hover:bg-osu-b3 focus-visible:outline-osu-pink-light";

function exampleScore(index: number, title = "Midnight Circuit"): OsuScore {
  const cover = "/images/headers/generic.jpg";
  return {
    id: 0, user_id: 0, mode: "mania", accuracy: 0.9943, score: 984532,
    max_combo: 2590, passed: true, rank: "S", mods: [], pp: 344,
    statistics: { count_geki: 2400, count_300: 160, count_katu: 20, count_100: 8, count_50: 2, count_miss: 0 },
    ended_at: "2026-09-23T21:00:00Z", has_replay: false,
    user: { id: 0, username: "Preview player", avatar_url: "", country_code: "CR" },
    beatmap: {
      id: 0, beatmapset_id: 0, difficulty_rating: 5.8, mode: "mania", status: "ranked",
      total_length: 180, cs: 4, drain: 6, accuracy: 8, ar: 5, bpm: 180, convert: false,
      count_circles: 2590, count_sliders: 0, count_spinners: 0, version: "4K / Expert", url: "",
    },
    beatmapset: {
      id: 0, title, artist: `Example track ${index}`, creator: "Preview", user_id: 0,
      covers: { cover, "cover@2x": cover, card: cover, "card@2x": cover, list: cover, "list@2x": cover, slimcover: cover, "slimcover@2x": cover },
      status: "ranked", play_count: 0, favourite_count: 0, submitted_date: "", ranked_date: null, last_updated: "", bpm: 180, preview_url: "",
    },
  };
}

function RecentRatingsPreview() {
  const [enabled, setEnabled] = useState(true);
  const [stage, setStage] = useState<"idle" | "loading" | "pending" | "ready">("idle");
  const [retryStage, setRetryStage] = useState<"error" | "loading" | "ready">("error");
  const [reason, setReason] = useState<LiveRecentRatingMissingReason>("not_retained");
  const [detail, setDetail] = useState<OsuScore | null>(null);
  useEffect(() => {
    if (stage !== "loading" && stage !== "pending") return;
    const timer = setTimeout(() => setStage(stage === "loading" ? "pending" : "ready"), stage === "loading" ? 900 : 3500);
    return () => clearTimeout(timer);
  }, [stage]);
  useEffect(() => {
    if (retryStage !== "loading") return;
    const timer = setTimeout(() => setRetryStage("ready"), 1000);
    return () => clearTimeout(timer);
  }, [retryStage]);
  const retry: RecentPlayRatingView | undefined = retryStage === "error"
    ? { msd: null, dan: READY.dan, loadError: true, onRetry: () => setRetryStage("loading") }
    : retryStage === "ready" ? READY : undefined;
  const row = (index: number, rating: RecentPlayRatingView | undefined, title?: string) => (
    <ScoreRow score={exampleScore(index, title)} position={index} layout={{ modColumns: 0, showPp: true, showReplay: false }}
      showRating={enabled} rating={rating} onOpenDetails={setDetail} />
  );

  return <div className="min-h-screen bg-osu-b5">
    <PageHeader iconSrc="/images/icons/beatmapsets.svg" title="Recent plays · rating preview"
      right={<span className="rounded bg-osu-pink/15 px-2 py-1 text-[10px] font-semibold text-osu-pink-light">Local preview · example data</span>} />
    <main className="mx-auto max-w-[1100px] space-y-8 px-4 py-7 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-osu-l1">Try every rating state</h1>
          <p className="mt-1 text-sm text-osu-f1">Tap or hover a status for its explanation. These are the same rows used on profiles.</p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-osu-l2">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="accent-osu-pink" />
          Show ratings
        </label>
      </div>

      <section className="space-y-3 rounded-xl border border-osu-pink/25 bg-osu-b4/25 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-osu-l1">Watch a new play update</h2>
            <p className="mt-1 text-xs text-osu-f1">Loading → dan ready, MSD pending → both ready. Timing is sped up for this preview.</p>
          </div>
          <button type="button" className={BUTTON} onClick={() => setStage("loading")}
            disabled={stage === "loading" || stage === "pending"}>
            {stage === "loading" || stage === "pending" ? "Updating…" : stage === "ready" ? "Play again" : "Play the update"}
          </button>
        </div>
        <div aria-live="polite">{row(1, stage === "loading" || stage === "idle" ? undefined : stage === "pending" ? PARTIAL : READY, "A brand-new play")}</div>
      </section>

      <div className="space-y-6">
        <section className="space-y-2" data-case="loading">
          <h2 className="text-xs font-semibold text-osu-f1">1 · Looking up existing ratings</h2>
          {row(1, undefined)}
        </section>
        <section className="space-y-2" data-case="pending">
          <h2 className="text-xs font-semibold text-osu-f1">2 · Both waiting for scheduled analysis</h2>
          {row(2, PENDING, "Afterglow")}
        </section>
        <section className="space-y-2" data-case="partial">
          <h2 className="text-xs font-semibold text-osu-f1">3 · Dan is ready; MSD is still pending</h2>
          {row(3, PARTIAL, "Signal Rush")}
        </section>
        <section className="space-y-2" data-case="ready">
          <h2 className="text-xs font-semibold text-osu-f1">4 · Both ready</h2>
          {row(4, READY, "Electric Horizon")}
        </section>
        <section className="space-y-2" data-case="unavailable">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xs font-semibold text-osu-f1">5 · Unavailable — tap the MSD status to see why</h2>
            <select aria-label="Unavailable reason" value={reason} onChange={(event) => setReason(event.target.value as LiveRecentRatingMissingReason)}
              className="max-w-full rounded-lg border border-osu-b3 bg-osu-b4 px-2 py-1.5 text-xs text-osu-l2">
              {REASONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </div>
          {row(5, { ...UNAVAILABLE, missing: { msd: reason, dan: "not_analyzed" } }, "Second Attempt")}
        </section>
        <section className="space-y-2" data-case="msd-only">
          <h2 className="text-xs font-semibold text-osu-f1">6 · MSD ready; dan unavailable</h2>
          {row(6, { msd: READY.msd, dan: null, missing: { dan: "unsupported" } }, "Different Path")}
        </section>
        <section className="space-y-2" data-case="retry">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xs font-semibold text-osu-f1">7 · Lookup failed — tap Retry in the row</h2>
            {retryStage !== "error" && <button type="button" className={BUTTON} onClick={() => setRetryStage("error")}>Reset error</button>}
          </div>
          {row(7, retry, "Try Once More")}
        </section>
      </div>
      <p className="text-xs text-osu-f1">Resize your browser or open this page on your phone to try the mobile layout. Clicking a song opens its usual score details.</p>
    </main>
    {detail && <ScoreDetailModal score={detail} onClose={() => setDetail(null)} />}
  </div>;
}
