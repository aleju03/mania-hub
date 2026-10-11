import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CircleHelp } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Pagination } from "../ui/Pagination";
import { SegmentedControl } from "../ui/SegmentedControl";
import { LeaderboardTable, type LeaderboardRow } from "./LeaderboardTable";
import { DanSkillsetPicker, KeymodeControl } from "./LeaderboardControls";
import { DanLevelBadge } from "../player/DanLevelBadge";
import { DAN_SKILLSET_META } from "../../lib/skill-axes";
import { loadClearBoard, peekClearBoard } from "../../lib/skill-leaderboard-cache";
import { formatAccuracy, formatNumber, intlLocaleTag } from "../../lib/format";
import { formatDateTime } from "../../lib/intl-formatters";
import { useLocale } from "../../lib/locale-context";
import { buildCourseClearScore } from "../../lib/tracked-play-score";
import { ScoreDetailModal } from "../player/ScoreRows";
import type { OsuScore } from "../../lib/types";
import { useHiddenUserIds } from "../../store";
import {
  DEFAULT_CLEAR_SKILLSET,
  DAN_LEADERBOARD_KEY_COUNTS,
  LEADERBOARD_PAGE_SIZE,
  type ClearLeaderboardSnapshot,
  type DanSide,
  type LeaderboardKeyCount,
} from "../../lib/skill-leaderboards";

// The clears board: each player's highest verified pass of a full dan course,
// or of a skillset's practice charts, ordered by that level and then by the
// accuracy of the run. Only runs at or above the pass bar are on it.

// Mods worth naming beside a clear: the ones that change how hard the run was.
// Mirror and the scoring toggles are left off.
const SHOWN_MODS = new Set(["DT", "NC", "HR", "HD", "FI", "FL"]);

/* The registry names restate what the row already shows: the keymode and side
   are picked above, and the badge is the level. What is left names the run:
   "FINAL-ZETA", "Dan 16th - Yokaze", or the practice chart's own title with
   its "~ Zenith ~" level tag and "(Marathon)" suffix taken off. The full name
   stays in the hover. */
function shortClearName(name: string): string {
  const short = name
    .replace(/\s+/g, " ")
    .replace(/^\d+K (Regular |LN )?/, "")
    .replace(/^Dan ~ REFORM ~ /, "")
    .replace(/ \(Marathon\)$/, "")
    .replace(/^[~-] [^~]+ ~ /, "")
    .replace(/ ~ [^~]+ ~$/, "")
    .trim();
  return short || name.trim();
}

