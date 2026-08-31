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
  { date: "2026-08-31", text: "To make OD 0 7K maps count for LN dan, play them with Difficulty Adjust and set Overall Difficulty to 5. The play is judged at the OD you set instead of the map's", to: "/dan-estimates" },
  { date: "2026-08-31", text: "The Skills tab has MSD plays and Dan plays next to Ratings. MSD plays lists the plays behind a skill rating, one keymode and one skill at a time, ordered by best or most recent, and you can cap how many rates per chart count or hide ranked maps. Dan plays lists the clears behind a dan, regular or LN, and the plays that do not count, with the reason. Ratings now shows one keymode at a time, picked from the row of ratings above it" },
  { date: "2026-08-31", text: "Updated to a MinaCalc version (0.74.0, was 0.72.3) with support from 4K to 18K, so 5K, 8K, 9K, 10K and every keymode up to 18K get an MSD and skillset breakdown instead of only a pattern profile, and plays on those keymodes count toward your Skill rating, each keymode rated separately like 4K, 6K and 7K already were. Maps on those keymodes are being rated now", to: "/my-stats" },
  { date: "2026-08-31", text: "More work on how maps are sorted into skills on 4K, so fewer tech maps land under speed. A map that is genuinely both now counts in both skills, and so does a long jack map that is also stamina. About one map in seven changes skill", to: "/dan-estimates" },
  { date: "2026-08-30", text: "Dan estimates now leave up to three passes out of a skillset's average when they credit more than five levels below the average of your five best in it. A dan 6 pass in a skillset whose best five are beta is left out. They still show in the dan window, marked not counted", to: "/dan-estimates" },
  { date: "2026-08-29", text: "Fixed plays with the lazer Difficulty Adjust mod counting toward skill ratings and dan, and plays with the EZ mod counting toward dan. EZ plays still count for MSD, with their Wife accuracy measured against the wider EZ windows, so they rate lower and there is nothing to gain from playing EZ", to: "/my-stats" },
  { date: "2026-08-28", text: "Player profiles have a new Add a missing score button: paste an osu! score link and, if the score really belongs to that player, the site tracks it like any other. Old ranked and loved plays can finally count toward skill ratings and dan without replaying them, and you can add scores to anyone" },
  { date: "2026-08-28", text: "The All clears tab on the dan window no longer stops at 20: click Load more at the bottom to see the next 50" },
  { date: "2026-08-28", text: "Dan badges now show a small ring when the estimate is incomplete, so you can tell before opening it. It fills as your skillsets get closer to their 20 clears, on player pages, My Stats and the dan rankings", to: "/dan-estimates" },
  { date: "2026-08-27", text: "The Chordjack skill on 6K and 7K profiles has been renamed to Jack, and it also counts jack maps the old version missed, so fewer of them land under Tech" },
  { date: "2026-08-27", text: "New dan bonus and decay system: passes with high accuracy are now worth more dan, and passes that barely miss the accuracy requirement still count for a bit less instead of not counting at all", to: "/dan-estimates" },
  { date: "2026-08-27", text: "Dan estimates reworked: each skillset dan is now the average of your 20 best passes in it instead of your 4th best pass, your dan is the average of those skillsets, clearing a real dan course sets your dan when the average sits lower, and lazer custom rate plays like 1.15x now count. The page explaining how dan is estimated is updated to match", to: "/dan-estimates" },
  { date: "2026-08-26", text: "Click Key Split on a player page to see how much pp each keymode is worth, 4K, 5K, 6K, 7K and up, so you can track your pp on each. Pick a keymode on the Best Performance tab and the plays this site tracked below your osu! top 200 show up in the list too, so every keymode gets a top of up to 200 plays of its own instead of sharing one" },
  { date: "2026-08-26", text: "Rankings now has MSD and Dan tabs next to Performance: see who is rated highest on each skillset, per keymode, and who holds the highest dan", to: "/rankings" },
  { date: "2026-08-26", text: "Click a dan on the skills tab of a player page to see the clears the estimate is built on" },
  { date: "2026-08-26", text: "Made a page to explain how dan levels are estimated", to: "/dan-estimates" },
  { date: "2026-08-26", text: "You can now build and post your own map collections. The collections tab on maps has a Community half: pick maps, give the list a title and tags, post it, and like anyone else's. Each one gets its own page to share", to: "/maps" },
  { date: "2026-08-26", text: "Fixed vibro maps getting a huge MSD and inflating skill ratings", to: "/maps" },
  { date: "2026-08-26", text: "Improved LN Release detection for 7K" },
  { date: "2026-08-24", text: "Recycle duplicates now takes a press and hold, so you can no longer accidentally recycle all your copies", to: "/packs" },
  { date: "2026-08-24", text: "If you complete your collection the next pack you open comes with an Eternal card of yourself", to: "/packs" },
  { date: "2026-08-24", text: "Dan estimates, map difficulty values and player skill ratings are being recalculated after a rating-system update. The recalculation should take about a day, and results may be missing or mix old and new values until it finishes" },
  { date: "2026-08-23", text: "New bug report page", to: "/report" },
  { date: "2026-08-23", text: "New per-hand accuracy HUD for replays. Drag it anywhere and right-click it to choose meters, numbers, rings or a balance bar", to: "/replay" },
  { date: "2026-08-23", text: "Uploaded replays now use the uploader's replay skin instead of sometimes picking the wrong player's skin", to: "/replay" },
  { date: "2026-08-23", text: "Links to manually uploaded replays now show a full result-card preview in Discord and social apps", to: "/replay" },
  { date: "2026-08-21", text: "Skillset play lists on the skills tab now label each play's strongest skillset, so you can tell when an LN map is on your Chordjack list just for its overall" },
  { date: "2026-08-21", text: "Fixed long notes in replays and skin previews stacking repeated note ends. NoteBodyStyle support was missing", to: "/replay" },
  { date: "2026-08-21", text: "Dynamic renders now show the map's star rating next to your newest top play", to: "/dynamic-renders" },
  { date: "2026-08-21", text: "New maniacard update to rebalance 6K players: their pp used to count for nothing, so their cards rated way below their real level", to: "/packs" },
  { date: "2026-08-21", text: "Added Spanish and Chinese translations. The site follows your browser's language, and you can change it in settings" },
  { date: "2026-08-19", text: "New feature: dynamic renders for your osu! page, under your avatar menu", to: "/dynamic-renders" },
  { date: "2026-08-19", text: "Collections: showcase your cards, browse anyone else's, and some pack stats", to: "/packs/collections" },
  { date: "2026-08-19", text: "A skin you uploaded private now shows up as new on the skins page the day you make it public, not the day you uploaded it", to: "/skins" },
  { date: "2026-08-18", text: "Made the player Dan Estimates feature visible to everyone on the Skills tab. Just know that I haven't even put in the effort to make sure its estimates are generally accurate, AND I haven't touched its implementation in over a month, but I will eventually..." },
  { date: "2026-08-18", text: "The Skill rating formula is still being tuned, so ratings may change", to: "/my-stats" },
  { date: "2026-08-16", text: "Fixed chordjack maps getting tagged and rated as Bracket", to: "/maps" },
  { date: "2026-08-16", text: "Map search now accepts pasted osu! map links", to: "/maps" },
  { date: "2026-08-16", text: "Custom rate plays from lazer, like 1.15x, now count toward your skill rating", to: "/my-stats" },
  { date: "2026-08-16", text: "Fixed LN maps showing an impossible pattern BPM, like 4497BPM Inverse on a 150BPM map. Affected maps are being recomputed", to: "/maps" },
  { date: "2026-08-15", text: "Collections show every dan logo in a pack's range on its cover, not just the last one", to: "/maps" },
  { date: "2026-08-15", text: "Fixed many maps showing a way lower MSD and dan estimate than they should since Aug 14. Affected maps and player skill ratings are being recomputed", to: "/maps" },
  { date: "2026-08-15", text: "Skins that mix circles and bars are now labeled correctly", to: "/skins" },
  { date: "2026-08-15", text: "Farm helper: estimated pp gains and target scores are more realistic, they used to lowball what a map could give you", to: "/farm-helper" },
  { date: "2026-08-15", text: "Farm helper: push acc is now skillboost. Skillboost maps are hidden by default until you achieve one of its scores; the skillboost tab still shows them", to: "/farm-helper" },
  { date: "2026-08-15", text: "If you slice through the middle of a pack, the cards inside get sliced too. Imagine cutting a goat lol", to: "/packs" },
  { date: "2026-08-14", text: "New skills tab on user pages: click on a skillset to see more" },
  { date: "2026-08-13", text: "Filter skins by note shape, lane cover, mania stage, screenshots, stable or lazer, and display resolution", to: "/skins" },
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
