import { createServerFn } from "@tanstack/react-start";
import { msg } from "@lingui/core/macro";
import type { I18n, MessageDescriptor } from "@lingui/core";
import {
  CHAIN_SCENE_IDS,
  type ChainAction,
  type ChainActionResult,
  type ChainCard,
  type ChainPackView,
  type ChainRunView,
  type ChainSceneId,
  type ChainSkill,
  type ChainTier,
  type ChainVariant,
  CHAIN_VARIANT,
  CHAIN_REEL,
  CHAIN_SKILL_EFFECT,
  chainEffectSkill,
  chainSkillBand,
  type ChainReelId,
  type ChainReelPrize,
  type ChainTrait,
} from "../../backend/src/shared/chain-run";
import { honoraryPlayerById } from "./honorary-players";
import { liveBridgeToken } from "./live-backend-tokens";

/* The chain run on this side: the server functions behind its table and the
   copy for everything it names. The engine and its tables are the backend's
   (backend/src/shared/chain-run.ts), imported as-is so a local preview of a
   row scores exactly as the server will. */

export * from "../../backend/src/shared/chain-run";

/* One player's best run on the board (GET /api/chain-run/board). */
export interface ChainBoardEntry {
  rank: number;
  userId: number;
  username: string;
  round: number;
  bestRow: number;
  rows: number;
  finished: boolean;
  updatedAt: number;
}

export interface ChainRunResponse {
  run: ChainRunView | null;
  rev: number;
  best: ChainBoardEntry | null;
}

/* What an action answered: the result and the run after it, or a refusal
   code with the run as it stands (409), so the page can resync to it. */
export type ChainActionResponse =
  | { status: "ok"; result: ChainActionResult; run: ChainRunView | null; rev: number; best: ChainBoardEntry | null }
  | { status: "refused"; error: string; run: ChainRunView | null; rev: number; best: ChainBoardEntry | null };

async function chainTarget(): Promise<{ url: string; headers: HeadersInit; isAdmin: boolean } | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const { canUseAdminFeatures } = await import("./auth-shared");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = process.env.LIVE_BACKEND_URL?.trim().replace(/\/$/, "");
  if (!base) return null;
  const headers: HeadersInit = { "content-type": "application/json" };
  const bridgeToken = liveBridgeToken();
  if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;
  return { url: `${base}/api/chain-run/${auth.viewer.id}`, headers, isAdmin: canUseAdminFeatures(auth) };
}

/* Null when the viewer cannot play: logged out, no backend, or chain runs
   not released to them. `run` is null for a viewer who never started one. */
