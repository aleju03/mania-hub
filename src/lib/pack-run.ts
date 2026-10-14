import { createServerFn } from "@tanstack/react-start";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import {
  CHARM_NUMBERS,
  EDITION_EFFECTS,
  type BossId,
  type HandTypeId,
  type OpenOutcome,
  type PackRunState,
  type RunEdition,
  type RunUnlocks,
  type RunWrapper,
  type ShopAction,
} from "../../backend/src/shared/pack-run";
import { liveBridgeToken } from "./live-backend-tokens";

/* The pack run on this side: the server functions behind the run page and
   the copy for everything it names. The engine and its tables are the
   backend's (backend/src/shared/pack-run.ts), imported as-is so the numbers
   a description prints are the numbers the server scores with. */

export * from "../../backend/src/shared/pack-run";

export interface PackRunView {
  state: PackRunState;
  unlocks: RunUnlocks;
  distinct: number;
  rungs: Array<{ at: number; unlock: string; reached: boolean }>;
  masterSets?: Record<RunEdition, number>;
  /* Players in the draw pool, the size of a full master set. */
  poolTotal?: number;
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
      case "newRun":
        return { kind: input.kind } as ShopAction;
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
  hoarder: { name: msg`Hoarder`, text: msg`Cards give +${N.hoarder.chips} notes per mastery level.` },
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
  herd: { name: msg`Herd`, text: msg`GOAT and Eternal cards give x${N.herd.xMult} combo.` },
  ascension: { name: msg`Ascension`, text: msg`Gains x${N.ascension.step} combo for every final song cleared.` },
  luckyStrike: { name: msg`Lucky Strike`, text: msg`x${N.luckyStrike.xMult} combo. 1 in ${N.luckyStrike.breakOdds} chance to break after each pack.` },
  echo: { name: msg`Echo`, text: msg`Cards with a finish score twice.` },
  oldGuard: { name: msg`Old Guard`, text: msg`Cards in the global top ${N.oldGuard.rank} give x${N.oldGuard.xMult} combo.` },
  party: { name: msg`Party`, text: msg`x${N.party.xMult} combo if the pack has a handstream or better.` },
  archivist: { name: msg`Archivist`, text: msg`Gains x${N.archivist.step} combo for every new card this run.` },
  crown: { name: msg`Crown`, text: msg`GOAT and Eternal cards give x${N.crown.xMult} combo, Mythic and better x${N.crown.highXMult}.` },
  mirror: { name: msg`Twin`, text: msg`Every card scores twice.` },
  giantSlayer: { name: msg`Nomod`, text: msg`Mods have no effect.` },
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
};

export const MOD_TINT: Record<"increase" | "reduction" | "conversion", string> = {
  increase: "#ff6b6b",
  reduction: "#b2ff66",
  conversion: "#c58cff",
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
