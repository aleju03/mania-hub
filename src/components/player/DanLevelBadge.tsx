import { useLingui } from "@lingui/react/macro";

import { danBareLabel, danTierColor, danTierSuffix, getDanImageSrc } from "../../lib/dan-images";

// One player dan level, drawn once so the profile's dan chips and the /rankings
// dan board can never render the same estimate two different ways.
//
// The course's own logo IS the level, same as the map dan badge; the tier
// suffix rides top-right like an exponent, colored by where inside the level
// the estimate sits. Keymodes with no artwork fall back to the text.
//
// Past the ladder's last level the estimator has nothing left to measure with,
// so the badge reads "> 9th" instead of dressing the ceiling up as a tier
// ("9++") the estimate never actually earned.
//
// An estimate whose averaging window is not full yet wears a ring in the
// badge's corner, filled to how much of it is there. That is the one thing the
// evidence window could say that the badge could not: a 20-clear average over
// six clears is a real reading of thin evidence, and a reader deserves to know
// which before opening anything. A full window draws nothing at all, so the
// mark only ever appears where it means something.

export type DanBadgeSize = "sm" | "md";

const IMAGE_CLASS: Record<DanBadgeSize, string> = {
  sm: "h-7 w-7",
  md: "h-9 w-9",
};

const SUFFIX_CLASS: Record<DanBadgeSize, string> = {
  sm: "text-[11px]",
  md: "text-[14px]",
};

const APPROX_CLASS: Record<DanBadgeSize, string> = {
  sm: "text-[11px]",
  md: "text-[12px]",
};

const RING_CLASS: Record<DanBadgeSize, string> = {
  sm: "h-3 w-3",
  md: "h-3.5 w-3.5",
};

/** How full the averaging window behind a dan is: `have` of `need` clears,
 *  and on a side headline how many of its skills have their whole window. */
export interface DanClearWindow {
  have: number;
  need: number;
  skills?: { full: number; total: number };
}

// r=5 in a 14 box leaves room for the 2.5 stroke.
const RING_RADIUS = 5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
// Arc units, not pixels: enough of a break that four segments read as four.
const RING_GAP = 2.4;

/**
 * A side's estimate is drawn as one segment per skill, filled for each skill
 * that has its whole window, because the clear sum alone cannot be read: a
 * player missing one skill entirely still stands at 75 of 80 clears, and an
 * arc that long is a full circle to the eye. Segments make the missing skill
 * the shape of the mark. A single pool (one skillset's own dan, or a keymode
 * that publishes none) has nothing to segment and fills smoothly instead.
 */
function ClearWindowRing({ clearWindow, size, title }: { clearWindow: DanClearWindow; size: DanBadgeSize; title: string }) {
  const skills = clearWindow.skills && clearWindow.skills.total > 1 ? clearWindow.skills : null;
  const segments = skills
    ? Array.from({ length: skills.total }, (_, index) => ({ index, filled: index < skills.full }))
    : null;
  const segmentArc = skills ? RING_CIRCUMFERENCE / skills.total : 0;
  const ratio = Math.max(0, Math.min(1, clearWindow.have / clearWindow.need));
  return (
    <span className={`absolute -bottom-0.5 -right-0.5 ${RING_CLASS[size]}`} title={title}>
      <svg viewBox="0 0 14 14" className="h-full w-full" role="img" aria-label={title}>
        <circle cx="7" cy="7" r="7" className="fill-osu-b6/85" />
        {segments ? (
          segments.map(({ index, filled }) => (
            <circle
              key={index}
              cx="7"
              cy="7"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="2.5"
              strokeDasharray={`${segmentArc - RING_GAP} ${RING_CIRCUMFERENCE - segmentArc + RING_GAP}`}
              strokeDashoffset={-(index * segmentArc + RING_GAP / 2)}
              transform="rotate(-90 7 7)"
              className={filled ? "stroke-osu-l1" : "stroke-osu-b2"}
            />
          ))
        ) : (
          <>
            <circle cx="7" cy="7" r={RING_RADIUS} fill="none" strokeWidth="2.5" className="stroke-osu-b2" />
            <circle
              cx="7"
              cy="7"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={`${RING_CIRCUMFERENCE * ratio} ${RING_CIRCUMFERENCE}`}
              transform="rotate(-90 7 7)"
              className="stroke-osu-l1"
            />
          </>
        )}
      </svg>
    </span>
  );
}

export function DanLevelBadge({
  label,
  keyCount,
  side,
  beyondTable = false,
  size = "md",
  clearWindow,
  formatLabel,
}: {
  label: string;
  keyCount: number;
  side: "rc" | "ln";
  beyondTable?: boolean;
  size?: DanBadgeSize;
  /** Absent on a stored verdict written before the window shipped and on one a
   *  course clear set, so nothing is drawn rather than a full ring guessed. */
  clearWindow?: DanClearWindow | null;
  /** Renders the level for humans ("8" -> "8th dan"); used for alt text. */
  formatLabel: (label: string) => string;
}) {
  const { t } = useLingui();
  const shown = beyondTable ? danBareLabel(label) : label;
  const image = getDanImageSrc(danBareLabel(shown), side === "ln" ? "ln" : undefined, keyCount);
  const suffix = beyondTable ? "" : danTierSuffix(shown);
  const approx = beyondTable ? ">" : "~";

  const partial = clearWindow != null && clearWindow.need > 0 && clearWindow.have < clearWindow.need;
  const windowHave = clearWindow?.have ?? 0;
  const windowNeed = clearWindow?.need ?? 0;
  // A side names the skills it is short of rather than a clear sum, since that
  // is what the ring draws and the sum on its own reads as nearly done.
  const windowSkills = clearWindow?.skills ?? null;
  const skillsFull = windowSkills?.full ?? 0;
  const skillsTotal = windowSkills?.total ?? 0;
  const perSkill = windowSkills && windowSkills.total > 0 ? Math.round(windowNeed / windowSkills.total) : windowNeed;
  const windowTitle = windowSkills && windowSkills.total > 1
    ? t`${skillsFull} of ${skillsTotal} skills have their full ${perSkill} clears, so the estimate is still filling in.`
    : t`Averaged over ${windowHave} of ${windowNeed} clears, so the estimate is still filling in.`;

  if (!image) {
    return (
      <span className="relative inline-flex items-center pr-2 text-[12px] font-bold text-osu-l1">
        {approx}{formatLabel(shown)}
        {partial ? <ClearWindowRing clearWindow={clearWindow!} size={size} title={windowTitle} /> : null}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-0.5">
      <span className={`${APPROX_CLASS[size]} leading-none text-osu-f1`}>{approx}</span>
      <span className="flex items-start gap-[2px] leading-none">
        <span className="relative inline-flex">
          <img src={image} alt={formatLabel(shown)} className={`${IMAGE_CLASS[size]} object-contain`} />
          {partial ? <ClearWindowRing clearWindow={clearWindow!} size={size} title={windowTitle} /> : null}
        </span>
        {suffix ? (
          <span
            className={`mt-0.5 ${SUFFIX_CLASS[size]} font-bold leading-none`}
            style={{ color: danTierColor(suffix) ?? undefined }}
          >
            {suffix}
          </span>
        ) : null}
      </span>
    </span>
  );
}
