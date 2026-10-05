import { Trans } from "@lingui/react/macro";
import type { ReplayOverlayPlacement } from "#/lib/replay-overlays";
import { ReplayOptionChip, ReplayOptionChips } from "./ReplayOptionChip";

export function ReplayPlayerInfoControls({ placement, onChange }: { placement: ReplayOverlayPlacement; onChange: (patch: Partial<ReplayOverlayPlacement>) => void }) {
  return (
    <ReplayOptionChips>
      <ReplayOptionChip checked={placement.playerBanner !== false} onChange={(playerBanner) => onChange({ playerBanner })}>
        <Trans>Profile banner</Trans>
      </ReplayOptionChip>
    </ReplayOptionChips>
  );
}
