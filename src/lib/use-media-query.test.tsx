// @vitest-environment jsdom
import { act, render, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import { useMediaQuery } from "./use-media-query";

type Listener = () => void;

function stubMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<Listener>();
  const media = {
    get matches() {
      return matches;
    },
    addEventListener: (_: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_: string, listener: Listener) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", () => media);
  return {
    set(next: boolean) {
      matches = next;
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useMediaQuery", () => {
  test("answers from the browser and follows the query as it changes", () => {
    const media = stubMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery("(min-width: 640px)"));
    expect(result.current).toBe(true);
    act(() => media.set(false));
    expect(result.current).toBe(false);
  });

  test("is null on the server, so both layouts render there", () => {
    function ServerProbe() {
      const wide = useMediaQuery("(min-width: 640px)");
      return <span>{wide === null ? "unknown" : String(wide)}</span>;
    }
    expect(renderToString(<ServerProbe />)).toContain("unknown");
  });

  test("drops its listener on unmount", () => {
    const media = stubMatchMedia(false);
    const { unmount } = render(<Probe />);
    expect(media.listeners.size).toBe(1);
    unmount();
    expect(media.listeners.size).toBe(0);
  });
});

function Probe() {
  useMediaQuery("(min-width: 640px)");
  return null;
}
