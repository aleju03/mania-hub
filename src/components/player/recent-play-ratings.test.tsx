// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchLiveRecentPlayRatingsDirect, isLiveBackendConfigured, openLiveEventSource } from "#/lib/live-backend";
import type { OsuScore } from "#/lib/types";
import { useRecentPlayRatingLookup } from "./recent-play-ratings";

vi.mock("#/lib/live-backend", () => ({
  fetchLiveRecentPlayRatingsDirect: vi.fn(),
  isLiveBackendConfigured: vi.fn(() => true),
  openLiveEventSource: vi.fn(),
}));
const fetchRatings = vi.mocked(fetchLiveRecentPlayRatingsDirect);
let userId = 0;
let source: EventTarget & { close: ReturnType<typeof vi.fn> };
const pending = { msd: null, dan: null, pending: true as const, missing: { msd: "pending" as const, dan: "pending" as const },
  jobs: [{ id: 123, runAfter: "2026-09-23T00:30:00Z" }] };
const jobEvent = (payload: object) => act(() => { source.dispatchEvent(new MessageEvent("job_status", { data: JSON.stringify(payload) })); });
const score = (id: number) => ({ id, beatmap: { id: 10, cs: 4 }, mods: [] }) as unknown as OsuScore;
const rated = { msd: 25, dan: null };
const imported = { ...score(3), ended_at: "2000-01-01T00:00:00Z", companella: { importId: "old-replay-import", replay: false } };
const flush = () => act(async () => { await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
function visibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}
beforeEach(() => {
  userId++;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T00:00:00Z"));
  visibility("visible");
  fetchRatings.mockReset().mockImplementation(async (_user, plays) => ({
    items: Object.fromEntries(plays.map((play) => [play.scoreId, rated])), imports: {},
  }));
  vi.mocked(isLiveBackendConfigured).mockReturnValue(true);
  source = Object.assign(new EventTarget(), { close: vi.fn() });
  vi.mocked(openLiveEventSource).mockReset().mockReturnValue(source as unknown as NonNullable<ReturnType<typeof openLiveEventSource>>);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("does no work when disabled, unconfigured or hidden, and has no ordinary-play timer", async () => {
  const hook = renderHook(({ enabled }) => useRecentPlayRatingLookup(userId, [score(1)], enabled), { initialProps: { enabled: false } });
  expect(fetchRatings).not.toHaveBeenCalled();
  vi.mocked(isLiveBackendConfigured).mockReturnValue(false);
  hook.rerender({ enabled: true });
  expect(fetchRatings).not.toHaveBeenCalled();
  hook.rerender({ enabled: false });
  vi.mocked(isLiveBackendConfigured).mockReturnValue(true);
  visibility("hidden");
  hook.rerender({ enabled: true });
  expect(fetchRatings).not.toHaveBeenCalled();
  visibility("visible");
  await flush();
  expect(fetchRatings).toHaveBeenCalledTimes(1);
  expect(hook.result.current.get("1")).toEqual(rated);
  expect(vi.getTimerCount()).toBe(0);
  await advance(30 * 60_000);
  expect(fetchRatings).toHaveBeenCalledTimes(1);
});

it("fetches only added rows, reuses recent answers and expires completed ratings on reopening", async () => {
  const hook = renderHook(({ scores, enabled }) => useRecentPlayRatingLookup(userId, scores, enabled), {
    initialProps: { scores: [score(1)], enabled: true },
  });
  await flush();
  hook.rerender({ scores: [score(1), score(2)], enabled: true });
  await flush();
  expect(fetchRatings.mock.calls[1][1].map((play) => play.scoreId)).toEqual([2]);
  hook.rerender({ scores: [score(1)], enabled: false });
  expect(hook.result.current.size).toBe(0);
  hook.rerender({ scores: [score(1)], enabled: true });
  await flush();
  expect(fetchRatings).toHaveBeenCalledTimes(2);
  await advance(10 * 60_000);
  hook.rerender({ scores: [score(1)], enabled: false });
  hook.rerender({ scores: [score(1)], enabled: true });
  await flush();
  expect(fetchRatings).toHaveBeenCalledTimes(3);
  expect(fetchRatings.mock.calls[2][3]?.fresh).toBe(true);
});

it("retries a pending old import only while visible and stops when ready", async () => {
  fetchRatings.mockResolvedValue({ items: {}, imports: { "old-replay-import": { msd: null, dan: null, pending: true } } });
  const hook = renderHook(() => useRecentPlayRatingLookup(userId, [imported], true));
  await flush();
  visibility("hidden");
  expect(vi.getTimerCount()).toBe(0);
  await advance(60_000);
  expect(fetchRatings).toHaveBeenCalledTimes(1);
  fetchRatings.mockResolvedValue({ items: {}, imports: { "old-replay-import": rated } });
  visibility("visible");
  await flush();
  expect(fetchRatings).toHaveBeenCalledTimes(2);
  expect(hook.result.current.get("import:old-replay-import")).toEqual(rated);
  expect(vi.getTimerCount()).toBe(0);
});

it("sleeps through a scheduled session wait and refreshes only the affected play when its job finishes", async () => {
  fetchRatings.mockResolvedValue({ items: { "1": pending, "2": rated }, imports: {} });
  const hook = renderHook(() => useRecentPlayRatingLookup(userId, [score(1), score(2)], true));
  await flush();
  await advance(29 * 60_000);
  expect(fetchRatings).toHaveBeenCalledTimes(1);
  jobEvent({ id: 456, status: "done" });
  await advance(1);
  expect(fetchRatings).toHaveBeenCalledTimes(1);
  fetchRatings.mockResolvedValue({ items: { "1": rated }, imports: {} });
  jobEvent({ id: 123, status: "done" });
  await advance(1);
  expect(fetchRatings.mock.calls[1][1].map((play) => play.scoreId)).toEqual([1]);
  expect(fetchRatings.mock.calls[1][3]?.fresh).toBe(true);
  expect(hook.result.current.get("1")).toEqual(rated);
  expect(vi.getTimerCount()).toBe(0);
});

it("waits out the origin cache after a fast completion and coalesces repeated events", async () => {
  fetchRatings.mockResolvedValue({ items: { "1": pending }, imports: {} });
  renderHook(() => useRecentPlayRatingLookup(userId, [score(1)], true));
  await flush();
  jobEvent({ id: 123, status: "done" });
  jobEvent({ id: 123, status: "done" });
  await advance(30_000);
  expect(fetchRatings).toHaveBeenCalledTimes(1);
  fetchRatings.mockResolvedValue({ items: { "1": rated }, imports: {} });
  await advance(1_000);
  expect(fetchRatings).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not lose a completion that arrives while the first pending snapshot is in flight", async () => {
  let resolve!: (result: Awaited<ReturnType<typeof fetchLiveRecentPlayRatingsDirect>>) => void;
  fetchRatings.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const hook = renderHook(() => useRecentPlayRatingLookup(userId, [score(1)], true));
  jobEvent({ id: 123, status: "done" });
  await act(async () => { resolve({ items: { "1": pending }, imports: {} }); });
  fetchRatings.mockResolvedValue({ items: { "1": rated }, imports: {} });
  await advance(31_000);
  expect(fetchRatings).toHaveBeenCalledTimes(2);
  expect(hook.result.current.get("1")).toEqual(rated);
});

it("recovers a missed event after work is due and stops when analysis is no longer scheduled", async () => {
  fetchRatings.mockResolvedValue({ items: { "1": pending }, imports: {} });
  const hook = renderHook(() => useRecentPlayRatingLookup(userId, [score(1)], true));
  await flush();
  const unavailable = { msd: null, dan: null, missing: { msd: "not_retained" as const, dan: "not_analyzed" as const } };
  fetchRatings.mockResolvedValue({ items: { "1": unavailable }, imports: {} });
  await advance(31 * 60_000);
  expect(fetchRatings).toHaveBeenCalledTimes(2);
  expect(hook.result.current.get("1")).toEqual(unavailable);
  expect(vi.getTimerCount()).toBe(0);
});

it("updates a play when a new skill job completes after the initial unavailable result", async () => {
  const hook = renderHook(() => useRecentPlayRatingLookup(userId, [score(1)], true));
  await flush();
  await advance(60_000);
  fetchRatings.mockResolvedValue({ items: { "1": { ...rated, msd: 30 } }, imports: {} });
  jobEvent({ id: 456, type: "compute_player_skills", userId: userId + 1, status: "done" });
  await advance(1);
  expect(fetchRatings).toHaveBeenCalledTimes(1);
  jobEvent({ id: 456, type: "compute_player_skills", userId, status: "done" });
  await advance(1);
  expect(hook.result.current.get("1")?.msd).toBe(30);
});

it("shows a retryable error for every unfetched batch instead of leaving loading cells", async () => {
  fetchRatings.mockRejectedValueOnce(new Error("offline"));
  const hook = renderHook(() => useRecentPlayRatingLookup(userId, Array.from({ length: 101 }, (_, i) => score(i + 1)), true));
  await flush();
  expect(hook.result.current.get("1")?.loadError).toBe(true);
  expect(hook.result.current.get("101")?.loadError).toBe(true);
  await act(async () => { hook.result.current.get("1")?.onRetry?.(); });
  expect(hook.result.current.get("1")).toEqual(rated);
  expect(hook.result.current.get("101")).toEqual(rated);
});

it("does not cache a late response after cancellation", async () => {
  let resolve!: (result: Awaited<ReturnType<typeof fetchLiveRecentPlayRatingsDirect>>) => void;
  fetchRatings.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const first = renderHook(() => useRecentPlayRatingLookup(userId, [score(1)], true));
  first.unmount();
  expect(fetchRatings.mock.calls[0][3]?.signal?.aborted).toBe(true);
  await act(async () => { resolve({ items: { "1": rated }, imports: {} }); });
  renderHook(() => useRecentPlayRatingLookup(userId, [score(1)], true));
  await flush();
  expect(fetchRatings).toHaveBeenCalledTimes(2);
});

it("deduplicates rows, batches at 100, and ignores renders with unchanged input", async () => {
  const scores = [...Array.from({ length: 101 }, (_, index) => score(index + 1)), score(1)];
  const hook = renderHook(() => useRecentPlayRatingLookup(userId, [...scores], true));
  await flush();
  expect(fetchRatings.mock.calls.map((call) => call[1].length)).toEqual([100, 1]);
  hook.rerender();
  await flush();
  expect(fetchRatings).toHaveBeenCalledTimes(2);
});

it("evicts older profiles instead of retaining every visited user's scores", async () => {
  const firstUser = userId;
  const hook = renderHook(({ id }) => useRecentPlayRatingLookup(id, [score(1)], true), { initialProps: { id: firstUser } });
  await flush();
  for (let i = 0; i < 20; i++) {
    hook.rerender({ id: ++userId });
    await flush();
  }
  hook.rerender({ id: firstUser });
  await flush();
  expect(fetchRatings).toHaveBeenCalledTimes(22);
});
