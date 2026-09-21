// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_REPLAY_OVERLAY_SETTINGS } from "../replay-overlays";
import { DEFAULT_REPLAY_SKIN_SETTINGS } from "../replay-skin";
import { canonicalReplayExportSpecJson, parseReplayExportSpec } from "./render-spec";
import {
  buildReplayExportFilename,
  buildReplayExportSpec,
  resolveReplayExportResources,
  type ReplayExportCapture,
} from "./snapshot";

function makeCapture(overrides: Partial<ReplayExportCapture> = {}): ReplayExportCapture {
  return {
    scoreId: 42,
    beatmapId: 7,
    beatmapsetId: 9,
    beatmapChecksum: "hash",
    uploadId: null,
    playerName: "Some Player",
    songTitle: "A Song",
    difficultyName: "Another World",

    replayFrames: [],
    lifeBarFrames: [],
    keyCount: 4,
    replayDurationMs: 90_000,

    notes: [],
    timingPoints: undefined,
    scrollVelocities: undefined,
    od: 8.5,
    isConvert: false,
    expectedCounts: undefined,
    realTotalScore: 900_000,
    initialCombo: 0,

    isLazer: true,
    legacyReplayFrameRounding: false,
    mods: [{ acronym: "DT", settings: { speed_change: 1.4 } }],
    modRate: 1.4,
    userSpeed: 1,
    effectiveRate: 1.4,
    pitchPreserved: true,

    bgDim: 70,
    blackPlayfield: false,
    scrollSpeed: 21,
    showInputOverlay: true,
    inputOverlayOnly: false,
    inputOverlayColor: "#a855f7",
    inputOverlayKeyHistory: true,
    missThumbHand: "right",
    skinSettings: structuredClone(DEFAULT_REPLAY_SKIN_SETTINGS),
    overlaySettings: structuredClone(DEFAULT_REPLAY_OVERLAY_SETTINGS),

    leaderboard: [],
    leaderboardPlayerName: "Some Player",
    leaderboardVisible: true,
    storyboard: null,
    storyboardEnabled: false,

    audioEnabled: true,
    songVolume: 0.6,
    hitsoundsEnabled: true,
    beatmapHitsounds: true,
    beatmapHitsoundVolume: 0.5,
    keypressHitsounds: true,
    keypressHitsoundVolume: 0.4,
    comboBreakSound: true,
    hitsoundSamples: new Map([["default:normal-hitnormal", new ArrayBuffer(8)]]),

    songUrl: "blob:https://mania-tracker.com/song",
    backgroundUrls: [null],

    locale: "en",
    ...overrides,
  };
}

const options = { preset: "720p60" as const, startMs: 1_000, endMs: 31_000, includeAudio: true };

describe("buildReplayExportSpec", () => {
  it("produces a spec that validates after a JSON round trip", () => {
    const spec = buildReplayExportSpec(makeCapture(), options);
    expect(() => parseReplayExportSpec(JSON.parse(JSON.stringify(spec)))).not.toThrow();
  });

  it("copies mutable settings so a later preferences write cannot reach the job", () => {
    const capture = makeCapture();
    const spec = buildReplayExportSpec(capture, options);
    capture.skinSettings.comboFontSet = "set2";
    expect(spec.visual.skinSettings.comboFontSet).not.toBe("set2");
  });

  it("captures the actual viewer viewport independently of output dimensions", () => {
    const capture = makeCapture({ viewport: {
      width: 2040, height: 930, fullscreen: false, fullHeight: false, coarsePointer: false,
    } });
    const spec = buildReplayExportSpec(capture, options);
    expect(spec.output).toMatchObject({ width: 1580, height: 720 });
    expect(spec.output.videoBitrate).toBe(1_851_563);
    expect(parseReplayExportSpec(JSON.parse(JSON.stringify(spec))).visual.viewport).toEqual(capture.viewport);
    capture.viewport!.height = 1080;
    expect(spec.visual.viewport?.height).toBe(930);
  });

  it("retains the viewer's authored overlay geometry independently of export resolution", () => {
    const capture = makeCapture();
    const reference = { width: 2048, height: 1020, playfieldX: 600, playfieldWidth: 848, hudScale: 1.45 };
    capture.overlaySettings.judgements.reference = reference;
    const spec = buildReplayExportSpec(capture, options);
    expect(spec.output.height).toBe(720);
    expect(parseReplayExportSpec(JSON.parse(JSON.stringify(spec))).visual.overlaySettings.judgements.reference).toEqual(reference);
    reference.height = 900;
    expect(spec.visual.overlaySettings.judgements.reference?.height).toBe(1020);
  });

  it("carries no locator, token, or path into the rendering intent", () => {
    const json = canonicalReplayExportSpecJson(buildReplayExportSpec(makeCapture(), options));
    expect(json).not.toContain("blob:");
    expect(json).not.toContain("https://");
    expect(json).not.toContain("/api/");
  });

  it("keeps the resolved rate and pitch policy rather than a mod acronym list", () => {
    const spec = buildReplayExportSpec(makeCapture(), options);
    expect(spec.playback).toEqual({ rate: 1.4, pitchPolicy: "preserved" });
  });

  it("treats the viewer's mute as audio off", () => {
    const spec = buildReplayExportSpec(makeCapture({ audioEnabled: false }), options);
    expect(spec.output.audioCodec).toBeNull();
    expect(spec.audio.songEnabled).toBe(false);
    expect(spec.audio.hitsoundsEnabled).toBe(false);
  });

  it("stays exportable without a score id", () => {
    const spec = buildReplayExportSpec(makeCapture({ scoreId: null, uploadId: "abc" }), options);
    expect(spec.assets).toContainEqual({ role: "replay", id: "upload:abc" });
    expect(spec.filename).toBe("Some-Player-A-Song-Another-World.mp4");
  });

  it("lists every loaded sample as an asset identity", () => {
    const spec = buildReplayExportSpec(makeCapture(), options);
    expect(spec.assets).toContainEqual({ role: "default-sound", id: "default:normal-hitnormal" });
  });

  it("sanitizes the filename without letting it go empty", () => {
    expect(buildReplayExportFilename(makeCapture({ playerName: "///", songTitle: "", difficultyName: "" })))
      .toBe("replay-replay-mania-42.mp4");
  });
});

