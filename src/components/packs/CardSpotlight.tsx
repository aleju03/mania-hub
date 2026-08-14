import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Share2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "#/lib/auth-context";
import { formatOrdinal } from "#/lib/format";
import { fetchLivePackCardStats, isLiveBackendConfigured } from "#/lib/live-backend";
import { MANIA_TIER_STYLES, type ManiaCardTier } from "#/lib/maniacard";
import { collectedCardTier, type CollectedCard } from "#/lib/pack-collection";
import { ManiaCardRenderer } from "../player/maniacard3d/ManiaCardRenderer";
import { buildManiaCardRenderDataFromSkills } from "../player/maniacard3d/renderData";
import { CountryFlag } from "../ui/CountryFlag";
import { renderCardSkeletonThumbnail, renderCardThumbnail } from "./cardSnapshot";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";

export interface CardSpotlightTarget {
  card: CollectedCard;
  /* The grid tile's thumbnail at open time; the card flies up wearing it
     until the live 3D card (or a 600px re-render) takes over. */
  thumbnail: string | null;
  /* Where the clicked tile sat, so the card can lift out of the grid and
     land back in it on close. */
  rect: { top: number; left: number; width: number; height: number };
}

/* The WebGL card fills the host's height divided by the renderer's 1.05
   breathing-room factor; oversizing the host by that factor makes the canvas
   card land exactly on the static image it replaces. */
const CANVAS_BREATHING_INSET = "-2.5%";

function isMobileViewport() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 640px)").matches
  );
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

function spotlightCardTier(card: CollectedCard): ManiaCardTier {
  return collectedCardTier(card);
}

/* The vivid rgb triplet of a tier's palette (from its badge halo), same
   extraction the collection filter chips use. */
