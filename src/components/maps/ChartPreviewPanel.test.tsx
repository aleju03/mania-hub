// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getI18n } from "../../lib/i18n";
import type { ManiaBeatmap } from "../../lib/beatmap-parser";
import type { MapsFavouriteBeatmapset } from "../../lib/types";
import { ChartPreviewPanel } from "./ChartPreviewPanel";

const mocks = vi.hoisted(() => ({ getBeatmapFile: vi.fn(), rendererReady: vi.fn() }));
vi.mock("../../lib/osu", () => ({ getBeatmapFile: mocks.getBeatmapFile }));
vi.mock("../../lib/audio-url", () => ({ getBeatmapAudioUrl: () => "/full-audio.mp3" }));
vi.mock("../../lib/use-replay-skin-settings", () => ({ useReplaySkinSettings: () => null }));
vi.mock("../../lib/parsed-beatmap-cache", () => ({ parseCachedManiaBeatmap: () => chart }));
vi.mock("../../lib/replay-renderer-loader", () => ({
  loadReplayRenderer: async () => ({
    ManiaReplayRenderer: class {
      isPlaying = false;
      time = 0;
      duration = 120_000;
      ready = mocks.rendererReady;
      play() { this.isPlaying = true; }
      pause() { this.isPlaying = false; }
      destroy() {}
      resize() {}
      seek() {}
      setPreviewData() {}
      setExternalClock() {}
      setSkinSettings() {}
      setScrollSpeed() {}
    },
  }),
}));

const chart: ManiaBeatmap = {
  title: "Song", artist: "Artist", creator: "Mapper", version: "0.7x",
  keyCount: 4, od: 8, bpm: 140, totalLength: 120_000,
  audioFilename: "song-0.7.mp3", previewTime: 5_000, backgroundFilename: "",
  breakPeriods: [], scrollVelocities: [],
  notes: [5_200, 10_000, 120_000].map((time) => ({ column: 0, time, endTime: time, isHold: false })),
};

function setFixture(rateEdits = true) {
  return {
    id: 100, title: "Song", previewUrl: "/clip.mp3",
    maniaBeatmaps: [
      { id: 101, beatmapsetId: 100, version: rateEdits ? "0.7x" : "Hard", difficultyRating: 5, totalLength: 120, cs: 4 },
      { id: 102, beatmapsetId: 100, version: "Insane", difficultyRating: 6, totalLength: 120, cs: 4 },
    ],
  } as MapsFavouriteBeatmapset;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function openPreview(rateEdits = true) {
  const view = render(
    <I18nProvider i18n={getI18n("en")}>
      <ChartPreviewPanel beatmapset={setFixture(rateEdits)} selectedBeatmapId={101} playbackRate={1.25} />
    </I18nProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "chart preview" }));
  return view;
}

function metadata(audio: HTMLAudioElement, readyState = 1) {
  Object.defineProperty(audio, "readyState", { configurable: true, value: readyState });
  fireEvent.loadedMetadata(audio);
}

beforeEach(() => {
  mocks.getBeatmapFile.mockResolvedValue({ content: "chart" });
  mocks.rendererReady.mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("chart preview loading", () => {
  it("labels chart and audio loading, hides renderer preparation, and keeps the pending start on canplay", async () => {
    const file = deferred<{ content: string }>();
    const renderer = deferred<void>();
    const playback = deferred<void>();
    mocks.getBeatmapFile.mockReturnValue(file.promise);
    mocks.rendererReady.mockReturnValue(renderer.promise);
    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValue(playback.promise);
    const { container } = openPreview();
    expect(screen.getByRole("status").textContent).toContain("Loading chart");
    await act(async () => file.resolve({ content: "chart" }));
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => renderer.resolve());
    expect(screen.getByRole("status").textContent).toContain("Loading full audio");
    expect(screen.getByRole("status").textContent).toContain("Rate edits detected");
    const audio = container.querySelector("audio")!;
    expect(audio.getAttribute("src")).toBe("/full-audio.mp3");
    expect(audio.playbackRate).toBe(1.25); // The file already contains the difficulty's 0.7x edit.
    await act(async () => metadata(audio));
    expect(screen.getByRole("status").textContent).toContain("Seeking audio");
    fireEvent.canPlay(audio);
    expect(screen.getByRole("status").textContent).toContain("Seeking audio");
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Buffering audio"));
    await act(async () => playback.resolve());
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.waiting(audio);
    expect(screen.getByRole("status").textContent).toContain("Buffering audio");
    fireEvent.playing(audio);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("labels short-clip loading and leaves the full song untouched for ordinary sets", async () => {
    const { container } = openPreview(false);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Loading audio preview"));
    const audio = container.querySelector("audio")!;
    expect(audio.getAttribute("src")).toBe("/clip.mp3");
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
    await act(async () => metadata(audio, 4));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("retains loaded audio when the user scrubs to a different position", async () => {
    const { container } = openPreview();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Loading full audio"));
    const audio = container.querySelector("audio")!;
    await act(async () => metadata(audio, 4));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    const loadCount = vi.mocked(HTMLMediaElement.prototype.load).mock.calls.length;
    const timeline = container.querySelector<HTMLDivElement>("div.group\\/density")!;
    timeline.setPointerCapture = vi.fn();
    vi.spyOn(timeline, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 5));
    fireEvent(timeline, new MouseEvent("pointerdown", { clientX: 50, bubbles: true }));
    fireEvent(timeline, new MouseEvent("pointerup", { clientX: 50, bubbles: true }));
    await waitFor(() => expect(audio.currentTime).toBe(59));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(loadCount);
  });
});
