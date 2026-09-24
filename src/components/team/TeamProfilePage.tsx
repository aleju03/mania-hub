import { useTeamTopPlayDates } from "./useTeamTopPlayDates";
import { loadTeamView, peekTeamView } from "../../lib/team-view-cache";
/* An osu! team as a profile: the player page's layout with every number built
   from the team's members (live-backend features/teams.ts). */

import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import {
  fetchLiveTeamCardDirect,
  fetchLiveTeamRecentDirect,
  fetchLiveTeamSkillsDirect,
  fetchLiveTeamSnapshotDirect,
  isLiveBackendConfigured,
  LiveBackendRequestError,
  type LiveTeamCard,
  type LiveTeamMember,
  type LiveTeamProfileSnapshot,
  type LiveTeamSkills,
} from "../../lib/live-backend";
import { formatAccuracy, formatDate, formatNumber } from "../../lib/format";
import { getRankTierClass } from "../../lib/rankings";
import { calculateUserProfileInsights, scoreToSnapshot } from "../../lib/profile-insights";
import { danBareLabel } from "../../lib/dan-images";
import { useNoDans } from "../../store";
import { cycleModFilterMode, reverseCycleModFilterMode, type ModFilterState } from "../../lib/mod-filter";
import {
  BestScoresControlBar,
  KeyModeControl,
  getAvailableKeyModes,
  getRelevantMods,
  matchesBestKeyFilter,
  matchesKeyFilter,
  matchesModFilter,
  sortBestScores,
  type BestAgeSort,
  type BestPpSort,
  type BestSort,
  type KeyFilter,
} from "../player/BestScoresControls";
import type { OsuScore } from "../../lib/types";
import { OsuLogo } from "../ui/OsuLogo";
import { CountryFlag } from "../ui/CountryFlag";
import { GradeImg } from "../ui/GradeImg";
import { ModBadge } from "../ui/ModBadge";
import { Skeleton } from "../ui/LoadingSkeleton";
import { Pagination } from "../ui/Pagination";
import { UsernameText } from "../ui/UsernameText";
import { BBCodePreview } from "../player/bbcode/BBCodePreview";
import { DanLevelBadge } from "../player/DanLevelBadge";
import { ScoreDetailModal, ScoreRow, getScoreRowLayout } from "../player/ScoreRows";
import { TeamActivityPanel } from "../player/ActivityPanel";
import { ManiaCard3DPanel, preloadManiaCard3DPanel } from "../player/maniacard3d/LazyManiaCard3DPanel";
import { teamImageProxyUrl } from "../../lib/team-image";
import type { ManiaSkills } from "../../lib/maniacard";
import { BpmBreakdownModal, ModUsageModal, PpDistributionModal } from "../player/InsightModals";
import {
  ExpandHint,
  HeroStat,
  INSIGHT_CELL_CLASS,
  INSIGHT_CELL_INTERACTIVE_CLASS,
  INSIGHT_LABEL_CLASS,
  INSIGHT_PANEL_CLASS,
  InsightsSkeleton,
  KEYMODE_BAR_COLORS,
  KEYMODE_TEXT_COLORS,
  KeySplitCard,
  PlayerScoreRowSkeleton,
  RailStat,
  TopPlayCard,
} from "../player/ProfileParts";

export type TeamTab = "best" | "recent" | "members" | "skills" | "about" | "card" | "activity";

export const TEAM_TABS: TeamTab[] = ["best", "recent", "members", "skills", "about", "card", "activity"];

const TEAM_TAB_LABELS: Record<TeamTab, MessageDescriptor> = {
  best: msg`Best Performance`,
  recent: msg`Recent Plays`,
  members: msg`Members`,
  skills: msg`Skills`,
  about: msg`About`,
  card: msg`Maniacard`,
  activity: msg`Activity`,
};

// The player page's batches: a list opens at five rows and grows by fifty, so
// switching tabs never swaps one long list for another.
const INITIAL_ROWS = 5;
const MORE_ROWS = 50;
const MAX_INLINE_KEY_MODES = 5;

// The tab body's last height, kept across tab switches (see TeamProfilePage).
let lastTabBodyHeight: number | null = null;

export function isTeamTab(value: unknown): value is TeamTab {
  return typeof value === "string" && (TEAM_TABS as string[]).includes(value);
}

