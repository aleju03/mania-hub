import { ensureReplayFontStyle, ensureReplayFontStylesheet } from "./replay-fonts";
import { getReplayComboFontStyle, readReplaySkinSettings } from "./replay-skin";

type ReplayRendererModule = typeof import("../components/replay/ReplayCanvas");

let rendererRequest: Promise<ReplayRendererModule> | null = null;

export function loadReplayRenderer(): Promise<ReplayRendererModule> {
  if (!rendererRequest) {
    void ensureReplayFontStylesheet().catch(() => {});
    rendererRequest = import("../components/replay/ReplayCanvas").catch((error) => {
      rendererRequest = null;
      throw error;
    });
  }
  return rendererRequest;
}

// Speculation must not produce an unhandled rejection. A failed download can
// be retried by the viewer, which owns the visible error and timeout handling.
export function preloadReplayRenderer(): void {
  void ensureReplayFontStyle(getReplayComboFontStyle(readReplaySkinSettings().comboFontSet)).catch(() => {});
  void loadReplayRenderer().catch(() => {});
}
