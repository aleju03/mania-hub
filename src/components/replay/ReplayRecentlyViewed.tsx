import { motion } from "framer-motion";
import { X } from "lucide-react";

import { GradeImg } from "#/components/ui/GradeImg";
import { ModBadge } from "#/components/ui/ModBadge";
import { formatAccuracy, formatPP, formatTimeAgo } from "#/lib/format";
import type { RecentReplayEntry } from "#/lib/replay-recent";

export function ReplayRecentlyViewed({
  entries,
  onOpen,
  onRemove,
  onClear,
  variant = "grid",
  className = "",
}: {
  entries: RecentReplayEntry[];
  onOpen: (entry: RecentReplayEntry) => void;
  onRemove: (key: string) => void;
  onClear: () => void;
  /** "sidebar" stacks the cards in one narrow column beside other content. */
  variant?: "grid" | "sidebar";
  className?: string;
}) {
  if (entries.length === 0) return null;

  const sidebar = variant === "sidebar";

  return (
    <div className={`${sidebar ? "w-full" : "max-w-5xl mx-auto"} ${className}`}>
      <div className={`relative mb-3 flex items-center ${sidebar ? "justify-between gap-3" : "justify-center"}`}>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-osu-f1">
          Recently Watched
        </h4>
        <button
          type="button"
          onClick={onClear}
          className={`rounded-lg px-2 py-1 text-[11px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:bg-osu-b4 hover:text-white ${sidebar ? "-mr-2" : "absolute right-0"}`}
        >
          Clear
        </button>
      </div>

      <div
        className={sidebar
          ? "replay-score-scroll flex max-h-[440px] flex-col gap-2 overflow-y-auto overscroll-contain"
          : "grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"}
      >
        {entries.map((entry, index) => {
          // "[Insane] 7K // player", with whatever parts an entry actually has.
          const chart = [entry.version ? `[${entry.version}]` : null, entry.keyCount ? `${entry.keyCount}K` : null]
            .filter(Boolean)
            .join(" ");

          return (
            <motion.div
              key={entry.key}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.02 }}
              className="group relative overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4"
            >
              {entry.coverUrl && (
                <img
                  src={entry.coverUrl}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover opacity-[0.12]"
                  loading="lazy"
                />
              )}

              <button
                type="button"
                onClick={() => onOpen(entry)}
                className="relative flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors cursor-pointer hover:bg-osu-b3/50 focus:outline-none focus-visible:bg-osu-b3/50"
              >
                {entry.grade ? (
                  <GradeImg grade={entry.grade} size={22} />
                ) : (
                  // Uploaded .osr files have no ranked grade to show.
                  <span className="rounded bg-osu-b5/70 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-osu-f1">
                    osr
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-white">{entry.title}</div>
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="truncate text-[10px] text-osu-f1">
                      {chart ? `${chart} // ` : ""}{entry.playerName}
                    </div>
                    {!sidebar && entry.mods && entry.mods.length > 0 && (
                      <div className="hidden shrink-0 gap-0.5 sm:flex">
                        {entry.mods.map((mod, modIndex) => (
                          <ModBadge key={`${mod.acronym}-${modIndex}`} mod={mod.acronym} rate={mod.rate} size={0.7} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="shrink-0 pr-5 text-right">
                  {entry.accuracy != null && (
                    <div className="text-[11px] font-semibold text-osu-l2">{formatAccuracy(entry.accuracy)}</div>
                  )}
                  {entry.pp != null && (
                    <div className="text-xs font-bold text-white">{formatPP(entry.pp)}</div>
                  )}
                  <div className="text-[10px] text-osu-f1">{formatTimeAgo(new Date(entry.viewedAt).toISOString())}</div>
                </div>
              </button>

              {/* Touch has no hover to reveal on, so the remove button stays
                  visible below sm and only fades in on pointer devices. */}
              <button
                type="button"
                onClick={() => onRemove(entry.key)}
                aria-label={`Remove ${entry.title} from recently watched`}
                className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-osu-f1 transition-[opacity,color,background-color] cursor-pointer hover:bg-osu-b3 hover:text-white focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
