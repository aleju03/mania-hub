/* Dev-only fixture harness for the chain run's table. Loaded from packs.tsx
   behind `import.meta.env.DEV` with a dynamic import, so production builds
   drop it.

   `/packs?view=run&runFixture=<moment>` renders the table from
   makeFixtureRun (no login, no backend: actions apply on the engine here)
   and plays one moment:

     start    the three starting packs torn, dealt, turned over and picked,
              then round 1's pack joining the hand
     arrange  a hand with a row half laid out
     play     an ordinary row playing out
     chain    a strong build's row, 100 events, playing out
     clear    a row that clears the round: the slam, the pay, the keep pick
     shop     the shop: a pack bought and opened, a reroll, a scene card
              bought, a buy refused
     over     the run's end
     fail     the last row of a round falls short: the miss beat, then the
              run's end
     goat     a row with a GOAT in it: both its links at full strength and
              the combo doubling as the chain reaches it; the row clears,
              then the shop's pack turns a GOAT with its ceremony
     skills   an arranged row showing the skillset hints: a Delay landing
              late, a Bracket pair's span, Tech, Jack and Chordstream
     contract the shop's contracts, the second one signed
     variants a row holding one card of each variant (Silver SS, Mirror,
              PFC, MAX) playing out, with more in the hand
     wysi     a row whose running total reads 3,727 mid-chain (the 727
              freeze and combo jump), landing the round score on a 727 too
              (the table stamp), then the clear
     endless  an endless round's broken row: Blue Zenith, FREEDOM DiVE and
              Halcyon held, practice levels, a Replay and a MAX card in it
     won      the win round's clearing row, then the run-won banner

   <html data-run-moment> reads "<moment>:ready" once the moment starts and
   "<moment>:done" once it has settled; the screenshot script
   (local-notes/pack-run-gauntlet/shoot-chain.mjs) waits on those. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyChainAction,
  buildChainPool,
  chainRunView,
  makeFixturePool,
  chainRandom,
  CHAIN_GOAT,
  makeFixtureRun,
  scoreChainRowFor,
  chainBestRow,
  chainTargetFor,
  CHAIN_RULES,
  type ChainAction,
  type ChainBoardEntry,
  type ChainPool,
  type ChainCard,
  type ChainRunState,
  type ChainVariant,
  type ChainRunView,
} from "#/lib/chain-run";
import { PACK_TYPES, type PackTypeId } from "#/lib/packs";
import { getCachedPackFrontCanvas, PACK_ASPECT, packArtStyleFor } from "../../packArt";
import { ChainTable, type ChainTableScript } from "../chain/ChainTable";
import type { ChainActOutcome } from "../chain/useChainRun";

export const CHAIN_FIXTURE_MOMENTS = ["start", "arrange", "play", "chain", "clear", "shop", "over", "fail", "wysi", "goat", "variants", "contract", "skills", "endless", "won"] as const;
export type ChainFixtureMoment = (typeof CHAIN_FIXTURE_MOMENTS)[number];

/* Real osu! ids, used only for avatars on the synthetic players. */
const AVATAR_IDS = [
  5580057, 7296977, 37538073, 16438713, 38355633, 38388668, 32047306, 5419711, 30442264, 27611523, 37215641, 20519861, 10588809, 23622159, 26772944,
  28391442, 38502410, 162860, 15406985, 16081867, 29152268, 23028806, 12743135, 18438885, 3215366, 9821346, 12118687, 3337688, 30608692, 11585213,
];

function fixturePool(seed: number): ChainPool {
  const base = makeFixturePool(seed);
  const avatar = <T extends { id: number }>(card: T) => ({ ...card, avatarUrl: `https://a.ppy.sh/${AVATAR_IDS[card.id % AVATAR_IDS.length]}` });
  return buildChainPool(base.cards.map(avatar), base.goats.map(avatar));
}

