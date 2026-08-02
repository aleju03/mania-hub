import { GradeImg } from "../ui/GradeImg";
import { ModBadge } from "../ui/ModBadge";
import { formatAccuracy, formatPP, formatTimeAgo, formatTimeAgoTooltip } from "../../lib/format";
import { getDisplayedAccuracy, getDisplayedRank, getModDisplayList, getScoreTimestamp } from "../../lib/score";
import type { LeanTrackerScore } from "../../lib/types";

type MyDataScoreRow = LeanTrackerScore & { archived?: boolean; archivedExact?: boolean };

function keymodeLabel(score: MyDataScoreRow): string | null {
  const cs = score.beatmap?.cs;
  if (cs == null) return null;
  return `${Math.round(cs)}K`;
}

function accColor(acc: number): string {
  if (acc >= 0.99) return "text-osu-yellow";
  if (acc >= 0.97) return "text-osu-green";
  if (acc >= 0.94) return "text-osu-l1";
  return "text-osu-f1";
}

function coverThumb(score: MyDataScoreRow): string | null {
  const covers = score.beatmapset?.covers;
  if (covers?.list) return covers.list;
  if (covers?.cover) return covers.cover;
  const setId = score.beatmapset?.id ?? score.beatmap?.beatmapset_id;
  return setId ? `https://assets.ppy.sh/beatmaps/${setId}/covers/list.jpg` : null;
}

// One of the player's own tracked plays, styled like a tracker feed row but compact (no avatar,
// since every row is the same player). Used for the My Data recent-plays feed.
export function MeScoreRow({ score, isNew, ppGain }: { score: MyDataScoreRow; isNew?: boolean; ppGain?: number }) {
  const acc = getDisplayedAccuracy(score);
  const beatmapUrl = score.beatmap?.url ?? (score.beatmap?.id ? `https://osu.ppy.sh/beatmaps/${score.beatmap.id}` : undefined);
  const keys = keymodeLabel(score);
  const mods = getModDisplayList(score.mods);
  const cover = coverThumb(score);
  const showExactStats = !score.archived || score.archivedExact;

  return (
    <div className={`flex items-center gap-2.5 rounded-lg border border-osu-b3/20 bg-osu-b4 py-2 pl-2 pr-2.5 transition-colors hover:bg-osu-b3/40${isNew ? " score-enter" : ""}`}>
      <div className="relative h-9 w-[52px] shrink-0 overflow-hidden rounded bg-osu-b3/40">
        {cover ? <img src={cover} alt="" className="h-full w-full object-cover" loading="lazy" /> : null}
        {score.archived && !score.archivedExact ? (
          <span className="absolute left-0.5 top-0.5 rounded bg-osu-b5/80 px-1 py-0.5 text-[7px] font-bold uppercase text-osu-l2">old</span>
        ) : (
          <span className="absolute left-0.5 top-0.5">
            <GradeImg grade={getDisplayedRank(score)} size={18} />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <a
            href={beatmapUrl}
            target="_blank"
            rel="noreferrer"
            className="truncate text-[12px] font-semibold text-white hover:text-osu-pink-light"
            title={`${score.beatmapset?.artist ?? ""} - ${score.beatmapset?.title ?? ""}`}
          >
            {score.beatmapset?.title ?? "Unknown map"}
          </a>
          <span className="min-w-[5ch] shrink-[3] truncate text-[10px] text-osu-f1">[{score.beatmap?.version}]</span>
          {keys ? <span className="shrink-0 rounded bg-osu-b3/50 px-1 py-0.5 text-[8px] font-bold text-osu-yellow">{keys}</span> : null}
        </div>
        <div className="mt-0.5 flex min-h-[13px] flex-wrap items-center gap-0.5">
          {score.archived && mods.length === 0 ? (
            <span className="text-[9px] text-osu-f1/70">{score.archivedExact ? "archived" : "archived summary"}</span>
          ) : mods.length > 0 ? (
            mods.map((m) => <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} size={0.55} />)
          ) : (
            <span className="text-[9px] text-osu-f1/70">nomod</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <div className="flex items-center gap-2">
          {showExactStats ? <span className={`text-[11px] tabular-nums ${accColor(acc)}`}>{formatAccuracy(acc)}</span> : null}
          <span className="text-[13px] font-bold tabular-nums text-white">{showExactStats ? formatPP(score.pp) : "archived"}</span>
          {ppGain != null && ppGain >= 1 ? <span className="text-[10px] font-semibold tabular-nums text-osu-green">+{Math.round(ppGain)}</span> : null}
        </div>
        <span className="text-[9px] text-osu-f1" title={formatTimeAgoTooltip(getScoreTimestamp(score))}>
          {formatTimeAgo(getScoreTimestamp(score))}
        </span>
      </div>
    </div>
  );
}
