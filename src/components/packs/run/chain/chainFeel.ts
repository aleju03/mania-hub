/* Timings and magnitudes for the chain run's table, beside runFeel.ts whose
   springs, shake and juice it reuses. `// tune` marks numbers picked by eye. */

export const CHAIN_FEEL = {
  /* The row's scoring chain: the first step waits 400ms and each next one
     0.94x as long, all the way down to 60ms, so a long chain keeps
     speeding up through its whole length instead of settling on one tick. */
  chain: {
    firstMs: 400,
    decay: 0.94,
    floorMs: 55,
    /* Heavier beats hold a little longer wherever they fall. */
    extraMs: { break: 160, hand: 180, scene: 280, multiplier: 360, goat: 520, secondPass: 0 } as Record<string, number>,
    /* A scene card stamping onto the row is a full beat of its own. */
    stampMs: 300,
    /* A 727: the chain freezes this long on the first one in a row, shorter
       on any after it. */
    wysiMs: 1200,
    wysiSmallMs: 420,
    wysiShake: 1.6,
    /* Second gear: past gearAtMs the steps run at gearFactor of their hold,
       down to gearFloorMs, two links a beat. */
    gearAtMs: 6000,
    gearFactor: 0.62,
    gearFloorMs: 70,
    /* Deliberate holds: the round passing its target, the last multiplier. */
    crossHoldMs: 650,
    crossShake: 1.1,
    finalMultiplierMs: 0,
    /* A tap during the chain: x3, then a second one skips to the slam. */
    fastForward: 3,
    reducedStepMs: 120,
    /* Before the first step, so the row reads as about to play. */
    leadMs: 260,
    /* After the last step, before the row's total lands. */
    tailMs: 120,
    /* The row total punches, holds, then flies into the round score. */
    /* The total comes down into the row (centreMs), slams there and holds. */
    centreMs: 200,
    centreShake: 1.4,
    holdMs: 260,
    flyMs: 380,
    afterSlamMs: 100,
    afterFireMs: 140,
    igniteDelayMs: 170,
    /* Shake per step grows with the combo, so a long chain heats the room. */
    stepShake: 0.12,
    stepShakePerCombo: 0.006,
    stepShakeMax: 0.45,
    breakShake: 0.55,
    multiplierShake: 0.9,
    secondPassShake: 0.7,
    slamShake: 0.9,
    slamShakePerShare: 0.9,
    igniteShake: 0.5,
    /* Floating numbers live floatMs while the chain is slow and are cut
       toward floatMinMs once steps drop under 200ms. */
    floatMs: 700,
    floatMinMs: 380,
  },
  /* Cards moving between the hand and the row. */
  move: {
    spring: { type: "spring", stiffness: 520, damping: 30, mass: 0.9 } as const,
    /* A drag past this many px is a drag, not a tap. */
    dragPx: 7,
    /* Long-press on touch for a card's details. */
    longPressMs: 450,
    hoverDetailsMs: 380,
  },
  /* The pack stage. */
  pack: {
    dealStaggerMs: 60,
    flipStaggerMs: 80,
    /* A flip waits this long at most for its card's face to paint. */
    faceWaitMs: 1800,
    /* After the last flip of a round pack, before its cards join the hand. */
    joinHoldMs: 420,
    joinStaggerMs: 60,
    keepLiftPx: 18,
    /* Kept cards leave for the deck, the rest recycle into shards. */
    keepFlyMs: 460,
    recycleMs: 420,
    tokenMs: 480,
    tokenStaggerMs: 45,
    afterKeepMs: 0,
  },
  /* A cleared round's pay, line by line. */
  pay: {
    bannerMs: 420,
    lineMs: 220,
    tokenMs: 560,
    afterMs: 300,
  },
} as const;

export function chainStepMs(index: number, kind: string, reducedMotion: boolean): number {
  const feel = CHAIN_FEEL.chain;
  if (reducedMotion) return feel.reducedStepMs;
  const base = Math.max(feel.floorMs, feel.firstMs * feel.decay ** index);
  // A trait ticking up a link is half the beat of a card firing, so the
  // chain never idles on the small steps.
  const share = kind === "link" ? 0.5 : 1;
  return Math.round(Math.max(feel.floorMs * share, base * share) + (feel.extraMs[kind] ?? 0));
}
