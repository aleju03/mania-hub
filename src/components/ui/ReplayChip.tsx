import { useNavigate } from "@tanstack/react-router";
import type { KeyboardEvent, MouseEvent } from "react";
import { useLingui } from "@lingui/react/macro";
import { PlayGlyph } from "./PlayGlyph";

/**
 * "Replay" chip for a play row's badge line. The row is itself a button, which
 * cannot hold a link, so this is a link-role span that stops the row's click
 * and navigates on its own; a modified or middle click opens a new tab.
 */
export function ReplayChip({
  scoreId,
  beatmapsetId,
  className = "",
}: {
  scoreId: number;
  beatmapsetId: number | null | undefined;
  className?: string;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const search = { scoreId, beatmapsetId: beatmapsetId ?? undefined };
  const href = `/replay?scoreId=${scoreId}${beatmapsetId != null ? `&beatmapsetId=${beatmapsetId}` : ""}`;
  const open = (event: MouseEvent | KeyboardEvent, newTab: boolean) => {
    event.stopPropagation();
    event.preventDefault();
    if (newTab) window.open(href, "_blank", "noopener");
    else void navigate({ to: "/replay", search });
  };
  return (
    <span
      role="link"
      tabIndex={0}
      title={t`Watch replay`}
      onClick={(event) => open(event, event.ctrlKey || event.metaKey || event.shiftKey)}
      onAuxClick={(event) => { if (event.button === 1) open(event, true); }}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") open(event, false); }}
      className={`inline-flex cursor-pointer items-center gap-1 rounded bg-osu-pink/20 px-1.5 py-0.5 font-bold text-osu-pink-light transition-colors hover:bg-osu-pink/35 ${className}`}
    >
      <PlayGlyph className="h-[8px] w-[7px]" />
      {t`Replay`}
    </span>
  );
}
