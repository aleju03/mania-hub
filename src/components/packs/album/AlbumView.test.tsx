// @vitest-environment jsdom
/* The album cover's triangle field is positioned entirely by an inline
   animation-delay, so anything that restamps that delay teleports the whole
   field -- which is what "the triangle animation resets the moment i release
   the cover" was. And the shelf stays mounted behind an open album, so it needs
   a memo boundary or every page turn re-renders ~90 covers nobody can see. */
import { useState, type ReactElement } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AlbumShelf,
  CoverTriangles,
  albumCountText,
  albumSubtitle,
  useFramePulse,
} from "./AlbumView";
import { buildAlbumSections } from "./albumModel";

/* The three drift layers, in the order CoverTriangles renders them. */
const LAYER_DURATIONS = [26, 40, 58];

/* memo() stops a parent re-render from reaching the component at all, which is
   one half of the fix; unwrapping it exercises the other half -- that the
   component re-rendering does not restamp its phase. */
const RawCoverTriangles = (CoverTriangles as unknown as { type: () => ReactElement }).type;

function layerStyles(container: HTMLElement): Array<string | null> {
  return Array.from(container.querySelectorAll(".album-tri-layer")).map((node) =>
    node.getAttribute("style"),
  );
}

function delaySeconds(style: string | null): number {
  const match = /animation-delay:\s*(-?\d+(?:\.\d+)?)s/.exec(style ?? "");
  if (!match) throw new Error(`no animation-delay in ${style}`);
  return Number(match[1]);
}

/* vitest runs without globals, so testing-library's own auto-cleanup hook never
   registers and renders would pile up in one document. */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CoverTriangles", () => {
  it("stamps the drift phase once and never restamps it on a re-render", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    function Host() {
      const [tick, setTick] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setTick(tick + 1)}>
            bump {tick}
          </button>
          <RawCoverTriangles />
        </div>
      );
    }
    const { container, getByRole } = render(<Host />);
    const before = layerStyles(container);
    expect(before).toHaveLength(3);

    /* Nine seconds pass, then the parent re-renders -- exactly what a page turn
       does through setCurrentPage. Restamping here shifted the animation's local
       time by the whole gap and the field visibly jumped. */
    now.mockReturnValue(1_700_000_009_000);
    act(() => {
      fireEvent.click(getByRole("button"));
    });
    expect(layerStyles(container)).toEqual(before);
  });

  it("locks every instance to the same wall-clock phase whenever it mounts", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const first = layerStyles(render(<CoverTriangles />).container);
    now.mockReturnValue(1_700_000_009_000);
    const second = layerStyles(render(<CoverTriangles />).container);

    /* Two covers mounted nine seconds apart carry different stamps... */
    expect(second).not.toEqual(first);
    /* ...but land on the same point of the drift, which is what keeps the
       stand-in cover and the book's own cover face in step across the hand-off. */
    LAYER_DURATIONS.forEach((duration, index) => {
      expect((1_700_000_000 + delaySeconds(first[index])) % duration).toBe(0);
      expect((1_700_000_009 + delaySeconds(second[index])) % duration).toBe(0);
    });
  });

  it("is a memo barrier, so AlbumView state changes never walk the mounted covers", () => {
    expect((CoverTriangles as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    );
  });
});

describe("useFramePulse", () => {
  it("collapses a burst of pulses into one render on the next frame", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    let renders = 0;
    let pulse = () => {};
    function Host() {
      renders += 1;
      pulse = useFramePulse();
      return null;
    }
    render(<Host />);
    expect(renders).toBe(1);

    /* Six thumbnails landing in six separate tasks: React cannot batch those,
       so unbatched this is six full AlbumView renders mid page turn. */
    act(() => {
      for (let index = 0; index < 6; index += 1) pulse();
    });
    expect(frames).toHaveLength(1);
    expect(renders).toBe(1);

    act(() => {
      frames[0](0);
    });
    expect(renders).toBe(2);

    // The next batch schedules a fresh frame rather than being swallowed.
    act(() => {
      pulse();
    });
    expect(frames).toHaveLength(2);
  });

  it("cancels a pending frame when the album unmounts", () => {
    const cancelled: number[] = [];
    vi.stubGlobal("requestAnimationFrame", () => 77);
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      cancelled.push(handle);
    });
    let pulse = () => {};
    function Host() {
      pulse = useFramePulse();
      return null;
    }
    const { unmount } = render(<Host />);
    act(() => {
      pulse();
    });
    unmount();
    expect(cancelled).toEqual([77]);
  });
});

describe("cover captions", () => {
  it("pluralizes and localizes the card count", () => {
    const counts = new Map([
      ["CR", 1],
      ["US", 1234],
    ]);
    expect(albumCountText(counts, "CR")).toBe("1 card");
    expect(albumCountText(counts, "US")).toBe("1,234 cards");
    expect(albumCountText(counts, "JP")).toBe("0 cards");
  });

  it("labels the Global album by its cap", () => {
    expect(albumSubtitle("GLOBAL")).toBe("Top 100 players");
    expect(albumSubtitle("CR")).toBe("Card collection");
  });
});

describe("AlbumShelf", () => {
  const sections = buildAlbumSections(["CR", "US", "JP"]);
  const counts = new Map([["CR", 3]]);

  it("filters by name and reports the count against the full shelf", () => {
    const { getByLabelText, getByText, queryByLabelText } = render(
      <AlbumShelf sections={sections} counts={counts} onOpen={() => {}} />,
    );
    fireEvent.change(getByLabelText("Find a country album"), { target: { value: "costa" } });
    expect(getByText("1 of 4 albums")).toBeTruthy();
    expect(queryByLabelText("Open the United States album")).toBeNull();

    fireEvent.change(getByLabelText("Find a country album"), { target: { value: "zzz" } });
    expect(getByText('No album matches "zzz".')).toBeTruthy();
  });

  it("filters by country code too", () => {
    const { getByLabelText, getByText } = render(
      <AlbumShelf sections={sections} counts={counts} onOpen={() => {}} />,
    );
    fireEvent.change(getByLabelText("Find a country album"), { target: { value: "jp" } });
    expect(getByText("1 of 4 albums")).toBeTruthy();
    expect(getByLabelText("Open the Japan album")).toBeTruthy();
  });

  it("opens an album by its section code", () => {
    const onOpen = vi.fn();
    const { getByLabelText } = render(
      <AlbumShelf sections={sections} counts={counts} onOpen={onOpen} />,
    );
    fireEvent.click(getByLabelText("Open the Costa Rica album"));
    expect(onOpen).toHaveBeenCalledWith("CR");
  });

  it("is a memo barrier, so an open album's page turns never re-render the hidden shelf", () => {
    expect((AlbumShelf as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
  });

  it("keeps the query across a parent re-render, since the state moved in with it", () => {
    function Host() {
      const [tick, setTick] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setTick(tick + 1)}>
            bump {tick}
          </button>
          <AlbumShelf sections={sections} counts={counts} onOpen={() => {}} />
        </div>
      );
    }
    const { getByLabelText, getByRole } = render(<Host />);
    fireEvent.change(getByLabelText("Find a country album"), { target: { value: "costa" } });
    act(() => {
      fireEvent.click(getByRole("button", { name: /bump/ }));
    });
    expect((getByLabelText("Find a country album") as HTMLInputElement).value).toBe("costa");
  });
});
