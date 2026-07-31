import { getModAcronyms, getScoreIdentity, getScoreSpeedBucket, getScoreTimeMs } from "./score";
import type { LeanTrackerScore } from "./types";

// Scores from one multiplayer round land on the same beatmap for every player
// at (nearly) the same moment: the round ends for everyone when the map does,
// and submissions reach osu! within seconds of each other. But a single
// co-finish is weak evidence - a fresh farm map gets played by many people at
// once and produces the same signature by coincidence. So a lobby is only
// flagged when the same players co-finish repeatedly:
//
// 1. Round candidate: >= 2 players finish the same map (same rate bucket)
//    with consecutive gaps of at most TRACKER_MULTI_WINDOW_MS.
// 2. Session: candidates whose player sets share >= 2 players, at most
//    TRACKER_MULTI_SESSION_GAP_MS apart (a long map plus song select, with
//    slack for an idle chat break between maps). A candidate sharing >= 2
//    players with several sessions bridges them: they were one lobby whose
//    earlier rounds happened to pair up different subsets of its players.
// 3. Confirmation: a session needs >= TRACKER_MULTI_MIN_ROUNDS rounds, and a
//    player must appear in >= 2 of its rounds to be counted - anyone swept
//    into a single round by coincidence is trimmed back out.
export const TRACKER_MULTI_WINDOW_MS = 5_000;
export const TRACKER_MULTI_SESSION_GAP_MS = 20 * 60_000;
export const TRACKER_MULTI_MIN_ROUNDS = 2;

export interface TrackerMultiRound {
  /** Stable identity for the round: map + rate bucket + earliest finish time. */
  key: string;
  /** The round's plays, ordered by finish time. */
  scores: LeanTrackerScore[];
}

export interface TrackerMultiGroup {
  /** Stable identity for the lobby: its first round's key. */
  key: string;
  /** Every map the lobby played, in play order. */
  rounds: TrackerMultiRound[];
  /** Every play across all rounds. */
  scores: LeanTrackerScore[];
  /** Distinct confirmed players in the lobby. */
  playerCount: number;
}

interface RoundCandidate {
  key: string;
  scores: LeanTrackerScore[];
  players: Set<number>;
  startMs: number;
  endMs: number;
}

interface SessionDraft {
  rounds: RoundCandidate[];
  players: Set<number>;
  endMs: number;
}

function getScoreBeatmapId(score: LeanTrackerScore): number | null {
  return score.beatmap?.id ?? score.beatmap_id ?? null;
}

/**
 * Detect multiplayer-lobby sessions in a tracker score pool.
 * Returns a map keyed by score identity; every play of a lobby maps to the
 * same shared group object, and scores absent from the map are solo plays.
 */
export function detectTrackerMultis(scores: LeanTrackerScore[]): Map<string, TrackerMultiGroup> {
  // The pool may merge overlapping sources (SSE feed + page snapshots).
  const byIdentity = new Map<string, LeanTrackerScore>();
  for (const score of scores) {
    if (getScoreBeatmapId(score) == null || getScoreTimeMs(score) <= 0) continue;
    byIdentity.set(getScoreIdentity(score), score);
  }

  const byLane = new Map<string, LeanTrackerScore[]>();
  for (const score of byIdentity.values()) {
    const lane = `${getScoreBeatmapId(score)}:${getScoreSpeedBucket(getModAcronyms(score.mods))}`;
    const list = byLane.get(lane);
    if (list) list.push(score);
    else byLane.set(lane, [score]);
  }

  const candidates: RoundCandidate[] = [];
  for (const [lane, list] of byLane.entries()) {
    if (list.length < 2) continue;
    list.sort((a, b) => getScoreTimeMs(a) - getScoreTimeMs(b));
    let clusterStart = 0;
    for (let i = 1; i <= list.length; i++) {
      const gap = i < list.length ? getScoreTimeMs(list[i]) - getScoreTimeMs(list[i - 1]) : Number.POSITIVE_INFINITY;
      if (gap <= TRACKER_MULTI_WINDOW_MS) continue;
      const cluster = list.slice(clusterStart, i);
      clusterStart = i;
      const players = new Set(cluster.map((score) => score.user_id));
      if (players.size < 2) continue;
      candidates.push({
        key: `${lane}:${getScoreTimeMs(cluster[0])}`,
        scores: cluster,
        players,
        startMs: getScoreTimeMs(cluster[0]),
        endMs: getScoreTimeMs(cluster[cluster.length - 1]),
      });
    }
  }

  // Chain rounds into lobby sessions: same >= 2 players, close enough in time.
  candidates.sort((a, b) => a.startMs - b.startMs);
  const sessions: SessionDraft[] = [];
  for (const candidate of candidates) {
    const matches: SessionDraft[] = [];
    for (const session of sessions) {
      if (candidate.startMs - session.endMs > TRACKER_MULTI_SESSION_GAP_MS) continue;
      let shared = 0;
      for (const id of candidate.players) {
        if (session.players.has(id)) shared++;
      }
      if (shared >= 2) matches.push(session);
    }
    if (matches.length > 0) {
      // Every matched session is the same lobby: merge them into the first.
      const attached = matches[0];
      for (const extra of matches.slice(1)) {
        attached.rounds.push(...extra.rounds);
        for (const id of extra.players) attached.players.add(id);
        attached.endMs = Math.max(attached.endMs, extra.endMs);
        sessions.splice(sessions.indexOf(extra), 1);
      }
      if (matches.length > 1) attached.rounds.sort((a, b) => a.startMs - b.startMs);
      attached.rounds.push(candidate);
      for (const id of candidate.players) attached.players.add(id);
      attached.endMs = Math.max(attached.endMs, candidate.endMs);
    } else {
      sessions.push({ rounds: [candidate], players: new Set(candidate.players), endMs: candidate.endMs });
    }
  }

  const result = new Map<string, TrackerMultiGroup>();
  for (const session of sessions) {
    if (session.rounds.length < TRACKER_MULTI_MIN_ROUNDS) continue;

    // Confirm players: repeated co-finishes only.
    const roundsPerPlayer = new Map<number, number>();
    for (const round of session.rounds) {
      for (const id of round.players) {
        roundsPerPlayer.set(id, (roundsPerPlayer.get(id) ?? 0) + 1);
      }
    }
    const confirmed = new Set([...roundsPerPlayer.entries()].filter(([, count]) => count >= 2).map(([id]) => id));
    if (confirmed.size < 2) continue;

    const rounds: TrackerMultiRound[] = session.rounds
      .map((round) => ({ key: round.key, scores: round.scores.filter((score) => confirmed.has(score.user_id)) }))
      .filter((round) => new Set(round.scores.map((score) => score.user_id)).size >= 2);
    if (rounds.length < TRACKER_MULTI_MIN_ROUNDS) continue;

    const allScores = rounds.flatMap((round) => round.scores);
    const group: TrackerMultiGroup = {
      key: `multi:${rounds[0].key}`,
      rounds,
      scores: allScores,
      playerCount: new Set(allScores.map((score) => score.user_id)).size,
    };
    for (const score of allScores) {
      result.set(getScoreIdentity(score), group);
    }
  }
  return result;
}
