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
 * - Newest first. `date` is the day it went live on the site clock (UTC-6),
 *   which is the day the author lived, not the UTC day.
 */

export interface ChangelogUpdate {
  /** Day it went live on the site clock (UTC-6), as YYYY-MM-DD. */
  date: string;
  text: string;
  /** Optional in-app path, which makes the whole row clickable. */
  to?: string;
}

/** Short list of what is being worked on now. Keep it to three or four.
    Leave it empty to hide the section entirely. */
export const WIP: string[] = [];

export const UPDATES: ChangelogUpdate[] = [
  { date: "2026-08-12", text: "You can now recycle cards from the pack you just opened: right-click one, or use Recycle all", to: "/packs" },
  { date: "2026-08-12", text: "See who is still missing from your collection: tap the count under your collection progress", to: "/packs" },
  { date: "2026-08-12", text: "New align left and align right buttons in the BBCode editor, next to center", to: "/bbcode" },
  { date: "2026-08-12", text: "Fixed a bug where custom rate mods on uploaded replays played at base rate instead (e.g. 1.5x instead of 1.1x)", to: "/replay" },
  { date: "2026-08-12", text: "Uploaded replays now detect lazer/stable correctly", to: "/replay" },
  { date: "2026-08-11", text: "Images in the BBCode editor now show at the size they will be on your osu! profile", to: "/bbcode" },
  { date: "2026-08-11", text: "Drag the corner of an image in the BBCode editor to resize it", to: "/bbcode" },
  { date: "2026-08-11", text: "Right-click an image in the BBCode editor to make an imagemap, then drag its clickable areas", to: "/bbcode" },
  { date: "2026-08-11", text: "Selected text in the BBCode editor stays readable while you pick a color for it", to: "/bbcode" },
  { date: "2026-08-11", text: "New page: osu!mania Discord servers. Find one to join, or post your own", to: "/communities" },
  { date: "2026-08-11", text: "New GOATs album on the card albums shelf", to: "/packs" },
  { date: "2026-08-10", text: "When uploading a skin, you can now rename screenshots. You can also make a screenshot be the skin's thumbnail cover", to: "/skins" },
  { date: "2026-08-10", text: "Reduced free pack recharge time from 30s to 20s", to: "/packs" },
  { date: "2026-08-09", text: "Song previews on map search now open a player, and use your default volume", to: "/maps" },
  { date: "2026-08-09", text: "Now you can choose the pattern to showcase on your skin thumbnails", to: "/skins" },
  { date: "2026-08-09", text: "Map search is much faster, and huge result counts show as 5,000+", to: "/maps" },
  { date: "2026-08-09", text: "The farm helper loads faster, and an empty board now explains why instead of showing nothing", to: "/farm-helper" },
  { date: "2026-08-08", text: "Pick a whole continent or region, like Europe or Southeast Asia, instead of just one country" },
  { date: "2026-08-08", text: "New maniacard update to rebalance 4K players", to: "/packs" },
  { date: "2026-08-08", text: "Low OD maps no longer increase MSD rating", to: "/my-stats" },
  { date: "2026-08-07", text: "Uploaded replays on unranked maps show the right accuracy and client again, and seeking now works", to: "/replay" },
  { date: "2026-08-05", text: "Fixed some bugs on how skins are rendered", to: "/skins" },
  { date: "2026-08-05", text: "New Blitz mode for higher or lower: every round is timed and it has a leaderboard", to: "/streak" },
  { date: "2026-08-05", text: "New top 500 difficulty mode, and an idk button for when you literally have no clue", to: "/streak" },
  { date: "2026-08-05", text: "Sort skins by size, and narrow the grid to your own uploads", to: "/skins" },
  { date: "2026-08-05", text: "New 4K and 7K packs: every card in one is a player who mains that keymode", to: "/packs" },
  { date: "2026-08-05", text: "Performance optimizations and speedups everywhere" },
  { date: "2026-08-05", text: "You can now show your name under the spectators of a replay you are watching, from settings", to: "/settings" },
  { date: "2026-08-05", text: "The player name on a replay opens their profile", to: "/replay" },
  { date: "2026-08-04", text: "New higher or lower difficulty mode: anyone in the entire pool (previously was only the top 1000)", to: "/streak" },
  { date: "2026-08-04", text: "Skins now know about 7k+1, when you upload one and when you filter for it", to: "/skins" },
  { date: "2026-08-04", text: "Sort skins by a keymode and every cover shows that keymode's thumbnail", to: "/skins" },
  { date: "2026-08-04", text: "Skin thumbnails load faster", to: "/skins" },
  { date: "2026-08-04", text: "New game: higher or lower. The longer your streak, the more shards you earn", to: "/streak" },
  { date: "2026-08-04", text: "See the latest replays other people uploaded, on the upload tab", to: "/replay" },
  { date: "2026-08-03", text: "Skins can be private now: only you can open or download one, and your replays still use it", to: "/skins" },
  { date: "2026-08-03", text: "Added a few more players to GOAT status", to: "/packs" },
  { date: "2026-08-03", text: "Tapping a pull in the live ticker now opens that pull, not the player's profile", to: "/packs" },
  { date: "2026-08-03", text: "Performance optimizations for packs, player pages and the farm helper" },
  { date: "2026-08-02", text: "Added a new secret rarity for a few players", to: "/packs" },
  { date: "2026-08-02", text: "Share any replay with a friend, from the start or from the moment you are watching", to: "/replay" },
  { date: "2026-08-02", text: "Added import skin support to replays", to: "/replay" },
  { date: "2026-08-02", text: "Bugfixes and performance optimizations for replays", to: "/replay" },
  { date: "2026-08-01", text: "New feature: Side by side replay comparison", to: "/replay" },
  { date: "2026-07-31", text: "New in-game style look for the replay viewer", to: "/replay" },
  { date: "2026-07-31", text: "Added support for storyboards on replays", to: "/replay" },
  { date: "2026-07-31", text: "Customize the replay HUD: drag, resize or remove any element", to: "/replay" },
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