function packThumbFor(id: PackTypeId): string | null {
  const type = PACK_TYPES.find((entry) => entry.id === id);
  if (!type) return null;
  const full = getCachedPackFrontCanvas(packArtStyleFor(type));
  const small = document.createElement("canvas");
  small.width = 256;
  small.height = Math.round(256 / PACK_ASPECT);
  small.getContext("2d")?.drawImage(full, 0, 0, small.width, small.height);
  return small.toDataURL("image/png");
}

const BOARD: ChainBoardEntry[] = [
  { rank: 1, userId: 1, username: "Hanabira", round: 17, bestRow: 214_880, rows: 51, finished: true, updatedAt: 0 },
  { rank: 2, userId: 2, username: "stairwell", round: 13, bestRow: 61_240, rows: 38, finished: true, updatedAt: 0 },
  { rank: 3, userId: 3, username: "tapwave", round: 11, bestRow: 40_310, rows: 33, finished: true, updatedAt: 0 },
  { rank: 4, userId: 4, username: "Lunarkeys", round: 8, bestRow: 18_020, rows: 24, finished: true, updatedAt: 0 },
  { rank: 5, userId: 5, username: "rollfinger", round: 6, bestRow: 9_120, rows: 17, finished: true, updatedAt: 0 },
];

interface Scenario {
  state: ChainRunState;
  pool: ChainPool;
  script: ChainTableScript;
  best: ChainBoardEntry | null;
}

