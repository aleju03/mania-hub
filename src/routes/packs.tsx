import { createFileRoute, notFound } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { Recycle } from "lucide-react";
import { useEffect, useState } from "react";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { PageHeader } from "../components/layout/PageHeader";
import { CollectionPanel } from "../components/packs/CollectionPanel";
import { createPackFrontCanvas, PACK_ASPECT } from "../components/packs/packArt";
import { PackStage } from "../components/packs/PackStage";
import { PackSummary } from "../components/packs/PackSummary";
import { RevealStage, type PackCardState, type RevealedCard } from "../components/packs/RevealStage";
import { usePackWallet } from "../components/packs/usePackWallet";
import { useAuth } from "../lib/auth-context";
import { isPacksFeatureEnabled } from "../lib/feature-flags";
import {
  MAX_PACK_CHARGES,
  msUntilNextCharge,
  ownedCards,
  PACK_OPEN_SHARD_REWARD,
  type PackWallet,
} from "../lib/pack-collection";
import {
  drawPackPlayers,
  fetchPackPlayerScores,
  PACK_TYPES,
  packTypeById,
  type PackTypeDef,
  type PackTypeId,
} from "../lib/packs";
import { pageSeo } from "../lib/seo";

export const Route = createFileRoute("/packs")({
  head: ({ match }) => pageSeo({
    title: "Card Packs",
    description: "Tear open a booster pack of five maniacards: random osu!mania players minted as collectible cards with skill stats and rarity tiers.",
    path: "/packs",
    origin: match.context.origin,
  }),
  beforeLoad: () => {
    if (!isPacksFeatureEnabled()) {
      throw notFound();
    }
    return undefined as never;
  },
  component: PacksPage,
});

type PackPhase = "pack" | "reveal" | "summary";

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

function canAffordPack(wallet: PackWallet | null, type: PackTypeDef): boolean {
  if (!wallet) return false;
  if (type.cost.kind === "charge") return wallet.charges > 0;
  return wallet.shards >= type.cost.amount;
}

/* Thumbnail renders of each pack type's foil art, generated once. */
function usePackArtThumbs(): Partial<Record<PackTypeId, string>> {
  const [thumbs, setThumbs] = useState<Partial<Record<PackTypeId, string>>>({});
  useEffect(() => {
    const next: Partial<Record<PackTypeId, string>> = {};
    for (const type of PACK_TYPES) {
      const full = createPackFrontCanvas({ accent: type.accent, subtitle: type.artSubtitle });
      const small = document.createElement("canvas");
      small.width = 160;
      small.height = Math.round(160 / PACK_ASPECT);
      const context = small.getContext("2d");
      if (!context) continue;
      context.drawImage(full, 0, 0, small.width, small.height);
      next[type.id] = small.toDataURL("image/png");
    }
    setThumbs(next);
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
            </button>
          );
        })}
      </div>
      <div className="mt-4 text-center text-[11px] text-osu-f1">
        {selectedType.blurb}. Every opened pack banks {PACK_OPEN_SHARD_REWARD} shards; recycling
        duplicate cards adds more.
      </div>
    </div>
  );
}

function PacksPage() {
  const reducedMotion = useReducedMotion();
  const auth = useAuth();
  const walletApi = usePackWallet();
  const packThumbs = usePackArtThumbs();
  const [phase, setPhase] = useState<PackPhase>("pack");
  const [packId, setPackId] = useState(0);
  const [packTypeId, setPackTypeId] = useState<PackTypeId>("standard");
  const [cards, setCards] = useState<PackCardState[] | null>(null);
  const [revealed, setRevealed] = useState<RevealedCard[]>([]);
  const [dealError, setDealError] = useState(false);

  const wallet = walletApi.wallet;
  const selectedType = packTypeById(packTypeId);
  const charges = wallet?.charges ?? 0;
  const shards = wallet?.shards ?? 0;
  const nextChargeMs = wallet ? msUntilNextCharge(wallet, walletApi.nowMs || Date.now()) : null;

  /* Deal a fresh pack from the tracked pool (uniform odds within the pack
     type's slice), then start prefetching each player's best scores so the
     cards are usually ready by the time the pack is slashed open. Staggered
     to keep the backend's snapshot endpoint calm. */
  useEffect(() => {
    let cancelled = false;
    setCards(null);
    setDealError(false);
    const type = packTypeById(packTypeId);
    const currentWallet = walletApi.wallet;
    drawPackPlayers(Math.random, {
      topFraction: type.topFraction,
      ownedUserIds:
        type.guaranteesNew && currentWallet
          ? new Set(ownedCards(currentWallet).map((card) => card.userId))
          : undefined,
    })
      .then((draw) => {
        if (cancelled) return;
        walletApi.notePoolTotal(draw.poolTotal);
        setCards(
          draw.players.map((player, position) => ({
            player,
            scoresPromise: new Promise<void>((resolve) => setTimeout(resolve, position * 350))
              .then(() => fetchPackPlayerScores(player.user.id))
              .catch(() => []),
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setDealError(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packId, packTypeId]);

  const openAnother = () => {
    setRevealed([]);
    // Keep the chosen pack type across packs while it stays affordable.
    if (!canAffordPack(walletApi.wallet, packTypeById(packTypeId))) setPackTypeId("standard");
    setPhase("pack");
    setPackId((id) => id + 1);
  };

  const handleOpened = () => {
    // The slash is the moment of purchase: one charge or the shard price.
    if (!walletApi.openPack(selectedType.cost)) {
      setPackTypeId("standard");
      setPackId((id) => id + 1);
      return;
    }
    setPhase("reveal");
  };

  const canOpen = canAffordPack(wallet, selectedType);

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col overflow-clip bg-osu-b5">
        <OsuTriangleBackdrop />
        <div className="relative z-10 flex flex-1 flex-col">
          <PageHeader iconSrc="/images/icons/beatmappacks.svg" title="Maniacard packs" />

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
              </div>
            )}

            {dealError ? (
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
                      <PackStage
                        key={packTypeId}
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
                {phase === "reveal" && (
                  <motion.div
                    key={`reveal-${packId}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    {cards ? (
                      <RevealStage
                        cards={cards}
                        reducedMotion={reducedMotion}
                        onCardRevealed={walletApi.recordPull}
                        onComplete={(pulls) => {
                          setRevealed(pulls);
                          setPhase("summary");
                        }}
                      />
                    ) : (
                      <div className="py-16 text-center text-[12px] text-osu-f1">Shuffling players...</div>
                    )}
                  </motion.div>
                )}
                {phase === "summary" && (
                  <motion.div
                    key={`summary-${packId}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    <PackSummary cards={revealed} reducedMotion={reducedMotion} onOpenAnother={openAnother} />
                  </motion.div>
                )}
              </AnimatePresence>
            )}

            {!dealError && (phase === "pack" || phase === "summary") && (
              <div className="mt-14">
                <CollectionPanel
                  wallet={wallet}
                  showLoginNudge={!auth.viewer && auth.loginAvailable}
                  syncStatus={walletApi.syncStatus}
                  onRecycleCard={walletApi.recycleCard}
                  onRecycleWhole={walletApi.recycleWhole}
                  onRecycleAll={walletApi.recycleAll}
                  onApplyMint={walletApi.applyMint}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
