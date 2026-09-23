/* Pieces of the player profile page that the team page draws the same way:
   the hero and rail stats, the insight panel cells and the skeletons. */

import type { ReactNode } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { GradeImg } from "../ui/GradeImg";
import { ModBadge } from "../ui/ModBadge";
import { Skeleton } from "../ui/LoadingSkeleton";
import { formatDate, formatTimeAgo } from "../../lib/format";
import { useLocale } from "../../lib/locale-context";
import { useViewerTimeZone } from "../../lib/use-viewer-time-zone";
import type { InsightScoreSnapshot, UserProfileInsights } from "../../lib/types";

export function RailStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-osu-f1">{label}</div>
      <div className="mt-1.5 text-[19px] font-bold leading-none tabular-nums text-white">{value}</div>
    </div>
  );
}

// A headline figure inside the hero, sitting over the cover art.
export function HeroStat({
  label,
  value,
  valueClassName = "text-white",
  sub,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string;
  sub?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-white/40">{label}</div>
      <div className={`mt-2 text-[26px] font-black leading-none tabular-nums sm:text-[34px] ${valueClassName}`}>
        {value}
      </div>
      <div className="mt-2 min-h-[13px] text-[10px] leading-none text-white/45">{sub}</div>
    </div>
  );
}

// The insight cells live in one panel: 1px gaps let the parent colour through
// as hairlines, so four readings read as a single object instead of four boxes.
export const INSIGHT_PANEL_CLASS = "grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-osu-b3/30 lg:grid-cols-4";
export const INSIGHT_CELL_CLASS = "flex min-h-[108px] flex-col bg-osu-b4 p-4";
export const INSIGHT_CELL_INTERACTIVE_CLASS = "cursor-pointer transition-colors duration-150 hover:bg-osu-b3/40";
export const INSIGHT_LABEL_CLASS = "text-[9px] font-semibold uppercase tracking-[0.18em] text-osu-f1";

// Fixed hues only: osu-pink is derived from --theme-hue, so on a blue or
// purple theme it collapsed onto 4K's blue or 6K's purple. Keymode identity
// has to read the same under every theme, and 4K/7K (the pair that almost
// always appears together) get complementary ends of the range.
// The two-stage keymodes (12K up) take the other shade of the keymode each one
// doubles, so 18K reads as 9K's deeper red and nothing above 10K falls back to
// a colourless bar. 10K already worked this way against 5K.
export const KEYMODE_BAR_COLORS: Record<number, string> = { 4: "bg-osu-blue", 5: "bg-osu-green-light", 6: "bg-osu-purple-light", 7: "bg-osu-orange", 8: "bg-osu-yellow", 9: "bg-osu-red-light", 10: "bg-osu-green", 12: "bg-osu-purple", 14: "bg-osu-orange-dark", 16: "bg-osu-yellow-light", 18: "bg-osu-red" };
export const KEYMODE_TEXT_COLORS: Record<number, string> = { 4: "text-osu-blue", 5: "text-osu-green-light", 6: "text-osu-purple-light", 7: "text-osu-orange", 8: "text-osu-yellow", 9: "text-osu-red-light", 10: "text-osu-green-light", 12: "text-osu-purple", 14: "text-osu-orange-dark", 16: "text-osu-yellow-light", 18: "text-osu-red" };

