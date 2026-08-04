// @vitest-environment jsdom
/* The board opened by dealing twice: React runs mount effects twice in
   development, both deals reached setRound, and the pair you were shown for
   the first half-second was not the pair the question was about. Only the
   newest deal may touch state now, and playCardDraw is the tell: it fires once
   per deal that actually lands on the board. */
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveGlobalRankingEntry } from "#/lib/live-backend";

const sfx = vi.hoisted(() => ({
  playCardDraw: vi.fn(),
  playRecycleClink: vi.fn(),
  playStreakCorrect: vi.fn(),
  playStreakMilestone: vi.fn(),
  playStreakWrong: vi.fn(),
  warmPackAudio: vi.fn(),
}));
vi.mock("./packSfx", () => sfx);

const fetchLiveGlobalRankings = vi.hoisted(() => vi.fn());
vi.mock("#/lib/live-backend", () => ({
  fetchLiveGlobalRankings,
  isLiveBackendConfigured: () => true,
  warmLivePackPlayers: vi.fn(() => Promise.resolve()),
}));

vi.mock("#/lib/auth-context", () => ({ useAuth: () => ({ viewer: null, loginAvailable: false }) }));
vi.mock("#/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("#/lib/pack-games", () => ({
  fetchPackGameAllowance: vi.fn(() => Promise.resolve(null)),
  claimStreakShards: vi.fn(() => Promise.resolve(null)),
}));
// Cards mint from stored scores; the art itself is a canvas, so the game gets
// the tier (which is what colours the names) and no thumbnail.
vi.mock("#/lib/packs", () => ({ fetchCachedPackPlayerScores: vi.fn(() => Promise.resolve([{}])) }));
vi.mock("../player/maniacard3d/renderData", () => ({
  buildManiaCardRenderData: () => ({
    status: "ready",
    tier: "worldClass",
    glowColor: { r: 34, g: 197, b: 94, a: 0.42 },
  }),
}));
vi.mock("./cardSnapshot", () => ({ renderCardThumbnail: () => Promise.resolve(null) }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params }: { children?: React.ReactNode; params?: { username?: string } }) => (
    <a href={`/player/${params?.username ?? ""}`}>{children}</a>
  ),
}));

const { StreakGame } = await import("./StreakGame");

function entry(id: number, plays: number): LiveGlobalRankingEntry {
  return {
    rank: id,
    user: {
      id,
      username: `player${id}`,
      avatar_url: `https://a.ppy.sh/${id}`,
      cover_url: "",
      country_code: "CR",
      avatar_accent: null,
    },
    pp: 12_000,
    global_rank: id,
    country_rank: null,
    hit_accuracy: null,
    play_count: plays,
    ranked_score: null,
    grade_counts: null,
    global_change: null,
    country_change: null,
  } as LiveGlobalRankingEntry;
}

/* One page, ascending play counts, and Math.random pinned to zero: the draw
   takes candidates in order, so player1 faces player2 and "more plays" is
   always the right answer. */
const RANKING = Array.from({ length: 40 }, (_, index) => entry(index + 1, 10_000 + index * 1_000));

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  fetchLiveGlobalRankings.mockReset();
  fetchLiveGlobalRankings.mockResolvedValue({ ranking: RANKING, total: RANKING.length });
  for (const fn of Object.values(sfx)) fn.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("dealing the first board", () => {
  it("lands one deal even though the mount effect runs twice", async () => {
    render(
      <StrictMode>
        <StreakGame onExit={() => {}} />
      </StrictMode>,
    );
    await settle();

    expect(await screen.findByText(/have more or fewer/)).toBeTruthy();
    // Two deals ran; one board was shown.
    expect(sfx.playCardDraw).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText(/have more or fewer/)).toHaveLength(1);
  });

  it("prints each name in its card's rarity colour", async () => {
    render(<StreakGame onExit={() => {}} />);
    await settle();

    const question = await screen.findByText(/have more or fewer/);
    const names = question.querySelectorAll("span");
    expect(names.length).toBe(2);
    for (const name of names) {
      expect((name as HTMLElement).style.color).toBe("rgb(34, 197, 94)");
    }
  });
});

describe("the hard mode", () => {
  it("re-deals when the pool switches", async () => {
    render(<StreakGame onExit={() => {}} />);
    await settle();
    await screen.findByText(/have more or fewer/);
    expect(sfx.playCardDraw).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Anyone" }));
    await settle();
    expect(screen.getByRole("button", { name: "Anyone" }).getAttribute("aria-pressed")).toBe("true");
    // A fresh deal, not the old board with a different label on it.
    expect(sfx.playCardDraw).toHaveBeenCalledTimes(2);
  });

  it("locks the switch while a streak is live", async () => {
    render(<StreakGame onExit={() => {}} />);
    await settle();

    fireEvent.click(await screen.findByRole("button", { name: /more plays/i }));
    // One right answer on the board: the run would be dumped by a switch, so
    // the chips wait for it to end.
    expect((screen.getByRole("button", { name: "Anyone" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the sound of a guess", () => {
  it("climbs on a right answer and thuds on a wrong one", async () => {
    render(<StreakGame onExit={() => {}} />);
    await settle();

    fireEvent.click(await screen.findByRole("button", { name: /more plays/i }));
    expect(sfx.playStreakCorrect).toHaveBeenCalledWith(1);
    expect(sfx.playStreakWrong).not.toHaveBeenCalled();
    // Not a milestone yet: that is every fifth.
    expect(sfx.playStreakMilestone).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1400));
    });
    fireEvent.click(screen.getByRole("button", { name: /fewer plays/i }));
    expect(sfx.playStreakWrong).toHaveBeenCalledTimes(1);
  });
});
