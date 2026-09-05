import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchPackDrawWithRetry } from "./pack-draw-request";

const request = { method: "POST", body: JSON.stringify({ userId: 7095193, packType: "legend" }) };
const fetchMock = vi.fn<typeof fetch>();
const busy = (seconds = "2") => Response.json(
  { error: "rate_limited", bucket: "write_pressure", retryAfterMs: 1500 },
  { status: 429, headers: { "retry-after": seconds } },
);

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("waits for the server's retry interval and repeats the same open after a pre-payment refusal", async () => {
  const dealt = Response.json({ players: [{ userId: 1 }] });
  fetchMock.mockResolvedValueOnce(busy()).mockResolvedValueOnce(dealt);
  const result = fetchPackDrawWithRetry("http://backend/api/packs/draw", request);
  await vi.advanceTimersByTimeAsync(1999);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe(dealt);
  expect(fetchMock.mock.calls).toEqual([
    ["http://backend/api/packs/draw", request],
    ["http://backend/api/packs/draw", request],
  ]);
});

it("stops after three retries and preserves the refusal for the busy screen", async () => {
  fetchMock.mockImplementation(async () => busy());
  const result = fetchPackDrawWithRetry("http://backend/api/packs/draw", request);
  await vi.runAllTimersAsync();
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(await (await result).json()).toMatchObject({ bucket: "write_pressure" });
});

it.each([
  () => busy("60"),
  () => Response.json({ error: "rate_limited" }, { status: 429 }),
  () => new Response("invalid body", { status: 429 }),
  () => Response.json({ error: "insufficient_funds" }, { status: 409 }),
  () => new Response("failed after payment", { status: 500 }),
  () => new Response("unavailable", { status: 503 }),
])("does not repeat long waits, account limits, or ambiguous failures (%#)", async (makeResponse) => {
  const response = makeResponse();
  fetchMock.mockResolvedValue(response);
  expect(await fetchPackDrawWithRetry("http://backend/api/packs/draw", request)).toBe(response);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("does not repeat an open whose response was lost, since payment may already have happened", async () => {
  fetchMock.mockRejectedValue(new TypeError("fetch failed"));
  await expect(fetchPackDrawWithRetry("http://backend/api/packs/draw", request)).rejects.toThrow("fetch failed");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
