import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { fetchLiveChartAnalysis, fetchLiveRateChartAnalysis, type LiveChartAnalysisCluster, type LiveChartAnalysisDetail, type LiveMapSearchEntry, type LiveRateChartAnalysis, type LivePlayerSkillScoreDetails } from "../../lib/live-backend";
import type { MapsFavouriteBeatmapset } from "../../lib/types";
import { formatAccuracy, formatDuration, formatNumber, formatPP, formatTimeAgo, formatTimeAgoTooltip } from "../../lib/format";
import { getManiaJudgementCounts, getManiaGradeFromAccuracy } from "../../lib/score";
import { GradeImg } from "../ui/GradeImg";
import { OsuLogo } from "../ui/OsuLogo";
import { ModBadge } from "../ui/ModBadge";
import { ChartPreviewPanel } from "./ChartPreviewPanel";
import { PatternRadar } from "./PatternRadar";
import { danBareLabel, danScaleContextFor, getDanImageSrc } from "../../lib/dan-images";
import { DanProgressRail } from "./DanProgressRail";
import { Skeleton } from "../ui/LoadingSkeleton";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";
import { useLocale } from "../../lib/locale-context";
import type { AppLocale } from "../../lib/locale";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import type { VibroAnalysis } from "#dan/vibro-sections";
import type { VibroClearEvidenceSummary } from "#dan/vibro-clear-evidence";
import { useNoDans } from "../../store";
import {
  FamilyPatternChip,
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
  sharePath?: string | null;
  score?: LivePlayerSkillScoreDetails | null;
  skillRatings?: Record<string, number>;
  dan?: {
    chartRating: number | null;
    chartLabel: string | null;
    creditedRating?: number;
    creditedLabel?: string;
    accuracy: number | null;
    rejection?: ReactNode;
    /** The ladder side the clear testifies for, which picks the rail's courses. */
    family?: "rc" | "ln" | null;
  };
  vibroAdjustment?: Pick<VibroAnalysis, "excludedDurationMs" | "timeShare" | "noteShare" | "judgementShare">;
  vibroClearEvidence?: VibroClearEvidenceSummary;
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
  ratingExcluded?: boolean;
  ratingExclusionReason?: "msd_floor";
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
  // Every mod acronym the score carried, when the projection still knows them.
  // Absent is not NoMod: an older retained play only remembers its speed mod,
  // and `rateMod` alone stands in for the badge row then.
  mods?: string[] | null;
  /** The OD a Difficulty Adjust play set, for the DA badge's tail. */
  daOd?: number | null;
  // Historical identity; its namespace is ambiguous. Only score.scoreUrl
  // provides a verified external link.
  scoreId?: number | null;
}

// The judgement palette, same values the replay OG card draws its chips with
// (JUDGEMENT_COLORS in routes/api/og.ts).
const JUDGEMENT_COLOR: Record<string, string> = {
  MAX: "#ffcc22",
  "300": "#66ccff",
  "200": "#b3d944",
  "100": "#88b300",
  "50": "#ff8e5d",
  Miss: "#ed7887",
};

// Keep all six cells in place, including zero counts and missing old data.
function JudgementStrip({ statistics, locale }: { statistics: LivePlayerSkillScoreDetails["statistics"]; locale: AppLocale }) {
  const { t } = useLingui();
  const judgements = getManiaJudgementCounts(statistics ?? {});
  const available = judgements.some(({ value }) => value > 0);
  return (
    <div className="grid grid-cols-6 gap-2 border-y border-white/5 py-4" aria-label={available ? t`Judgments` : t`Judgments unavailable`}>
      {judgements.map(({ label, value }) => (
        <div key={label} className="flex min-w-0 flex-col">
          <span
            className={`text-[15px] font-bold leading-none tabular-nums ${available && value > 0 ? "" : "text-osu-f1/40"}`}
            style={available && value > 0 ? { color: JUDGEMENT_COLOR[label] } : undefined}
          >
            {available ? formatNumber(value, locale) : "—"}
          </span>
          <span className="mt-1.5 text-[9px] uppercase tracking-wide text-osu-f1/60">{label}</span>
        </div>
      ))}
    </div>
  );
}

/** The DA badge's tail: "OD 9" rather than "OD 9.0" when the value is whole. */
function formatDaOd(od: number): string {
  return Number.isInteger(od) ? String(od) : od.toFixed(1);
}

