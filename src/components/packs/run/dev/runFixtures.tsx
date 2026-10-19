/* Dev-only fixture harness for the run table. Loaded from packs.tsx behind
   `import.meta.env.DEV` with a dynamic import, so production builds drop it.

   `/packs?view=run&runFixture=<moment>` renders the table from the data
   below (no login, no backend, no charge spent) and plays one moment:

     table    the table at rest with the last pack's hand
     opening  the pack tears, the hand deals and turns over
     scoring  a dealt hand scores
     slam     the same, landing straight on the total
     tally    a pack that clears the song, and its tally up to the Shop button
     shop     the shop in the play area
     win      the final pack of stage 8 clears the run: tally, then the run end
     loss     the last pack of a final song falls short: the run end

   <html data-run-moment> reads "<moment>:ready" once the moment's sequence
   starts and "<moment>:done" once it has settled; the gauntlet's screenshot
   script (local-notes/pack-run-gauntlet/shoot.mjs) waits on those. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LivePackRunBoardEntry } from "#/lib/live-backend";
import type { ManiaCardTier, ManiaSkills } from "#/lib/maniacard";
import {
  applyPack,
  applyShopAction,
  blindTarget,
  freshProgress,
  newRun,
  RUNGS,
  scorePack,
  unlocksFor,
  type BlindId,
  type BossId,
  type PackRunOpenPayload,
  type PackRunState,
  type PackRunView,
  type RunCardInput,
  type RunCharm,
  type RunEdition,
  type RunStats,
  type ShopAction,
} from "#/lib/pack-run";
import { PACK_TYPES, type PackPlayer, type PackTypeId } from "#/lib/packs";
import { getCachedPackFrontCanvas, PACK_ASPECT, packArtStyleFor } from "../../packArt";
import { renderCardThumbnail } from "../../cardSnapshot";
import { COLLECTION_CARD_THUMB_WIDTH } from "../../cardThumbnailCache";
import { buildManiaCardRenderDataFromSkills } from "../../../player/maniacard3d/renderData";
import type { PackCardState, RevealedCard } from "../../RevealStage";
import type { RunPreparedCard } from "../RunCard";
import { RunTable, type RunOpenResult, type RunTablePhase, type RunTableScript } from "../RunTable";

export const RUN_FIXTURE_MOMENTS = ["table", "opening", "scoring", "slam", "tally", "shop", "win", "loss"] as const;
export type RunFixtureMoment = (typeof RUN_FIXTURE_MOMENTS)[number];

const OWN_COUNTRY = "CR";

interface FixturePlayer {
  id: number;
  username: string;
  country: string;
  tier: ManiaCardTier;
  keyMode: 4 | 7;
  rank: number;
  pp: number;
  edition?: RunEdition;
  isNew?: boolean;
}

/* Real-looking, generic players. The ids are only used for avatars, which
   fall back to osu!'s default portrait for an id with none. */
const PLAYERS: FixturePlayer[] = [
  { id: 4650315, username: "Lunarkeys", country: "KR", tier: "rare", keyMode: 4, rank: 1840, pp: 9120 },
  { id: 7562902, username: "tapwave", country: "KR", tier: "elite", keyMode: 4, rank: 912, pp: 10480, edition: "holo" },
  { id: 9269034, username: "Mizunoya", country: "JP", tier: "common", keyMode: 7, rank: 5210, pp: 6120, isNew: true },
  { id: 5414370, username: "stairwell", country: "US", tier: "superRare", keyMode: 4, rank: 402, pp: 12210 },
  { id: 10760216, username: "Quadjack", country: OWN_COUNTRY, tier: "ultraRare", keyMode: 4, rank: 188, pp: 13650, edition: "foil" },
  { id: 3533958, username: "Pelican_", country: "BR", tier: "rare", keyMode: 4, rank: 2210, pp: 8710 },
  { id: 8301957, username: "noodlejam", country: "DE", tier: "common", keyMode: 7, rank: 7710, pp: 5480, isNew: true },
  { id: 6447454, username: "Hanabira", country: "JP", tier: "legendary", keyMode: 4, rank: 64, pp: 15240, edition: "polychrome" },
  { id: 11367222, username: "rollfinger", country: "BR", tier: "elite", keyMode: 4, rank: 1130, pp: 9860 },
  { id: 2558286, username: "Kestrel", country: "US", tier: "mythic", keyMode: 4, rank: 21, pp: 17320 },
];

