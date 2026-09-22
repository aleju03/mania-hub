import { afterEach, describe, expect, it, vi } from "vitest";

const { restrictedPpReplayUrl, parseUploadedReplayBuffer } = vi.hoisted(() => ({
  restrictedPpReplayUrl: vi.fn(),
  parseUploadedReplayBuffer: vi.fn(),
}));
vi.mock("./live-backend", () => ({ restrictedPpReplayUrl }));
vi.mock("./replay-upload", () => ({ parseUploadedReplayBuffer }));

import { fetchRestrictedPpReplay, pickRestrictedPpReplayChart } from "./restricted-pp-replay";
import type { UploadedReplayBeatmapResolution } from "./uploaded-replay-payload";

const IMPORT_ID = "imp_0123456789";
const URL_FOR_IMPORT = `https://live.example/api/integrations/companella/public/replays/${IMPORT_ID}`;

function resolution(overrides: Partial<UploadedReplayBeatmapResolution>): UploadedReplayBeatmapResolution {
  return { meta: null, file: null, community: null, ...overrides };
}

describe("fetchRestrictedPpReplay", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("downloads the public .osr and parses it in the browser", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const parsed = { replay: { header: { beatmapHash: "a".repeat(32) } }, mods: [], scoreId: null };
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    restrictedPpReplayUrl.mockReturnValue(URL_FOR_IMPORT);
    parseUploadedReplayBuffer.mockResolvedValue(parsed);

    await expect(fetchRestrictedPpReplay(IMPORT_ID)).resolves.toBe(parsed);
    expect(restrictedPpReplayUrl).toHaveBeenCalledWith(IMPORT_ID);
    expect(fetchMock).toHaveBeenCalledWith(URL_FOR_IMPORT, expect.objectContaining({ credentials: "omit" }));
    expect(new Uint8Array(parseUploadedReplayBuffer.mock.calls[0][0])).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("returns null when the play is not public", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "not_found" }), { status: 404 })));
    restrictedPpReplayUrl.mockReturnValue(URL_FOR_IMPORT);

    await expect(fetchRestrictedPpReplay(IMPORT_ID)).resolves.toBeNull();
    expect(parseUploadedReplayBuffer).not.toHaveBeenCalled();
  });

  it("returns null without a request when the backend is not configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    restrictedPpReplayUrl.mockReturnValue(null);

    await expect(fetchRestrictedPpReplay(IMPORT_ID)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on other failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
    restrictedPpReplayUrl.mockReturnValue(URL_FOR_IMPORT);

    await expect(fetchRestrictedPpReplay(IMPORT_ID)).rejects.toThrow("503");
  });
});

describe("pickRestrictedPpReplayChart", () => {
  const file = (checksumMatched: boolean | null) => ({ content: "osu", cacheStatus: "hit" as const, checksumMatched });
  const community = { content: "community", assets: { audio: false, background: false } };

  it("prefers osu!'s copy of the exact revision", () => {
    expect(pickRestrictedPpReplayChart(resolution({ file: file(true), community }))).toBe("osu");
    expect(pickRestrictedPpReplayChart(resolution({ file: file(null) }))).toBe("osu");
  });

  it("takes a contributed copy over another revision", () => {
    expect(pickRestrictedPpReplayChart(resolution({ file: file(false), community }))).toBe("community");
    expect(pickRestrictedPpReplayChart(resolution({ community }))).toBe("community");
  });

  it("falls back to another revision, then to nothing", () => {
    expect(pickRestrictedPpReplayChart(resolution({ file: file(false) }))).toBe("osu");
    expect(pickRestrictedPpReplayChart(resolution({}))).toBeNull();
  });
});
