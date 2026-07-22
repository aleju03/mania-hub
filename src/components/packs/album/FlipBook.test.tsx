// @vitest-environment jsdom
/* Two things the album's flip wrapper has to get right on a phone: it must not
   hand the engine a live fold of a page the engine would classify differently
   (that is how a drag landed on the rigid cover and made the album blink), and
   it must treat a released fold's settle as busy -- the engine stays in
   "user_fold" for the whole settle, so a flip arriving in that window used to
   snap the running turn to its last frame with no motion. */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlipBook, grabDecision, type FlipBookApi } from "./FlipBook";

describe("grabDecision", () => {
  /* Portrait: the engine's rect always spans the whole spread (width = 2 *
     pageWidth) with left = -pageWidth, so the visible page runs from bookX =
     pageWidth to 2 * pageWidth and the engine's fold-back/fold-forward boundary
     (x - pageWidth <= width / 5) lands at 1.4 * pageWidth -- 40% across the
     visible page, not at an edge. */
  const portrait = { portrait: true, rectWidth: 760, pageWidth: 380, count: 8 };
  const landscape = { portrait: false, rectWidth: 880, pageWidth: 440, count: 10 };

  it("refuses a grab whose drag direction disagrees with the region", () => {
    // Trailing region folds forward, but the finger is heading back.
    expect(grabDecision({ ...portrait, bookX: 700, deltaX: 40, index: 3 }).grab).toBe(false);
    // Leading region folds back, but the finger is heading forward.
    expect(grabDecision({ ...portrait, bookX: 400, deltaX: -40, index: 3 }).grab).toBe(false);
  });

  it("grabs an agreeing drag on a soft page, both ways", () => {
    expect(grabDecision({ ...portrait, bookX: 700, deltaX: -40, index: 3 })).toEqual({
      grab: true,
      back: false,
    });
    expect(grabDecision({ ...portrait, bookX: 400, deltaX: 40, index: 3 })).toEqual({
      grab: true,
      back: true,
    });
  });

  it("refuses the rigid covers in portrait", () => {
    // Forward off page 0 folds page 0, the hard front cover.
    expect(grabDecision({ ...portrait, bookX: 700, deltaX: -40, index: 0 }).grab).toBe(false);
    // Back from page 1 folds page 0 as well.
    expect(grabDecision({ ...portrait, bookX: 400, deltaX: 40, index: 1 }).grab).toBe(false);
    // Forward off the last slot page folds the hard back cover.
    expect(grabDecision({ ...portrait, bookX: 700, deltaX: -40, index: 7 }).grab).toBe(false);
  });

  it("refuses cover-adjacent flips in landscape, where the engine promotes them to hard", () => {
    expect(grabDecision({ ...landscape, bookX: 700, deltaX: -40, index: 0 }).grab).toBe(false);
    expect(grabDecision({ ...landscape, bookX: 200, deltaX: 40, index: 1 }).grab).toBe(false);
    expect(grabDecision({ ...landscape, bookX: 700, deltaX: -40, index: 3 }).grab).toBe(true);
    expect(grabDecision({ ...landscape, bookX: 700, deltaX: -40, index: 8 }).grab).toBe(false);
  });

  it("refuses to fold past either end of the book", () => {
    expect(grabDecision({ ...portrait, bookX: 400, deltaX: 40, index: 0 }).grab).toBe(false);
    expect(grabDecision({ ...portrait, bookX: 700, deltaX: -40, index: 7 }).grab).toBe(false);
  });

  it("classifies both sides of the boundary the way the engine does", () => {
    // 1.4 * 380 = 532: <= folds back, > folds forward. tryGrabPage passes the
    // seed point precisely so this agrees with the engine's own reading.
    expect(grabDecision({ ...portrait, bookX: 532, deltaX: 40, index: 3 }).back).toBe(true);
    expect(grabDecision({ ...portrait, bookX: 533, deltaX: -40, index: 3 }).back).toBe(false);
  });
});

/* The real engine measures the DOM and starts an animation loop it never
   cancels; in jsdom every rect is zero and the loop would leak across tests, so
   it is replaced with a scriptable stub. */
const engine = vi.hoisted(() => ({
  state: "read" as "read" | "user_fold" | "flipping",
  calculation: null as object | null,
  flips: [] as Array<{ x: number; y: number }>,
  grabs: [] as Array<{ x: number; y: number }>,
  moves: [] as Array<{ x: number; y: number }>,
  listeners: new Map<string, (event: { data: unknown }) => void>(),
}));

vi.mock("page-flip", () => {
  class PageFlipStub {
    loadFromHTML() {}
    destroy() {}
    getState() {
      return engine.state;
    }
    getPageCount() {
      return 8;
    }
    getCurrentPageIndex() {
      return 1;
    }
    getOrientation() {
      return "portrait" as const;
    }
    getRender() {
      return {
        getRect: () => ({ left: -380, top: 0, width: 760, height: 560, pageWidth: 380 }),
        getDirection: () => null,
      };
    }
    getFlipController() {
      return {
        flip: (pos: { x: number; y: number }) => {
          engine.flips.push(pos);
        },
        getCalculation: () => engine.calculation,
      };
    }
    getUI() {
      return { getDistElement: () => document.createElement("div") };
    }
    getPageCollection() {
      return {
        getCurrentSpreadIndex: () => 0,
        getSpreadIndexByPage: () => 0,
        setCurrentSpreadIndex: () => {},
      };
    }
    startUserTouch(pos: { x: number; y: number }) {
      engine.grabs.push(pos);
    }
    userMove(pos: { x: number; y: number }) {
      engine.moves.push(pos);
    }
    userStop() {}
    on(event: string, callback: (event: { data: unknown }) => void) {
      engine.listeners.set(event, callback);
      return this;
    }
    off() {
      return this;
    }
  }
  return { PageFlip: PageFlipStub };
});

