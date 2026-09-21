// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_REPLAY_OVERLAY_SETTINGS } from "../replay-overlays";
import { DEFAULT_REPLAY_SKIN_SETTINGS } from "../replay-skin";
import type { ReplayExportCapture } from "./snapshot";
import { buildReplayExportSpec } from "./snapshot";
import type { ReplayExportJobView } from "./types";

const runner = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock("./runners/local", () => ({
  runLocalExport: (options: unknown) => runner.run(options),
}));

function makeCapture(): ReplayExportCapture {
  return {
    scoreId: 1,
    beatmapId: 2,
    beatmapsetId: 3,
    beatmapChecksum: "hash",
    uploadId: null,
    playerName: "player",
    songTitle: "song",
    difficultyName: "diff",

    replayFrames: [],
    lifeBarFrames: [],
    keyCount: 4,
    replayDurationMs: 60_000,

    notes: [],
    timingPoints: undefined,
    scrollVelocities: undefined,
    od: 8,
    isConvert: false,
    expectedCounts: undefined,
    realTotalScore: null,
    initialCombo: 0,

    isLazer: false,
    legacyReplayFrameRounding: true,
    mods: [],
    modRate: 1,
    userSpeed: 1,
    effectiveRate: 1,
    pitchPreserved: true,

    bgDim: 70,
    blackPlayfield: false,
    scrollSpeed: 20,
    showInputOverlay: false,
    inputOverlayOnly: false,
    inputOverlayColor: "#a855f7",
    inputOverlayKeyHistory: false,
    missThumbHand: "right",
    skinSettings: DEFAULT_REPLAY_SKIN_SETTINGS,
    overlaySettings: DEFAULT_REPLAY_OVERLAY_SETTINGS,

    leaderboard: [],
    leaderboardPlayerName: "player",
    leaderboardVisible: false,
    storyboard: null,
    storyboardEnabled: false,

    // No song and no background: the resolver then has nothing to fetch, so
    // these tests exercise the manager rather than the network.
    audioEnabled: false,
    songVolume: 1,
    hitsoundsEnabled: false,
    beatmapHitsounds: false,
    beatmapHitsoundVolume: 0.5,
    keypressHitsounds: false,
    keypressHitsoundVolume: 0.5,
    comboBreakSound: false,
    hitsoundSamples: new Map(),

    songUrl: null,
    backgroundUrls: [],

    locale: "en",
  };
}

function startRequest(capture = makeCapture()) {
  const spec = buildReplayExportSpec(capture, { preset: "720p60", startMs: 0, endMs: 30_000, includeAudio: true });
  return { spec, capture, target: { kind: "buffer" } as const, title: "song [diff]" };
}

async function freshManager() {
  vi.resetModules();
  const module = await import("./manager");
  return module.getReplayExportManager();
}

let deferred: { resolve: (value: unknown) => void; reject: (error: unknown) => void };

