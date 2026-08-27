import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { Pagination } from "../ui/Pagination";
import { SegmentedControl } from "../ui/SegmentedControl";
import { LeaderboardTable, type LeaderboardRow } from "./LeaderboardTable";
import { DanSkillsetPicker, KeymodeControl } from "./LeaderboardControls";
import { DanLevelBadge } from "../player/DanLevelBadge";
import { DAN_SKILLSET_META } from "../../lib/skill-axes";
import { loadDanBoard, peekDanBoard } from "../../lib/skill-leaderboard-cache";
import { formatNumber } from "../../lib/format";
import { useHiddenUserIds } from "../../store";
import {
  DEFAULT_DAN_SKILLSET,
  LEADERBOARD_PAGE_SIZE,
  type DanLeaderboardSnapshot,
  type DanSide,
  type LeaderboardKeyCount,
} from "../../lib/skill-leaderboards";

// The dan boards. Unlike the skill boards these are not shrunk: a player's dan
// is already the 4th-best credited clear, so the evidence floor is baked into
// the estimate rather than applied afterwards.

export function DanLeaderboardBoard({
  country,
  keys,
  side,
  skillset,
  page,
  onNavigate,
}: {
  country: string;
  keys: LeaderboardKeyCount;
  side: DanSide;
  skillset: string | undefined;
  page: number;
  onNavigate: (next: { keys?: LeaderboardKeyCount; side?: DanSide; skillset?: string; page?: number }) => void;
}) {
  const { t, i18n } = useLingui();
  const hiddenUserIds = useHiddenUserIds();
  // No skillset in the URL is the every-clear board, the estimate a profile
  // chip shows. Overall is the first chip on every keymode, so clicking back to
  // it is how a skill selection is cleared.
  const requestedSkillset = skillset ?? DEFAULT_DAN_SKILLSET;
  const request = { country, keys, side, skillset: requestedSkillset, page };
  const [snapshot, setSnapshot] = useState<DanLeaderboardSnapshot | null>(() => peekDanBoard(request));
  const [loading, setLoading] = useState(!snapshot);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cached = peekDanBoard(request);
    if (cached) {
      setSnapshot(cached);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    loadDanBoard(request)
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
  }, [country, keys, side, requestedSkillset, page]);

  // A numbered course reads as a level, not a name, so it needs the word; named
  // ladders (greek letters and the like) already read as one. Same rule the
  // profile's dan chips use.
  const formatDanLabel = (label: string): string => (/^\d/.test(label) ? t`${label} dan` : label);

  /* Two skillsets, deliberately, for the same reason the skill board keeps two
     axes: the chips answer to the one that was CLICKED so a press lands
     immediately, the table to the one that has arrived so a header and its
     numbers always belong together. */
  const servedSkillset = snapshot?.skillset ?? requestedSkillset;
  const skillsetMeta = servedSkillset === DEFAULT_DAN_SKILLSET ? null : DAN_SKILLSET_META[servedSkillset];
  const skillsetLabel = skillsetMeta ? i18n._(skillsetMeta.labelMsg) : servedSkillset;

  const rows: LeaderboardRow[] = useMemo(() => {
    return (snapshot?.ranking ?? [])
      .filter((entry) => !hiddenUserIds.has(entry.user.id))
      .map((entry) => ({
        key: entry.user.id,
        rank: entry.rank,
        user: entry.user,
        value: (
          <span className="inline-flex items-center justify-end gap-2">
            <span className="text-[11px] tabular-nums text-osu-f1">{entry.rawDan.toFixed(2)}</span>
            <DanLevelBadge
              label={entry.label}
              keyCount={keys}
              side={side}
              beyondTable={entry.beyondTable === true}
              size="sm"
              formatLabel={formatDanLabel}
            />
          </span>
        ),
        // Not the clear count: that field counts clears tied with the dan level
        // itself, so it reads "4" on ~98% of rows. Plays at least separates a
        // dan earned off a deep pool from one off a handful of maps.
        detail: <Trans>{formatNumber(entry.analyzedPlays)} plays</Trans>,
      }));
  }, [snapshot, hiddenUserIds, keys, side, t]);

  const totalPages = Math.max(1, Math.ceil((snapshot?.total ?? 0) / LEADERBOARD_PAGE_SIZE));
  const sideOptions: Array<{ value: DanSide; label: string }> = [
    { value: "rc", label: t`Regular` },
    { value: "ln", label: t`LN` },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <KeymodeControl
          id="dan-leaderboard-keys"
          value={keys}
          onChange={(next) => onNavigate({ keys: next, skillset: undefined, page: 1 })}
        />
        <div role="group" aria-label={t`Dan course`}>
          <SegmentedControl
            id="dan-leaderboard-side"
            value={side}
            options={sideOptions}
            onChange={(next) => onNavigate({ side: next, skillset: undefined, page: 1 })}
          />
        </div>
      </div>

      {/* A skillset belongs to one keymode and side (stamina is 4K's, the LN
          subtypes are 7K's), so changing either drops back to every clear
          rather than asking for a column that ladder does not have. */}
      <DanSkillsetPicker
        skillsets={snapshot?.skillsets ?? []}
        value={requestedSkillset}
        onChange={(next) => onNavigate({ skillset: next, page: 1 })}
      />

      {/* Plain line, not a boxed callout: the caveat belongs next to the data,
          not in furniture around it. */}
      <p className="text-[11px] text-osu-f1">
        <Trans>Dan levels here are estimated from the charts a player has passed, not from real course clears. Read this as a rough ordering, not a ranking.</Trans>{' '}
        <Link to="/dan-estimates" className="text-osu-pink-light transition-colors hover:text-white">
          <Trans>Click here to read how dans are estimated</Trans>
        </Link>
      </p>

      <LeaderboardTable
        rows={rows}
        loading={loading}
        error={error}
        emptyMessage={
          servedSkillset === DEFAULT_DAN_SKILLSET
            ? <Trans>Nobody here has enough qualifying clears yet.</Trans>
            : <Trans>Nobody here has enough qualifying {skillsetLabel} clears yet.</Trans>
        }
        valueHeader={servedSkillset === DEFAULT_DAN_SKILLSET ? t`Dan` : t`${skillsetLabel} dan`}
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