async function mountBook() {
  const apiRef = { current: null as FlipBookApi | null };
  const { container } = render(
    <FlipBook pageWidth={380} pageHeight={560} minPageWidth={260} maxPageWidth={440} apiRef={apiRef}>
      <div data-album-page />
      <div data-album-page />
    </FlipBook>,
  );
  // The engine arrives through a dynamic import.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // The wrapper renders the hidden staging div, then the engine's host.
  const host = container.firstElementChild?.children[1] as HTMLElement;
  return { apiRef, host };
}

/* jsdom implements no Touch/TouchEvent, and the wrapper only reads clientX,
   clientY and the list lengths off them. */
function sendTouch(host: HTMLElement, type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { clientX: x, clientY: y };
  Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [point] });
  Object.defineProperty(event, "changedTouches", { value: [point] });
  host.dispatchEvent(event);
}

beforeEach(() => {
  engine.state = "read";
  engine.calculation = null;
  engine.flips = [];
  engine.grabs = [];
  engine.moves = [];
  engine.listeners.clear();
  /* jsdom ships no matchMedia, and the wrapper asks it whether to draw the
     page shadows. Answering "not touch" keeps these tests on the desktop path. */
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FlipBook busy guard", () => {
  it("queues a flip while a released fold settles, then runs it once the book reads", async () => {
    const { apiRef } = await mountBook();
    /* A settle: the engine never enters "flipping", but its calculation is
       live. Reaching its flip() here would call finishAnimation() first and
       snap the turn in progress. */
    engine.state = "user_fold";
    engine.calculation = {};
    act(() => {
      apiRef.current?.flipNext();
    });
    expect(engine.flips).toEqual([]);

    engine.state = "read";
    engine.calculation = null;
    act(() => {
      engine.listeners.get("changeState")?.({ data: "read" });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(engine.flips).toHaveLength(1);
  });

  it("does not deadlock in the dead user_fold the engine leaves with no calculation", async () => {
    /* Reachable today by dragging the closed cover toward the spine with a
       mouse: Flip.start() refuses the direction, so the state sticks at
       user_fold forever. A state-string busy test would wedge the arrows, the
       keyboard and the cover tap there for good. */
    const { apiRef } = await mountBook();
    engine.state = "user_fold";
    engine.calculation = null;
    act(() => {
      apiRef.current?.flipNext();
    });
    expect(engine.flips).toHaveLength(1);
  });

  it("still aims the corrected corner coordinates the engine's own flips miss", async () => {
    const { apiRef } = await mountBook();
    act(() => {
      apiRef.current?.flipPrev();
    });
    // rect.left + 10 and rect.top + 1, not the engine's (10, 1).
    expect(engine.flips).toEqual([{ x: -370, y: 1 }]);
  });
});

/* The stub's book: portrait, rect.left = -380, and a dist element that measures
   zero in jsdom, so bookX = clientX + 380 and the engine's fold-back boundary
   (bookX - 380 <= 152) sits at clientX = 152. The book is open at page 1, so a
   fold back from here would take page 0 -- the hard front cover. */
describe("FlipBook page grab", () => {
  it("takes a live fold when the drag agrees with the region", async () => {
    const { host } = await mountBook();
    sendTouch(host, "touchstart", 300, 200);
    sendTouch(host, "touchmove", 260, 200);
    // Anchored at the touch-down point, seeded 6px along the drag -- the
    // engine only starts folding once the move clears 5px from the anchor.
    expect(engine.grabs).toEqual([{ x: 300, y: 200 }]);
    expect(engine.moves[0]).toEqual({ x: 294, y: 200 });
  });

  it("refuses when the seed point falls on the other side of the boundary", async () => {
    const { host } = await mountBook();
    /* Touch down at 155 -- just forward of the boundary -- and drag forward.
       Judged by the touch-down point this is a legal forward fold of page 1,
       but the fold is seeded at 149, which the engine reads as a fold BACK,
       and back from page 1 swings the hard front cover: the album blinking
       away for a frame. Classifying the seed point is what closes it. */
    sendTouch(host, "touchstart", 155, 200);
    sendTouch(host, "touchmove", 115, 200);
    expect(engine.grabs).toEqual([]);
    expect(engine.moves).toEqual([]);
  });

  it("never grabs on a vertical drag, so the page can still scroll", async () => {
    const { host } = await mountBook();
    sendTouch(host, "touchstart", 300, 200);
    sendTouch(host, "touchmove", 292, 280);
    expect(engine.grabs).toEqual([]);
  });
});