function scenarioFor(moment: ChainFixtureMoment): Scenario {
  if (moment === "start") {
    const pool = fixturePool(11);
    const f = makeFixtureRun(11, { phase: "pack", pool });
    return { state: f.state, pool, script: { autoPack: true }, best: null };
  }
  if (moment === "arrange") {
    const pool = fixturePool(5);
    const f = makeFixtureRun(5, { round: 3, phase: "arranged", pool, scenes: ["tree", "makiba"] });
    // A signed contract on the table.
    f.state.contract = { id: "quick", prize: { id: "dt" } };
    return { state: f.state, pool, script: { row: f.row, place: 3, dealt: true }, best: null };
  }
  if (moment === "play") {
    const pool = fixturePool(3);
    const f = makeFixtureRun(3, { round: 2, phase: "arranged", pool });
    return { state: f.state, pool, script: { row: f.row, dealt: true, autoPlay: true }, best: null };
  }
  if (moment === "chain") {
    const pool = fixturePool(4);
    const f = makeFixtureRun(4, { round: 6, phase: "arranged", pool, scenes: ["future", "echoes", "tree"] });
    return { state: f.state, pool, script: { row: f.row, dealt: true, autoPlay: true }, best: null };
  }
  if (moment === "clear") {
    const pool = fixturePool(9);
    const f = makeFixtureRun(9, { round: 3, phase: "arranged", pool, scenes: ["makiba"] });
    const state = f.state;
    const total = f.row ? scoreChainRowFor(state, f.row)?.total ?? 0 : 0;
    // The row lands a little past the target.
    if (total > 0) state.roundScore = Math.max(0, state.target - Math.floor(total * 0.6));
    state.rowsLeft = 2;
    return { state, pool, script: { row: f.row, dealt: true, autoPlay: true, skipReplay: true, autoPack: true }, best: null };
  }
  if (moment === "skills") {
    const pool = fixturePool(3);
    const f = makeFixtureRun(3, { round: 2, phase: "arranged", pool });
    const state = f.state;
    const row = f.row ?? [];
    const looks: Array<[ChainCard["skill"], 4 | 7]> = [["Delay", 7], ["Bracket", 7], ["Tech", 7], ["Bracket", 7], ["Jack", 7], ["Chordstream", 7]];
    row.slice(0, looks.length).forEach((uid, index) => {
      const [skill, key] = looks[index];
      for (const entry of [...state.hand, ...state.deck]) if (entry.uid === uid) entry.card = { ...entry.card, skill, key, cc: "KR" };
    });
    return { state, pool, script: { row, dealt: true }, best: null };
  }
  if (moment === "contract") {
    const pool = fixturePool(6);
    const f = makeFixtureRun(6, { round: 1, phase: "shop", pool, scenes: ["echoes"], shards: 14 });
    return { state: f.state, pool, script: {}, best: null };
  }
  if (moment === "shop") {
    const pool = fixturePool(6);
    const f = makeFixtureRun(6, { round: 1, phase: "shop", pool, scenes: ["echoes"], shards: 14 });
    // A country pack and a skillset pack on the shelf, so their own wrappers
    // show (the first is the one bought).
    if (f.state.shop) {
      f.state.shop.offers[0] = { kind: "country", keep: 1, price: 7, boost: 0, cc: "ID", sold: false };
      f.state.shop.offers[1] = { kind: "skill", keep: 1, price: 7, boost: 0, skill: "Stamina", sold: false };
    }
    return { state: f.state, pool, script: { autoPack: true }, best: null };
  }
  if (moment === "goat") {
    const pool = fixturePool(5);
    const f = makeFixtureRun(5, { round: 3, phase: "arranged", pool, scenes: ["tree"] });
    const state = f.state;
    const row = f.row ?? [];
    // A synthetic GOAT takes the place of a round-pack card near the middle of the row.
    const slot = [2, 3, 1, 4, 0, 5].find((at) => state.hand.find((entry) => entry.uid === row[at])?.pack) ?? Math.min(2, row.length - 1);
    const goat = pool.goats[0];
    if (goat && row[slot] !== undefined) {
      for (const entry of [...state.hand, ...state.deck]) if (entry.uid === row[slot]) entry.card = goat;
    }
    const total = scoreChainRowFor(state, row)?.total ?? 0;
    // The row lands a little past the target, so the shop follows.
    if (total > 0) state.roundScore = Math.max(0, state.target - Math.floor(total * 0.6));
    state.rowsLeft = 2;
    state.shards = 30;
    // The GOAT roll's stream set to hit on its next card: the shop pack's first.
    for (let rng = 0; rng < 1_000_000; rng += 1) {
      if (chainRandom({ rng }) < CHAIN_GOAT.chance) {
        state.goatRng = rng;
        break;
      }
    }
    return { state, pool, script: { row, dealt: true, autoPlay: true, autoPack: true }, best: null };
  }
  if (moment === "variants") {
    const pool = fixturePool(3);
    const f = makeFixtureRun(3, { round: 2, phase: "arranged", pool });
    const state = f.state;
    const row = f.row ?? [];
    const order: ChainVariant[] = ["silver", "mirror", "pfc", "max"];
    row.slice(0, 4).forEach((uid, index) => {
      for (const entry of [...state.hand, ...state.deck]) if (entry.uid === uid) entry.card = { ...entry.card, variant: order[index] };
    });
    // The hand shows them at rest too.
    state.hand.filter((entry) => !row.includes(entry.uid)).slice(0, 4).forEach((entry, index) => (entry.card = { ...entry.card, variant: order[index] }));
    return { state, pool, script: { row, dealt: true, autoPlay: true }, best: null };
  }
  if (moment === "endless" || moment === "won") {
    const pool = fixturePool(4);
    const endless = moment === "endless";
    const f = makeFixtureRun(4, { round: 6, phase: "arranged", pool, scenes: endless ? ["blueZenith", "freedomDive", "halcyon"] : ["echoes", "galaxy"] });
    const state = f.state;
    const row = f.row ?? [];
    state.round = endless ? CHAIN_RULES.winRound + 3 : CHAIN_RULES.winRound;
    state.target = chainTargetFor(state.round);
    state.levels = { cc: 3, key: 4, skill: 2, tier: 1 };
    if (endless) {
      // Won at the win round, three rounds back.
      state.won = true;
      state.carry = 40;
      state.scenes = state.scenes.map((scene) => ({ ...scene }));
      const looks: ChainVariant[] = ["replay", "max"];
      row.slice(2, 4).forEach((uid, index) => {
        for (const entry of [...state.hand, ...state.deck]) if (entry.uid === uid) entry.card = { ...entry.card, variant: looks[index] };
      });
    } else {
      state.scenes = state.scenes.map((scene) => (scene.id === "galaxy" ? { ...scene, stacks: 9 } : scene));
    }
    const best = chainBestRowFor(state, row);
    const total = scoreChainRowFor(state, best)?.total ?? 0;
    // The row lands a little past the target.
    if (total > 0) state.roundScore = Math.max(0, state.target - Math.floor(total * 0.6));
    state.rowsLeft = 2;
    return { state, pool, script: { row: best, dealt: true, autoPlay: true }, best: null };
  }
  if (moment === "wysi") {
    // Seed 7's round 3 row (Echoes, Future Dominators) reads 3,727 after its
    // eighth card, with seven cards still to score.
    const pool = fixturePool(7);
    const f = makeFixtureRun(7, { round: 3, phase: "arranged", pool, scenes: ["echoes", "future"] });
    const state = f.state;
    const total = f.row ? scoreChainRowFor(state, f.row)?.total ?? 0 : 0;
    // The round score the row lands on reads x,727 as well.
    state.roundScore = (((727 - (total % 1000)) % 1000) + 1000) % 1000;
    return { state, pool, script: { row: f.row, dealt: true, autoPlay: true }, best: null };
  }
  if (moment === "fail") {
    const pool = fixturePool(8);
    const f = makeFixtureRun(8, { round: 3, phase: "arranged", pool });
    const state = f.state;
    // The last row, and only the weakest card left to play: it falls short.
    state.rowsLeft = 1;
    state.roundScore = Math.floor(state.target * 0.4);
    const weakest = state.hand.slice().sort((a, b) => a.card.base - b.card.base)[0];
    return { state, pool, script: { row: weakest ? [weakest.uid] : f.row, dealt: true, autoPlay: true }, best: { rank: 9, userId: 99, username: "you", round: 3, bestRow: 2_140, rows: 8, finished: true, updatedAt: 0 } };
  }
  const pool = fixturePool(7);
  const f = makeFixtureRun(7, { round: 5, phase: "over", pool, scenes: ["tree", "future"] });
  return { state: f.state, pool, script: { fresh: true }, best: { rank: 7, userId: 99, username: "you", round: 5, bestRow: 8_048, rows: 13, finished: true, updatedAt: 0 } };
}