const STAT_BY_TIER: Partial<Record<ManiaCardTier, number>> = {
  common: 38,
  rare: 47,
  elite: 55,
  superRare: 62,
  ultraRare: 69,
  legendary: 76,
  mythic: 83,
};

function packPlayer(fixture: FixturePlayer): PackPlayer {
  return {
    user: {
      id: fixture.id,
      username: fixture.username,
      avatar_url: `https://a.ppy.sh/${fixture.id}`,
      country_code: fixture.country,
      statistics: { global_rank: fixture.rank, pp: fixture.pp },
    },
    globalRank: fixture.rank,
    pp: fixture.pp,
    ...(fixture.edition ? { edition: fixture.edition } : {}),
  };
}

function skillsOf(fixture: FixturePlayer, index: number): ManiaSkills {
  const base = STAT_BY_TIER[fixture.tier] ?? 50;
  const wobble = (n: number) => base + ((index * 7 + n * 13) % 11) - 5;
  return {
    starAvg: 3.2 + base / 20,
    fingerControl: wobble(1),
    speed: wobble(2),
    accuracy: wobble(3),
    stamina: wobble(4),
    versatility: wobble(5),
    peak: wobble(6),
    polish: wobble(7),
    apex: wobble(8),
    cardPower: base,
    mainKeyMode: fixture.keyMode,
    archetype: `${fixture.keyMode}K`,
    sampleSize: 50,
  };
}

function cardInput(fixture: FixturePlayer): RunCardInput {
  return {
    key: String(fixture.id),
    tier: fixture.tier,
    country: fixture.country,
    keyMode: fixture.keyMode,
    globalRank: fixture.rank,
    isNew: Boolean(fixture.isNew),
    mastery: 1,
    goat: false,
    eternal: false,
    team: false,
    firstFind: false,
    chained: false,
    edition: fixture.edition ?? null,
  };
}

/* Deterministic, so every shot of a moment shows the same run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DISTINCT = 2_740;
const UNLOCKS = unlocksFor(DISTINCT);

function viewOf(state: PackRunState): PackRunView {
  return {
    state,
    unlocks: UNLOCKS,
    distinct: DISTINCT,
    rungs: RUNGS.map((rung) => ({ at: rung.at, unlock: rung.unlock, reached: DISTINCT >= rung.at })),
    masterSets: { foil: 41, holo: 17, polychrome: 0 },
    poolTotal: 6_320,
  };
}

const DEFAULT_CHARMS: RunCharm[] = [
  { uid: 1, id: "duet", paid: 22 },
  { uid: 2, id: "grassroots", paid: 22 },
  { uid: 3, id: "snowball", value: 6, paid: 40 },
  { uid: 4, id: "underdog", paid: 55 },
];

/* A run mid-stage: stage 3, the second song, four charms held. */
function runAt(
  ante: number,
  blind: BlindId,
  boss: BossId,
  score: number,
  packsLeft: number,
  extra: { charms?: RunCharm[]; stats?: Partial<RunStats> } = {},
): PackRunState {
  const progress = { ...freshProgress(), xp: 340, level: 6, runsPlayed: 6, runsWon: 0, bestAnte: 4, bestHand: 1_380, distinct: DISTINCT };
  const base = newRun(progress, 7, seeded(7), UNLOCKS);
  return {
    ...base,
    blind: { ante, blind, boss, target: blindTarget(ante, blind, blind === "boss" ? boss : null), score, packsLeft, handTypes: ["pair"] },
    charms: extra.charms ?? DEFAULT_CHARMS,
    nextUid: 5,
    newCards: 9,
    packs: 22,
    bestHand: 1_380,
    ...(extra.stats ? { stats: { ...base.stats, ...extra.stats } } : {}),
  };
}

