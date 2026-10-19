/* Timings for the song-clear tally and the run-end screens, cited against
   local-notes/pack-run-gauntlet/reference/feel.md like runFeel.ts. Kept apart
   only while other builders edit runFeel.ts; it can fold into RUN_FEEL. */

export const RUN_END_FEEL = {
  tally: {
    /* The panel springs up from below (feel §10). */
    panelSpring: { type: "spring", stiffness: 420, damping: 30, mass: 1 } as const,
    panelFromPx: 260,
    /* The panel springs up 0.2s after the score has settled (feel §10). */
    enterMs: 200,
    /* Once near rest: jiggle +3 (one unit of RUN_FEEL.shake) and the clear sound. */
    landMs: 200,
    landShake: 1,
    /* First line after landing (feel §10: 0.1s pause, then 0.2s). */
    firstLineMs: 250,
    /* One line every 0.5s (feel §10: row hold 0.5s). */
    lineMs: 500,
    /* A line's value counts up this long, then stamps. */
    countMinMs: 160,
    countMaxMs: 380,
    countPerShardMs: 14,
    /* Bottom of the panel: 0.4 + 0.5s before the total (feel §10), shortened. */
    totalLeadMs: 600,
    totalShake: 0.45,
    /* The button arrives this long after the total lands (feel §10: the
       total is the button, 0.9s bottom hold; here 0.45s). */
    buttonMs: 450,
    /* Shards fly from the total into the HUD wallet, beside the button. */
    flyLeadMs: 150,
    flyStaggerMs: 55,
    flyMs: 560,
    flyArcPx: 70,
    flyMaxTokens: 12,
    /* The continue button after the last shard lands. */
    settleMs: 220,
  },
  end: {
    /* Loss: a flat red wash to 80% in 0.3s; win: green to 50% (feel §13). */
    washMs: 300,
    lossWash: "rgba(92, 14, 26, 0.8)",
    winWash: "rgba(18, 78, 54, 0.5)",
    landShake: 1,
    /* The title pops in by letters within 0.4s (feel §13: letters from 0.4s;
       pulled in so the panel lands complete). */
    titleLeadMs: 60,
    titleMs: 400,
    letterStaggerMs: 34,
    letterMs: 220,
    /* Loss: the panel sinks into place instead of springing. */
    lossSinkPx: 18,
    lossSinkMs: 600,
    /* Win letters fan in, then sway 0.02 rad at 2 rad/s per letter (feel §13). */
    winSwayDeg: 1.15,
    winSwayPeriodMs: 3140,
    winFanDeg: 9,
    /* The numbers are on the panel as it lands (feel §13: static); the
       actions follow within a second. */
    actionsAtMs: 800,
  },
} as const;
