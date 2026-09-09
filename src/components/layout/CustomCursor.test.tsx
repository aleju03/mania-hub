// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DEFAULT_CURSOR_SETTINGS, writeCursorSettings } from "../../lib/cursor";
import { CustomCursor } from "./CustomCursor";

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const context = {
  createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
  beginPath: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  scale: vi.fn(),
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  drawImage: vi.fn(),
};
const encodedSizes: number[] = [];
const root = document.documentElement;
const cursor = () => root.style.getPropertyValue("--custom-cursor");

function drawFrame(time: number) {
  const pending = [...frames.values()];
  frames.clear();
  act(() => pending.forEach((callback) => callback(time)));
}

function movePointer() {
  const event = new MouseEvent("pointermove", { clientX: 120, clientY: 80 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  fireEvent(window, event);
}

beforeEach(() => {
  frames.clear();
  encodedSizes.length = 0;
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    (() => context) as unknown as HTMLCanvasElement["getContext"],
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (this: HTMLCanvasElement) {
    encodedSizes.push(this.width);
    return `data:image/png;base64,${encodedSizes.length}`;
  });
  writeCursorSettings({ ...DEFAULT_CURSOR_SETTINGS, enabled: true, trail: false });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("uses a native cursor without waiting for frames and never paints a second cursor", () => {
  render(<CustomCursor />);
  expect(root.dataset.customCursor).toBe("true");
  expect(cursor()).toMatch(/^url\("data:image\/png;base64,1"\) \d+ \d+, auto$/);
  // The black-screen workaround must remain: no desynchronized canvas context.
  for (const args of vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls) {
    expect(args).toEqual(["2d"]);
  }

  movePointer();
  drawFrame(16);
  expect(context.drawImage).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
});

it("switches the pressed image immediately and releases it on blur", () => {
  render(<CustomCursor />);
  const normal = cursor();
  fireEvent.pointerDown(window);
  expect(cursor()).not.toBe(normal);
  fireEvent.pointerUp(window);
  expect(cursor()).toBe(normal);
  fireEvent.pointerDown(window);
  fireEvent.blur(window);
  expect(cursor()).toBe(normal);
});

it("keeps even the largest pressed cursor within native image limits and updates settings", () => {
  writeCursorSettings({ ...DEFAULT_CURSOR_SETTINGS, enabled: true, size: 200, glow: 100 });
  render(<CustomCursor />);
  expect(encodedSizes).toEqual([128, 128]);
  expect(cursor()).toContain("64 64, auto");
  const previous = cursor();
  act(() => writeCursorSettings({ ...DEFAULT_CURSOR_SETTINGS, enabled: true, color: "#66baff" }));
  expect(cursor()).not.toBe(previous);
  expect(encodedSizes.every((size) => size <= 128)).toBe(true);
});

it("keeps the trail animated, then stops rendering once it has faded", () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  writeCursorSettings({ ...DEFAULT_CURSOR_SETTINGS, enabled: true });
  render(<CustomCursor />);
  movePointer();
  drawFrame(16);
  expect(context.drawImage).toHaveBeenCalledOnce();
  expect(frames.size).toBe(1);
  now = 300;
  drawFrame(now);
  expect(frames.size).toBe(0);
});

it("restores the normal browser cursor and stops effects when disabled", () => {
  render(<CustomCursor />);
  act(() => writeCursorSettings(DEFAULT_CURSOR_SETTINGS));
  expect(root.dataset.customCursor).toBeUndefined();
  expect(cursor()).toBe("");
  expect(frames.size).toBe(0);
});

it("leaves the browser cursor available if canvas initialization fails", () => {
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
  render(<CustomCursor />);
  expect(root.dataset.customCursor).toBeUndefined();
  expect(cursor()).toBe("");
});