export function TeamProfilePage({
  teamId,
  initialSnapshot,
  tab,
  onTabChange,
}: {
  teamId: number;
  initialSnapshot: LiveTeamProfileSnapshot | null;
  tab: TeamTab;
  onTabChange: (tab: TeamTab) => void;
}) {
  const { t, i18n } = useLingui();
  const [snapshot, setSnapshot] = useState<LiveTeamProfileSnapshot | null>(initialSnapshot);
  const [fullLoaded, setFullLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailScore, setDetailScore] = useState<OsuScore | null>(null);
  const [flagOpen, setFlagOpen] = useState(false);
  const [insightModal, setInsightModal] = useState<"mod" | "bpm" | "pp" | null>(null);
  // The list controls live on the page, as on a player's: the keymode strip
  // rides the tab row and the mod chips and sort sit under it. The keymode is
  // shared by Best and Recent, the mods and sort are Best's.
  const [keyFilter, setKeyFilter] = useState<KeyFilter>("all");
  const [modFilter, setModFilter] = useState<ModFilterState>({});
  const [sort, setSort] = useState<BestSort>("pp-desc");
  const [ppSort, setPpSort] = useState<BestPpSort>("pp-desc");
  const [ageSort, setAgeSort] = useState<BestAgeSort>("newest");
  const [recentScores, setRecentScores] = useState<OsuScore[] | null>(() => peekTeamView<OsuScore[]>(`recent:${teamId}`) ?? null);
  const [recentError, setRecentError] = useState<string | null>(null);
  /* Same floor the player's Skills panel keeps: swapping a tall tab for one
     whose data has not loaded takes height out of the document, the browser
     clamps the scroll to the shorter page and the reader lands back at the
     header. The body holds its last height until the incoming tab says it has
     content; a shorter tab then settles once instead of jumping twice. */
  const [heldHeight, setHeldHeight] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const releaseHeldHeight = useCallback(() => {
    requestAnimationFrame(() => setHeldHeight(null));
  }, []);
  const changeTab = useCallback((next: TeamTab) => {
    if (next === tab) return;
    setHeldHeight(lastTabBodyHeight);
    onTabChange(next);
  }, [onTabChange, tab]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const height = body.getBoundingClientRect().height;
      if (height > 0) lastTabBodyHeight = height;
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, [snapshot == null]);

  // Tabs drawn from the snapshot have their content on the first frame.
  useLayoutEffect(() => {
    if (tab === "members" || tab === "about" || (tab === "best" && fullLoaded)
      || (tab === "recent" && (recentScores != null || recentError != null))) releaseHeldHeight();
  }, [fullLoaded, recentError, recentScores, releaseHeldHeight, tab]);

  useEffect(() => {
    if (!flagOpen && !detailScore && !insightModal) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setFlagOpen(false);
      setDetailScore(null);
      setInsightModal(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [detailScore, flagOpen, insightModal]);

  // Recent is loaded on intent; opening another tab costs no score scan.
  useEffect(() => {
    if (recentScores != null) return;
    if (tab !== "recent" || !fullLoaded) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setRecentError(null);
      loadTeamView(`recent:${teamId}`, async () => (await fetchLiveTeamRecentDirect(teamId)).scores)
        .then((scores) => {
          if (!cancelled) setRecentScores(scores);
        })
        .catch(() => {
          if (!cancelled) setRecentError(t`Couldn't load recent plays right now.`);
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fullLoaded, recentScores, tab, teamId]);

  useEffect(() => {
    if (!isLiveBackendConfigured()) {
      setError(t`Teams need the server to be configured.`);
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setFullLoaded(false);
    setMissing(false);
    setError(null);
    const load = () => {
      fetchLiveTeamSnapshotDirect(teamId)
        .then((next) => {
          if (cancelled) return;
          if (!next) {
            setMissing(true);
            return;
          }
          setSnapshot(next);
          setFullLoaded(true);
        })
        .catch((loadError) => {
          if (cancelled) return;
          // Too many teams opened at once: keep loading and try again when
          // the server says a slot frees up.
          if (loadError instanceof LiveBackendRequestError && loadError.status === 429) {
            retryTimer = setTimeout(load, Math.min(60_000, Math.max(2_000, loadError.retryAfterMs ?? 10_000)));
            return;
          }
          setError(t`Couldn't load this team right now.`);
        });
    };
    load();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [teamId]);

  const liveTopPlayDates = useTeamTopPlayDates(teamId, snapshot?.members.map((member) => member.id) ?? [], fullLoaded);
  const topPlayDates = liveTopPlayDates ?? snapshot;

  const bestScores = fullLoaded ? snapshot?.bestScores ?? [] : [];
  const listScores = tab === "recent" ? recentScores ?? [] : bestScores;
  const listIsBest = tab !== "recent";
  const availableKeyModes = useMemo(() => getAvailableKeyModes(listScores), [listScores]);
  const keyModePlayCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const keyMode of availableKeyModes) {
      counts[keyMode] = listScores.filter((score) => (listIsBest ? matchesBestKeyFilter : matchesKeyFilter)(score, keyMode)).length;
    }
    return counts;
  }, [availableKeyModes, listIsBest, listScores]);
  const relevantMods = useMemo(() => getRelevantMods(bestScores), [bestScores]);
  const shownBest = useMemo(
    () => sortBestScores(bestScores.filter((score) => matchesBestKeyFilter(score, keyFilter) && matchesModFilter(score, modFilter)), sort),
    [bestScores, keyFilter, modFilter, sort],
  );
  const shownRecent = useMemo(
    () => (recentScores ?? []).filter((score) => matchesKeyFilter(score, keyFilter)),
    [keyFilter, recentScores],
  );
  const cycleMod = (mod: string, cycle: typeof cycleModFilterMode) => {
    setModFilter((previous) => {
      const next = { ...previous };
      const mode = cycle(previous[mod]);
      if (mode === undefined) delete next[mod];
      else next[mod] = mode;
      return next;
    });
  };
  const showKeyModes = (tab === "best" || tab === "recent") && availableKeyModes.length > 1;
  const hasTabControls = tab === "recent" ? showKeyModes : tab === "best" && bestScores.length > 0;

  const insights = useMemo(
    () => (fullLoaded && snapshot && snapshot.bestScores.length > 0 ? calculateUserProfileInsights(snapshot.bestScores) : null),
    [fullLoaded, snapshot],
  );

  // Every member's best plays rather than the merged top list, with the
  // keymodes a whole team barely touches left out.
  const keySplit = useMemo(() => {
    const entries = snapshot?.keySplit?.length ? snapshot.keySplit : insights?.keySplit ?? [];
    const total = entries.reduce((sum, entry) => sum + entry.count, 0);
    return { entries: entries.filter((entry) => Math.round((entry.count / total) * 100) >= 1), total };
  }, [snapshot, insights]);

  if (missing) {
    return (
      <div className="flex-1 bg-osu-b5">
        <div className="mx-auto max-w-[1200px] px-4 py-16 text-center text-sm text-osu-f1 sm:px-5">
          {t`osu! has no team with this id.`}
        </div>
      </div>
    );
  }
  if (!snapshot) {
    return error ? (
      <div className="flex-1 bg-osu-b5">
        <div className="mx-auto max-w-[1200px] px-4 py-16 text-center text-sm text-osu-f1 sm:px-5">{error}</div>
      </div>
    ) : <TeamPageSkeleton tab={tab} onTabChange={changeTab} />;
  }

  const { team, statistics } = snapshot;
  const membersById = new Map(snapshot.members.map((member) => [member.id, member]));
  const leader = team.leader_id != null ? membersById.get(team.leader_id) ?? null : null;
  const playerPeak = statistics.player_peak;
  const playerPeakMember = playerPeak ? membersById.get(playerPeak.user_id) ?? null : null;
  const createdValue = team.created_at ? formatDate(team.created_at) : null;

  return (
    <div className="flex-1">
      <AnimatePresence>
        {detailScore && <ScoreDetailModal score={detailScore} onClose={() => setDetailScore(null)} showPlayer />}
      </AnimatePresence>

      <AnimatePresence>
        {insightModal === "mod" && insights?.modBreakdown && insights.modBreakdown.length > 0 && (
          <ModUsageModal insights={insights} onClose={() => setInsightModal(null)} />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {insightModal === "bpm" && insights && insights.medianBpm != null && (
          <BpmBreakdownModal insights={insights} onClose={() => setInsightModal(null)} />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {insightModal === "pp" && insights?.ppRange && insights.ppDistribution.length > 0 && (
          <PpDistributionModal insights={insights} scores={bestScores} onClose={() => setInsightModal(null)} />
        )}
      </AnimatePresence>

      {/* The flag at full size, like a player's avatar. */}
      <AnimatePresence>
        {flagOpen && team.flag_url && (
          <motion.div
            className="fixed inset-0 z-50 flex cursor-pointer flex-col items-center justify-center bg-black/75 backdrop-blur-sm"
            onClick={() => setFlagOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.img
              src={team.flag_url}
              alt={t`${team.name}'s flag`}
              className="w-[min(512px,90vw)] rounded-2xl object-cover shadow-[0_12px_60px_rgba(0,0,0,0.7)]"
              onClick={(event) => event.stopPropagation()}
              initial={{ scale: 0.85, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.85, opacity: 0 }}
              transition={{ type: "spring", damping: 30, stiffness: 500 }}
            />
            <motion.div
              className="mt-4 flex flex-col items-center gap-2"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.15, delay: 0.05 }}
              onClick={(event) => event.stopPropagation()}
            >
              <span className="text-lg font-bold text-white">{team.name}</span>
              <a
                href={`https://osu.ppy.sh/teams/${team.id}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-osu-f1 transition-colors hover:text-osu-l2"
              >
                <Trans>View osu! team</Trans>
              </a>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <header className="relative isolate overflow-hidden bg-osu-b4">
        {team.cover_url && (
          <img
            src={team.cover_url}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            style={{ filter: "brightness(0.34) saturate(1.15)" }}
          />
        )}
        <div className="absolute inset-0 bg-[radial-gradient(135%_120%_at_12%_0%,rgba(0,0,0,0.25),rgba(0,0,0,0.82))]" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b from-transparent to-osu-b5" />

        <div className="relative mx-auto max-w-[1200px] px-4 pt-8 pb-7 sm:px-5 sm:pt-12 sm:pb-9">
          <div className="flex items-center gap-4 sm:gap-5">
            {team.flag_url ? (
              <button
                type="button"
                onClick={() => setFlagOpen(true)}
                aria-label={t`View ${team.name}'s flag`}
                className="h-[64px] w-[128px] flex-shrink-0 cursor-pointer overflow-hidden rounded-2xl shadow-[0_10px_30px_rgba(0,0,0,0.45)] ring-2 ring-white/15 transition duration-150 hover:ring-osu-pink/70 sm:h-[112px] sm:w-[224px]"
              >
                {/* osu! team flags are 2:1. */}
                <img src={team.flag_url} alt="" className="h-full w-full object-cover" />
              </button>
            ) : null}
            <div className="min-w-0 flex-1">
              <h1 className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-2">
                {/* `truncate` clips at the padding box, which leading-none makes
                    tighter than the ink, so a descender lost its tail. Same
                    padding/-margin pair as the player name. */}
                <span className="-m-2 min-w-0 truncate p-2 text-[26px] font-black leading-none text-white sm:text-[40px]">{team.name}</span>
                <span className="shrink-0 text-[15px] font-bold leading-none text-white/45 sm:text-[20px]">{team.short_name}</span>
              </h1>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-white/50">
                <a
                  href={`https://osu.ppy.sh/teams/${team.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full bg-white/10 py-0.5 pl-0.5 pr-2 font-semibold text-white/80 transition-colors duration-150 hover:bg-white/20 hover:text-white"
                >
                  <span className="h-4 w-4 rounded-full bg-osu-pink text-white">
                    <OsuLogo className="h-4 w-4" />
                  </span>
                  <Trans>osu! team</Trans>
                </a>
                {leader ? (
                  <span className="inline-flex items-center gap-1">
                    <Trans>Leader</Trans>
                    <Link
                      to="/player/$username"
                      params={{ username: leader.username }}
                      className="font-semibold text-white/80 hover:text-white"
                    >
                      {leader.username}
                    </Link>
                  </span>
                ) : null}
                {snapshot.countedMembers < snapshot.memberCount ? (
                  <span>
                    <Trans>{snapshot.countedMembers} of {snapshot.memberCount} members counted</Trans>
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          <div className="mt-7 grid grid-cols-2 gap-x-6 gap-y-5 sm:mt-9 sm:flex sm:flex-wrap sm:items-end sm:gap-x-12">
            <HeroStat
              label={t`Global`}
              value={statistics.global_rank ? `#${formatNumber(statistics.global_rank)}` : "-"}
            />
            <HeroStat
              label={t`Peak`}
              value={statistics.peak ? `#${formatNumber(statistics.peak.rank)}` : "-"}
              sub={statistics.peak ? formatDate(statistics.peak.ranked_at) : null}
            />
            <HeroStat
              label={t`Player Peak`}
              value={playerPeak ? `#${formatNumber(playerPeak.rank)}` : "-"}
              valueClassName={playerPeak ? getRankTierClass(playerPeak.rank) || "text-white" : "text-white"}
              sub={playerPeak && playerPeakMember ? (
                playerPeak.updated_at
                  ? t`${playerPeakMember.username}, ${formatDate(playerPeak.updated_at)}`
                  : playerPeakMember.username
              ) : null}
            />
            <HeroStat
              label={t`Performance`}
              value={statistics.performance != null ? `${formatNumber(Math.round(statistics.performance))}pp` : "-"}
              valueClassName="text-osu-yellow"
              sub={statistics.pp_4k != null || statistics.pp_7k != null ? (
                <span className="inline-flex items-center gap-2.5 tabular-nums">
                  {([["4k", statistics.pp_4k], ["7k", statistics.pp_7k]] as const).map(([variant, pp]) => (
                    pp != null ? (
                      <span key={variant}>
                        <span className="font-bold uppercase text-white/35">{variant} </span>
                        <span className="font-semibold text-white/70">{formatNumber(Math.round(pp))}</span>
                      </span>
                    ) : null
                  ))}
                </span>
              ) : null}
            />
          </div>
        </div>
      </header>

      <div className="bg-osu-b5">
        <div className={`mx-auto max-w-[1200px] px-4 sm:px-5 ${hasTabControls ? "pb-4" : ""}`}>
          <div className="relative flex flex-wrap items-center gap-x-8 gap-y-5 border-b border-osu-b3/25 py-5 sm:gap-x-12">
            <RailStat label={t`Accuracy`} value={statistics.accuracy != null ? formatAccuracy(statistics.accuracy / 100) : "-"} />
            <RailStat label={t`Play Count`} value={statistics.play_count != null ? formatNumber(statistics.play_count) : "-"} />
            <RailStat
              label={t`Play Time`}
              value={statistics.play_time != null ? t`${formatNumber(Math.floor(statistics.play_time / 3600))}h` : "-"}
            />
            <RailStat label={t`Members`} value={formatNumber(snapshot.memberCount)} />
            {createdValue ? (
              <div className="text-[11px] text-osu-f1">
                <Trans>Created <strong className="font-semibold text-osu-l2">{createdValue}</strong></Trans>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:ml-auto">
              {([
                ["SSH", statistics.grade_counts.ssh],
                ["SS", statistics.grade_counts.ss],
                ["SH", statistics.grade_counts.sh],
                ["S", statistics.grade_counts.s],
                ["A", statistics.grade_counts.a],
              ] as [string, number][]).map(([grade, count]) => (
                <div key={grade} className="flex items-center gap-1.5">
                  <GradeImg grade={grade} size={26} />
                  <span className="text-xs font-semibold tabular-nums text-osu-f1">{formatNumber(count)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3 py-5">
            {!fullLoaded ? (
              <InsightsSkeleton />
            ) : insights && insights.sampleSize > 0 ? (
              <div className="space-y-3">
                <div className={INSIGHT_PANEL_CLASS}>
                  <KeySplitCard keySplit={keySplit.entries} sampleSize={keySplit.total} />
                  <div
                    className={`${INSIGHT_CELL_CLASS} group ${insights.mostUsedMod ? INSIGHT_CELL_INTERACTIVE_CLASS : ""}`}
                    onClick={insights.mostUsedMod ? () => setInsightModal("mod") : undefined}
                  >
                    <div className="flex items-center justify-between">
                      <div className={INSIGHT_LABEL_CLASS}>{t`Most Used Mod`}</div>
                      {insights.mostUsedMod && <ExpandHint />}
                    </div>
                    {insights.mostUsedMod ? (
                      <>
                        <div className="mt-2 flex items-center gap-2">
                          <ModBadge mod={insights.mostUsedMod.label} />
                          <span className="text-[26px] font-black leading-none text-white">{insights.mostUsedMod.label}</span>
                        </div>
                        <div className="mt-auto flex items-center gap-2 pt-2.5">
                          <div className="h-1 flex-1 overflow-hidden rounded-full bg-osu-b3/50">
                            <div
                              className="h-full rounded-full bg-osu-yellow"
                              style={{ width: `${Math.round((insights.mostUsedMod.count / insights.mostUsedMod.total) * 100)}%` }}
                            />
                          </div>
                          <span className="text-[10px] tabular-nums text-osu-f1">
                            {Math.round((insights.mostUsedMod.count / insights.mostUsedMod.total) * 100)}%
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="mt-2 text-sm text-osu-f1">{t`No mod preference`}</div>
                    )}
                  </div>
                  <div
                    className={`${INSIGHT_CELL_CLASS} group ${insights.medianBpm != null ? INSIGHT_CELL_INTERACTIVE_CLASS : ""}`}
                    onClick={insights.medianBpm != null ? () => setInsightModal("bpm") : undefined}
                  >
                    <div className="flex items-center justify-between">
                      <div className={INSIGHT_LABEL_CLASS}>{t`Median BPM`}</div>
                      {insights.medianBpm != null && <ExpandHint />}
                    </div>
                    {insights.medianBpm != null ? (
                      <>
                        <div className="mt-2 flex items-baseline gap-1.5">
                          <span className="text-[26px] font-black leading-none tabular-nums text-white">{Math.round(insights.medianBpm)}</span>
                          <span className="text-[11px] font-semibold text-osu-f1">{t`BPM`}</span>
                        </div>
                        {insights.bpmRange && (
                          <div className="mt-auto pt-2.5 text-[11px] tabular-nums text-osu-f1">
                            <Trans>{Math.round(insights.bpmRange.min)} to {Math.round(insights.bpmRange.max)}</Trans>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="mt-2 text-sm text-osu-f1">-</div>
                    )}
                  </div>
                  <div
                    className={`${INSIGHT_CELL_CLASS} group ${insights.ppRange && insights.ppDistribution.length > 0 ? INSIGHT_CELL_INTERACTIVE_CLASS : ""}`}
                    onClick={insights.ppRange && insights.ppDistribution.length > 0 ? () => setInsightModal("pp") : undefined}
                  >
                    <div className="flex items-center justify-between">
                      <div className={INSIGHT_LABEL_CLASS}>{t`PP Range`}</div>
                      {insights.ppRange && insights.ppDistribution.length > 0 && <ExpandHint />}
                    </div>
                    {insights.ppRange ? (
                      <>
                        <div className="mt-2 flex items-baseline gap-1.5">
                          <span className="text-[26px] font-black leading-none tabular-nums text-osu-pink-light">{Math.round(insights.ppRange.top)}</span>
                          <span className="text-[11px] text-osu-f1">{t`to`}</span>
                          <span className="text-[26px] font-black leading-none tabular-nums text-white">{Math.round(insights.ppRange.bottom)}</span>
                        </div>
                        <div className="mt-auto pt-2.5 text-[11px] text-osu-f1">{t`${Math.round(insights.ppRange.top - insights.ppRange.bottom)}pp spread`}</div>
                      </>
                    ) : (
                      <div className="mt-2 text-sm text-osu-f1">-</div>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
            {fullLoaded && ((insights?.sampleSize ?? 0) > 0 || topPlayDates?.newestTopPlay || topPlayDates?.oldestTopPlay) ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <TopPlayCard label={t`Newest Top Play`} snapshot={topPlayDates?.newestTopPlay ? scoreToSnapshot(topPlayDates.newestTopPlay) : null} />
                <TopPlayCard label={t`Oldest Top Play`} snapshot={topPlayDates?.oldestTopPlay ? scoreToSnapshot(topPlayDates.oldestTopPlay) : null} />
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-3 border-t border-osu-b3/25 pt-1 lg:flex-row lg:items-center lg:justify-between">
            <div className="-mx-4 overflow-x-auto px-4 scrollbar-hide sm:mx-0 sm:px-0">
              <div className="flex min-w-max">
                {TEAM_TABS.map((teamTab) => (
                  <button
                    key={teamTab}
                    type="button"
                    onPointerEnter={teamTab === "card" ? preloadManiaCard3DPanel : undefined}
                    onFocus={teamTab === "card" ? preloadManiaCard3DPanel : undefined}
                    onClick={() => changeTab(teamTab)}
                    className={`relative shrink-0 cursor-pointer whitespace-nowrap px-4 py-3 text-[12px] font-semibold transition-colors duration-[120ms] ${tab === teamTab ? "text-white" : "text-osu-f1 hover:text-osu-l2"}`}
                  >
                    {i18n._(TEAM_TAB_LABELS[teamTab])}
                    {tab === teamTab && (
                      <motion.span
                        layoutId="team-tab-indicator"
                        className="absolute inset-x-2.5 bottom-0 h-[2px] rounded-full bg-osu-h1"
                        transition={{ type: "spring", stiffness: 420, damping: 34 }}
                      />
                    )}
                  </button>
                ))}
              </div>
            </div>
            {showKeyModes ? (
              <div className="hidden min-w-0 items-center gap-2 lg:flex">
                <KeyModeControl
                  availableKeyModes={availableKeyModes}
                  keyFilter={keyFilter}
                  onChangeKeyFilter={setKeyFilter}
                  maxVisible={MAX_INLINE_KEY_MODES}
                  playCounts={keyModePlayCounts}
                />
              </div>
            ) : null}
          </div>

          {tab === "best" && bestScores.length > 0 ? (
            <BestScoresControlBar
              availableKeyModes={availableKeyModes}
              keyFilter={keyFilter}
              onChangeKeyFilter={setKeyFilter}
              maxInlineKeyModes={MAX_INLINE_KEY_MODES}
              keyModePlayCounts={keyModePlayCounts}
              mods={relevantMods}
              modFilter={modFilter}
              onCycleMod={(mod) => cycleMod(mod, cycleModFilterMode)}
              onReverseCycleMod={(mod) => cycleMod(mod, reverseCycleModFilterMode)}
              onClearMods={() => setModFilter({})}
              sort={sort}
              ppSort={ppSort}
              ageSort={ageSort}
              onChangeSort={(next) => {
                setSort(next);
                if (next === "pp-desc" || next === "pp-asc") setPpSort(next);
                else setAgeSort(next);
              }}
            />
          ) : null}
          {tab === "recent" && showKeyModes ? (
            <div className="mt-3 flex justify-end lg:hidden">
              <KeyModeControl
                availableKeyModes={availableKeyModes}
                keyFilter={keyFilter}
                onChangeKeyFilter={setKeyFilter}
                maxVisible={MAX_INLINE_KEY_MODES}
                playCounts={keyModePlayCounts}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-t border-osu-b3/20 bg-osu-b5">
        <div
          ref={bodyRef}
          className="mx-auto max-w-[1200px] px-4 py-5 sm:px-5"
          style={heldHeight != null ? { minHeight: heldHeight } : undefined}
        >
          {tab === "best" ? (
            fullLoaded ? (
              <TeamScoreList
                key={`${keyFilter}|${JSON.stringify(modFilter)}|${sort}`}
                scores={shownBest}
                empty={bestScores.length === 0 ? t`No top plays from this team's members yet.` : t`No scores found`}
                onOpenDetails={setDetailScore}
              />
            ) : <RowsSkeleton />
          ) : tab === "recent" ? (
            recentError ? (
              <div className="rounded-xl bg-osu-b4 p-5 text-center text-sm text-osu-f1">{recentError}</div>
            ) : recentScores ? (
              <TeamScoreList
                key={keyFilter}
                scores={shownRecent}
                empty={recentScores.length === 0 ? t`No tracked plays from this team's members yet.` : t`No scores found`}
                onOpenDetails={setDetailScore}
              />
            ) : <RowsSkeleton />
          ) : tab === "members" ? (
            <TeamMembersList members={snapshot.members} leaderId={team.leader_id} />
          ) : tab === "skills" ? (
            <TeamSkillsPanel teamId={teamId} members={snapshot.members} onReady={releaseHeldHeight} />
          ) : tab === "about" ? (
            team.description?.trim() ? (
              <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
                <div className="bbcode-content px-4 py-3 text-sm text-osu-l2">
                  <BBCodePreview source={team.description} />
                </div>
              </div>
            ) : (
              <div className="rounded-xl bg-osu-b4 p-5 text-center text-sm text-osu-f1">{t`This team has no description.`}</div>
            )
          ) : tab === "card" ? (
            <TeamCardPanel team={team} onReady={releaseHeldHeight} />
          ) : (
            <TeamActivityPanel teamId={teamId} members={snapshot.members} onReady={releaseHeldHeight} />
          )}
        </div>
      </div>
    </div>
  );
}

/* One of the page's lists, already filtered and sorted by the page's controls.
   Remounted when the filters change, which resets it to its first batch. */
function TeamScoreList({
  scores,
  empty,
  onOpenDetails,
}: {
  scores: OsuScore[];
  empty: string;
  onOpenDetails: (score: OsuScore) => void;
}) {
  const { t } = useLingui();
  const [visible, setVisible] = useState(INITIAL_ROWS);
  const shown = scores.slice(0, visible);
  const layout = getScoreRowLayout(shown.map((score) => ({ kind: "score" as const, score })));

  if (scores.length === 0) {
    return <div className="py-8 text-center text-sm text-osu-f1">{empty}</div>;
  }

  return (
    <div className="space-y-1.5">
      {shown.map((score, index) => (
        <ScoreRow
          key={`${score.id}-${score.user_id}`}
          score={score}
          position={index + 1}
          layout={layout}
          onOpenDetails={onOpenDetails}
          showPlayer
        />
      ))}
      {scores.length > shown.length ? (
        <div className="flex justify-center pt-3">
          <button
            type="button"
            onClick={() => setVisible((count) => count + MORE_ROWS)}
            className="cursor-pointer rounded-lg border border-osu-b3/30 bg-osu-b4 px-4 py-2 text-[12px] font-semibold text-osu-l2 transition-colors hover:bg-osu-b3"
          >
            {t`Show more`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

const MEMBERS_PAGE_SIZE = 50;

function TeamMembersList({ members, leaderId }: { members: LiveTeamMember[]; leaderId: number | null }) {
  const { t } = useLingui();
  // Zero-based, as Pagination counts.
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(members.length / MEMBERS_PAGE_SIZE));
  const offset = page * MEMBERS_PAGE_SIZE;
  return (
    <div className="space-y-1.5">
      {members.slice(offset, offset + MEMBERS_PAGE_SIZE).map((member, index) => (
        <Link
          key={member.id}
          to="/player/$username"
          params={{ username: member.username }}
          className={`flex items-center gap-3 rounded-lg bg-osu-b4/50 px-3 py-2.5 transition-colors duration-[120ms] hover:bg-osu-b4 ${member.counted ? "" : "opacity-60"}`}
        >
          <span className="w-6 shrink-0 text-right text-[11px] tabular-nums text-osu-f1">{offset + index + 1}</span>
          {member.avatar_url ? (
            <img src={member.avatar_url} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" loading="lazy" />
          ) : (
            <span className="h-9 w-9 shrink-0 rounded-lg bg-osu-b3/50" />
          )}
          <CountryFlag code={member.country_code} decorative />
          <div className="min-w-0 flex-1">
            <UsernameText username={member.username} avatarUrl={member.avatar_url} className="block truncate text-sm font-bold text-white" />
            {member.id === leaderId ? <div className="text-[11px] text-osu-f1">{t`Leader`}</div> : null}
          </div>
          <span className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-osu-l2 sm:block">
            {member.accuracy != null ? formatAccuracy(member.accuracy / 100) : "-"}
          </span>
          <span className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-osu-f1 sm:block">
            {member.global_rank != null ? `#${formatNumber(member.global_rank)}` : "-"}
          </span>
          <span className="w-20 shrink-0 text-right text-sm font-bold tabular-nums text-osu-pink-light">
            {member.pp != null ? `${formatNumber(Math.round(member.pp))}pp` : "-"}
          </span>
        </Link>
      ))}
      {totalPages > 1 ? (
        <div className="pt-3">
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </div>
      ) : null}
    </div>
  );
}

type DanGroup = { label: string; rawDan: number; members: LiveTeamMember[] };

function groupDans(
  skills: LiveTeamSkills,
  membersById: Map<number, LiveTeamMember>,
  keyCount: number,
  side: "rc" | "ln",
): DanGroup[] {
  const groups = new Map<string, DanGroup>();
  for (const entry of skills.members) {
    const mode = entry.modes.find((candidate) => candidate.keyCount === keyCount);
    const dan = mode?.[side];
    const member = membersById.get(entry.userId);
    if (!dan || !member) continue;
    const label = danBareLabel(dan.label);
    let group = groups.get(label);
    if (!group) {
      group = { label, rawDan: dan.rawDan, members: [] };
      groups.set(label, group);
    }
    group.rawDan = Math.max(group.rawDan, dan.rawDan);
    group.members.push(member);
  }
  return [...groups.values()].sort((a, b) => b.rawDan - a.rawDan);
}

function TeamSkillsPanel({ teamId, members, onReady }: { teamId: number; members: LiveTeamMember[]; onReady: () => void }) {
  const { t } = useLingui();
  const noDans = useNoDans();
  const [skills, setSkills] = useState<LiveTeamSkills | null>(() => peekTeamView<LiveTeamSkills>(`skills:${teamId}`) ?? null);
  const [error, setError] = useState<string | null>(null);
  const membersById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const ready = skills != null || error != null;
  useLayoutEffect(() => {
    if (ready) onReady();
  }, [onReady, ready]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    loadTeamView(`skills:${teamId}`, () => fetchLiveTeamSkillsDirect(teamId))
      .then((result) => {
        if (!cancelled) setSkills(result);
      })
      .catch(() => {
        if (!cancelled) setError(t`Couldn't load skills right now.`);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  if (error) return <div className="rounded-xl bg-osu-b4 p-5 text-center text-sm text-osu-f1">{error}</div>;
  if (!skills) return <RowsSkeleton />;
  if (skills.members.length === 0) {
    return <div className="rounded-xl bg-osu-b4 p-5 text-center text-sm text-osu-f1">{t`No skill ratings for this team's members yet.`}</div>;
  }

  // Keymodes by how many members have a rating there, 4K and 7K first on ties.
  const keyCounts = new Map<number, number>();
  for (const entry of skills.members) {
    for (const mode of entry.modes) keyCounts.set(mode.keyCount, (keyCounts.get(mode.keyCount) ?? 0) + 1);
  }
  const keyModes = [...keyCounts.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([keyCount]) => keyCount);
  const formatDanChip = (label: string): string => (/^\d/.test(label) ? t`${label} dan` : label);

  return (
    <div>
      <div className="text-[11px] text-osu-f1">
        <Trans>{skills.members.length} of {skills.memberCount} members rated</Trans>
      </div>
      {keyModes.map((keyCount) => {
        const rated = keyCounts.get(keyCount) ?? 0;
        const sides = noDans ? [] : (["rc", "ln"] as const)
          .map((side) => ({ side, groups: groupDans(skills, membersById, keyCount, side).reverse() }))
          .filter(({ groups }) => groups.length > 0);
        const overall = sides.length > 0 ? [] : skills.members
          .map((entry) => ({ member: membersById.get(entry.userId), overall: entry.modes.find((mode) => mode.keyCount === keyCount)?.overall ?? null }))
          .filter((entry): entry is { member: LiveTeamMember; overall: number } => entry.member != null && entry.overall != null)
          .sort((a, b) => b.overall - a.overall);
        return (
          <section key={keyCount} className="border-b border-white/[0.07] py-6 last:border-b-0">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className={`text-[22px] font-black leading-none ${KEYMODE_TEXT_COLORS[keyCount] ?? "text-white"}`}>{keyCount}K</h2>
              <span className="text-[11px] text-osu-f1">
                <Plural value={rated} one="# member" other="# members" />
              </span>
            </div>
            {sides.length > 0 ? (
              <div className={`mt-5 grid gap-x-10 gap-y-7 ${sides.length > 1 ? "lg:grid-cols-2" : ""}`}>
                {sides.map(({ side, groups }) => (
                  <DanHistogram
                    key={side}
                    title={side === "rc" ? t`Regular` : t`LN`}
                    groups={groups}
                    keyCount={keyCount}
                    side={side}
                    formatLabel={formatDanChip}
                  />
                ))}
              </div>
            ) : overall.length > 0 ? (
              <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
                {overall.slice(0, 8).map(({ member, overall: rating }) => (
                  <Link
                    key={member.id}
                    to="/player/$username"
                    params={{ username: member.username }}
                    className="flex items-baseline gap-1.5 hover:brightness-110"
                  >
                    <UsernameText username={member.username} avatarUrl={member.avatar_url} className="text-[13px] font-semibold text-osu-l2" />
                    <span className="text-[15px] font-black tabular-nums text-white">{rating.toFixed(2)}</span>
                  </Link>
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

/* One bar per dan the team has members at, lowest on the left, so the shape
   of the roster reads before any number does. Hovering or tapping a bar names
   who is there. */
function DanHistogram({
  title,
  groups,
  keyCount,
  side,
  formatLabel,
}: {
  title: string;
  groups: DanGroup[];
  keyCount: number;
  side: "rc" | "ln";
  formatLabel: (label: string) => string;
}) {
  const most = groups.reduce((top, group) => Math.max(top, group.members.length), 0);
  const barColor = KEYMODE_BAR_COLORS[keyCount] ?? "bg-osu-pink";
  // Fixed to the viewport, since the row scrolls sideways on a phone and
  // would clip anything hanging out of it.
  const [active, setActive] = useState<{ label: string; x: number; y: number } | null>(null);
  const show = (label: string, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setActive({ label, x: rect.left + rect.width / 2, y: rect.top });
  };
  useEffect(() => {
    if (!active) return;
    const hide = () => setActive(null);
    window.addEventListener("scroll", hide, { passive: true });
    return () => window.removeEventListener("scroll", hide);
  }, [active]);
  const activeGroup = active ? groups.find((group) => group.label === active.label) ?? null : null;
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-osu-f1">{title}</div>
      <div className="mt-3 flex items-end gap-1 overflow-x-auto pb-1 sm:gap-2">
        {groups.map((group) => {
          return (
            <button
              key={group.label}
              type="button"
              className="group flex w-7 shrink-0 flex-col items-center focus:outline-none sm:w-11"
              onPointerEnter={(event) => show(group.label, event.currentTarget)}
              onPointerLeave={() => setActive(null)}
              onFocus={(event) => show(group.label, event.currentTarget)}
              onBlur={() => setActive(null)}
              onClick={(event) => show(group.label, event.currentTarget)}
            >
              <span className="mb-1 text-[15px] font-black tabular-nums text-white">{group.members.length}</span>
              <span
                className={`block w-full rounded-t-md ${barColor} opacity-80 transition group-hover:opacity-100 group-hover:brightness-110 group-focus-visible:opacity-100`}
                style={{ height: `${Math.max(6, Math.round((group.members.length / most) * 112))}px` }}
              />
              <span className="mt-2">
                <DanLevelBadge label={group.label} keyCount={keyCount} side={side} formatLabel={formatLabel} approximate={false} />
              </span>
            </button>
          );
        })}
      </div>
      {active && activeGroup ? (
        <div
          className="pointer-events-none fixed z-50 w-max max-w-[260px] -translate-x-1/2 -translate-y-full rounded-lg bg-osu-b6 px-3 py-2 text-[12px] leading-snug text-osu-l1 shadow-lg"
          style={{ left: Math.min(Math.max(active.x, 138), window.innerWidth - 138), top: active.y - 6 }}
        >
          {activeGroup.members.map((member) => member.username).join(", ")}
        </div>
      ) : null}
    </div>
  );
}

function TeamCardPanel({ team, onReady }: { team: LiveTeamProfileSnapshot["team"]; onReady: () => void }) {
  const { t } = useLingui();
  const [card, setCard] = useState<LiveTeamCard | null | undefined>(() => peekTeamView<LiveTeamCard | null>(`card:${team.id}`));
  const [error, setError] = useState<string | null>(null);
  // The card holds a fixed 5:7 box from its first frame, so it is ready now.
  useLayoutEffect(() => {
    onReady();
  }, [onReady]);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    loadTeamView(`card:${team.id}`, async () => (await fetchLiveTeamCardDirect(team.id)).card)
      .then((card) => {
        if (!cancelled) setCard(card);
      })
      .catch(() => {
        if (!cancelled) setError(t`Couldn't load the Maniacard right now.`);
      });
    return () => {
      cancelled = true;
    };
  }, [team.id]);

  // The card renderer reads a player's shape; a team fills it with its name,
  // its flag and the averaged numbers. A negative id keeps it clear of every
  // per-player lookup the renderer does by id.
  const cardUser = useMemo(() => ({ id: -team.id, username: team.name, avatar_url: "", country_code: "" }), [team.id, team.name]);
  const skills = useMemo<ManiaSkills | null>(() => card ? {
    starAvg: card.starAvg,
    fingerControl: card.fingerControl,
    speed: card.speed,
    accuracy: card.accuracy,
    stamina: 0,
    versatility: 0,
    peak: 0,
    cardPower: card.cardPower,
    mainKeyMode: card.mainKeyMode,
    archetype: "",
    sampleSize: 0,
  } : null, [card]);
  const cardTeam = useMemo(() => ({
    flagUrl: teamImageProxyUrl(team.flag_url),
    coverUrl: teamImageProxyUrl(team.cover_url),
    tag: team.short_name || team.name,
  }), [team.cover_url, team.flag_url, team.name, team.short_name]);

  if (error) return <div className="rounded-xl bg-osu-b4 p-5 text-center text-sm text-osu-f1">{error}</div>;
  if (card === null) {
    return <div className="rounded-xl bg-osu-b4 p-5 text-center text-sm text-osu-f1">{t`No member of this team has a Maniacard yet.`}</div>;
  }
  return (
    <div>
      <ManiaCard3DPanel
        user={cardUser}
        scores={[]}
        precomputedSkills={skills ?? undefined}
        loading={card === undefined}
        team={cardTeam}
      />
    </div>
  );
}

function RowsSkeleton() {
  return (
    <div className="space-y-1.5">
      {Array.from({ length: 5 }).map((_, index) => <PlayerScoreRowSkeleton key={index} />)}
    </div>
  );
}

/* Laid out like the loaded page (hero, stat rail, insights, tab bar, rows),
   the way the player page's skeleton is, so nothing jumps when it lands. The
   tabs are live: picking one before the snapshot arrives opens it. */
function TeamPageSkeleton({ tab, onTabChange }: { tab: TeamTab; onTabChange: (tab: TeamTab) => void }) {
  const { i18n } = useLingui();
  return (
    <div className="flex-1 bg-osu-b5">
      <div className="relative overflow-hidden bg-osu-b4">
        <div className="absolute inset-0 bg-gradient-to-b from-osu-d5 to-osu-b5" />
        <div className="relative mx-auto max-w-[1200px] px-4 pt-8 pb-7 sm:px-5 sm:pt-12 sm:pb-9">
          <div className="flex items-center gap-4 sm:gap-5">
            <Skeleton className="h-[64px] w-[128px] flex-shrink-0 rounded-2xl sm:h-[112px] sm:w-[224px]" />
            <div className="min-w-0 flex-1 space-y-3">
              <Skeleton className="h-7 w-40 sm:h-10 sm:w-64" />
              <Skeleton className="h-3 w-52" />
            </div>
          </div>
          <div className="mt-7 grid grid-cols-2 gap-x-6 gap-y-5 sm:mt-9 sm:flex sm:flex-wrap sm:gap-x-12">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i}>
                <Skeleton className="h-2.5 w-16" />
                <Skeleton className="mt-2 h-7 w-28 sm:h-9 sm:w-32" />
                <Skeleton className="mt-2 h-2.5 w-20" />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1200px] px-4 sm:px-5">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-5 border-b border-osu-b3/25 py-5 sm:gap-x-12">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i}>
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="mt-2 h-5 w-20" />
            </div>
          ))}
          <div className="flex items-center gap-4 sm:ml-auto">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-12" />
            ))}
          </div>
        </div>

        <div className="py-5">
          <InsightsSkeleton />
        </div>

        <div className="border-t border-osu-b3/25 pt-1">
          <div className="-mx-4 overflow-x-auto px-4 scrollbar-hide sm:mx-0 sm:px-0">
            <div className="flex min-w-max">
              {TEAM_TABS.map((teamTab) => (
                <button
                  key={teamTab}
                  type="button"
                  onClick={() => onTabChange(teamTab)}
                  className={`relative shrink-0 cursor-pointer whitespace-nowrap px-4 py-3 text-[12px] font-semibold transition-colors duration-[120ms] ${tab === teamTab ? "text-white" : "text-osu-f1 hover:text-osu-l2"}`}
                >
                  {i18n._(TEAM_TAB_LABELS[teamTab])}
                  {tab === teamTab && <span className="absolute inset-x-2.5 bottom-0 h-[2px] rounded-full bg-osu-h1" />}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-1.5 border-t border-osu-b3/20 py-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <PlayerScoreRowSkeleton key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}