export function KeySplitCard({ keySplit, sampleSize, onOpen, onPrefetch }: { keySplit: UserProfileInsights["keySplit"]; sampleSize: number; onOpen?: () => void; onPrefetch?: () => void }) {
  const { t } = useLingui();
  const colors = KEYMODE_BAR_COLORS;
  const textColors = KEYMODE_TEXT_COLORS;
  // keySplit stays in keymode order, so the dominant share has to be found.
  const dominantCount = keySplit.reduce((top, entry) => Math.max(top, entry.count), 0);

  return (
    <button
      type="button"
      className={`${INSIGHT_CELL_CLASS} group w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-osu-pink/50 ${onOpen ? INSIGHT_CELL_INTERACTIVE_CLASS : "cursor-default"}`}
      onClick={onOpen}
      // Hovering or tabbing to the card is the earliest honest signal that the
      // totals are about to be read, and it buys the fetch a head start.
      onPointerEnter={onPrefetch}
      onFocus={onPrefetch}
      disabled={!onOpen}
    >
      <div className="flex items-center justify-between">
        <div className={INSIGHT_LABEL_CLASS}>{t`Key Split`}</div>
        {onOpen && <ExpandHint />}
      </div>
      {keySplit.length === 0 ? (
        <div className="mt-2 text-sm text-osu-f1">{t`No key data`}</div>
      ) : keySplit.length === 1 ? (
        // A single keymode carries no split to show, so the keymode itself is
        // the reading.
        <div className={`mt-2 text-[26px] font-black leading-none ${textColors[keySplit[0].keyCount] ?? "text-white"}`}>
          <Trans>{keySplit[0].keyCount}K only</Trans>
        </div>
      ) : (
        <>
          {/* The keymode someone actually plays gets the big number; the rest
              stay legible without competing with it. */}
          <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {keySplit.map((b) => (
              <div key={b.keyCount} className="flex items-baseline gap-1">
                <span
                  className={`font-black leading-none tabular-nums ${b.count === dominantCount ? "text-[26px]" : "text-[17px]"} ${textColors[b.keyCount] ?? "text-white"}`}
                >
                  {Math.round((b.count / sampleSize) * 100)}
                  <span className="text-[13px]">%</span>
                </span>
                <span className={`text-[11px] font-bold ${textColors[b.keyCount] ?? "text-osu-f1"}`}>{b.keyCount}K</span>
              </div>
            ))}
          </div>
          <div className="mt-auto w-full pt-3">
            <div className="flex h-1 overflow-hidden rounded-full bg-osu-b3/50">
              {keySplit.map((b) => (
                <div
                  key={b.keyCount}
                  className={`${colors[b.keyCount] ?? "bg-osu-b1"} transition-all duration-300`}
                  style={{ width: `${(b.count / sampleSize) * 100}%` }}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </button>
  );
}

export function ExpandHint() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-osu-f1/30 group-hover:text-osu-f1 group-hover:translate-x-0.5 transition-all duration-150 flex-shrink-0"
      aria-hidden
    >
      <path d="M3.5 2 6.5 5 3.5 8" />
    </svg>
  );
}

export function TopPlayCard({ label, snapshot }: { label: string; snapshot: InsightScoreSnapshot | null }) {
  const locale = useLocale();
  const { t } = useLingui();
  const viewerTimeZone = useViewerTimeZone();
  if (!snapshot) {
    return (
      <div className="h-[120px] rounded-xl bg-osu-b4 p-4">
        <div className={INSIGHT_LABEL_CLASS}>{label}</div>
        <div className="mt-2 text-sm text-osu-f1">{t`No data`}</div>
      </div>
    );
  }

  const href = snapshot.scoreUrl ?? snapshot.beatmapUrl;

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="group/topplay relative block h-[120px] overflow-hidden rounded-xl bg-osu-b4 ring-1 ring-inset ring-white/[0.06] transition duration-150 hover:ring-osu-pink/40"
    >
      {snapshot.coverUrl && (
        <img
          src={snapshot.coverUrl}
          alt=""
          className="absolute -inset-px h-[calc(100%+2px)] w-[calc(100%+2px)] max-w-none object-cover brightness-[0.38] transition-transform duration-500 group-hover/topplay:scale-[1.03]"
        />
      )}
      <div className="absolute -inset-px bg-gradient-to-r from-black/60 via-black/20 to-black/45" />
      <div className="relative flex h-full items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-white/45">{label}</div>
          <div className="mt-1.5 truncate text-[15px] font-bold text-white">{snapshot.title}</div>
          <div className="truncate text-[10px] text-white/55">{snapshot.artist} [{snapshot.version}]</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <GradeImg grade={snapshot.rank} size={18} />
            {snapshot.mods.map((mod) => (
              <ModBadge key={mod} mod={mod} />
            ))}
            {/* Relative to Date.now(): the newest top play is usually minutes old,
                so SSR and hydration routinely land on different sides of a minute
                boundary. Let the client text win. */}
            <span className="text-[10px] text-white/45" suppressHydrationWarning>{formatTimeAgo(snapshot.date, locale)}</span>
            {/* The viewer's own day, like the score page this links to. A play
                set at 20:28 in Costa Rica is 02:28 UTC the next morning, and
                the UTC day dated it one day after osu! did. No
                suppressHydrationWarning needed: useViewerTimeZone holds UTC
                through the hydration render and the real zone arrives on the
                next one, as a normal diff. */}
            {snapshot.date && (
              <span className="hidden text-[10px] text-white/45 sm:inline">
                {formatDate(snapshot.date, viewerTimeZone)}
              </span>
            )}
          </div>
        </div>
        {snapshot.pp != null && (
          <div className="flex-shrink-0 text-right">
            <div className="text-[28px] font-black leading-none tabular-nums text-osu-pink-light">{Math.round(snapshot.pp)}</div>
            <div className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">{t`pp`}</div>
          </div>
        )}
      </div>
    </a>
  );
}

export function InsightsSkeleton() {
  return (
    <div className="space-y-3">
      <div className={INSIGHT_PANEL_CLASS}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={INSIGHT_CELL_CLASS}>
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="mt-3 h-7 w-24" />
            <Skeleton className="mt-auto h-2.5 w-20" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-[120px] rounded-xl bg-osu-b4 p-4">
            <Skeleton className="h-2.5 w-24" />
            <Skeleton className="mt-3 h-4 w-40" />
            <Skeleton className="mt-2 h-3 w-32" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function PlayerScoreRowSkeleton() {
  return (
    <div className="flex items-center gap-3 py-2.5 px-3 rounded-lg bg-osu-b4/50 min-h-[63px]">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <Skeleton className="w-7 h-7 rounded-full flex-shrink-0" />
        <Skeleton className="w-12 h-8 rounded flex-shrink-0" />
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-64 max-w-[55%]" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-4 w-5 rounded" />
          </div>
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="flex gap-0.5 justify-end w-24">
          <Skeleton className="h-5 w-14 rounded" />
        </div>
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-4 w-10" />
        <Skeleton className="h-5 w-16" />
      </div>
    </div>
  );
}

/** The art a chart with no cover gets: the blurred generic header, turned to
 *  a hue and framed at a spot picked from its title, artist and difficulty,
 *  so two such charts do not read as the same map. */
