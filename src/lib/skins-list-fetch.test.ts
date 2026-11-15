import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./live-backend", () => ({
  getLiveBackendUrl: () => "https://api.example.test",
  getServerLiveBackendUrl: () => null,
  getAssetsBaseUrl: () => "",
}));

const { fetchSkinsListDirect, SKINS_LIST_TIMEOUT_MS } = await import("./skins");

const LIST = { skins: [], total: 0, page: 0, pageSize: 24 };

function hangingFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) => new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  })) as unknown as typeof fetch;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchSkinsListDirect", () => {
  it("asks once more when the first try hangs past the timeout", async () => {
    const hang = hangingFetch();
    const fetchMock = vi.fn()
      .mockImplementationOnce(hang)
      .mockImplementationOnce(async () => new Response(JSON.stringify(LIST), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = fetchSkinsListDirect({});
    await vi.advanceTimersByTimeAsync(SKINS_LIST_TIMEOUT_MS + 1);
    await expect(result).resolves.toEqual(LIST);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after two hung tries so the page can show its failed state", async () => {
    const fetchMock = vi.fn(hangingFetch());
    vi.stubGlobal("fetch", fetchMock);

    const result = fetchSkinsListDirect({});
    const settled = expect(result).rejects.toThrow("took too long");
    await vi.advanceTimersByTimeAsync(2 * SKINS_LIST_TIMEOUT_MS + 2);
    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the caller leaves", async () => {
    const fetchMock = vi.fn(hangingFetch());
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const result = fetchSkinsListDirect({}, { signal: controller.signal });
    const settled = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
