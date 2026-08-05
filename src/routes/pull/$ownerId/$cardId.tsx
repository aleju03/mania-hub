import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { OsuTriangleBackdrop } from "../../../components/layout/OsuTriangleBackdrop";
import { PageHeader } from "../../../components/layout/PageHeader";
import { renderCardSkeletonThumbnail, renderCardThumbnail } from "../../../components/packs/cardSnapshot";
import { ManiaCardRenderer } from "../../../components/player/maniacard3d/ManiaCardRenderer";
import { buildManiaCardRenderDataFromSkills } from "../../../components/player/maniacard3d/renderData";
import { CountryFlag } from "../../../components/ui/CountryFlag";
import { formatDate } from "../../../lib/format";
import {
  fetchLivePackSharedCard,
  isLiveBackendConfigured,
  type LiveSharedPackCard,
} from "../../../lib/live-backend";
import { HONORARY_PACK_POOL } from "../../../lib/honorary-players";
import { getManiaCardTier, MANIA_TIER_STYLES, type ManiaCardTier, type ManiaSkills } from "../../../lib/maniacard";
import { PACK_TYPES } from "../../../lib/packs";
import { pageSeo, pullOgImagePath } from "../../../lib/seo";

export const Route = createFileRoute("/pull/$ownerId/$cardId")({
  head: ({ params, match }) => pageSeo({
    title: "Maniacard pull",
    description: "A maniacard pulled from a booster pack. Open your own packs and build a collection.",
    path: `/pull/${params.ownerId}/${params.cardId}`,
    origin: match.context.origin,
    image: pullOgImagePath(Number(params.ownerId), Number(params.cardId)),
    imageWidth: 720,
    imageHeight: 1080,
  }),
  component: PullPage,
});

/* Same oversize trick as the card spotlight: the WebGL card fills the host's
   height divided by the renderer's 1.05 breathing-room factor. */
const CANVAS_BREATHING_INSET = "-2.5%";

/* What the backend calls an owner it cannot name: no live users row and no
   name frozen in the pull log (a collector outside every tracked roster, on a
   card old enough to predate the pull log). There is no profile to point at,
   so that one case stays plain text. */
const UNKNOWN_OWNER_NAME = "a collector";

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

function sharedCardTier(shared: LiveSharedPackCard): ManiaCardTier {
  if (shared.card.tier && shared.card.tier in MANIA_TIER_STYLES) {
    return shared.card.tier as ManiaCardTier;
  }
  const skills = shared.card.skills as ManiaSkills | null;
  if (skills && Number.isFinite(skills.cardPower)) return getManiaCardTier(skills.cardPower);
  return "common";
}

/* What a GOAT pull actually cost in luck. The honorary slot rolls the pack's
   own chance and then picks uniformly from the dealable roster, so the odds of
   any one of them is the product. A pack that can cascade gets slightly more
   than one shot at it (a hit re-rolls for another honorary, and again after
   that), which is worth 1 / (1 - cascade) slots on average. Figures are
   today's: the roster grows, and the pull log records the pack rather than the
   odds that applied then. */
function goatPullOdds(packType: string): { pack: string; slotChance: number; percent: string } | null {
  const definition = PACK_TYPES.find((type) => type.id === packType);
  const poolSize = HONORARY_PACK_POOL.length;
  if (!definition || poolSize === 0) return null;
  const slotsPerHit = 1 / (1 - Math.min(0.99, Math.max(0, definition.honoraryCascadeChance)));
  const chance = (definition.honoraryChance * slotsPerHit) / poolSize;
  if (!(chance > 0)) return null;
  // Two significant figures: these run from 0.015% to 0.18%, so a fixed number
  // of decimals either rounds the small ones to zero or pads the large ones.
  const percent = Number((chance * 100).toPrecision(2));
  return { pack: definition.name, slotChance: definition.honoraryChance, percent: `${percent}%` };
}

