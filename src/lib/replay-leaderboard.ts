/** Shared input for the viewer and its on-device export renderer. */
export interface ReplayLeaderboardEntry {
  name: string;
  score: number;
  combo: number;
  rank?: number;
  /** osu! API accuracy, on the 0–1 scale. */
  accuracy?: number;
  /** Canvas-safe, same-origin avatar URL. */
  avatarUrl?: string;
  isFriend?: boolean;
}

export interface ReplayLeaderboardOptions {
  playerAvatarUrl?: string;
  /** A truncated board cannot assign a rank below its last known score. */
  isPartial?: boolean;
}

export interface LazerLeaderboardRow extends ReplayLeaderboardEntry {
  key: string;
  tracked: boolean;
  position: number | null;
}

// Ported from ppy/osu ebaf7e9910ef3755308dec2c7950d916aabc545b:
// SoloGameplayLeaderboardProvider, DrawableGameplayLeaderboard{,Score}.
// Copyright (c) ppy Pty Ltd. MIT licence: /licenses/osu-lazer-leaderboard.txt.
export const LAZER_LEADERBOARD = {
  width: 277.6,
  height: 300,
  rowHeight: 38,
  rowGap: 2.5,
  shear: 0.2,
  flowX: 17.6,
  sortIntervalMs: 1000,
  moveDurationMs: 450,
  panelDurationMs: 500,
  scrollDecay: 0.01,
  guestAvatar: "/images/replay/leaderboard/lazer-avatar-guest.png",
  colors: { leader: 0x99eb47, player: 0xebc247, other: 0x2e576b, friend: 0xff66ab },
} as const;

export function lazerOutQuint(progress: number): number {
  return 1 - (1 - Math.max(0, Math.min(1, progress))) ** 5;
}

export function lazerOutElastic(progress: number): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  return 2 ** (-10 * progress) * Math.sin((progress - 0.075) * (2 * Math.PI / 0.3)) + 1 - 2 ** -11 * progress;
}

export function formatLazerLeaderboardAccuracy(accuracy: number | undefined): string {
  if (accuracy == null || !Number.isFinite(accuracy)) return "–";
  return `${(Math.floor(Math.max(0, Math.min(1, accuracy)) * 10000) / 100).toFixed(2)}%`;
}

export function buildLazerLeaderboardRows(
  entries: readonly ReplayLeaderboardEntry[],
  player: ReplayLeaderboardEntry,
  isPartial: boolean,
): LazerLeaderboardRow[] {
  const rows: LazerLeaderboardRow[] = entries.map((entry, index) => ({
    ...entry, key: `e${index}`, tracked: false, position: entry.rank ?? index + 1,
  }));
  // Stable ties in Array.sort leave the watched score after existing plays.
  rows.push({ ...player, key: "player", tracked: true, position: null });
  rows.sort((a, b) => b.score - a.score);
  let delta = 0;
  rows.forEach((row, index) => {
    if (!isPartial) row.position = index + 1;
    else if (row.tracked) {
      const previous = index === 0 ? 0 : rows[index - 1].rank ?? rows[index - 1].position;
      const next = index + 1 < rows.length ? rows[index + 1].rank ?? rows[index + 1].position : null;
      row.position = previous != null && next != null && previous + 1 === next ? previous + 1 : null;
      if (row.position != null) delta++;
    } else {
      row.position = row.position == null ? null : row.position + delta;
    }
  });
  return rows;
}
