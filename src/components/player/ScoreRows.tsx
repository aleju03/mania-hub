import { Link } from "@tanstack/react-router";
import { useState, type CSSProperties, type ReactNode } from "react";
import { motion } from "framer-motion";
import { ExternalLink, X } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { LiveKeymodePpPlay } from "../../lib/live-backend";
import {
  formatNumber,
  formatAccuracy,
  formatTimeAgo,
  formatTimeAgoTooltip,
  formatDetailedTimeAgo,
  formatDate,
  formatPP,
} from "../../lib/format";
import { useViewerTimeZone } from "../../lib/use-viewer-time-zone";
import {
  getBeatmapUrl,
  getBeatmapKeymodeLabel,
  getModDisplayList,
  getScoreDisplayValues,
  getScoreTimestamp,
  getScoreUrl,
  scoreHasReplay,
} from "../../lib/score";
import { CompanellaMark } from "../ui/CompanellaMark";
import { GradeImg } from "../ui/GradeImg";
import { UsernameText } from "../ui/UsernameText";
import { StarRatingBadge } from "../ui/StarRating";
import { getManiaJudgementStats } from "../ui/ManiaJudgementStats";
import { ModBadge } from "../ui/ModBadge";
import { DanBadge } from "../ui/DanBadge";
import { RecentPlayRatingCells } from "./RecentPlayRatingCells";
import type { RecentPlayRatingView } from "./recent-play-ratings";
import { useNoDans } from "../../store";
import { companellaReplayImportId } from "../../lib/companella-scores";
import type { OsuScore } from "../../lib/types";
import { getTrackedPlayRank } from "../../lib/tracked-play-score";
import { useLocale } from "../../lib/locale-context";

/* The profile's play rows and play popup, shared with pages that list plays
   the same way (the Companella page's imports). */

const FALLBACK_COVER_URL = "/images/headers/generic.jpg";

function fallbackCoverStyle(score: OsuScore): CSSProperties {
  const key = `${score.beatmapset?.artist ?? ""}\u0000${score.beatmapset?.title ?? ""}\u0000${score.beatmap?.version ?? ""}`;
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) | 0;
  const seed = Math.abs(hash);
  return { filter: `hue-rotate(${seed % 360}deg)`, objectPosition: `${Math.floor(seed / 360) % 101}% 50%` };
}

