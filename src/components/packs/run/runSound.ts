/* Every sound the run table plays, by beat. Components call only these;
   packSfx.ts owns decoding and playback, scripts/audio/pack-run-sfx.py renders
   the cues.

   Pitch rules:
   - `chain` is the position of a step in the current scoring chain (0-based).
     Each step type is a few takes of one foley hit with a short damped note
     under it; the whole hit plays at rate 0.9 + 0.016 x chain (the
     reference's +1.6% a step), capped at 1.4, so the clinks and knocks climb
     with the note. Notes, combo, multiplier, again and charm steps share the
     one climb, so a mixed chain still rises step by step. Takes rotate by
     chain position and the level creeps up 1.2% a step.
   - Step levels live in the render (STEP_PEAK in the renderer); every step
     plays at the same gain. Combo sits about 1 LU over notes with more
     attack, multiplier at least 2 LU over combo even on a small speaker,
     charm and again level with notes. The slam stays at least 4 dB over the
     loudest step at any share.
   - Deal climbs 0.85 to 1.05 playback rate across the dealt cards, flip and
     shop items climb the same way more gently; tally lines climb a
     pentatonic step a line.
   - Cues that repeat close together (deal, flip, hover, count tick, shop items,
     charm moves, taps) rotate recordings and carry +-2-3% random pitch. */
import {
  playRunCue,
  playRunMeterTick,
  playRunTotal,
  prefetchRunSounds,
  RUN_CHAIN_TAKES,
  startRunFireLoop,
  stopRunFireLoop,
} from "../packSfx";

function jitter(amount: number): number {
  return 1 + (Math.random() * 2 - 1) * amount;
}

const STEP_GAIN = 0.78;

function chainStep(chain: number) {
  const step = Math.max(0, Math.floor(chain));
  return {
    slot: step % RUN_CHAIN_TAKES,
    rate: Math.min(1.4, 0.9 + 0.016 * step),
    gain: STEP_GAIN * (1 + 0.012 * Math.min(step, 12)),
  };
}

/* Semitones above the tally line's B4 for each line: B, C#, E, F#, G#, B, C#. */
const TALLY_STEPS = [0, 2, 5, 7, 9, 12, 14];

let lastHoverAt = 0;
let lastHoverTake = 0;

function otherTake(last: number, count: number): number {
  return (last + 1 + Math.floor(Math.random() * (count - 1))) % count;
}

export const runSound = {
  prefetch: () => prefetchRunSounds(),
  /* Table */
  packOpen: () => playRunCue("pack-open", { gain: 0.8 }),
  deal: (index: number) =>
    playRunCue("deal", { slot: index % 3, rate: Math.min(1.05, 0.85 + 0.04 * index) * jitter(0.025), gain: 0.62 }),
  flip: (index: number) =>
    playRunCue("flip", { slot: index % 3, rate: Math.min(1.12, 0.95 + 0.035 * index) * jitter(0.02), gain: 0.6 }),
  hover: () => {
    const now = performance.now();
    if (now - lastHoverAt < 60) return;
    lastHoverAt = now;
    lastHoverTake = otherTake(lastHoverTake, 3);
    playRunCue("hover", { slot: lastHoverTake, rate: 0.9 + Math.random() * 0.2, gain: 0.3 });
  },
  /* Scoring: notes, combo, multiplier, a card a mod zeroed, a card scoring again, a charm firing */
  stepNotes: (chain: number) => playRunCue("step-notes", chainStep(chain)),
  stepCombo: (chain: number) => playRunCue("step-combo", chainStep(chain)),
  stepMultiplier: (chain: number) => playRunCue("step-multiplier", chainStep(chain)),
  stepMiss: () => playRunCue("step-miss", { gain: 0.75 }),
  stepAgain: (chain: number) => playRunCue("step-again", chainStep(chain)),
  charmFire: (chain: number) => playRunCue("charm-fire", chainStep(chain)),
  /* A 727 showed: the owner's clip, full level for the chain moment, under it for a table stamp. */
  wysi: (big: boolean) => playRunCue("wysi", { gain: big ? 0.9 : 0.7 }),
  finish: () => playRunCue("finish", { gain: 0.75 }),
  countTick: (progress: number) => playRunMeterTick(progress),
  slam: (share: number) => playRunTotal(share),
  fireIgnite: () => playRunCue("fire-ignite", { gain: 0.75 }),
  /* The quiet flame loop while the song's score is over its target; start
     is safe to call repeatedly, stop fades it out over about a second. */
  fireLoopStart: () => startRunFireLoop(0.3),
  fireLoopStop: () => stopRunFireLoop(),
  /* Song end */
  tallyLine: (index: number) =>
    playRunCue("tally-line", {
      rate: 2 ** (TALLY_STEPS[Math.max(0, Math.min(TALLY_STEPS.length - 1, index))] / 12),
      gain: 0.7,
    }),
  tallyTotal: () => playRunCue("tally-total", { gain: 0.8 }),
  songCleared: (kind: "song" | "stage" | "run") =>
    playRunCue(kind === "run" ? "run-cleared" : kind === "stage" ? "clear-stage" : "clear-song", {
      gain: kind === "run" ? 0.9 : 0.8,
    }),
  /* At least 3 LU under the run-cleared cue. */
  runFailed: () => playRunCue("run-failed", { gain: 0.9 }),
  /* Shop */
  shopIn: (index: number) =>
    playRunCue("shop-in", { slot: index % 2, rate: Math.min(1.12, 0.94 + 0.045 * index) * jitter(0.02), gain: 0.6 }),
  reroll: () => playRunCue("reroll", { rate: jitter(0.015), gain: 0.72 }),
  buy: () => playRunCue("buy", { rate: jitter(0.01), gain: 0.6 }),
  sell: () => playRunCue("sell", { rate: jitter(0.01), gain: 0.6 }),
  charmMove: () => playRunCue("charm-move", { slot: Math.floor(Math.random() * 2), rate: jitter(0.03), gain: 0.55 }),
  refuse: () => playRunCue("refuse", { gain: 0.75 }),
  /* Menus */
  uiTap: () => playRunCue("ui-tap", { slot: Math.floor(Math.random() * 2), rate: jitter(0.03), gain: 0.5 }),
};
