import type { LivePlayerSkillHistoryEntry } from "../../lib/live-backend";

/**
 * Rating-system changes worth explaining inside a player's skill history.
 *
 * Static data on purpose, like the site changelog: a note lands in the same
 * commit as the work it describes, and no projection has to remember it.
 *
 * House rules:
 * - One line, written for the player whose number just moved. Say what the
 *   site now measures differently, not how it is implemented.
 * - Only changes that can move a rating or a dan on their own. Everything
 *   else belongs in the footer changelog.
 * - Newest first. `date` is the day it went live on the site clock (UTC-6).
 * - `keyCounts` limits a note to the keymodes it can touch; leave it out for
 *   a change every keymode feels.
 * - `mapLink` names one chart the note is easier to read with an example of.
 *   Write `{link}` where its name belongs in the sentence.
 */
export interface SkillHistoryNote {
  /** Day it went live on the site clock (UTC-6), as YYYY-MM-DD. */
  date: string;
  text: string;
  keyCounts?: readonly number[];
  /** Rendered in place of `{link}`, linking to the map page. */
  mapLink?: { label: string; beatmapId: number };
}

export const SKILL_HISTORY_NOTES: readonly SkillHistoryNote[] = [
  {
    date: "2026-09-18",
    text: "A chart with 45% or more holds now files as LN at a rate where its LN rating beats its Overall, so a DT play on such a chart can count toward your LN rating and LN dan.",
    keyCounts: [4],
  },
  {
    date: "2026-09-17",
    text: "Inverse-style charts made of short holds chained one after another now count as LN charts at the rate you played, so plays on them can move your LN rating and LN dan.",
    keyCounts: [4],
  },
  {
    date: "2026-09-17",
    text: "4K LN ratings now scale with rate the same way MSD does. DT LN plays rate higher and HT LN plays lower than before.",
    keyCounts: [4],
  },
  {
    date: "2026-09-16",
    text: "Improved 4K vibro detection to catch more patterns that were inflating ratings, while restoring MSD and Dan credit to dense chordjack plays that were incorrectly excluded.",
    keyCounts: [4],
  },
  {
    date: "2026-09-16",
    text: "Only your two best rate plays on the same chart now count toward Dan, chosen by Dan credit, and both count fully. Verified rate reuploads share the limit; further rates no longer contribute a shrinking share.",
    keyCounts: [4, 6, 7],
  },
  {
    date: "2026-09-16",
    text: "Clearing a supported skillset chart can now set that skillset's Dan, even without enough ordinary clears for an estimate. For example, clearing {link} sets your 4K Speed Dan to Delta. A higher estimate from your other clears is kept.",
    keyCounts: [4, 7],
    mapLink: { label: "Volcanic ~ Delta ~", beatmapId: 4969890 },
  },
  {
    date: "2026-09-16",
    text: "Fixed Hard Rock and Difficulty Adjust scores being rated at the original file's OD. Dan credit now uses the OD you actually played, which also decides whether the clear counts on the LN or the regular ladder.",
    keyCounts: [4, 6, 7],
  },
  {
    date: "2026-09-15",
    text: "Prevented temporary rating drops when unchanged scores were waiting for recalculation or missing chart data. Their previous ratings now stay available while the update is pending.",
  },
  {
    date: "2026-09-13",
    text: "4K LN now has its own skill rating based on holding, release timing and finger coordination, instead of using Overall MSD as the LN rating.",
    keyCounts: [4],
  },
  {
    date: "2026-09-13",
    text: "The accuracy estimate behind MSD ratings was recalibrated: it now reads your judgements against your scoring client, OD, playback rate and hold share instead of treating every judgement window the same. Ratings can move up or down, including on LN maps and custom rates.",
  },
  {
    date: "2026-09-13",
    text: "4K LN eligibility now checks hold lengths at the played rate and OD. Charts whose holds mostly play like taps can move to regular ratings instead of contributing LN credit.",
    keyCounts: [4],
  },
  {
    date: "2026-09-13",
    text: "4K LN Dan now accepts OD 7 and above, and passes down to 91% instead of 94.5%. Below-bar penalties are gentler: a 96% clear loses about half a level instead of a full level.",
    keyCounts: [4],
  },
  {
    date: "2026-09-13",
    text: "Removed the penalty jump just below the 6K/7K LN Dan accuracy requirement. A 94.9% clear now loses about 0.13 levels instead of 0.36; scores at 94% or below are unchanged.",
    keyCounts: [6, 7],
  },
  {
    date: "2026-09-13",
    text: "Improved 4K speed and tech classification: slow sections no longer decide a fast map's skill, and jacks within chords are recognized. Some clears now contribute to different skillset Dans.",
    keyCounts: [4],
  },
  {
    date: "2026-09-13",
    text: "Halved the above-bar accuracy bonus for 4K jack Dan clears. The chart's base credit and penalties for scores below the accuracy requirement are unchanged.",
    keyCounts: [4],
  },
  {
    date: "2026-09-13",
    text: "Restored eligible Difficulty Adjust plays that lowered OD, including 7K Invert plays at OD 5. Dan credit still requires the minimum OD for the relevant ladder.",
  },
  {
    date: "2026-09-11",
    text: "Reuploads with a few added notes are now recognized as the same chart, reducing extra rating credit from farming copies.",
  },
  {
    date: "2026-09-10",
    text: "Fixed some 4K handstream and jumpstream maps incorrectly counting toward tech dan.",
    keyCounts: [4],
  },
  {
    date: "2026-09-10",
    text: "Clears at the bottom of a Dan ladder, such as 7K kyu or 4K 1--, now contribute evidence instead of being ignored.",
    keyCounts: [4, 6, 7],
  },
  {
    date: "2026-09-09",
    text: "4K Dan estimates now apply the marathon correction to maps longer than five minutes, which can change the level credited for long-map clears.",
    keyCounts: [4],
  },
  {
    date: "2026-09-09",
    text: "Improved detection of recurring short vibro bursts in 4K. Localized bursts are removed before rating the remaining notes; maps dominated by vibro remain excluded.",
    keyCounts: [4],
  },
  {
    date: "2026-09-09",
    text: "Fixed archived stable scores being rated as lazer, which had inflated some LN MSD ratings.",
  },
  {
    date: "2026-09-07",
    text: "MSD ratings now use at most two plays per chart across its rates, chosen by Overall MSD. Further rate farms no longer add entries to your skill ratings.",
  },
  {
    date: "2026-09-07",
    text: "Passes below the MSD accuracy floor can now contribute Dan evidence when they meet the Dan requirements, instead of being dropped with their MSD rating.",
    keyCounts: [4, 6, 7],
  },
  {
    date: "2026-09-06",
    text: "Reduced the rice dan penalty for scores just below the accuracy requirement. A 95.9% on a chart requiring 96% now gives almost full dan credit.",
  },
  {
    date: "2026-09-06",
    text: "Adjusted 4K vibro detection to exclude more fast rolls and repeated chords from skill and dan ratings, including DT scores on ranked maps.",
    keyCounts: [4],
  },
  {
    date: "2026-09-06",
    text: "Fixed some 4K stamina maps incorrectly counting toward speed dan.",
    keyCounts: [4],
  },
  {
    date: "2026-09-06",
    text: "Clears at different rates of the same chart now carry less weight in your dan average: 100% for the best clear, 90% for the next, then 81%, and so on. Matching reuploads count as the same chart.",
  },
];

