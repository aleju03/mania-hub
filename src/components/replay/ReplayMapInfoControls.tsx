import { useLingui } from "@lingui/react/macro";
import { REPLAY_MAP_INFO_OPTIONS, REPLAY_MAP_INFO_OPTION_LABELS, normalizeReplayMapInfoOptions } from "#/lib/replay-overlays";
import type { ReplayOverlayPlacement } from "#/lib/replay-overlays";
import { ReplayOptionChip, ReplayOptionChips } from "./ReplayOptionChip";

export function ReplayMapInfoControls({ placement, onChange }: { placement: ReplayOverlayPlacement; onChange: (patch: Partial<ReplayOverlayPlacement>) => void }) {
  const { i18n } = useLingui();
  const options = normalizeReplayMapInfoOptions(placement.mapInfo);
  return (
    <ReplayOptionChips>
      {REPLAY_MAP_INFO_OPTIONS.map((option) => (
        <ReplayOptionChip
          key={option}
          checked={options[option]}
          onChange={(checked) => onChange({ mapInfo: { ...options, [option]: checked } })}
        >
          {i18n._(REPLAY_MAP_INFO_OPTION_LABELS[option])}
        </ReplayOptionChip>
      ))}
    </ReplayOptionChips>
  );
}