/* The run so far at the end screens, as the engine would have counted it. */
const WIN_STATS: Partial<RunStats> = {
  packsOpened: 33,
  bestPack: { total: 9_840, handType: "fullHouse" },
  charmsBought: 9,
  charmsSold: 4,
  songsCleared: 23,
  modsBeaten: ["fog", "club", "wall", "eye", "flint", "window", "needle"],
  shardsEarned: 268,
  rerolls: 6,
  finishes: { foil: 5, holo: 3, polychrome: 1 },
};
const LOSS_STATS: Partial<RunStats> = {
  packsOpened: 15,
  bestPack: { total: 2_310, handType: "threeOfAKind" },
  charmsBought: 5,
  charmsSold: 1,
  songsCleared: 11,
  modsBeaten: ["fog", "club", "eye"],
  shardsEarned: 96,
  rerolls: 3,
  finishes: { foil: 2, holo: 1, polychrome: 0 },
};
const TALLY_CHARMS: RunCharm[] = [
  { uid: 1, id: "duet", paid: 22 },
  { uid: 2, id: "allowance", paid: 22 },
  { uid: 3, id: "snowball", value: 6, paid: 40 },
  { uid: 4, id: "underdog", paid: 55 },
];

/* One scored pack against `state`, the way the server answers a run open. */
function openOn(state: PackRunState, hand: FixturePlayer[]): PackRunOpenPayload {
  const { state: after, outcome } = applyPack(
    state,
    hand.map(cardInput),
    { ownCountry: OWN_COUNTRY, collectorLevel: state.progress.level },
    UNLOCKS,
    seeded(11),
    Date.UTC(2026, 9, 14),
  );
  return {
    editions: hand.map((player) => player.edition ?? null),
    wrapper: "plain",
    outcome,
    rungsCrossed: [],
    view: viewOf(after),
  };
}

function totalOf(state: PackRunState, hand: FixturePlayer[]): number {
  return scorePack(state, hand.map(cardInput), { ownCountry: OWN_COUNTRY, collectorLevel: state.progress.level }, seeded(11)).score.total;
}

interface Scenario {
  /* The run before the preset pack, shown until the pack plays; the page
     applies the draw's view the same way, once the pack is opened. */
  before?: PackRunView;
  view: PackRunView;
  shards: number;
  script: RunTableScript;
}

const REST_HAND = PLAYERS.slice(0, 5);
const OPEN_HAND = PLAYERS.slice(5, 10);

function scenarioFor(moment: RunFixtureMoment, hands: Map<number, RevealedCard>): Scenario {
  const revealed = (players: FixturePlayer[]) => players.map((player) => hands.get(player.id)!).filter(Boolean);
  const shards = 186;
  if (moment === "scoring" || moment === "slam" || moment === "tally") {
    const extra = moment === "tally" ? { charms: TALLY_CHARMS } : {};
    const probe = runAt(3, "big", "wall", 0, 3, extra);
    const total = totalOf(probe, OPEN_HAND);
    const target = probe.blind.target;
    // Short of the target for scoring and slam; over it for the tally, on
    // the song's second pack so two are left over.
    const score = moment === "tally" ? Math.max(0, target - Math.floor(total * 0.6)) : Math.max(0, Math.min(420, target - total - 60));
    const before = runAt(3, "big", "wall", score, 3, extra);
    const run = openOn(before, OPEN_HAND);
    return {
      before: viewOf(before),
      view: run.view,
      shards: shards + run.outcome.shards,
      script: { preset: { hand: revealed(OPEN_HAND), run, skipToTotal: moment === "slam" } },
    };
  }
  if (moment === "win") {
    const probe = runAt(8, "boss", "tooth", 0, 1, { stats: WIN_STATS });
    const total = totalOf(probe, OPEN_HAND);
    const before = runAt(8, "boss", "tooth", Math.max(0, probe.blind.target - Math.floor(total * 0.5)), 1, { stats: WIN_STATS });
    const run = openOn(before, OPEN_HAND);
    return { before: viewOf(before), view: run.view, shards: shards + run.outcome.shards, script: { preset: { hand: revealed(OPEN_HAND), run } } };
  }
  if (moment === "loss") {
    const before = runAt(4, "boss", "wall", 0, 1, { stats: LOSS_STATS });
    const run = openOn(before, OPEN_HAND);
    return { before: viewOf(before), view: run.view, shards, script: { preset: { hand: revealed(OPEN_HAND), run } } };
  }
  const view = viewOf(runAt(3, "big", "wall", 420, 3));
  // One slot free so the shop's buy lands instead of being refused.
  if (moment === "shop") {
    const shopView = viewOf(runAt(3, "big", "wall", 420, 3, { charms: DEFAULT_CHARMS.slice(0, 3) }));
    return { view: shopView, shards, script: { startInShop: true, restHand: revealed(REST_HAND) } };
  }
  if (moment === "opening") return { view, shards, script: { autoOpen: true, restHand: revealed(REST_HAND) } };
  return { view, shards, script: { restHand: revealed(REST_HAND) } };
}

