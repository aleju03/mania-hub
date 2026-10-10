import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { fetchLiveMapScores, type LiveMapScoreEntry, type LiveMapScoresSnapshot, type LiveMapSearchEntry } from "../../lib/live-backend";
import { formatAccuracy, formatTimeAgo, formatTimeAgoTooltip } from "../../lib/format";
import { getManiaGradeFromAccuracy } from "../../lib/score";
import { useLocale } from "../../lib/locale-context";
import { useAuth } from "../../lib/auth-context";
import type { OsuScore } from "../../lib/types";
import { Avatar } from "../ui/Avatar";
import { CompanellaMark } from "../ui/CompanellaMark";
import { CountryFlag } from "../ui/CountryFlag";
import { GradeImg } from "../ui/GradeImg";
import { ModBadge } from "../ui/ModBadge";
import { Skeleton } from "../ui/LoadingSkeleton";
import { UsernameText } from "../ui/UsernameText";

// Keyed by beatmap and viewer, so switching diffs back and forth stays warm.
// Kept a minute, like the endpoint's own cache.
const BOARD_CACHE_TTL_MS = 60_000;
const boardCache = new Map<string, { snapshot: LiveMapScoresSnapshot; at: number }>();

function cachedBoard(key: string): LiveMapScoresSnapshot | null {
  const hit = boardCache.get(key);
  return hit && Date.now() - hit.at < BOARD_CACHE_TTL_MS ? hit.snapshot : null;
}

/** A board row as the score the play card reads. */
export function mapScoreEntryScore(entry: LiveMapScoreEntry, map: LiveMapSearchEntry): OsuScore {
  return {
    id: entry.soloScoreId ?? entry.scoreId,
    type: "solo_score",
    user_id: entry.user.id,
    user: { id: entry.user.id, username: entry.user.username, avatar_url: entry.user.avatar_url, country_code: entry.user.country_code },
    accuracy: entry.accuracy,
    mods: entry.mods.map((acronym) => ({ acronym })),
    score: entry.totalScore ?? 0,
    total_score: entry.totalScore ?? 0,
    // An app import has no osu! score id: its mark carries the import, which
    // the play card shares and opens the replay of.
    ...(entry.companella
      ? { companella: entry.companella, ...(entry.isLazer ? {} : { legacy_total_score: entry.totalScore ?? 0 }) }
      : entry.isLazer ? {} : { legacy_score_id: entry.scoreId, legacy_total_score: entry.totalScore ?? 0 }),
    pp: entry.pp,
    rank: entry.grade,
    passed: true,
    // Unknown stays unknown: the card shows a dash rather than 0x.
    max_combo: entry.maxCombo ?? undefined,
    statistics: entry.statistics ?? {},
    has_replay: entry.hasReplay,
    ended_at: entry.playedAt ?? "",
    created_at: entry.playedAt ?? "",
    beatmap: { id: map.beatmapId, beatmapset_id: map.beatmapsetId, version: map.version, difficulty_rating: map.stars, cs: map.keyCount, mode: "mania" },
    beatmapset: { id: map.beatmapsetId, title: map.title, artist: map.artist, creator: map.creator, covers: map.covers ?? {} },
  } as unknown as OsuScore;
}

/** The top tracked plays on one chart, ranked by lazer accuracy. */
export function MapScoresBoard({ beatmapId, onOpen }: { beatmapId: number; onOpen: (entry: LiveMapScoreEntry) => void }) {
  const { t } = useLingui();
  const viewerId = useAuth().viewer?.id ?? null;
  const cacheKey = `${beatmapId}:${viewerId ?? ""}`;
  const [board, setBoard] = useState<LiveMapScoresSnapshot | null>(() => cachedBoard(cacheKey));
  const [error, setError] = useState(false);

  useEffect(() => {
    const cached = cachedBoard(cacheKey);
    setBoard(cached);
    setError(false);
    if (cached) return;
    let cancelled = false;
    fetchLiveMapScores(beatmapId, viewerId)
      .then((snapshot) => {
        boardCache.set(cacheKey, { snapshot, at: Date.now() });
        if (!cancelled) setBoard(snapshot);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [beatmapId, cacheKey, viewerId]);

  if (error) return <span className="text-[11.5px] text-osu-f1">{t`Could not load the scores.`}</span>;
  if (!board) {
    return (
      <div className="flex flex-col" aria-busy="true">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="flex items-center gap-2.5 border-t border-white/[0.07] py-2 first:border-t-0">
            <Skeleton className="h-3 w-5" />
            <Skeleton className="h-6 w-6 rounded-full" />
            <Skeleton className="h-3 w-32" />
            <Skeleton className="ml-auto h-3.5 w-14" />
          </div>
        ))}
      </div>
    );
  }
  if (board.entries.length === 0) {
    return <span className="text-[11.5px] text-osu-f1">{t`No tracked plays on this difficulty yet.`}</span>;
  }

  return (
    <div className="flex flex-col">
      {board.entries.map((entry) => (
        <MapScoreRow key={entry.user.id} entry={entry} own={entry.user.id === viewerId} onOpen={onOpen} />
      ))}
      {board.self ? (
        <div className="mt-1 border-t border-white/[0.07] pt-1">
          <MapScoreRow entry={board.self} own onOpen={onOpen} />
        </div>
      ) : null}
    </div>
  );
}

function MapScoreRow({ entry, own, onOpen }: { entry: LiveMapScoreEntry; own: boolean; onOpen: (entry: LiveMapScoreEntry) => void }) {
  const { t } = useLingui();
  const locale = useLocale();
  // The grade follows the accuracy shown, so a stable SS with 300s reads as the S it is on this scale.
  const grade = getManiaGradeFromAccuracy(entry.accuracy, entry.mods.map((acronym) => ({ acronym }))) ?? entry.grade;
  return (
    <button
      type="button"
      onClick={() => onOpen(entry)}
      title={t`Open ${entry.user.username}'s play`}
      className={`grid cursor-pointer grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded border-t border-white/[0.07] py-1.5 pr-1.5 text-left first:border-t-0 hover:bg-white/[0.03] sm:grid-cols-[1.75rem_minmax(0,1fr)_auto_4.5rem] ${own ? "bg-osu-pink/10" : ""}`}
    >
      <span className={`text-right text-[11px] font-bold tabular-nums ${own ? "text-osu-pink-light" : "text-osu-f1"}`}>#{entry.position}</span>
      <span className="flex min-w-0 items-center gap-2">
        <Avatar url={entry.user.avatar_url} size={24} />
        <CountryFlag code={entry.user.country_code} size="xs" decorative />
        <UsernameText
          username={entry.user.username}
          avatarUrl={entry.user.avatar_url}
          accent={entry.user.avatar_accent}
          className="truncate text-[12.5px] font-semibold text-white"
        />
        {entry.companella ? <CompanellaMark app={entry.companella.app} className="h-[15px] w-[15px]" /> : null}
        {entry.mods.map((mod) => (
          <ModBadge key={mod} mod={mod} size={0.55} />
        ))}
      </span>
      <span className="flex items-center gap-2">
        <GradeImg grade={grade} size={20} />
        <span className="w-[4.25rem] text-right text-[14px] font-bold tabular-nums text-white">{formatAccuracy(entry.accuracy)}</span>
      </span>
      <span
        className="hidden text-right text-[11px] text-osu-f1 sm:block"
        title={entry.playedAt ? formatTimeAgoTooltip(entry.playedAt, locale) : undefined}
      >
        {entry.playedAt ? formatTimeAgo(entry.playedAt, locale) : ""}
      </span>
    </button>
  );
}
