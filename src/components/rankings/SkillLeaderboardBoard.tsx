import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Pagination } from "../ui/Pagination";
import { LeaderboardTable, type LeaderboardRow } from "./LeaderboardTable";
import { AxisPicker, KeymodeControl } from "./LeaderboardControls";
import { loadSkillBoard, peekSkillBoard } from "../../lib/skill-leaderboard-cache";
import { skillAxisMeta } from "../../lib/skill-axes";
import { formatNumber } from "../../lib/format";
import { useHiddenUserIds } from "../../store";
import {
  DEFAULT_LEADERBOARD_AXIS,
  LEADERBOARD_PAGE_SIZE,
  type LeaderboardKeyCount,
  type SkillLeaderboardSnapshot,
} from "../../lib/skill-leaderboards";

// "Who are the best 7K chordjack players". The rating is the display-shrunk one
// the profile Skills tab prints, so a player's number here and on their own page
// are the same number; ranking the raw aggregate instead would put a 20-play
// pool above a 300-play one.

export function SkillLeaderboardBoard({
  country,
  keys,
  axis,
  page,
  onNavigate,
}: {
  country: string;
  keys: LeaderboardKeyCount;
  axis: string | undefined;
  page: number;
  onNavigate: (next: { keys?: LeaderboardKeyCount; axis?: string; page?: number }) => void;
}) {
  const { t, i18n } = useLingui();
  const hiddenUserIds = useHiddenUserIds();
  // No axis in the URL means the aggregate board, not a guess at which
  // specialty the reader wanted. Overall is the first chip on every keymode, so
  // clicking back to it is how you clear a skill selection.
  const requestedAxis = axis ?? DEFAULT_LEADERBOARD_AXIS;
  const request = { country, keys, axis: requestedAxis, page };
  const [snapshot, setSnapshot] = useState<SkillLeaderboardSnapshot | null>(() => peekSkillBoard(request));
  const [loading, setLoading] = useState(!snapshot);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cached = peekSkillBoard(request);
    if (cached) {
      setSnapshot(cached);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    loadSkillBoard(request)
      .then((next) => {
        if (cancelled) return;
        setSnapshot(next);
        setLoading(false);
        if (!next) setError(t`Could not load this leaderboard.`);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
        setError(t`Could not load this leaderboard.`);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, keys, requestedAxis, page]);

  const activeAxis = snapshot?.axis ?? requestedAxis;
  const isOverall = activeAxis === DEFAULT_LEADERBOARD_AXIS;
  const meta = skillAxisMeta(activeAxis);
  const axisLabel = meta ? i18n._(meta.labelMsg) : activeAxis;

  const rows: LeaderboardRow[] = useMemo(() => {
    return (snapshot?.ranking ?? [])
      .filter((entry) => !hiddenUserIds.has(entry.user.id))
      .map((entry) => ({
        key: entry.user.id,
        rank: entry.rank,
        user: entry.user,
        value: (
          <span
            className="text-base font-bold tabular-nums"
            style={meta ? { color: meta.color } : undefined}
          >
            {entry.value.toFixed(2)}
          </span>
        ),
        detail: entry.provisional
          ? (
            <span className="opacity-50" title={t`Fewer plays than the population baseline asks for, so this rating reads as an estimate`}>
              <Trans>{formatNumber(entry.plays)} plays</Trans>
            </span>
          )
          : <Trans>{formatNumber(entry.plays)} plays</Trans>,
      }));
  }, [snapshot, hiddenUserIds, meta, t]);

  const totalPages = Math.max(1, Math.ceil((snapshot?.total ?? 0) / LEADERBOARD_PAGE_SIZE));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <KeymodeControl
          id="skill-leaderboard-keys"
          value={keys}
          onChange={(next) => onNavigate({ keys: next, axis: undefined, page: 1 })}
        />
        <AxisPicker
          axes={snapshot?.axes ?? []}
          value={activeAxis}
          onChange={(next) => onNavigate({ axis: next, page: 1 })}
        />
      </div>

      {snapshot && !snapshot.shrunk && (
        <p className="text-[11px] text-osu-f1">
          <Trans>The population baseline has not been built yet, so these are raw ratings and will not match the numbers on player profiles.</Trans>
        </p>
      )}

      <LeaderboardTable
        rows={rows}
        loading={loading}
        error={error}
        emptyMessage={
          isOverall
            ? <Trans>No rated players here yet.</Trans>
            : <Trans>Nobody here has a rated {axisLabel} pool yet.</Trans>
        }
        valueHeader={axisLabel}
        detailHeader={t`Plays`}
      />

      {totalPages > 1 && (
        <Pagination
          page={page - 1}
          totalPages={totalPages}
          onPageChange={(next) => onNavigate({ page: next + 1 })}
        />
      )}
    </div>
  );
}
