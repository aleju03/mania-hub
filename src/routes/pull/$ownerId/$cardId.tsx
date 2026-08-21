import { createFileRoute, Link } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { OsuTriangleBackdrop } from "../../../components/layout/OsuTriangleBackdrop";
import { PageHeader } from "../../../components/layout/PageHeader";
import { renderCardSkeletonThumbnail, renderCardThumbnail } from "../../../components/packs/cardSnapshot";
import { ManiaCardRenderer } from "../../../components/player/maniacard3d/ManiaCardRenderer";
import { buildManiaCardRenderDataFromSkills } from "../../../components/player/maniacard3d/renderData";
import { CountryFlag } from "../../../components/ui/CountryFlag";
import { formatDate, formatOrdinal } from "../../../lib/format";
import { useViewerTimeZone } from "../../../lib/use-viewer-time-zone";
import {
  fetchLivePackSharedCard,
  isLiveBackendConfigured,
  type LiveSharedPackCard,
} from "../../../lib/live-backend";
import { HONORARY_PACK_POOL } from "../../../lib/honorary-players";
import { getManiaCardTier, MANIA_TIER_STYLES, type ManiaCardTier, type ManiaSkills } from "../../../lib/maniacard";
import { parsePackCardKey } from "../../../lib/pack-collection";
import { getI18n } from "../../../lib/i18n";
import { PACK_TYPE_NAME_LABELS, PACK_TYPES, type PackTypeId } from "../../../lib/packs";
import { pageSeo, pullOgImagePath } from "../../../lib/seo";

export const Route = createFileRoute("/pull/$ownerId/$cardId")({
  validateSearch: (search: Record<string, unknown>): { pull?: number } => {
    const pull = Math.floor(Number(search.pull) || 0);
    return pull > 0 ? { pull } : {};
  },
  head: ({ params, match }) => {
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: i18n._(msg`Maniacard pull`),
      description: i18n._(msg`A maniacard pulled from a booster pack. Open your own packs and build a collection.`),
      path: `/pull/${params.ownerId}/${params.cardId}`,
      origin: match.context.origin,
      image: pullOgImagePath(Number(params.ownerId), params.cardId),
      imageWidth: 720,
      imageHeight: 1080,
    });
  },
  component: PullPage,
});

/* Same oversize trick as the card spotlight: the WebGL card fills the host's
   height divided by the renderer's 1.05 breathing-room factor. */
const CANVAS_BREATHING_INSET = "-2.5%";

/* What the backend calls an owner it cannot name: no live users row and no
   name frozen in the pull log (a collector outside every tracked roster, on a
   card old enough to predate the pull log). There is no profile to point at,
   so that one case stays plain text. The constant is the backend's sentinel,
   matched against the payload, so it stays English; only what is printed on
   the page goes through the catalog. */
const UNKNOWN_OWNER_NAME = "a collector";
const UNKNOWN_OWNER_LABEL = msg`a collector`;

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
function goatPullOdds(packType: string): { packId: PackTypeId; slotChance: number; percent: string } | null {
  const definition = PACK_TYPES.find((type) => type.id === packType);
  const poolSize = HONORARY_PACK_POOL.length;
  if (!definition || poolSize === 0) return null;
  const slotsPerHit = 1 / (1 - Math.min(0.99, Math.max(0, definition.honoraryCascadeChance)));
  const chance = (definition.honoraryChance * slotsPerHit) / poolSize;
  if (!(chance > 0)) return null;
  // Two significant figures: these run from 0.015% to 0.18%, so a fixed number
  // of decimals either rounds the small ones to zero or pads the large ones.
  const percent = Number((chance * 100).toPrecision(2));
  // The id, not the name: the pack's shelf name is translated at render.
  return { packId: definition.id, slotChance: definition.honoraryChance, percent: `${percent}%` };
}