export type SkillHistoryRow =
  | { kind: "entry"; entry: LivePlayerSkillHistoryEntry & { day: string } }
  | { kind: "note"; note: SkillHistoryNote };

/**
 * Merge the notes into a newest-first day list, above the day they landed on.
 *
 * A note older than the oldest loaded day is left out: it belongs to a page
 * the reader has not asked for yet, and once they load it the note comes with
 * it. A note newer than every entry still shows, since a player whose rating
 * has not been recomputed yet is exactly who the note is for.
 */
export function mergeSkillHistoryNotes(
  days: (LivePlayerSkillHistoryEntry & { day: string })[],
  keyCount: number,
  notes: readonly SkillHistoryNote[] = SKILL_HISTORY_NOTES,
): SkillHistoryRow[] {
  const oldest = days.at(-1)?.day;
  if (!oldest) return days.map((entry) => ({ kind: "entry", entry }));
  const visible = notes.filter((note) =>
    note.date >= oldest && (!note.keyCounts || note.keyCounts.includes(keyCount)));
  const rows: SkillHistoryRow[] = [];
  let index = 0;
  for (const entry of days) {
    while (index < visible.length && visible[index].date >= entry.day) {
      rows.push({ kind: "note", note: visible[index++] });
    }
    rows.push({ kind: "entry", entry });
  }
  for (; index < visible.length; index++) rows.push({ kind: "note", note: visible[index] });
  return rows;
}
