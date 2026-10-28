import { createServerFn } from "@tanstack/react-start";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import {
  BOSS_NUMBERS,
  CHARM_NUMBERS,
  EDITION_EFFECTS,
  LOADOUT_NUMBERS,
  LOADOUT_UNLOCKS,
  LOADOUTS,
  RUN_STAKES,
  STAKE_NUMBERS,
  type BossId,
  type HandTypeId,
  type LoadoutId,
  type OpenOutcome,
  type PackRunState,
  type RunEdition,
  type RunStakeId,
  type RunStats,
  type RunUnlocks,
  type RunWrapper,
  type ShopAction,
  type SkipRewardId,
} from "../../backend/src/shared/pack-run";
import { liveBridgeToken } from "./live-backend-tokens";

/* The pack run on this side: the server functions behind the run page and
   the copy for everything it names. The engine and its tables are the
   backend's (backend/src/shared/pack-run.ts), imported as-is so the numbers
   a description prints are the numbers the server scores with. */

export * from "../../backend/src/shared/pack-run";

export interface PackRunView {
  state: PackRunState;
  /* What this run plays with: the ladder plus the loadout, difficulty and
     slot and shop charms. */
  unlocks: RunUnlocks;
  /* The collection ladder alone. */
  ladderUnlocks?: RunUnlocks;
  distinct: number;
  rungs: Array<{ at: number; unlock: string; reached: boolean }>;
  masterSets?: Record<RunEdition, number>;
  /* Players in the draw pool, the size of a full master set. */
  poolTotal?: number;
  loadouts?: Array<{ id: LoadoutId; unlocked: boolean }>;
  /* Difficulties 0..unlocked can be picked. */
  stakes?: { unlocked: number; count: number };
  skipsEnabled?: boolean;
  /* The wrapper the next pack will actually wear. */
  nextWrapper?: RunWrapper;
}

/* What a dealt pack carries back about the run (live-backend pack-run.ts). */
export interface PackRunOpenPayload {
  editions: Array<RunEdition | null>;
  wrapper: RunWrapper;
  outcome: OpenOutcome;
  rungsCrossed: number[];
  view: PackRunView;
}

export type PackRunActionResult =
  | { status: "ok"; view: PackRunView; wallet: { payload: string; rev: number } | null }
  | { status: "refused"; reason: string };

async function runTarget(): Promise<{ url: string; headers: HeadersInit; isAdmin: boolean } | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const { canUseAdminFeatures } = await import("./auth-shared");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = process.env.LIVE_BACKEND_URL?.trim().replace(/\/$/, "");
  if (!base) return null;
  const headers: HeadersInit = { "content-type": "application/json" };
  const bridgeToken = liveBridgeToken();
  if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;
  return { url: `${base}/api/pack-run/${auth.viewer.id}`, headers, isAdmin: canUseAdminFeatures(auth) };
}

/* Null when there is no run for this viewer: logged out, no backend, or runs
   not released to them yet. */
