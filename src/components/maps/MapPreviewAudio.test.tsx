// @vitest-environment jsdom
//
// Regression tests for the "no preview audio" mark. It is permanent for the
// session, so it must only ever be set for the set that actually failed, and
// only when the source itself could not be loaded. A shared error handler used
// to blame whichever set was active when the event fired, so a 404 on an old
// set crossed out the next card the user clicked.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMapPreviewAudio } from "./MapPreviewAudio";

const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

// jsdom has no media stack: no load/play, no error events, no `error` setter.
class FakeAudio extends EventTarget {
  static last: FakeAudio | null = null;

  src = "";
  preload = "";
  volume = 1;
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

  pause() {}
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
  vi.stubGlobal("Audio", FakeAudio);
});

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

  it("does not cross out a set while the browser is offline", () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { result } = renderHook(() => useMapPreviewAudio());

    act(() => result.current.toggle(111));
    act(() => FakeAudio.last!.fail(MEDIA_ERR_SRC_NOT_SUPPORTED));

    expect(result.current.isUnavailable(111)).toBe(false);
    onLine.mockRestore();
  });
});
