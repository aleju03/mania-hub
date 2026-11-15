import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

// The osu! leaderboard status as the solid pill the maps pages use: green
// RANKED, blue QUALIFIED, pink LOVED, grey GRAVEYARD, yellow for the rest
// (pending and WIP), matching osu! and the maps filter chips.

function beatmapStatusBadgeClass(status: string): string {
  const normalized = status.toLowerCase();
  const colorClass =
    normalized === "ranked" || normalized === "approved"
      ? "bg-[#6cf27f]"
      : normalized === "qualified"
        ? "bg-[#66ccff]"
        : normalized === "loved"
        ? "bg-[#f26fa6]"
        : normalized === "graveyard"
          ? "bg-[#b3b3b3]"
          : "bg-[#ffd36b]";

  return [
    "inline-flex shrink-0 items-center justify-center rounded-full",
    "px-2.5 py-1 text-[10px] font-extrabold uppercase leading-none text-black",
    colorClass,
  ].join(" ");
}

export function BeatmapStatusBadge({ status, className = "" }: { status: string; className?: string }) {
  const { i18n } = useLingui();
  const normalized = status.toLowerCase();
  const descriptor = MAP_STATUS_LABELS[normalized];
  return (
    <span className={`${beatmapStatusBadgeClass(status)} ${className}`}>
      {descriptor ? i18n._(descriptor) : status}
    </span>
  );
}

export const MAP_STATUS_LABELS: Record<string, MessageDescriptor> = {
  ranked: msg`Ranked`,
  approved: msg`Ranked`,
  qualified: msg`Qualified`,
  loved: msg`Loved`,
  graveyard: msg`Graveyard`,
  pending: msg`Pending`,
  wip: msg`Pending`,
  other: msg`Other`,
};