export function ScoreThumbnail({ score }: { score: OsuScore }) {
  const [failed, setFailed] = useState(false);
  const coverUrl = score.beatmapset?.covers?.list
    ?? score.beatmapset?.covers?.cover
    ?? (score.beatmapset?.id ? `/api/background?beatmapsetId=${score.beatmapset.id}` : null);

  if (coverUrl && !failed) {
    return (
      <img
        src={coverUrl}
        alt=""
        className="w-12 h-8 rounded object-cover flex-shrink-0"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }

  // No art (a chart osu! does not have, or a cover that failed).
  return (
    <img
      src={FALLBACK_COVER_URL}
      alt=""
      className="w-12 h-8 rounded object-cover flex-shrink-0"
      style={fallbackCoverStyle(score)}
      loading="lazy"
    />
  );
}

/** Which desktop metadata cells the current list needs. Reserving a cell that
 *  no visible row fills just pushes the map title away from its numbers, and
 *  skipping one a single row fills makes that row's numbers drift out of line
 *  with the rest, so the whole list agrees on the columns up front. */
/** A Best Performance row: an osu! window score, or a play only this site's
    tracking has. Both are real plays; only their provenance differs. */
export type BestListRow =
  | { kind: "score"; score: OsuScore }
  | { kind: "tracked"; play: LiveKeymodePpPlay };

export type ScoreRowLayout = {
  /** Badge count of the widest mod set on screen; 0 drops the column. */
  modColumns: number;
  showPp: boolean;
  showReplay: boolean;
};

const EMPTY_SCORE_ROW_LAYOUT: ScoreRowLayout = {
  modColumns: 0,
  showPp: false,
  showReplay: false,
};

/** Keep in sync with ModBadge's intrinsic size and the gap-0.5 between badges. */
const MOD_BADGE_WIDTH = 36;
const MOD_BADGE_GAP = 2;

/* Every visible row, not just the window ones. A keymode list can be all
   tracked rows, and reading the layout off the window scores alone gave that
   list modColumns: 0 and showPp: false, which drops the mods and the feature's
   own number on desktop while mobile still shows both. */
export function getScoreRowLayout(rows: BestListRow[]): ScoreRowLayout {
  const layout = { ...EMPTY_SCORE_ROW_LAYOUT };
  for (const row of rows) {
    if (row.kind === "tracked") {
      const { play } = row;
      layout.modColumns = Math.max(layout.modColumns, getModDisplayList(play.mods.map((acronym) => ({ acronym }))).length);
      layout.showPp = true;
      if (play.hasReplay === true && play.soloScoreId != null) layout.showReplay = true;
      continue;
    }
    const { score } = row;
    layout.modColumns = Math.max(layout.modColumns, getModDisplayList(score.mods).length);
    if (score.pp != null) layout.showPp = true;
    if (scoreHasReplay(score) || companellaReplayImportId(score) != null) layout.showReplay = true;
  }
  return layout;
}

const REPLAY_BUTTON_CLASS =
  "relative z-20 hidden flex-shrink-0 rounded-md border border-osu-pink/20 bg-osu-pink/15 px-2.5 py-1.5 text-[10px] font-semibold text-osu-pink-light sm:block";

/**
 * A play only this site's tracking has, drawn to sit in line with ScoreRow.
 *
 * It shows what the tracking stored and nothing else: combo and the replay
 * button are recorded at ingest, and a play from before that reads a dash
 * instead of a made-up zero. The cells it skips keep their width so the
 * numbers stay in their columns, and the details card it opens is built from
 * the same row rather than fetched.
 */
export function TrackedScoreRow({
  play,
  position,
  layout = EMPTY_SCORE_ROW_LAYOUT,
  onOpenDetails,
}: {
  play: LiveKeymodePpPlay;
  position: number;
  layout?: ScoreRowLayout;
  onOpenDetails: (play: LiveKeymodePpPlay) => void;
}) {
  const locale = useLocale();
  const { t } = useLingui();
  const mods = getModDisplayList(play.mods.map((acronym) => ({ acronym })));
  const coverUrl = play.beatmapsetId ? `/api/background?beatmapsetId=${play.beatmapsetId}` : null;
  const canReplay = play.hasReplay === true && play.soloScoreId != null;

  return (
    <div className="player-score-row relative flex items-center gap-2 sm:gap-3 py-2.5 px-3 rounded-lg bg-osu-b4/50 hover:bg-osu-b4 transition-colors duration-[120ms] cursor-pointer">
      {/* Same full-row target as a window score. */}
      <button
        type="button"
        onClick={() => onOpenDetails(play)}
        aria-label={t`Show details for ${play.title || t`score`}`}
        className="absolute inset-0 z-0 rounded-lg cursor-pointer"
      />
      <span className="pointer-events-none relative z-10 sm:hidden text-xs text-osu-f1 font-bold flex-shrink-0">{position}.</span>
      <div
        className="score-position-indicator pointer-events-none absolute -left-14 top-1/2 -translate-y-1/2 w-10 text-right text-white/90 opacity-0 translate-x-2 transition-all duration-150 ease-out hidden sm:block"
        style={{ fontFamily: "Venera" }}
      >
        <span className="block text-[24px] leading-none">{position}</span>
      </div>
      <div className="pointer-events-none relative z-10 flex items-center gap-2 sm:gap-3 flex-1 min-w-0">
        <GradeImg grade={getTrackedPlayRank(play)} size={28} />
        {coverUrl ? (
          <img src={coverUrl} alt="" className="w-12 h-8 rounded object-cover flex-shrink-0" loading="lazy" />
        ) : (
          <div className="w-12 h-8 rounded flex-shrink-0 border border-osu-b3/50 bg-osu-b4" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-white truncate">{play.title || t`Unknown`}</span>
            <span className="text-[11px] text-osu-f1 truncate hidden sm:inline">[{play.version}]</span>
            {play.keyCount > 0 && (
              <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-osu-b3/50 text-osu-yellow flex-shrink-0">
                {play.keyCount}K
              </span>
            )}
          </div>
          <span className="text-[11px] text-osu-f1">
            {play.artist}
            {play.playedAt && (
              <>
                {" "}&middot;{" "}
                <span suppressHydrationWarning title={formatTimeAgoTooltip(play.playedAt, locale)}>
                  {formatTimeAgo(play.playedAt, locale)}
                </span>
              </>
            )}
          </span>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 sm:hidden">
            <div className="flex flex-wrap items-center gap-0.5">
              {mods.map((m) => (
                <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} size={0.82} />
              ))}
            </div>
            <div className="ml-auto flex flex-shrink-0 items-center gap-1.5">
              {play.accuracy != null && (
                <span className="whitespace-nowrap text-xs text-osu-l2 tabular-nums">{formatAccuracy(play.accuracy)}</span>
              )}
              {play.maxCombo != null && (
                <span className="whitespace-nowrap text-xs text-osu-f1 tabular-nums">{formatNumber(play.maxCombo)}x</span>
              )}
              <span className="whitespace-nowrap text-sm font-bold tabular-nums text-osu-pink-light">{formatPP(play.pp)}</span>
              {canReplay && (
                <Link
                  to="/replay"
                  search={{ scoreId: play.soloScoreId ?? undefined, beatmapsetId: play.beatmapsetId ?? undefined }}
                  title={t`Watch replay`}
                  aria-label={t`Watch replay`}
                  className="pointer-events-auto inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-osu-pink/20 text-[9px] font-semibold leading-none text-osu-pink-light transition-colors hover:bg-osu-pink/30"
                >
                  <span aria-hidden="true">&#9654;</span>
                </Link>
              )}
            </div>
          </div>
        </div>
        <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
          {layout.modColumns > 0 && (
            <div
              className="flex flex-shrink-0 gap-0.5 justify-end"
              style={{ width: layout.modColumns * MOD_BADGE_WIDTH + (layout.modColumns - 1) * MOD_BADGE_GAP }}
            >
              {mods.map((m) => (
                <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} />
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="w-14 text-right text-xs tabular-nums text-osu-l2">
              {play.accuracy != null ? formatAccuracy(play.accuracy) : "-"}
            </span>
            <span className={`w-14 text-right text-xs tabular-nums ${play.maxCombo != null ? "text-osu-f1" : "text-osu-f1/40"}`}>
              {play.maxCombo != null ? `${formatNumber(play.maxCombo)}x` : "-"}
            </span>
            {layout.showPp && (
              <span className="w-16 text-right text-sm font-bold tabular-nums text-osu-pink-light">{formatPP(play.pp)}</span>
            )}
          </div>
        </div>
      </div>
      {canReplay ? (
        <Link
          to="/replay"
          search={{ scoreId: play.soloScoreId ?? undefined, beatmapsetId: play.beatmapsetId ?? undefined }}
          title={t`Watch replay`}
          aria-label={t`Watch replay`}
          className={`pointer-events-auto relative z-10 transition-colors hover:bg-osu-pink/25 ${REPLAY_BUTTON_CLASS}`}
        >
          {t`Replay`}
        </Link>
      ) : layout.showReplay ? (
        <span aria-hidden="true" className={`pointer-events-none invisible ${REPLAY_BUTTON_CLASS}`}>
          {t`Replay`}
        </span>
      ) : null}
    </div>
  );
}

export function ScoreRow({
  score,
  position,
  layout = EMPTY_SCORE_ROW_LAYOUT,
  onOpenDetails,
  showPlayer = false,
  showRating = false,
  rating,
}: {
  score: OsuScore;
  position: number;
  layout?: ScoreRowLayout;
  onOpenDetails: (score: OsuScore) => void;
  /* Lists that mix players (a team's plays) lead each row with whose it is. */
  showPlayer?: boolean;
  /* Recent's optional MSD and dan column. The cell keeps its width while the
     rating loads or when a play has none, so the columns stay lined up. */
  showRating?: boolean;
  rating?: RecentPlayRatingView | null;
}) {
  const locale = useLocale();
  const { t } = useLingui();
  const scoreFallbackLabel = t`score`;
  const keymodeLabel = getBeatmapKeymodeLabel(score.beatmap);
  // A Companella play opens by its import, and only when its replay is public.
  const importId = companellaReplayImportId(score);
  const canReplay = importId != null || scoreHasReplay(score);
  const replaySearch = importId != null ? { importId } : { scoreId: score.id, beatmapsetId: score.beatmapset?.id };
  const display = getScoreDisplayValues(score);
  const hasPp = score.pp != null;
  const noDans = useNoDans();
  const ratingKeyCount = Math.round(Number(score.beatmap?.cs)) || 4;

  const player = showPlayer ? score.user ?? null : null;
  const content = (
    <>
      {player ? (
        <img
          src={player.avatar_url}
          alt=""
          title={player.username}
          className="hidden h-8 w-8 flex-shrink-0 rounded-md object-cover sm:block"
        />
      ) : null}
      <GradeImg grade={display.rank} size={28} />
      <ScoreThumbnail score={score} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white truncate">
            {score.beatmapset?.title || t`Unknown`}
          </span>
          <span className="text-[11px] text-osu-f1 truncate hidden sm:inline">
            [{score.beatmap?.version}]
          </span>
          {keymodeLabel && (
            <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-osu-b3/50 text-osu-yellow flex-shrink-0">
              {keymodeLabel}
            </span>
          )}
          {score.companella && <CompanellaMark />}
          <span className="hidden sm:inline flex-shrink-0"><DanBadge score={score} /></span>
        </div>
        <span className="text-[11px] text-osu-f1">
          {player ? <><span className="font-semibold text-osu-l2">{player.username}</span> &middot;{" "}</> : null}
          {score.beatmapset?.artist} &middot;{" "}
          {/* Fresh scores are minutes old, so this half drifts between SSR and
              hydration; the artist name stays hydration-checked. */}
          {/* pointer-events-auto opts this one span back into hit testing: the
              content layer is inert so the full-row overlay can take the
              clicks, and an element that never sees the pointer never shows its
              title. The click handler keeps the patch acting like the row. */}
          <span
            suppressHydrationWarning
            title={formatTimeAgoTooltip(getScoreTimestamp(score), locale)}
            className="pointer-events-auto"
            onClick={() => onOpenDetails(score)}
          >
            {formatTimeAgo(getScoreTimestamp(score), locale)}
          </span>
        </span>
        {/* Mobile-only metadata row */}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 sm:hidden">
          <div className="flex max-w-full flex-shrink-0 flex-wrap items-center gap-1">
            <div className="flex flex-wrap items-center gap-0.5">
              {getModDisplayList(score.mods).map((m) => (
                <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} size={0.82} />
              ))}
            </div>
            <DanBadge score={score} />
            {showRating && <RecentPlayRatingCells rating={rating} keyCount={ratingKeyCount} hideDan={noDans} compact />}
          </div>
          <div className="ml-auto flex flex-shrink-0 items-center gap-1.5">
            <span className="whitespace-nowrap text-xs text-osu-l2 tabular-nums">{formatAccuracy(display.accuracy)}</span>
            <span className="whitespace-nowrap text-xs text-osu-f1 tabular-nums">{formatNumber(score.max_combo)}x</span>
            {hasPp && <span className="whitespace-nowrap text-sm font-bold tabular-nums text-osu-pink-light">{formatPP(score.pp)}</span>}
            {canReplay && (
              <Link
                to="/replay"
                search={replaySearch}
                title={t`Watch replay`}
                aria-label={t`Watch replay`}
                className="pointer-events-auto inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-osu-pink/20 text-[9px] font-semibold leading-none text-osu-pink-light transition-colors hover:bg-osu-pink/30"
              >
                <span aria-hidden="true">&#9654;</span>
              </Link>
            )}
          </div>
        </div>
      </div>
      {/* Desktop metadata. The numeric cells get fixed widths so accuracy,
          combo and pp line up down the list instead of drifting per row; the
          mod and pp cells only exist when some visible row fills them. */}
      <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
        {layout.modColumns > 0 && (
          <div
            className="flex flex-shrink-0 gap-0.5 justify-end"
            style={{ width: layout.modColumns * MOD_BADGE_WIDTH + (layout.modColumns - 1) * MOD_BADGE_GAP }}
          >
            {getModDisplayList(score.mods).map((m) => (
              <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} />
            ))}
          </div>
        )}
        {showRating && (
          <div className="flex flex-shrink-0 items-center justify-end gap-2">
            <RecentPlayRatingCells rating={rating} keyCount={ratingKeyCount} hideDan={noDans} />
          </div>
        )}
        {/* Accuracy, combo and pp read as one cluster, so they sit tighter
            together than the badge cells beside them. */}
        <div className="flex items-center gap-2">
          <span className="w-14 text-right text-xs tabular-nums text-osu-l2">{formatAccuracy(display.accuracy)}</span>
          <span className="w-14 text-right text-xs tabular-nums text-osu-f1">{formatNumber(score.max_combo)}x</span>
          {layout.showPp && (
            <span className="w-16 text-right text-sm font-bold tabular-nums text-osu-pink-light">
              {hasPp ? formatPP(score.pp) : ""}
            </span>
          )}
        </div>
      </div>
    </>
  );

  return (
    <div className="player-score-row relative flex items-center gap-2 sm:gap-3 py-2.5 px-3 rounded-lg bg-osu-b4/50 hover:bg-osu-b4 transition-colors duration-[120ms] cursor-pointer">
      {/* Full-row hit target. The osu! score page moved into the details modal,
          so this opens that instead of navigating away. */}
      <button
        type="button"
        onClick={() => onOpenDetails(score)}
        aria-label={t`Show details for ${score.beatmapset?.title || scoreFallbackLabel}`}
        className="absolute inset-0 z-0 rounded-lg cursor-pointer"
      />
      {/* Mobile inline position number */}
      <span className="pointer-events-none relative z-10 sm:hidden text-xs text-osu-f1 font-bold flex-shrink-0">{position}.</span>
      {/* Desktop hover position number */}
      <div
        className="score-position-indicator pointer-events-none absolute -left-14 top-1/2 -translate-y-1/2 w-10 text-right text-white/90 opacity-0 translate-x-2 transition-all duration-150 ease-out hidden sm:block"
        style={{ fontFamily: "Venera" }}
      >
        <span className="block text-[24px] leading-none">{position}</span>
      </div>
      <div className="pointer-events-none relative z-10 flex items-center gap-2 sm:gap-3 flex-1 min-w-0">
        {content}
      </div>
      {canReplay ? (
        <Link
          to="/replay"
          search={replaySearch}
          title={t`Watch replay`}
          aria-label={t`Watch replay`}
          className={`pointer-events-auto transition-colors hover:bg-osu-pink/25 ${REPLAY_BUTTON_CLASS}`}
        >
          {t`Replay`}
        </Link>
      ) : layout.showReplay ? (
        // Rows without a stored replay still hold the slot, otherwise their
        // numbers sit a button-width right of the rows that have one.
        <span aria-hidden="true" className={`pointer-events-none invisible ${REPLAY_BUTTON_CLASS}`}>
          {t`Replay`}
        </span>
      ) : null}
    </div>
  );
}

/** Value first, label under it: the number is what people came for, so it
 *  carries the weight and the caption stays out of the way. */
function ScoreDetailStat({ label, value, color }: { label: string; value: ReactNode; color?: string }) {
  return (
    <div>
      {/* The MAX gradient draws as an inline-block, which would otherwise sit
          on this line's default strut baseline and hang a few pixels below the
          plain judgement numbers. Matching leading here keeps the row level. */}
      <div className="leading-none">
        <div className={`text-base font-bold leading-none tabular-nums ${color ?? "text-white"}`}>{value}</div>
      </div>
      <div className="mt-1 text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
    </div>
  );
}

/** Everything the row can't fit: total score, judgement spread, map metadata,
 *  and the links (osu! page, replay) the row used to navigate to on its own. */
/** `extra` sits under the play's own stats, for pages that know more about it.
 *  `showPlayer` names whose play it is, for lists that mix players. */
export function ScoreDetailModal({ score, onClose, extra, showPlayer = false }: { score: OsuScore; onClose: () => void; extra?: ReactNode; showPlayer?: boolean }) {
  const { t } = useLingui();
  const locale = useLocale();
  const scoreTitleFallback = t`Score`;
  const display = getScoreDisplayValues(score);
  /* A play whose judgement counts were never stored (a tracked play from
     before the day-best rows kept them) would otherwise draw six zeros, which
     reads as a real score of nothing. The grid is dropped instead. */
  const judgements = getManiaJudgementStats(score);
  const hasJudgements = judgements.some((judgement) => judgement.value > 0);
  const mods = getModDisplayList(score.mods);
  const keymodeLabel = getBeatmapKeymodeLabel(score.beatmap);
  const scoreUrl = getScoreUrl(score);
  const beatmapUrl = getBeatmapUrl(score);
  const importId = companellaReplayImportId(score);
  const canReplay = importId != null || scoreHasReplay(score);
  const hasPp = score.pp != null;
  const playedAt = getScoreTimestamp(score);
  const viewerTimeZone = useViewerTimeZone();
  const cover = score.beatmapset?.covers?.["cover@2x"] || score.beatmapset?.covers?.cover;
  const [coverFailed, setCoverFailed] = useState(false);
  const fallbackStyle = fallbackCoverStyle(score);

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 sm:backdrop-blur-sm cursor-pointer p-4"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={t`${score.beatmapset?.title ?? scoreTitleFallback} details`}
        className="modal-card-mobile-safe relative isolate bg-osu-b4 border border-osu-b3/20 rounded-2xl w-[520px] max-w-full max-h-[85vh] overflow-hidden shadow-[0_12px_60px_rgba(0,0,0,0.7)] cursor-default"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t`Close`}
          className="absolute top-3 right-3 z-20 w-7 h-7 flex items-center justify-center rounded-full bg-black/30 text-white/80 hover:text-white hover:bg-black/50 transition-colors cursor-pointer"
        >
          <X size={14} />
        </button>

        <div className="max-h-[85vh] overflow-y-auto">
          {/* The cover gets a banner of its own instead of washing over the
              whole card, where it fought every number for contrast. */}
          <div className="relative h-[104px] overflow-hidden">
            {cover && !coverFailed ? (
              <img
                src={cover}
                alt=""
                className="absolute inset-0 h-full w-full object-cover"
                style={{ filter: "brightness(0.42) saturate(1.1)" }}
                onError={() => setCoverFailed(true)}
              />
            ) : (
              <img
                src={FALLBACK_COVER_URL}
                alt=""
                className="absolute inset-0 h-full w-full object-cover"
                style={{ ...fallbackStyle, filter: `${fallbackStyle.filter} brightness(0.42) saturate(1.1)` }}
              />
            )}
            <div className="absolute inset-0 bg-gradient-to-b from-osu-b4/10 via-osu-b4/55 to-osu-b4" />
            {/* Mods belong with the map they were played on, not floating in
                the middle of the numbers row. */}
            <div className="relative flex h-full items-end justify-between gap-3 px-4 pb-3 sm:px-5">
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  {beatmapUrl ? (
                    <a
                      href={beatmapUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-lg font-semibold text-white truncate hover:text-osu-pink-light underline-offset-2 hover:underline"
                      title={t`Open beatmap on osu!`}
                    >
                      {score.beatmapset?.title || t`Unknown`}
                    </a>
                  ) : (
                    <span className="text-lg font-semibold text-white truncate">
                      {score.beatmapset?.title || t`Unknown`}
                    </span>
                  )}
                  {keymodeLabel && (
                    <span className="px-1 py-0.5 rounded text-[8px] font-bold bg-osu-b3/50 text-osu-yellow flex-shrink-0">
                      {keymodeLabel}
                    </span>
                  )}
                  {score.companella && <CompanellaMark />}
                  <DanBadge score={score} />
                </div>
                <div className="mt-0.5 truncate text-[11px] text-osu-f1">
                  {score.beatmapset?.artist}
                  {score.beatmap?.version ? ` · [${score.beatmap.version}]` : ""}
                  {score.beatmapset?.creator ? ` · ${t`mapped by ${score.beatmapset.creator}`}` : ""}
                </div>
              </div>
              {mods.length > 0 && (
                <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1 pb-0.5">
                  {mods.map((m) => (
                    <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} />
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="px-4 pt-4 pb-5 sm:px-5">
            {/* Grade, accuracy and the headline number carry the card; pp is
                the headline where it exists, total score where it doesn't. */}
            <div className="flex items-center gap-3 sm:gap-4">
              <GradeImg grade={display.rank} size={46} />
              <div>
                <div className="text-2xl font-bold leading-none tabular-nums text-white sm:text-3xl">
                  {formatAccuracy(display.accuracy)}
                </div>
                <div className="mt-1.5 text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{t`Accuracy`}</div>
              </div>
              <div className="ml-auto text-right">
                <div
                  className={`text-2xl font-bold leading-none tabular-nums sm:text-3xl ${hasPp ? "text-osu-pink-light" : "text-white"}`}
                >
                  {hasPp ? formatPP(score.pp) : display.totalScore != null ? formatNumber(display.totalScore) : "-"}
                </div>
                <div className="mt-1.5 text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">
                  {/* Best-play rows know how much of this actually reaches the
                      profile total, which beats repeating the raw pp. */}
                  {hasPp ? (score.weight ? t`${Math.round(score.weight.percentage)}% weighted` : t`PP`) : t`Score`}
                </div>
              </div>
            </div>

            {/* Narrow screens wrap these into 3x2 and 2x2 blocks; centring the
                cells there keeps the wrapped rows reading as a grid instead of
                as columns with ragged space to their right. */}
            {hasJudgements && (
              <div className="mt-5 grid grid-cols-3 gap-3 text-center sm:grid-cols-6 sm:text-left">
                {judgements.map((judgement) => (
                  <ScoreDetailStat
                    key={judgement.label}
                    label={judgement.label}
                    value={formatNumber(judgement.value)}
                    color={judgement.className}
                  />
                ))}
              </div>
            )}

            <div className="mt-5 grid grid-cols-2 gap-3 text-center sm:grid-cols-4 sm:text-left">
              <ScoreDetailStat label={t`Combo`} value={score.max_combo ? `${formatNumber(score.max_combo)}x` : "-"} />
              {hasPp && (
                <ScoreDetailStat
                  label={t`Score`}
                  value={display.totalScore ? formatNumber(display.totalScore) : "-"}
                />
              )}
              <ScoreDetailStat
                label={t`Stars`}
                value={
                  score.beatmap?.difficulty_rating != null
                    ? <StarRatingBadge stars={score.beatmap.difficulty_rating} size={1.4} />
                    : "-"
                }
              />
              <ScoreDetailStat
                label={t`BPM`}
                value={score.beatmap?.bpm != null ? String(Math.round(score.beatmap.bpm)) : "-"}
              />
            </div>

            <div className="mt-5 flex flex-col gap-3 border-t border-osu-b3/20 pt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
                {showPlayer && score.user ? (
                  <Link
                    to="/player/$username"
                    params={{ username: score.user.username }}
                    className="flex min-w-0 items-center gap-2 hover:brightness-110"
                  >
                    {score.user.avatar_url ? (
                      <img src={score.user.avatar_url} alt="" className="h-6 w-6 shrink-0 rounded-md object-cover" />
                    ) : null}
                    <UsernameText username={score.user.username} avatarUrl={score.user.avatar_url} className="truncate text-[13px] font-bold text-white" />
                  </Link>
                ) : null}
                <span className="text-[11px] text-osu-f1" suppressHydrationWarning title={formatDate(playedAt, viewerTimeZone)}>
                  <Trans>Played {formatDetailedTimeAgo(playedAt, locale)} on {display.isLazer ? "Lazer" : "Stable"}</Trans>
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 sm:justify-end">
                {/* A tracked play whose row never kept a score id has no page
                    on osu! to open, so the link falls back to the map it was
                    set on rather than leaving the card with nothing to follow. */}
                {(scoreUrl ?? beatmapUrl) && (
                  <a
                    href={scoreUrl ?? beatmapUrl ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-osu-f1 hover:text-osu-pink-light transition-colors"
                  >
                    {scoreUrl ? t`View on osu!` : t`Open beatmap on osu!`}
                    <ExternalLink size={11} className="shrink-0" />
                  </a>
                )}
                {canReplay && (
                  <Link
                    to="/replay"
                    search={importId != null ? { importId } : { scoreId: score.id, beatmapsetId: score.beatmapset?.id }}
                    className="rounded-md border border-osu-pink/20 bg-osu-pink/15 px-2.5 py-1.5 text-[10px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/25"
                  >
                    {t`Watch replay`}
                  </Link>
                )}
              </div>
            </div>
            {extra}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
