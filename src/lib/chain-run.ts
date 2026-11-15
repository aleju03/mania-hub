import { createServerFn } from "@tanstack/react-start";
import { msg } from "@lingui/core/macro";
import type { I18n, MessageDescriptor } from "@lingui/core";
import {
  CHAIN_CONTRACTS,
  type ChainContractId,
  type ChainContractTrack,
  chainContractBroken,
  chainContractMet,
  CHAIN_SCENE_IDS,
  type ChainAction,
  type ChainActionResult,
  type ChainCard,
  type ChainPackView,
  type ChainRunSnapshot,
  type ChainRunView,
  type ChainSceneId,
  type ChainSkill,
  type ChainTier,
  type ChainVariant,
  CHAIN_VARIANT,
  CHAIN_REEL,
  CHAIN_SKILL_EFFECT,
  chainEffectSkill,
  chainRegionName,
  chainRegionCode,
  CHAIN_SKILL2_MARK,
  isChainTier,
  chainSkillBand,
  type ChainReelId,
  type ChainReelPrize,
  type ChainTrait,
  type ChainModId,
  CHAIN_MODS,
  CHAIN_SCENE_NUMBERS,
  chainScoreText,
  chainEternalBase,
  isChainStartDeck,
} from "../../backend/src/shared/chain-run";
import { honoraryPlayerById } from "./honorary-players";
import { displayCountryName } from "./country";
import type { AppLocale } from "./locale";
import { getRegionDef } from "./regions";
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
  /* Country code for the flag, "" when unknown (older entries). */
  cc?: string;
  round: number;
  bestRow: number;
  rows: number;
  finished: boolean;
  updatedAt: number;
}

/* The board's periods: every run, and runs played this UTC month. */
export type ChainBoardPeriod = "all" | "month" | "day";

/* A board page, and the viewer's own entry when it was asked for. */
export interface ChainBoardPage {
  entries: ChainBoardEntry[];
  mine: ChainBoardEntry | null;
}

/* A board entry's run sheet: what the run was built from (null for entries
   saved before builds were kept). */
export interface ChainRunSheet {
  entry: ChainBoardEntry;
  snapshot: ChainRunSnapshot | null;
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

/* A player's own run, or the daily run (everyone on the same cards that UTC day, one try). */
export type ChainRunMode = "normal" | "daily";
const cleanMode = (mode: unknown): ChainRunMode => (mode === "daily" ? "daily" : "normal");

async function chainTarget(mode: ChainRunMode = "normal"): Promise<{ url: string; headers: HeadersInit; country: string } | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = process.env.LIVE_BACKEND_URL?.trim().replace(/\/$/, "");
  if (!base) return null;
  const headers: HeadersInit = { "content-type": "application/json" };
  const bridgeToken = liveBridgeToken();
  if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;
  return { url: `${base}/api/chain-run/${auth.viewer.id}${mode === "daily" ? "?mode=daily" : ""}`, headers, country: auth.viewer.countryCode ?? "" };
}

/* Null when the viewer cannot play: logged out or no backend. `run` is null
   for a viewer who never started one. */
