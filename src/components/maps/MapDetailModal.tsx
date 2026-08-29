import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { fetchLiveChartAnalysis, fetchLiveRateChartAnalysis, type LiveChartAnalysisCluster, type LiveChartAnalysisDetail, type LiveMapSearchEntry, type LiveRateChartAnalysis } from "../../lib/live-backend";
import type { MapsFavouriteBeatmapset } from "../../lib/types";
import { formatAccuracy, formatDuration, formatNumber, formatPP, formatTimeAgo, formatTimeAgoTooltip } from "../../lib/format";
import { OsuLogo } from "../ui/OsuLogo";
import { ModBadge } from "../ui/ModBadge";
import { ChartPreviewPanel } from "./ChartPreviewPanel";
import { PatternRadar } from "./PatternRadar";
import { danBareLabel, getDanImageSrc } from "../../lib/dan-images";
import { Skeleton } from "../ui/LoadingSkeleton";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";
import { useLocale } from "../../lib/locale-context";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import {
  PATTERN_COLOR,
  SubPatternChip,
  entryDiffs,
  mapCoverUrl,
  osuBeatmapUrl,
  osuDirectUrl,
  oszDownloadUrl,
  patternLabel,
  subPatternTags,
  StarRatingBadge,
  starRatingColor,
} from "./SearchCard";

// A minimal beatmapset built from the search entry alone, enough for the chart
// preview: the .osu loads from mirrors and the audio preview URL is derivable, so
// opening the modal costs zero osu! API calls. All matching diffs of the set ride
// along so the preview can switch between them.
function buildPreviewBeatmapset(entry: LiveMapSearchEntry, diffs: LiveMapSearchEntry[]): MapsFavouriteBeatmapset {
  return {
    id: entry.beatmapsetId,
    title: entry.title,
    artist: entry.artist,
    creator: entry.creator,
    covers: (entry.covers ?? {}) as unknown as MapsFavouriteBeatmapset["covers"],
    status: entry.status,
    globalPlayCount: entry.playCount,
    globalFavouriteCount: 0,
    previewUrl: `https://b.ppy.sh/preview/${entry.beatmapsetId}.mp3`,
    maniaKeys: [...new Set(diffs.map((diff) => diff.keyCount))],
    maniaBeatmaps: diffs.map((diff) => ({
      id: diff.beatmapId,
      beatmapsetId: diff.beatmapsetId,
      version: diff.version,
      difficultyRating: diff.stars,
      totalLength: diff.length,
      cs: diff.keyCount,
    })),
    starMin: Math.min(...diffs.map((diff) => diff.stars)),
    starMax: Math.max(...diffs.map((diff) => diff.stars)),
    bpm: entry.bpm,
    patterns: [entry.primaryPattern],
  };
}

// A specific player's play on one diff of this set, when the modal is opened
// from a play row (the skill-plays modal) rather than from search. Rendered as
// its own stat strip while that diff is the active one.
export interface MapDetailPlayContext {
  beatmapId: number;
  username: string;
  accuracy: number | null;
  pp: number | null;
  // `pitched` is whether the mod resampled the audio (NC/DC) rather than
  // stretching it (DT/HT); true as well when the play's mods are no longer
  // known, where the rate is all there is to go on.
  rateMod: { acronym: string; rate: number; pitched: boolean } | null;
  playedAt: string | null;
  source: "top" | "tracked";
  rating: number;
  ratingLabel: string;
  ratingColor: string;
  // Dan evidence has two distinct values: the chart's base rating and the
  // level this particular accuracy credits. Ordinary skill evidence only has
  // the first value, so both display names and the credit stay optional.
  ratingDisplayName?: string;
  credit?: {
    rating: number;
    displayName: string;
    label: string;
    color: string;
  };
}