async function renderFixtureCard(player: FixturePlayer, index: number): Promise<RevealedCard> {
  const data = buildManiaCardRenderDataFromSkills({ user: packPlayer(player).user, skills: skillsOf(player, index), tierOverride: player.tier });
  let thumbnail: string | null = null;
  try {
    thumbnail = await Promise.race([
      renderCardThumbnail(data, COLLECTION_CARD_THUMB_WIDTH),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 6000)),
    ]);
  } catch {
    thumbnail = null;
  }
  return {
    player: packPlayer(player),
    tier: data.tier,
    tierLabel: data.tierStyle.label,
    glowColor: data.glowColor,
    thumbnail,
    skills: data.skills,
    isNew: Boolean(player.isNew),
  };
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

const BOARD: LivePackRunBoardEntry[] = [
  { userId: 1, username: "Hanabira", bestAnte: 8, bestHand: 48_210, runsWon: 2, level: 31 },
  { userId: 2, username: "stairwell", bestAnte: 6, bestHand: 12_940, runsWon: 0, level: 19 },
  { userId: 3, username: "tapwave", bestAnte: 5, bestHand: 7_310, runsWon: 0, level: 14 },
];

function markMoment(moment: string, state: "ready" | "done") {
  document.documentElement.dataset.runMoment = `${moment}:${state}`;
}