export const fetchOwnPackRun = createServerFn({ method: "GET" }).handler(async (): Promise<PackRunView | null> => {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
  const target = await runTarget();
  if (!target) return null;
  const response = await fetch(`${target.url}${target.isAdmin ? "?admin=1" : ""}`, { headers: target.headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Pack run fetch failed (${response.status}).`);
  return (await response.json()) as PackRunView;
});

export const actOnOwnPackRun = createServerFn({ method: "POST" })
  .validator((input: ShopAction) => {
    const int = (value: unknown) => Math.floor(Number(value));
    switch (input?.kind) {
      case "buy":
        if (Number.isInteger(int(input.index))) return { kind: "buy", index: int(input.index) } as ShopAction;
        break;
      case "sell":
        if (Number.isInteger(int(input.uid))) return { kind: "sell", uid: int(input.uid) } as ShopAction;
        break;
      case "move":
        if (Number.isInteger(int(input.uid)) && Number.isInteger(int(input.to))) {
          return { kind: "move", uid: int(input.uid), to: int(input.to) } as ShopAction;
        }
        break;
      case "reroll":
      case "skip":
        return { kind: input.kind } as ShopAction;
      case "newRun": {
        const loadout = (LOADOUTS as readonly string[]).includes(String(input.loadout)) ? (input.loadout as LoadoutId) : undefined;
        const stake = Number.isInteger(int(input.stake)) && int(input.stake) >= 0 && int(input.stake) < RUN_STAKES.length ? int(input.stake) : undefined;
        return { kind: "newRun", ...(loadout ? { loadout } : {}), ...(stake !== undefined ? { stake } : {}) } as ShopAction;
      }
      case "pickSkipReward":
        if (Number.isInteger(int(input.index))) {
          const choice = Number.isInteger(int(input.choice)) ? int(input.choice) : undefined;
          return { kind: "pickSkipReward", index: int(input.index), ...(choice !== undefined ? { choice } : {}) } as ShopAction;
        }
        break;
      default:
        break;
    }
    throw new Error("Invalid run action.");
  })
  .handler(async ({ data }): Promise<PackRunActionResult | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await runTarget();
    if (!target) return null;
    const { kind, ...rest } = data;
    const response = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({ action: kind, ...rest, viewerIsAdmin: target.isAdmin }),
    });
    if (response.status === 409) {
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      return { status: "refused", reason: typeof body?.error === "string" ? body.error : "refused" };
    }
    if (!response.ok) throw new Error(`Pack run action failed (${response.status}).`);
    const { wallet, ...view } = (await response.json()) as PackRunView & { wallet?: { payload: string; rev: number } };
    return { status: "ok", view, wallet: wallet ?? null };
  });

/* ------------------------------------------------------------------ copy */

const N = CHARM_NUMBERS;
const B = BOSS_NUMBERS;
/* A share as a whole percent, so 0.2 prints as 20. */
const pct = (share: number) => Math.round(share * 100);

export const CHARM_COPY: Record<string, { name: MessageDescriptor; text: MessageDescriptor }> = {
  homeCrowd: { name: msg`Home Country`, text: msg`+${N.homeCrowd.mult} combo for each card from your country.` },
  newBlood: { name: msg`New Blood`, text: msg`+${N.newBlood.mult} combo for each new card.` },
  duet: { name: msg`Duet`, text: msg`+${N.duet.mult} combo if the pack has a jump.` },
  trio: { name: msg`Trio`, text: msg`+${N.trio.mult} combo if the pack has a hand.` },
  climber: { name: msg`Climber`, text: msg`+${N.climber.mult} combo if the pack has stairs.` },
  monochrome: { name: msg`Jackhammer`, text: msg`+${N.monochrome.mult} combo if the pack has jacks.` },
  grassroots: { name: msg`Grassroots`, text: msg`Common cards give +${N.grassroots.chips} notes.` },
  rareForm: { name: msg`Rare Form`, text: msg`Rare cards give +${N.rareForm.mult} combo.` },
  sightread: { name: msg`Sightread`, text: msg`+0 to +${N.sightread.max} combo, rolled each pack.` },
  sevenKeys: { name: msg`Seven Keys`, text: msg`7K cards give +${N.sevenKeys.mult} combo.` },
  fourKeys: { name: msg`Four Keys`, text: msg`4K cards give +${N.fourKeys.chips} notes.` },
  allowance: { name: msg`Allowance`, text: msg`Songs you clear pay ${N.allowance.shards} more shards.` },
  bigStack: { name: msg`Big Stack`, text: msg`+${N.bigStack.mult} combo for each card in the pack.` },
  lastPack: { name: msg`Last Pack`, text: msg`x${N.lastPack.xMult} combo on the last pack of a song.` },
  hoarder: { name: msg`Hoarder`, text: msg`Cards give +${N.hoarder.chips} notes per card level.` },
  patriot: { name: msg`Patriot`, text: msg`+${N.patriot.mult} combo for each card that shares a country with another card in the pack.` },
  snowball: { name: msg`Snowball`, text: msg`Gains +${N.snowball.step} combo every pack with a jump.` },
  freshPaint: { name: msg`Fresh Paint`, text: msg`+${N.freshPaint.chips} notes, ${N.freshPaint.decay} fewer after every pack.` },
  encore: { name: msg`Encore`, text: msg`The strongest card in the pack scores twice.` },
  hotStreak: { name: msg`Hot Streak`, text: msg`Every card scores twice for the next ${N.hotStreak.packs} packs.` },
  shine: { name: msg`Shine`, text: msg`Finishes roll twice as often.` },
  chainLink: { name: msg`Chain Link`, text: msg`Each card has a ${N.chainLink.chance * 100}% chance to deal one more card.` },
  collector: { name: msg`Collector`, text: msg`+${N.collector.mult} combo per collector level.` },
  topThousand: { name: msg`Top Thousand`, text: msg`Cards in the global top 1,000 give +${N.topThousand.chips} notes.` },
  gallery: { name: msg`Gallery`, text: msg`Cards with a finish give +${N.gallery.mult} combo.` },
  piggyBank: { name: msg`Refund`, text: msg`Other charms sell for everything you paid.` },
  underdog: { name: msg`Underdog`, text: msg`x${N.underdog.xMult} combo if no card in the pack is better than Rare.` },
  headliner: { name: msg`Headliner`, text: msg`The first Legendary or better card gives x${N.headliner.xMult} combo.` },
  firstFind: { name: msg`First Find`, text: msg`x${N.firstFind.xMult} combo if a card in the pack is the first copy anyone pulled.` },
  herd: { name: msg`Herd`, text: msg`Gains x${N.herd.step} combo for every GOAT or Eternal card in your packs.` },
  ascension: { name: msg`Ascension`, text: msg`Gains x${N.ascension.step} combo for every final song cleared.` },
  luckyStrike: { name: msg`Lucky Strike`, text: msg`x${N.luckyStrike.xMult} combo, with a 1 in ${N.luckyStrike.breakOdds} chance to break after each pack.` },
  echo: { name: msg`Echo`, text: msg`Cards with a finish score twice.` },
  oldGuard: { name: msg`Old Guard`, text: msg`Cards in the global top ${N.oldGuard.rank} give x${N.oldGuard.xMult} combo.` },
  party: { name: msg`Party`, text: msg`x${N.party.xMult} combo if the pack has a handstream or better.` },
  archivist: { name: msg`Archivist`, text: msg`Gains x${N.archivist.step} combo for every new card this run.` },
  crown: { name: msg`Crown`, text: msg`GOAT and Eternal cards give x${N.crown.xMult} combo, Mythic and better x${N.crown.highXMult}.` },
  mirror: { name: msg`Twin`, text: msg`Every card scores twice.` },
  giantSlayer: { name: msg`Nomod`, text: msg`Mods have no effect.` },
  metronome: { name: msg`Metronome`, text: msg`Gains +${N.metronome.step} notes every pack.` },
  trill: { name: msg`Trill`, text: msg`+${N.trill.mult} combo if the pack has a jumptrill.` },
  singleTap: { name: msg`Single Tap`, text: msg`+${N.singleTap.mult} combo if the pack's pattern is a Single.` },
  abroad: { name: msg`Multiplayer`, text: msg`+${N.abroad.mult} combo for each card not from your country.` },
  keyOverlay: { name: msg`Key Overlay`, text: msg`+${N.keyOverlay.mult} combo for each different key mode in the pack.` },
  firstNote: { name: msg`First Note`, text: msg`The first card gives +${N.firstNote.chips} notes.` },
  opener: { name: msg`First Try`, text: msg`+${N.opener.mult} combo on the first pack of a song.` },
  scrollSpeed: { name: msg`Scroll Speed`, text: msg`+${N.scrollSpeed.mult} combo for each pack already played this song.` },
  warmUp: { name: msg`Warm-up`, text: msg`+${N.warmUp.chips} notes on the first song of a stage.` },
  overallDifficulty: { name: msg`Overall Difficulty`, text: msg`+${N.overallDifficulty.mult} combo for each stage up to and including this one.` },
  setlist: { name: msg`Setlist`, text: msg`+${N.setlist.chips} notes for each song cleared this run.` },
  doubleTap: { name: msg`Double Tap`, text: msg`The first card scores twice.` },
  spam: { name: msg`Spam`, text: msg`Common cards score twice.` },
  comboBurst: { name: msg`Combo Burst`, text: msg`Each card has a 1 in ${N.comboBurst.odds} chance to give x${N.comboBurst.xMult} combo.` },
  maxJudgement: { name: msg`MAX`, text: msg`Each card has a 1 in ${N.maxJudgement.odds} chance to give +${N.maxJudgement.chips} notes.` },
  overdrive: { name: msg`Overdrive`, text: msg`Gains +${N.overdrive.step} combo for every pack that is not a Single and drops to 0 on a Single.` },
  practice: { name: msg`Practice`, text: msg`Gains +${N.practice.step} notes for every pack that is a Single.` },
  grind: { name: msg`Grind`, text: msg`Gains +${N.grind.step} combo for every pack with a card at card level ${N.grind.level} or higher.` },
  comboCounter: { name: msg`Combo Counter`, text: msg`+${N.comboCounter.step} combo for every card scored earlier in this song.` },
  worldTour: { name: msg`World Cup`, text: msg`+${N.worldTour.mult} combo for each different country among the cards scored this song.` },
  blacklight: { name: msg`Blacklight`, text: msg`Neon cards give x${N.blacklight.xMult} combo.` },
  spaceKey: { name: msg`Space Key`, text: msg`The middle card gives x${N.spaceKey.xMult} combo.` },
  modded: { name: msg`Modded`, text: msg`x${N.modded.xMult} combo on songs with a mod.` },
  modReader: { name: msg`Mod Reader`, text: msg`Cards a mod stops from scoring give +${N.modReader.mult} combo.` },
  holdNote: { name: msg`Hold Note`, text: msg`Chained cards score twice.` },
  freshEyes: { name: msg`Fresh Eyes`, text: msg`New cards score twice.` },
  quickRetry: { name: msg`Quick Retry`, text: msg`Every song from the next one on gets +${N.quickRetry.packs} pack.` },
  beatmapListing: { name: msg`Beatmap Listing`, text: msg`The shop shows +${N.beatmapListing.offers} charm.` },
  fever: { name: msg`Fever`, text: msg`Chances on your charms are ${N.fever.factor} times as likely, and Sightread rolls ${N.fever.factor} times and keeps the highest.` },
  drainTime: { name: msg`Drain Time`, text: msg`The song's target drops ${pct(N.drainTime.share)}% after every pack that does not clear it.` },
  fullCombo: { name: msg`Full Combo`, text: msg`Gains x${N.fullCombo.step} combo for every song cleared with a pack to spare and goes back to x1 when a song takes its last pack.` },
  endurance: { name: msg`Endurance`, text: msg`Adds the notes it has kept, then keeps ${pct(N.endurance.share)}% of the pack's notes.` },
  medalHunter: { name: msg`Medal Hunter`, text: msg`x1 combo plus x${N.medalHunter.step} for each different mod beaten this run.` },
  kiai: { name: msg`Kiai Time`, text: msg`x${N.kiai.xMult} combo on every ${N.kiai.every}th pack of the run.` },
  quadJack: { name: msg`Quadjack`, text: msg`x${N.quadJack.xMult} combo if the pack has a quad.` },
  legacy: { name: msg`Legacy`, text: msg`Mythic and better cards score twice.` },
  spotlight: { name: msg`Spotlight`, text: msg`The card with the most notes gives x${N.spotlight.xMult} combo.` },
  prism: { name: msg`Prism`, text: msg`Rainbow cards give x${N.prism.xMult} combo.` },
  clutch: { name: msg`Clutch`, text: msg`x${N.clutch.xMult} combo when a song is still under half its target after its first pack.` },
  homeStage: { name: msg`Home Stage`, text: msg`Cards from your country score twice.` },
  extraKey: { name: msg`Extra Key`, text: msg`+${N.extraKey.slots} charm slots.` },
  spectator: { name: msg`Spectator`, text: msg`Scores as a copy of the charm to its right.` },
  graveyard: { name: msg`Graveyard`, text: msg`At the start of each song, removes the charm to its right and gains +${N.graveyard.perShard} combo for each shard that charm would sell for.` },
  overflow: { name: msg`Overflow`, text: msg`${pct(N.overflow.share)}% of the score past a cleared song's target carries into the next song.` },
  peakForm: { name: msg`Peak Performance`, text: msg`x1 combo plus x${N.peakForm.step} for each Legendary or better card in the pack.` },
  replay: { name: msg`Replay`, text: msg`Every card scores ${N.replay.extra} more times on the last pack of a song.` },
  marathon: { name: msg`Marathon`, text: msg`Gains x${N.marathon.step} combo every pack.` },
  hallOfFame: { name: msg`Hall of Fame`, text: msg`If the pack has a GOAT or Eternal card, every card scores twice.` },
  spectrum: { name: msg`Spectrum`, text: msg`x1 combo plus x${N.spectrum.step} for each different finish in the pack.` },
};

/* Patterns: what the cards in a pack line up as. Countries stack into
   chords, rarities run as stairs or repeat as jacks. */
export const HAND_TYPE_COPY: Record<HandTypeId, { name: MessageDescriptor; text: MessageDescriptor }> = {
  highCard: { name: msg`Single`, text: msg`Nothing lines up.` },
  pair: { name: msg`Jump`, text: msg`Two cards from the same country.` },
  twoPair: { name: msg`Jumptrill`, text: msg`Two countries with two cards each.` },
  threeOfAKind: { name: msg`Hand`, text: msg`Three cards from the same country.` },
  ladder: { name: msg`Stairs`, text: msg`Five rarities in a row.` },
  flush: { name: msg`Jacks`, text: msg`Five cards of the same rarity.` },
  fullHouse: { name: msg`Handstream`, text: msg`Three from one country and two from another.` },
  fourOfAKind: { name: msg`Quad`, text: msg`Four cards from the same country.` },
  fiveOfAKind: { name: msg`Chord`, text: msg`Five cards from the same country.` },
};

/* The mod on a stage's final song. `kind` picks the badge colour the way
   osu! sorts its mods. */
export const BOSS_COPY: Record<BossId, { name: MessageDescriptor; text: MessageDescriptor; acronym: string; kind: "increase" | "reduction" | "conversion" }> = {
  wall: { name: msg`Hard Rock`, text: msg`The target is twice as high.`, acronym: "HR", kind: "increase" },
  needle: { name: msg`Sudden Death`, text: msg`One pack to clear it.`, acronym: "SD", kind: "increase" },
  border: { name: msg`Mirror`, text: msg`Cards from your country score nothing.`, acronym: "MR", kind: "conversion" },
  flint: { name: msg`Half Time`, text: msg`The pattern's notes and combo are halved.`, acronym: "HT", kind: "reduction" },
  club: { name: msg`Fade In`, text: msg`Common cards score nothing.`, acronym: "FI", kind: "increase" },
  window: { name: msg`Flashlight`, text: msg`Rare cards score nothing.`, acronym: "FL", kind: "increase" },
  ceiling: { name: msg`Easy`, text: msg`Legendary and better cards score nothing.`, acronym: "EZ", kind: "reduction" },
  eye: { name: msg`Random`, text: msg`Each pattern scores only once.`, acronym: "RD", kind: "conversion" },
  tooth: { name: msg`Double Time`, text: msg`Every card gives half its notes.`, acronym: "DT", kind: "increase" },
  fog: { name: msg`Hidden`, text: msg`New cards score nothing.`, acronym: "HD", kind: "increase" },
  keyThree: { name: msg`Three Keys`, text: msg`Only the first ${B.keyThree.cards} cards score.`, acronym: "3K", kind: "conversion" },
  windUp: { name: msg`Wind Up`, text: msg`The target rises ${pct(B.windUp.growth)}% after every pack.`, acronym: "WU", kind: "increase" },
  windDown: { name: msg`Wind Down`, text: msg`Combo drops ${pct(B.windDown.step)}% for each pack already played this song.`, acronym: "WD", kind: "reduction" },
  cover: { name: msg`Cover`, text: msg`The charm in the first slot does nothing, apart from any slots or shop offers it adds.`, acronym: "CO", kind: "increase" },
  perfect: { name: msg`Perfect`, text: msg`A pack scoring under ${pct(B.perfect.share)}% of the target fails the song.`, acronym: "PF", kind: "increase" },
  constantSpeed: { name: msg`Constant Speed`, text: msg`Every pattern starts with the notes and combo of a Single.`, acronym: "CS", kind: "conversion" },
  dualStages: { name: msg`Dual Stages`, text: msg`Cards that share no country with another card score nothing.`, acronym: "DS", kind: "conversion" },
  holdOff: { name: msg`Hold Off`, text: msg`Finishes do nothing.`, acronym: "HO", kind: "conversion" },
  invert: { name: msg`Invert`, text: msg`Charms fire from the last slot to the first.`, acronym: "IN", kind: "conversion" },
  nightcore: { name: msg`Nightcore`, text: msg`Every pack scores x${B.nightcore.early} combo except the last, which scores x${B.nightcore.last}.`, acronym: "NC", kind: "increase" },
  muted: { name: msg`Muted`, text: msg`Charms give no notes.`, acronym: "MU", kind: "conversion" },
  daycore: { name: msg`Daycore`, text: msg`Every +combo is halved.`, acronym: "DC", kind: "reduction" },
  noRelease: { name: msg`No Release`, text: msg`Cards score only once.`, acronym: "NR", kind: "reduction" },
};

/* Run difficulties, osu! difficulty names. Each keeps the rules of the ones
   below it and adds its own. */
export const STAKE_COPY: Record<RunStakeId, { name: MessageDescriptor; text: MessageDescriptor }> = {
  beginner: { name: msg`Beginner`, text: msg`The standard run.` },
  normal: { name: msg`Normal`, text: msg`Targets are ${pct(STAKE_NUMBERS.targetFactor - 1)}% higher.` },
  hard: { name: msg`Hard`, text: msg`Song 2 of every stage carries a mod.` },
  insane: { name: msg`Insane`, text: msg`Every song has ${STAKE_NUMBERS.fewerPacks} pack fewer.` },
  expert: { name: msg`Expert`, text: msg`You have ${STAKE_NUMBERS.fewerSlots} charm slot fewer.` },
  expertPlus: { name: msg`Expert+`, text: msg`Song 1 of every stage carries a mod.` },
};

export const STAKE_LOCKED_COPY = msg`Win a run on the difficulty below to unlock it.`;

export const LOADOUT_COPY: Record<LoadoutId, { name: MessageDescriptor; text: MessageDescriptor; unlock: MessageDescriptor }> = {
  standard: { name: msg`Standard`, text: msg`No changes.`, unlock: msg`Always available.` },
  stamina: {
    name: msg`Stamina`,
    text: msg`Every song has +${LOADOUT_NUMBERS.stamina.packs} pack and you have ${-LOADOUT_NUMBERS.stamina.slots} charm slot fewer.`,
    unlock: msg`Reach stage ${LOADOUT_UNLOCKS.stamina.bestAnte}.`,
  },
  storyboard: {
    name: msg`Storyboard`,
    text: msg`Chrome, Neon and Rainbow finishes apply ${LOADOUT_NUMBERS.storyboard.finishTimes} times when scored.`,
    unlock: msg`Reach stage ${LOADOUT_UNLOCKS.storyboard.bestAnte}.`,
  },
  tournament: {
    name: msg`Tournament`,
    text: msg`You start with a random rare charm.`,
    unlock: msg`Win a run.`,
  },
  speed: {
    name: msg`Speed`,
    text: msg`You have +${LOADOUT_NUMBERS.speed.slots} charm slot and every song has ${-LOADOUT_NUMBERS.speed.packs} pack fewer.`,
    unlock: msg`Reach stage ${LOADOUT_UNLOCKS.speed.bestAnte}.`,
  },
  stream: {
    name: msg`Stream`,
    text: msg`You start with Hold Note.`,
    unlock: msg`Reach ${LOADOUT_UNLOCKS.stream.distinct.toLocaleString("en-US")} on the collection ladder.`,
  },
};

export const SKIP_REWARD_COPY: Record<SkipRewardId, { name: MessageDescriptor; text: MessageDescriptor }> = {
  goldPack: { name: msg`Gold pack`, text: msg`Your next pack is a Gold pack.` },
  rainbowPack: { name: msg`Rainbow pack`, text: msg`Your next pack is a Rainbow pack.` },
  finish: { name: msg`Finish`, text: msg`Your next pack has at least one card with a finish.` },
  charm: { name: msg`Free charm`, text: msg`Pick one of two common charms.` },
  slot: { name: msg`Extra slot`, text: msg`One more charm slot until this stage ends, when any charm past your slots is sold.` },
};

/* Refusals added with loadouts, difficulties and skips, for the page's
   refusal line. */
export const RUN_REFUSAL_COPY: Record<string, MessageDescriptor> = {
  locked: msg`Not unlocked yet.`,
  skips_disabled: msg`Skipping songs is not available yet.`,
  cannot_skip: msg`This song cannot be skipped.`,
  pick_pending: msg`Pick your skip reward first.`,
  no_pick: msg`There is no reward to pick.`,
};

/* Labels for the run-end numbers (RunStats). */
export const RUN_STATS_COPY: Record<keyof RunStats, MessageDescriptor> = {
  packsOpened: msg`Packs opened`,
  bestPack: msg`Best pack`,
  bestCard: msg`Best card`,
  charmsBought: msg`Charms bought`,
  charmsSold: msg`Charms sold`,
  songsCleared: msg`Songs cleared`,
  songsSkipped: msg`Songs skipped`,
  modsBeaten: msg`Mods beaten`,
  shardsEarned: msg`Shards earned`,
  rerolls: msg`Rerolls`,
  finishes: msg`Finishes pulled`,
};

export const MOD_TINT: Record<"increase" | "reduction" | "conversion", string> = {
  increase: "#ff6b6b",
  reduction: "#b2ff66",
  conversion: "#8c66ff",
};

export const EDITION_COPY: Record<RunEdition, { name: MessageDescriptor; text: MessageDescriptor }> = {
  foil: { name: msg`Chrome`, text: msg`+${EDITION_EFFECTS.foil.chips} notes` },
  holo: { name: msg`Neon`, text: msg`+${EDITION_EFFECTS.holo.mult} combo` },
  polychrome: { name: msg`Rainbow`, text: msg`x${EDITION_EFFECTS.polychrome.xMult} combo` },
};

export const WRAPPER_COPY: Record<Exclude<RunWrapper, "plain">, { name: MessageDescriptor; text: MessageDescriptor }> = {
  silver: { name: msg`Silver pack`, text: msg`Finishes are three times as likely.` },
  gold: { name: msg`Gold pack`, text: msg`At least one card has a finish.` },
  prismatic: { name: msg`Rainbow pack`, text: msg`Every card has the same finish.` },
};

export const RUNG_COPY: Record<string, MessageDescriptor> = {
  polychrome: msg`The Rainbow finish`,
  slot4: msg`A fourth charm slot`,
  rareCharms: msg`Rare charms in the shop`,
  chains: msg`Chain pulls and a third shop slot`,
  slot5: msg`A fifth charm slot`,
  legendary: msg`Legendary charms and endless runs`,
  slot6: msg`A sixth charm slot`,
  freeReroll: msg`One free reroll per shop`,
};

export const BLIND_COPY: Record<"small" | "big" | "boss", MessageDescriptor> = {
  small: msg`Song 1`,
  big: msg`Song 2`,
  boss: msg`Final song`,
};

export const BLIND_CLEARED_COPY: Record<"small" | "big" | "boss", MessageDescriptor> = {
  small: msg`Song 1 cleared`,
  big: msg`Song 2 cleared`,
  boss: msg`Stage cleared`,
};

/* The colours each finish and charm rarity draws with. */
export const EDITION_TINT: Record<RunEdition, string> = {
  foil: "#9cc7ff",
  holo: "#ff8ad8",
  polychrome: "#ffd36b",
};

/* osu! score meter digits: the total zero-padded to eight places. */
export function formatMeter(value: number): string {
  return String(Math.max(0, Math.round(value))).padStart(8, "0");
}

export const RARITY_TINT: Record<string, string> = {
  common: "#7fb6ff",
  uncommon: "#6be0a0",
  rare: "#ff6b8b",
  legendary: "#c58cff",
};

export function formatScore(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function formatMult(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(value < 10 ? 2 : 1).replace(/\.?0+$/, "");
}
