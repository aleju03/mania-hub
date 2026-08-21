// @vitest-environment jsdom
/* The board opened by dealing twice: React runs mount effects twice in
   development, both deals reached setRound, and the pair you were shown for
   the first half-second was not the pair the question was about. Only the
   newest deal may touch state now, and playCardDraw is the tell: it fires once
   per deal that actually lands on the board. */
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "#/lib/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveGlobalRankingEntry } from "#/lib/live-backend";

// The game reads its copy through useLingui, so every render needs the
// provider; en resolves to the source strings the assertions match.
const Providers = ({ children }: { children: ReactNode }) => (
  <I18nProvider i18n={getI18n("en")}>{children}</I18nProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: Providers });

const sfx = vi.hoisted(() => ({
  playCardDraw: vi.fn(),
  playDiceRoll: vi.fn(),
  playRecycleClink: vi.fn(),
  playStreakCorrect: vi.fn(),
  playStreakMilestone: vi.fn(),
  playStreakWrong: vi.fn(),
  warmPackAudio: vi.fn(),
}));
vi.mock("./packSfx", () => sfx);

const fetchLiveGlobalRankings = vi.hoisted(() => vi.fn());
const fetchLiveStreakMetrics = vi.hoisted(() => vi.fn());
const fetchLiveStreakBoard = vi.hoisted(() => vi.fn());
vi.mock("#/lib/live-backend", () => ({
  fetchLiveGlobalRankings,
  fetchLiveStreakMetrics,
  fetchLiveStreakBoard,
  isLiveBackendConfigured: () => true,
  warmLivePackPlayers: vi.fn(() => Promise.resolve()),
  // Pulled in by the leaderboard the game renders; exercised in its own test.
  removeLiveStreakBest: vi.fn(),
}));

const viewer = vi.hoisted(() => ({ current: null as null | { id: number; username: string } }));
vi.mock("#/lib/auth-context", () => ({
  useAuth: () => ({ viewer: viewer.current, loginAvailable: false }),
}));
vi.mock("#/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("#/lib/pack-games", () => ({
  fetchPackGameAllowance: vi.fn(() => Promise.resolve(null)),
  claimStreakShards: vi.fn(() => Promise.resolve(null)),
}));
const blitz = vi.hoisted(() => ({
  startBlitzStreak: vi.fn(),
  guessBlitzStreak: vi.fn(),
  cashOutBlitzStreak: vi.fn(),
}));
vi.mock("#/lib/streak-blitz", () => ({
  ...blitz,
  BLITZ_ROUND_GRACE_MS: 1500,
  blitzClientDeadline: (round: { deadlineAt: number; serverNow: number }, receivedAt: number) =>
    round.deadlineAt + (receivedAt - round.serverNow),
}));
// Cards mint from stored scores; the art itself is a canvas, so the game gets
// the tier (which is what colours the names) and no thumbnail.
const fetchCachedPackPlayerScores = vi.hoisted(() => vi.fn());
vi.mock("#/lib/packs", () => ({ fetchCachedPackPlayerScores }));
vi.mock("../player/maniacard3d/renderData", () => ({
  buildManiaCardRenderData: () => ({
    status: "ready",
    tier: "worldClass",
    glowColor: { r: 34, g: 197, b: 94, a: 0.42 },
  }),
}));
vi.mock("./cardSnapshot", () => ({ renderCardThumbnail: () => Promise.resolve(null) }));
// The face-down back is canvas art too; jsdom has no 2D context, so hand the
// board a stand-in instead of a not-implemented warning per test.
vi.mock("./packArt", () => ({ getCachedCardBackDataUrl: () => "data:image/png;base64,back" }));
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

/* A server-dealt round, as the blitz endpoints hand it over: the face-up
   card carries its number and the face-down one carries none. */