export const fetchOwnChainRun = createServerFn({ method: "GET" })
  .validator((mode: ChainRunMode | undefined) => cleanMode(mode))
  .handler(async ({ data: mode }): Promise<ChainRunResponse | null> => {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
  const target = await chainTarget(mode);
  if (!target) return null;
  const response = await fetch(target.url, { headers: target.headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Chain run fetch failed (${response.status}).`);
  return (await response.json()) as ChainRunResponse;
});

export type ChainActionInput = ChainAction & { rev: number; mode?: ChainRunMode };

function cleanAction(input: ChainActionInput): ChainActionInput {
  const rev = Math.floor(Number(input?.rev));
  if (!Number.isSafeInteger(rev) || rev < 0) throw new Error("Invalid chain action.");
  const mode = cleanMode(input?.mode);
  const clean = cleanActionBody(input, rev);
  return mode === "daily" ? { ...clean, mode } : clean;
}

function cleanActionBody(input: ChainActionInput, rev: number): ChainActionInput {
  const int = (value: unknown) => Math.floor(Number(value));
  const ints = (value: unknown, max: number) =>
    Array.isArray(value) && value.length <= max && value.every((entry) => Number.isSafeInteger(int(entry))) ? value.map(int) : null;
  switch (input?.kind) {
    case "start":
      return isChainStartDeck(input.deck) ? { kind: "start", deck: input.deck, rev } : { kind: "start", rev };
    case "openPack":
    case "reroll":
    case "nextRound":
    case "revive":
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
      if (input.item === "practice") return { kind: "buy", item: "practice", rev };
      if (input.item === "pack" && Number.isSafeInteger(int(input.index))) return { kind: "buy", item: "pack", index: int(input.index), rev };
      if (input.item === "mod" && Number.isSafeInteger(int(input.index))) return { kind: "buy", item: "mod", index: int(input.index), rev };
      break;
    case "useMod":
      if (Number.isSafeInteger(int(input.index)) && Number.isSafeInteger(int(input.uid))) return { kind: "useMod", index: int(input.index), uid: int(input.uid), rev };
      break;
    case "sell":
      if ((CHAIN_SCENE_IDS as readonly string[]).includes(String(input.scene))) return { kind: "sell", scene: input.scene, rev };
      break;
    case "removeCard":
      if (Number.isSafeInteger(int(input.uid))) return { kind: "removeCard", uid: int(input.uid), rev };
      break;
    case "sign":
      if (Number.isSafeInteger(int(input.index))) return { kind: "sign", index: int(input.index), rev };
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
    const { kind, mode, ...rest } = data;
    const target = await chainTarget(cleanMode(mode));
    if (!target) return null;
    const response = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      // The country only puts a flag beside the player's name on the boards.
      body: JSON.stringify({ action: kind, ...rest, viewerCountry: target.country }),
    });
    if (response.status === 404) return null;
    if (response.status === 409 || response.status === 503) {
      const body = (await response.json().catch(() => null)) as (Partial<ChainRunResponse> & { error?: unknown }) | null;
      // A refusal of the backend's own carries the run; anything else (a proxy's
      // error page) says nothing about it and must not blank the table.
      if (!body || typeof body.rev !== "number") throw new Error(`Chain run action failed (${response.status}).`);
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

/* ---------------------------------------------------------------- shares */

/* A finished run as its share link shows it (the backend's ChainRunShare). */
export interface ChainRunShare {
  id: string;
  userId: number;
  username: string;
  daily: boolean;
  won: boolean;
  round: number;
  bestRow: number;
  rows: number;
  scenes: ChainSceneId[];
  bestRowCards: ChainCard[];
  createdAt: number;
}

/* The share link id of the viewer's finished run (the same id however often
   it is shared); null for a guest, a run still going, or no backend. */
export const shareOwnChainRun = createServerFn({ method: "POST" })
  .validator((mode: ChainRunMode | undefined) => cleanMode(mode))
  .handler(async ({ data: mode }): Promise<{ id: string } | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await chainTarget(mode);
    if (!target) return null;
    const url = new URL(target.url);
    url.pathname = `${url.pathname}/share`;
    const response = await fetch(url, { method: "POST", headers: target.headers });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
    return typeof body?.id === "string" ? { id: body.id } : null;
  });

/* A run's share, for its page; null when the link is wrong. */
export const fetchChainRunShare = createServerFn({ method: "GET" })
  .validator((id: string) => String(id ?? "").slice(0, 32))
  .handler(async ({ data: id }): Promise<ChainRunShare | null> => {
    if (!/^[a-zA-Z0-9]{6,16}$/.test(id)) return null;
    const base = process.env.LIVE_BACKEND_URL?.trim().replace(/\/$/, "");
    if (!base) return null;
    const response = await fetch(`${base}/api/chain-run/share/${id}`);
    if (!response.ok) return null;
    return (await response.json()) as ChainRunShare;
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
/* An Eternal's, the maniacard Eternal's violet. */
export const CHAIN_ETERNAL_COLOR = { fill: "#7e22ce", deep: "#2e1065", ink: "#e9d5ff" };
export const CHAIN_ETERNAL_LABEL = msg`Eternal`;

/* The colour and rarity word a card shows: its tier's, the GOAT's or the
   Eternal's. The roster's own badge text for a GOAT (cardTierLabel) wins
   when it has one. */
export function chainCardColor(card: Pick<ChainCard, "tier" | "goat" | "eternal">) {
  return card.goat ? CHAIN_GOAT_COLOR : card.eternal ? CHAIN_ETERNAL_COLOR : CHAIN_TIER_COLOR[card.tier];
}

export function chainCardRarityLabel(card: Pick<ChainCard, "id" | "tier" | "goat" | "eternal">, i18n: I18n): string {
  if (card.eternal && !card.goat) return i18n._(CHAIN_ETERNAL_LABEL);
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
  replay: {
    name: "Replay",
    badge: "RP",
    fill: "linear-gradient(135deg, #e7fff6 0%, #5eead4 45%, #0f766e 100%)",
    ink: "#8ff5dc",
    text: msg`After it scores, the link into it triggers again and it scores again.`,
  },
  random: {
    name: "Random",
    badge: "RD",
    fill: "linear-gradient(135deg, #fde68a 0%, #f472b6 45%, #60a5fa 100%)",
    ink: "#f9a8d4",
    text: msg`Its country, keymode and skillset change every round.`,
  },
  anchor: {
    name: "Anchor",
    badge: "AN",
    fill: "linear-gradient(135deg, #f1f5f9 0%, #94a3b8 50%, #475569 100%)",
    ink: "#cbd5e1",
    text: msg`A break later in the row only drops the combo back to what this card scored at.`,
  },
  chameleon: {
    name: "Chameleon",
    badge: "CH",
    fill: "linear-gradient(135deg, #ecfccb 0%, #4ade80 50%, #0e7490 100%)",
    ink: "#86efac",
    text: msg`Matches every trait of the cards next to it.`,
  },
  max: {
    name: "MAX",
    badge: "MAX",
    fill: "linear-gradient(110deg, #ff8fd0, #ffd36b, #a5f3c4, #7fd3ff, #c4b2ff)",
    ink: "#ffffff",
    text: msg`Doubles the combo before it scores.`,
  },
};

/* Mod cards: the chip's mark and colours, its name and what it does. The
   variant mods wear their variant's badge. */
const MOD_EXTRA: Record<"keyChange" | "rateUp", { name: MessageDescriptor; badge: string; fill: string; ink: string; text: MessageDescriptor }> = {
  keyChange: {
    name: msg`Key Change`,
    badge: "KC",
    fill: "linear-gradient(135deg, #e0f2fe 0%, #7fc4ff 50%, #1d4ed8 100%)",
    ink: "#7fc4ff",
    text: msg`Turns a 4K card into 7K, or 7K into 4K.`,
  },
  rateUp: {
    name: msg`Rate Up`,
    badge: `x${CHAIN_MODS.rateUp}`,
    fill: "linear-gradient(135deg, #fff7d6 0%, #ffd36b 50%, #c2410c 100%)",
    ink: "#ffd36b",
    text: msg`A card's base goes up by half.`,
  },
};

export function chainModLook(id: ChainModId, i18n: I18n): { name: string; badge: string; fill: string; ink: string; text: string } {
  if (id === "keyChange" || id === "rateUp") {
    const extra = MOD_EXTRA[id];
    return { name: i18n._(extra.name), badge: extra.badge, fill: extra.fill, ink: extra.ink, text: i18n._(extra.text) };
  }
  const variant = CHAIN_VARIANT_COPY[id];
  const name = variant.name;
  return { name, badge: variant.badge, fill: variant.fill, ink: variant.ink, text: i18n._(msg`Makes a card ${name}. ${i18n._(variant.text)}`) };
}

/* The reel's prizes: the tile's big mark and small word, its rarity colour
   (by how often it lands), and the line saying what it does. Mod names
   (EZ, DT, NF) and 727 stay as they are in every language. */
export const CHAIN_TRAIT_WORD: Record<ChainTrait, MessageDescriptor> = {
  cc: msg`Country`,
  region: msg`Region`,
  tier: msg`Rarity`,
  dan: msg`Dan`,
  key: msg`Keymode`,
  skill: msg`Skillset`,
};

/* A region's name in the reader's language, from the same table the
   country picker uses; English when the table has no entry. */
function regionWord(code: string, i18n: I18n): string {
  return getRegionDef(code) ? displayCountryName(code, i18n.locale as AppLocale) : chainRegionName(code);
}

/* A card's region by name, from its country ("South America"). */
export function chainRegionOf(card: Pick<ChainCard, "cc" | "chart">, i18n: I18n): string | null {
  const code = card.chart || !card.cc ? null : chainRegionCode(card.cc);
  return code ? regionWord(code, i18n) : null;
}

/* A dan's bare label as people say it: "Dan 10", "Gamma". */
export function chainDanName(dan: string): string {
  return /^\d+$/.test(dan) ? `Dan ${dan}` : dan.charAt(0).toUpperCase() + dan.slice(1);
}

/* A link trait's value in words: a region's name, a dan without its
   keymode, a rarity's label; anything else as it is. */
export function chainTraitValueText(trait: string, value: string, i18n: I18n): string {
  if (trait === "region") return regionWord(value, i18n);
  if (trait === "dan") return chainDanName(value.replace(/^\d+K /, ""));
  if (trait === "tier" && isChainTier(value)) return i18n._(CHAIN_TIER_LABEL[value]);
  if (trait === "skill" && value.startsWith(CHAIN_SKILL2_MARK)) return value.slice(CHAIN_SKILL2_MARK.length);
  return value;
}

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
      return i18n._(msg`Play it in a row of 6 with no breaks and every Stamina card in your deck gains +${E.stamina[band]} base for the run.`);
    case "Jack":
      return band === 2
        ? i18n._(msg`Hits twice.`)
        : band === 1
          ? i18n._(msg`Hits twice; the link into it adds half its combo.`)
          : i18n._(msg`Hits twice; the link into it adds no combo.`);
    case "Chordjack":
      return band === 2 ? i18n._(msg`The links into and out of it trigger twice.`) : i18n._(msg`The link into it triggers twice.`);
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
    text: msg`The last 3 cards in a row link like they share 3 traits. A card there with no real link of its own scores half its base.`,
  },
  mario: {
    short: msg`Your first break becomes a link.`,
    text: msg`The first break in each row counts as a 3-trait link instead.`,
  },
  duplicity: {
    short: msg`Card 2 copies card 1.`,
    text: msg`The second card in a row also gets every trait of the first card.`,
  },
  echoes: {
    short: msg`Every row plays twice.`,
    text: msg`After a row scores, it plays again from the first card and keeps its combo.`,
  },
  tree: {
    short: msg`Cards also link two back.`,
    text: msg`Each card can also link to the card two spots back. It only breaks if neither link works.`,
  },
  forgotten: {
    short: msg`Stay under ${CHAIN_SCENE_NUMBERS.starTimesTarget}x the target for more combo.`,
    text: msg`Every round you clear without going past ${CHAIN_SCENE_NUMBERS.starTimesTarget}x the target gives every row +${CHAIN_SCENE_NUMBERS.forgottenCombo} starting combo. Go past ${CHAIN_SCENE_NUMBERS.starTimesTarget}x in a round and she leaves, taking all that combo with her.`,
  },
  future: {
    short: msg`3 cards sharing a trait make a hand.`,
    text: msg`3 cards in a row that share a trait make a hand, and its links trigger 3 times. Every hand after the first gives the row x${CHAIN_SCENE_NUMBERS.handRowMultiplier}.`,
  },
  ascension: {
    short: msg`Rows of only 7K cards get a multiplier.`,
    text: msg`A row of only 7K cards scores x${CHAIN_SCENE_NUMBERS.ascendStart}, and that goes up x${CHAIN_SCENE_NUMBERS.ascendGrowth} every time it triggers. If you'd fail a round, she burns instead and you replay the round.`,
  },
  aiae: {
    short: msg`A row of 6 with no breaks scores x3.`,
    text: msg`A full row of ${CHAIN_SCENE_NUMBERS.aiaeCards} cards with no breaks scores x${CHAIN_SCENE_NUMBERS.aiaeMultiplier}.`,
  },
  scatteredFaith: {
    short: msg`Breaks only halve your combo.`,
    text: msg`A break halves your combo instead of resetting it, and every break gives the row x${CHAIN_SCENE_NUMBERS.scatteredBreakMultiplier}.`,
  },
  foolMoon: {
    short: msg`Your lowest card fits anywhere.`,
    text: msg`The card with the lowest base in a row matches every trait of the cards next to it.`,
  },
  moonGate: {
    short: msg`Short rows score x3.`,
    text: msg`Rows of ${CHAIN_SCENE_NUMBERS.moonGateCards} cards or less score x${CHAIN_SCENE_NUMBERS.moonGateMultiplier}.`,
  },
  lostRequiem: {
    short: msg`Recycling raises every base.`,
    text: msg`Every card you recycle or remove while you hold her gives all your cards +${CHAIN_SCENE_NUMBERS.requiemBase} base for the rest of the run.`,
  },
  purplePalace: {
    short: msg`Rows of all different rarities score x3.5.`,
    text: msg`A row where every card is a different rarity scores x${CHAIN_SCENE_NUMBERS.palaceMultiplier}.`,
  },
  galaxy: {
    short: msg`Grows with every clean row.`,
    text: msg`Every row with no breaks adds x${CHAIN_SCENE_NUMBERS.galaxyStep} to her for the rest of the run, and she multiplies every row.`,
  },
  sidetracked: {
    short: msg`Every row makes the next ones stronger.`,
    text: msg`Every row you play makes the rows after it score x${CHAIN_SCENE_NUMBERS.sidetrackedGrowth} more. It stacks for the rest of the run.`,
  },
  freedomDive: {
    short: msg`Strong links make cards play twice.`,
    text: msg`If the link into a card shares ${CHAIN_SCENE_NUMBERS.freedomTraits} or more traits, the card plays twice.`,
  },
  blueZenith: {
    short: msg`A row's first 4-trait link doubles your combo.`,
    text: msg`The first link in a row that shares all 4 traits doubles your combo.`,
  },
  halcyon: {
    short: msg`Your combo carries between rows.`,
    text: msg`Each row starts with the combo the last row ended on. A break still resets it.`,
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
  galaxy: "#a98bff",
  sidetracked: "#ff9f5a",
  freedomDive: "#5fd4ff",
  blueZenith: "#7aa8ff",
  halcyon: "#f5d76e",
};

const REFUSALS: Record<string, MessageDescriptor> = {
  no_shards: msg`Not enough shards.`,
  spun: msg`Already spun this visit.`,
  sold: msg`Already bought.`,
  slots_full: msg`No free slot for that.`,
  deck_too_small: msg`Your deck can't go below 4 cards.`,
  no_redraws: msg`No redraws left this round.`,
  no_rows: msg`No rows left this round.`,
  pool_unavailable: msg`Cards can't be dealt right now. Try again in a moment.`,
  no_target: msg`GOATs can't take mods.`,
  no_revive: msg`This run already used its revive.`,
  eternal: msg`An Eternal never leaves.`,
  daily_done: msg`You've played today's daily run. A new one starts at midnight UTC.`,
};

/* The shop's contracts: a name and the rule, short. */
export const CHAIN_CONTRACT_COPY: Record<ChainContractId, { name: MessageDescriptor; rule: MessageDescriptor }> = {
  quick: { name: msg`Quick clear`, rule: msg`Clear in ${CHAIN_CONTRACTS.quickRows} rows or fewer.` },
  oneShot: { name: msg`One shot`, rule: msg`Clear with your first row.` },
  clean: { name: msg`Clean`, rule: msg`No breaks in any row.` },
  overkill: { name: msg`Overkill`, rule: msg`Finish at ${CHAIN_CONTRACTS.overkill}x the target or more.` },
  noRedraw: { name: msg`No redraws`, rule: msg`Clear without redrawing.` },
  fullHouse: { name: msg`Full house`, rule: msg`Every row you play has 6 cards.` },
  perfect: { name: msg`Perfect chain`, rule: msg`Play a 6-card row with no breaks.` },
  oneFlag: { name: msg`One flag`, rule: msg`Play a row of ${CHAIN_CONTRACTS.flagCards} or more cards from one country.` },
  shortRows: { name: msg`Short rows`, rule: msg`Every row you play has ${CHAIN_CONTRACTS.shortRowMax} cards or fewer.` },
  fourTraits: { name: msg`Four traits`, rule: msg`Link two cards that share ${CHAIN_CONTRACTS.linkTraits} traits.` },
};

/* The signed contract mid-round: how it reads now. "met" when it would pay
   if the round cleared this moment, "lost" once it cannot. */
export function chainContractState(
  id: ChainContractId,
  track: ChainContractTrack,
  roundScore: number,
  target: number,
): { state: "on" | "met" | "lost"; progress: string | null } {
  const lost = chainContractBroken(id, track);
  const progress =
    id === "quick"
      ? `${track.rows}/${CHAIN_CONTRACTS.quickRows}`
      : id === "overkill"
        ? `${Math.floor((roundScore / Math.max(1, target)) * 10) / 10}x/${CHAIN_CONTRACTS.overkill}x`
        : null;
  if (lost && !(id === "quick" && track.rows === CHAIN_CONTRACTS.quickRows)) return { state: "lost", progress };
  if (id === "perfect" || id === "overkill" || id === "oneFlag" || id === "fourTraits") return { state: chainContractMet(id, track, roundScore, target) ? "met" : "on", progress };
  return { state: "on", progress };
}

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

export function chainOfferName(offer: { kind: string; cc?: string; skill?: string; key?: number; chartName?: string }, i18n: I18n): string {
  switch (offer.kind) {
    case "chart": {
      const name = offer.chartName ?? "";
      return i18n._(msg`${name} pack`);
    }
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

/* A score as the table shows it: digits, or e-notation once huge (the
   engine's text, so a 727 shows exactly where the engine flags one). */
export function formatChainScore(value: number): string {
  return chainScoreText(value);
}

/* The number a card face shows: its base (an Eternal's doubled) plus what it
   grew, short enough for the face (48K, 3.1M, then e-notation). */
export function chainCardBaseText(card: Pick<ChainCard, "base" | "grown" | "eternal" | "doubled">): string {
  const value = chainEternalBase(card) + (card.grown ?? 0);
  if (value < 10_000) return String(value);
  if (value >= 1e15) {
    const [mantissa, exponent] = value.toExponential(1).split("e");
    return `${mantissa}e${Number(exponent)}`;
  }
  const units: Array<[number, string]> = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  const [size, unit] = units.find(([size]) => value >= size)!;
  const short = value / size;
  return `${short >= 100 ? Math.floor(short) : Math.floor(short * 10) / 10}${unit}`;
}

/* The shop's practice, as its tile says it. */
export function chainPracticeText(trait: ChainTrait, i18n: I18n): string {
  const word = i18n._(CHAIN_TRAIT_WORD[trait]);
  return i18n._(msg`${word} links add +1 more each time they trigger.`);
}

export function formatChainX(value: number): string {
  return (Math.round(value * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
}
