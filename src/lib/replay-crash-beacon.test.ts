// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock("./analytics", () => ({ track }));

import {
  markReplayRendererInitStage,
  markReplayWatchStage,
  reportCrashedReplayWatchSession,
  startReplayWatchBeacon,
} from "./replay-crash-beacon";

const STORAGE_KEY = "mh_replay_watch_beacon";

let stopBeacon: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-01T06:15:48.000Z"));
  window.sessionStorage.clear();
  track.mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  stopBeacon?.();
  stopBeacon = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.sessionStorage.clear();
});

describe("replay crash beacon renderer progress", () => {
  test("persists each renderer init marker synchronously", () => {
    stopBeacon = startReplayWatchBeacon({ score_id: 7189878496 }, () => null);

    vi.advanceTimersByTime(12);
    markReplayRendererInitStage("renderer_context_requested", { canvas_width: 1366 });
    vi.advanceTimersByTime(7);
    markReplayRendererInitStage("renderer_context_acquired", { renderer_backend: "WebGL 2" });

    const record = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "{}") as {
      context: Record<string, unknown>;
    };
    expect(record.context).toMatchObject({
      score_id: 7189878496,
      replay_watch_stage: "renderer_context_acquired",
      renderer_init_stage: "renderer_context_acquired",
      renderer_init_stage_at_ms: 19,
      renderer_backend: "WebGL 2",
    });
    expect((record.context.renderer_init_trace as unknown[]).slice(-2)).toEqual([
      {
        stage: "renderer_context_requested",
        atMs: 12,
        details: { canvas_width: 1366 },
      },
      {
        stage: "renderer_context_acquired",
        atMs: 19,
        details: { renderer_backend: "WebGL 2" },
      },
    ]);
  });

  test("records tab visibility and focus work without overwriting the last init stage", () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    stopBeacon = startReplayWatchBeacon({ score_id: 7189878496 }, () => 1234);
    markReplayRendererInitStage("renderer_attached", { renderer_backend: "WebGL 2" });
    markReplayWatchStage("document_visibility_changed", { visibility_state: "hidden" });
    markReplayWatchStage("shared_settings_refresh_started", { settings_refresh_reason: "focus" });

    const record = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "{}") as {
      context: Record<string, unknown>;
    };
    expect(record.context).toMatchObject({
      replay_watch_stage: "shared_settings_refresh_started",
      settings_refresh_reason: "focus",
      renderer_init_stage: "renderer_attached",
      renderer_backend: "WebGL 2",
    });
    expect((record.context.replay_watch_trace as unknown[]).slice(-2)).toEqual([
      {
        stage: "document_visibility_changed",
        atMs: 0,
        details: { visibility_state: "hidden" },
      },
      {
        stage: "shared_settings_refresh_started",
        atMs: 0,
        details: { settings_refresh_reason: "focus" },
      },
    ]);
  });

  test("prints copy-ready JSON and sends the same init trace after a crash", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
    stopBeacon = startReplayWatchBeacon({ score_id: 7189878496 }, () => 0);
    markReplayRendererInitStage("first_frame_gpu_submit_started", {
      renderer_backend: "WebGL 2",
    });

    reportCrashedReplayWatchSession();

    expect(error).toHaveBeenCalledWith(
      "[replay crash] The previous replay renderer died without unloading.",
      expect.objectContaining({
        replay_watch_stage: "first_frame_gpu_submit_started",
        renderer_init_stage: "first_frame_gpu_submit_started",
      }),
    );
    expect(info).toHaveBeenCalledWith("[replay crash] COPY THIS JSON", expect.any(String));
    const copyJson = JSON.parse(info.mock.calls[0][1] as string) as Record<string, unknown>;
    expect(copyJson).toMatchObject({
      score_id: 7189878496,
      renderer_init_stage: "first_frame_gpu_submit_started",
      renderer_backend: "WebGL 2",
      crash_detected_at: "2026-08-01T06:15:48.000Z",
    });
    expect(track).toHaveBeenCalledWith("replay_watch_crash", copyJson);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
