// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock("./analytics", () => ({ track }));

import {
  reportCrashedReplayWatchSession,
  startReplayWatchBeacon,
  updateReplayWatchBeaconContext,
} from "./replay-crash-beacon";

const STORAGE_KEY = "mh_replay_watch_beacon";
const LEGACY_DEBUG_STORAGE_KEY = "mh_replay_watch_beacon_debug";

let stopBeacon: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-01T06:15:48.000Z"));
  window.sessionStorage.clear();
  window.localStorage.clear();
  track.mockClear();
});

afterEach(() => {
  stopBeacon?.();
  stopBeacon = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("replay crash beacon", () => {
  test("does not create a throwaway WebGL context for diagnostics", () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

    stopBeacon = startReplayWatchBeacon({ score_id: 7189878496 }, () => null);

    expect(getContext).not.toHaveBeenCalled();
  });

  test("persists lightweight renderer diagnostics in session storage only", () => {
    stopBeacon = startReplayWatchBeacon({ score_id: 7189878496 }, () => 1234);
    updateReplayWatchBeaconContext({ renderer_backend: "WebGL", judgement_build_ms: 23 });

    const record = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "{}") as {
      context: Record<string, unknown>;
    };
    expect(record.context).toMatchObject({
      score_id: 7189878496,
      renderer_backend: "WebGL",
      judgement_build_ms: 23,
    });
    expect(window.localStorage.getItem(LEGACY_DEBUG_STORAGE_KEY)).toBeNull();
  });

  test("clears the active record on a normal stop", () => {
    stopBeacon = startReplayWatchBeacon({ score_id: 7189878496 }, () => null);

    stopBeacon();
    stopBeacon = null;

    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("reports a leftover session without writing debug console or localStorage output", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    stopBeacon = startReplayWatchBeacon({ score_id: 7189878496 }, () => 0);
    updateReplayWatchBeaconContext({ renderer_backend: "WebGL" });
    window.localStorage.setItem(LEGACY_DEBUG_STORAGE_KEY, "old debug trace");

    reportCrashedReplayWatchSession();

    expect(error).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith("replay_watch_crash", expect.objectContaining({
      score_id: 7189878496,
      renderer_backend: "WebGL",
      crash_detected_at: "2026-08-01T06:15:48.000Z",
    }));
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(LEGACY_DEBUG_STORAGE_KEY)).toBeNull();
  });
});
