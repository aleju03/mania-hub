// @vitest-environment jsdom
//
// Regression tests for the "no preview audio" mark. It is permanent for the
// session, so it must only ever be set for the set that actually failed, and
// only when the source itself could not be loaded. A shared error handler used
// to blame whichever set was active when the event fired, so a 404 on an old
// set crossed out the next card the user clicked.
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPLAY_VOLUME_STORAGE_KEY, writeReplayVolume } from "../../lib/replay-preferences";
import { MapPreviewPlayerBar, useMapPreviewAudio, type MapPreviewAudio, type MapPreviewTrack } from "./MapPreviewAudio";

const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

// jsdom has no media stack: no load/play, no error events, no `error` setter.
class FakeAudio extends EventTarget {
  static last: FakeAudio | null = null;

  src = "";
  preload = "";
  volume = 1;
  loop = false;
  paused = false;
  currentTime = 0;
  duration = NaN;
  error: { code: number } | null = null;
  playRejection: (() => void) | null = null;

  constructor() {
    super();
    FakeAudio.last = this;
  }

  play(): Promise<void> {
    return new Promise<void>((_resolve, reject) => {
      this.playRejection = () => reject(new DOMException("interrupted", "AbortError"));
    });
  }

  pause() {
    this.paused = true;
  }

  load() {}
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }

  fail(code: number) {
    this.error = { code };
    this.dispatchEvent(new Event("error"));
  }
}

beforeEach(() => {
  FakeAudio.last = null;
  window.localStorage.clear();
  vi.stubGlobal("Audio", FakeAudio);
});

afterEach(cleanup);

describe("useMapPreviewAudio", () => {
  it("blames the set that failed, not the one playing when the error lands", () => {
    const { result } = renderHook(() => useMapPreviewAudio());

    // Old set with no preview file; the 404 takes a moment to come back.
    act(() => result.current.toggle(111));
    const audio = FakeAudio.last!;
    // Impatient click on another card while the first load is still in flight.
    act(() => result.current.toggle(222));
    act(() => audio.fail(MEDIA_ERR_SRC_NOT_SUPPORTED));

    expect(result.current.isUnavailable(222)).toBe(false);
    expect(result.current.isUnavailable(111)).toBe(false);
  });

  it("ignores a stale rejection from a superseded attempt on the same set", async () => {
    const { result } = renderHook(() => useMapPreviewAudio());

    act(() => result.current.toggle(111));
    const first = FakeAudio.last!.playRejection!;
    act(() => result.current.toggle(111)); // stop
    act(() => result.current.toggle(111)); // play again
    await act(async () => {
      first();
      await Promise.resolve();
    });

    expect(result.current.isUnavailable(111)).toBe(false);
    expect(result.current.loadingSetId).toBe(111);
  });

  it("marks a set unavailable when its own source cannot be loaded", () => {
    const { result } = renderHook(() => useMapPreviewAudio());

    act(() => result.current.toggle(111));
    act(() => FakeAudio.last!.fail(MEDIA_ERR_SRC_NOT_SUPPORTED));

    expect(result.current.isUnavailable(111)).toBe(true);
  });

  it("keeps a transient network error retryable", () => {
    const { result } = renderHook(() => useMapPreviewAudio());

    act(() => result.current.toggle(111));
    act(() => FakeAudio.last!.fail(MEDIA_ERR_NETWORK));

    expect(result.current.isUnavailable(111)).toBe(false);
    expect(result.current.loadingSetId).toBe(null);
    expect(result.current.playingSetId).toBe(null);
  });

  // The settings "Default volume" is the one stored volume; the preview used
  // to read a key of its own, so moving that slider did nothing here.
  it("opens at the stored default volume and follows a later change", () => {
    window.localStorage.setItem(REPLAY_VOLUME_STORAGE_KEY, "0.2");
    const { result } = renderHook(() => useMapPreviewAudio());

    act(() => result.current.toggle(111));
    expect(FakeAudio.last!.volume).toBeCloseTo(0.2);

    // What the settings slider does, from over the top of the playing preview.
    act(() => writeReplayVolume(0.8));
    expect(FakeAudio.last!.volume).toBeCloseTo(0.8);
    expect(result.current.volume).toBeCloseTo(0.8);
  });

  it("keeps a muted default muted", () => {
    window.localStorage.setItem(REPLAY_VOLUME_STORAGE_KEY, "0");
    const { result } = renderHook(() => useMapPreviewAudio());

    act(() => result.current.toggle(111));
    expect(FakeAudio.last!.volume).toBe(0);
  });

  it("pauses and resumes the same set in place", () => {
    const { result } = renderHook(() => useMapPreviewAudio());

    act(() => result.current.toggle(111));
    const audio = FakeAudio.last!;
    act(() => audio.dispatchEvent(new Event("playing")));
    expect(result.current.playingSetId).toBe(111);

    act(() => result.current.toggle(111));
    expect(audio.paused).toBe(true);
    expect(result.current.playingSetId).toBe(null);
    // Still the player bar's track, not a torn-down preview.
    expect(result.current.pausedSetId).toBe(111);
    expect(result.current.activeSetId).toBe(111);

    act(() => result.current.toggle(111));
    expect(result.current.playingSetId).toBe(111);
    expect(FakeAudio.last).toBe(audio);
  });

  it("does not cross out a set while the browser is offline", () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { result } = renderHook(() => useMapPreviewAudio());

    act(() => result.current.toggle(111));
    act(() => FakeAudio.last!.fail(MEDIA_ERR_SRC_NOT_SUPPORTED));

    expect(result.current.isUnavailable(111)).toBe(false);
    onLine.mockRestore();
  });
});

const TRACKS: MapPreviewTrack[] = [
  { beatmapsetId: 1, title: "One", artist: "First", coverUrl: "https://example.test/cover.jpg" },
  { beatmapsetId: 2, title: "Two", artist: "Second", coverUrl: "https://example.test/cover.jpg" },
  { beatmapsetId: 3, title: "Three", artist: "Third", coverUrl: "https://example.test/cover.jpg" },
];

function stubPreview(overrides: Partial<MapPreviewAudio> = {}): MapPreviewAudio {
  return {
    playingSetId: null,
    loadingSetId: null,
    pausedSetId: null,
    activeSetId: null,
    volume: 0.5,
    looping: false,
    isUnavailable: () => false,
    toggle: vi.fn(),
    stop: vi.fn(),
    getAudio: () => null,
    setVolume: vi.fn(),
    toggleMute: vi.fn(),
    toggleLoop: vi.fn(),
    seek: vi.fn(),
    ...overrides,
  };
}

describe("MapPreviewPlayerBar", () => {
  it("skips to the next set that has a preview file", () => {
    const toggle = vi.fn();
    render(
      <MapPreviewPlayerBar
        preview={stubPreview({ activeSetId: 1, playingSetId: 1, toggle, isUnavailable: (id) => id === 2 })}
        tracks={TRACKS}
      />,
    );

    expect(screen.getByText("One")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Next preview"));
    expect(toggle).toHaveBeenCalledWith(3);
  });

  it("has nothing to skip to at the ends of the list", () => {
    render(<MapPreviewPlayerBar preview={stubPreview({ activeSetId: 3, playingSetId: 3 })} tracks={TRACKS} />);

    expect((screen.getByLabelText("Next preview") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Previous preview") as HTMLButtonElement).disabled).toBe(false);
  });

  it("stays out of the way when nothing is playing", () => {
    render(<MapPreviewPlayerBar preview={stubPreview()} tracks={TRACKS} />);

    expect(screen.queryByLabelText("Preview volume")).toBe(null);
  });
});