// The score's mods, as the badge row of a score screen. A play whose full mod
// list aged out still shows its speed mod, which is all the projection kept.
function PlayModRow({ play }: { play: MapDetailPlayContext }) {
  const mods = play.mods && play.mods.length > 0
    ? [...new Set(play.mods.filter((mod) => typeof mod === "string" && mod.length > 0))]
    : play.rateMod
      ? [play.rateMod.acronym]
      : [];
  if (mods.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center justify-end gap-1">
      {mods.map((mod) => (
        <ModBadge
          key={mod}
          mod={mod}
          size={0.75}
          rate={play.rateMod?.acronym === mod ? play.rateMod.rate : undefined}
          detail={mod === "DA" && typeof play.daOd === "number" ? `OD ${formatDaOd(play.daOd)}` : undefined}
        />
      ))}
    </span>
  );
}

// Everything displayed here arrives with the play list. Opening a score or
// switching tabs must not fetch osu! or insert another row after first paint.
export function PlayContextBlock({ play, entry }: { play: MapDetailPlayContext; entry?: LiveMapSearchEntry | null }) {
  const { t } = useLingui();
  const locale = useLocale();
  const noDans = useNoDans();
  const score = play.score;
  const grade = score?.rank || (play.accuracy != null ? getManiaGradeFromAccuracy(play.accuracy, play.mods ?? []) : null);
  const quality = play.vibroClearEvidence;
  const qualityRatio = quality?.max300Ratio == null ? "∞" : `${quality.ratioIsLowerBound ? "≥" : ""}${quality.max300Ratio.toFixed(2)}`;
  const scoreAccuracy = play.accuracy == null ? null : formatAccuracy(play.accuracy);
  const danAccuracy = play.dan?.accuracy == null ? null : formatAccuracy(play.dan.accuracy);
  const showRail = !noDans && play.dan != null && play.dan.chartRating != null;
  const rejected = play.dan?.rejection != null;

  return (
    <div className="flex flex-col gap-2.5">
      <div className={`grid gap-2.5 ${showRail || !play.dan ? "sm:grid-cols-[minmax(0,1fr)_15rem]" : ""}`}>
        <div className="flex min-w-0 flex-col gap-5 rounded-xl bg-osu-b4/50 p-4 sm:p-5">
          <div className="flex min-h-5 items-start justify-between gap-3">
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">{t`${play.username}'s play`}</span>
            <PlayModRow play={play} />
          </div>
          <div className="flex flex-1 flex-wrap items-center justify-between gap-x-5 gap-y-3 py-1">
            <div className="flex items-center gap-3">
              {grade ? <GradeImg grade={grade} size={42} /> : null}
              <div className="flex flex-col">
                <span className="text-[36px] font-bold leading-none tabular-nums text-osu-l1">{scoreAccuracy ?? "—"}</span>
                <span className="mt-1.5 text-[9px] uppercase tracking-wide text-osu-f1/70">{t`Accuracy`}</span>
              </div>
            </div>
            {danAccuracy != null && danAccuracy !== scoreAccuracy && <Stat label={t`Dan accuracy`} value={danAccuracy} />}
          </div>
          <JudgementStrip statistics={score?.statistics ?? null} locale={locale} />
          <div className={`grid gap-x-3 gap-y-4 ${play.pp != null ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-3"}`}>
            <Stat label={t`Max combo`} value={score?.maxCombo != null ? `${formatNumber(score.maxCombo, locale)}x` : "—"} />
            <Stat label={t`Score`} value={score?.totalScore != null ? formatNumber(score.totalScore, locale) : "—"} />
            {play.pp != null && <Stat label={t`PP`} value={formatPP(play.pp)} />}
            <div className="flex flex-col" title={play.playedAt ? formatTimeAgoTooltip(play.playedAt, locale) : undefined}>
              <span className="text-[16px] font-bold text-osu-l1 tabular-nums leading-none">{play.playedAt ? formatTimeAgo(play.playedAt, locale) : "—"}</span>
              <span className="mt-1 text-[9px] uppercase tracking-wide text-osu-f1/70">
                {play.source === "top" ? t`profile top play` : t`tracked history`}
              </span>
            </div>
          </div>
        </div>
        {showRail && play.dan ? (
          <div className="rounded-xl bg-osu-b4/50 p-4">
            <DanProgressRail
              context={danScaleContextFor(entry?.keyCount, play.dan.family)}
              chart={play.dan.chartRating}
              chartLabel={play.dan.chartLabel}
              landed={play.dan.creditedRating ?? null}
              landedLabel={play.dan.creditedLabel ?? null}
              rejected={rejected}
            />
          </div>
        ) : !play.dan ? <PlaySkillRatings play={play} /> : null}
      </div>
      {play.vibroAdjustment && <p className="text-[11px] text-[#ffcf70]"><Trans>Vibro sections excluded from rating. Credit uses a conservative accuracy estimate for the remaining notes.</Trans></p>}
      {quality && <p className="text-[11px] text-[#ffcf70]"><Trans>Accepted clear on a vibro chart: {formatAccuracy(quality.stableAccuracy)} accuracy, {qualityRatio}:1 MAX:300, OD{quality.od}.</Trans></p>}
      {play.dan?.rejection ? (
        <div className="flex flex-col gap-1 rounded-lg bg-osu-red/10 px-3.5 py-2.5 text-osu-red-light">
          <span className="text-[10px] font-bold uppercase tracking-[0.08em]"><Trans>does not count</Trans></span>
          <span className="text-xs leading-relaxed">{play.dan.rejection}</span>
        </div>
      ) : null}
    </div>
  );
}

