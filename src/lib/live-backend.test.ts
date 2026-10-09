import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchLiveChartAnalysis,
  fetchLiveLocalChartEntry,
  isLocalChartId,
  loadLiveMapSearchEntry,
  packCollectorLabel,
  packCollectorLookupSpecs,
  packCollectorParam,
  parsePackCollectorParam,
} from "./live-backend";

describe("packCollectorParam", () => {
  it("links by name, which is what people paste", () => {
    expect(packCollectorParam({ userId: 2531335, username: "Aleju03" })).toBe("Aleju03");
  });

  it("links by id when the collector is only labelled `user <id>`", () => {
    // The placeholder the backend prints for a collector it cannot name. It
    // resolves to nobody, so the shelf 404s as "has not opened a pack".
    expect(packCollectorParam({ userId: 16308062, username: "user 16308062" })).toBe("16308062");
  });

  it("keeps a real name that only looks like the placeholder", () => {
    expect(packCollectorParam({ userId: 99, username: "user 16308062" })).toBe("user 16308062");
  });

  it("falls back to the id on an empty name", () => {
    expect(packCollectorParam({ userId: 7, username: "" })).toBe("7");
  });

  it("marks numeric-only usernames so they are not mistaken for ids", () => {
    expect(packCollectorParam({ userId: 12345678, username: "080106" })).toBe("name:080106");
  });
});

describe("parsePackCollectorParam", () => {
  it("keeps legacy numeric links as ids", () => {
    expect(parsePackCollectorParam("2531335")).toEqual({ userId: 2531335 });
    expect(packCollectorLookupSpecs("2531335")).toEqual([
      { userId: 2531335 },
      { username: "2531335" },
    ]);
  });

  it("resolves explicitly marked numeric usernames by name", () => {
    expect(parsePackCollectorParam("name:080106")).toEqual({ username: "080106" });
    expect(packCollectorLookupSpecs("name:080106")).toEqual([{ username: "080106" }]);
    expect(packCollectorLabel("name:080106")).toBe("080106");
  });

  it("continues resolving ordinary usernames by name", () => {
    expect(parsePackCollectorParam("Aleju03")).toEqual({ username: "Aleju03" });
  });
});

describe("local chart entries", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function stubBackend(response: () => Response) {
    vi.stubEnv("VITE_LIVE_BACKEND_URL", "https://live.test");
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("reads only negative ids as local charts", () => {
    expect(isLocalChartId(-5)).toBe(true);
    expect(isLocalChartId(0)).toBe(false);
    expect(isLocalChartId(101)).toBe(false);
    expect(isLocalChartId(undefined)).toBe(false);
    expect(isLocalChartId(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it("loads a negative id from the local chart endpoint, not the catalog", async () => {
    const fetchMock = stubBackend(() => Response.json({ entry: { beatmapId: -7001, status: "local" } }));
    const entry = await loadLiveMapSearchEntry(-7001);
    expect(entry).toMatchObject({ beatmapId: -7001, status: "local" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://live.test/api/companella/local-charts/-7001");
    // Memoized: the second read answers from memory.
    await fetchLiveLocalChartEntry(-7001);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads a 404 from the local chart endpoint as no entry", async () => {
    stubBackend(() => new Response("{}", { status: 404 }));
    await expect(fetchLiveLocalChartEntry(-7002)).resolves.toBeNull();
  });

  it("never asks the local chart endpoint for an official id", async () => {
    const fetchMock = stubBackend(() => Response.json({ entry: null }));
    await expect(fetchLiveLocalChartEntry(101)).resolves.toBeNull();
    await expect(fetchLiveLocalChartEntry(0)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips the stored chart analysis for a local chart", async () => {
    const fetchMock = stubBackend(() => Response.json({}));
    await expect(fetchLiveChartAnalysis(-7003)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
