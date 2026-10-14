/* Every timing, curve and magnitude the run table moves by, in one place so
   the feel can be tuned without hunting through components. Numbers marked
   `// tune` were picked by eye before reference/feel.md existed; replace them
   with the measured ones (and cite the section) when it lands. */

export type CubicBezier = readonly [number, number, number, number];

export const RUN_FEEL = {
  /* The pack in the play area. */
  pack: {
    /* Idle bob of the unopened pack. */
    bobPx: 5, // tune
    bobPeriodMs: 2600, // tune
    hoverScale: 1.04, // tune
    hoverTiltDeg: 10, // tune
    /* The top strip tearing away, then the body dropping out of the way
       once the last card has left it. */
    tearMs: 340, // tune
    tearEase: [0.2, 0.8, 0.3, 1] as CubicBezier, // tune
    tearFlyPx: 140, // tune
    tearSpinDeg: -28, // tune
    exitMs: 260, // tune
  },
  /* Cards leaving the pack for the hand (bar F1). */
  deal: {
    /* Fixed gap between one card leaving and the next. */
    staggerMs: 95, // tune
    /* Flight from the pack to the slot, a spring so it lands past the slot
       and settles back: the visible overshoot. */
    spring: { type: "spring", stiffness: 340, damping: 19, mass: 0.9 } as const, // tune
    /* Rough settle time of that spring, for sequencing. */
    settleMs: 520, // tune
    /* Spin a card picks up in flight, alternating sides. */
    flightSpinDeg: 14, // tune
    startScale: 0.62, // tune
  },
  /* Face down to face up, in hand order (bar F1). */
  flip: {
    /* Gap after the deal settles before the first card turns. */
    leadMs: 160, // tune
    staggerMs: 150, // tune
    durationMs: 340, // tune
    ease: [0.3, 0.1, 0.25, 1.25] as CubicBezier, // tune: last control point > 1 is the snap past flat
    /* Lift while the card is edge-on, so the turn reads as picked up. */
    liftPx: 14, // tune
    /* Beat after the last flip before scoring starts. */
    tailMs: 260, // tune
  },
  /* A card under the pointer (bar F2). */
  hover: {
    tiltDeg: 16, // tune: max rotateX/rotateY at the card's edge
    liftPx: 22, // tune
    scale: 1.09, // tune
    perspectivePx: 700, // tune
    tiltSpring: { stiffness: 260, damping: 20, mass: 0.6 }, // tune
    /* Tap lift on touch screens. */
    tapLiftPx: 30, // tune
  },
  /* Idle life of every card in the hand (bar F2): a slow wobble, each card
     on its own phase. */
  sway: {
    rotateDeg: 1.4, // tune
    translatePx: 2.5, // tune
    periodMs: 3800, // tune
    /* Spread of periods so no two cards ever line up again. */
    periodJitter: 0.18, // tune
  },
  /* How the hand lays out: a slight fan with overlap once crowded. */
  fan: {
    degPerCard: 2.6, // tune
    maxSpreadDeg: 14, // tune
    /* Drop of the outer cards below the middle one, per card from centre squared. */
    arcPx: 3.2, // tune
    /* Gap between cards while there is room. */
    gapFraction: 0.1, // tune
    /* Smallest share of a card left visible when the hand overlaps. */
    minVisibleFraction: 0.42, // tune
  },
  /* Table shake for heavy beats (the scoring builder uses it). */
  shake: {
    magnitudePx: 7, // tune
    decayMs: 280, // tune
    frequencyHz: 28, // tune
  },
  /* Interim scoring (RunScoring): the song score counting up. */
  scoring: {
    countMs: 600, // tune
    holdMs: 900, // tune
    resultHoldMs: 1300, // tune
  },
  /* The backdrop shader: how fast a mood change blends in. */
  backdrop: {
    moodLerpMs: 1000, // tune
    /* Render scale of the paint field against CSS px (it is soft, so it
       upscales without showing). DPR is capped separately. */
    resolutionScale: 0.6, // tune
    maxDpr: 1.5,
  },
  /* A hand about to be replaced: the old cards drop off the table. */
  discard: {
    durationMs: 280, // tune
    staggerMs: 35, // tune
    dropPx: 220, // tune
  },
} as const;

export function cubicBezierCss([a, b, c, d]: CubicBezier): string {
  return `cubic-bezier(${a}, ${b}, ${c}, ${d})`;
}