describe("resolveReplayExportResources", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 4, height: 4, close: vi.fn() })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it("fetches its own copy of the song rather than holding a URL string", async () => {
    const capture = makeCapture();
    const spec = buildReplayExportSpec(capture, options);
    const resources = await resolveReplayExportResources(capture, spec, new AbortController().signal);
    expect(fetch).toHaveBeenCalledWith("blob:https://mania-tracker.com/song", expect.anything());
    // Its own Blob, not the URL string: revoking that URL later is then a
    // non-event for the job.
    expect(resources.songFile?.size).toBe(3);
    expect(typeof resources.songFile?.arrayBuffer).toBe("function");
  });

  it("resolves from the spec alone, with no viewer or route in reach", async () => {
    const capture = makeCapture();
    // The spec crosses a JSON boundary first, the way a future runner's would.
    const spec = parseReplayExportSpec(JSON.parse(JSON.stringify(buildReplayExportSpec(capture, options))));
    const resources = await resolveReplayExportResources(capture, spec, new AbortController().signal);
    expect(resources.hitsoundSamples.has("default:normal-hitnormal")).toBe(true);
  });

  it("retains lazer leaderboard metadata without sharing mutable player options", async () => {
    const capture = makeCapture({
      leaderboard: [{ name: "Top", score: 990000, combo: 1500, rank: 1, accuracy: 0.98765, avatarUrl: "/api/avatar?u=2" }],
      leaderboardOptions: { playerAvatarUrl: "/api/avatar?u=3", isPartial: true },
    });
    const resources = await resolveReplayExportResources(capture, buildReplayExportSpec(capture, options), new AbortController().signal);
    capture.leaderboardOptions!.playerAvatarUrl = "/api/avatar?u=4";
    expect(resources.leaderboard[0]).toMatchObject({ accuracy: 0.98765, avatarUrl: "/api/avatar?u=2" });
    expect(resources.leaderboardOptions).toEqual({ playerAvatarUrl: "/api/avatar?u=3", isPartial: true });
    resources.release();
  });

  it("releases its bytes once, and stays released", async () => {
    const capture = makeCapture();
    const spec = buildReplayExportSpec(capture, options);
    const resources = await resolveReplayExportResources(capture, spec, new AbortController().signal);
    const bitmap = resources.backgroundImage as unknown as { close: () => void } | null;
    resources.release();
    resources.release();
    expect(resources.songFile).toBeNull();
    expect(resources.hitsoundSamples.size).toBe(0);
    if (bitmap) expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("fails loudly when music was asked for and could not be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    const capture = makeCapture();
    const spec = buildReplayExportSpec(capture, options);
    await expect(resolveReplayExportResources(capture, spec, new AbortController().signal))
      .rejects.toMatchObject({ code: "asset_load_failed" });
  });

  it("does not touch the network when the export has no audio", async () => {
    const capture = makeCapture({ audioEnabled: false });
    const spec = buildReplayExportSpec(capture, options);
    await resolveReplayExportResources(capture, spec, new AbortController().signal);
    expect(fetch).not.toHaveBeenCalled();
  });
});