function tierAccentRgb(tier: ManiaCardTier): string {
  const match = MANIA_TIER_STYLES[tier].badgeHalo.match(/([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  return match ? `${match[1]}, ${match[2]}, ${match[3]}` : "148, 163, 184";
}

export function CardSpotlight({
  target,
  onClose,
  onExitComplete,
}: {
  target: CardSpotlightTarget | null;
  onClose: () => void;
  /* Fires once the close flight has landed back in the grid slot, so the
     owner can reveal the source tile again without a duplicate frame. */
  onExitComplete?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<ManiaCardRenderer | null>(null);
  const [canvasReady, setCanvasReady] = useState(false);
  const [hiResFallback, setHiResFallback] = useState<string | null>(null);
  const [ownerCount, setOwnerCount] = useState<number | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const reducedMotion = prefersReducedMotion();
  const viewerId = useAuth().viewer?.id ?? null;

  /* Community context: how many collections hold this card. */
  useEffect(() => {
    setOwnerCount(null);
    const cardUserId = target?.card.userId;
    if (!cardUserId || !isLiveBackendConfigured()) return;
    let cancelled = false;
    void fetchLivePackCardStats([cardUserId])
      .then((stats) => {
        if (!cancelled) setOwnerCount(stats[0]?.owners ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [target?.card.userId]);

  useEffect(() => {
    setShareCopied(false);
  }, [target?.card.userId]);

  const shareCard = async (card: CollectedCard) => {
    // Signed-in collectors share the pull itself (/pull/{owner}/{card}: their
    // minted card, "pulled by them", with an OG embed). Local-only wallets
    // have no server row to link, so those share the player's card page.
    const url = viewerId
      ? `${window.location.origin}/pull/${viewerId}/${card.userId}`
      : `${window.location.origin}/player/${encodeURIComponent(card.username)}/maniacard`;
    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 1600);
    } catch {
      // Clipboard can be unavailable (permissions, http); the native share
      // sheet is the fallback rather than the default so desktop gets the
      // predictable copy behavior.
      try {
        await navigator.share?.({ url, title: `${card.username} maniacard` });
      } catch {
        // The user closed the share sheet; nothing to do.
      }
    }
  };

  useEffect(() => {
    if (!target) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  useBodyScrollLock(target != null);

  /* Where the card lands: centered, leaving room for the info block below. */
  const layout = useMemo(() => {
    if (!target || typeof window === "undefined") return null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const infoHeight = 118;
    const gap = 16;
    const margin = 16;
    const maxHeight = Math.min(470, vh - infoHeight - gap - margin * 2);
    const width = Math.min(vw * 0.82, (maxHeight * 5) / 7);
    const height = (width * 7) / 5;
    const left = (vw - width) / 2;
    const top = Math.max(margin, (vh - (height + gap + infoHeight)) / 2);
    return { left, top, width, height, infoTop: top + height + gap };
  }, [target]);

  /* Mount the live 3D card once the flight has mostly settled; the texture
     pipeline is heavy enough to stutter the spring if started right away.
     WebGL failure falls back to a 600px re-render of the front. */
  useEffect(() => {
    setCanvasReady(false);
    setHiResFallback(null);
    const card = target?.card;
    if (!card?.skills) return;
    let cancelled = false;
    const data = buildManiaCardRenderDataFromSkills({
      user: {
        id: card.userId,
        username: card.username,
        avatar_url: card.avatarUrl,
        country_code: card.countryCode,
        statistics: { global_rank: card.globalRank, pp: card.pp },
      },
      skills: card.skills,
      tierOverride: collectedCardTier(card),
    });
    const fallbackTo2d = () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
      void renderCardThumbnail(data, 600)
        .then((url) => {
          if (!cancelled) setHiResFallback(url);
        })
        .catch(() => {});
    };
    const timer = window.setTimeout(() => {
      const host = hostRef.current;
      if (!host || cancelled) return;
      try {
        rendererRef.current = new ManiaCardRenderer({
          host,
          data,
          mobile: isMobileViewport(),
          reducedMotion: prefersReducedMotion(),
          devicePixelRatio: window.devicePixelRatio || 1,
          // A steady card in a modal; touch drag still tilts it.
          gyro: false,
          onReady: () => {
            if (!cancelled) setCanvasReady(true);
          },
          onError: () => {
            if (!cancelled) fallbackTo2d();
          },
        });
        rendererRef.current.resize();
      } catch {
        if (!cancelled) fallbackTo2d();
      }
    }, 340);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      const renderer = rendererRef.current;
      rendererRef.current = null;
      if (!renderer) return;
      /* dispose() removes the canvas immediately, but the exit flight still
         shows this card for ~220ms; keep the live card visible on its way
         back to the grid, then release. */
      window.setTimeout(() => renderer.dispose({ deferGpuRelease: true }), 450);
    };
  }, [target?.card]);

  if (typeof document === "undefined") return null;

  const card = target?.card ?? null;
  const from =
    target && layout
      ? {
          x: target.rect.left - layout.left,
          y: target.rect.top - layout.top,
          scale: target.rect.width / layout.width,
        }
      : null;
  const tier = card ? spotlightCardTier(card) : null;
  const tierLabel = card?.tierLabel ?? (card?.tier ? MANIA_TIER_STYLES[card.tier].label : null);
  const baseImage =
    target?.thumbnail ?? (tier ? renderCardSkeletonThumbnail(tier, 600) : null);

  return createPortal(
    <AnimatePresence onExitComplete={onExitComplete}>
      {target && card && layout && from && (
        <div key={`spotlight-${card.userId}`} className="fixed inset-0 z-[120]">
          <motion.div
            className="absolute inset-0 bg-black/80"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          />
          <motion.button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute top-3 right-3 z-20 grid h-8 w-8 place-items-center rounded-full bg-black/50 text-white/80 transition-colors hover:bg-black/70 hover:text-white cursor-pointer"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="h-4 w-4">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </motion.button>

          {/* The card, flying from its grid slot to center stage. Overflow
              stays visible so the tilted 3D card can poke past the box. */}
          <motion.div
            className="fixed z-10 origin-top-left"
            style={{ left: layout.left, top: layout.top, width: layout.width, height: layout.height }}
            initial={reducedMotion ? { opacity: 0 } : { x: from.x, y: from.y, scale: from.scale }}
            animate={
              reducedMotion
                ? { opacity: 1, transition: { duration: 0.15 } }
                : { x: 0, y: 0, scale: 1, transition: { type: "spring", stiffness: 300, damping: 28, mass: 0.8 } }
            }
            exit={
              reducedMotion
                ? { opacity: 0, transition: { duration: 0.12 } }
                : { x: from.x, y: from.y, scale: from.scale, transition: { duration: 0.22, ease: "easeInOut" } }
            }
          >
            {baseImage ? (
              <img
                src={hiResFallback ?? baseImage}
                alt={`${card.username} maniacard`}
                className="h-full w-full rounded-[14px] object-cover shadow-[0_18px_48px_rgba(0,0,0,0.6)]"
                style={{ opacity: canvasReady ? 0 : 1, transition: "opacity 0.2s ease-out" }}
                draggable={false}
              />
            ) : (
              <div className="h-full w-full rounded-[14px] bg-osu-b4 shadow-[0_18px_48px_rgba(0,0,0,0.6)]" />
            )}
            <div
              ref={hostRef}
              className="absolute"
              style={{
                inset: CANVAS_BREATHING_INSET,
                opacity: canvasReady ? 1 : 0,
                pointerEvents: canvasReady ? "auto" : "none",
                transition: "opacity 0.2s ease-out",
                touchAction: "none",
              }}
              role="img"
              aria-label={canvasReady ? `${card.username} maniacard` : undefined}
            />
          </motion.div>

          {/* Player info under the card */}
          <motion.div
            className="fixed inset-x-0 z-10 flex justify-center px-4"
            style={{ top: layout.infoTop }}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0, transition: { delay: reducedMotion ? 0 : 0.12, duration: 0.2 } }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
          >
            <div className="flex flex-col items-center gap-1.5 text-center">
              <div className="flex items-center gap-2">
                <CountryFlag code={card.countryCode} size="sm" />
                <span className="text-[15px] font-bold text-white">{card.username}</span>
                {tierLabel && tier && (
                  <span
                    className="rounded-full border px-2 py-px text-[10px] font-bold uppercase tracking-wide"
                    style={{
                      color: `rgb(${tierAccentRgb(tier)})`,
                      borderColor: `rgba(${tierAccentRgb(tier)}, 0.4)`,
                      backgroundColor: `rgba(${tierAccentRgb(tier)}, 0.1)`,
                    }}
                  >
                    {tierLabel}
                  </span>
                )}
              </div>
              <div className="text-[12px] text-osu-f1 tabular-nums">
                {Math.round(card.pp).toLocaleString()}pp
                {card.globalRank > 0 && <> &middot; #{card.globalRank.toLocaleString()} global</>}
                {card.copies > 1 && <> &middot; x{card.copies} copies</>}
                {ownerCount !== null && ownerCount > 0 && (
                  <> &middot; in {ownerCount.toLocaleString()} {ownerCount === 1 ? "collection" : "collections"}</>
                )}
              </div>
              {card.serial ? (
                // Pull order, only known for a synced collection: the registry
                // that hands out these numbers lives on the server. Plain
                // ordinal, not "first ever": this describes a holding, and a
                // serial-1 card may by now sit in hundreds of collections.
                <div
                  className={`text-[12px] tabular-nums ${card.serial === 1 ? "font-bold text-amber-300" : "text-osu-f1"}`}
                >
                  {formatOrdinal(card.serial)} person to pull this
                  {card.mintedTotal && card.mintedTotal !== card.serial ? (
                    // Skip the total when it just repeats the serial ("61st ... out of 61").
                    <span className="text-osu-f1"> out of {card.mintedTotal.toLocaleString()}</span>
                  ) : null}
                </div>
              ) : null}
              <div className="mt-1.5 flex items-center gap-2">
                <Link
                  to="/player/$username"
                  params={{ username: card.username }}
                  className="rounded-full bg-osu-pink px-4 py-1.5 text-[12px] font-bold text-white transition hover:brightness-110"
                >
                  View profile
                </Link>
                <button
                  type="button"
                  onClick={() => void shareCard(card)}
                  className="flex items-center gap-1.5 rounded-full bg-osu-b3/80 px-4 py-1.5 text-[12px] font-bold text-white transition hover:bg-osu-b3 cursor-pointer"
                  aria-label={`Share ${card.username}'s maniacard`}
                >
                  {shareCopied ? (
                    <>
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
                      Share
                    </>
                  )}
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
