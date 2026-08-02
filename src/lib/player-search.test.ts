import { beforeEach, describe, expect, it, vi } from "vitest";

import { searchPlayers } from "./player-search";
import { fetchLiveUserSearch, isLiveBackendConfigured } from "./live-backend";
import { searchUsers } from "./osu";

vi.mock("./live-backend", () => ({
  fetchLiveUserSearch: vi.fn(),
  isLiveBackendConfigured: vi.fn(() => true),
}));

vi.mock("./osu", () => ({
  searchUsers: vi.fn(),
}));

const storedSearch = vi.mocked(fetchLiveUserSearch);
const backendConfigured = vi.mocked(isLiveBackendConfigured);
const osuSearch = vi.mocked(searchUsers);

const stored = (username: string, id: number) => ({
  id,
  username,
  avatarUrl: `https://a.ppy.sh/${id}.png`,
  countryCode: "CR",
  pp: 1000,
  globalRank: 500,
});

describe("searchPlayers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backendConfigured.mockReturnValue(true);
  });

  it("answers from stored players without spending an osu! API call", async () => {
    storedSearch.mockResolvedValue([stored("Kalkai", 401)]);

    expect(await searchPlayers("kalkai")).toEqual([
      { id: 401, username: "Kalkai", avatar_url: "https://a.ppy.sh/401.png", country_code: "CR" },
    ]);
    expect(osuSearch).not.toHaveBeenCalled();
  });

  // The stored table only knows tracked players and whoever has been seen in
  // ingest, so a name it has never met still has to reach osu! somehow.
  it("falls back to osu! only when nothing is stored", async () => {
    storedSearch.mockResolvedValue([]);
    osuSearch.mockResolvedValue({
      user: { data: [{ id: 9, username: "Untracked", avatar_url: "https://a.ppy.sh/9.png", country_code: "SE" }] },
    } as never);

    expect(await searchPlayers("untracked")).toEqual([
      { id: 9, username: "Untracked", avatar_url: "https://a.ppy.sh/9.png", country_code: "SE" },
    ]);
    expect(osuSearch).toHaveBeenCalledTimes(1);
  });

  it("stays local for callers that can only act on stored players", async () => {
    storedSearch.mockResolvedValue([]);

    expect(await searchPlayers("untracked", { fallbackToOsu: false })).toEqual([]);
    expect(osuSearch).not.toHaveBeenCalled();
  });

  it("still finds players when the backend is unreachable", async () => {
    storedSearch.mockRejectedValue(new Error("offline"));
    osuSearch.mockResolvedValue({
      user: { data: [{ id: 7, username: "Anyone", avatar_url: "https://a.ppy.sh/7.png", country_code: "US" }] },
    } as never);

    expect((await searchPlayers("anyone")).map((user) => user.id)).toEqual([7]);
    expect((await searchPlayers("anyone", { fallbackToOsu: false }))).toEqual([]);
  });

  // Two characters is what the search boxes debounce on; below that a query
  // matches half the table and is worth nothing to anyone.
  it("ignores queries too short to mean anything", async () => {
    expect(await searchPlayers(" a ")).toEqual([]);
    expect(storedSearch).not.toHaveBeenCalled();
    expect(osuSearch).not.toHaveBeenCalled();
  });
});
