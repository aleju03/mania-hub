// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManiaRain } from "./ManiaRain";

const activity = vi.hoisted(() => ({ active: true, changed: () => {} }));
vi.mock("../../lib/window-activity", () => ({
  isWindowActive: () => activity.active,
  subscribeWindowActivity: (changed: () => void) => {
    activity.changed = changed;
    return () => { activity.changed = () => {}; };
  },
}));
vi.mock("../../lib/cursor", () => ({
  readCursorSettings: () => ({ enabled: false }),
  subscribeCursorSettings: () => () => {},
  segmentHitsCircle: () => false,
}));

let rect: DOMRect;
let now: number;
let nextFrame: number;
let frames: Map<number, FrameRequestCallback>;
let contexts: WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>;
let reduced: boolean;
let motionChanged: () => void;

function frame(time: number): void {
  now = time;
  const pending = [...frames.values()];
  frames.clear();
  act(() => { for (const callback of pending) callback(time); });
}

beforeEach(() => {
  rect = new DOMRect(0, 60, 1440, 6000);
  now = 0;
  nextFrame = 0;
  frames = new Map();
  contexts = new WeakMap();
  reduced = false;
  motionChanged = () => {};
  activity.active = true;
  vi.stubGlobal("innerHeight", 900);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return reduced; },
    addEventListener: (_event: string, listener: () => void) => { motionChanged = listener; },
    removeEventListener: () => { motionChanged = () => {}; },
  }));
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => rect);
  // This component uses only 2D contexts; canvas also declares WebGL/WebGPU overloads.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    let context = contexts.get(this);
    if (!context) {
      context = new Proxy({} as CanvasRenderingContext2D, {
        get(target, key) {
          const record = target as unknown as Record<string | symbol, unknown>;
          return record[key] ??= vi.fn();
        },
      });
      contexts.set(this, context);
    }
    return context;
  } as unknown as HTMLCanvasElement["getContext"]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ManiaRain viewport", () => {
  it("keeps a viewport-sized bitmap while following document-space positions on scroll", () => {
    const view = render(<div><ManiaRain /></div>);
    const canvas = view.container.querySelector("canvas")!;
    const context = contexts.get(canvas)!;
    expect(canvas.width).toBe(1440);
    expect(canvas.height).toBe(900);
    rect = new DOMRect(0, -2940, 1440, 6000);
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(canvas.height).toBe(900);
    expect(canvas.style.top).toBe("2940px");
    expect(context.setTransform).toHaveBeenLastCalledWith(1, 0, 0, 1, 0, -2940);

    rect = new DOMRect(0, -5800, 1440, 6000);
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(canvas.style.top).toBe("5100px");
    expect(canvas.height).toBe(900);

    rect = new DOMRect(0, 60, 1440, 300);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(canvas.height).toBe(300);
    expect(canvas.style.top).toBe("0px");
  });

  it("limits decorative redraws and stops while out of view, inactive, or reduced-motion", () => {
    const view = render(<div><ManiaRain /></div>);
    const canvas = view.container.querySelector("canvas")!;
    const clear = vi.mocked(contexts.get(canvas)!.clearRect);
    clear.mockClear();
    frame(16);
    frame(34);
    frame(50);
    frame(68);
    expect(clear).toHaveBeenCalledTimes(2);

    rect = new DOMRect(0, -6100, 1440, 6000);
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(frames.size).toBe(0);
    rect = new DOMRect(0, 60, 1440, 6000);
    act(() => window.dispatchEvent(new Event("scroll")));
    expect(frames.size).toBe(1);
    activity.active = false;
    act(() => activity.changed());
    expect(frames.size).toBe(0);
    activity.active = true;
    act(() => activity.changed());
    expect(frames.size).toBe(1);

    reduced = true;
    act(() => motionChanged());
    expect(frames.size).toBe(0);
    reduced = false;
    act(() => motionChanged());
    expect(frames.size).toBe(1);
    view.unmount();
    expect(frames.size).toBe(0);
  });
});
