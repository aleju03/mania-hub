import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { drawSkinPreviewPatterns, PatternDealer, type SkinPreviewChartSnippet } from "./skin-preview-patterns";
import { getLiveBackendUrl } from "./live-backend";

vi.mock("./live-backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./live-backend")>()),
  getLiveBackendUrl: vi.fn(() => "https://live.test"),
}));

const backendUrl = vi.mocked(getLiveBackendUrl);
const fetchMock = vi.fn();

function snippet(beatmapId: number, keys = 4): SkinPreviewChartSnippet {
  return {
    beatmapId,
    keys,
    label: `artist ${beatmapId} - title [${keys}K]`,
    stars: 6,
    notes: [{ column: 0, time: 0, endTime: 0 }],
  };
}

function respond(patterns: SkinPreviewChartSnippet[]): Response {
  return { ok: true, json: async () => ({ patterns }) } as Response;
}

beforeEach(() => {
  backendUrl.mockReturnValue("https://live.test");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("drawSkinPreviewPatterns", () => {
  it("asks the backend for one keymode and passes on what is already on offer", async () => {
    fetchMock.mockResolvedValue(respond([snippet(11), snippet(12)]));

    const pool = await drawSkinPreviewPatterns({ keys: 7, count: 4, exclude: [99] });

    expect(pool.map((entry) => entry.beatmapId)).toEqual([11, 12]);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/skins/preview-patterns");
    expect(url.searchParams.get("keys")).toBe("7");
    expect(url.searchParams.get("count")).toBe("4");
    expect(url.searchParams.get("exclude")).toBe("99");
  });

  it("leaves out snippets with no notes in them", async () => {
    fetchMock.mockResolvedValue(respond([{ ...snippet(21), notes: [] }, snippet(22)]));

    expect((await drawSkinPreviewPatterns({ keys: 4 })).map((entry) => entry.beatmapId)).toEqual([22]);
  });

  it("is an empty pool, not a throw, when the backend is missing or refuses", async () => {
    backendUrl.mockReturnValue(null);
    await expect(drawSkinPreviewPatterns({ keys: 4 })).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    backendUrl.mockReturnValue("https://live.test");
    fetchMock.mockResolvedValue({ ok: false, status: 429 } as Response);
    await expect(drawSkinPreviewPatterns({ keys: 4 })).resolves.toEqual([]);

    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(drawSkinPreviewPatterns({ keys: 4 })).resolves.toEqual([]);
  });
});

describe("PatternDealer", () => {
  it("draws a keymode's pool once and deals every chart before repeating one", async () => {
    fetchMock.mockResolvedValue(respond([snippet(1), snippet(2), snippet(3)]));
    const dealer = new PatternDealer();

    const dealt = [
      await dealer.next(4),
      await dealer.next(4),
      await dealer.next(4),
    ].map((entry) => entry?.beatmapId);

    expect(new Set(dealt)).toEqual(new Set([1, 2, 3]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A fourth ask reshuffles the same pool rather than drawing again.
    expect(await dealer.next(4)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps one pool per keymode and shares an in-flight draw", async () => {
    fetchMock.mockImplementation(async (input: string | URL) => {
      const keys = new URL(String(input)).searchParams.get("keys");
      return respond([snippet(Number(keys) * 100, Number(keys))]);
    });
    const dealer = new PatternDealer();

    const [four, seven, alsoFour] = await Promise.all([dealer.next(4), dealer.next(7), dealer.next(4)]);

    expect(four?.keys).toBe(4);
    expect(seven?.keys).toBe(7);
    // The 4K pool holds one chart, so the racing ask deals the same one rather
    // than firing a second request.
    expect(alsoFour?.beatmapId).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("deals nothing for a keymode the backend has no charts for", async () => {
    fetchMock.mockResolvedValue(respond([]));
    const dealer = new PatternDealer();

    expect(await dealer.next(9)).toBeNull();
  });
});
