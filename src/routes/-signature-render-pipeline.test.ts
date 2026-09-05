// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageResponse } from "@vercel/og";
import { renderSignature } from "./api/signature/-renderers";
import { avatarSquareDataUrl, beatmapCoverBandDataUrl } from "./api/signature/-backgrounds";
import { ogRenderGate } from "../lib/og-render";
import { normalizeSignatureStyle } from "../lib/signature-style";
import type { OsuScore } from "../lib/types";

vi.mock("@vercel/og", () => ({ ImageResponse: vi.fn() }));
vi.mock("../lib/og-render", async (original) => ({
  ...await original<typeof import("../lib/og-render")>(),
  loadOgFonts: async () => [new ArrayBuffer(0), new ArrayBuffer(0)],
}));
vi.mock("./api/signature/-backgrounds", () => ({
  avatarSquareDataUrl: vi.fn(), beatmapCoverBandDataUrl: vi.fn(),
  backgroundImageDataUrl: vi.fn().mockResolvedValue(null),
}));
afterEach(() => vi.clearAllMocks());

const score: OsuScore = {
  user: { id: 101, username: "tester", avatar_url: "https://a.ppy.sh/101", country_code: "CR" },
  id: 1, user_id: 101, pp: 100, accuracy: 0.99, mods: [], score: 999000,
  max_combo: 100, passed: true, rank: "S", statistics: {}, ended_at: "2026-01-01T00:00:00Z",
  beatmap: { id: 1, beatmapset_id: 1, mode: "mania", cs: 4, bpm: 180,
    difficulty_rating: 5, version: "Hard", status: "ranked", total_length: 120,
    drain: 8, accuracy: 8, ar: 0, convert: false, count_circles: 100,
    count_sliders: 0, count_spinners: 0, url: "https://osu.ppy.sh/b/1" },
  beatmapset: { id: 1, title: "Map", artist: "Artist", creator: "Mapper", user_id: 1,
    status: "ranked", play_count: 1, favourite_count: 0, submitted_date: "2026-01-01",
    ranked_date: null, last_updated: "2026-01-01", bpm: 180, preview_url: "",
    covers: { cover: "https://assets.ppy.sh/cover.jpg", "cover@2x": "", card: "", "card@2x": "",
      list: "", "list@2x": "", slimcover: "", "slimcover@2x": "" } },
};

describe("signature render pipeline", () => {
  it("starts the top-play cover before the avatar finishes, with no raster slot held", async () => {
    let finishAvatar!: (value: null) => void;
    vi.mocked(avatarSquareDataUrl).mockImplementation(() => new Promise((resolve) => { finishAvatar = resolve; }));
    vi.mocked(beatmapCoverBandDataUrl).mockResolvedValue(null);
    vi.mocked(ImageResponse).mockImplementation(function () {
      expect(ogRenderGate.activeCount).toBe(1);
      return { arrayBuffer: async () => new Uint8Array([1, 2]).buffer } as ImageResponse;
    });
    const pending = renderSignature({
      request: new Request("https://mania-tracker.com"), type: "insights", design: 1,
      style: normalizeSignatureStyle({ background: "none" }, "insights"),
      resolved: { userId: 101, username: "tester", enabledTypes: ["insights"], skillsKeyCount: null,
        styles: null, timeZone: null, versions: {} as never,
        profile: { user: { id: 101, avatar_url: "https://a.ppy.sh/101" }, bestScores: [score] } },
    });
    await vi.waitFor(() => expect(beatmapCoverBandDataUrl).toHaveBeenCalledTimes(1));
    expect(ogRenderGate.activeCount).toBe(0);
    expect(ImageResponse).not.toHaveBeenCalled();
    finishAvatar(null);
    expect(await pending).toEqual(Buffer.from([1, 2]));
    expect(ogRenderGate.activeCount).toBe(0);
  });
});