export default function RunFixtureHost({ moment: rawMoment, reducedMotion }: { moment: string; reducedMotion: boolean }) {
  const moment: RunFixtureMoment = (RUN_FIXTURE_MOMENTS as readonly string[]).includes(rawMoment)
    ? (rawMoment as RunFixtureMoment)
    : "table";
  const [cards, setCards] = useState<Map<number, RevealedCard> | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [view, setView] = useState<PackRunView | null>(null);
  const [shards, setShards] = useState(0);
  const [busy, setBusy] = useState(false);
  const [packThumb, setPackThumb] = useState<string | null>(null);
  const readyRef = useRef(false);
  const doneRef = useRef(false);

  useEffect(() => {
    delete document.documentElement.dataset.runMoment;
    let cancelled = false;
    setPackThumb(packThumbFor("standard"));
    void (async () => {
      const faces = await Promise.all(PLAYERS.map((player, index) => renderFixtureCard(player, index)));
      if (cancelled) return;
      const rendered = new Map(faces.map((face) => [face.player.user.id, face] as const));
      const next = scenarioFor(moment, rendered);
      setCards(rendered);
      setScenario(next);
      setView(next.before ?? next.view);
      setShards(next.shards);
    })();
    return () => {
      cancelled = true;
    };
  }, [moment]);

  const ready = useCallback(() => {
    if (readyRef.current) return;
    readyRef.current = true;
    markMoment(moment, "ready");
  }, [moment]);
  const done = useCallback(() => {
    if (doneRef.current || !readyRef.current) return;
    doneRef.current = true;
    markMoment(moment, "done");
  }, [moment]);

  /* Moments with no sequence: ready on the first frame, done after a second
     of idle sway. */
  useEffect(() => {
    if (!scenario || moment !== "table") return;
    const frame = window.requestAnimationFrame(ready);
    const timer = window.setTimeout(done, 1200);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [done, moment, ready, scenario]);

  /* shop: plays a reroll, a buy and a sell so the strip catches each beat. */
  useEffect(() => {
    if (!scenario || moment !== "shop") return;
    const frame = window.requestAnimationFrame(ready);
    const byName = (prefix: string) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
        (button.getAttribute("aria-label") ?? button.textContent ?? "").trim().startsWith(prefix),
      );
    const tap = (element: Element | null | undefined) => {
      if (!element) return;
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, isPrimary: true }));
      (element as HTMLElement).click?.();
    };
    const timers = [
      window.setTimeout(() => byName("Reroll")?.click(), 1400),
      window.setTimeout(() => byName("Buy")?.click(), 2800),
      window.setTimeout(() => tap(document.querySelector('[aria-label^="Charm 1 of"]')), 4400),
      window.setTimeout(() => byName("Sell")?.click(), 4900),
      window.setTimeout(done, 6200),
    ];
    return () => {
      window.cancelAnimationFrame(frame);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [done, moment, ready, scenario]);

  const scenarioRef = useRef<Scenario | null>(null);
  scenarioRef.current = scenario;
  const onPhase = useCallback(
    (phase: RunTablePhase) => {
      const current = scenarioRef.current;
      if (phase === "scoring" && current?.before) setView(current.view);
      if (moment === "opening") {
        if (phase === "opening") ready();
        else if (phase === "rest" && readyRef.current) window.setTimeout(done, 400);
      } else if (moment === "tally" || moment === "win" || moment === "loss") {
        // Done comes from the tally and end screens themselves (below).
        if (phase === "scoring") ready();
      } else if (moment !== "table" && moment !== "shop") {
        if (phase === "scoring") ready();
        else if (phase === "rest" && readyRef.current) window.setTimeout(done, 700);
        // A scoring fixture that clears its song hands over to the tally.
        else if (phase === "tally" && readyRef.current) window.setTimeout(done, 300);
      }
    },
    [done, moment, ready],
  );

  /* tally: done once the tally has settled on its Shop button. win: the
     tally settles, Continue is pressed, done once the run end has settled.
     loss: done once the run end has settled. */
  useEffect(() => {
    if (!scenario || (moment !== "tally" && moment !== "win" && moment !== "loss")) return;
    let pressed = false;
    const timer = window.setInterval(() => {
      if (!readyRef.current) return;
      if (moment === "tally") {
        if (document.querySelector('[data-run-tally="settled"]')) window.setTimeout(done, 500);
        return;
      }
      if (moment === "win" && !pressed) {
        const button = document.querySelector<HTMLButtonElement>("[data-run-tally-continue]");
        if (button) {
          pressed = true;
          window.setTimeout(() => button.click(), 700);
        }
      }
      if (document.querySelector('[data-run-end="settled"]')) window.setTimeout(done, 400);
    }, 100);
    return () => window.clearInterval(timer);
  }, [done, moment, scenario]);

  const script = useMemo<RunTableScript | null>(() => (scenario ? { ...scenario.script, onPhase } : null), [scenario, onPhase]);

  const act = useCallback(
    async (action: ShopAction): Promise<string | null> => {
      if (!view) return "failed";
      setBusy(true);
      await new Promise((resolve) => window.setTimeout(resolve, 160));
      setBusy(false);
      const result = applyShopAction(view.state, action, UNLOCKS, seeded(Date.now() % 100_000), shards);
      if (!result.ok) return result.error;
      setView(viewOf(result.state));
      setShards((value) => value + result.shardDelta);
      return null;
    },
    [shards, view],
  );

  const openPack = useCallback(async (): Promise<RunOpenResult> => {
    await new Promise((resolve) => window.setTimeout(resolve, 280));
    return {
      kind: "dealt",
      cards: OPEN_HAND.map((player) => ({ player: packPlayer(player), scoresPromise: Promise.resolve([]) })),
      run: null,
    };
  }, []);

  const prepareCard = useCallback(
    async (card: PackCardState): Promise<RunPreparedCard> => {
      const entry = cards?.get(card.player.user.id);
      return {
        entry: {
          player: card.player,
          tier: entry?.tier ?? null,
          tierLabel: entry?.tierLabel ?? null,
          glowColor: entry?.glowColor ?? null,
          thumbnail: entry?.thumbnail ?? null,
        },
        skills: entry?.skills ?? null,
      };
    },
    [cards],
  );

  const loadBoard = useCallback(async () => BOARD, []);

  if (!view || !script) return <div className="fixed inset-x-0 bottom-0 top-[60px] z-40 bg-osu-b6" />;
  const standard = PACK_TYPES[0];
  return (
    <RunTable
      view={view}
      busy={busy}
      act={act}
      shards={shards}
      charges={3}
      maxCharges={5}
      nextChargeMs={null}
      packType={standard}
      packThumb={packThumb}
      packChoices={[{ id: standard.id, canOpen: true }]}
      onSelectPackType={() => {}}
      canOpen
      reducedMotion={reducedMotion}
      openPack={openPack}
      onCardRevealed={(pull) => Boolean(PLAYERS.find((player) => player.id === pull.userId)?.isNew)}
      onComplete={() => {}}
      onExit={() => {
        window.location.href = "/packs";
      }}
      prepareCard={prepareCard}
      loadBoard={loadBoard}
      script={script}
    />
  );
}