export function ClearLeaderboardBoard({
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
  const locale = useLocale();
  const requestedSkillset = skillset ?? DEFAULT_CLEAR_SKILLSET;
  const request = { country, keys, side, skillset: requestedSkillset, page };
  const [snapshot, setSnapshot] = useState<ClearLeaderboardSnapshot | null>(() => peekClearBoard(request));
  const [loading, setLoading] = useState(!snapshot);
  const [error, setError] = useState<string | null>(null);
  const [openScore, setOpenScore] = useState<OsuScore | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cached = peekClearBoard(request);
    if (cached) {
      setSnapshot(cached);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    loadClearBoard(request)
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

  const formatDanLabel = (label: string): string => (/^\d/.test(label) ? t`${label} dan` : label);

  // Chips answer to the click, the table to the snapshot on screen (same split
  // as the dan board).
  const servedSkillset = snapshot?.skillset ?? requestedSkillset;
  const servedKeys = snapshot?.keyCount ?? keys;
  const servedSide = snapshot?.side ?? side;
  const staleLadder = snapshot != null && (snapshot.keyCount !== keys || snapshot.side !== side);
  const courses = servedSkillset === DEFAULT_CLEAR_SKILLSET;
  const skillsetMeta = courses ? null : DAN_SKILLSET_META[servedSkillset];
  const skillsetLabel = skillsetMeta ? i18n._(skillsetMeta.labelMsg) : servedSkillset;

  const rows: LeaderboardRow[] = useMemo(() => {
    return (snapshot?.ranking ?? [])
      .filter((entry) => !hiddenUserIds.has(entry.user.id))
      .map((entry) => {
        const fullName = entry.courseName.replace(/\s+/g, " ").trim();
        const chart = shortClearName(entry.courseName);
        const mods = entry.mods.filter((mod) => SHOWN_MODS.has(mod));
        const clearedOn = entry.playedAt
          ? formatDateTime(new Date(entry.playedAt), intlLocaleTag(locale), { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
          : null;
        return {
          key: entry.user.id,
          rank: entry.rank,
          user: entry.user,
          // A response cached from before the board carried the run has no
          // score to open; those rows keep opening the profile.
          onOpen: entry.score ? () => setOpenScore(buildCourseClearScore(entry.score!, servedKeys, entry.user)) : undefined,
          value: (
            <span className="inline-flex items-center justify-end gap-2 sm:gap-2.5">
              <span
                className="text-sm font-semibold tabular-nums text-white"
                title={entry.currency === "v2" ? t`ScoreV2 accuracy` : undefined}
              >
                {formatAccuracy(entry.accuracy)}
              </span>
              <span className="flex min-w-9 justify-end sm:min-w-12">
                <DanLevelBadge
                  label={entry.label}
                  keyCount={servedKeys}
                  side={servedSide}
                  size="sm"
                  approximate={false}
                  formatLabel={formatDanLabel}
                />
              </span>
            </span>
          ),
          detail: (
            <span className="flex min-w-0 items-center gap-2 sm:justify-end" title={fullName}>
              <span className="truncate">{chart}</span>
              {mods.length > 0 && (
                <>
                  <span aria-hidden="true" className="h-3 w-px flex-shrink-0 bg-osu-b3/60" />
                  <span className="flex-shrink-0 font-semibold text-osu-l1">
                    {mods.join("")}
                    {/* A lazer custom speed: plain DT reads as 1.5x. Same format as the mod badges. */}
                    {entry.modRate != null && mods.some((mod) => mod === "DT" || mod === "NC") ? ` ${entry.modRate.toFixed(2)}×` : null}
                  </span>
                </>
              )}
              {clearedOn && (
                <>
                  <span aria-hidden="true" className="hidden h-3 w-px flex-shrink-0 bg-osu-b3/60 sm:block" />
                  <span className="hidden flex-shrink-0 tabular-nums sm:inline">{clearedOn}</span>
                </>
              )}
            </span>
          ),
        };
      });
  }, [snapshot, hiddenUserIds, servedKeys, servedSide, locale, t]);

  const totalPages = Math.max(1, Math.ceil((snapshot?.total ?? 0) / LEADERBOARD_PAGE_SIZE));
  const sideOptions: Array<{ value: DanSide; label: string }> = [
    { value: "rc", label: t`Regular` },
    { value: "ln" as const, label: t`LN` },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <KeymodeControl
          id="clear-leaderboard-keys"
          value={keys}
          keyCounts={DAN_LEADERBOARD_KEY_COUNTS}
          onChange={(next) => onNavigate({ keys: next, skillset: undefined, page: 1 })}
        />
        <div role="group" aria-label={t`Dan course`}>
          <SegmentedControl
            id="clear-leaderboard-side"
            value={side}
            options={sideOptions}
            onChange={(next) => onNavigate({ side: next, skillset: undefined, page: 1 })}
          />
        </div>
        <Link
          to="/dan-estimates"
          aria-label={t`How dans are estimated`}
          title={t`How dans are estimated`}
          className="ml-auto text-osu-f1/60 transition-colors hover:text-white"
        >
          <CircleHelp size={14} />
        </Link>
      </div>

      {/* The slot keeps its height across a keymode change, like the dan
          board's picker. 6K has no practice charts, so it has no row at all. */}
      <div className={keys === 6 ? undefined : "min-h-6"} aria-busy={staleLadder}>
        <DanSkillsetPicker
          skillsets={snapshot?.skillsets ?? []}
          value={requestedSkillset}
          onChange={(next) => onNavigate({ skillset: next === DEFAULT_CLEAR_SKILLSET ? undefined : next, page: 1 })}
          disabled={staleLadder}
          lead={{ skillset: DEFAULT_CLEAR_SKILLSET, label: t`Courses` }}
          countTitle={(players) => t`${formatNumber(players)} players with a clear`}
        />
      </div>

      <LeaderboardTable
        rows={rows}
        loading={loading}
        error={error}
        emptyMessage={
          courses
            ? <Trans>Nobody here has a verified course clear yet.</Trans>
            : <Trans>Nobody here has a verified {skillsetLabel} clear yet.</Trans>
        }
        valueHeader={t({ message: "Clear", context: "a dan course pass" })}
        detailHeader={courses ? t`Course` : t`Chart`}
        wideDetail
      />

      {totalPages > 1 && (
        <Pagination
          page={page - 1}
          totalPages={totalPages}
          onPageChange={(next) => onNavigate({ page: next + 1 })}
        />
      )}

      {openScore ? <ScoreDetailModal score={openScore} onClose={() => setOpenScore(null)} /> : null}
    </div>
  );
}
