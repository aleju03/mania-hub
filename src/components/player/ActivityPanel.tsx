import { loadTeamView, peekTeamView } from "../../lib/team-view-cache";
/* The Activity tab: the year heatmap of tracked plays and the day modal, for
   a player and for a team. */

import { useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { I18n, MessageDescriptor } from "@lingui/core";
import {
  fetchLivePlayerActivityDirect,
  fetchLivePlayerActivityDayDirect,
  fetchLiveTeamActivityDayDirect,
  fetchLiveTeamActivityDirect,
  isLiveBackendConfigured,
  type LiveTeamActivityDayDetail,
  type LiveTeamActivitySnapshot,
  type LiveTeamMember,
  type LivePlayerActivityPatterns,
  type LivePlayerActivityPrimarySkill,
  type LivePlayerActivitySnapshot,
  type LivePlayerActivitySkillReadout,
  type LivePlayerActivitySkillVector,
  type LivePlayerActivityTimelineSegment,
} from "../../lib/live-backend";
import {
  formatNumber,
  formatAccuracy,
  formatPP,
} from "../../lib/format";
import { refreshPlayerActivitySnapshot } from "../../lib/player-activity-refresh";
import { useAuth } from "../../lib/auth-context";
import { addSelfToRoster } from "../../lib/roster-self-track";
import { showTrackingStartedToast } from "../me/TrackingToasts";
import { OsuLogo } from "../ui/OsuLogo";
import { Skeleton } from "../ui/LoadingSkeleton";
import { UsernameText } from "../ui/UsernameText";
import type { OsuUser } from "../../lib/types";

type ActivityDay = {
  date: string;
  scoreCount: number;
  passedCount: number;
  sessionCount: number;
  mapCount: number;
  level: 0 | 1 | 2 | 3 | 4;
  maps: ActivityPlayedMap[];
  skills: ActivitySkillReadout | null;
  timeline: ActivityTimelineSegment[];
};

type ActivityPlayedMap = {
  key: string;
  beatmapId: number;
  beatmapsetId: number | null;
  title: string;
  artist: string;
  version: string;
  coverUrl: string | null;
  plays: number;
  accuracy: number | null;
  pp: number | null;
  rank: string | null;
  keyCount: number | null;
  skills: LivePlayerActivitySkillVector | null;
};

type ActivitySkillReadout = LivePlayerActivitySkillReadout;

type ActivityTimelineSegment = LivePlayerActivityTimelineSegment;

type ActivityWeek = {
  key: string;
  days: (ActivityDay | null)[];
};

type ActivitySummary = {
  days: ActivityDay[];
  weeks: ActivityWeek[];
  totalScores: number;
  activeDays: number;
  totalSessions: number;
  currentStreak: number;
  typicalSession: number;
  availableYears: number[];
  timezone: string;
};

const ACTIVITY_EMPTY_CELL_CLASS = "bg-osu-b4/45 border-osu-b3/25";
const PLAYER_ACTIVITY_COUNTRY_SCOPE = "GLOBAL";

export function PlayerActivityPanel({ user }: { user: OsuUser }) {
  const auth = useAuth();
  const { t } = useLingui();
  const currentYear = new Date().getFullYear();
  const [requestedYear, setRequestedYear] = useState(currentYear);
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);
  const [selectedDay, setSelectedDay] = useState<ActivityDay | null>(null);
  // Dev-only simulated day; kept out of selectedDay so the day-sync and
  // detail-fetch effects below never race it against real backend data.
  const [devDay, setDevDay] = useState<ActivityDay | null>(null);
  const [selectedDayDetail, setSelectedDayDetail] = useState<ActivityDay | null>(null);
  const [dayDetailLoading, setDayDetailLoading] = useState(false);
  const [dayDetailError, setDayDetailError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<LivePlayerActivitySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Draw the year the loaded snapshot actually holds: picking a new year starts a
  // fetch, and building the grid from the old snapshot against the new year gives
  // an empty range, so the heatmap would blank out until the new one lands.
  const selectedYear = snapshot?.year ?? requestedYear;
  const yearPending = loading && selectedYear !== requestedYear;
  const activity = useMemo(() => buildActivityFromSnapshot(snapshot, selectedYear), [selectedYear, snapshot]);
  const yearOptions = useMemo(() => {
    const years = new Set([currentYear, requestedYear, selectedYear, ...activity.availableYears]);
    return [...years].sort((a, b) => b - a);
  }, [activity.availableYears, currentYear, requestedYear, selectedYear]);
  const selectedDayDate = selectedDay?.date;
  const modalDay = devDay ?? (selectedDayDetail?.date === selectedDayDate ? selectedDayDetail : selectedDay);
  const modalPlayedLabel = modalDay ? formatActivityDuration(getActivityDayPlayedMs(modalDay)) : null;
  const closeDayModal = useCallback(() => {
    setSelectedDay(null);
    setDevDay(null);
  }, []);

  useEffect(() => {
    if (!isLiveBackendConfigured()) {
      setLoading(false);
      setSnapshot(null);
      setError(t`Activity is only available when the server is configured.`);
      return;
    }

    setLoading(true);
    setError(null);
    return refreshPlayerActivitySnapshot({
      load: () => fetchLivePlayerActivityDirect(user.id, PLAYER_ACTIVITY_COUNTRY_SCOPE, requestedYear),
      onSnapshot: setSnapshot,
      onInitialError: () => {
        setSnapshot(null);
        setError(t`Couldn't load Activity right now.`);
      },
      onInitialSettled: () => setLoading(false),
    });
  }, [activityRefreshKey, requestedYear, user.id]);

  useEffect(() => {
    if (!selectedDayDate) return;
    setSelectedDay(activity.days.find((day) => day.date === selectedDayDate) ?? null);
  }, [activity, selectedDayDate]);

  useEffect(() => {
    if (!selectedDayDate) {
      setSelectedDayDetail(null);
      setDayDetailLoading(false);
      setDayDetailError(null);
      return;
    }

    let cancelled = false;
    setSelectedDayDetail(null);
    setDayDetailLoading(true);
    setDayDetailError(null);

    fetchLivePlayerActivityDayDirect(user.id, PLAYER_ACTIVITY_COUNTRY_SCOPE, selectedDayDate)
      .then((day) => {
        if (cancelled) return;
        setSelectedDayDetail(normalizeActivityDay(day, activity.typicalSession));
      })
      .catch(() => {
        if (cancelled) return;
        setDayDetailError(t`Couldn't load the full day detail.`);
      })
      .finally(() => {
        if (cancelled) return;
        setDayDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activity.typicalSession, selectedDayDate, user.id]);

  if (loading && !snapshot) {
    return (
      <div className="space-y-4 py-2">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-7 w-44" />
            <Skeleton className="h-3 w-36" />
          </div>
          <Skeleton className="h-10 w-28" />
        </div>
        <div className="grid grid-cols-[32px_minmax(0,1fr)] gap-2">
          <Skeleton className="h-32 w-8" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (error && !snapshot) {
    return (
      <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-5 text-center text-sm text-osu-f1">
        {error}
      </div>
    );
  }

  if (snapshot && !snapshot.available) {
    // Tracking an account osu! turned away would only queue osu! calls that 404.
    const optInMode: "self" | "other" | "anon" = user.account_status
      ? "other"
      : auth.viewer == null ? "anon" : auth.viewer.id === user.id ? "self" : "other";
    return (
      <ActivityOptInEmptyState
        mode={optInMode}
        loginAvailable={auth.loginAvailable}
        onTracked={() => setActivityRefreshKey((key) => key + 1)}
      />
    );
  }

  return (
    <>
      <ActivityYearView
        activity={activity}
        selectedYear={selectedYear}
        requestedYear={requestedYear}
        yearPending={yearPending}
        yearOptions={yearOptions}
        onSelectYear={(year) => {
          setRequestedYear(year);
          setSelectedDay(null);
        }}
        onSelectDay={setSelectedDay}
        onSimulateDay={() => setDevDay(createDevActivityDay(activity.timezone))}
      />

      <AnimatePresence>
        {modalDay && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 backdrop-blur-sm sm:p-4"
            onClick={closeDayModal}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
          >
            <motion.div
              className="flex max-h-[calc(100dvh-1rem)] w-full max-w-[34rem] flex-col overflow-hidden rounded-xl border border-osu-b3/25 bg-osu-b4 p-4 shadow-[0_18px_70px_rgba(0,0,0,0.55)] sm:max-h-[calc(100vh-2rem)] sm:max-w-xl sm:p-5"
              onClick={(event) => event.stopPropagation()}
              initial={{ opacity: 0, y: 10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              transition={{ duration: 0.16 }}
            >
              <div className="flex shrink-0 items-start justify-between gap-4">
                <div>
                  <div className="text-[9px] font-black uppercase tracking-wide text-osu-pink-light sm:text-[10px]">{t`Activity day`}</div>
                  <h3 className="mt-1 text-xl font-black text-white sm:text-2xl">{formatFullActivityDate(modalDay.date)}</h3>
                </div>
                <button
                  type="button"
                  onClick={closeDayModal}
                  aria-label={t`Close activity details`}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-osu-f1 hover:bg-osu-b3/50 hover:text-white"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M1 1l12 12M13 1L1 13" />
                  </svg>
                </button>
              </div>

              <div className="min-h-0 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                <div className={`mt-4 grid gap-2 sm:mt-5 ${modalPlayedLabel ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"}`}>
                  <ActivityDetailMetric label={t`Plays`} value={formatNumber(modalDay.scoreCount)} />
                  <ActivityDetailMetric label={t`Sessions`} value={formatNumber(modalDay.sessionCount)} />
                  {modalPlayedLabel ? <ActivityDetailMetric label={t`Time played`} value={modalPlayedLabel} /> : null}
                  <ActivityDetailMetric label={t`Maps`} value={formatNumber(modalDay.mapCount)} />
                </div>

                <ActivitySessionFlow day={modalDay} timezone={activity.timezone} />

                <ActivityDayMaps
                  key={modalDay.date}
                  maps={modalDay.maps}
                  mapCount={modalDay.mapCount}
                  loading={dayDetailLoading}
                  error={dayDetailError}
                />

                <div className="mt-4 rounded-lg border border-osu-b3/20 bg-osu-b5/35 p-3 sm:mt-5 sm:p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-bold uppercase text-osu-f1 sm:text-xs">{t`Pattern mix`}</div>
                    <div className="text-[10px] text-osu-f1 sm:text-[11px]">{t`avg intensity, 0-100`}</div>
                  </div>
                  {modalDay.skills && modalDay.skills.analyzedPlays > 0 ? (
                    <ActivityPatternMix key={modalDay.date} skills={modalDay.skills} />
                  ) : dayDetailLoading ? (
                    <div className="mt-3 space-y-2">
                      <Skeleton className="h-3 rounded-full" />
                      <Skeleton className="h-3 rounded-full" />
                      <Skeleton className="h-3 rounded-full" />
                      <Skeleton className="h-3 rounded-full" />
                    </div>
                  ) : (
                    <div className="mt-3 text-[11px] text-osu-f1">
                      {t`Skill analysis is queued for the maps played on this day.`}
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/* A team's calendar: every tracked member's plays on one heatmap, each day in
   the member's own local time. A day opens the members who played it. */
export function TeamActivityPanel({ teamId, members, onReady }: {
  teamId: number;
  members: LiveTeamMember[];
  /* Told once the calendar (or its error) has drawn, for a page holding its height. */
  onReady?: () => void;
}) {
  const { t } = useLingui();
  const currentYear = new Date().getFullYear();
  const [requestedYear, setRequestedYear] = useState(currentYear);
  const [snapshot, setSnapshot] = useState<LiveTeamActivitySnapshot | null>(() => peekTeamView<LiveTeamActivitySnapshot>(`activity:${teamId}:${currentYear}`) ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [dayDetail, setDayDetail] = useState<LiveTeamActivityDayDetail | null>(null);
  const [dayLoading, setDayLoading] = useState(false);
  const [dayError, setDayError] = useState<string | null>(null);
  const selectedYear = snapshot?.year ?? requestedYear;
  const yearPending = loading && selectedYear !== requestedYear;
  const playerSnapshot = useMemo(() => (snapshot ? teamToActivitySnapshot(snapshot) : null), [snapshot]);
  const activity = useMemo(() => buildActivityFromSnapshot(playerSnapshot, selectedYear), [playerSnapshot, selectedYear]);
  const yearOptions = useMemo(() => {
    const years = new Set([currentYear, requestedYear, selectedYear, ...activity.availableYears]);
    return [...years].sort((a, b) => b - a);
  }, [activity.availableYears, currentYear, requestedYear, selectedYear]);
  const membersById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const selectedDay = selectedDate ? activity.days.find((day) => day.date === selectedDate) ?? null : null;
  const selectedTeamDay = selectedDate ? snapshot?.days.find((day) => day.date === selectedDate) ?? null : null;
  const ready = snapshot != null || error != null;
  useLayoutEffect(() => {
    if (ready) onReady?.();
  }, [onReady, ready]);

  useEffect(() => {
    if (!isLiveBackendConfigured()) {
      setLoading(false);
      setError(t`Activity is only available when the server is configured.`);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadTeamView(`activity:${teamId}:${requestedYear}`, () => fetchLiveTeamActivityDirect(teamId, requestedYear))
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch(() => {
        if (!cancelled) setError(t`Couldn't load Activity right now.`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [requestedYear, teamId]);

  useEffect(() => {
    if (!selectedDate) {
      setDayDetail(null);
      setDayError(null);
      setDayLoading(false);
      return;
    }
    let cancelled = false;
    setDayDetail(null);
    setDayLoading(true);
    setDayError(null);
    loadTeamView(`activity-day:${teamId}:${selectedDate}`, () => fetchLiveTeamActivityDayDirect(teamId, selectedDate))
      .then((detail) => {
        if (!cancelled) setDayDetail(detail);
      })
      .catch(() => {
        if (!cancelled) setDayError(t`Couldn't load the full day detail.`);
      })
      .finally(() => {
        if (!cancelled) setDayLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDate, teamId]);

  if (loading && !snapshot) {
    return (
      <div className="space-y-4 py-2">
        <Skeleton className="h-7 w-44" />
        <div className="grid grid-cols-[32px_minmax(0,1fr)] gap-2">
          <Skeleton className="h-32 w-8" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (error && !snapshot) {
    return <div className="rounded-xl bg-osu-b4 p-5 text-center text-sm text-osu-f1">{error}</div>;
  }

  if (snapshot && snapshot.activeMembers === 0) {
    return (
      <div className="rounded-xl bg-osu-b4 p-5 text-center text-sm text-osu-f1">
        {t`Activity is recorded for tracked players, and no one in this team is tracked yet.`}
      </div>
    );
  }

  const detailMembers = dayDetail?.date === selectedDate ? dayDetail.members : null;
  const dayMembers = detailMembers
    ? detailMembers.map((entry) => ({ userId: entry.userId, scoreCount: entry.day.scoreCount, day: entry.day }))
    : (selectedTeamDay?.members ?? []).map((entry) => ({ ...entry, day: null }));

  return (
    <>
      <ActivityYearView
        activity={activity}
        selectedYear={selectedYear}
        requestedYear={requestedYear}
        yearPending={yearPending}
        yearOptions={yearOptions}
        onSelectYear={(year) => {
          setRequestedYear(year);
          setSelectedDate(null);
        }}
        onSelectDay={(day) => setSelectedDate(day.date)}
        subtitle={snapshot ? (
          <Plural
            value={snapshot.activeMembers}
            one={`from # tracked member of ${snapshot.memberCount}`}
            other={`from # tracked members of ${snapshot.memberCount}`}
          />
        ) : null}
      />

      <AnimatePresence>
        {selectedDay && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 backdrop-blur-sm sm:p-4"
            onClick={() => setSelectedDate(null)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
          >
            <motion.div
              className="flex max-h-[calc(100dvh-1rem)] w-full max-w-[34rem] flex-col overflow-hidden rounded-xl border border-osu-b3/25 bg-osu-b4 p-4 shadow-[0_18px_70px_rgba(0,0,0,0.55)] sm:max-h-[calc(100vh-2rem)] sm:max-w-xl sm:p-5"
              onClick={(event) => event.stopPropagation()}
              initial={{ opacity: 0, y: 10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              transition={{ duration: 0.16 }}
            >
              <div className="flex shrink-0 items-start justify-between gap-4">
                <div>
                  <div className="text-[9px] font-black uppercase tracking-wide text-osu-pink-light sm:text-[10px]">{t`Activity day`}</div>
                  <h3 className="mt-1 text-xl font-black text-white sm:text-2xl">{formatFullActivityDate(selectedDay.date)}</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedDate(null)}
                  aria-label={t`Close activity details`}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-osu-f1 hover:bg-osu-b3/50 hover:text-white"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M1 1l12 12M13 1L1 13" />
                  </svg>
                </button>
              </div>

              <div className="min-h-0 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                <div className="mt-4 grid grid-cols-2 gap-2 sm:mt-5 sm:grid-cols-4">
                  <ActivityDetailMetric label={t`Plays`} value={formatNumber(selectedDay.scoreCount)} />
                  <ActivityDetailMetric label={t`Players`} value={formatNumber(selectedTeamDay?.members.length ?? dayMembers.length)} />
                  <ActivityDetailMetric label={t`Sessions`} value={formatNumber(selectedDay.sessionCount)} />
                  <ActivityDetailMetric label={t`Maps`} value={formatNumber(selectedDay.mapCount)} />
                </div>

                <div className="mt-4 space-y-1.5 sm:mt-5">
                  {dayMembers.map((entry) => (
                    <TeamActivityDayMember
                      key={entry.userId}
                      member={membersById.get(entry.userId) ?? null}
                      userId={entry.userId}
                      scoreCount={entry.scoreCount}
                      day={entry.day ? normalizeActivityDay(entry.day, activity.typicalSession) : null}
                      loading={dayLoading}
                    />
                  ))}
                  {dayError ? <div className="rounded-md bg-osu-b5/45 px-3 py-2 text-[11px] text-osu-f1">{dayError}</div> : null}
                </div>

                <div className="mt-4 rounded-lg border border-osu-b3/20 bg-osu-b5/35 p-3 sm:mt-5 sm:p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-bold uppercase text-osu-f1 sm:text-xs">{t`Pattern mix`}</div>
                    <div className="text-[10px] text-osu-f1 sm:text-[11px]">{t`avg intensity, 0-100`}</div>
                  </div>
                  {selectedDay.skills && selectedDay.skills.analyzedPlays > 0 ? (
                    <ActivityPatternMix key={selectedDay.date} skills={selectedDay.skills} />
                  ) : (
                    <div className="mt-3 text-[11px] text-osu-f1">
                      {t`Skill analysis is queued for the maps played on this day.`}
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function TeamActivityDayMember({ member, userId, scoreCount, day, loading }: {
  member: LiveTeamMember | null;
  userId: number;
  scoreCount: number;
  day: ActivityDay | null;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const username = member?.username ?? String(userId);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-3 rounded-lg bg-osu-b5/45 px-3 py-2 text-left transition-colors hover:bg-osu-b3/30"
      >
        {member?.avatar_url ? (
          <img src={member.avatar_url} alt="" className="h-8 w-8 shrink-0 rounded-md object-cover" />
        ) : (
          <span className="h-8 w-8 shrink-0 rounded-md bg-osu-b3/50" />
        )}
        <UsernameText username={username} avatarUrl={member?.avatar_url} className="min-w-0 flex-1 truncate text-sm font-bold text-white" />
        <span className="shrink-0 text-sm font-bold tabular-nums text-osu-l2">
          <Plural value={scoreCount} one="# play" other="# plays" />
        </span>
      </button>
      {open ? (
        <div className="-mt-2 mb-3">
          <ActivityDayMaps
            maps={day?.maps ?? []}
            mapCount={day?.mapCount ?? 0}
            loading={loading && !day}
            error={null}
          />
        </div>
      ) : null}
    </div>
  );
}

/* The team payload in the player snapshot's shape, so the same grid builder
   and cell colours apply. Maps and timelines only exist on a day's detail. */
function teamToActivitySnapshot(snapshot: LiveTeamActivitySnapshot): LivePlayerActivitySnapshot {
  return {
    available: true,
    isTracked: true,
    userId: 0,
    country: null,
    timezone: "UTC",
    year: snapshot.year,
    availableYears: snapshot.availableYears,
    totalScores: snapshot.totalScores,
    activeDays: snapshot.activeDays,
    totalSessions: snapshot.totalSessions,
    typicalSession: snapshot.typicalSession,
    currentStreak: snapshot.currentStreak,
    generatedAt: snapshot.generatedAt,
    days: snapshot.days.map((day) => ({
      date: day.date,
      scoreCount: day.scoreCount,
      passedCount: day.passedCount,
      sessionCount: day.sessionCount,
      mapCount: day.mapCount,
      maps: [],
      skills: day.skills,
      timeline: [],
    })),
  };
}

/* One year of activity: the headline, the heatmap and the year picker. The
   player and team panels share it and each opens its own day modal. */
function ActivityYearView({
  activity,
  selectedYear,
  requestedYear,
  yearPending,
  yearOptions,
  onSelectYear,
  onSelectDay,
  onSimulateDay,
  subtitle,
}: {
  activity: ActivitySummary;
  selectedYear: number;
  requestedYear: number;
  yearPending: boolean;
  yearOptions: number[];
  onSelectYear: (year: number) => void;
  onSelectDay: (day: ActivityDay) => void;
  onSimulateDay?: () => void;
  subtitle?: ReactNode;
}) {
  const { t, i18n } = useLingui();
  const averageActiveDay = activity.activeDays > 0 ? Math.round(activity.totalScores / activity.activeDays) : 0;
  const activityGridStyle = useMemo(
    () => ({ "--activity-weeks": String(activity.weeks.length) }) as CSSProperties,
    [activity.weeks.length],
  );
  return (
    <>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_130px]">
        <section className="min-w-0 px-1 py-2 sm:px-0">
          {/* Year switches crossfade instead of snapping: the old year dims while
              its replacement loads, and the new grid fades up once it is here. */}
          <motion.div
            key={selectedYear}
            initial={{ opacity: 0.35 }}
            animate={{ opacity: yearPending ? 0.55 : 1 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white">
                  <Trans>{formatNumber(activity.totalScores)} plays in {selectedYear}</Trans>
                </h2>
                {subtitle ? <div className="mt-1 text-[11px] text-osu-f1">{subtitle}</div> : null}
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                <ActivityInlineMetric label={t`Avg active day`} value={formatNumber(averageActiveDay)} detail={t`plays`} />
                <ActivityInlineMetric label={t`Streak`} value={t`${activity.currentStreak}d`} detail={t`now`} />
              </div>
            </div>

            <div className="mt-6 sm:mt-7">
              <div className="flex gap-2">
                {/* Row pitch must match the cells: fixed 12px rows on mobile (cells are
                    12px), 1fr rows on sm+ where pt-5 equals the month-label row (h-3 +
                    mt-2) so the stretched height equals the heatmap grid exactly. */}
                <div className="grid w-8 shrink-0 grid-rows-[repeat(7,12px)] gap-1 pt-5 text-[10px] leading-none text-osu-f1 sm:grid-rows-7">
                  {ACTIVITY_WEEKDAY_LABELS.map((day, index) => (
                    <span key={index} className="flex items-center">{i18n._(day)}</span>
                  ))}
                </div>
                <div className="min-w-0 max-w-full flex-1 overflow-x-auto pb-2 scrollbar-hide sm:overflow-visible sm:pb-0">
                  <div className="w-max sm:w-full">
                    <ActivityMonthLabels weeks={activity.weeks} gridStyle={activityGridStyle} />
                    <div
                      className="activity-heatmap-grid mt-2 grid gap-1"
                      style={activityGridStyle}
                    >
                      {activity.weeks.map((week) => (
                        <div key={week.key} className="grid min-w-0 grid-rows-7 gap-1">
                          {week.days.map((day, index) => (
                            day ? (
                              day.scoreCount > 0 ? (
                                <button
                                  key={day.date}
                                  type="button"
                                  title={t`${formatFullActivityDate(day.date)}: ${day.scoreCount} plays, ${day.sessionCount} sessions`}
                                  onClick={() => onSelectDay(day)}
                                  className="aspect-square w-full min-w-0 rounded-[3px] border transition-transform hover:scale-125 hover:ring-2 hover:ring-osu-pink/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-osu-pink/90"
                                  style={getActivityCellStyle(day, activity.typicalSession)}
                                />
                              ) : (
                                <span
                                  key={day.date}
                                  title={t`${formatFullActivityDate(day.date)}: no tracked plays`}
                                  className={`aspect-square w-full min-w-0 rounded-[3px] border ${ACTIVITY_EMPTY_CELL_CLASS}`}
                                />
                              )
                            ) : (
                              <span key={`empty-${index}`} className="aspect-square w-full min-w-0" />
                            )
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <span className="text-[11px] text-osu-f1">
                <Trans>Typical session <span className="font-semibold text-osu-l2">{activity.typicalSession} plays</span></Trans>
              </span>
              {import.meta.env.DEV && onSimulateDay && (
                <button
                  type="button"
                  onClick={onSimulateDay}
                  className="rounded-lg border border-osu-pink/25 bg-osu-pink/10 px-2 py-1 text-[10px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/20"
                  title={t`Open the day modal with simulated busy-day data`}
                >
                  {t`Sim busy day`}
                </button>
              )}
            </div>
          </motion.div>
        </section>

        <div className="flex gap-2 overflow-x-auto scrollbar-hide lg:block lg:space-y-2 lg:overflow-visible">
          {yearOptions.map((year) => (
            <button
              key={year}
              type="button"
              onClick={() => onSelectYear(year)}
              className={`min-w-24 rounded-lg px-4 py-2 text-left text-sm font-semibold transition-colors duration-200 ease-out lg:w-full ${requestedYear === year
                  ? "bg-osu-pink text-white"
                  : "bg-osu-b4/60 text-osu-f1 hover:bg-osu-b3/55 hover:text-osu-l2"
                }`}
            >
              {year}
            </button>
          ))}
        </div>
      </div>

    </>
  );
}

function ActivityDetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-osu-b3/20 bg-osu-b5/45 px-3 py-2">
      <div className="text-[10px] font-bold uppercase text-osu-f1">{label}</div>
      <div className="mt-1 text-lg font-black text-white sm:text-xl">{value}</div>
    </div>
  );
}

function ActivityPatternMix({ skills }: { skills: ActivitySkillReadout }) {
  const keyModes = skills.keyModes.length > 0
    ? skills.keyModes
    : [{
      keyCount: null,
      patterns: skills.patterns,
      analyzedPlays: skills.analyzedPlays,
      totalPlays: skills.totalPlays,
    }];
  const { t, i18n } = useLingui();
  const [selectedKeyModeIndex, setSelectedKeyModeIndex] = useState(0);
  const activeIndex = Math.min(selectedKeyModeIndex, keyModes.length - 1);
  const activeKeyMode = keyModes[activeIndex];
  const entries = getActivityPatternEntries(activeKeyMode.patterns, activeKeyMode.keyCount, i18n).slice(0, 6);
  return (
    <div className="mt-3">
      {keyModes.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {keyModes.map((keyMode, index) => {
            const selected = index === activeIndex;
            return (
              <button
                key={`${keyMode.keyCount ?? "unknown"}:${index}`}
                type="button"
                onClick={() => setSelectedKeyModeIndex(index)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors ${selected
                    ? "bg-osu-pink text-white"
                    : "bg-osu-b4/60 text-osu-f1 hover:bg-osu-b3/55 hover:text-osu-l2"
                  }`}
              >
                {formatActivityKeyCount(keyMode.keyCount) ?? t`Other`}
                <span className={`ml-1 font-semibold ${selected ? "text-white/75" : "text-osu-f1/80"}`}>
                  <Plural value={keyMode.analyzedPlays} one={`${formatNumber(keyMode.analyzedPlays)} play`} other={`${formatNumber(keyMode.analyzedPlays)} plays`} />
                </span>
              </button>
            );
          })}
        </div>
      )}
      {entries.length > 0 ? (
        <div className="space-y-2.5">
          {entries.map(({ key, label, value }) => (
            <div key={key}>
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-osu-l2">
                  <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: getActivitySkillColor(key) }} />
                  {label}
                </span>
                <span className="text-xs font-black text-white">{value}</span>
              </div>
              <div className="h-2 rounded-full bg-osu-b3/35">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${value}%`, backgroundColor: getActivitySkillColor(key) }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-osu-f1">{t`No pattern signal for this keymode yet.`}</div>
      )}
      {activeKeyMode.analyzedPlays < activeKeyMode.totalPlays && (
        <div className="mt-2 text-[10px] text-osu-f1">
          <Trans>{formatNumber(activeKeyMode.analyzedPlays)} of {formatNumber(activeKeyMode.totalPlays)} plays analyzed</Trans>
        </div>
      )}
    </div>
  );
}

function ActivitySessionFlow({ day, timezone }: { day: ActivityDay; timezone: string }) {
  const { t, i18n } = useLingui();
  if (day.timeline.length === 0) return null;
  const sessions = groupActivityTimelineBySession(day.timeline).map(mergeActivitySessionSegments);
  const flowLabel = formatActivityKeyFlow(day.timeline, t`mixed keys`);
  const timezoneHint = getActivityTimezoneHint(timezone, day.timeline[0]?.startAt);
  const multiKeymode = new Set(day.timeline.map((segment) => segment.keyCount ?? 0)).size > 1;
  return (
    <div className="mt-4 rounded-lg border border-osu-b3/20 bg-osu-b5/35 p-3 sm:mt-5 sm:p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-bold uppercase text-osu-f1 sm:text-xs">
          {t`Sessions`}
          {timezoneHint ? <span className="ml-1.5 font-semibold normal-case text-osu-f1/70">{timezoneHint}</span> : null}
        </div>
        <div className="text-[10px] font-semibold text-osu-l2 sm:text-[11px]">{flowLabel}</div>
      </div>
      <ActivityDayClock sessions={sessions} timezone={timezone} dayKey={day.date} />
      <div className="mt-4 space-y-3.5">
        {sessions.map((session, sessionIndex) => {
          const sessionPlays = session.reduce((sum, segment) => sum + segment.playCount, 0);
          const first = session[0];
          const last = session[session.length - 1];
          const startDateLabel = formatActivitySessionDate(first.startAt, day.date, timezone);
          const elapsed = Date.parse(last.endAt) - Date.parse(first.startAt);
          const durationLabel = formatActivityDuration(Number.isFinite(elapsed) ? elapsed : 0);
          const breakdown = aggregateActivitySessionBreakdown(session);
          return (
            <div key={first.key}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="text-[11px] font-semibold text-osu-l2">
                  {sessions.length > 1 ? <span className="text-osu-f1"><Trans>Session {sessionIndex + 1}</Trans> · </span> : null}
                  {startDateLabel ? `${startDateLabel} · ` : null}
                  {formatActivityTime(first.startAt, timezone)} - {formatActivityTime(last.endAt, timezone)}
                  {durationLabel ? <span className="font-normal text-osu-f1"> · {durationLabel}</span> : null}
                </span>
                <span className="text-[10px] text-osu-f1">
                  <Plural value={sessionPlays} one={`${formatNumber(sessionPlays)} play`} other={`${formatNumber(sessionPlays)} plays`} />
                </span>
              </div>
              <div className="flex h-2.5 overflow-hidden rounded-full bg-osu-b4/70">
                {session.map((segment) => (
                  <div
                    key={segment.key}
                    title={formatActivitySegmentTitle(segment, timezone, i18n)}
                    className="min-w-0 border-r border-black/25 last:border-r-0"
                    style={{
                      flexBasis: 0,
                      flexGrow: Math.max(1, segment.playCount),
                      backgroundColor: getActivityTimelineSegmentColor(segment),
                    }}
                  />
                ))}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {breakdown.map((entry) => {
                  const known = entry.skill !== "unknown";
                  const label = known ? getActivitySkillLabel(entry.skill, entry.keyCount, i18n) : t`Unanalyzed`;
                  const keyLabel = multiKeymode ? formatActivityKeyCount(entry.keyCount) : null;
                  return (
                    <span
                      key={`${entry.skill}:${entry.keyCount ?? "x"}`}
                      title={entry.playCount === 1 ? t`${formatNumber(entry.playCount)} play` : t`${formatNumber(entry.playCount)} plays`}
                      className="flex items-center gap-1 rounded bg-osu-b4/60 px-1.5 py-1 text-[10px] leading-none"
                    >
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-[2px]"
                        style={{ backgroundColor: getActivitySkillColor(entry.skill) }}
                      />
                      <span className={`font-semibold ${known ? "text-osu-l2" : "text-osu-f1"}`}>
                        {label}
                        {keyLabel ? ` ${keyLabel}` : null}
                      </span>
                      {entry.playCount > 1 ? <span className="text-osu-f1">×{formatNumber(entry.playCount)}</span> : null}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Marks where each session sits in the player's local day so "played in the
// evening" is visible without reading the time labels. Sessions bleeding past
// the day boundary (stale pre-timezone data) clamp to the day's edges.
function ActivityDayClock({ sessions, timezone, dayKey }: {
  sessions: ActivityTimelineSegment[][];
  timezone: string;
  dayKey: string;
}) {
  const { t } = useLingui();
  const blocks = sessions
    .map((session) => {
      const first = session[0];
      const last = session[session.length - 1];
      const startKey = getZonedDateKey(new Date(first.startAt), timezone);
      const endKey = getZonedDateKey(new Date(last.endAt), timezone);
      const startMin = startKey === dayKey
        ? getZonedMinutesOfDay(first.startAt, timezone)
        : startKey < dayKey ? 0 : null;
      const endMin = endKey === dayKey
        ? getZonedMinutesOfDay(last.endAt, timezone)
        : endKey > dayKey ? ACTIVITY_MINUTES_PER_DAY : null;
      if (startMin == null || endMin == null) return null;
      let end = Math.max(startMin, endMin);
      let start = startMin;
      if (end - start < ACTIVITY_DAY_CLOCK_MIN_MINUTES) {
        end = Math.min(ACTIVITY_MINUTES_PER_DAY, start + ACTIVITY_DAY_CLOCK_MIN_MINUTES);
        start = end - ACTIVITY_DAY_CLOCK_MIN_MINUTES;
      }
      const plays = session.reduce((sum, segment) => sum + segment.playCount, 0);
      return {
        key: first.key,
        left: (start / ACTIVITY_MINUTES_PER_DAY) * 100,
        width: ((end - start) / ACTIVITY_MINUTES_PER_DAY) * 100,
        title: plays === 1
          ? t`${formatActivityTime(first.startAt, timezone)} - ${formatActivityTime(last.endAt, timezone)} · ${formatNumber(plays)} play`
          : t`${formatActivityTime(first.startAt, timezone)} - ${formatActivityTime(last.endAt, timezone)} · ${formatNumber(plays)} plays`,
      };
    })
    .filter((block): block is NonNullable<typeof block> => block != null);
  if (blocks.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="relative h-2 rounded-full bg-osu-b4/70">
        {[25, 50, 75].map((percent) => (
          <span key={percent} className="absolute inset-y-0 w-px bg-osu-b3/40" style={{ left: `${percent}%` }} />
        ))}
        {blocks.map((block) => (
          <span
            key={block.key}
            title={block.title}
            className="absolute inset-y-0 rounded-full bg-osu-pink"
            style={{ left: `${block.left}%`, width: `${block.width}%` }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[9px] leading-none text-osu-f1">
        <span>{t`12 AM`}</span>
        <span>{t`6 AM`}</span>
        <span>{t`12 PM`}</span>
        <span>{t`6 PM`}</span>
        <span>{t`12 AM`}</span>
      </div>
    </div>
  );
}

// Below this the list renders in full; above it the tail collapses behind an
// inline "show more" so the modal has a single scrollbar instead of a nested one.
const ACTIVITY_DAY_MAPS_PREVIEW = 6;

function ActivityDayMaps({ maps, mapCount, loading, error }: {
  maps: ActivityPlayedMap[];
  mapCount: number;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const visibleMaps = expanded ? maps : maps.slice(0, ACTIVITY_DAY_MAPS_PREVIEW);
  const hiddenCount = maps.length - visibleMaps.length;
  return (
    <div className="mt-4 rounded-lg border border-osu-b3/20 bg-osu-b5/35 p-3 sm:mt-5 sm:p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-bold uppercase text-osu-f1 sm:text-xs">{t`Maps played`}</div>
        <div className="text-[10px] text-osu-f1 sm:text-[11px]">
          {loading
            ? t`loading`
            : mapCount > maps.length
              ? t`${maps.length} of ${mapCount}`
              : maps.length === 1
                ? t`${maps.length} map`
                : t`${maps.length} maps`}
        </div>
      </div>
      <div className="mt-2 space-y-1.5 sm:mt-3 sm:space-y-2">
        {loading && maps.length === 0 ? (
          <>
            <Skeleton className="h-16 rounded-md" />
            <Skeleton className="h-16 rounded-md" />
            <Skeleton className="h-16 rounded-md" />
          </>
        ) : (
          visibleMaps.map((map) => (
            <ActivityMapRow key={map.key} map={map} />
          ))
        )}
        {error ? (
          <div className="rounded-md bg-osu-b4/70 px-3 py-2 text-[11px] text-osu-f1">
            {error}
          </div>
        ) : null}
      </div>
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 w-full rounded-md bg-osu-b4/60 px-3 py-1.5 text-[11px] font-semibold text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-osu-l2"
        >
          <Plural value={hiddenCount} one="Show # more map" other="Show # more maps" />
        </button>
      ) : expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-2 w-full rounded-md bg-osu-b4/60 px-3 py-1.5 text-[11px] font-semibold text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-osu-l2"
        >
          {t`Show fewer`}
        </button>
      ) : null}
    </div>
  );
}

function ActivityMapRow({ map }: { map: ActivityPlayedMap }) {
  return (
    <a
      href={`https://osu.ppy.sh/beatmaps/${map.beatmapId}`}
      target="_blank"
      rel="noreferrer"
      className="grid grid-cols-[42px_minmax(0,1fr)_2.25rem] items-center gap-2 rounded-md bg-osu-b4/70 px-2 py-1.5 transition-colors hover:bg-osu-b3/45 sm:grid-cols-[48px_minmax(0,1fr)_auto] sm:gap-3 sm:rounded-lg sm:p-2"
    >
      {map.coverUrl ? (
        <img
          src={map.coverUrl}
          alt=""
          className="h-8 w-[42px] rounded object-cover sm:h-9 sm:w-12"
          loading="lazy"
        />
      ) : (
        <div className="flex h-8 w-[42px] items-center justify-center rounded bg-osu-b3/60 text-xs font-black text-osu-l2 sm:h-9 sm:w-12">
          {map.title.slice(0, 1).toUpperCase()}
        </div>
      )}
      <div className="min-w-0">
        <div className="truncate text-[13px] font-bold text-white sm:text-sm">{map.title}</div>
        <div className="truncate text-[10px] text-osu-f1 sm:text-[11px]">
          {map.artist} [{map.version}]
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-osu-f1">
          {map.keyCount ? <span>{map.keyCount}K</span> : null}
          {map.accuracy != null ? <span>{formatAccuracy(map.accuracy)}</span> : null}
          {map.pp != null ? <span>{formatPP(map.pp)}</span> : null}
        </div>
        <ActivityMapPatternTag skills={map.skills} keyCount={map.keyCount} />
      </div>
      <div className="text-right">
        <div className="text-[13px] font-black text-osu-l2 sm:text-sm">{formatNumber(map.plays)}</div>
        <div className="text-[10px] text-osu-f1"><Plural value={map.plays} one="play" other="plays" /></div>
      </div>
    </a>
  );
}

// One clear primary-pattern tag instead of a row of abbreviated score pills;
// the full breakdown stays reachable via the tooltip.
function ActivityMapPatternTag({ skills, keyCount }: { skills: LivePlayerActivitySkillVector | null; keyCount: number | null }) {
  const { i18n } = useLingui();
  if (!skills) return null;
  const primary = getActivityPrimarySkill(skills);
  if (primary === "unknown") return null;
  const entries = getActivityPatternEntries(skills.patterns, keyCount, i18n);
  const secondary = entries.filter(({ key }) => key !== primary).slice(0, 2);
  const tooltip = entries.slice(0, 5).map(({ label, value }) => `${label} ${value}`).join(" · ");
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5" title={tooltip}>
      <span
        className="rounded px-1.5 py-0.5 text-[9px] font-black leading-none text-white"
        style={{ backgroundColor: primary === "mixed" ? "rgba(255,255,255,0.14)" : getActivitySkillColor(primary) }}
      >
        {getActivitySkillLabel(primary, keyCount, i18n)}
      </span>
      {secondary.length > 0 ? (
        <span className="text-[9px] leading-none text-osu-f1">
          + {secondary.map(({ label }) => label).join(", ")}
        </span>
      ) : null}
    </div>
  );
}

function ActivityInlineMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-20 border-l border-osu-b3/30 pl-4 first:border-l-0 first:pl-0">
      <div className="text-[10px] font-bold uppercase text-osu-f1">{label}</div>
      <div className="text-lg font-black leading-tight text-white">{value}</div>
      <div className="text-[10px] text-osu-f1">{detail}</div>
    </div>
  );
}

function ActivityMonthLabels({ weeks, gridStyle }: { weeks: ActivityWeek[]; gridStyle: CSSProperties }) {
  let lastMonth = "";
  return (
    <div
      className="activity-heatmap-grid grid h-3 gap-1 text-[10px] leading-none text-osu-f1"
      style={gridStyle}
    >
      {weeks.map((week) => {
        const firstDay = week.days.find((day): day is ActivityDay => day != null);
        const month = firstDay ? formatActivityMonth(firstDay.date) : "";
        const label = month && month !== lastMonth ? month : "";
        if (month) lastMonth = month;
        return (
          <span key={week.key} className="min-w-0 whitespace-nowrap">
            {label}
          </span>
        );
      })}
    </div>
  );
}

function buildActivityFromSnapshot(snapshot: LivePlayerActivitySnapshot | null, year: number): ActivitySummary {
  const today = startOfLocalDay(new Date());
  const { start, end } = getActivityHeatmapRange(snapshot, year);
  const activeDays = new Map((snapshot?.days ?? []).map((day) => [day.date, day]));
  const typicalSession = Math.max(1, snapshot?.typicalSession ?? 1);
  const days: ActivityDay[] = [];

  for (let date = startOfLocalDay(start); date <= end; date = addLocalDays(date, 1)) {
    const dateKey = toDateKey(date);
    const active = activeDays.get(dateKey);
    const scoreCount = active?.scoreCount ?? 0;

    days.push(normalizeActivityDay({
      date: dateKey,
      scoreCount,
      passedCount: active?.passedCount ?? 0,
      sessionCount: active?.sessionCount ?? 0,
      mapCount: active?.mapCount ?? active?.maps.length ?? 0,
      maps: active?.maps ?? [],
      skills: active?.skills ?? null,
      timeline: active?.timeline ?? [],
    }, typicalSession));
  }

  const weeks = buildActivityWeeks(days);

  return {
    days,
    weeks,
    totalScores: snapshot?.totalScores ?? 0,
    activeDays: snapshot?.activeDays ?? 0,
    totalSessions: snapshot?.totalSessions ?? 0,
    currentStreak: snapshot?.currentStreak ?? 0,
    typicalSession,
    availableYears: snapshot?.availableYears ?? [today.getFullYear()],
    timezone: snapshot?.timezone ?? "UTC",
  };
}

// Skip the empty months before a player's first tracked play: the heatmap
// starts at the first active month and always runs through December.
function getActivityHeatmapRange(
  snapshot: LivePlayerActivitySnapshot | null,
  year: number,
): { start: Date; end: Date } {
  const firstActiveDate = (snapshot?.days ?? [])
    .filter((day) => day.scoreCount > 0)
    .map((day) => day.date)
    .sort()[0];
  const first = firstActiveDate ? parseLocalDateKey(firstActiveDate) : new Date(year, 0, 1);
  return {
    start: new Date(first.getFullYear(), first.getMonth(), 1),
    end: new Date(year, 11, 31),
  };
}

function normalizeActivityDay(day: Omit<ActivityDay, "level">, typicalSession: number): ActivityDay {
  return {
    ...day,
    level: getActivityLevel(day.scoreCount, typicalSession),
  };
}

function buildActivityWeeks(days: ActivityDay[]): ActivityWeek[] {
  const weeks: ActivityWeek[] = [];
  let current: (ActivityDay | null)[] = [];

  const leadingBlanks = days[0] ? parseLocalDateKey(days[0].date).getDay() : 0;
  for (let index = 0; index < leadingBlanks; index++) current.push(null);

  for (const day of days) {
    current.push(day);
    if (current.length === 7) {
      weeks.push({ key: day.date, days: current });
      current = [];
    }
  }

  if (current.length > 0) {
    const key = current.find((day): day is ActivityDay => day != null)?.date ?? `week-${weeks.length}`;
    while (current.length < 7) current.push(null);
    weeks.push({ key, days: current });
  }

  return weeks;
}

function getActivityLevel(scoreCount: number, typicalSession: number): 0 | 1 | 2 | 3 | 4 {
  if (scoreCount <= 0) return 0;
  if (scoreCount < typicalSession * 0.5) return 1;
  if (scoreCount < typicalSession) return 2;
  if (scoreCount < typicalSession * 2) return 3;
  return 4;
}

function getActivityCellStyle(day: ActivityDay, typicalSession: number) {
  const ratio = Math.min(1, day.scoreCount / Math.max(1, typicalSession * 2.4));
  const eased = Math.sqrt(ratio);
  const saturation = Math.round(58 + eased * 42);
  const lightness = Math.round(20 + eased * 55);
  const alpha = (0.62 + eased * 0.38).toFixed(2);
  const borderAlpha = (0.08 + eased * 0.22).toFixed(2);
  return {
    backgroundColor: `hsl(var(--theme-hue) calc(${saturation}% * var(--theme-sat)) ${lightness}% / ${alpha})`,
    borderColor: `hsl(var(--theme-hue) calc(100% * var(--theme-sat)) 82% / ${borderAlpha})`,
    boxShadow: "none",
  };
}

function groupActivityTimelineBySession(segments: ActivityTimelineSegment[]): ActivityTimelineSegment[][] {
  const groups = new Map<number, ActivityTimelineSegment[]>();
  for (const segment of segments) {
    groups.set(segment.sessionIndex, [...(groups.get(segment.sessionIndex) ?? []), segment]);
  }
  return [...groups.values()]
    .sort((a, b) => Date.parse(a[0].startAt) - Date.parse(b[0].startAt));
}

// Time actually spent inside sessions (first to last play of each one), not
// the wall-clock span of the day.
function getActivityDayPlayedMs(day: ActivityDay): number {
  return groupActivityTimelineBySession(day.timeline).reduce((sum, session) => {
    const elapsed = Date.parse(session[session.length - 1].endAt) - Date.parse(session[0].startAt);
    return sum + Math.max(0, Number.isFinite(elapsed) ? elapsed : 0);
  }, 0);
}

// One entry per skill+keymode with summed plays: the session bar already
// carries the chronology, so the chip list reads as "what was played",
// most-played first, instead of one chip per timeline segment.
function aggregateActivitySessionBreakdown(session: ActivityTimelineSegment[]): {
  skill: LivePlayerActivityPrimarySkill;
  keyCount: number | null;
  playCount: number;
}[] {
  const groups = new Map<string, { skill: LivePlayerActivityPrimarySkill; keyCount: number | null; playCount: number }>();
  for (const segment of session) {
    const key = `${segment.primarySkill}:${segment.keyCount ?? "x"}`;
    const existing = groups.get(key);
    if (existing) {
      existing.playCount += segment.playCount;
    } else {
      groups.set(key, { skill: segment.primarySkill, keyCount: segment.keyCount, playCount: segment.playCount });
    }
  }
  return [...groups.values()].sort((left, right) => right.playCount - left.playCount);
}

function getActivityPrimarySkill(skills: LivePlayerActivitySkillVector | null): LivePlayerActivityPrimarySkill {
  return skills?.primary ?? "unknown";
}

// Pattern ids come from the backend's dan estimator families; unknown ids get
// a derived label and a palette color so future families render unchanged.
const ACTIVITY_PATTERN_META: Record<string, { label: MessageDescriptor; shortLabel: string; color: string }> = {
  stream: { label: msg`Stream`, shortLabel: "S", color: "#8f6bd8" },
  jumpstream: { label: msg`Jumpstream`, shortLabel: "JS", color: "#6f87d8" },
  handstream: { label: msg`Handstream`, shortLabel: "HS", color: "#b06bc0" },
  jack: { label: msg`Jack`, shortLabel: "J", color: "#c66f84" },
  chordjack: { label: msg`Chordjack`, shortLabel: "CJ", color: "#c59a5c" },
  stamina: { label: msg`Stamina`, shortLabel: "ST", color: "#ad6b5d" },
  tech: { label: msg`Tech`, shortLabel: "T", color: "#83a86f" },
  ln: { label: msg`LN`, shortLabel: "LN", color: "#57aeba" },
  lnGeneral: { label: msg`LN General`, shortLabel: "LNG", color: "#63bf98" },
  lnRelease: { label: msg`LN Release`, shortLabel: "LNR", color: "#58b7d9" },
  lnInverse: { label: msg`LN Inverse`, shortLabel: "LNI", color: "#7fbed2" },
  lnTech: { label: msg`LN Tech`, shortLabel: "LNT", color: "#9f78df" },
  unknown: { label: msg`Unknown`, shortLabel: "", color: "#5f596b" },
};

const ACTIVITY_WEEKDAY_LABELS: MessageDescriptor[] = [
  msg`Sun`,
  msg`Mon`,
  msg`Tue`,
  msg`Wed`,
  msg`Thu`,
  msg`Fri`,
  msg`Sat`,
];

const ACTIVITY_PATTERN_FALLBACK_COLORS = ["#8c7fb8", "#b88a7f", "#7fb89a", "#b8a87f", "#7f9ab8"];

function getActivityPatternColor(patternId: string): string {
  const meta = ACTIVITY_PATTERN_META[patternId];
  if (meta) return meta.color;
  let hash = 0;
  for (let index = 0; index < patternId.length; index++) hash = (hash * 31 + patternId.charCodeAt(index)) | 0;
  return ACTIVITY_PATTERN_FALLBACK_COLORS[Math.abs(hash) % ACTIVITY_PATTERN_FALLBACK_COLORS.length];
}

function getActivityPatternMeta(patternId: string, keyCount: number | null, i18n: I18n): { label: string; shortLabel: string; color: string } {
  // The estimator's handstream family reads as brackets in 7K+ vocabulary;
  // the score is the same, only the label follows the keymode.
  if (patternId === "handstream" && keyCount != null && keyCount >= 7) {
    return { label: i18n._(msg`Bracket`), shortLabel: "B", color: ACTIVITY_PATTERN_META.handstream.color };
  }
  const meta = ACTIVITY_PATTERN_META[patternId];
  if (meta) return { label: i18n._(meta.label), shortLabel: meta.shortLabel, color: meta.color };
  return {
    label: patternId.charAt(0).toUpperCase() + patternId.slice(1),
    shortLabel: patternId.slice(0, 2).toUpperCase(),
    color: getActivityPatternColor(patternId),
  };
}

function getActivityPatternEntries(patterns: LivePlayerActivityPatterns | null | undefined, keyCount: number | null, i18n: I18n) {
  return Object.entries(patterns ?? {})
    .map(([key, raw]) => {
      const meta = getActivityPatternMeta(key, keyCount, i18n);
      return { key, label: meta.label, shortLabel: meta.shortLabel, value: Math.round(clamp01(Number(raw)) * 100) };
    })
    .filter(({ value }) => value >= 5)
    .sort((left, right) => right.value - left.value);
}

function getActivitySkillColor(skill: LivePlayerActivityPrimarySkill): string {
  return getActivityPatternColor(skill);
}

function getActivityTimelineSegmentColor(segment: ActivityTimelineSegment): string {
  return getActivitySkillColor(segment.primarySkill);
}

function getActivitySkillLabel(skill: LivePlayerActivityPrimarySkill, keyCount: number | null, i18n: I18n): string {
  if (skill === "mixed") return i18n._(msg`Hybrid`);
  return getActivityPatternMeta(skill, keyCount, i18n).label;
}

function formatActivityKeyFlow(segments: ActivityTimelineSegment[], mixedLabel: string): string {
  const labels = [...new Set(segments
    .map((segment) => formatActivityKeyCount(segment.keyCount))
    .filter((label): label is string => label != null))];
  if (labels.length === 0) return mixedLabel;
  return labels.join(" / ");
}

// Adjacent same-keymode same-skill segments read as one block; merging them
// frees enough width for the survivors' labels.
function mergeActivitySessionSegments(session: ActivityTimelineSegment[]): ActivityTimelineSegment[] {
  const merged: ActivityTimelineSegment[] = [];
  for (const segment of session) {
    const prev = merged[merged.length - 1];
    if (prev && prev.keyCount === segment.keyCount && prev.primarySkill === segment.primarySkill) {
      merged[merged.length - 1] = {
        ...prev,
        endAt: segment.endAt,
        playCount: prev.playCount + segment.playCount,
        patterns: mergeActivityPatterns(prev.patterns, prev.playCount, segment.patterns, segment.playCount),
      };
    } else {
      merged.push(segment);
    }
  }
  return merged;
}

function mergeActivityPatterns(
  left: LivePlayerActivityPatterns,
  leftPlays: number,
  right: LivePlayerActivityPatterns,
  rightPlays: number,
): LivePlayerActivityPatterns {
  const total = Math.max(1, leftPlays + rightPlays);
  const out: LivePlayerActivityPatterns = {};
  for (const key of new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])) {
    out[key] = ((Number(left?.[key]) || 0) * leftPlays + (Number(right?.[key]) || 0) * rightPlays) / total;
  }
  return out;
}

function createDevActivityPatterns(skill: LivePlayerActivityPrimarySkill, keyCount: number | null): LivePlayerActivityPatterns {
  if (skill === "unknown") return {};
  const base: LivePlayerActivityPatterns = keyCount != null && keyCount >= 7
    ? { ln: 0.46, lnRelease: 0.34, handstream: 0.3, stream: 0.36, tech: 0.32 }
    : { stream: 0.42, jumpstream: 0.31, tech: 0.38, jack: 0.26, chordjack: 0.24, stamina: 0.45 };
  if (skill === "mixed") return { ...base, stream: 0.64, chordjack: 0.6, tech: 0.58 };
  return { ...base, [skill]: 0.88 };
}

function createDevActivityMap(
  index: number,
  title: string,
  artist: string,
  version: string,
  keyCount: number,
  plays: number,
  accuracy: number,
  pp: number,
  primary: LivePlayerActivityPrimarySkill | null,
): ActivityPlayedMap {
  return {
    key: `dev-map-${index}`,
    beatmapId: 4000000 + index,
    beatmapsetId: 1900000 + index,
    title,
    artist,
    version,
    coverUrl: null,
    plays,
    accuracy,
    pp,
    rank: "S",
    keyCount,
    skills: primary ? { primary, patterns: createDevActivityPatterns(primary, keyCount) } : null,
  };
}

// Dev-only fixture for previewing the day modal with a busy multi-keymode day;
// local setups usually run without osu! API jobs, so real days stay sparse.
// Covers: adjacent merge candidates, sub-threshold segments, unanalyzed
// segments, 7K bracket relabeling, hybrid, partial analysis, map overflow.
function createDevActivityDay(timezone: string): ActivityDay {
  const sessionSpecs: { keyCount: number | null; skill: LivePlayerActivityPrimarySkill; plays: number; minutes: number }[][] = [
    [
      { keyCount: 4, skill: "chordjack", plays: 5, minutes: 14 },
      { keyCount: 4, skill: "stream", plays: 1, minutes: 3 },
      { keyCount: 4, skill: "stream", plays: 3, minutes: 9 },
      { keyCount: 4, skill: "tech", plays: 2, minutes: 6 },
      { keyCount: 4, skill: "unknown", plays: 1, minutes: 3 },
      { keyCount: 4, skill: "jack", plays: 1, minutes: 2 },
      { keyCount: 4, skill: "chordjack", plays: 6, minutes: 16 },
      { keyCount: 4, skill: "mixed", plays: 4, minutes: 11 },
      { keyCount: 7, skill: "jumpstream", plays: 3, minutes: 8 },
    ],
    [
      { keyCount: 7, skill: "ln", plays: 6, minutes: 18 },
      { keyCount: 7, skill: "handstream", plays: 2, minutes: 7 },
      { keyCount: 7, skill: "unknown", plays: 1, minutes: 3 },
      { keyCount: 7, skill: "lnRelease", plays: 4, minutes: 12 },
      { keyCount: 7, skill: "mixed", plays: 5, minutes: 13 },
    ],
    [
      { keyCount: 4, skill: "stamina", plays: 7, minutes: 19 },
      { keyCount: 4, skill: "stream", plays: 2, minutes: 5 },
    ],
  ];
  const start = new Date();
  start.setHours(13, 40, 0, 0);
  let cursor = start.getTime();
  const timeline: ActivityTimelineSegment[] = [];
  sessionSpecs.forEach((session, sessionIndex) => {
    session.forEach((spec, segmentIndex) => {
      const startAt = new Date(cursor).toISOString();
      cursor += spec.minutes * 60_000;
      timeline.push({
        key: `dev:${sessionIndex}:${segmentIndex}`,
        sessionIndex,
        startAt,
        endAt: new Date(cursor).toISOString(),
        playCount: spec.plays,
        keyCount: spec.keyCount,
        primarySkill: spec.skill,
        patterns: createDevActivityPatterns(spec.skill, spec.keyCount),
      });
    });
    cursor += 75 * 60_000;
  });
  const scoreCount = timeline.reduce((sum, segment) => sum + segment.playCount, 0);
  const playsForKeyCount = (keyCount: number) => timeline
    .filter((segment) => segment.keyCount === keyCount)
    .reduce((sum, segment) => sum + segment.playCount, 0);
  const maps = [
    createDevActivityMap(1, "Quantum Surgery", "Camellia", "[4K] Lasersweep", 4, 6, 0.9641, 412, "chordjack"),
    createDevActivityMap(2, "Snow Crystals", "yuki.", "[4K] Hyper", 4, 5, 0.9893, 121, "stream"),
    createDevActivityMap(3, "Lights of Muse", "xi", "[7K] LN Master", 7, 4, 0.9712, 287, "ln"),
    createDevActivityMap(4, "Backbeat Maniac", "Eternal", "[4K] SHD", 4, 4, 0.9534, 198, "stamina"),
    createDevActivityMap(5, "Brain Power", "NOMA", "[4K] Another", 4, 3, 0.9477, 233, "mixed"),
    createDevActivityMap(6, "Future Dominators", "technoplanet", "[7K] 4 Dimensions", 7, 3, 0.9588, 305, "handstream"),
    createDevActivityMap(7, "Grand Thaw", "Aoi", "[7K] Release", 7, 3, 0.9821, 176, "lnRelease"),
    createDevActivityMap(8, "Pure Ruby", "DJ Sharpnel", "[4K] Lunatic", 4, 2, 0.9312, 264, "jack"),
    createDevActivityMap(9, "Cicadidae", "t+pazolite", "[4K] Extra", 4, 2, 0.9665, 209, "tech"),
    createDevActivityMap(10, "Unknown Signal", "Various Artists", "[4K] ???", 4, 1, 0.9402, 88, null),
  ];
  return {
    date: getZonedDateKey(start, timezone),
    scoreCount,
    passedCount: Math.round(scoreCount * 0.7),
    sessionCount: sessionSpecs.length,
    mapCount: maps.length + 4,
    level: 4,
    maps,
    skills: {
      patterns: { stream: 0.74, chordjack: 0.72, tech: 0.66, stamina: 0.62, jack: 0.48 },
      analyzedPlays: scoreCount - 2,
      totalPlays: scoreCount,
      keyModes: [
        {
          keyCount: 4,
          patterns: { stream: 0.86, chordjack: 0.72, tech: 0.71, stamina: 0.7, jack: 0.61 },
          analyzedPlays: playsForKeyCount(4) - 1,
          totalPlays: playsForKeyCount(4),
        },
        {
          keyCount: 7,
          patterns: { ln: 0.82, lnRelease: 0.66, handstream: 0.58, stream: 0.4 },
          analyzedPlays: playsForKeyCount(7) - 1,
          totalPlays: playsForKeyCount(7),
        },
      ],
    },
    timeline,
  };
}

function formatActivitySegmentTitle(segment: ActivityTimelineSegment, timeZone: string, i18n: I18n): string {
  const scores = getActivityPatternEntries(segment.patterns, segment.keyCount, i18n)
    .slice(0, 4)
    .map(({ shortLabel, value }) => `${shortLabel} ${value}%`)
    .join(" / ");
  return [
    `${formatActivityTime(segment.startAt, timeZone)} - ${formatActivityTime(segment.endAt, timeZone)}`,
    segment.playCount === 1
      ? i18n._(msg`${formatNumber(segment.playCount)} play`)
      : i18n._(msg`${formatNumber(segment.playCount)} plays`),
    formatActivityKeyCount(segment.keyCount),
    getActivitySkillLabel(segment.primarySkill, segment.keyCount, i18n),
    scores,
  ].filter(Boolean).join(" • ");
}

function formatActivityKeyCount(keyCount: number | null): string | null {
  if (keyCount == null || !Number.isFinite(keyCount) || keyCount <= 0) return null;
  return `${Math.round(keyCount)}K`;
}

// Safety net: with player-timezone bucketing a session always falls on its
// heatmap date, but stale data from an older backend can still cross over;
// label those sessions with their date so the order stays legible.
function formatActivitySessionDate(startAt: string, dayKey: string, timeZone: string): string | null {
  const date = new Date(startAt);
  if (!Number.isFinite(date.getTime())) return null;
  if (getZonedDateKey(date, timeZone) === dayKey) return null;
  try {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
  } catch {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
}

// en-CA formats as YYYY-MM-DD, matching the backend's day keys.
function getZonedDateKey(date: Date, timeZone: string): string {
  try {
    return date.toLocaleDateString("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return toDateKey(date);
  }
}

function formatActivityTime(value: string, timeZone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  try {
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  } catch {
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
}

const ACTIVITY_MINUTES_PER_DAY = 24 * 60;
// Below this a session block on the day clock is an invisible sliver.
const ACTIVITY_DAY_CLOCK_MIN_MINUTES = 8;

function formatActivityDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

function getZonedMinutesOfDay(value: string, timeZone: string): number | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" })
      .formatToParts(date);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
  } catch {
    return date.getHours() * 60 + date.getMinutes();
  }
}

// Shown only when the viewer's clock differs from the player's timezone, so
// the session times don't read as broken to foreign visitors.
function getActivityTimezoneHint(timeZone: string, referenceIso: string | undefined): string | null {
  const reference = referenceIso ? new Date(referenceIso) : new Date();
  if (!Number.isFinite(reference.getTime())) return null;
  try {
    const zoned = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
      .formatToParts(reference)
      .find((part) => part.type === "timeZoneName")?.value ?? null;
    const local = new Intl.DateTimeFormat("en-US", { timeZoneName: "shortOffset" })
      .formatToParts(reference)
      .find((part) => part.type === "timeZoneName")?.value ?? null;
    if (!zoned || zoned === local) return null;
    return zoned;
  } catch {
    return null;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseLocalDateKey(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function formatFullActivityDate(date: string): string {
  return parseLocalDateKey(date).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatActivityMonth(date: string): string {
  return parseLocalDateKey(date).toLocaleDateString("en-US", {
    month: "short",
  });
}

/* A restricted player's own page, drawn from its BBCode the same way the
   editor preview draws it. */

function ActivityOptInEmptyState({
  mode,
  loginAvailable,
  onTracked,
}: {
  mode: "self" | "other" | "anon";
  loginAvailable: boolean;
  onTracked?: () => void;
}) {
  const location = useLocation();
  const { t } = useLingui();
  const [status, setStatus] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const loginHref = `/api/auth/osu?next=${encodeURIComponent(`${location.pathname}${location.searchStr}`)}`;

  const handleTrack = useCallback(async () => {
    setStatus("pending");
    setMessage(null);
    try {
      const result = await addSelfToRoster();
      if (result.ok) {
        setStatus("done");
        showTrackingStartedToast();
        onTracked?.();
        return;
      }
      setStatus("error");
      setMessage(
        result.status === "country_not_tracked"
          ? t`Your country isn't tracked yet, so there's nothing to record your plays against.`
          : result.status === "country_full"
            ? t`This country's opt-in list is full right now. Check back later.`
            : t`Couldn't turn on tracking right now. Try again in a moment.`,
      );
    } catch {
      setStatus("error");
      setMessage(t`Couldn't turn on tracking right now. Try again in a moment.`);
    }
  }, [onTracked]);

  if (mode === "self" && status === "done") {
    return (
      <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-6 text-center">
        <div className="text-sm font-semibold text-osu-l2">{t`You're being tracked now`}</div>
        <div className="mt-1.5 text-[13px] text-osu-f1">
          {t`Your recent plays are being pulled in. Activity will start filling in here within a minute or two, and keeps updating as you play.`}
        </div>
      </div>
    );
  }

  if (mode === "self") {
    return (
      <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-6 text-center">
        <div className="text-sm font-semibold text-osu-l2">{t`Start tracking your plays`}</div>
        <div className="mt-1.5 text-[13px] text-osu-f1">
          {t`Activity is recorded automatically for the top 100 of each country. You're not in it yet, but you can add yourself to the tracker.`}
        </div>
        <button
          type="button"
          onClick={handleTrack}
          disabled={status === "pending"}
          className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-osu-pink/40 bg-osu-pink/15 text-[12px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white cursor-pointer disabled:opacity-60 disabled:cursor-default"
        >
          {status === "pending" ? t`Adding you…` : t`Track my plays`}
        </button>
        {message ? <div className="mt-3 text-[12px] text-osu-f1">{message}</div> : null}
      </div>
    );
  }

  if (mode === "anon") {
    return (
      <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-6 text-center">
        <div className="text-sm font-semibold text-osu-l2">{t`No activity data for this player`}</div>
        <div className="mt-1.5 text-[13px] text-osu-f1">
          {t`Activity is recorded for the top 100 of each tracked country. If this is your profile, log in with osu! to add yourself to the tracker.`}
        </div>
        {loginAvailable ? (
          <a
            href={loginHref}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-osu-pink/40 bg-osu-pink/15 px-4 py-2 text-[12px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white"
          >
            <OsuLogo className="h-4 w-4" />
            {t`Log in with osu!`}
          </a>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-6 text-center">
      <div className="text-sm font-semibold text-osu-l2">{t`No activity data for this player`}</div>
      <div className="mt-1.5 text-[13px] text-osu-f1">
        {t`Plays are only recorded for the top 100 players of each tracked country, and this player isn't currently among them.`}
      </div>
    </div>
  );
}