beforeEach(() => {
  // jsdom ships neither half of the object-URL pair.
  Object.assign(URL, {
    createObjectURL: vi.fn(() => "blob:test/1"),
    revokeObjectURL: vi.fn(),
  });
  runner.run.mockReset();
  runner.run.mockImplementation(() => new Promise((resolve, reject) => {
    deferred = { resolve, reject };
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The manager resolves assets and then dynamically imports the runner, so
// draining microtasks alone is not enough to reach it.
async function flush() {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ReplayExportManager", () => {
  it("publishes a preparing job and reserves the slot synchronously", async () => {
    const manager = await freshManager();
    const view = manager.start(startRequest());
    expect(view.phase).toBe("preparing");
    expect(manager.isBusy).toBe(true);
    // Two clicks in one tick must not both get a job.
    expect(() => manager.start(startRequest())).toThrowError(/export_busy/);
  });

  it("walks a job to a downloadable result", async () => {
    const manager = await freshManager();
    const seen: (ReplayExportJobView | null)[] = [];
    manager.subscribe((view) => seen.push(view));
    manager.start(startRequest());
    await flush();

    expect(runner.run).toHaveBeenCalledTimes(1);
    deferred.resolve({
      kind: "blob",
      filename: "player-song-diff-1.mp4",
      byteLength: 1234,
      blob: new Blob([new Uint8Array(4)], { type: "video/mp4" }),
      mimeType: "video/mp4",
    });
    await flush();

    const view = manager.view;
    expect(view?.phase).toBe("ready");
    expect(view?.progress).toBe(1);
    expect(view?.result?.byteLength).toBe(1234);
    expect(view?.result?.downloadUrl).toBeTruthy();
    // A ready-but-undownloaded result still holds the slot.
    expect(manager.isBusy).toBe(true);
    expect(seen.length).toBeGreaterThan(1);
  });

  it("reports a failure under its stable code", async () => {
    const manager = await freshManager();
    const { ReplayExportError } = await import("./errors");
    manager.start(startRequest());
    await flush();
    deferred.reject(new ReplayExportError("unsupported_video_codec"));
    await flush();
    expect(manager.view?.phase).toBe("failed");
    expect(manager.view?.errorCode).toBe("unsupported_video_codec");
    expect(manager.isBusy).toBe(false);
  });

  it("maps an unknown throw onto a code rather than leaking it", async () => {
    const manager = await freshManager();
    manager.start(startRequest());
    await flush();
    deferred.reject(new TypeError("something native blew up"));
    await flush();
    expect(manager.view?.phase).toBe("failed");
    expect(manager.view?.errorCode).toBe("encoder_failed");
  });

  it("cancels idempotently and never publishes a late success", async () => {
    const manager = await freshManager();
    manager.start(startRequest());
    await flush();
    manager.cancel();
    manager.cancel();
    expect(manager.view?.phase).toBe("cancelling");

    const signal = (runner.run.mock.calls[0][0] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(true);

    // A result that arrives after the user cancelled must be discarded.
    deferred.resolve({ kind: "blob", filename: "x.mp4", byteLength: 1, blob: new Blob([]), mimeType: "video/mp4" });
    await flush();
    expect(manager.view?.phase).toBe("cancelled");
    expect(manager.view?.result).toBeNull();
    expect(manager.isBusy).toBe(false);
  });

  it("frees the slot and the object URL when a result is dismissed", async () => {
    const manager = await freshManager();
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    manager.start(startRequest());
    await flush();
    deferred.resolve({
      kind: "blob",
      filename: "x.mp4",
      byteLength: 4,
      blob: new Blob([new Uint8Array(4)]),
      mimeType: "video/mp4",
    });
    await flush();
    manager.dismiss();
    expect(revoke).toHaveBeenCalled();
    expect(manager.view).toBeNull();
    expect(manager.isBusy).toBe(false);
  });

  it("marks a download as started without claiming a saved file", async () => {
    const manager = await freshManager();
    manager.start(startRequest());
    await flush();
    deferred.resolve({
      kind: "blob",
      filename: "x.mp4",
      byteLength: 4,
      blob: new Blob([new Uint8Array(4)]),
      mimeType: "video/mp4",
    });
    await flush();
    manager.markDownloadStarted();
    expect(manager.view?.phase).toBe("download-started");
  });

  it("reports a committed file as saved, not merely ready", async () => {
    const manager = await freshManager();
    manager.start(startRequest());
    await flush();
    deferred.resolve({ kind: "file", filename: "x.mp4", byteLength: 90, blob: null, mimeType: "video/mp4" });
    await flush();
    expect(manager.view?.phase).toBe("saved-to-file");
    expect(manager.view?.result?.downloadUrl).toBeNull();
    // Nothing is left in memory for the user to deal with.
    expect(manager.isBusy).toBe(false);
  });

  it("guards the page against unload only while something is at stake", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const manager = await freshManager();
    manager.start(startRequest());
    expect(add).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    await flush();
    deferred.reject(new Error("nope"));
    await flush();
    expect(remove).toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });

  it("keeps a terminal phase rather than relabelling it on the way out", async () => {
    const manager = await freshManager();
    const { ReplayExportError } = await import("./errors");
    manager.start(startRequest());
    await flush();
    // Something outside the run fails the job, then the run unwinds through
    // its own abort path. The first verdict is the one the user needs.
    deferred.reject(new ReplayExportError("export_busy"));
    await flush();
    manager.cancel();
    await flush();
    expect(manager.view?.phase).toBe("failed");
    expect(manager.view?.errorCode).toBe("export_busy");
  });

  it("hands the runner a spec that survives a JSON round trip", async () => {
    const manager = await freshManager();
    const { parseReplayExportSpec } = await import("./render-spec");
    manager.start(startRequest());
    await flush();
    const spec = (runner.run.mock.calls[0][0] as { spec: unknown }).spec;
    expect(() => parseReplayExportSpec(JSON.parse(JSON.stringify(spec)))).not.toThrow();
  });
});