function tierAccentRgb(tier: ManiaCardTier): string {
  const match = MANIA_TIER_STYLES[tier].badgeHalo.match(/([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  return match ? `${match[1]}, ${match[2]}, ${match[3]}` : "148, 163, 184";
}

/* The pulled card itself: live 3D when WebGL cooperates, a 600px 2D render of
   the same front otherwise, a tier skeleton when the mint has no skills. */
function PulledCardArt({ shared }: { shared: LiveSharedPackCard }) {
  const { t } = useLingui();
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
      labelOverride: shared.card.customLabel,
      motifOverride: shared.card.motif,
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
          alt={t`${shared.card.username} maniacard`}
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
        aria-label={canvasReady ? t`${shared.card.username} maniacard` : undefined}
      />
    </div>
  );
}

type PullPageState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "ready"; shared: LiveSharedPackCard };

function PullPage() {
  const { t } = useLingui();
  const { ownerId, cardId } = Route.useParams();
  const { pull } = Route.useSearch();
  const [state, setState] = useState<PullPageState>({ status: "loading" });

  useEffect(() => {
    const owner = Number(ownerId);
    /* The path segment is a card key, so each card a collector holds of one
       player has a permalink of its own: their pull, their GOAT, and every one
       the grant desk handed them. A bare player id still addresses the
       ordinary card, and the backend falls back to whatever card of that
       player they do hold, which is what every link shared before keys were
       addressable meant. */
    const card = parsePackCardKey(cardId);
    if (!isLiveBackendConfigured() || !Number.isInteger(owner) || owner <= 0 || !card) {
      setState({ status: "missing" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void fetchLivePackSharedCard(owner, cardId, pull)
      .then((shared) => {
        if (!cancelled) setState({ status: "ready", shared });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "missing" });
      });
    return () => {
      cancelled = true;
    };
  }, [ownerId, cardId, pull]);

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col overflow-clip bg-osu-b5">
        <OsuTriangleBackdrop />
        <div className="relative z-10 flex flex-1 flex-col">
          <PageHeader iconSrc="/images/icons/packs.svg" title={t`Maniacard pull`} />
          <div className="mx-auto w-full max-w-[720px] flex-1 px-4 py-10 sm:px-5 sm:py-14">
            {state.status === "loading" && (
              <div className="flex flex-col items-center">
                <div className="w-[min(78vw,300px)] animate-pulse rounded-[14px] bg-osu-b4/60" style={{ aspectRatio: "5 / 7" }} />
              </div>
            )}
            {state.status === "missing" && (
              <div className="mx-auto max-w-[420px] py-14 text-center">
                <div className="text-sm font-bold text-white"><Trans>This pull is gone</Trans></div>
                <div className="mt-2 text-[12px] text-osu-f1">
                  <Trans>The card was recycled, never synced, or the link is wrong.</Trans>
                </div>
                <Link
                  to="/packs"
                  className="mt-6 inline-block rounded-full bg-osu-pink px-6 py-2 text-sm font-bold text-white transition hover:brightness-110"
                >
                  <Trans>Open your own packs</Trans>
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
  const { t, i18n } = useLingui();
  const tier = sharedCardTier(shared);
  const accent = tierAccentRgb(tier);
  const tierLabel = shared.card.tierLabel ?? MANIA_TIER_STYLES[tier].label;
  const odds = shared.goatPull ? goatPullOdds(shared.goatPull.packType) : null;
  const exactPull = shared.pullEvent && shared.pullEvent.pulledAt > 0 ? shared.pullEvent : null;
  const displayedPullAt = exactPull?.pulledAt ?? shared.card.firstPulledAt;
  const viewerTimeZone = useViewerTimeZone();
  const pullLabel = exactPull
    ? exactPull.isNew ? t`Pulled by` : t`Pulled again by`
    : t`First collected by`;
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
          {Math.round(shared.card.pp).toLocaleString("en-US")}pp
          {shared.card.globalRank > 0 && (
            <> &middot; <Trans>#{shared.card.globalRank.toLocaleString("en-US")} global</Trans></>
          )}
          {shared.owners > 0 && (
            <>
              {" "}&middot;{" "}
              <Plural value={shared.owners} one="in # collection" other="in # collections" />
            </>
          )}
        </div>
        {typeof shared.serial === "number" && shared.serial > 0 && (
          // Pull order, not copy count. Plain ordinal, not "first ever": the
          // permalink describes a holding, and a serial-1 card may by now sit
          // in hundreds of collections.
          <div
            className={`text-[13px] tabular-nums ${shared.serial === 1 ? "font-bold text-amber-300" : "text-osu-f1"}`}
          >
            <Trans>{formatOrdinal(shared.serial)} person to pull this card</Trans>
            {shared.mintedTotal > 0 && shared.mintedTotal !== shared.serial && (
              // Skip the total when it just repeats the serial ("61st ... out of 61").
              <span className="text-osu-f1">
                {" "}
                <Trans>out of {shared.mintedTotal.toLocaleString("en-US")}</Trans>
              </span>
            )}
          </div>
        )}
        <div className="text-[12px] text-osu-f1">
          {pullLabel}{" "}
          {shared.owner.username === UNKNOWN_OWNER_NAME ? (
            <span className="font-bold text-white">{i18n._(UNKNOWN_OWNER_LABEL)}</span>
          ) : (
            <Link
              to="/player/$username"
              params={{ username: shared.owner.username }}
              className="font-bold text-white transition-colors hover:text-osu-pink-light"
            >
              {shared.owner.username}
            </Link>
          )}
          {displayedPullAt > 0 && (
            <span className="tabular-nums">
              {" "}
              <Trans>on {formatDate(new Date(displayedPullAt).toISOString(), viewerTimeZone)}</Trans>
            </span>
          )}
          {shared.card.copies > 1 && (
            <span className="tabular-nums">
              {" "}&middot;{" "}
              <Plural value={shared.card.copies} one="x# copy" other="x# copies" />
            </span>
          )}
        </div>
        {odds && (
          // Only shown when the log says this card arrived as a GOAT, so a
          // ranked-pool pull from before the roster change never claims odds
          // it did not face. The derivation lives in the tooltip: the headline
          // is the pack and the long odds.
          <div
            className="text-[12px] text-osu-f1"
            title={t`${(odds.slotChance * 100).toFixed(2).replace(/\.?0+$/, "")}% GOAT slot, then 1 of ${HONORARY_PACK_POOL.length} on the roster`}
          >
            <Trans>{i18n._(PACK_TYPE_NAME_LABELS[odds.packId])} pack</Trans> &middot;{" "}
            <Trans>
              <span className="font-bold tabular-nums text-amber-200">{odds.percent}</span> pull chance
            </Trans>
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <Link
            to="/packs"
            className="rounded-full bg-osu-pink px-5 py-2 text-[12px] font-bold text-white transition hover:brightness-110"
          >
            <Trans>Open your own packs</Trans>
          </Link>
          <Link
            to="/player/$username"
            params={{ username: shared.card.username }}
            className="rounded-full bg-osu-b3/80 px-5 py-2 text-[12px] font-bold text-white transition hover:bg-osu-b3"
          >
            <Trans>View profile</Trans>
          </Link>
        </div>
      </div>
    </div>
  );
}
