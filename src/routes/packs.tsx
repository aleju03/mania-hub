import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpDown, Recycle } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { PageHeader } from "../components/layout/PageHeader";
import { AlbumView } from "../components/packs/album/AlbumView";
import { CollectionPanel } from "../components/packs/CollectionPanel";
import { GoatHoldersButton } from "../components/packs/GoatHoldersButton";
import {
  getCachedCardBackDataUrl,
  getCachedPackFrontCanvas,
  PACK_ASPECT,
} from "../components/packs/packArt";
import { PackStage } from "../components/packs/PackStage";
import { StreakGame } from "../components/packs/StreakGame";
import { PackSummary } from "../components/packs/PackSummary";
import {
  RevealStage,
  type FlightRect,
  type PackCardState,
  type RevealedCard,
} from "../components/packs/RevealStage";
import { ShuffleStage } from "../components/packs/ShuffleStage";
import { usePackWallet } from "../components/packs/usePackWallet";
import { useAuth } from "../lib/auth-context";
import { canUseAdminFeatures } from "../lib/auth-shared";
import {
  MAX_PACK_CHARGES,
  msUntilNextCharge,
  ownedCards,
  PACK_OPEN_SHARD_REWARD,
  parsePackCardKey,
  type PackWallet,
} from "../lib/pack-collection";
import { fetchLivePackDuel, isLiveBackendConfigured, warmLivePackPlayers, type LivePackDuel } from "../lib/live-backend";
import {
  clearPendingPack,
  consumePendingPackCard,
  readPendingPack,
  writePendingPack,
} from "../lib/pack-pending";
import { fetchServerPackCollectionOwnedKeys, recordServerPackPulls } from "../lib/pack-wallet-sync";
import { duelCardsFromRevealed } from "../components/packs/duelMint";
import { createPackDuel, duelErrorMessage, joinPackDuel } from "../lib/pack-duels";
import { PackPulse, refreshPackPulseFeed } from "../components/packs/PackPulse";
import {
  drawPackPlayers,
  PACK_TYPES,
  packTypeById,
  prefetchPackPlayerScores,
  type PackPlayer,
  type PackTypeDef,
  type PackTypeId,
} from "../lib/packs";
import { pageSeo } from "../lib/seo";
import { track } from "../lib/analytics";

export const Route = createFileRoute("/packs")({
  validateSearch: (search: Record<string, unknown>): { view?: "album" | "streak"; duel?: string } => {
    const view = search.view === "album" || search.view === "streak" ? search.view : undefined;
    // Answering a duel is opening a pack, so the duel travels as a search
    // param and the summary hands the pulled cards straight to it.
    const duel =
      typeof search.duel === "string" && /^[a-z0-9]{6,16}$/.test(search.duel) ? search.duel : undefined;
    return { ...(view ? { view } : {}), ...(duel ? { duel } : {}) };
  },
  head: ({ match }) => pageSeo({
    title: "Card Packs",
    description: "Tear open booster packs of maniacards: random osu!mania players minted as collectible cards with skill stats and rarity tiers.",
    path: "/packs",
    origin: match.context.origin,
    imageKind: "packs",
  }),
  component: PacksPage,
});

type PackPhase = "pack" | "reveal" | "summary";

/* Both collection panels are heavy; memo keeps the wallet countdown ticks
   and the Grid/Album swap (a wrapper-class flip) from re-rendering them.
   usePackWallet's action callbacks are identity-stable for this. */
const MemoAlbumView = memo(AlbumView);
const MemoCollectionPanel = memo(CollectionPanel);

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

type IdleDeadlineLike = {
  didTimeout: boolean;
  timeRemaining: () => number;
};