function tierAccentRgb(tier: ManiaCardTier): string {
  const match = MANIA_TIER_STYLES[tier].badgeHalo.match(/([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  return match ? `${match[1]}, ${match[2]}, ${match[3]}` : "148, 163, 184";
}

/* The pulled card itself: live 3D when WebGL cooperates, a 600px 2D render of
   the same front otherwise, a tier skeleton when the mint has no skills. */
function PulledCardArt({ shared }: { shared: LiveSharedPackCard }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<ManiaCardRenderer | null>(null);
  const [canvasReady, setCanvasReady] = useState(false);
  const [staticImage, setStaticImage] = useState<string | null>(null);
  const tier = sharedCardTier(shared);

  useEffect(() => {
    setCanvasReady(false);
    setStaticImage(null);
    const skills = shared.card.skills as ManiaSkills | null;
    if (!skills || !Number.isFinite(skills.cardPower)) {
      setStaticImage(renderCardSkeletonThumbnail(tier, 600));
      return;
    }
    const data = buildManiaCardRenderDataFromSkills({
      user: {
        id: shared.card.userId,
        username: shared.card.username,
        avatar_url: shared.card.avatarUrl,
        country_code: shared.card.countryCode,
        statistics: { global_rank: shared.card.globalRank, pp: shared.card.pp },
      },
      skills,
      tierOverride: tier,
    });
    let cancelled = false;
    // The 2D front renders first so something card-shaped is visible while
    // the WebGL pipeline warms up (and stays if it fails).
    void renderCardThumbnail(data, 600)
      .then((url) => {
        if (!cancelled && url) setStaticImage(url);
      })
      .catch(() => {});
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
          gyro: false,
          onReady: () => {
            if (!cancelled) setCanvasReady(true);
          },
          onError: () => {
            rendererRef.current?.dispose();
            rendererRef.current = null;
          },
        });
        rendererRef.current.resize();
      } catch {
        rendererRef.current = null;
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared]);

  const glow = `rgba(${tierAccentRgb(tier)}, 0.35)`;

  return (
    <div
      className="relative w-[min(78vw,300px)]"
      style={{ aspectRatio: "5 / 7", filter: `drop-shadow(0 18px 44px ${glow})` }}
    >
      {staticImage ? (
        <img
          src={staticImage}
          alt={`${shared.card.username} maniacard`}
          className="h-full w-full rounded-[14px] object-cover"
          style={{ opacity: canvasReady ? 0 : 1, transition: "opacity 0.2s ease-out" }}
          draggable={false}
        />
      ) : (
        <div className="h-full w-full rounded-[14px] bg-osu-b4/70" />
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
        aria-label={canvasReady ? `${shared.card.username} maniacard` : undefined}
      />
    </div>
  );
}

type PullPageState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "ready"; shared: LiveSharedPackCard };

function PullPage() {
  const { ownerId, cardId } = Route.useParams();
  const [state, setState] = useState<PullPageState>({ status: "loading" });

  useEffect(() => {
    const owner = Number(ownerId);
    const card = Number(cardId);
    if (!isLiveBackendConfigured() || !Number.isInteger(owner) || owner <= 0 || !Number.isInteger(card) || card <= 0) {
      setState({ status: "missing" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void fetchLivePackSharedCard(owner, card)
      .then((shared) => {
        if (!cancelled) setState({ status: "ready", shared });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "missing" });
      });
    return () => {
      cancelled = true;
    };
  }, [ownerId, cardId]);

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col overflow-clip bg-osu-b5">
        <OsuTriangleBackdrop />
        <div className="relative z-10 flex flex-1 flex-col">
          <PageHeader iconSrc="/images/icons/packs.svg" title="Maniacard pull" />
          <div className="mx-auto w-full max-w-[720px] flex-1 px-4 py-10 sm:px-5 sm:py-14">
            {state.status === "loading" && (
              <div className="flex flex-col items-center">
                <div className="w-[min(78vw,300px)] animate-pulse rounded-[14px] bg-osu-b4/60" style={{ aspectRatio: "5 / 7" }} />
              </div>
            )}
            {state.status === "missing" && (
              <div className="mx-auto max-w-[420px] py-14 text-center">
                <div className="text-sm font-bold text-white">This pull is gone</div>
                <div className="mt-2 text-[12px] text-osu-f1">
                  The card was recycled, never synced, or the link is wrong.
                </div>
                <Link
                  to="/packs"
                  className="mt-6 inline-block rounded-full bg-osu-pink px-6 py-2 text-sm font-bold text-white transition hover:brightness-110"
                >
                  Open your own packs
                </Link>
              </div>
            )}
            {state.status === "ready" && <PulledCardDetails shared={state.shared} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function PulledCardDetails({ shared }: { shared: LiveSharedPackCard }) {
  const tier = sharedCardTier(shared);
  const accent = tierAccentRgb(tier);
  const tierLabel = shared.card.tierLabel ?? MANIA_TIER_STYLES[tier].label;
  const odds = shared.goatPull ? goatPullOdds(shared.goatPull.packType) : null;
  return (
    <div className="flex flex-col items-center">
      <PulledCardArt shared={shared} />
      <div className="mt-6 flex flex-col items-center gap-1.5 text-center">
        <div className="flex items-center gap-2">
          <CountryFlag code={shared.card.countryCode} size="sm" />
          <span className="text-[16px] font-bold text-white">{shared.card.username}</span>
          <span
            className="rounded-full border px-2 py-px text-[10px] font-bold uppercase tracking-wide"
            style={{
              color: `rgb(${accent})`,
              borderColor: `rgba(${accent}, 0.4)`,
              backgroundColor: `rgba(${accent}, 0.1)`,
            }}
          >
            {tierLabel}
          </span>
        </div>
        <div className="text-[12px] text-osu-f1 tabular-nums">
          {Math.round(shared.card.pp).toLocaleString()}pp
          {shared.card.globalRank > 0 && <> &middot; #{shared.card.globalRank.toLocaleString()} global</>}
          {shared.owners > 0 && (
            <> &middot; in {shared.owners.toLocaleString()} {shared.owners === 1 ? "collection" : "collections"}</>
          )}
        </div>
        {typeof shared.serial === "number" && shared.serial > 0 && (
          // Pull order, not copy count. Mint phrasing, not "first ever": the
          // permalink describes a holding, and a mint-#1 card may by now sit
          // in hundreds of collections.
          <div
            className={`text-[13px] tabular-nums ${shared.serial === 1 ? "font-bold text-amber-300" : "text-osu-f1"}`}
          >
            Mint #{shared.serial.toLocaleString()}
            {shared.mintedTotal > 0 && (
              <span className="text-osu-f1"> out of {shared.mintedTotal.toLocaleString()}</span>
            )}
            {shared.serial === 1 && " — pulled before anyone else"}
          </div>
        )}
        <div className="text-[12px] text-osu-f1">
          Pulled by{" "}
          {shared.owner.username === UNKNOWN_OWNER_NAME ? (
            <span className="font-bold text-white">{shared.owner.username}</span>
          ) : (
            <Link
              to="/player/$username"
              params={{ username: shared.owner.username }}
              className="font-bold text-white transition-colors hover:text-osu-pink-light"
            >
              {shared.owner.username}
            </Link>
          )}
          {shared.card.firstPulledAt > 0 && (
            <span className="tabular-nums"> on {formatDate(new Date(shared.card.firstPulledAt).toISOString())}</span>
          )}
          {shared.card.copies > 1 && <span className="tabular-nums"> &middot; x{shared.card.copies} copies</span>}
        </div>
        {odds && (
          // Only shown when the log says this card arrived as a GOAT, so a
          // ranked-pool pull from before the roster change never claims odds
          // it did not face. The derivation lives in the tooltip: the headline
          // is the pack and the long odds.
          <div
            className="text-[12px] text-osu-f1"
            title={`${(odds.slotChance * 100).toFixed(2).replace(/\.?0+$/, "")}% GOAT slot, then 1 of ${HONORARY_PACK_POOL.length} on the roster`}
          >
            {odds.pack} pack &middot;{" "}
            <span className="font-bold tabular-nums text-amber-200">{odds.percent}</span> pull chance
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <Link
            to="/packs"
            className="rounded-full bg-osu-pink px-5 py-2 text-[12px] font-bold text-white transition hover:brightness-110"
          >
            Open your own packs
          </Link>
          <Link
            to="/player/$username"
            params={{ username: shared.card.username }}
            className="rounded-full bg-osu-b3/80 px-5 py-2 text-[12px] font-bold text-white transition hover:bg-osu-b3"
          >
            View profile
          </Link>
        </div>
      </div>
    </div>
  );
}
