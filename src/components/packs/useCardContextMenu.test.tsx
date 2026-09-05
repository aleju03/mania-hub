// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCardContextMenu } from "./useCardContextMenu";

function Card({ open, tap }: { open: () => void; tap: () => void }) {
  const contextMenu = useCardContextMenu();
  return <div {...contextMenu(open)}><button onClick={tap}>Card</button></div>;
}

const touch = { identifier: 1, clientX: 100, clientY: 100 };
const start = (card: HTMLElement) => fireEvent.touchStart(card, { touches: [touch] });
const hold = () => act(() => { vi.advanceTimersByTime(500); });

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("opens on a touch hold without a native contextmenu and consumes its release", () => {
  const open = vi.fn();
  const tap = vi.fn();
  render(<Card open={open} tap={tap} />);
  const card = screen.getByRole("button");
  start(card);
  hold();
  expect(open).toHaveBeenCalledExactlyOnceWith(100, 100);
  fireEvent.contextMenu(card, { clientX: 100, clientY: 100 });
  expect(open).toHaveBeenCalledTimes(1);
  expect(fireEvent.touchEnd(card, { touches: [] })).toBe(false);
  fireEvent.click(card, { detail: 1 });
  expect(tap).not.toHaveBeenCalled();

  start(card);
  expect(fireEvent.touchEnd(card, { touches: [] })).toBe(true);
  fireEvent.click(card, { detail: 1 });
  expect(tap).toHaveBeenCalledTimes(1);
});

it.each(["move", "cancel", "scroll", "multitouch", "release", "unmount"])(
  "cancels a pending hold on %s", (reason) => {
    const open = vi.fn();
    const { unmount } = render(<Card open={open} tap={() => {}} />);
    const card = screen.getByRole("button");
    start(card);
    if (reason === "move") fireEvent.touchMove(card, { touches: [{ ...touch, clientY: 120 }] });
    if (reason === "cancel") fireEvent.touchCancel(card);
    if (reason === "scroll") fireEvent.scroll(window);
    if (reason === "multitouch") fireEvent.touchStart(card, { touches: [touch, { ...touch, identifier: 2 }] });
    if (reason === "release") fireEvent.touchEnd(card, { touches: [] });
    if (reason === "unmount") unmount();
    hold();
    expect(open).not.toHaveBeenCalled();
  },
);

it("preserves desktop right-click and ordinary tap/keyboard activation", () => {
  const open = vi.fn();
  const tap = vi.fn();
  render(<Card open={open} tap={tap} />);
  const card = screen.getByRole("button");
  expect(fireEvent.contextMenu(card, { clientX: 20, clientY: 30 })).toBe(false);
  expect(open).toHaveBeenCalledExactlyOnceWith(20, 30);
  start(card);
  fireEvent.touchEnd(card, { touches: [] });
  hold();
  fireEvent.click(card, { detail: 1 });
  fireEvent.click(card, { detail: 0 });
  expect(open).toHaveBeenCalledTimes(1);
  expect(tap).toHaveBeenCalledTimes(2);
});

it("opens only once when Android's native menu event beats the hold timer", () => {
  const open = vi.fn();
  render(<Card open={open} tap={() => {}} />);
  const card = screen.getByRole("button");
  start(card);
  act(() => { vi.advanceTimersByTime(400); });
  fireEvent.contextMenu(card, { clientX: 100, clientY: 100 });
  hold();
  expect(open).toHaveBeenCalledExactlyOnceWith(100, 100);
  expect(fireEvent.contextMenu(document.body)).toBe(false);
  expect(fireEvent.touchEnd(card, { touches: [] })).toBe(false);
});

it.each(["pointerdown", "touchstart", "keydown", "unmount"])(
  "releases the document gesture guard on %s", (reason) => {
    const { unmount } = render(<Card open={() => {}} tap={() => {}} />);
    start(screen.getByRole("button"));
    hold();
    expect(fireEvent.contextMenu(document.body)).toBe(false);
    expect(fireEvent.click(document.body, { detail: 1 })).toBe(false);
    if (reason === "pointerdown") fireEvent.pointerDown(document.body);
    if (reason === "touchstart") fireEvent.touchStart(document.body);
    if (reason === "keydown") fireEvent.keyDown(document.body, { key: "Escape" });
    if (reason === "unmount") unmount();
    expect(fireEvent.contextMenu(document.body)).toBe(true);
    expect(fireEvent.click(document.body, { detail: 1 })).toBe(true);
  },
);
