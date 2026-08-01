import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay request optimizations", () => {
  const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
  const hitsoundSource = fs.readFileSync(path.resolve(__dirname, "../lib/replay-hitsounds.ts"), "utf8");

  it("loads one default hitsound bundle only when an enabled channel needs it", () => {
    expect(hitsoundSource).toContain('const DEFAULT_SAMPLE_BUNDLE_URL = "/assets/replay-default-hitsounds-v1.zip";');
    expect(routeSource).toContain("if (replayAudioNeedsDefaultSamples(initial)) void player.loadDefaultSamples();");
    expect(routeSource).toContain("if (replayAudioNeedsDefaultSamples(audioSettings)) void player.loadDefaultSamples();");
  });

  it("uses score-embedded player identity without an eager profile lookup", () => {
    expect(routeSource).not.toContain("getUser({ data: { key: lookupKey } })");
    expect(routeSource).toContain("const playerProfile = useMemo<ReplayPlayerProfile | null>");
  });

  it("delays the cover fallback and reserves the full audio fetch for stalls", () => {
    expect(routeSource).toContain("REPLAY_COVER_FALLBACK_DELAY_MS");
    expect(routeSource).toContain("window.setTimeout(startCoverFallback, REPLAY_COVER_FALLBACK_DELAY_MS)");
    expect(routeSource).toContain("!audioRecoveryRequested || !canRecoverRemoteAudio");
    expect(routeSource).toContain("scheduleAudioRecovery");
  });
});