function blitzRound(index: number, leftId: number, rightId: number, dealtAt: number) {
  const player = (id: number) => ({
    userId: id,
    username: `player${id}`,
    countryCode: "CR",
    avatarUrl: `https://a.ppy.sh/${id}`,
    globalRank: id,
    pp: 12_000,
  });
  return {
    index,
    metric: "plays" as const,
    left: { player: player(leftId), value: 10_000 + leftId * 1_000 },
    right: { player: player(rightId) },
    // As the backend deals it: twelve seconds plus the mint/reveal hold.
    deadlineAt: dealtAt + 12_000 + 1_250,
    serverNow: dealtAt,
  };
}

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  fetchLiveGlobalRankings.mockReset();
  fetchLiveGlobalRankings.mockResolvedValue({ ranking: RANKING, total: RANKING.length });
  fetchLiveStreakMetrics.mockReset();
  fetchLiveStreakMetrics.mockResolvedValue(new Map());
  fetchLiveStreakBoard.mockReset();
  fetchLiveStreakBoard.mockResolvedValue({ pool: "top500", entries: [], viewer: null });
  fetchCachedPackPlayerScores.mockReset();
  fetchCachedPackPlayerScores.mockResolvedValue([{}]);
  viewer.current = null;
  for (const fn of Object.values(sfx)) fn.mockClear();
  for (const fn of Object.values(blitz)) fn.mockReset();
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
  it("shows an intentional face-down deal instead of a pulsing skeleton", async () => {
    let finishRanking!: (value: { ranking: LiveGlobalRankingEntry[]; total: number }) => void;
    fetchLiveGlobalRankings.mockImplementation(
      () => new Promise((resolve) => {
        finishRanking = resolve;
      }),
    );

    render(<StreakGame onExit={() => {}} />);

    expect(screen.getByText("Dealing a matchup…")).toBeTruthy();
    const board = screen.getByTestId("streak-dealing-board");
    expect(board.querySelectorAll("[data-streak-card-back]")).toHaveLength(2);
    expect(board.querySelector(".animate-pulse")).toBeNull();

    await act(async () => {
      finishRanking({ ranking: RANKING, total: RANKING.length });
    });
    expect(await screen.findByText(/have more or fewer/)).toBeTruthy();
  });

  it("shows a playable question before the full card thumbnails finish minting", async () => {
    const delayedRanking = Array.from({ length: 40 }, (_, index) => ({
      ...entry(10_000 + index, 10_000 + index * 1_000),
      rank: index + 1,
    }));
    fetchLiveGlobalRankings.mockResolvedValue({ ranking: delayedRanking, total: delayedRanking.length });
    const finishMints: Array<(scores: unknown[]) => void> = [];
    fetchCachedPackPlayerScores.mockImplementation(
      () => new Promise((resolve) => {
        finishMints.push(resolve);
      }),
    );

    render(<StreakGame onExit={() => {}} />);

    expect(await screen.findByText(/have more or fewer/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /more plays/i })).toBeTruthy();
    expect(sfx.playCardDraw).toHaveBeenCalledTimes(1);
    // Playable, but the art is not in yet: both cards are on the table face
    // down rather than showing a stand-in front.
    const faces = () => [...document.querySelectorAll("[data-streak-card-face]")]
      .map((face) => face.getAttribute("data-streak-card-face"));
    expect(faces()).toEqual(["back", "back"]);

    for (const finishMint of finishMints) finishMint([{}]);
    await settle();

    // The mint landing turns them over, whether or not it produced art (the
    // stubbed renderer here returns none).
    expect(faces()).toEqual(["front", "front"]);
  });

  it("does not fetch a second rankings page before the opening question", async () => {
    render(<StreakGame onExit={() => {}} />);
    await screen.findByText(/have more or fewer/);

    expect(fetchLiveGlobalRankings).toHaveBeenCalledTimes(1);
  });

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
    await waitFor(() => {
      const names = question.querySelectorAll("span");
      expect(names.length).toBe(2);
      for (const name of names) {
        expect((name as HTMLElement).style.color).toBe("rgb(34, 197, 94)");
      }
    });
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

