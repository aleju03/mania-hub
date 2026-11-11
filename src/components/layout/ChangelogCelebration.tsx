import { CompanionFigure } from "#/components/supporter/Companion";
import type { ChangelogCelebration as Celebration } from "#/data/changelog";
import { builtInCompanion } from "#/lib/supporter-companions";

const TETO = builtInCompanion("plush-teto");

/* Loaded with the modal's first celebration only, so the 3D mascot code stays
   out of the page until then. Both Tetos turn the same way, in step. */
export default function ChangelogCelebration({ celebration }: { celebration: Celebration }) {
  const mascot = (spin: number) =>
    TETO ? (
      <div className="relative h-24 w-16 shrink-0 sm:h-32 sm:w-24">
        <CompanionFigure companion={{ builtIn: TETO }} spin={spin} />
      </div>
    ) : null;
  const at = celebration.title.indexOf(celebration.asideAfter);
  const cut = at < 0 ? celebration.title.length : at + celebration.asideAfter.length;
  return (
    <div className="mb-6 flex items-center justify-center gap-1 sm:gap-4">
      {mascot(1.4)}
      <div className="min-w-0 text-center">
        <p className="text-[20px] font-extrabold leading-tight tracking-[0.02em] text-white sm:text-[28px]">
          {celebration.title.slice(0, at < 0 ? cut : at)}
          {/* Raised over the number's top right like an exponent, taking no
              room in the line. */}
          <span className="relative inline-block">
            {at < 0 ? null : celebration.asideAfter}
            <span className="sr-only"> </span>
            <span className="absolute bottom-[78%] left-[88%] whitespace-nowrap text-[11px] font-semibold tracking-normal text-osu-c2/70 sm:text-[13px]">
              ({celebration.aside})
            </span>
          </span>
          {celebration.title.slice(cut)}
        </p>
        <p className="mt-1.5 text-[14.5px] text-osu-c2/90">{celebration.line}</p>
      </div>
      {mascot(1.4)}
    </div>
  );
}
