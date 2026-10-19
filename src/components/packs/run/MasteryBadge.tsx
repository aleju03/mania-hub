import { useLingui } from "@lingui/react/macro";
import { masteryLevel, masteryNextAt } from "#/lib/pack-run";

/* Bronze, silver, gold, then the prismatic sweep from the seventh level on. */
function masteryFill(level: number): string {
  if (level >= 7) return "conic-gradient(from 30deg, #ff6b8b, #ffd36b, #6be0a0, #6bc5ff, #c58cff, #ff6b8b)";
  if (level >= 5) return "linear-gradient(135deg, #fff1b8, #e8b33a 55%, #a8741a)";
  if (level >= 3) return "linear-gradient(135deg, #ffffff, #b9c3d1 55%, #7d8796)";
  return "linear-gradient(135deg, #f3c39a, #b8743f 55%, #7a4520)";
}

/* A card's mastery: a level for every doubling of the copies a collector has
   held of it (recycled ones included), drawn as a small cut gem in the
   card's bottom-left corner. Nothing below the first level. */
export function MasteryBadge({ copies }: { copies: number }) {
  const { t } = useLingui();
  const level = masteryLevel(copies);
  if (level <= 0) return null;
  const next = masteryNextAt(level);
  return (
    <span
      className="absolute bottom-1.5 left-1.5 z-[6] grid h-[22px] w-[22px] place-items-center"
      title={t`Mastery ${level}: ${copies} copies held, next at ${next}`}
    >
      <span
        aria-hidden="true"
        className="absolute inset-[3px] rotate-45 rounded-[4px] shadow-[0_1px_3px_rgba(0,0,0,0.6)]"
        style={{ background: masteryFill(level) }}
      />
      <span className="relative text-[11px] font-black leading-none text-black/80 tabular-nums">{level}</span>
    </span>
  );
}
