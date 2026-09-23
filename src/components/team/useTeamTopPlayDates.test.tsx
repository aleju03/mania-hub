// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchLiveTeamTopPlayDatesDirect, openLiveEventSource, type LiveTeamTopPlayDates } from "../../lib/live-backend";
import { useTeamTopPlayDates } from "./useTeamTopPlayDates";

vi.mock("../../lib/live-backend", () => ({ fetchLiveTeamTopPlayDatesDirect: vi.fn(), openLiveEventSource: vi.fn() }));
const fetchDates = vi.mocked(fetchLiveTeamTopPlayDatesDirect);
const listeners = new Map<string, (event: MessageEvent) => void>();
const close = vi.fn(() => listeners.clear());
const pair = (id: number, teamId = 1): LiveTeamTopPlayDates => ({ teamId,
  newestTopPlay: { id } as NonNullable<LiveTeamTopPlayDates["newestTopPlay"]>, oldestTopPlay: null });
const flush = () => act(async () => { await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const emit = (type: string, payload: unknown) => act(() => listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(payload) })));
function visibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T00:00:00Z"));
  vi.clearAllMocks();
  listeners.clear();
  visibility("visible");
  fetchDates.mockReset().mockResolvedValue(pair(1));
  vi.mocked(openLiveEventSource).mockReturnValue({
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => listeners.set(type, listener), close,
  } as unknown as NonNullable<ReturnType<typeof openLiveEventSource>>);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("reads once on entry, uses a shared global observer, and never polls an idle page", async () => {
  const hook = renderHook(() => useTeamTopPlayDates(1, [42], true));
  await flush();
  expect(hook.result.current?.newestTopPlay?.id).toBe(1);
  expect(openLiveEventSource).toHaveBeenCalledWith("GLOBAL", { observe: true });
  await advance(10 * 60_000);
  expect(fetchDates).toHaveBeenCalledTimes(1);
  emit("tracker_score", { user_id: 99 });
  await advance(5_000);
  expect(fetchDates).toHaveBeenCalledTimes(1);
});

it("coalesces member score bursts and accepts both tracker and confirmed top-play events", async () => {
  const hook = renderHook(() => useTeamTopPlayDates(1, [42], true));
  await flush();
  fetchDates.mockResolvedValue(pair(2));
  for (let i = 0; i < 10; i++) emit("tracker_score", { user_id: 42 });
  await advance(2_999);
  expect(fetchDates).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(fetchDates).toHaveBeenCalledTimes(2);
  expect(hook.result.current?.newestTopPlay?.id).toBe(2);
  fetchDates.mockResolvedValue(pair(3));
  emit("top_play", { user: { id: 42 }, score: { user_id: 42 } });
  await advance(3_000);
  expect(hook.result.current?.newestTopPlay?.id).toBe(3);
});

it("holds updates while hidden and catches up on visibility/reconnect without a polling timer", async () => {
  visibility("hidden");
  renderHook(() => useTeamTopPlayDates(1, [42], true));
  emit("tracker_score", { user_id: 42 });
  await advance(60_000);
  expect(fetchDates).not.toHaveBeenCalled();
  visibility("visible");
  await advance(150);
  expect(fetchDates).toHaveBeenCalledTimes(1);
  emit("hello", {});
  await advance(3_000);
  expect(fetchDates).toHaveBeenCalledTimes(2);
  await advance(60_000);
  expect(fetchDates).toHaveBeenCalledTimes(2);
});

it("preserves events arriving during a read and does not publish that stale response", async () => {
  let resolve!: (value: LiveTeamTopPlayDates) => void;
  fetchDates.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const hook = renderHook(() => useTeamTopPlayDates(1, [42], true));
  emit("tracker_score", { user_id: 42 });
  await act(async () => resolve(pair(1)));
  expect(hook.result.current).toBeNull();
  fetchDates.mockResolvedValue(pair(2));
  await advance(3_000);
  expect(hook.result.current?.newestTopPlay?.id).toBe(2);
});

it("keeps the last pair on failure and aborts pending work when leaving", async () => {
  const hook = renderHook(() => useTeamTopPlayDates(1, [42], true));
  await flush();
  fetchDates.mockRejectedValue(new Error("offline"));
  emit("tracker_score", { user_id: 42 });
  await advance(3_000);
  expect(hook.result.current?.newestTopPlay?.id).toBe(1);
  await advance(60_000);
  expect(fetchDates).toHaveBeenCalledTimes(2);
  emit("tracker_score", { user_id: 42 });
  const signal = fetchDates.mock.calls[0][1]!;
  hook.unmount();
  expect(signal.aborted).toBe(true);
  expect(close).toHaveBeenCalledOnce();
  await advance(5_000);
  expect(fetchDates).toHaveBeenCalledTimes(2);
});

it("does nothing before the full profile is ready and drops the previous team's pair on navigation", async () => {
  const hook = renderHook(({ teamId, enabled }) => useTeamTopPlayDates(teamId, [42], enabled), { initialProps: { teamId: 1, enabled: false } });
  expect(fetchDates).not.toHaveBeenCalled();
  hook.rerender({ teamId: 1, enabled: true });
  await flush();
  fetchDates.mockImplementation(() => new Promise(() => {}));
  hook.rerender({ teamId: 2, enabled: true });
  expect(hook.result.current).toBeNull();
  expect(close).toHaveBeenCalledOnce();
});
