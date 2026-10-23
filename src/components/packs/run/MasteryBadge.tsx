import { useLingui } from "@lingui/react/macro";
import { masteryLevel, masteryNextAt } from "#/lib/pack-run";
import { masteryRecycleBonusPercent } from "#/lib/pack-collection";

/* Bronze, silver, gold, then the prismatic sweep from the seventh level on. */
function masteryFill(level: number): string {
  if (level >= 7) return "conic-gradient(from 30deg, #ff6b8b, #ffd36b, #6be0a0, #6bc5ff, #c58cff, #ff6b8b)";
  if (level >= 5) return "linear-gradient(135deg, #fff1b8, #e8b33a 55%, #a8741a)";
  if (level >= 3) return "linear-gradient(135deg, #ffffff, #b9c3d1 55%, #7d8796)";
  return "linear-gradient(135deg, #f3c39a, #b8743f 55%, #7a4520)";
}

/* The rim a mastered card wears, in the gem's metal: a hairline at the first
   levels, a soft glow from gold on, and the prismatic sweep from the seventh.
   Drawn over the art's edge, under the gem and the copy count. */
function masteryRim(level: number): { background?: string; boxShadow: string; padding?: string } {
  if (level >= 7) return { background: masteryFill(level), padding: "2px", boxShadow: "0 0 14px rgba(197,140,255,0.45)" };
  if (level >= 5) return { boxShadow: "inset 0 0 0 1.5px rgba(232,179,58,0.95), 0 0 12px rgba(232,179,58,0.4)" };
  if (level >= 3) return { boxShadow: "inset 0 0 0 1.5px rgba(205,214,226,0.9), 0 0 6px rgba(205,214,226,0.25)" };
  return { boxShadow: "inset 0 0 0 1px rgba(214,140,82,0.85)" };
}

export function MasteryRim({ copies }: { copies: number }) {
  const level = masteryLevel(copies);
  if (level <= 0) return null;
  const rim = masteryRim(level);
  // The prismatic rim is a gradient border: the fill shows only in the
  // padding ring, the art keeps the middle.
  const ring = rim.background
    ? {
        WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
        WebkitMaskComposite: "xor",
        mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
        maskComposite: "exclude",
      }
    : {};
  return <span aria-hidden="true" className="pointer-events-none absolute inset-0 z-[5] rounded-[10px]" style={{ ...rim, ...ring }} />;
}

/* A card's mastery: a level for every doubling of the copies a collector has
   held of it (recycled ones included), drawn as a small cut gem in the
   card's bottom-left corner. Nothing below the first level. */
export function MasteryBadge({ copies }: { copies: number }) {
  const { t } = useLingui();
  const level = masteryLevel(copies);
  if (level <= 0) return null;
  const next = masteryNextAt(level);
  const bonus = masteryRecycleBonusPercent(copies);
  return (
    <span
      className="absolute bottom-1.5 left-1.5 z-[6] grid h-[22px] w-[22px] place-items-center"
      title={t`Mastery ${level}: ${copies} copies held, next at ${next}. Spares recycle for +${bonus}%.`}
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

/* The card spotlight's line: the gem inline, the level, how far it has come,
   and for the holder's own card what it earns at the recycler. */
export function MasteryLine({ copies, own }: { copies: number; own: boolean }) {
  const { t } = useLingui();
  const level = masteryLevel(copies);
  if (level <= 0) return null;
  const next = masteryNextAt(level);
  const bonus = masteryRecycleBonusPercent(copies);
  return (
    <div className="mt-1 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-[12px] text-osu-f1">
      <span className="inline-flex items-center gap-1.5 font-semibold text-white">
        <span className="relative grid h-4 w-4 place-items-center" aria-hidden="true">
          <span className="absolute inset-[2px] rotate-45 rounded-[3px]" style={{ background: masteryFill(level) }} />
        </span>
        {t`Mastery ${level}`}
      </span>
      <span className="h-3 w-px bg-white/15" aria-hidden="true" />
      <span className="tabular-nums">{t`${copies} copies held, next level at ${next}`}</span>
      {own && bonus > 0 ? <>
        <span className="h-3 w-px bg-white/15" aria-hidden="true" />
        <span className="tabular-nums">{t`Spares recycle for +${bonus}%`}</span>
      </> : null}
    </div>
  );
}