type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (
    callback: (deadline: IdleDeadlineLike) => void,
    options?: { timeout?: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function scheduleCollectionPanelMount(callback: () => void, reducedMotion: boolean) {
  if (typeof window === "undefined") {
    callback();
    return () => {};
  }

  const idleWindow = window as WindowWithIdleCallback;
  let active = true;
  let timeoutId: number | null = null;
  let idleId: number | null = null;

  timeoutId = window.setTimeout(() => {
    timeoutId = null;
    if (!active) return;

    if (idleWindow.requestIdleCallback) {
      idleId = idleWindow.requestIdleCallback(() => {
        idleId = null;
        if (active) callback();
      }, { timeout: 900 });
      return;
    }

    callback();
  }, reducedMotion ? 80 : 380);

  return () => {
    active = false;
    if (timeoutId !== null) window.clearTimeout(timeoutId);
    if (idleId !== null) idleWindow.cancelIdleCallback?.(idleId);
  };
}

/* Probes every player's local snapshot immediately, then sends only genuine
   cache misses through the small osu! concurrency bound. That lets a hot card
   near the end of a ten-card hand become ready even when four earlier players
   are cold. A resolved null = the fetch failed (network, rate limit), as
   opposed to a player with genuinely no ranked plays; the reveal retries it. */
function buildCardStates(players: PackPlayer[]): PackCardState[] {
  const scoresPromises = prefetchPackPlayerScores(players.map((player) => player.user.id));
  return players.map((player, index) => ({
    player,
    scoresPromise: scoresPromises[index] ?? Promise.resolve(null),
  }));
}

/* Dev only: `/packs?forceGoat=1` pins the honorary slot so the GOAT reveal can
   be reviewed on demand instead of waiting out a 0.25-3% roll. Vite strips the
   DEV branch from production builds, so this can't mint a card on the live
   site; the search param is deliberately not part of the route's schema. */
function devForceGoatPull(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("forceGoat");
}

function canAffordPack(wallet: PackWallet | null, type: PackTypeDef): boolean {
  if (!wallet) return false;
  if (type.cost.kind === "charge") return wallet.charges > 0;
  return wallet.shards >= type.cost.amount;
}

/* Two different questions, so two different sets.

   `ownedUserIds` drives the ranked pool's "new cards first": holding any card
   of a player means the pool should deal someone else. `ownedGoatUserIds`
   drives the honorary slot, where holding a player's ordinary card is not
   holding their GOAT - those are separate cards, so a World Class bojii must
   not make the roster's one GOAT bojii count as already collected. */
async function getDuplicateProtectionOwned(
  type: PackTypeDef,
  wallet: PackWallet | null,
  syncStatus: "local" | "syncing" | "synced",
): Promise<{ ownedUserIds: Set<number>; ownedGoatUserIds: Set<number> } | undefined> {
  if (!type.guaranteesNew || !wallet) return undefined;
  const ownedUserIds = new Set<number>();
  const ownedGoatUserIds = new Set<number>();
  for (const card of ownedCards(wallet)) {
    ownedUserIds.add(card.userId);
    if (card.tier === "goat") ownedGoatUserIds.add(card.userId);
  }
  if (syncStatus === "local") return { ownedUserIds, ownedGoatUserIds };

  const serverOwnedKeys = await fetchServerPackCollectionOwnedKeys();
  if (!serverOwnedKeys) throw new Error("Synced collection is unavailable.");
  for (const key of serverOwnedKeys) {
    const parsed = parsePackCardKey(key);
    if (!parsed) continue;
    ownedUserIds.add(parsed.userId);
    if (parsed.goat) ownedGoatUserIds.add(parsed.userId);
  }
  return { ownedUserIds, ownedGoatUserIds };
}

/* Thumbnail renders of each pack type's foil art, generated once per session
   and kept across route visits. Each full-size foil draw costs ~20ms, so the
   types render in separate idle tasks instead of competing with the 3D pack's
   setup or interaction frames. */
const packThumbCache = new Map<PackTypeId, string>();

function usePackArtThumbs(): Partial<Record<PackTypeId, string>> {
  const [thumbs, setThumbs] = useState<Partial<Record<PackTypeId, string>>>(() =>
    Object.fromEntries(packThumbCache),
  );
  useEffect(() => {
    const pending = PACK_TYPES.filter((type) => !packThumbCache.has(type.id));
    if (pending.length === 0) return;
    let cancelled = false;
    const idleWindow = window as WindowWithIdleCallback;
    let idleHandle: number | null = null;
    let timeoutHandle: number | null = null;
    const scheduleNext = () => {
      if (idleWindow.requestIdleCallback) {
        idleHandle = idleWindow.requestIdleCallback(renderNext, { timeout: 900 });
      } else {
        timeoutHandle = window.setTimeout(renderNext, 100);
      }
    };
    const renderNext = () => {
      idleHandle = null;
      timeoutHandle = null;
      if (cancelled) return;
      const type = pending.shift();
      if (!type) return;
      const full = getCachedPackFrontCanvas({
        accent: type.accent,
        subtitle: type.artSubtitle,
        cardCount: type.cardCount,
      });
      const small = document.createElement("canvas");
      small.width = 160;
      small.height = Math.round(160 / PACK_ASPECT);
      const context = small.getContext("2d");
      if (context) {
        context.drawImage(full, 0, 0, small.width, small.height);
        const url = small.toDataURL("image/png");
        packThumbCache.set(type.id, url);
        setThumbs((current) => ({ ...current, [type.id]: url }));
      }
      if (pending.length > 0) scheduleNext();
    };
    scheduleNext();
    return () => {
      cancelled = true;
      if (idleHandle !== null) idleWindow.cancelIdleCallback?.(idleHandle);
      if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
    };
  }, []);
  return thumbs;
}

function PackTypeSelector({
  wallet,
  selectedId,
  thumbs,
  onSelect,
}: {
  wallet: PackWallet | null;
  selectedId: PackTypeId;
  thumbs: Partial<Record<PackTypeId, string>>;
  onSelect: (id: PackTypeId) => void;
}) {
  const selectedType = packTypeById(selectedId);
  return (
    <div>
      <div className="flex items-start justify-center gap-3 sm:gap-5">
        {PACK_TYPES.map((type) => {
          const selected = type.id === selectedId;
          const affordable = canAffordPack(wallet, type);
          const accent = `rgb(${type.accent.r}, ${type.accent.g}, ${type.accent.b})`;
          const thumb = thumbs[type.id];
          return (
            <button
              key={type.id}
              type="button"
              onClick={() => {
                if (affordable && !selected) onSelect(type.id);
              }}
              disabled={!affordable && !selected}
              className={`flex w-[76px] flex-col items-center sm:w-[96px] ${
                affordable && !selected ? "cursor-pointer" : ""
              }`}
              aria-pressed={selected}
              title={type.blurb}
            >
              <div
                className={`w-full transition-transform duration-150 ${
                  selected ? "-translate-y-1" : affordable ? "hover:-translate-y-1" : ""
                }`}
                style={{
                  aspectRatio: `${PACK_ASPECT}`,
                  filter: affordable || selected ? undefined : "grayscale(0.85) brightness(0.55)",
                }}
              >
                {thumb ? (
                  <img
                    src={thumb}
                    alt={`${type.name} pack`}
                    className="h-full w-full rounded-[7px]"
                    draggable={false}
                    style={{
                      boxShadow: selected
                        ? `0 0 0 2px ${accent}, 0 10px 28px rgba(0,0,0,0.5)`
                        : "0 6px 18px rgba(0,0,0,0.4)",
                    }}
                  />
                ) : (
                  <div className="h-full w-full rounded-[7px] bg-osu-b4/60" />
                )}
              </div>
              <div
                className="mt-2 text-[11px] font-bold"
                style={{ color: affordable || selected ? accent : "rgba(148,163,184,0.6)" }}
              >
                {type.name}
              </div>
              <div className="text-[10px] text-osu-f1 tabular-nums">
                {type.cost.kind === "charge" ? "free" : `${type.cost.amount} shards`}
              </div>
              <div className="text-[10px] text-osu-f1/70 tabular-nums">{type.cardCount} cards</div>
            </button>
          );
        })}
      </div>
      <div className="mt-4 text-center text-[11px] text-osu-f1">
        {selectedType.blurb}. +{PACK_OPEN_SHARD_REWARD} shards per pack; recycle duplicates for more.
      </div>
    </div>
  );
}

function PacksPage() {
  const reducedMotion = useReducedMotion();
  const auth = useAuth();
  const { view, duel: answeringDuelId } = Route.useSearch();
  const { countryFeatures } = Route.useRouteContext();
  const navigate = useNavigate();
  const walletApi = usePackWallet();
  const packThumbs = usePackArtThumbs();
  const [phase, setPhase] = useState<PackPhase>("pack");
  const [packId, setPackId] = useState(0);
  const [packTypeId, setPackTypeId] = useState<PackTypeId>("standard");
  const [cards, setCards] = useState<PackCardState[] | null>(null);
  const [revealed, setRevealed] = useState<RevealedCard[]>([]);
  /* Reveal-all handoff: the rects every card tile occupied when the reveal
     finished. Non-null means the viewer already saw the whole grid, so the
     summary skips its enter ceremony and flies the cards into place. */
  const [summaryFlyFrom, setSummaryFlyFrom] = useState<Map<number, FlightRect> | null>(null);
  const [dealError, setDealError] = useState(false);
  /* Set by "Open another" on the summary: the next deal skips the pack stage
     and charges itself as soon as it has cards. */
  const autoOpenRef = useRef(false);
  /* Serials for the pack on screen, keyed by wallet card key. Filled in when
     the pull log answers, a beat after the summary appears. */
  const [serials, setSerials] = useState<Map<string, { serial: number; mintedTotal: number }> | null>(null);
  const [duelBusy, setDuelBusy] = useState(false);
  const [duelError, setDuelError] = useState<string | null>(null);
  /* The duel this pack is being opened to answer, if any. Loaded from the
     link so the page knows which pack type to force and who is waiting. */
  const [answering, setAnswering] = useState<LivePackDuel | null>(null);
  const [collectionPanelReady, setCollectionPanelReady] = useState(true);
  const [collectionPanelMounted, setCollectionPanelMounted] = useState(true);
  // Holds the last wallet the visible collection rendered. Spending a pack
  // changes the live wallet, but the hidden panel should not reconcile its
  // large grid/album subtree in the same frame as the opening handoff.
  const collectionWalletRef = useRef<PackWallet | null>(null);
  /* The Grid/Album swap runs on local state so it lands in the click's own
     render; the router navigation (route re-match + full route re-render)
     only trails behind to keep the URL shareable. Waiting on it made the
     tab switch visibly lag. */
  /* The game takes over the page's middle; everything around it (the ticker,
     the wallet strip, the header) stays exactly where it was. */
  const streakOpen = view === "streak";
  const [albumOpen, setAlbumOpen] = useState(view === "album");
  /* Once visited, the album stays mounted (hidden) so switching back keeps
     its shelf, open book, and loaded rosters. */
  const [albumMounted, setAlbumMounted] = useState(view === "album");
  useEffect(() => {
    setAlbumOpen(view === "album");
    if (view === "album") setAlbumMounted(true);
  }, [view]);

  const wallet = walletApi.wallet;
  if (phase === "pack" && wallet) collectionWalletRef.current = wallet;
  /* Identity-stable for the memoized album view. */
  const trackedCountries = useMemo(
    () => countryFeatures?.countries.map((entry) => entry.country) ?? null,
    [countryFeatures],
  );
  const selectedType = packTypeById(packTypeId);
  const charges = wallet?.charges ?? 0;
  const shards = wallet?.shards ?? 0;
  const nextChargeMs = wallet ? msUntilNextCharge(wallet, walletApi.nowMs || Date.now()) : null;

  /* The moment of purchase: one charge or the pack's shard price. False means
     the wallet could not pay (a charge burned on another tab, shards spent
     elsewhere), and the caller keeps the pack unopened. */
  const chargeForPack = (type: PackTypeDef): boolean => {
    if (!walletApi.openPack(type.cost)) return false;
    track("pack_open", {
      pack_type: type.id,
      pack_username: auth.viewer?.username,
    });
    return true;
  };

  // Build and encode the neutral reveal back while the unopened pack is idle.
  // RevealStage can then mount without a synchronous canvas + PNG spike.
  useEffect(() => {
    const idleWindow = window as WindowWithIdleCallback;
    let idleId: number | null = null;
    let timeoutId: number | null = null;
    const warm = () => {
      idleId = null;
      timeoutId = null;
      getCachedCardBackDataUrl();
    };
    if (idleWindow.requestIdleCallback) {
      idleId = idleWindow.requestIdleCallback(warm, { timeout: 700 });
    } else {
      timeoutId = window.setTimeout(warm, 120);
    }
    return () => {
      if (idleId !== null) idleWindow.cancelIdleCallback?.(idleId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, []);

  /* Deal a fresh pack from the tracked pool (uniform odds within the pack
     type's slice), then ask the backend to warm the profile snapshots and
     start prefetching each player's best scores, so the cards are usually
     ready by the time the pack is slashed open. A pack paid for earlier but
     abandoned mid-reveal (navigation, refresh) resumes its unrevealed
     remainder instead: the charge is already spent. */
  useEffect(() => {
    let cancelled = false;
    setCards(null);
    setDealError(false);
    if (packId === 0) {
      const pendingPlayers = readPendingPack();
      if (pendingPlayers) {
        if (isLiveBackendConfigured()) {
          void warmLivePackPlayers(pendingPlayers.map((player) => player.user.id)).catch(() => {});
        }
        setCards(buildCardStates(pendingPlayers));
        setPhase("reveal");
        return;
      }
    }
    const type = packTypeById(packTypeId);
    const currentWallet = walletApi.wallet;
    void (async () => {
      try {
        const owned = await getDuplicateProtectionOwned(type, currentWallet, walletApi.syncStatus);
        const draw = await drawPackPlayers(Math.random, {
          topFraction: type.topFraction,
          count: type.cardCount,
          honoraryChance: devForceGoatPull() ? 1 : type.honoraryChance,
          ownedUserIds: owned?.ownedUserIds,
          ownedGoatUserIds: owned?.ownedGoatUserIds,
        });
        if (cancelled) return;
        walletApi.notePoolTotal(draw.poolTotal);
        if (isLiveBackendConfigured()) {
          void warmLivePackPlayers(draw.players.map((player) => player.user.id)).catch(() => {});
        }
        setCards(buildCardStates(draw.players));
        /* A pack opened straight from the summary pays here rather than at the
           slash, because there is no slash: charging only once the draw
           succeeded keeps a failed deal from eating the price. */
        if (autoOpenRef.current) {
          autoOpenRef.current = false;
          setPhase(chargeForPack(type) ? "reveal" : "pack");
        }
      } catch {
        autoOpenRef.current = false;
        if (!cancelled) setDealError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packId, packTypeId]);

  /* The slash charged the wallet, so from that moment the unrevealed cards
     are owed to the viewer: keep the remainder in localStorage so leaving the
     page resumes the pack instead of eating it. Entries are consumed one by
     one as cards flip into the wallet. */
  useEffect(() => {
    if (phase !== "reveal" || !cards) return;
    writePendingPack(cards.map((card) => card.player));
  }, [phase, cards]);

  useEffect(() => {
    if (phase === "pack") {
      setCollectionPanelReady(true);
      setCollectionPanelMounted(true);
      return;
    }

    setCollectionPanelReady(false);
    if (phase === "reveal") {
      // Hide immediately, then let the browser choose an idle window for the
      // expensive album/grid unmount after the reveal stack has painted.
      return scheduleCollectionPanelMount(() => setCollectionPanelMounted(false), reducedMotion);
    }

    setCollectionPanelMounted(false);
    return scheduleCollectionPanelMount(() => {
      setCollectionPanelMounted(true);
      setCollectionPanelReady(true);
    }, reducedMotion);
  }, [phase, reducedMotion]);

  /* Duelling is an unfinished prototype, so every entry point is admin-only
     for now. The server functions refuse a non-admin caller regardless. The
     higher-or-lower game next to it is deliberately NOT behind this: it is
     open to everyone, signed in or not. */
  const canDuel = canUseAdminFeatures(auth) && Boolean(auth.viewer) && isLiveBackendConfigured();

  useEffect(() => {
    // Gated with the rest of duelling: without this a non-admin following a
    // duel link would be told to open a pack and play it for the stake, and
    // then find no button to do it with.
    if (!answeringDuelId || !canDuel || !isLiveBackendConfigured()) {
      setAnswering(null);
      return;
    }
    let cancelled = false;
    void fetchLivePackDuel(answeringDuelId)
      .then((duel) => {
        if (cancelled) return;
        // Already answered: nothing here to match, so it reads as an ordinary
        // visit to the packs page rather than a broken banner.
        setAnswering(duel.opponent.userId ? null : duel);
      })
      .catch(() => {
        if (!cancelled) setAnswering(null);
      });
    return () => {
      cancelled = true;
    };
  }, [answeringDuelId, canDuel]);

  /* An answer has to match the challenge: same pack type, same size of stake. */
  useEffect(() => {
    if (answering) setPackTypeId(answering.packType as PackTypeId);
  }, [answering]);

  /* Puts the pack that was just opened up against the challenge. The cards are
     already in the collection by now (the wallet push is what put them there),
     which is what the backend checks before it will take the stake. */
  const answerDuel = () => {
    if (!answering || duelBusy) return;
    const cards = duelCardsFromRevealed(revealed);
    if (cards.length === 0) {
      setDuelError("None of these cards minted, so there is nothing to stake.");
      return;
    }
    setDuelBusy(true);
    setDuelError(null);
    void joinPackDuel({ data: { duelId: answering.id, cards } })
      .then((result) => {
        if (result.ok) void navigate({ to: "/duel/$duelId", params: { duelId: answering.id } });
        else setDuelError(duelErrorMessage(result.error));
      })
      .catch(() => setDuelError("Could not answer that duel."))
      .finally(() => setDuelBusy(false));
  };

  /* Freezes the hand just revealed into a duel link. Whoever opens it answers
     with their own pack of the same type, and the two hands play five rounds
     out on the duel page; nothing here touches either collection. */
  const startDuel = () => {
    if (!auth.viewer || duelBusy) return;
    const cards = duelCardsFromRevealed(revealed);
    if (cards.length === 0) {
      setDuelError("None of these cards minted, so there is nothing to duel with.");
      return;
    }
    setDuelBusy(true);
    setDuelError(null);
    void createPackDuel({ data: { packType: selectedType.id, cards } })
      .then((result) => {
        if (result.ok) void navigate({ to: "/duel/$duelId", params: { duelId: result.duel.id } });
        else setDuelError(duelErrorMessage(result.error));
      })
      .catch(() => setDuelError("Could not open that duel."))
      .finally(() => setDuelBusy(false));
  };

  const openAnother = () => {
    setRevealed([]);
    setSummaryFlyFrom(null);
    setSerials(null);
    setDuelError(null);
    autoOpenRef.current = false;
    // Keep the chosen pack type across packs while it stays affordable.
    if (!canAffordPack(walletApi.wallet, packTypeById(packTypeId))) setPackTypeId("standard");
    setPhase("pack");
    setPackId((id) => id + 1);
  };

  /* Straight from the summary into the next pack of the same type: the deal
     starts now and tears itself open once it lands, so the shuffle stands in
     for the pack stage. */
  const openNextPack = () => {
    if (!canAffordPack(walletApi.wallet, selectedType)) return;
    setRevealed([]);
    setSummaryFlyFrom(null);
    setSerials(null);
    setDuelError(null);
    autoOpenRef.current = true;
    setPhase("reveal");
    setPackId((id) => id + 1);
  };

  const handleOpened = () => {
    // The slash is the moment of purchase.
    if (!chargeForPack(selectedType)) {
      setPackTypeId("standard");
      setPackId((id) => id + 1);
      return;
    }
    setPhase("reveal");
  };

  const canOpen = canAffordPack(wallet, selectedType);
  /* The game owns the page's middle while it is open, so the collection does
     not sit under it: the point of hosting it here is the ticker and the
     wallet, not a second screen's worth of grid to scroll past. */
  const showCollectionPanel = !streakOpen && (phase === "pack" || (phase === "summary" && collectionPanelReady));
  const collectionWallet = collectionWalletRef.current;

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col overflow-clip bg-osu-b5">
        <OsuTriangleBackdrop />
        <div className="relative z-10 flex flex-1 flex-col">
          <PageHeader iconSrc="/images/icons/packs.svg" title="Maniacard packs" />
          {/* Ambient side rails: the live pull ticker runs through every
              phase (including the reveal), only the your-card fun fact hides
              while cards are flipping. */}
          <PackPulse viewerId={auth.viewer?.id ?? null} revealing={phase === "reveal"} />

          <div className="mx-auto w-full max-w-[960px] flex-1 px-4 py-8 sm:px-5 sm:py-12">
            {wallet && phase !== "reveal" && (
              <div className="mb-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[12px]">
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1" aria-hidden="true">
                    {Array.from({ length: MAX_PACK_CHARGES }, (_, position) => (
                      <span
                        key={position}
                        className={`h-2 w-2 rounded-full ${position < charges ? "bg-osu-pink" : "bg-osu-b3"}`}
                      />
                    ))}
                  </div>
                  <span className="text-osu-f1 tabular-nums">
                    {charges}/{MAX_PACK_CHARGES} packs
                  </span>
                  {nextChargeMs !== null && (
                    <span className="text-osu-f1 tabular-nums">+1 in {Math.ceil(nextChargeMs / 1000)}s</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-osu-f1">
                  <Recycle className="h-3.5 w-3.5" />
                  <span className="font-semibold text-white tabular-nums">{shards.toLocaleString()}</span>
                  <span>shards</span>
                </div>
                <GoatHoldersButton />
                {/* The solo game, played right here rather than on a page of
                    its own: the pull ticker, the charges and the shard count
                    are half of why the arcade is on the packs page at all. */}
                {/* Toggles: the same chip that opens the game closes it, so
                    the way out is where the way in was. */}
                <Link
                  to="/packs"
                  search={streakOpen ? {} : { view: "streak" }}
                  resetScroll={false}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors ${
                    streakOpen
                      ? "border-osu-pink bg-osu-pink/15 text-white"
                      : "border-osu-b3/40 text-osu-f1 hover:border-osu-pink/50 hover:text-white"
                  }`}
                  aria-pressed={streakOpen}
                >
                  <ArrowUpDown className="h-3 w-3" />
                  {streakOpen ? "Leave the game" : "Higher or lower"}
                </Link>
              </div>
            )}
            {answering && phase !== "reveal" && (
              <div className="mb-6 text-center text-[12px]">
                <span className="font-bold text-white">
                  {answering.challenger.username ?? "Someone"} has {answering.challenger.cardCount} cards on the line.
                </span>{" "}
                <span className="text-osu-f1">
                  Open a {packTypeById(answering.packType as PackTypeId).name} pack and play them for it. The winner
                  keeps both hands.
                </span>
              </div>
            )}
            {duelError && phase !== "reveal" && (
              <div className="mb-6 text-center text-[12px] text-osu-pink-light">{duelError}</div>
            )}

            {streakOpen ? (
              <StreakGame
                onExit={() => {
                  void navigate({ to: "/packs", search: {}, resetScroll: false });
                }}
              />
            ) : dealError ? (
              <div className="mx-auto max-w-[420px] text-center">
                <div className="text-sm font-bold text-white">Couldn't deal a pack</div>
                <div className="mt-2 text-[12px] text-osu-f1">The rankings lookup failed. Try again in a moment.</div>
                <button
                  type="button"
                  onClick={openAnother}
                  className="mt-5 rounded-full bg-osu-pink px-6 py-2 text-sm font-bold text-white hover:brightness-110 transition cursor-pointer"
                >
                  Retry
                </button>
              </div>
            ) : (
              <AnimatePresence mode="wait">
                {phase === "pack" && (
                  // packTypeId is NOT part of this key: switching pack types
                  // swaps the stage instantly instead of fading the whole
                  // section out and back in.
                  <motion.div
                    key={`pack-${packId}`}
                    initial={false}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    {!wallet ? (
                      <div className="py-16 text-center text-[12px] text-osu-f1">Loading your collection...</div>
                    ) : !canOpen ? (
                      <div className="mx-auto max-w-[420px] py-12 text-center">
                        <div className="text-sm font-bold text-white">Out of free packs</div>
                        <div className="mt-2 text-[12px] text-osu-f1 tabular-nums">
                          {nextChargeMs !== null
                            ? `Next free pack in ${Math.ceil(nextChargeMs / 1000)}s`
                            : "A free pack is ready."}
                        </div>
                        <div className="mt-2 text-[12px] text-osu-f1">
                          Shard packs below stay open if you have the shards.
                        </div>
                      </div>
                    ) : (
                      // No packTypeId key: the stage stays mounted across
                      // type switches and swaps its cached foil texture
                      // instead of remounting a fresh WebGL scene.
                      <PackStage
                        reducedMotion={reducedMotion}
                        onOpened={handleOpened}
                        packType={selectedType}
                      />
                    )}
                    {wallet && (
                      <div className="mt-8">
                        <PackTypeSelector
                          wallet={wallet}
                          selectedId={packTypeId}
                          thumbs={packThumbs}
                          onSelect={setPackTypeId}
                        />
                      </div>
                    )}
                  </motion.div>
                )}
                {(phase === "reveal" || phase === "summary") && (
                  // Reveal and summary share one presence child: swapping
                  // between them is a plain same-frame re-render, so the
                  // reveal-all handoff can fly each card straight from its
                  // reveal rect into its summary slot with no blank frame.
                  <motion.div
                    key={`open-${packId}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    {phase === "summary" ? (
                      <PackSummary
                        cards={revealed}
                        reducedMotion={reducedMotion}
                        flyFrom={summaryFlyFrom}
                        onOpenAnother={openAnother}
                        onOpenNext={openNextPack}
                        canOpenNext={canOpen}
                        nextPackShardCost={
                          selectedType.cost.kind === "shards" ? selectedType.cost.amount : null
                        }
                        serials={serials}
                        onChallenge={canDuel ? (answering ? answerDuel : startDuel) : undefined}
                        challengeBusy={duelBusy}
                        answeringUsername={answering?.challenger.username ?? null}
                      />
                    ) : cards ? (
                      <RevealStage
                        cards={cards}
                        reducedMotion={reducedMotion}
                        onCardRevealed={(pull) => {
                          // In the wallet now, so no longer owed by the pending pack.
                          consumePendingPackCard(pull.userId);
                          return walletApi.recordPull(pull);
                        }}
                        onComplete={(pulls, handoff) => {
                          clearPendingPack();
                          /* Log the opened pack into the community pull feed.
                             Fire-and-forget: the reveal is already done and
                             the wallet is the source of truth either way. */
                          if (auth.viewer && pulls.length > 0) {
                            void recordServerPackPulls({
                              data: {
                                packType: selectedType.id,
                                cards: pulls.map((pull) => ({
                                  userId: pull.player.user.id,
                                  username: pull.player.user.username,
                                  countryCode: pull.player.user.country_code,
                                  tier: pull.tier,
                                  isNew: pull.isNew,
                                })),
                              },
                            })
                              // Once they are logged, pull the ticker forward
                              // so your own pack lands in the rail alongside
                              // the summary instead of on the next poll.
                              .then((result) => {
                                if (!result) return;
                                if (result.recorded > 0) refreshPackPulseFeed();
                                // Serials come back with the log write, so the
                                // summary can print them without asking again.
                                if (result.mints.length > 0) {
                                  setSerials(
                                    new Map(
                                      result.mints.map((mint) => [
                                        mint.cardKey,
                                        { serial: mint.serial, mintedTotal: mint.mintedTotal },
                                      ]),
                                    ),
                                  );
                                }
                              })
                              .catch(() => {});
                          }
                          setRevealed(pulls);
                          setSummaryFlyFrom(handoff?.sourceRects ?? null);
                          setPhase("summary");
                        }}
                      />
                    ) : (
                      <ShuffleStage reducedMotion={reducedMotion} count={selectedType.cardCount} />
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            )}

            {!dealError && collectionPanelMounted && collectionWallet && (
              <div className={showCollectionPanel ? "mt-14" : "hidden"}>
                <div className="mx-auto mb-3 flex w-full max-w-[820px] items-center justify-end gap-1">
                  {(["grid", "album"] as const).map((mode) => {
                    const active = albumOpen === (mode === "album");
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => {
                          const toAlbum = mode === "album";
                          setAlbumOpen(toAlbum);
                          if (toAlbum) setAlbumMounted(true);
                          /* The URL update waits until after the next paint:
                             navigate() does its route re-match and full route
                             re-render synchronously, and inside the click
                             handler React would batch the swap above into
                             that long task, holding the paint back to where
                             it started. rAF lands just before the paint, the
                             timeout right after it. */
                          window.requestAnimationFrame(() => {
                            window.setTimeout(() => {
                              void navigate({
                                to: "/packs",
                                search: toAlbum ? { view: "album" } : {},
                                replace: true,
                                resetScroll: false,
                              });
                            }, 0);
                          });
                        }}
                        className={`rounded-full px-3 py-1 text-[12px] font-semibold transition-colors cursor-pointer ${
                          active ? "bg-osu-pink text-white" : "text-osu-f1 hover:bg-osu-b4/60 hover:text-white"
                        }`}
                        aria-pressed={active}
                      >
                        {mode === "album" ? "Album" : "Grid"}
                      </button>
                    );
                  })}
                </div>
                {albumMounted && (
                  <div className={albumOpen ? undefined : "hidden"}>
                    <MemoAlbumView
                      wallet={collectionWallet}
                      syncStatus={walletApi.syncStatus}
                      trackedCountries={trackedCountries}
                      viewerId={auth.viewer?.id ?? null}
                    />
                  </div>
                )}
                <div className={albumOpen ? "hidden" : undefined}>
                  <MemoCollectionPanel
                    wallet={collectionWallet}
                    showLoginNudge={!auth.viewer && auth.loginAvailable}
                    syncStatus={walletApi.syncStatus}
                    onRecycleCard={walletApi.recycleCard}
                    onRecycleWhole={walletApi.recycleWhole}
                    onRecycleWholeMany={walletApi.recycleWholeMany}
                    onRecycleWholeMatching={walletApi.recycleWholeMatching}
                    onRecycleAll={walletApi.recycleAll}
                    onApplyMint={walletApi.applyMint}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