describe("blitz mode", () => {
  it("asks for a sign-in rather than dealing a board nobody can be ranked on", async () => {
    render(<StreakGame onExit={() => {}} />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Blitz" }));
    await settle();
    expect(await screen.findByText(/Sign in with osu!/)).toBeTruthy();
    expect(blitz.startBlitzStreak).not.toHaveBeenCalled();
  });

  it("plays the round the server dealt, with its number withheld", async () => {
    viewer.current = { id: 99, username: "runner" };
    blitz.startBlitzStreak.mockResolvedValue({
      runId: "abcdefgh1234",
      pool: "top",
      streak: 0,
      status: "live",
      endedBy: null,
      round: blitzRound(1, 1, 2, Date.now()),
    });
    render(<StreakGame onExit={() => {}} />);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Blitz" }));
    await settle();
    expect(blitz.startBlitzStreak).toHaveBeenCalledWith({ data: { pool: "top500" } });
    // The card being guessed at shows a question mark, because its number
    // never left the backend.
    expect(await screen.findByText("? plays")).toBeTruthy();
  });

  it("takes the verdict from the server even when the browser would disagree", async () => {
    viewer.current = { id: 99, username: "runner" };
    blitz.startBlitzStreak.mockResolvedValue({
      runId: "abcdefgh1234",
      pool: "top",
      streak: 0,
      status: "live",
      endedBy: null,
      round: blitzRound(1, 1, 2, Date.now()),
    });
    /* The revealed number beats the face-up one, so a client scoring this
       itself would call "more plays" right. The server says otherwise, and the
       server is the one that counts. */
    blitz.guessBlitzStreak.mockResolvedValue({
      runId: "abcdefgh1234",
      pool: "top",
      streak: 0,
      status: "ended",
      endedBy: "wrong",
      round: null,
      correct: false,
      expired: false,
      revealed: { userId: 2, value: 999_999 },
      reward: { granted: 0, remainingToday: 1200, cap: 1200 },
    });
    render(<StreakGame onExit={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Blitz" }));
    await settle();

    fireEvent.click(await screen.findByRole("button", { name: /more plays/i }));
    await settle();
    expect(blitz.guessBlitzStreak).toHaveBeenCalledWith({
      data: { runId: "abcdefgh1234", guess: "more" },
    });
    expect(sfx.playStreakWrong).toHaveBeenCalledTimes(1);
    expect(sfx.playStreakCorrect).not.toHaveBeenCalled();
  });

  it("sweeps the clock bar every frame rather than in interval-sized hops", async () => {
    viewer.current = { id: 99, username: "runner" };
    blitz.startBlitzStreak.mockResolvedValue({
      runId: "abcdefgh1234",
      pool: "top500",
      streak: 0,
      status: "live",
      endedBy: null,
      round: blitzRound(1, 1, 2, Date.now()),
    });
    const { container } = render(<StreakGame onExit={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Blitz" }));
    await settle();

    const bar = container.querySelector("[data-clock-bar]") as HTMLElement;
    expect(bar).toBeTruthy();
    /* Sampled over a fifth of a second. The old clock ticked state on a 100ms
       interval, which is two positions in this window and reads as hopping;
       a frame loop is a dozen. */
    const seen = new Set<string>();
    await act(async () => {
      await new Promise<void>((resolve) => {
        const started = Date.now();
        const sample = () => {
          seen.add(bar.style.transform);
          if (Date.now() - started < 200) requestAnimationFrame(sample);
          else resolve();
        };
        requestAnimationFrame(sample);
      });
    });
    expect(seen.size).toBeGreaterThan(4);
  });

  it("holds the countdown until both cards are face up", async () => {
    viewer.current = { id: 99, username: "runner" };
    /* Players no other test has minted, so both cards genuinely start face
       down, and mints that only finish when the test says so. */
    const finishMints: Array<(scores: unknown[]) => void> = [];
    fetchCachedPackPlayerScores.mockImplementation(
      () => new Promise((resolve) => {
        finishMints.push(resolve);
      }),
    );
    blitz.startBlitzStreak.mockResolvedValue({
      runId: "abcdefgh1234",
      pool: "top",
      streak: 0,
      status: "live",
      endedBy: null,
      round: blitzRound(1, 61, 62, Date.now()),
    });
    const { container } = render(<StreakGame onExit={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Blitz" }));
    await settle();
    await screen.findByText("? plays");

    // The round is up and answerable, but the clock does not run against two
    // card backs. The server dealt this wait into the deadline.
    expect(container.querySelector("[data-clock-bar]")).toBeNull();

    await act(async () => {
      for (const finish of finishMints) finish([{}]);
    });
    await settle();
    expect(container.querySelector("[data-clock-bar]")).toBeTruthy();
    // The countdown runs the twelve seconds it advertises: the hold the server
    // folded into the deadline is quiet grace, not a 13 on the clock.
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("closes the run when the clock runs out, and stops taking guesses first", async () => {
    viewer.current = { id: 99, username: "runner" };
    const dealtAt = Date.now();
    blitz.startBlitzStreak.mockResolvedValue({
      runId: "abcdefgh1234",
      pool: "top",
      streak: 0,
      status: "live",
      endedBy: null,
      // A round with 300ms on it, so the clock can be watched running out.
      round: { ...blitzRound(1, 1, 2, dealtAt), deadlineAt: dealtAt + 300 },
    });
    blitz.cashOutBlitzStreak.mockResolvedValue({
      runId: "abcdefgh1234",
      pool: "top",
      streak: 0,
      status: "ended",
      endedBy: "timeout",
      round: null,
      correct: false,
      expired: true,
      revealed: { userId: 2, value: 12_000 },
      reward: null,
    });
    render(<StreakGame onExit={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Blitz" }));
    await settle();
    await screen.findByText("? plays");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect((screen.getByRole("button", { name: /more plays/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Out of time.")).toBeTruthy();
    expect(blitz.cashOutBlitzStreak).not.toHaveBeenCalled();

    // The grace the backend allows for the wire, waited out so it agrees this
    // was a timeout rather than closing it early as a cash-out.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1700));
    });
    expect(blitz.cashOutBlitzStreak).toHaveBeenCalledWith({ data: { runId: "abcdefgh1234" } });
  });
});

describe("rolling for it", () => {
  it("picks a side, locks the board while the dice are in the air, then plays it", async () => {
    render(<StreakGame onExit={() => {}} />);
    await settle();
    await screen.findByText(/have more or fewer/);

    fireEvent.click(screen.getByRole("button", { name: /guess at random/i }));
    // Math.random is pinned to 0, so the dice pick "more" - the right answer
    // in this fixture. Nothing is submitted until they land.
    expect(sfx.playDiceRoll).toHaveBeenCalledTimes(1);
    expect(sfx.playStreakCorrect).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: /more plays/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /fewer plays/i }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    expect(sfx.playStreakCorrect).toHaveBeenCalledWith(1);
  });

  it("throws the dice away when a re-deal beats them to the board", async () => {
    render(<StreakGame onExit={() => {}} />);
    await settle();
    await screen.findByText(/have more or fewer/);

    fireEvent.click(screen.getByRole("button", { name: /guess at random/i }));
    // A pool switch mid-roll: the round the dice were thrown at is gone, so
    // the guess they picked must not land on the one that replaced it.
    fireEvent.click(screen.getByRole("button", { name: "Anyone" }));
    await settle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    expect(sfx.playStreakCorrect).not.toHaveBeenCalled();
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
