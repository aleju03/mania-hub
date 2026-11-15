/* Timings and magnitudes for the shop and the charm rail, kept beside
   runFeel.ts (whose springs they reuse) so the shop's feel can be tuned in
   one place. "feel §N" cites local-notes/pack-run-gauntlet/reference/feel.md;
   `// tune` marks numbers picked by eye. */

export const SHOP_FEEL = {
  /* The shop easing in and out of the play area; the table jiggles once it
     is near rest (feel §11: +3 jiggle at ~0.2s). */
  panel: {
    spring: { type: "spring", stiffness: 330, damping: 27, mass: 1 } as const, // ~11% overshoot, tune
    landMs: 220, // feel §11: 0.2s
    exitMs: 260, // tune
  },
  /* Offers dealing in once the shop has landed (feel §11: items materialize
     one by one, a sound per item; feel §7: 0.1s apart). */
  deal: {
    leadMs: 360, // landMs + 0.14s (feel §11: 0.1-0.2s after the panel)
    rerollLeadMs: 60, // after a reroll the shop is already up, tune
    staggerMs: 100, // feel §7
    fromY: 70, // tune
    fromRotateY: -110, // tune: cards turn face up as they land
    fromScale: 0.7, // tune
    /* Lands with a visible overshoot (feel §2: ~11%). */
    spring: { type: "spring", stiffness: 520, damping: 24, mass: 1 } as const,
  },
  /* The old offers leaving on a reroll: flipped away upward, quickly, so the
     new ones are not kept waiting (feel §11 removes them outright). */
  sweep: {
    durationMs: 170, // tune
    staggerMs: 45, // tune
    toY: -40, // tune
    toRotateY: 95, // tune
  },
  /* Remaining offers closing the gap a bought one left (feel §2 spring). */
  recentre: { type: "spring", stiffness: 420, damping: 32, mass: 1 } as const,
  /* A bought charm: squashed on the press (feel §4: juice squash 1 - 0.6 x
     0.24), lifted over its card while the server answers, then flown to its
     slot on a spring that leans into its motion (feel §2). */
  ghost: {
    pressScale: [1, 0.86, 1.14, 1.08] as const, // feel §4 squash then ring, settling lifted
    pressMs: 260,
    liftPx: 16, // tune
    spring: { type: "spring", stiffness: 300, damping: 24, mass: 1 } as const, // tune
    leanPerVelocity: 0.012, // deg per px/s, feel §2: 0.015 x velocity, tune
    leanMaxDeg: 16, // tune
    backMs: 160, // tune
    /* The slot's pop once it lands (feel §4: juice ring). */
    popScale: [1, 1.26, 0.93, 1.03, 1] as const,
    popRotate: [0, -9, 6, -2, 0] as const,
    popMs: 420, // feel §4: 0.4s juice
  },
  /* Selling (feel §11): a wobble first, then the charm dissolves to gold and
     the +N rises; the neighbours close the gap once it has gone. */
  sell: {
    wobbleScale: [1, 0.93, 1.08, 0.98, 1] as const, // feel §4: sell juice 0.12
    wobbleRotate: [0, -9, 7, -3, 0] as const, // feel §4: sell rotation 0.16 rad
    wobbleMs: 400, // feel §4
    holdMs: 200, // feel §11: 0.2s before the coin
    dissolveMs: 600, // feel §11: 0.7s dissolve, tune
  },
  /* Drag on the rail: the charm leans by its horizontal speed (feel §2). */
  drag: { leanPerVelocity: 0.015, leanMaxDeg: 14, scale: 1.12 }, // feel §2, §6 (+0.1 while dragged)
  /* Shakes on the table, in RUN_FEEL.shake units (1 = a panel arriving,
     feel §5 +3 jiggle). */
  shake: {
    open: 1, // feel §5: a panel arriving
    reroll: 0.4, // tune
    buy: 0.25, // tune
    sell: 0.2, // tune
  },
  /* A refused action shakes the thing that was pressed (feel §4: "no space"
     juice), as a side-to-side shudder in px. */
  refuse: {
    keyframes: [0, -9, 8, -6, 4, -2, 0] as const,
    durationMs: 380, // tune
  },
  /* Shard amounts tick to their new value rather than jumping. */
  tickMs: 450, // tune
  /* A "+N" / "-N" rising off where shards changed hands (feel §11). */
  float: { durationMs: 1100, risePx: 26 }, // feel §11: hold 0.8s, fade 1/3s
  /* A refusal's message stays this long. */
  messageMs: 2600, // tune
  /* Hover tilt and lift, as the hand's cards (RUN_FEEL.hover). */
  hover: { tiltDeg: 14, lift: 8, scale: 1.05 }, // tune
  /* Charm size on the rail against the size the table asks for, fitted to
     the rail's width. */
  railScale: 1,
} as const;
