/* Every sound the run table plays, by beat. Components call only these;
   packSfx.ts owns decoding and playback. `chain` is the position of a step in
   the current scoring chain (0-based), which the cue turns into rising pitch. */
import {
  playCardDraw,
  playFlipWhoosh,
  playPackRip,
  playRunBlindCleared,
  playRunCombo,
  playRunCredit,
  playRunFinish,
  playRunMeterTick,
  playRunMiss,
  playRunNote,
  playRunOver,
  playRunTotal,
  prefetchRunSounds,
} from "../packSfx";

export const runSound = {
  prefetch: () => prefetchRunSounds(),
  /* Table */
  packOpen: () => playPackRip(),
  deal: (_index: number) => playCardDraw(),
  flip: (_index: number) => playFlipWhoosh(180),
  hover: () => {},
  /* Scoring: notes (chips), combo (+mult), multiplier (xmult), a card a mod zeroed, a retrigger */
  stepNotes: (chain: number) => playRunNote(chain),
  stepCombo: (chain: number) => playRunCombo(chain),
  stepMultiplier: (chain: number) => playRunCombo(chain + 2),
  stepMiss: () => playRunMiss(),
  stepAgain: (chain: number) => playRunNote(chain),
  charmFire: (chain: number) => playRunCombo(chain),
  finish: () => playRunFinish(),
  countTick: (progress: number) => playRunMeterTick(progress),
  slam: (share: number) => playRunTotal(share),
  fireIgnite: () => {},
  /* Song end */
  tallyLine: (_index: number) => playRunCredit(true),
  tallyTotal: () => playRunCredit(true),
  songCleared: (kind: "song" | "stage" | "run") => playRunBlindCleared(kind),
  runFailed: () => playRunOver(),
  /* Shop */
  shopIn: (_index: number) => playCardDraw(),
  reroll: () => playCardDraw(),
  buy: () => playRunCredit(false),
  sell: () => playRunCredit(true),
  charmMove: () => {},
  refuse: () => playRunMiss(),
  /* Menus */
  uiTap: () => {},
};
