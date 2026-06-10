import { Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { CountryFlag } from "../ui/CountryFlag";
import type { RevealedCard } from "./RevealStage";

interface PackSummaryProps {
  cards: RevealedCard[];
  onOpenAnother: () => void;
  reducedMotion: boolean;
}

export function PackSummary({ cards, onOpenAnother, reducedMotion }: PackSummaryProps) {
  const bestRank = Math.min(...cards.map((card) => card.player.globalRank));

  return (
    <div className="flex flex-col items-center">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-f1">your pulls</div>

      <div className="mt-5 flex flex-wrap items-start justify-center gap-4 sm:gap-5">
        {cards.map((card, position) => {
          const isBest = card.player.globalRank === bestRank;
          const glow = card.glowColor
            ? `rgba(${card.glowColor.r}, ${card.glowColor.g}, ${card.glowColor.b}, 0.55)`
            : "rgba(148, 163, 184, 0.35)";
          const tierColor = card.glowColor
            ? `rgb(${card.glowColor.r}, ${card.glowColor.g}, ${card.glowColor.b})`
            : "rgb(226, 232, 240)";
          return (
            <motion.div
              key={`${card.player.user.id}-${position}`}
              className="w-[128px] sm:w-[148px]"
              initial={reducedMotion ? false : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: reducedMotion ? 0 : position * 0.07 }}
            >
              <Link
                to="/player/$username"
                params={{ username: card.player.user.username }}
                className="block"
                aria-label={`Open ${card.player.user.username}'s profile`}
              >
                <div
                  className="overflow-hidden rounded-[10px] transition-transform duration-150 hover:-translate-y-1"
                  style={{
                    aspectRatio: "5 / 7",
                    boxShadow: isBest ? `0 0 0 2px ${tierColor}, 0 10px 34px ${glow}` : `0 10px 26px rgba(0,0,0,0.45)`,
                  }}
                >
                  {card.thumbnail ? (
                    <img
                      src={card.thumbnail}
                      alt={`${card.player.user.username} maniacard`}
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <div className="grid h-full w-full place-items-center bg-osu-b4/70 px-3 text-center">
                      <span className="text-[12px] font-semibold text-white">{card.player.user.username}</span>
                    </div>
                  )}
                </div>
              </Link>
              <div className="mt-2 text-center">
                <div className="flex items-center justify-center gap-1.5">
                  <CountryFlag code={card.player.user.country_code} size="xs" decorative />
                  <span className="truncate text-[13px] font-bold text-white">{card.player.user.username}</span>
                </div>
                <div className="mt-0.5 flex items-center justify-center gap-1.5 text-[11px]">
                  {card.tierLabel && (
                    <span className="font-bold uppercase tracking-wide" style={{ color: tierColor }}>
                      {card.tierLabel}
                    </span>
                  )}
                  <span className="text-osu-f1 tabular-nums">#{card.player.globalRank.toLocaleString()}</span>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onOpenAnother}
        className="mt-8 rounded-full bg-osu-pink px-7 py-2.5 text-sm font-bold text-white hover:brightness-110 transition cursor-pointer"
      >
        Open another pack
      </button>
      <div className="mt-3 text-[11px] text-osu-f1">Cards are not saved yet. Screenshot the good ones.</div>
    </div>
  );
}
