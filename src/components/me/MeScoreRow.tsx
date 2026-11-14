import { Check, Trash2 } from "lucide-react";

import { GradeImg } from "../ui/GradeImg";
import { ModBadge } from "../ui/ModBadge";
import { formatAccuracy, formatPP, formatTimeAgo, formatTimeAgoTooltip } from "../../lib/format";
import { getDisplayedAccuracy, getDisplayedRank, getModDisplayList, getScoreTimestamp } from "../../lib/score";
import type { LeanTrackerScore } from "../../lib/types";
import { useLingui } from "@lingui/react/macro";
import { useLocale } from "../../lib/locale-context";

export type MyDataScoreRow = LeanTrackerScore & { archived?: boolean; archivedExact?: boolean };

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
export function MeScoreRow({
  score,
  isNew,
  ppGain,
  selected,
  onToggleSelected,
  onOpen,
  onPrefetch,
}: {
  score: MyDataScoreRow;
  isNew?: boolean;
  ppGain?: number;
  /** Given when the viewer may remove this play; the trash button picks it. */
  selected?: boolean;
  onToggleSelected?: () => void;
  /** Opens the map's details; the row is a button when given. */
  onOpen?: () => void;
  onPrefetch?: () => void;
}) {
  const locale = useLocale();
  const acc = getDisplayedAccuracy(score);
  const beatmapUrl = score.beatmap?.url ?? (score.beatmap?.id ? `https://osu.ppy.sh/beatmaps/${score.beatmap.id}` : undefined);
  const keys = keymodeLabel(score);
  const mods = getModDisplayList(score.mods);
  const cover = coverThumb(score);
  const showExactStats = !score.archived || score.archivedExact;

  const { t } = useLingui();
  const removable = onToggleSelected != null;
  const Body = onOpen ? "button" : "div";
  return (
    <div
      className={`group flex items-center gap-2 rounded-xl border px-2 py-2 transition-colors sm:gap-3 sm:px-3${
        selected
          ? " border-osu-red-light/40 bg-osu-red-light/10"
          : " border-transparent bg-osu-b4/55 hover:border-osu-b3/30 hover:bg-osu-b4"
      }${isNew ? " score-enter" : ""}`}
    >
      {/* The remove control sits outside the button: one button cannot nest in another. */}
      <Body
        {...(onOpen
          ? { type: "button" as const, onClick: onOpen, onPointerEnter: onPrefetch, onFocus: onPrefetch, title: t`View map details` }
          : {})}
        className={`flex min-w-0 flex-1 items-center gap-2 text-left sm:gap-3${onOpen ? " cursor-pointer" : ""}`}
      >
      <div className="relative h-10 w-16 shrink-0 overflow-hidden rounded-md bg-osu-b3/35 sm:h-12 sm:w-20">
        {cover ? <img src={cover} alt="" className="h-full w-full object-cover" loading="lazy" /> : null}
        <div className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/[0.06]" />
        {score.archived && !score.archivedExact ? (
          <span className="absolute left-1 top-1 rounded bg-osu-b5/80 px-1 py-0.5 text-[9px] font-bold uppercase text-osu-l2">{t`old`}</span>
        ) : (
          <span className="absolute left-1 top-1">
            <GradeImg grade={getDisplayedRank(score)} size={22} />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {onOpen ? (
            <span className="min-w-0 truncate text-xs font-semibold text-white sm:text-sm">
              {score.beatmapset?.title ?? t`Unknown map`}
            </span>
          ) : (
            <a
              href={beatmapUrl}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 truncate text-xs font-semibold text-white hover:text-osu-pink-light sm:text-sm"
              title={`${score.beatmapset?.artist ?? ""} - ${score.beatmapset?.title ?? ""}`}
            >
              {score.beatmapset?.title ?? t`Unknown map`}
            </a>
          )}
          <span className="hidden min-w-0 shrink-[3] truncate text-[10px] text-osu-f1 md:inline">[{score.beatmap?.version}]</span>
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] text-osu-f1 sm:text-[10px]">
          {score.beatmapset?.artist ? <span className="max-w-44 truncate">{score.beatmapset.artist}</span> : null}
          {keys ? <span className="rounded bg-osu-b3/35 px-1 py-0.5 font-bold text-osu-yellow">{keys}</span> : null}
          {score.archived && mods.length === 0 ? (
            <span>{score.archivedExact ? t`archived` : t`archived summary`}</span>
          ) : mods.length > 0 ? (
            <span className="flex items-center gap-0.5">
              {mods.map((m) => <ModBadge key={m.acronym} mod={m.acronym} rate={m.rate} size={0.7} />)}
            </span>
          ) : null}
          <span title={formatTimeAgoTooltip(getScoreTimestamp(score), locale)}>
            {formatTimeAgo(getScoreTimestamp(score), locale)}
          </span>
        </div>
      </div>
      {showExactStats ? (
        <div className="hidden w-12 shrink-0 text-right sm:block">
          <div className={`text-xs font-semibold tabular-nums ${accColor(acc)}`}>{formatAccuracy(acc)}</div>
          <div className="mt-0.5 text-[8px] uppercase tracking-wide text-osu-f1">{t`accuracy`}</div>
        </div>
      ) : null}
      <div className="w-16 shrink-0 text-right sm:w-[72px]">
        {showExactStats ? (
          <>
            <div className="text-base font-black leading-none tabular-nums text-osu-pink-light sm:text-lg">{formatPP(score.pp)}</div>
            {ppGain != null && ppGain >= 1 ? (
              <div className="mt-1 text-[10px] font-semibold tabular-nums text-osu-green">+{Math.round(ppGain)}</div>
            ) : null}
          </>
        ) : (
          <div className="text-[11px] font-semibold text-osu-f1">{t`archived`}</div>
        )}
      </div>
      </Body>
      {removable ? (
        <button
          type="button"
          aria-pressed={!!selected}
          aria-label={t`Remove play`}
          onClick={onToggleSelected}
          className={`-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-[opacity,colors] cursor-pointer ${
            selected
              ? "bg-osu-red-light text-osu-b5"
              : "text-osu-f1 opacity-70 hover:bg-osu-red-light/15 hover:text-osu-red-light hover:opacity-100 group-hover:opacity-100"
          }`}
        >
          {selected ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : <Trash2 className="h-4 w-4" />}
        </button>
      ) : null}
    </div>
  );
}