export const fetchOwnChainRun = createServerFn({ method: "GET" }).handler(async (): Promise<ChainRunResponse | null> => {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
  const target = await chainTarget();
  if (!target) return null;
  const response = await fetch(`${target.url}${target.isAdmin ? "?admin=1" : ""}`, { headers: target.headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Chain run fetch failed (${response.status}).`);
  return (await response.json()) as ChainRunResponse;
});

export type ChainActionInput = ChainAction & { rev: number };

function cleanAction(input: ChainActionInput): ChainActionInput {
  const int = (value: unknown) => Math.floor(Number(value));
  const ints = (value: unknown, max: number) =>
    Array.isArray(value) && value.length <= max && value.every((entry) => Number.isSafeInteger(int(entry))) ? value.map(int) : null;
  const rev = int(input?.rev);
  if (!Number.isSafeInteger(rev) || rev < 0) throw new Error("Invalid chain action.");
  switch (input?.kind) {
    case "start":
    case "openPack":
    case "reroll":
    case "nextRound":
    case "abandon":
      return { kind: input.kind, rev };
    case "keep": {
      const ids = ints(input.ids, 10);
      if (ids) return { kind: "keep", ids, rev };
      break;
    }
    case "playRow":
    case "redraw": {
      const uids = ints(input.uids, 12);
      if (uids) return { kind: input.kind, uids, rev };
      break;
    }
    case "buy":
      if (input.item === "scene") return { kind: "buy", item: "scene", rev };
      if (input.item === "pack" && Number.isSafeInteger(int(input.index))) return { kind: "buy", item: "pack", index: int(input.index), rev };
      break;
    case "sell":
      if ((CHAIN_SCENE_IDS as readonly string[]).includes(String(input.scene))) return { kind: "sell", scene: input.scene, rev };
      break;
    case "removeCard":
      if (Number.isSafeInteger(int(input.uid))) return { kind: "removeCard", uid: int(input.uid), rev };
      break;
    default:
      break;
  }
  throw new Error("Invalid chain action.");
}

export const actOnOwnChainRun = createServerFn({ method: "POST" })
  .validator((input: ChainActionInput) => cleanAction(input))
  .handler(async ({ data }): Promise<ChainActionResponse | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await chainTarget();
    if (!target) return null;
    const { kind, ...rest } = data;
    const response = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({ action: kind, ...rest, viewerIsAdmin: target.isAdmin }),
    });
    if (response.status === 404) return null;
    if (response.status === 409 || response.status === 503) {
      const body = (await response.json().catch(() => null)) as Partial<ChainRunResponse> & { error?: unknown };
      return {
        status: "refused",
        error: typeof body?.error === "string" ? body.error : "refused",
        run: body?.run ?? null,
        rev: Number(body?.rev) || 0,
        best: body?.best ?? null,
      };
    }
    if (!response.ok) throw new Error(`Chain run action failed (${response.status}).`);
    const body = (await response.json()) as ChainRunResponse & { result: ChainActionResult };
    return { status: "ok", result: body.result, run: body.run, rev: body.rev, best: body.best ?? null };
  });

/* ------------------------------------------------------------------ copy */

/* The game's name, shown on the /packs game pack and the table. The owner
   has not settled it: renaming the run is this one line. */
export const CHAIN_RUN_NAME = msg`Overjoy`;

export const CHAIN_TIER_LABEL: Record<ChainTier, MessageDescriptor> = {
  common: msg`Common`,
  rare: msg`Rare`,
  elite: msg`Elite`,
  superRare: msg`Super Rare`,
  ultraRare: msg`Ultra Rare`,
  legendary: msg`Legendary`,
  mythic: msg`Mythic`,
  ascendant: msg`Ascendant`,
  worldClass: msg`World Class`,
};

/* The card's colour by rarity: `fill` paints the card, `ink` is the bright
   accent its marks and the link chips use. */
export const CHAIN_TIER_COLOR: Record<ChainTier, { fill: string; deep: string; ink: string }> = {
  common: { fill: "#5d6878", deep: "#2c323c", ink: "#c3cddb" },
  rare: { fill: "#1f86c4", deep: "#123f63", ink: "#7fd3ff" },
  elite: { fill: "#6d4fd0", deep: "#33246a", ink: "#c4b2ff" },
  superRare: { fill: "#b13fcb", deep: "#561d66", ink: "#f2a9ff" },
  ultraRare: { fill: "#d6306f", deep: "#6a1534", ink: "#ff9cc3" },
  legendary: { fill: "#d69513", deep: "#6b4708", ink: "#ffd978" },
  mythic: { fill: "#cf3b31", deep: "#661812", ink: "#ff9f97" },
  ascendant: { fill: "#c9a640", deep: "#5e4a12", ink: "#fff0b8" },
  worldClass: { fill: "#1f9e57", deep: "#0e4d29", ink: "#8ff2b7" },
};

/* A GOAT's colour, the maniacard GOAT's amber, and its rarity word. */
export const CHAIN_GOAT_COLOR = { fill: "#d9960f", deep: "#4a2a04", ink: "#ffd978" };
export const CHAIN_GOAT_LABEL = msg`GOAT`;

/* The colour and rarity word a card shows: its tier's, or the GOAT's. The
   roster's own badge text for a GOAT (cardTierLabel) wins when it has one. */
export function chainCardColor(card: Pick<ChainCard, "tier" | "goat">) {
  return card.goat ? CHAIN_GOAT_COLOR : CHAIN_TIER_COLOR[card.tier];
}

export function chainCardRarityLabel(card: Pick<ChainCard, "id" | "tier" | "goat">, i18n: I18n): string {
  if (!card.goat) return i18n._(CHAIN_TIER_LABEL[card.tier]);
  return honoraryPlayerById(card.id)?.cardTierLabel ?? i18n._(CHAIN_GOAT_LABEL);
}

/* A GOAT's face comes from the honorary roster by id, the one source of a
   GOAT card's face (as packs hydrate theirs); anything else as dealt. */
export function chainCardFace<T extends Pick<ChainCard, "id" | "name" | "avatarUrl" | "cc" | "goat">>(card: T): T {
  if (!card.goat) return card;
  const honoree = honoraryPlayerById(card.id);
  if (!honoree) return card;
  return { ...card, name: honoree.cardName ?? honoree.username, avatarUrl: honoree.avatarUrl, cc: honoree.countryCode || card.cc };
}

const SKILL_SHORT: Partial<Record<ChainSkill, string>> = { Jumpstream: "JS", Handstream: "HS", Chordjack: "CJ", Chordstream: "CS" };

/* Card variants: the name (an osu!mania result, never translated), the badge
   the face wears, its colours and the rule. */
export const CHAIN_VARIANT_COPY: Record<ChainVariant, { name: string; badge: string; fill: string; ink: string; text: MessageDescriptor }> = {
  silver: {
    name: "Silver SS",
    badge: "SS",
    fill: "linear-gradient(135deg, #f8fafc 0%, #94a3b8 48%, #e2e8f0 100%)",
    ink: "#dfe6ee",
    text: msg`Base x${CHAIN_VARIANT.silverCleanBase} while the row has no break before it, else x${CHAIN_VARIANT.silverBase}.`,
  },
  mirror: {
    name: "Mirror",
    badge: "MR",
    fill: "linear-gradient(135deg, #f0f9ff 0%, #7dd3fc 45%, #e0f2fe 70%, #38bdf8 100%)",
    ink: "#bfe6ff",
    text: msg`Links to each side with the traits of the card on its other side too.`,
  },
  pfc: {
    name: "PFC",
    badge: "PFC",
    fill: "linear-gradient(135deg, #fff3c4 0%, #f6c343 45%, #b7791f 100%)",
    ink: "#ffd36b",
    text: msg`The links on both its sides never break.`,
  },
  max: {
    name: "MAX",
    badge: "MAX",
    fill: "linear-gradient(110deg, #ff8fd0, #ffd36b, #a5f3c4, #7fd3ff, #c4b2ff)",
    ink: "#ffffff",
    text: msg`Doubles the combo before it scores.`,
  },
};

/* The reel's prizes: the tile's big mark and small word, its rarity colour
   (by how often it lands), and the line saying what it does. Mod names
   (EZ, DT, NF) and 727 stay as they are in every language. */
const CHAIN_TRAIT_WORD: Record<ChainTrait, MessageDescriptor> = {
  cc: msg`Country`,
  tier: msg`Rarity`,
  key: msg`Keymode`,
  skill: msg`Skillset`,
};

export const CHAIN_REEL_INK: Record<ChainReelId, string> = {
  shards: "#9fb3cf",
  retry: "#9fb3cf",
  redraws: "#9fb3cf",
  warmup: "#6fb6ff",
  ez: "#6fb6ff",
  dt: "#b28cff",
  surge: "#b28cff",
  nf: "#ff7ac3",
  wysi: "#ffd36b",
  wallet: "#7cf5c8",
};

export function chainReelTile(prize: ChainReelPrize, i18n: I18n): { mark: string; word: string; text: string } {
  const trait = prize.trait ? i18n._(CHAIN_TRAIT_WORD[prize.trait]) : "";
  switch (prize.id) {
    case "shards":
      return { mark: `+${prize.amount ?? 0}`, word: i18n._(msg`Shards`), text: i18n._(msg`+${prize.amount ?? 0} shards now.`) };
    case "retry":
      return { mark: `+${CHAIN_REEL.retryRows}`, word: i18n._(msg`Row`), text: i18n._(msg`Next round has ${CHAIN_REEL.retryRows} more row.`) };
    case "redraws":
      return { mark: `+${CHAIN_REEL.redraws}`, word: i18n._(msg`Redraws`), text: i18n._(msg`Next round has ${CHAIN_REEL.redraws} more redraws.`) };
    case "warmup":
      return { mark: `+${CHAIN_REEL.warmupCombo}`, word: i18n._(msg`Warm-up`), text: i18n._(msg`Next round's first row starts at +${CHAIN_REEL.warmupCombo} combo.`) };
    case "ez":
      return { mark: "EZ", word: `-${Math.round((1 - CHAIN_REEL.ezTarget) * 100)}%`, text: i18n._(msg`Next round's target is ${Math.round((1 - CHAIN_REEL.ezTarget) * 100)}% lower.`) };
    case "dt":
      return { mark: "DT", word: `x${CHAIN_REEL.dt}`, text: i18n._(msg`Next round's first row scores x${CHAIN_REEL.dt}.`) };
    case "surge":
      return { mark: `x${CHAIN_REEL.surge}`, word: trait, text: i18n._(msg`Next round's first row: ${trait} links add double.`) };
    case "nf":
      return { mark: "NF", word: i18n._(msg`No break`), text: i18n._(msg`Next round's first row can't break.`) };
    case "wysi":
      return { mark: "727", word: i18n._(msg`Combo`), text: i18n._(msg`Next round's first row starts on 727 combo.`) };
    case "wallet": {
      const amount = (prize.amount ?? CHAIN_REEL.wallet).toLocaleString("en-US");
      return { mark: `+${amount}`, word: i18n._(msg`Wallet`), text: i18n._(msg`+${amount} shards to your pack wallet.`) };
    }
  }
}

/* The words a skillset effect leaves under its card, in the row preview and
   as the row plays. */
export const CHAIN_SKILL_WORD = {
  late: msg`LATE`,
  twice: msg`x2 HIT`,
  borrow: msg`BORROW`,
  stream: msg`Stream`,
};

/* What a card's skillset does, as its hover line, with the numbers of its
   band (chainSkillBand). One line each, osu!mania words. */
const pct = (share: number) => Math.round(share * 1000) / 10;
export function chainSkillEffectText(card: Pick<ChainCard, "skill" | "goat" | "tier">, i18n: I18n): string | null {
  const skill = chainEffectSkill(card);
  if (!skill) return null;
  const band = chainSkillBand(card);
  const E = CHAIN_SKILL_EFFECT;
  switch (skill) {
    case "Stream":
      return i18n._(msg`Each link after it lifts the combo ${pct(E.stream[band])}% more, until a break.`);
    case "Jumpstream":
      return i18n._(msg`+${E.jumpstream[band]} base for each Jumpstream in your deck (up to ${E.jumpstreamCap}).`);
    case "Handstream":
      return i18n._(msg`Linked on both sides: it and both neighbours score x${E.handstream[band]}.`);
    case "Stamina":
      return i18n._(msg`An unbroken row of 6 trains every Stamina in your deck +${E.stamina[band]} base.`);
    case "Jack":
      return band === 2
        ? i18n._(msg`Hits twice.`)
        : band === 1
          ? i18n._(msg`Hits twice; the link into it adds half its combo.`)
          : i18n._(msg`Hits twice; the link into it adds no combo.`);
    case "Chordjack":
      return band === 2 ? i18n._(msg`The links into and out of it fire twice.`) : i18n._(msg`The link into it fires twice.`);
    case "Tech":
      return i18n._(msg`+${pct(E.tech[band])}% points for each other skillset in the row.`);
    case "Chordstream":
      return i18n._(msg`Scores with the previous card's base x${E.chordstream[band]}, if higher.`);
    case "Bracket":
      return i18n._(msg`Pairs with the next Bracket: the cards between score +${pct(E.bracket[band])}% from each.`);
    case "Delay":
      return E.delay[band] === 1
        ? i18n._(msg`Lands late: scores at the combo the row ends on.`)
        : i18n._(msg`Lands late: scores at the combo the row ends on, x${E.delay[band]}.`);
    default:
      return null;
  }
}

export function chainSkillShort(skill: ChainSkill): string {
  return SKILL_SHORT[skill] ?? skill;
}

/* Scene card rules (approved wording). `short` is the line under the name,
   `text` the full rule in the hover. */
export const CHAIN_SCENE_COPY: Record<ChainSceneId, { short: MessageDescriptor; text: MessageDescriptor }> = {
  makiba: {
    short: msg`The last 3 cards always link.`,
    text: msg`The last 3 cards of a row always link as if they shared 3 traits. Any of them that would not have linked to a neighbour on its own scores half its base.`,
  },
  mario: {
    short: msg`The first break becomes a link.`,
    text: msg`The first break in each row becomes a 3-trait link.`,
  },
  duplicity: {
    short: msg`Card 2 copies card 1.`,
    text: msg`The second card in each row also has every trait of the first.`,
  },
  echoes: {
    short: msg`The row plays twice.`,
    text: msg`After the row scores, every link and card fires again, and the combo carries on from where it ended.`,
  },
  tree: {
    short: msg`Cards also link two back.`,
    text: msg`Each card also links to the card two slots back. A card breaks only if it links to neither.`,
  },
  forgotten: {
    short: msg`The star was not meant for you.`,
    text: msg`A star sits at 3x the target. Clear a round without the round score passing it and every row starts 2 combo higher. Pass it and she leaves with all of it.`,
  },
  future: {
    short: msg`Three alike form a hand.`,
    text: msg`Three cards in a row that share one trait form a hand, and its two links fire three times. Each hand after the first multiplies the row by 1.3.`,
  },
  ascension: {
    short: msg`All-7K rows multiply.`,
    text: msg`A row of only 7K cards is multiplied by her multiplier, which starts at 1.5 and rises by 0.25 each time. If you would fail a round, she burns and the round starts over.`,
  },
  aiae: {
    short: msg`A full row with no break scores x3.`,
    text: msg`A row of 6 cards with no break is an SS and scores x3.`,
  },
  scatteredFaith: {
    short: msg`A break only halves the combo.`,
    text: msg`A break halves the combo instead of ending it, and each break multiplies the row by 1.4.`,
  },
  foolMoon: {
    short: msg`The lowest base fits anywhere.`,
    text: msg`The card with the lowest base in each row matches every trait of the cards next to it.`,
  },
  moonGate: {
    short: msg`Short rows score x3.`,
    text: msg`A row of 4 cards or fewer scores x3.`,
  },
  lostRequiem: {
    short: msg`Recycling raises every base.`,
    text: msg`Each card you recycle or remove while you hold it adds 1 to every card's base for the rest of the run.`,
  },
  purplePalace: {
    short: msg`Rows of all different rarities score x3.5.`,
    text: msg`A row where every card is a different rarity scores x3.5.`,
  },
};

/* The scene card's ink, for its effects on the table. */
export const CHAIN_SCENE_INK: Record<ChainSceneId, string> = {
  makiba: "#8fd16a",
  mario: "#4fd2d9",
  duplicity: "#b98cff",
  echoes: "#d9d2bf",
  tree: "#ff8a5c",
  forgotten: "#8fa7ff",
  future: "#ff5c8a",
  ascension: "#ffc24d",
  aiae: "#5fe0b0",
  scatteredFaith: "#6fb6ff",
  foolMoon: "#e0b98a",
  moonGate: "#d6e06a",
  lostRequiem: "#e8524c",
  purplePalace: "#f07ee0",
};

const REFUSALS: Record<string, MessageDescriptor> = {
  no_shards: msg`Not enough shards.`,
  spun: msg`Already spun this visit.`,
  sold: msg`Already bought.`,
  slots_full: msg`Every scene card slot is full. Sell one first.`,
  deck_too_small: msg`Your deck can't go below 4 cards.`,
  no_redraws: msg`No redraws left this round.`,
  no_rows: msg`No rows left this round.`,
  pool_unavailable: msg`Cards can't be dealt right now. Try again in a moment.`,
};

export function chainRefusalMessage(error: string, i18n: I18n): string {
  const copy = REFUSALS[error];
  return copy ? i18n._(copy) : i18n._(msg`That didn't go through. Try again.`);
}

/* The pack's name as the shop and the pack stage print it. */
export function chainPackName(pack: Pick<ChainPackView, "reason" | "startIndex" | "offer">, round: number, i18n: I18n): string {
  if (pack.reason === "start") {
    const index = pack.startIndex ?? 1;
    return i18n._(msg`Starting pack ${index} of 3`);
  }
  if (pack.reason === "round") return i18n._(msg`Round ${round} pack`);
  return pack.offer ? chainOfferName(pack.offer, i18n) : i18n._(msg`Pack`);
}

export function chainOfferName(offer: { kind: string; cc?: string; skill?: string; key?: number }, i18n: I18n): string {
  switch (offer.kind) {
    case "country": {
      const cc = offer.cc ?? "";
      return i18n._(msg`${cc} pack`);
    }
    case "skill": {
      const skill = offer.skill ?? "";
      return i18n._(msg`${skill} pack`);
    }
    case "key": {
      const key = offer.key ?? 7;
      return i18n._(msg`${key}K pack`);
    }
    case "big":
      return i18n._(msg`Big pack`);
    default:
      return i18n._(msg`Pack`);
  }
}

export function formatChainScore(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function formatChainX(value: number): string {
  return (Math.round(value * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
}
