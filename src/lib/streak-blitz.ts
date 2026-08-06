import { createServerFn } from "@tanstack/react-start";
import { postPackGame } from "./pack-games";
import type { StreakMetric, StreakPool } from "./streak-game";

// The blitz side of higher or lower. Casual runs deal themselves in the
// browser; a blitz run is dealt by the backend, which keeps the face-down
// card's number and the deadline it has to be answered by. So this module
// posts guesses and renders what comes back - it never decides whether one was
// right, and it never learns the answer before the server sends it.
//
// Everything here goes through a server function so the run is played as the
// account the osu! cookie proves, not as whoever the request says.

export interface BlitzStreakPlayer {
  userId: number;
  username: string;
  countryCode: string;
  avatarUrl: string;
  globalRank: number;
  pp: number;
}

export interface BlitzStreakRound {
  index: number;
  metric: StreakMetric;
  left: { player: BlitzStreakPlayer; value: number };
  /* No value: this is the card being guessed at. */
  right: { player: BlitzStreakPlayer };
  deadlineAt: number;
  /* The backend's clock at the moment it dealt, so a browser running a few
     seconds off still draws an honest countdown. */
  serverNow: number;
}

export type BlitzStreakEnd = "wrong" | "timeout" | "cashout" | "abandoned" | "exhausted";

export interface BlitzStreakRun {
  runId: string;
  pool: StreakPool;
  streak: number;
  status: "live" | "ended";
  endedBy: BlitzStreakEnd | null;
  round: BlitzStreakRound | null;
}

export interface BlitzStreakGuessResult extends BlitzStreakRun {
  correct: boolean;
  expired: boolean;
  revealed: { userId: number; value: number } | null;
  reward: { granted: number; remainingToday: number; cap: number } | null;
}

/* Mirrors the backend's allowance for the wire. The client waits it out before
   calling a run timed out, so the server agrees it was a timeout rather than
   ending it as a cash-out a second too early. */
export const BLITZ_ROUND_GRACE_MS = 1_500;

/* The deadline on the browser's own clock. Taken at the moment the response
   lands rather than the moment the round is drawn: the difference between the
   two clocks is fixed, so measuring it once is what keeps a browser running
   three minutes fast from showing a countdown that was never there. Network
   delay lands on the player's side of the trade, which is the right way round.
   Pure, so the countdown can be tested without a round. */
export function blitzClientDeadline(round: BlitzStreakRound, receivedAt: number): number {
  return round.deadlineAt + (receivedAt - round.serverNow);
}

/* Mirrors normalizeStreakPool on the backend. This used to recognise only
   "anyone" and collapse everything else to "top", which silently dropped
   "top500" -- so the Top 500 board could never receive a row, and because
   Top 500 is the default mode its runs were filed onto the Top 1000 board
   instead. The two pools are meant to be separate games. */
export function normalizeBlitzStreakPool(value: unknown): StreakPool {
  if (value === "anyone") return "anyone";
  return value === "top500" ? "top500" : "top";
}

export const startBlitzStreak = createServerFn({ method: "POST" })
  .validator((input: { pool?: unknown }) => ({
    pool: normalizeBlitzStreakPool(input?.pool),
  }))
  .handler(async ({ data }): Promise<BlitzStreakRun | null> =>
    postPackGame<BlitzStreakRun>("/api/packs/games/streak/start", { pool: data.pool }),
  );

export const guessBlitzStreak = createServerFn({ method: "POST" })
  .validator((input: { runId?: unknown; guess?: unknown }) => ({
    runId: String(input?.runId ?? "").slice(0, 24),
    guess: (input?.guess === "less" ? "less" : "more") as "more" | "less",
  }))
  .handler(async ({ data }): Promise<BlitzStreakGuessResult | null> =>
    postPackGame<BlitzStreakGuessResult>("/api/packs/games/streak/guess", {
      runId: data.runId,
      guess: data.guess,
    }),
  );

export const cashOutBlitzStreak = createServerFn({ method: "POST" })
  .validator((input: { runId?: unknown }) => ({ runId: String(input?.runId ?? "").slice(0, 24) }))
  .handler(async ({ data }): Promise<BlitzStreakGuessResult | null> =>
    postPackGame<BlitzStreakGuessResult>("/api/packs/games/streak/cashout", { runId: data.runId }),
  );
