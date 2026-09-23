import { useLingui } from "@lingui/react/macro";
import { danBareLabel, danTierColor, danTierSuffix, getDanImageSrc } from "#/lib/dan-images";

/**
 * A chart's dan as a play row prints it: the ladder image with its tier
 * suffix, or the bare words when the ladder has no image for the level. No
 * "~": this is the chart's own verdict, not an estimate of a player.
 *
 * Shared by the profile's plays explorer and the unrated plays board, so one
 * chart level looks the same wherever a play carries it.
 */
export function DanMark({
  label,
  keyCount,
  side,
  dimmed = false,
  compact = false,
}: {
  label: string;
  keyCount: number;
  side: "rc" | "ln" | null;
  dimmed?: boolean;
  /** The mobile score row's size, which sits in a line of text. */
  compact?: boolean;
}) {
  const { t } = useLingui();
  // A numeric label reads as "7 dan"; a named one already reads as itself.
  const text = /^\d/.test(label) ? t`${label} dan` : label;
  const image = getDanImageSrc(danBareLabel(label), side === "ln" ? "ln" : undefined, keyCount);
  const suffix = danTierSuffix(label);
  if (!image) {
    return <span className={`${compact ? "text-xs" : "text-sm sm:text-base"} font-black leading-none text-osu-l1 ${dimmed ? "opacity-50" : ""}`}>{text}</span>;
  }
  return (
    <span className={`flex items-start gap-[2px] leading-none ${dimmed ? "opacity-40" : ""}`}>
      <img src={image} alt={text} className={`${compact ? "h-5 w-5" : "h-8 w-8"} object-contain`} />
      {suffix ? (
        <span className={`mt-0.5 ${compact ? "text-[11px]" : "text-[12px]"} font-bold leading-none`} style={{ color: danTierColor(suffix) ?? undefined }}>
          {suffix}
        </span>
      ) : null}
    </span>
  );
}
