import { Trans } from "@lingui/react/macro";
import { DEFAULT_REPLAY_MASTER_SCROLL_SPEED, REPLAY_MASTER_MAX_SCROLL_SPEED, REPLAY_MASTER_MIN_SCROLL_SPEED, normalizeReplayMasterScrollSpeed } from "#/lib/replay-overlays";
import type { ReplayOverlayPlacement } from "#/lib/replay-overlays";
import { ReplayOptionChip, ReplayOptionChips } from "./ReplayOptionChip";

export function ReplayMasterOverlayControls({ placement, onChange }: { placement: ReplayOverlayPlacement; onChange: (patch: Partial<ReplayOverlayPlacement>) => void }) {
  const speed = normalizeReplayMasterScrollSpeed(placement.scrollSpeed);
  return (
    <div className="space-y-1.5 text-[11px]">
      <label className="block">
        <span className="flex items-center justify-between gap-2">
          <span><Trans>Overlay scroll speed</Trans></span>
          <span className="tabular-nums">{speed.toFixed(2)}×</span>
        </span>
        <input
          type="range"
          min={REPLAY_MASTER_MIN_SCROLL_SPEED}
          max={REPLAY_MASTER_MAX_SCROLL_SPEED}
          step={0.05}
          value={speed}
          onChange={(event) => onChange({ scrollSpeed: Number(event.target.value) })}
          className="mt-2 block w-full cursor-pointer accent-osu-pink"
        />
      </label>
      <div className="flex items-center justify-between gap-2 text-osu-f1">
        <span><Trans>1× = original default</Trans></span>
        <button type="button" onClick={() => onChange({ scrollSpeed: DEFAULT_REPLAY_MASTER_SCROLL_SPEED })} className="cursor-pointer text-osu-pink hover:text-osu-pink-light">
          <Trans>Reset</Trans>
        </button>
      </div>
      <div className="pt-2">
        <ReplayOptionChips>
          <ReplayOptionChip checked={placement.transparentBackground === true} onChange={(transparentBackground) => onChange({ transparentBackground })}>
            <Trans>Transparent background</Trans>
          </ReplayOptionChip>
          <ReplayOptionChip checked={placement.followSv === true} onChange={(followSv) => onChange({ followSv })}>
            <Trans>Follow SV changes</Trans>
          </ReplayOptionChip>
        </ReplayOptionChips>
      </div>
    </div>
  );
}
