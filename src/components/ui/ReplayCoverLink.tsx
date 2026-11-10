import { Link } from "@tanstack/react-router";
import { useLingui } from "@lingui/react/macro";
import { PlayGlyph } from "./PlayGlyph";

/**
 * Watch-replay link laid over a play row's cover. The cover sits inside the
 * row's own button, which cannot hold a link, so the row positions this over
 * it through `className` (offset and size matching the cover).
 */
export function ReplayCoverLink({
  scoreId,
  beatmapsetId,
  className,
}: {
  scoreId: number;
  beatmapsetId: number | null | undefined;
  className: string;
}) {
  const { t } = useLingui();
  return (
    <Link
      to="/replay"
      search={{ scoreId, beatmapsetId: beatmapsetId ?? undefined }}
      title={t`Watch replay`}
      aria-label={t`Watch replay`}
      className={`group/replay absolute top-1/2 flex -translate-y-1/2 items-center justify-center rounded-md ${className}`}
    >
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-black/65 text-white transition-colors group-hover/replay:bg-osu-pink sm:h-7 sm:w-7">
        <PlayGlyph className="h-[10px] w-[8.5px] translate-x-[0.5px]" />
      </span>
    </Link>
  );
}