function PlaySkillRatings({ play }: { play: MapDetailPlayContext }) {
  const { t, i18n } = useLingui();
  const skills = MSD_SKILLSETS.map((name) => ({ name, value: play.skillRatings?.[name] ?? 0 }))
    .filter(({ value }) => Number.isFinite(value) && value >= 1)
    .sort((a, b) => b.value - a.value);
  const max = Math.max(1, ...skills.map(({ value }) => value));
  return (
    <div className="flex flex-col gap-4 rounded-xl bg-osu-b4/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-osu-f1/60"><Trans>MSD skill rating</Trans></div>
          <div className="mt-1 text-xs text-osu-l2">{play.ratingLabel}</div>
        </div>
        {!play.ratingExcluded && <span className="text-[30px] font-black tabular-nums leading-none" style={{ color: play.ratingColor }}>{play.rating.toFixed(2)}</span>}
      </div>
      {play.ratingExcluded ? (
        <p className="text-xs text-osu-red-light">{play.ratingExclusionReason === "msd_floor" ? t`Accuracy below skill rating range` : t`Vibro detected`}</p>
      ) : (
        <div className="flex flex-1 flex-col justify-center gap-2.5" aria-label={t`Skill breakdown`}>
          {skills.map(({ name, value }) => (
            <div key={name} className="grid grid-cols-[5rem_1fr_2.5rem] items-center gap-2">
              <span className="text-[10px] text-osu-l2">{i18n._(MSD_SKILLSET_LABELS[name])}</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-white/5">
                <span className="block h-full rounded-full bg-osu-pink/70" style={{ width: `${value / max * 100}%` }} />
              </span>
              <span className="text-right text-[11px] font-semibold tabular-nums text-osu-l1">{value.toFixed(2)}</span>
            </div>
          ))}
          {skills.length === 0 && <p className="text-[11px] text-osu-f1/70"><Trans>Skill breakdown unavailable</Trans></p>}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-[16px] font-bold text-osu-l1 tabular-nums leading-none">{value}</span>
      <span className="text-[9px] uppercase tracking-wide text-osu-f1/70 mt-1">{label}</span>
    </div>
  );
}

// The osu! bpm is the timing point that holds the most wall-clock time, so
// gimmick timing (a set timed at 999 as a joke) and long off-tempo intros
// misreport the tempo the notes run at. When the note-weighted tempo the chart
// analysis stored disagrees by more than rounding, it takes the stat and the
// timed figure becomes the footnote.
function realBpm(bpm: number, noteBpm: number | null | undefined): string | null {
  if (noteBpm == null || !(noteBpm > 0) || !(bpm > 0)) return null;
  if (Math.abs(noteBpm - bpm) / bpm < 0.03) return null;
  return String(Math.round(noteBpm * 100) / 100);
}

// A Stat whose value the stub does not carry yet: the label is already true, so
// only the number waits. Same 16px value height, so nothing moves when it lands.
function PendingStat({ label }: { label: string }) {
  return (
    <div className="flex min-w-0 flex-col">
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

/** Round before splitting minutes so fractions never leak floating-point digits. */
function formatSectionTime(milliseconds: number): string {
  const centiseconds = Math.max(0, Math.round(milliseconds / 10));
  const minutes = Math.floor(centiseconds / 6000);
  const seconds = ((centiseconds % 6000) / 100).toFixed(2).padStart(5, "0");
  return `${minutes}:${seconds}`;
}

/** Group nearby detections for readability only; never expand calculator exclusions. */
function groupDetectedSections(sections: VibroAnalysis["sections"], rate: number) {
  const ranges: Array<{ startTime: number; endTime: number }> = [];
  const maxGapMs = 250 * rate;
  for (const section of [...sections].sort((a, b) => a.startTime - b.startTime)) {
    const previous = ranges.at(-1);
    if (previous && section.startTime - previous.endTime <= maxGapMs) {
      previous.endTime = Math.max(previous.endTime, section.endTime);
    } else {
      ranges.push({ startTime: section.startTime, endTime: section.endTime });
    }
  }
  return ranges;
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
export function MsdBlock({
  entry,
  msdLn,
  rate = 1,
  rateMsd = null,
  rateDan = null,
  vibroAnalysis,
}: {
  entry: LiveMapSearchEntry;
  msdLn?: Record<string, number> | null;
  // The rate a play on this chart was set at; 1 whenever the modal is not
  // standing in for a rate-modded play.
  rate?: number;
  rateMsd?: Record<string, number> | null;
  rateDan?: { label: string; family: string; rawDan: number } | null;
  vibroAnalysis?: VibroAnalysis;
}) {
  const { t, i18n } = useLingui();
  const noDans = useNoDans();
  // Under a rate mod the chart the play met is not the stored one, so its own
  // MSD and dan replace the 1.0x pair wholesale: a rate-adjusted MSD next to a
  // 1.0x dan badge would describe two different charts. When the rate values
  // never landed the whole block falls back to 1.0x and says so.
  const rateAdjusted = rate !== 1 && rateMsd != null;
  // The LN-adjusted (tail-aware) values simply ARE the msd shown when the
  // chart has holds, using the release-weighting policy shared with player
  // ratings. Bulk search rows carry them, so the final number shows from first
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

  const dan = noDans ? null : rateAdjusted ? rateDan : entry.dan ?? null;
  // "MSD" alone at 1.0x; a rate-modded play names the speed the numbers are
  // for, including when only the 1.0x pair could be shown.
  const heading = rate === 1 ? t`MSD` : t`MSD at ${formatRate(rateAdjusted ? rate : 1)}`;
  const sectionRate = rateAdjusted ? rate : 1;
  const displaySections = groupDetectedSections(vibroAnalysis?.sections ?? [], sectionRate);
  const danImage = dan
    ? getDanImageSrc(danBareLabel(dan.label), dan.family === "ln" ? "ln" : undefined, entry.keyCount)
    : null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">{heading}</span>
        {(vibroAnalysis ? vibroAnalysis.status === "excluded" : entry.vibro) && (
          <span className="text-[9.5px] font-semibold text-[#ffcf70]">{t`vibro chart, estimates unreliable`}</span>
        )}
      </div>
      {vibroAnalysis && vibroAnalysis.status !== "clean" && (
        <details className="text-[11px] text-osu-f1/75">
          <summary className="w-fit cursor-pointer"><Trans>Detected sections</Trans></summary>
          <ul className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
            {displaySections.map((section) => (
              <li key={section.startTime} className="whitespace-nowrap rounded bg-osu-b4/40 px-2 py-1 font-mono text-osu-f1/85 tabular-nums">
                {formatSectionTime(section.startTime / sectionRate)}–{formatSectionTime(section.endTime / sectionRate)}
              </li>
            ))}
          </ul>
        </details>
      )}
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
  // Opened from a play row, the score is what was clicked; the map's own detail
  // waits behind the second tab. Opened from search there is no score at all,
  // so the tab bar stays out and the map detail is the whole card.
  const [tab, setTab] = useState<"score" | "map">("score");

  useEffect(() => {
    setSelectedDiffId(entry ? entry.beatmapId : null);
    setShareCopied(false);
    setTab("score");
  }, [entry?.beatmapId, play?.scoreId, play?.playedAt]);

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
  // The diff the score was set on, whatever the picker is pointing at: the
  // score tab is about that one chart and nothing else in the set.
  const playDiff = play ? diffs.find((diff) => diff.beatmapId === play.beatmapId) ?? entry : null;
  const realBpmStat = active ? realBpm(active.bpm, active.noteBpm) : null;

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
  // Just the primary: the modal's Pattern profile already lists every family
  // with its number, so secondary chips here would say it twice.
  const familyTags = useMemo(() => (active ? [active.primaryPattern] : []), [active]);
  const subTags = useMemo(
    () => (active ? subPatternTags([active], familyTags, Infinity) : []),
    [active, familyTags],
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
  const activeOd = active?.od ?? activeAnalysis?.od ?? null;
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

              {/* Two tabs only when a score opened the card: the play first,
                  the map's own detail behind it. */}
              {play ? (
                <div role="tablist" className="flex shrink-0 items-center gap-1 border-b border-white/5 px-3.5 pt-2.5">
                  {([["score", t`Score`], ["map", t`Map info`]] as const).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={tab === id}
                      onClick={() => {
                        // The banner names the diff on screen, so returning to
                        // the score returns the selection to the diff it was set on.
                        if (id === "score") setSelectedDiffId(play.beatmapId);
                        setShareCopied(false);
                        setTab(id);
                      }}
                      className={`-mb-px cursor-pointer border-b-2 px-2.5 pb-2 text-[11.5px] font-bold uppercase tracking-[0.06em] transition-colors ${
                        tab === id ? "border-osu-pink text-white" : "border-transparent text-osu-f1/70 hover:text-osu-l1"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5">
                {play && tab === "score" ? (
                  <PlayContextBlock play={play} entry={playDiff} />
                ) : (
                  <>
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
                  <div className="flex flex-wrap justify-between gap-x-3 gap-y-3 rounded-lg bg-osu-b4/50 px-4 py-2.5 sm:grid sm:grid-cols-5 sm:gap-2">
                    {numbersKnown ? (
                      <>
                        <Stat label={t`BPM`} value={realBpmStat ?? String(Math.round(active.bpm))} />
                        <Stat label={t`Length`} value={formatDuration(active.length)} />
                        <Stat label={t`Plays`} value={formatNumber(active.playCount)} />
                        <Stat label={t`LN notes`} value={formatNumber(active.lnCount)} />
                        {active.od == null && analysisPending ? (
                          <PendingStat label={t`OD`} />
                        ) : (
                          <Stat label={t`OD`} value={activeOd == null ? "—" : activeOd.toFixed(1)} />
                        )}
                      </>
                    ) : (
                      [t`BPM`, t`Length`, t`Plays`, t`LN notes`, t`OD`].map((label) => <PendingStat key={label} label={label} />)
                    )}
                    {/* The osu! timing figure, when the note-weighted tempo took
                        the stat. Its own row: inline it would run under the next
                        stat on a phone, and giving one cell a second line leaves
                        the rest of the row with a gap under their values. */}
                    {numbersKnown && realBpmStat ? (
                      <span className="w-full col-span-full -mt-1 text-[10px] text-osu-f1/70">{t`timed at ${Math.round(active.bpm)}`}</span>
                    ) : null}
                  </div>
                ) : null}

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
                      vibroAnalysis={playRate === 1 ? activeAnalysis?.vibroAnalysis : entryDt ? entry?.vibroAnalysisDt : rateAnalysis?.vibroAnalysis}
                    />
                  )
                ) : pending ? <PendingMsdBlock /> : null}
                <ClustersBlock analysis={activeAnalysis} pending={analysisPending} />

                {/* The card's filled primary chip (the index's family verdict)
                    then the analyzer's outlined subfamily attributes (bracket,
                    speedjack, ...), distinct from the BPM cluster readout above. */}
                {(familyTags.length > 0 || subTags.length > 0) && (
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                    <span className="mr-1 text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">{t`Tags`}</span>
                    {familyTags.map((pattern, index) => (
                      <FamilyPatternChip key={pattern} pattern={pattern} primary={index === 0} />
                    ))}
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
                  </>
                )}
              </div>

              {/* Actions: one footer under both tabs, so switching tabs never
                  moves the links. */}
              <div className="shrink-0 border-t border-white/5 p-3.5">
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
                    disabled={play != null && tab === "score" && !play.sharePath && !play.score?.scoreUrl}
                    title={play != null && tab === "score" ? t`Share score` : t`Share map`}
                    onClick={() => {
                      const url = play && tab === "score"
                        ? (play.sharePath ? `${window.location.origin}${play.sharePath}` : play.score?.scoreUrl)
                        : `${window.location.origin}/maps?map=${active.beatmapId}`;
                      if (!url) return;
                      void navigator.clipboard?.writeText(url).then(() => {
                        setShareCopied(true);
                        window.setTimeout(() => setShareCopied(false), 1600);
                      }).catch(() => {});
                    }}
                    className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-osu-b3/70 px-3 py-2 text-[12px] font-semibold text-osu-l2 hover:bg-osu-b3 hover:text-white transition-colors cursor-pointer disabled:cursor-default disabled:opacity-40 sm:justify-start sm:px-3"
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
