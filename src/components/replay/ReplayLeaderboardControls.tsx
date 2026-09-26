import { Trans } from "@lingui/react/macro";
import type { ReplayOverlayPlacement } from "#/lib/replay-overlays";

export function ReplayLeaderboardControls({ placement, onChange }: {
  placement: ReplayOverlayPlacement;
  onChange: (patch: Partial<ReplayOverlayPlacement>) => void;
}) {
  return (
    <div className="space-y-1.5 text-[11px]">
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={placement.collapseDuringPlay === true}
          onChange={(event) => onChange({ collapseDuringPlay: event.target.checked })}
          className="accent-osu-pink"
        />
        <Trans>Compact while playing</Trans>
      </label>
      <p className="leading-snug text-osu-f1">
        <Trans>Lazer: keep ranks and avatars visible. Pause or hover to show score details.</Trans>
      </p>
    </div>
  );
}