/* The best order of the arranged row's cards under the scenario's scenes. */
function chainBestRowFor(state: ChainRunState, row: number[]): number[] {
  const cards = state.hand.filter((entry) => row.includes(entry.uid));
  return chainBestRow(state, cards, 24, null, { blind: true })?.uids ?? row;
}

function markMoment(moment: string, state: "ready" | "done") {
  document.documentElement.dataset.runMoment = `${moment}:${state}`;
}

function clickButton(label: string, which: "first" | "last" = "first") {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter(
    (button) => (button.textContent ?? "").trim().startsWith(label) && !button.disabled,
  );
  const button = which === "first" ? buttons[0] : buttons[buttons.length - 1];
  button?.click();
  return Boolean(button);
}

export default function ChainFixtureHost({ moment: rawMoment, reducedMotion }: { moment: string; reducedMotion: boolean }) {
  const moment: ChainFixtureMoment = (CHAIN_FIXTURE_MOMENTS as readonly string[]).includes(rawMoment) ? (rawMoment as ChainFixtureMoment) : "arrange";
  const scenario = useMemo(() => scenarioFor(moment), [moment]);
  const stateRef = useRef<ChainRunState>(scenario.state);
  const [view, setView] = useState<ChainRunView>(() => chainRunView(scenario.state));
  const [busy, setBusy] = useState(false);
  const [packThumbs, setPackThumbs] = useState<Partial<Record<PackTypeId, string>>>({});
  const readyRef = useRef(false);
  const doneRef = useRef(false);

  useEffect(() => {
    delete document.documentElement.dataset.runMoment;
    const thumbs: Partial<Record<PackTypeId, string>> = {};
    for (const id of ["standard", "wild", "elite", "7k", "legend"] as PackTypeId[]) {
      const thumb = packThumbFor(id);
      if (thumb) thumbs[id] = thumb;
    }
    setPackThumbs(thumbs);
  }, [scenario]);

  const ready = useCallback(() => {
    if (readyRef.current) return;
    readyRef.current = true;
    markMoment(moment, "ready");
  }, [moment]);
  const done = useCallback(
    (delay = 0) => {
      window.setTimeout(() => {
        if (doneRef.current || !readyRef.current) return;
        doneRef.current = true;
        markMoment(moment, "done");
      }, delay);
    },
    [moment],
  );

  const act = useCallback(async (action: ChainAction): Promise<ChainActOutcome> => {
    setBusy(true);
    await new Promise((resolve) => window.setTimeout(resolve, 140));
    setBusy(false);
    const out = applyChainAction(stateRef.current, action, { pool: scenario.pool, seed: 1234 + Math.floor(Math.random() * 1000), now: Date.now() });
    if (!out.ok) return { ok: false, error: out.error, view: chainRunView(stateRef.current) };
    stateRef.current = out.state;
    const next = chainRunView(out.state);
    setView(next);
    return { ok: true, result: out.result, view: next };
  }, [scenario.pool]);

  /* Moments driven by the table's own signals. */
  const shopStep = useRef(0);
  const onSignal = useCallback(
    (name: string) => {
      if (moment === "start") {
        if (name === "stage:sealed") ready();
        if (name === "round:dealt") done(900);
      } else if (moment === "goat") {
        if (name === "play:start") ready();
        // Back in the shop after the keep: buy a pack, which turns a GOAT.
        if (name === "shop" && shopStep.current === 0) {
          shopStep.current = 1;
          window.setTimeout(() => clickButton("Buy"), 900);
          done(9000);
        }
      } else if (moment === "fail") {
        if (name === "play:start") ready();
        if (name === "over:shown") done(1800);
      } else if (moment === "play" || moment === "chain" || moment === "clear" || moment === "wysi" || moment === "variants" || moment === "endless" || moment === "won") {
        if (name === "play:start") ready();
        if (moment === "clear") {
          if (name === "shop") done(900);
        } else if (name === "play:done" || name === "clear:done" || name === "over") done(700);
      } else if (moment === "shop" && name === "shop" && shopStep.current === 1) {
        // Back from the pack: a reroll, the scene card, then a pack that
        // cannot be afforded.
        shopStep.current = 2;
        window.setTimeout(() => clickButton("Reroll"), 900);
        window.setTimeout(() => clickButton("Buy", "last"), 2300);
        window.setTimeout(() => clickButton("Buy"), 3700);
        done(5000);
      }
    },
    [done, moment, ready],
  );

  /* Moments with no sequence of their own. */
  useEffect(() => {
    if (moment === "arrange" || moment === "over" || moment === "skills") {
      const frame = window.requestAnimationFrame(ready);
      done(moment === "over" ? 2600 : 1600);
      return () => window.cancelAnimationFrame(frame);
    }
    if (moment === "contract") {
      const frame = window.requestAnimationFrame(ready);
      const timer = window.setTimeout(() => {
        const cards = Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")).filter((button) => (button.textContent ?? "").includes("Pays"));
        cards[1]?.click();
      }, 1400);
      done(2600);
      return () => {
        window.cancelAnimationFrame(frame);
        window.clearTimeout(timer);
      };
    }
    if (moment === "shop") {
      const frame = window.requestAnimationFrame(ready);
      const timers = [
        window.setTimeout(() => {
          shopStep.current = 1;
          clickButton("Buy");
        }, 1500),
      ];
      return () => {
        window.cancelAnimationFrame(frame);
        timers.forEach((timer) => window.clearTimeout(timer));
      };
    }
    return undefined;
  }, [done, moment, ready]);

  const script = useMemo<ChainTableScript>(() => ({ ...scenario.script, onSignal }), [onSignal, scenario.script]);
  const loadBoard = useCallback(async () => BOARD, []);

  return (
    <ChainTable
      view={view}
      best={scenario.best}
      busy={busy}
      act={act}
      reducedMotion={reducedMotion}
      packThumbs={packThumbs}
      loadBoard={loadBoard}
      onExit={() => {
        window.location.href = "/packs";
      }}
      script={script}
    />
  );
}