function PlayContextBlock({ play }: { play: MapDetailPlayContext }) {
  const { t } = useLingui();
  const locale = useLocale();
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">{t`${play.username}'s play`}</span>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5 rounded-lg bg-osu-b4/50 px-4 py-2.5">
        {play.accuracy != null && <Stat label={t`Accuracy`} value={formatAccuracy(play.accuracy)} />}
        {play.pp != null && <Stat label={t`PP`} value={formatPP(play.pp)} />}
        {play.rateMod && (
          <div className="flex flex-col">
            <ModBadge mod={play.rateMod.acronym} rate={play.rateMod.rate} size={0.7} />
            <span className="text-[9px] uppercase tracking-wide text-osu-f1/70 mt-1">{t`Rate`}</span>
          </div>
        )}
        {play.playedAt && (
          <div className="flex flex-col" title={formatTimeAgoTooltip(play.playedAt, locale)}>
            <span className="text-[16px] font-bold text-osu-l1 tabular-nums leading-none">{formatTimeAgo(play.playedAt, locale)}</span>
            <span className="text-[9px] uppercase tracking-wide text-osu-f1/70 mt-1">
              {play.source === "top" ? t`profile top play` : t`tracked history`}
            </span>
          </div>
        )}
        <div className="flex flex-col">
          <span className="flex items-baseline gap-1.5 leading-none" style={{ color: play.ratingColor }}>
            <span className="text-[16px] font-bold tabular-nums">{play.rating.toFixed(2)}</span>
            {play.ratingDisplayName ? (
              <span className="text-[10px] font-bold">{play.ratingDisplayName}</span>
            ) : null}
          </span>
          <span className="text-[9px] uppercase tracking-wide text-osu-f1/70 mt-1">{play.ratingLabel} rating</span>
        </div>
        {play.credit ? (
          <div className="flex flex-col">
            <span className="flex items-baseline gap-1.5 leading-none" style={{ color: play.credit.color }}>
              <span className="text-[16px] font-bold tabular-nums">{play.credit.rating.toFixed(2)}</span>
              <span className="text-[10px] font-bold">{play.credit.displayName}</span>
            </span>
            <span className="mt-1 text-[9px] uppercase tracking-wide text-osu-f1/70">{play.credit.label}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[16px] font-bold text-osu-l1 tabular-nums leading-none">{value}</span>
      <span className="text-[9px] uppercase tracking-wide text-osu-f1/70 mt-1">{label}</span>
    </div>
  );
}

// A Stat whose value the stub does not carry yet: the label is already true, so
// only the number waits. Same 16px value height, so nothing moves when it lands.
function PendingStat({ label }: { label: string }) {
  return (
    <div className="flex flex-col">
      <Skeleton className="h-4 w-10" />
      <span className="text-[9px] uppercase tracking-wide text-osu-f1/70 mt-1">{label}</span>
    </div>
  );
}

// The MSD strip's frame while the entry is in flight. Every play in a skill
// list is rated, so this block is coming for all of them; holding its shape
// keeps the modal from resizing under the cursor when the numbers arrive.
function PendingMsdBlock({ label }: { label?: string }) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">{label ?? t`MSD`}</span>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg bg-osu-b4/40 px-3.5 py-2.5">
        <div className="flex min-h-10 items-center gap-4 sm:border-r sm:border-white/10 sm:pr-5">
          <Skeleton className="h-10 w-10 rounded-full" />
          <Skeleton className="h-[18px] w-12" />
        </div>
        <div className="grid min-w-0 flex-1 basis-[260px] grid-cols-[repeat(auto-fit,minmax(78px,1fr))] gap-x-3 gap-y-2.5">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-[14px] w-11" />
          ))}
        </div>
      </div>
    </div>
  );
}

// Skillset order used when every value ties (never in practice); display sorts
// by value, Overall stays the headline.
const MSD_SKILLSETS = ["Stream", "Jumpstream", "Handstream", "Stamina", "JackSpeed", "Chordjack", "Technical"];

// Display names for the strip; the keys above stay MinaCalc's own.
const MSD_SKILLSET_LABELS: Record<string, MessageDescriptor> = {
  Stream: msg`Stream`,
  Jumpstream: msg`Jumpstream`,
  Handstream: msg`Handstream`,
  Stamina: msg`Stamina`,
  JackSpeed: msg`Jackspeed`,
  Chordjack: msg`Chordjack`,
  Technical: msg`Technical`,
};

const BEATMAP_STATUS_LABELS: Record<string, MessageDescriptor> = {
  ranked: msg`Ranked`,
  approved: msg`Ranked`,
  qualified: msg`Qualified`,
  loved: msg`Loved`,
  graveyard: msg`Graveyard`,
  pending: msg`Pending`,
  wip: msg`Pending`,
};

/** Matches osu-web's rate rendering on mod badges: 2 decimals + "x" (U+00D7). */
function formatRate(rate: number): string {
  return `${rate.toFixed(2)}\u00d7`;
}

