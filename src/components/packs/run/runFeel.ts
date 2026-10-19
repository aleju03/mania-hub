/* Every timing, curve and magnitude the run table moves by, in one place so
   the feel can be tuned without hunting through components. Numbers cite the
   section of local-notes/pack-run-gauntlet/reference/feel.md they come from
   ("feel §7"); ones marked `// tune` are picked by eye where it gives none.

   The reference's main lesson (feel §2): nothing is tweened along a curve.
   Things chase their slot on a stiff, slightly underdamped spring, so the
   overshoot is the settle. Springs below are framer-motion's
   stiffness/damping/mass, tuned to land the same way: about 11% overshoot,
   most of the way there in ~0.1s. */

export type CubicBezier = readonly [number, number, number, number];

export const RUN_FEEL = {
  /* The pack in the play area. */
  pack: {
    hoverScale: 1.05, // feel §6: hover holds +0.05 scale
    hoverTiltDeg: 10, // tune
    /* Opening (feel §12): the pack shakes with a growing rotation built from
       three sines and swells, then bursts. Shortened from 1.3s to keep it a
       short tear; it also covers the server's round trip, so it runs until
       the draw answers, never less than chargeMs. */
    chargeMs: 650, // feel §12 is 1300; halved, tune
    chargeSinesHz: [0.8, 6.5, 10.7] as const, // feel §12
    chargeMaxDeg: 8.6, // feel §12: 0.15 rad
    chargeScale: 0.15, // feel §12: up to +15%
    /* The burst: the top strip tears off and the table jiggles. */
    tearMs: 220, // tune
    tearEase: [0.2, 0.8, 0.3, 1] as CubicBezier, // tune
    tearFlyPx: 150, // tune
    tearSpinDeg: -32, // tune
    burstShake: 1, // feel §5: +3 jiggle for a booster, the largest routine bump
    exitMs: 240, // tune
  },
  /* Cards leaving the pack for the hand (bar F1, feel §7). */
  deal: {
    /* Pause after the burst before the first card leaves. */
    leadMs: 120, // feel §7 waits 300 before a deal from the deck; shorter here since the tear already paused, tune
    staggerMs: 100, // feel §7: one card every 0.1s
    /* Flight to the slot: arrives in ~0.15s with ~11% overshoot (feel §2, §7). */
    spring: { type: "spring", stiffness: 700, damping: 30, mass: 1 } as const,
    settleMs: 320, // time for that spring to come to rest, for sequencing
    /* Cards lean into their flight (feel §2: rotation + velocity lean). */
    flightSpinDeg: 12, // tune
    startScale: 0.55, // tune
  },
  /* Face down to face up, in hand order (bar F1). */
  flip: {
    /* Gap after the deal settles before the first card turns. */
    leadMs: 140, // tune
    staggerMs: 110, // tune: close to the deal's 0.1s beat
    /* feel §2: the flip pinch runs at 8 widths/s, ~0.125s to edge-on and the
       same back. */
    durationMs: 250,
    ease: [0.45, 0, 0.55, 1] as CubicBezier, // near linear, as feel §2
    /* Lift while edge-on, so the turn reads as picked up. */
    liftPx: 12, // tune
    /* Beat after the last flip before scoring starts. */
    tailMs: 300, // feel §3: 0.3 to 0.4s pauses between scoring phases
  },
  /* A card under the pointer (bar F2, feel §6). */
  hover: {
    tiltDeg: 12, // feel §6 tilts 0.3 x the cursor offset inside the card; tune
    /* Hover holds +0.05 scale (feel §6); a small lift on top so the card
       clears its shadow. */
    scale: 1.05,
    liftFraction: 0.05, // tune
    /* A raised (tapped) card lifts 20% of its own height (feel, units). */
    tapLiftFraction: 0.2,
    perspectivePx: 700, // tune
    tiltSpring: { stiffness: 320, damping: 22, mass: 0.6 }, // tune
    /* The tiny tick a hover gives (feel §4: juice 0.02). */
    tickScale: 0.02,
  },
  /* Idle life of every card in the hand (bar F2, feel §6): a rotation sway on
     a ~3.1s period and a slow bob on a ~9.4s one, phased by position so the
     row ripples instead of moving in unison. */
  sway: {
    rotateDeg: 1.15, // feel §6: 0.02 rad
    rotatePeriodMs: 3140, // feel §6: sin(2t), period pi s
    bobFraction: 0.011, // feel §6: 0.03 units of a 2.75-unit card
    bobPeriodMs: 9400, // feel §6
    /* Phase step between neighbouring cards, as a share of the period. */
    phaseStep: 0.17, // tune
  },
  /* How the hand lays out (feel §6): fanned 0.2 rad across the row, the ends
     arcing down up to 0.25 units (9% of a card's height), overlapping once
     the row is crowded. */
  fan: {
    maxSpreadDeg: 11.5, // feel §6: 0.2 rad total
    degPerCard: 2.4, // tune: a short hand fans less than a full one
    arcFraction: 0.09, // feel §6
    gapFraction: 0.08, // tune
    minVisibleFraction: 0.42, // tune
  },
  /* Room shake (feel §5): small, stackable, decaying with a 0.2s time
     constant, a ~3.3Hz sway and a faster roll. One unit is the bump a panel
     or a booster gives (+3 jiggle): ~0.34% of the width and ~0.5deg. */
  shake: {
    magnitudeWidthFraction: 0.0034, // feel §5
    rollDeg: 0.5, // feel §5
    tauMs: 200, // feel §5: jiggle decays by 5/s
    decayMs: 500, // feel §5: gone in roughly half a second
    xHz: 3.2, // feel §5
    yHz: 3.5, // feel §5
    rollHz: 6.4, // feel §5
    /* Per scoring popup (feel §5: +0.7 of the +3 a panel gives). */
    popup: 0.23,
  },
  /* The whole table leans 1% toward the cursor (feel §5). */
  lean: {
    fraction: 0.01, // feel §5
    spring: { stiffness: 120, damping: 20, mass: 1 }, // tune
  },
  /* Juice on a trigger (feel §4), for the scoring sequence: squash, then a
     fast decaying scale ring and a slower rotation ring, 0.4s in all. */
  juice: {
    durationMs: 400,
    squash: 0.6,
    scaleHz: 8.1,
    rotateHz: 6.5,
    scoringCard: { amount: 0.24, rotateRad: 0.04 },
    firingCharm: { amount: 0.28, rotateRad: 0.16 },
    hud: { amount: 0.4, rotateRad: 0.24 },
  },
  /* The scoring sequence (RunScoring, bar F3/F4). One step at a time. The
     reference holds a flat 0.75-0.94s a step (feel §3); the owner wants the
     chain to build, so the first step holds stepFirstMs and each later one
     decays geometrically toward stepFloorMs. */
  scoring: {
    /* The pattern lands with its base notes x combo, then breathes (feel §3:
       0.4s hold after the hand name). */
    patternHoldMs: 620, // tune
    stepFirstMs: 420,
    stepFloorMs: 140,
    stepDecay: 0.8, // per step, tune
    /* Weightier beats hold a little longer at any point in the chain; a
       charm firing for the whole pack is the payoff, so it gets the most. */
    stepExtraMs: { xMult: 110, debuff: 70, break: 140, charm: 150 } as Record<string, number>,
    /* After the last step, before the total resolves (feel §3: 0.4s). */
    tailMs: 360,
    /* notes x combo resolve to the pack's total in the play area: it counts
       up there (feel §3 counts 0.5s), lands with a punch and holds (0.8s),
       then flies into the song score, which takes it in one slam. */
    totalCountMs: 520,
    holdMs: 800,
    flyMs: 260, // tune
    /* The fire catches a beat after the slam, so the two do not land as one
       noise; the ignite shake is skipped this close to the slam's. */
    igniteDelayMs: 170,
    igniteShakeGapMs: 300,
    /* What the song holds on after the slam before the table moves on. */
    afterSlamMs: 520,
    afterFireMs: 900,
    /* A tap during scoring: x3, then a second jumps to the total. */
    fastForward: 3,
    /* Reduced motion: a flat, quick chain with no wobble. */
    reducedStepMs: 170,
    /* Floating text over the firing card or charm (feel §3: pops in, floats
       up, fades in 1/3s), on the real clock. It lives floatMs, cut toward
       floatMinMs once the chain's holds drop under 200ms so a fast chain
       does not stack numbers. */
    floatMs: 760,
    floatMinMs: 450,
    floatRisePx: 30,
    /* Shake per step (feel §5: +0.7 jiggle a popup) and at the slam (a
       panel's +3 and up with the share of the target the pack covered). */
    stepShake: 0.23,
    multiplierShake: 0.5,
    slamShake: 0.9,
    slamShakePerShare: 0.9,
    igniteShake: 0.5,
  },
  /* The flame on the song score once it passes the target (bar F5, feel §3):
     intensity from the overshoot on a log scale, chased by a soft spring that
     flares on ignition and settles. */
  flame: {
    /* intensity = base + perLog5 * log5(score / target), capped. */
    base: 0.45,
    perLog5: 0.55,
    max: 1.6,
    /* Spring: stiffness, damping while rising, damping while falling. Flares
       to ~1.75x at ~1s and settles in ~2.4s (feel §3 flares 80%, ~3.7s). */
    stiffness: 8,
    dampUp: 0.5,
    dampDown: 5,
    /* The fire burns faster the hotter it is (feel §3: 1 + 0.2 x intensity). */
    speedPerIntensity: 0.6,
    /* Pixel cell in CSS px (feel §3 pixelates to a coarse grid). */
    cellPx: 3,
  },
  /* The backdrop (feel §9): palette eases in 0.6s; the swirl tightens for a
     mod song, winding up faster than it unwinds. */
  backdrop: {
    moodLerpMs: 600, // feel §9
    swirlUpPerSec: 2, // feel §9
    swirlDownPerSec: 0.3, // feel §9
    /* Render scale of the paint field against CSS px (it is soft, so it
       upscales without showing). DPR is capped separately. */
    resolutionScale: 0.6, // tune
    maxDpr: 1.5,
  },
  /* An old hand leaving the table before the next deal (feel §7: hand to
     deck 0.08s apart). */
  discard: {
    durationMs: 260, // tune
    staggerMs: 60, // feel §7 is 80, tune
    dropPx: 220, // tune
  },
} as const;

export function cubicBezierCss([a, b, c, d]: CubicBezier): string {
  return `cubic-bezier(${a}, ${b}, ${c}, ${d})`;
}
