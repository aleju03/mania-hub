import { useEffect } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { canUseDevFeatures } from "../lib/auth-shared";
import { runSound } from "../components/packs/run/runSound";
import {
  playCardDraw,
  playCardSlice,
  playDiceRoll,
  playEternalFanfare,
  playFlipWhoosh,
  playGoatFanfare,
  playPackRip,
  playPageTurn,
  playRecycleClink,
  playRevealChime,
  playShuffleWhisk,
  prefetchEternalFanfare,
} from "../components/packs/packSfx";

// Dev-only soundboard: every Overjoy cue (and the main pack opening's) played
// through the game's own sound code, at in-game level, grouped by where it
// plays. For picking which sound to replace.

export const Route = createFileRoute("/dev/overjoy-sounds")({
  beforeLoad: ({ context }) => {
    if (!canUseDevFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: OverjoySoundsPage,
});

type Cue = [label: string, note: string, play: () => void];

function seq(play: (index: number) => void, count: number, gapMs: number) {
  for (let index = 0; index < count; index += 1) window.setTimeout(() => play(index), index * gapMs);
}

/* A card flipping over on the pack screen at a rarity tier, as ChainPackStage plays it. */
function reveal(tier: number) {
  return () => {
    runSound.flip(0);
    runSound.charmFire(tier * 3);
    if (tier >= 3) runSound.stepMultiplier(tier * 4);
    if (tier >= 5) runSound.fireIgnite();
  };
}

const GROUPS: Array<[title: string, cues: Cue[]]> = [
  [
    "Picking cards on the table",
    [
      ["Card into the row", "deal, 1st to 5th", () => seq((i) => runSound.deal(i), 5, 350)],
      ["Card back to hand", "tap", () => runSound.uiTap()],
      ["Hover a card", "", () => runSound.hover()],
      ["Card flipped", "", () => seq((i) => runSound.flip(i), 5, 250)],
      ["Drag / move", "charm move", () => runSound.charmMove()],
      ["Not allowed", "refuse", () => runSound.refuse()],
      ["Map card a player played", "", () => seq((i) => runSound.played(i), 3, 300)],
    ],
  ],
  [
    "Pack screen",
    [
      ["Pack opens", "", () => runSound.packOpen()],
      ["Cards dealt out", "", () => seq((i) => runSound.deal(i), 5, 90)],
      ["Rare card revealed (tier 1)", "", reveal(1)],
      ["Rarer (tier 2)", "", reveal(2)],
      ["Rarer (tier 3)", "", reveal(3)],
      ["Rarer (tier 4)", "", reveal(4)],
      ["Rarer (tier 5, fire)", "", reveal(5)],
      ["GOAT fanfare", "", () => playGoatFanfare()],
      ["Eternal fanfare", "", () => playEternalFanfare()],
      ["Pick pressed", "coins", () => runSound.buy()],
      ["Leftovers recycled", "", () => runSound.sell()],
      ["Shard ticks", "", () => seq((i) => runSound.tallyLine(i), 5, 45)],
    ],
  ],
  [
    "Scoring",
    [
      ["Notes steps", "", () => seq((i) => runSound.stepNotes(i), 6, 180)],
      ["Combo steps", "", () => seq((i) => runSound.stepCombo(i), 6, 180)],
      ["Multiplier steps", "", () => seq((i) => runSound.stepMultiplier(i), 4, 240)],
      ["Again", "", () => runSound.stepAgain(3)],
      ["Charm fires", "", () => seq((i) => runSound.charmFire(i), 4, 220)],
      ["Miss", "", () => runSound.stepMiss()],
      ["Finish", "", () => runSound.finish()],
      ["Count ticks", "", () => seq((i) => runSound.countTick(i / 20), 20, 50)],
      ["Total slam (small)", "", () => runSound.slam(0.3)],
      ["Total slam (big)", "", () => runSound.slam(1)],
      ["Fire ignites", "", () => runSound.fireIgnite()],
      ["Fire loop (3 s)", "", () => { runSound.fireLoopStart(); window.setTimeout(() => runSound.fireLoopStop(), 3000); }],
      ["727", "", () => runSound.wysi(false)],
      ["727 big", "", () => runSound.wysi(true)],
    ],
  ],
  [
    "Round end and shop",
    [
      ["Tally lines", "", () => seq((i) => runSound.tallyLine(i), 7, 220)],
      ["Tally total", "", () => runSound.tallyTotal()],
      ["Interest", "", () => runSound.interest()],
      ["Round cleared", "", () => runSound.songCleared("song")],
      ["Stage cleared", "", () => runSound.songCleared("stage")],
      ["Run cleared", "", () => runSound.songCleared("run")],
      ["Run failed", "", () => runSound.runFailed()],
      ["Shop items in", "", () => seq((i) => runSound.shopIn(i), 5, 120)],
      ["Reroll", "", () => runSound.reroll()],
      ["Buy", "", () => runSound.buy()],
      ["Sell", "", () => runSound.sell()],
      ["Menu tap", "", () => runSound.uiTap()],
    ],
  ],
  [
    "Music",
    [
      ["Start the music", "the table's loop", () => runSound.musicStart()],
      ["Stop the music", "", () => runSound.musicStop()],
    ],
  ],
  [
    "Main pack opening (outside Overjoy)",
    [
      ["Pack rip", "", () => playPackRip()],
      ["Card draw", "", () => playCardDraw()],
      ["Card slice", "", () => playCardSlice(1)],
      ["Shuffle whisk", "", () => playShuffleWhisk()],
      ["Flip whoosh", "", () => playFlipWhoosh(400)],
      ["Page turn", "", () => playPageTurn()],
      ["Reveal chime (new)", "", () => playRevealChime(0.6, true)],
      ["Reveal chime (big)", "", () => playRevealChime(1, true)],
      ["Recycle clink", "", () => playRecycleClink(5)],
      ["Dice roll", "", () => playDiceRoll()],
    ],
  ],
];

function OverjoySoundsPage() {
  useEffect(() => {
    runSound.prefetch();
    prefetchEternalFanfare();
    return () => runSound.musicStop();
  }, []);
  return (
    <div className="min-h-screen bg-[#1d1824] px-7 py-7 text-[#f3e9d8]">
      <h1 className="text-[19px] font-bold">Every Overjoy sound</h1>
      <p className="mt-1 text-[13px] text-[#b9aebd]">Played by the game's own sound code, at in-game level.</p>
      {GROUPS.map(([title, cues]) => (
        <section key={title}>
          <h2 className="mb-2 mt-6 text-[15px] font-bold text-[#f0c35a]">{title}</h2>
          <div className="grid max-w-[960px] grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
            {cues.map(([label, note, play]) => (
              <button
                key={label}
                type="button"
                onClick={play}
                className="rounded-xl border-2 border-[#3d3348] bg-[#2a2234] px-3 py-2.5 text-left transition hover:border-[#f0c35a]"
              >
                <span className="block text-[14px] font-bold">{label}</span>
                {note && <span className="text-[12px] text-[#a99cae]">{note}</span>}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