/** The +/- tier suffix of a dan verdict ("2--" -> "--"), which badge art can't show. */
function danSuffix(label: string): string {
  return label.match(/[+-]+$/)?.[0] ?? "";
}

// MSD skillset breakdown + the classifier's dan verdict, as a compact stat
// strip in the same value-over-label language as the BPM/LENGTH/PLAYS row.
// Sorted by value with the top skillset tinted; no bars, the numbers carry it.
// The skillset names are MinaCalc's 4K taxonomy for every keymode; the
// ClustersBlock below is where charts speak their own keymode's language.
function MsdBlock({
  entry,
  msdLn,
  rate = 1,
  rateMsd = null,
  rateDan = null,
}: {
  entry: LiveMapSearchEntry;
  msdLn?: Record<string, number> | null;
  // The rate a play on this chart was set at; 1 whenever the modal is not
  // standing in for a rate-modded play.
  rate?: number;
  rateMsd?: Record<string, number> | null;
  rateDan?: { label: string; family: string; rawDan: number } | null;
}) {
  const { t, i18n } = useLingui();
  // Under a rate mod the chart the play met is not the stored one, so its own
  // MSD and dan replace the 1.0x pair wholesale: a rate-adjusted MSD next to a
  // 1.0x dan badge would describe two different charts. When the rate values
  // never landed the whole block falls back to 1.0x and says so.
  const rateAdjusted = rate !== 1 && rateMsd != null;
  // The LN-adjusted (tail-aware) values simply ARE the msd shown when the
  // chart has holds: they match what the skill-rating engine credits a play
  // here. Bulk search rows carry them, so the final number shows from first
  // paint; the lazily fetched analysis only overrides when it is fresher than
  // the index (base msd remains for pre-msdLn cached payloads).
  const msd = rateAdjusted ? rateMsd : msdLn ?? entry.msdLn ?? entry.msd ?? null;
  if (!msd) return null;
  const skillsets = MSD_SKILLSETS
    .map((name) => ({ name, value: Number(msd[name] ?? 0) }))
    // The 6K/7K calc engine returns ~0 for skillsets it does not rate
    // (Technical); a 0.18 next to real values reads as data, so drop it.
    .filter(({ value }) => value >= 1)
    .sort((a, b) => b.value - a.value);
  const overall = Number(msd.Overall ?? 0);
  const topName = skillsets[0]?.name;

  const dan = rateAdjusted ? rateDan : entry.dan ?? null;
  // "MSD" alone at 1.0x; a rate-modded play names the speed the numbers are
  // for, including when only the 1.0x pair could be shown.
  const heading = rate === 1 ? t`MSD` : t`MSD at ${formatRate(rateAdjusted ? rate : 1)}`;
  const danImage = dan
    ? getDanImageSrc(danBareLabel(dan.label), dan.family === "ln" ? "ln" : undefined, entry.keyCount)
    : null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">{heading}</span>
        {entry.vibro && (
          <span className="text-[9.5px] font-semibold text-[#ffcf70]">{t`vibro chart, estimates unreliable`}</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg bg-osu-b4/40 px-3.5 py-2.5">
        {/* Verdict group: dan badge + Overall, split from the skillset grid.
            min-h keeps the row the badge's height even on diffs that have no
            dan verdict, so switching diffs doesn't resize the MSD box. */}
        <div className="flex min-h-10 items-center gap-4 sm:border-r sm:border-white/10 sm:pr-5">
          {dan && (
            <div className="flex flex-col items-center">
              {/* The logo IS the number; the +/- tier suffix rides top-right like an exponent. */}
              <span className="flex items-start gap-[2px] leading-none">
                {danImage ? (
                  <img src={danImage} alt={dan.label} className="h-10 w-10 object-contain" />
                ) : (
                  <span className="text-[16px] font-bold leading-none text-osu-l1">{dan.label}</span>
                )}
                {danImage && danSuffix(dan.label) ? (
                  <span className="mt-0.5 text-[13px] font-bold leading-none text-osu-l1">{danSuffix(dan.label)}</span>
                ) : null}
              </span>
              <span className="mt-1 text-[9px] uppercase tracking-wide text-osu-f1/70">
                {dan.family === "ln" ? t`LN dan est.` : t`dan est.`}
              </span>
            </div>
          )}
          <div className="flex flex-col">
            <span className="text-[18px] font-bold tabular-nums leading-none text-osu-l1">{overall.toFixed(2)}</span>
            <span className="mt-1 text-[9px] uppercase tracking-wide text-osu-f1/70">{t`Overall`}</span>
          </div>
        </div>
        {/* Even columns keep the values aligned no matter how long the labels run. */}
        <div className="grid min-w-0 flex-1 basis-[260px] grid-cols-[repeat(auto-fit,minmax(78px,1fr))] gap-x-3 gap-y-2.5">
          {skillsets.map(({ name, value }) => (
            <div key={name} className="flex flex-col">
              <span
                className={`text-[14px] font-semibold tabular-nums leading-none ${
                  name === topName ? "text-osu-pink-light" : value < 1 ? "text-osu-f1/45" : "text-osu-l2"
                }`}
              >
                {value.toFixed(2)}
              </span>
              <span className="mt-1 text-[9px] uppercase tracking-wide text-osu-f1/55">
                {i18n._(MSD_SKILLSET_LABELS[name] ?? name)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// A cluster label is "~87BPM Mixed Light Chordstream"; the BPM becomes the
// value (~ marks a mixed-BPM cluster), the rest is the pattern name.
function clusterPatternName(cluster: LiveChartAnalysisCluster): string {
  const stripped = cluster.label.replace(/^~?\d+\s*BPM\s+/i, "").replace(/^Mixed\s+/i, "").trim();
  return stripped || cluster.pattern;
}

// LeoBlack clusters are keyed by (pattern, BPM), so a chart with dense
// chordstream sections at three speeds yields three clusters. One pattern name
// per strip is enough: same-named clusters merge into a BPM range.
interface ClusterGroup {
  name: string;
  bpmMin: number;
  bpmMax: number;
  mixed: boolean;
}

function groupClusters(clusters: LiveChartAnalysisCluster[]): ClusterGroup[] {
  const groups = new Map<string, ClusterGroup>();
  for (const cluster of clusters) {
    const name = clusterPatternName(cluster);
    // BPM 0 is the analyzer's "no meaningful tempo" pool (inverse windows, LN
    // tail gaps); it renders as the name alone and must not drag a real
    // sibling's range down to "0-247bpm".
    const bpm = Math.round(cluster.bpm);
    const existing = groups.get(name);
    if (existing) {
      if (bpm > 0) {
        existing.bpmMin = existing.bpmMin > 0 ? Math.min(existing.bpmMin, bpm) : bpm;
        existing.bpmMax = Math.max(existing.bpmMax, bpm);
      }
      existing.mixed = existing.mixed || cluster.mixed;
    } else {
      groups.set(name, { name, bpmMin: bpm, bpmMax: bpm, mixed: cluster.mixed });
    }
  }
  return [...groups.values()].slice(0, 4);
}

// The LeoBlack pattern clusters: what the chart is made of, in the analyzer's
// own per-keymode vocabulary (7K says Light Chordstream / Brackets / Shield /
// Jacky WC, 4K says Jumpstream / Rolls / ...). These are composition, not
// difficulty, so the value per pattern is the BPM it runs at. One inline row,
// importance-ordered with the dominant pattern tinted; no box of its own.
function ClustersBlock({ analysis, pending }: { analysis: LiveChartAnalysisDetail | null; pending: boolean }) {
  const { t } = useLingui();
  const groups =
    analysis && analysis.status === "ready" && analysis.clusters.length > 0 ? groupClusters(analysis.clusters) : [];
  // Done loading and genuinely nothing to show: collapse the row entirely.
  if (!pending && groups.length === 0) return null;
  // Fixed single-line height on desktop so the async result landing (or a diff
  // with more/wider pattern groups) can't grow this row and re-center the whole
  // centered modal. The pending "analyzing" state and the loaded state share the
  // exact height, so switching to an un-cached diff no longer jumps. On mobile
  // the card already sits at max-height (its scroll area absorbs changes), so we
  // let the strip wrap there instead of clipping pattern info.
  return (
    <div className="flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-1.5 overflow-hidden sm:h-[22px] sm:flex-nowrap">
      <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">{t`Patterns`}</span>
      {groups.map((group, index) => (
        <span key={group.name} className="flex shrink-0 items-baseline gap-1.5">
          {group.bpmMax > 0 && (
            <span
              className={`text-[12.5px] font-semibold tabular-nums leading-none ${
                index === 0 ? "text-osu-pink-light" : "text-osu-l2"
              }`}
            >
              {group.bpmMin === group.bpmMax ? `${group.mixed ? "~" : ""}${group.bpmMin}` : `${group.bpmMin}-${group.bpmMax}`}
              <span className="ml-0.5 text-[9px] font-normal text-osu-f1/55">{t`bpm`}</span>
            </span>
          )}
          <span
            className={`text-[9px] uppercase tracking-wide ${
              group.bpmMax === 0 && index === 0 ? "text-osu-pink-light" : "text-osu-f1/55"
            }`}
          >
            {group.name}
          </span>
        </span>
      ))}
      {pending && groups.length === 0 && (
        <span className="text-[9px] uppercase tracking-wide text-osu-f1/35">{t`analyzing…`}</span>
      )}
    </div>
  );
}

export function MapDetailModal({
  entry,
  onClose,
  play,
  status = "ready",
}: {
  entry: LiveMapSearchEntry | null;
  onClose: () => void;
  play?: MapDetailPlayContext | null;
  // "pending" means `entry` is the stub a list already had in hand (title,
  // cover, keys) and the catalog entry is still in flight, so the modal opens
  // on the click and the fields the stub cannot fill render as loading rather
  // than as zeroes. "missing"/"error": that fetch is done and brought nothing.
  status?: "ready" | "pending" | "missing" | "error";
}) {
  const { t, i18n } = useLingui();
  // Which diff of the set is in focus; defaults to the entry's representative.
  const [selectedDiffId, setSelectedDiffId] = useState<number | null>(null);
  const [shareCopied, setShareCopied] = useState(false);

  useEffect(() => {
    setSelectedDiffId(entry ? entry.beatmapId : null);
    setShareCopied(false);
  }, [entry]);

  useEffect(() => {
    if (!entry) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [entry, onClose]);

  useBodyScrollLock(entry != null);

  const pending = status === "pending";
  // Only a real catalog entry carries stars, bpm, length, play counts and the
  // set's other diffs. A stub has zeroes there, so those blocks either wait
  // (pending) or stay out (a chart the catalog does not have).
  const numbersKnown = status === "ready";
  const diffs = useMemo(() => (entry ? entryDiffs(entry) : []), [entry]);
  const mixedKeys = useMemo(() => new Set(diffs.map((diff) => diff.keyCount)).size > 1, [diffs]);
  const active = diffs.find((diff) => diff.beatmapId === selectedDiffId) ?? entry;

  // A tracked play can name a chart the catalog never indexed, and a stub built
  // from a play row may not know the set either; both leave the set id at 0.
  const setKnown = entry != null && entry.beatmapsetId > 0;
  // Never from a stub: its diffs carry no star rating, and the panel's own
  // footer would show the map as 0.00 stars.
  const previewSet = useMemo(
    () => (entry && setKnown && numbersKnown && diffs.length > 0 ? buildPreviewBeatmapset(entry, diffs) : null),
    [entry, setKnown, numbersKnown, diffs],
  );

  const patterns = useMemo(
    () => (active ? Object.entries(active.patterns).sort((a, b) => b[1] - a[1]) : []),
    [active],
  );

  // The active diff's detected subfamily tags (bracket, speedjack, ...), all
  // of them: the modal is the exhaustive view, unlike the cards' capped strip.
  const subTags = useMemo(
    () => (active ? subPatternTags([active], [active.primaryPattern], Infinity) : []),
    [active],
  );

  // Chart-analysis detail per diff, fetched lazily so the modal can show the
  // LeoBlack cluster readout (the chart's own keymode vocabulary). Keyed by
  // beatmap id: switching diffs and reopening the modal stay warm.
  const [analysisByBeatmap, setAnalysisByBeatmap] = useState<Record<number, LiveChartAnalysisDetail | null>>({});
  const activeBeatmapId = active?.beatmapId ?? null;
  useEffect(() => {
    if (activeBeatmapId == null) return;
    if (analysisByBeatmap[activeBeatmapId] !== undefined) return;
    let cancelled = false;
    void fetchLiveChartAnalysis(activeBeatmapId).then((detail) => {
      if (cancelled) return;
      setAnalysisByBeatmap((prev) => ({ ...prev, [activeBeatmapId]: detail }));
    });
    return () => {
      cancelled = true;
    };
  }, [activeBeatmapId, analysisByBeatmap]);
  const activeAnalysis = activeBeatmapId != null ? analysisByBeatmap[activeBeatmapId] ?? null : null;
  // True while a freshly selected diff's analysis is still being fetched (its
  // slot is `undefined`, not `null`). Used to hold the Patterns row's height so
  // the async result landing can't grow the card and re-center the modal.
  const analysisPending = activeBeatmapId != null && analysisByBeatmap[activeBeatmapId] === undefined;

  // The rate the opening play was set at, and only while that play's own diff
  // is the active one: the set's other diffs were not the ones played.
  const playRate = play && active && play.beatmapId === active.beatmapId ? play.rateMod?.rate ?? 1 : 1;
  const ratePercent = Math.round(playRate * 100);
  // 1.5x is the one rate the catalog already carries (the DT sweep), and it
  // rides on the detail entry, so the common DT/NC play needs no request at all.
  const entryDt = ratePercent === 150 && entry && active && active.beatmapId === entry.beatmapId && entry.msdDt
    ? { msd: entry.msdDt, dan: entry.danDt ?? null }
    : null;
  // Every other rate (and a chart the DT sweep never reached) is computed on
  // demand by the backend and cached there; keyed by rate as well as beatmap so
  // switching diffs mid-modal cannot show one diff's numbers under another's.
  const [rateAnalysisByKey, setRateAnalysisByKey] = useState<Record<string, LiveRateChartAnalysis | null>>({});
  const rateKey = playRate !== 1 && active ? `${active.beatmapId}:${ratePercent}` : null;
  const needsRateFetch = rateKey != null && entryDt == null;
  useEffect(() => {
    if (!needsRateFetch || rateKey == null) return;
    if (rateAnalysisByKey[rateKey] !== undefined) return;
    const [beatmapId, percent] = rateKey.split(":");
    let cancelled = false;
    void fetchLiveRateChartAnalysis(Number(beatmapId), Number(percent) / 100).then((result) => {
      if (cancelled) return;
      setRateAnalysisByKey((prev) => ({ ...prev, [rateKey]: result }));
    });
    return () => {
      cancelled = true;
    };
  }, [needsRateFetch, rateAnalysisByKey, rateKey]);
  const rateAnalysis = rateKey != null ? rateAnalysisByKey[rateKey] : undefined;
  const rateMsd = entryDt ? entryDt.msd : rateAnalysis?.msd ?? null;
  const rateDan = entryDt ? entryDt.dan : rateAnalysis?.dan ?? null;
  const ratePending = needsRateFetch && rateAnalysis === undefined;

  if (typeof document === "undefined") return null;

  // Same enter/exit recipe as the maps tabs' details modal: quick opacity
  // fades, but the panel is its own composited layer (modal-card-mobile-safe:
  // translateZ(0) + contain: paint) with an opaque in-layer backdrop, so a
  // dropped frame on phones can't paint the content see-through mid-fade.
  return createPortal(
    <AnimatePresence>
      {entry && active && (
        <motion.div
          key="map-detail"
          className="fixed inset-0 z-[120] flex items-center justify-center p-3 sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <div className="absolute inset-0 bg-black/85" onClick={onClose} />
          <motion.div
            className="modal-card-mobile-safe relative isolate z-10 w-full max-w-[760px] max-h-[calc(100dvh-1.5rem)] sm:max-h-[calc(100dvh-3rem)] overflow-hidden rounded-2xl bg-osu-b5 ring-1 ring-white/10 shadow-2xl flex flex-col"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
          >
            <div className="pointer-events-none absolute inset-0 bg-osu-b5" aria-hidden="true" />
            <div className="relative z-10 flex min-h-0 flex-1 flex-col">
              {/* Header banner */}
              <div className="relative h-[92px] shrink-0">
                <img
                  src={mapCoverUrl(entry)}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={(e) => { e.currentTarget.style.visibility = "hidden"; }}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-osu-b5 via-osu-b5/70 to-black/40" />
                <button
                  type="button"
                  onClick={onClose}
                  aria-label={t`Close`}
                  className="absolute top-2.5 right-2.5 z-10 grid h-7 w-7 place-items-center rounded-full bg-black/50 text-white/80 hover:bg-black/70 hover:text-white transition-colors cursor-pointer"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="h-4 w-4">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
                <div className="absolute inset-x-0 bottom-0 p-3.5 pr-12">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-bold leading-none tabular-nums text-white">{active.keyCount}K</span>
                    {numbersKnown ? (
                      <>
                        <StarRatingBadge stars={active.stars} />
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-white/70">
                          {BEATMAP_STATUS_LABELS[active.status.toLowerCase()]
                            ? i18n._(BEATMAP_STATUS_LABELS[active.status.toLowerCase()])
                            : active.status}
                        </span>
                      </>
                    ) : pending ? (
                      // A skeleton's tint is invisible against the banner art,
                      // so the star badge's place is held in the banner's own
                      // language instead.
                      <span className="inline-flex h-[14px] w-[52px] rounded-full bg-black/50" aria-hidden="true" />
                    ) : null}
                  </div>
                  <h2 className="mt-1 text-[17px] font-bold text-white leading-tight truncate drop-shadow">{entry.title}</h2>
                  <p className="text-[11px] text-white/75 truncate">
                    {entry.artist}
                    {entry.creator ? <span className="text-white/50"> · <Trans>mapped by {entry.creator}</Trans></span> : null}
                    <span className="text-white/50"> · [{active.version}]</span>
                  </p>
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5">
                {/* Diff picker: every matching diff of the set, easiest first */}
                {diffs.length > 1 && (
                  <div className="flex flex-wrap gap-1.5">
                    {diffs.map((diff) => {
                      const isActive = diff.beatmapId === active.beatmapId;
                      return (
                        <button
                          key={diff.beatmapId}
                          type="button"
                          onClick={() => setSelectedDiffId(diff.beatmapId)}
                          aria-pressed={isActive}
                          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10.5px] font-semibold cursor-pointer transition-colors ${
                            isActive ? "bg-osu-b3 text-white" : "bg-osu-b4/60 text-osu-l2 hover:bg-osu-b4 hover:text-osu-l1"
                          }`}
                        >
                          <span
                            className="h-2 w-2 shrink-0 rounded-full ring-1 ring-white/15"
                            style={{ background: starRatingColor(diff.stars) }}
                          />
                          {mixedKeys && <span className="text-osu-f1">{diff.keyCount}K</span>}
                          <span className="max-w-[180px] truncate">{diff.version}</span>
                          <span className="tabular-nums text-osu-yellow">★{diff.stars.toFixed(2)}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Stats */}
                {numbersKnown || pending ? (
                  <div className="grid grid-cols-4 gap-2 rounded-lg bg-osu-b4/50 px-4 py-2.5">
                    {numbersKnown ? (
                      <>
                        <Stat label={t`BPM`} value={String(Math.round(active.bpm))} />
                        <Stat label={t`Length`} value={formatDuration(active.length)} />
                        <Stat label={t`Plays`} value={formatNumber(active.playCount)} />
                        <Stat label={t`LN notes`} value={formatNumber(active.lnCount)} />
                      </>
                    ) : (
                      [t`BPM`, t`Length`, t`Plays`, t`LN notes`].map((label) => <PendingStat key={label} label={label} />)
                    )}
                  </div>
                ) : null}

                {/* The play this modal was opened from, while its diff is the
                    active one (it says nothing about the set's other diffs). */}
                {play && play.beatmapId === active.beatmapId && <PlayContextBlock play={play} />}

                {/* The catalog entry brought nothing back: say so where its
                    numbers would have been, the osu! link below still works. */}
                {status === "missing" || status === "error" ? (
                  <span className="text-[11.5px] text-osu-f1">
                    {status === "missing"
                      ? t`This chart is not in the map catalog, so there is nothing to show beyond the play itself.`
                      : t`Could not load the map details.`}
                  </span>
                ) : null}

                {/* MSD skillsets when the chart analysis has landed; the old
                    relative pattern mix stays as the fallback until then. */}
                {active.msd ? (
                  ratePending ? (
                    <PendingMsdBlock label={t`MSD at ${formatRate(playRate)}`} />
                  ) : (
                    <MsdBlock
                      entry={active}
                      msdLn={activeAnalysis?.msdLn ?? null}
                      rate={playRate}
                      rateMsd={rateMsd}
                      rateDan={rateDan}
                    />
                  )
                ) : pending ? <PendingMsdBlock /> : null}
                <ClustersBlock analysis={activeAnalysis} pending={analysisPending} />

                {/* Detected subfamily tags from the in-house analyzer: chart
                    attributes (bracket, speedjack, ...), distinct from the
                    family identity chips and the BPM cluster readout above. */}
                {subTags.length > 0 && (
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                    <span className="mr-1 text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">{t`Tags`}</span>
                    {subTags.map((pattern) => (
                      <SubPatternChip key={pattern} pattern={pattern} />
                    ))}
                  </div>
                )}

                {/* Pattern profile: radar + the raw numbers */}
                {!active.msd && patterns.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">{t`Pattern profile`}</span>
                    <div className="grid items-center gap-3 rounded-lg bg-osu-b4/40 p-3 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)]">
                      <div className="flex justify-center">
                        <PatternRadar patterns={active.patterns} />
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                        {patterns.map(([pattern, value]) => {
                          const color = PATTERN_COLOR[pattern] ?? "#cfcfe6";
                          const isPrimary = pattern === active.primaryPattern;
                          return (
                            <div key={pattern} className="flex items-center justify-between gap-2">
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                                <span className={`truncate text-[11.5px] ${isPrimary ? "font-bold text-osu-l1" : "text-osu-l2"}`}>
                                  {patternLabel(pattern)}
                                </span>
                              </span>
                              <span className="shrink-0 text-[11.5px] font-semibold tabular-nums text-osu-l1">
                                {(value * active.stars * 10).toFixed(1)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {/* Chart preview, held as an empty box of its own height while
                    the entry is in flight so it lands without moving. */}
                {previewSet ? (
                  <ChartPreviewPanel
                    beatmapset={previewSet}
                    selectedBeatmapId={active.beatmapId}
                    // A play's own speed and its own pitch: NC and DC resample
                    // the audio, DT and HT stretch it. A play whose mods are no
                    // longer known keeps the panel's default (pitch follows
                    // rate), which is what NC sounds like.
                    playbackRate={playRate}
                    preservePitch={playRate !== 1 && play?.rateMod ? !play.rateMod.pitched : undefined}
                    className="h-[300px] rounded-lg"
                    flatBackdrop
                  />
                ) : pending ? (
                  <div className="h-[300px] shrink-0 rounded-lg bg-osu-b4/30" aria-hidden="true" />
                ) : null}

                {/* Actions */}
                <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap">
                  <a
                    href={setKnown ? osuBeatmapUrl(active) : `https://osu.ppy.sh/beatmaps/${active.beatmapId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-osu-pink px-3 py-2 text-[12px] font-bold text-white hover:bg-osu-pink-light transition-colors sm:justify-start sm:px-3"
                  >
                    osu! web
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden="true">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </a>
                  {/* Both need the set id, which a chart outside the catalog
                      does not have; the osu! link above resolves it instead. */}
                  {setKnown ? (
                    <>
                      <a
                        href={oszDownloadUrl(entry.beatmapsetId)}
                        className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-osu-b3/70 px-3 py-2 text-[12px] font-semibold text-osu-l2 hover:bg-osu-b3 hover:text-white transition-colors sm:justify-start sm:px-3"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
                          <path d="M12 3v10" />
                          <path d="m7 10 5 4 5-4" />
                          <path d="M5 20h14" />
                        </svg>
                        {t`Download .osz`}
                      </a>
                      <a
                        href={osuDirectUrl(entry.beatmapsetId)}
                        className="hidden items-center gap-1.5 whitespace-nowrap rounded-md bg-osu-b3/70 px-3 py-2 text-[12px] font-semibold text-osu-l2 hover:bg-osu-b3 hover:text-white transition-colors sm:inline-flex"
                      >
                        <OsuLogo className="h-3.5 w-3.5" />
                        {t`Open in osu!`}
                      </a>
                    </>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      // /maps?map=<id> reopens this modal for whoever gets the
                      // link; the selected diff rides along in the id.
                      const url = `${window.location.origin}/maps?map=${active.beatmapId}`;
                      void navigator.clipboard?.writeText(url).then(() => {
                        setShareCopied(true);
                        window.setTimeout(() => setShareCopied(false), 1600);
                      }).catch(() => {});
                    }}
                    className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-osu-b3/70 px-3 py-2 text-[12px] font-semibold text-osu-l2 hover:bg-osu-b3 hover:text-white transition-colors cursor-pointer sm:justify-start sm:px-3"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </svg>
                    {shareCopied ? t`Link copied!` : t`Share`}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
