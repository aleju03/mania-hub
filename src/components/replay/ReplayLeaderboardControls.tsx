import { Trans } from "@lingui/react/macro";
import type { ReplayOverlayPlacement } from "#/lib/replay-overlays";
import { ReplayOptionChip, ReplayOptionChips } from "./ReplayOptionChip";

export function ReplayLeaderboardControls({ placement, onChange }: {
  placement: ReplayOverlayPlacement;
  onChange: (patch: Partial<ReplayOverlayPlacement>) => void;
}) {
  return (
    <div className="space-y-1.5 text-[11px]">
      <ReplayOptionChips>
        <ReplayOptionChip checked={placement.collapseDuringPlay === true} onChange={(collapseDuringPlay) => onChange({ collapseDuringPlay })}>
          <Trans>Compact while playing</Trans>
        </ReplayOptionChip>
      </ReplayOptionChips>
      <p className="leading-snug text-osu-f1">
        <Trans>Lazer: keep ranks and avatars visible. Pause or hover to show score details.</Trans>
      </p>
    </div>
  );
}
