import { createFileRoute, notFound } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { PageHeader } from "../components/layout/PageHeader";
import { PackStage } from "../components/packs/PackStage";
import { PackSummary } from "../components/packs/PackSummary";
import { RevealStage, type PackCardState, type RevealedCard } from "../components/packs/RevealStage";
import { isPacksFeatureEnabled } from "../lib/feature-flags";
import { drawPackPlayers, fetchPackPlayerScores } from "../lib/packs";
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

function PacksPage() {
  const reducedMotion = useReducedMotion();
  const [phase, setPhase] = useState<PackPhase>("pack");
  const [packId, setPackId] = useState(0);
  const [cards, setCards] = useState<PackCardState[] | null>(null);
  const [revealed, setRevealed] = useState<RevealedCard[]>([]);
  const [dealError, setDealError] = useState(false);

  /* Deal a fresh pack: pick five players from the global rankings, then start
     prefetching each one's top plays right away so the cards are usually
     ready by the time the pack is slashed open. Staggered so a pack never
     bursts the osu! API. */
  useEffect(() => {
    let cancelled = false;
    setCards(null);
    setDealError(false);
    drawPackPlayers()
      .then((players) => {
        if (cancelled) return;
        setCards(
          players.map((player, position) => ({
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
  }, [packId]);

  const openAnother = () => {
    setRevealed([]);
    setPhase("pack");
    setPackId((id) => id + 1);
  };

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col overflow-clip bg-osu-b5">
        <OsuTriangleBackdrop />
        <div className="relative z-10 flex flex-1 flex-col">
          <PageHeader iconSrc="/images/icons/beatmappacks.svg" title="Maniacard packs" />

          <div className="mx-auto w-full max-w-[960px] flex-1 px-4 py-8 sm:px-5 sm:py-12">
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
                  <motion.div
                    key={`pack-${packId}`}
                    initial={false}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    <PackStage reducedMotion={reducedMotion} onOpened={() => setPhase("reveal")} />
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
          </div>
        </div>
      </div>
    </div>
  );
}
