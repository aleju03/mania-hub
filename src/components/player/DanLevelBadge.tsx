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

export function DanLevelBadge({
  label,
  keyCount,
  side,
  beyondTable = false,
  size = "md",
  formatLabel,
}: {
  label: string;
  keyCount: number;
  side: "rc" | "ln";
  beyondTable?: boolean;
  size?: DanBadgeSize;
  /** Renders the level for humans ("8" -> "8th dan"); used for alt text. */
  formatLabel: (label: string) => string;
}) {
  const shown = beyondTable ? danBareLabel(label) : label;
  const image = getDanImageSrc(danBareLabel(shown), side === "ln" ? "ln" : undefined, keyCount);
  const suffix = beyondTable ? "" : danTierSuffix(shown);
  const approx = beyondTable ? ">" : "~";

  if (!image) {
    return <span className="text-[12px] font-bold text-osu-l1">{approx}{formatLabel(shown)}</span>;
  }
  return (
    <span className="flex items-center gap-0.5">
      <span className={`${APPROX_CLASS[size]} leading-none text-osu-f1`}>{approx}</span>
      <span className="flex items-start gap-[2px] leading-none">
        <img src={image} alt={formatLabel(shown)} className={`${IMAGE_CLASS[size]} object-contain`} />
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
