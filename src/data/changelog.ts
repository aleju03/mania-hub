/**
 * Changelog content for the footer modal.
 *
 * Static data on purpose: it ships with the frontend bundle, so there is no
 * projection to keep warm, no job to run, and no admin screen to maintain.
 * Edit this file in the same commit as the work it describes.
 *
 * House rules:
 * - One line per update, written for players. Say what changed on screen, in
 *   the plainest words that still say it.
 * - No commit subjects, no internals. Backend-only work stays out unless a
 *   player can tell the difference.
 * - Newest first. `date` is the UTC day it went live.
 */

export interface ChangelogUpdate {
  /** UTC day it went live, as YYYY-MM-DD. */
  date: string;
  text: string;
  /** Optional in-app path, which makes the whole row clickable. */
  to?: string;
}

/** Short list of what is being worked on now. Keep it to three or four. */
export const WIP: string[] = [
  "A replay viewer that looks in-game",
  "Importing your own skin into replays",
  "A better side-by-side replay compare",
];

export const UPDATES: ChangelogUpdate[] = [
  { date: "2026-07-31", text: "See how many times your own skins have been downloaded", to: "/skins" },
  { date: "2026-07-31", text: "Update your skin with a newer .osk, keeping its page and its downloads", to: "/skins" },
  { date: "2026-07-31", text: "Download a skin straight from the grid, without opening it first", to: "/skins" },
  { date: "2026-07-31", text: "See the best pulls as they happen, and how many collections a card is in", to: "/packs" },
  { date: "2026-07-31", text: "Every pull has a page you can share", to: "/packs" },
  { date: "2026-07-31", text: "New farm helper board, easier to read and quicker to pick from", to: "/farm-helper" },
  { date: "2026-07-31", text: "Mark a map too hard or too easy to steer what the board suggests", to: "/farm-helper" },
  { date: "2026-07-31", text: "Fewer maps wrongly labelled chordjack outside 4K", to: "/maps" },
  { date: "2026-07-30", text: "Sort your album shelves, and they stay that way next visit", to: "/packs" },
  { date: "2026-07-30", text: "The pp gain on your top plays is right again", to: "/top-plays" },
  { date: "2026-07-29", text: "Maps search can hide patterns and keymodes, not just filter for them", to: "/maps" },
  { date: "2026-07-29", text: "Packs open smoother on slower phones", to: "/packs" },
  { date: "2026-07-27", text: "The tracker picks up scores the live feed misses", to: "/tracker" },
  { date: "2026-07-26", text: "Updated maps show the new chart, not the old one" },
  { date: "2026-07-25", text: "Skins is open to everyone, with previews and .osk downloads", to: "/skins" },
  { date: "2026-07-25", text: "Live pp counter in the replay viewer, plus what-if re-judging", to: "/replay" },
  { date: "2026-07-24", text: "Random map rerolls are faster", to: "/maps" },
  { date: "2026-07-21", text: "The card album works properly on phones", to: "/packs" },
  { date: "2026-07-19", text: "New maps search with filter chips and a beat preview", to: "/maps" },
  { date: "2026-07-18", text: "Skill ratings for each keymode", to: "/my-stats" },
  { date: "2026-07-16", text: "Compare two replays side by side on one clock", to: "/replay" },
];

/** Newest update date, used for the footer's unseen-updates dot. */
export const LATEST_UPDATE_DATE = UPDATES[0]?.date ?? "";
