import { Link } from "@tanstack/react-router";
import { LogIn, Recycle, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MANIA_TIER_STYLES, type ManiaCardTier, type ManiaSkills } from "#/lib/maniacard";
import {
  duplicateShardTotal,
  duplicateShardValue,
  ownedCards,
  shardValueForTier,
  tierRank,
  type CollectedCard,
  type PackWallet,
} from "#/lib/pack-collection";
import { fetchPackPlayerScores } from "#/lib/packs";
import {
  buildManiaCardRenderData,
  buildManiaCardRenderDataFromSkills,
} from "../player/maniacard3d/renderData";
import { CountryFlag } from "../ui/CountryFlag";
import { renderCardThumbnail } from "./cardSnapshot";

export interface CardMint {
  skills: ManiaSkills;
  tier: ManiaCardTier | null;
  tierLabel: string | null;
}

interface CollectionPanelProps {
  wallet: PackWallet | null;
  showLoginNudge: boolean;
  syncStatus: "local" | "syncing" | "synced";
  onRecycleCard: (userId: number) => void;
  onRecycleWhole: (userId: number) => void;
  onRecycleAll: () => void;
  onApplyMint: (userId: number, mint: CardMint) => boolean;
}

/* Real card fronts are redrawn through the maniacard texture pipeline from
   the stored skills snapshot. Rendering is lazy (when the tile scrolls into
   view), throttled, and cached for the session so a big collection doesn't
   redraw on every visit to the page. */
const thumbnailCache = new Map<string, string>();

let activeRenders = 0;
const renderQueue: Array<() => void> = [];
async function throttleRender<T>(task: () => Promise<T>): Promise<T> {
  if (activeRenders >= 3) await new Promise<void>((resolve) => renderQueue.push(resolve));
  activeRenders += 1;
  try {
    return await task();
  } finally {
    activeRenders -= 1;
    renderQueue.shift()?.();
  }
}

function thumbnailKey(card: CollectedCard): string {
  return `${card.userId}:${card.skills ? Math.round(card.skills.cardPower) : "plain"}`;
}

/* Legacy cards (collected before skills snapshots existed) and failed mints
   re-mint themselves when scrolled into view: fetch the player's plays once,
   compute the skills, store them in the wallet. One attempt per session per
   card, two in flight at a time. */
const attemptedBackfills = new Set<number>();
let activeBackfills = 0;
const backfillQueue: Array<() => void> = [];
async function throttleBackfill<T>(task: () => Promise<T>): Promise<T> {
  if (activeBackfills >= 2) await new Promise<void>((resolve) => backfillQueue.push(resolve));
  activeBackfills += 1;
  try {
    return await task();
  } finally {
    activeBackfills -= 1;
    backfillQueue.shift()?.();
  }
}

async function backfillCardMint(card: CollectedCard, onApplyMint: (userId: number, mint: CardMint) => boolean) {
  if (attemptedBackfills.has(card.userId)) return;
  attemptedBackfills.add(card.userId);
  try {
    const scores = await throttleBackfill(() => fetchPackPlayerScores(card.userId));
    const data = buildManiaCardRenderData({
      user: {
        id: card.userId,
        username: card.username,
        avatar_url: card.avatarUrl,
        country_code: card.countryCode,
        statistics: { global_rank: card.globalRank, pp: card.pp },
      },
      scores,
    });
    if (data.status !== "ready") return;
    onApplyMint(card.userId, { skills: data.skills, tier: data.tier, tierLabel: data.tierStyle.label });
  } catch {
    // The sketch tile remains; another session can retry.
    attemptedBackfills.delete(card.userId);
  }
}

/* Placeholder (and fallback for cards without a skills snapshot): a DOM
   sketch of the card in its tier dress. */
function CardSketch({ card }: { card: CollectedCard }) {
  const style = MANIA_TIER_STYLES[card.tier ?? "common"];
  return (
    <div
      className={`relative h-full w-full overflow-hidden rounded-[10px] border bg-gradient-to-br ${style.background} ${style.border}`}
    >
      <div className="pointer-events-none absolute inset-[5px] rounded-[7px] border border-white/25" />
      <img
        src={card.avatarUrl}
        alt=""
        loading="lazy"
        className="absolute left-1/2 top-[8.5%] aspect-square w-[66%] -translate-x-1/2 rounded-[6px] border border-white/30 object-cover"
        draggable={false}
      />
      <div className="absolute inset-x-[7%] top-[60%] flex items-center justify-center gap-1">
        <CountryFlag code={card.countryCode} size="xs" decorative />
        <span className="truncate text-[10px] font-bold text-white" style={{ textShadow: "0 1px 3px rgba(0,0,0,0.6)" }}>
          {card.username}
        </span>
      </div>
      <div
        className="absolute inset-x-0 top-[74%] text-center text-[8px] font-bold uppercase tracking-widest text-white/90"
        style={{ textShadow: "0 1px 3px rgba(0,0,0,0.6)" }}
      >
        {card.tierLabel ?? "unrated"}
      </div>
      <div
        className="absolute inset-x-0 bottom-[5%] text-center text-[8px] font-semibold text-white/70 tabular-nums"
        style={{ textShadow: "0 1px 3px rgba(0,0,0,0.6)" }}
      >
        {Math.round(card.pp).toLocaleString()}pp · #{card.globalRank.toLocaleString()}
      </div>
    </div>
  );
}

function CollectionCardTile({
  card,
  onApplyMint,
}: {
  card: CollectedCard;
  onApplyMint: (userId: number, mint: CardMint) => boolean;
}) {
  const key = thumbnailKey(card);
  const [thumbnail, setThumbnail] = useState<string | null>(() => thumbnailCache.get(key) ?? null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (thumbnailCache.has(key)) {
      setThumbnail(thumbnailCache.get(key) ?? null);
      return;
    }
    setThumbnail(null);
    let cancelled = false;
    const skills = card.skills;
    // With a skills snapshot the real front renders locally; without one the
    // card re-mints itself first (the wallet update re-runs this effect).
    const work = skills
      ? async () => {
          try {
            const data = buildManiaCardRenderDataFromSkills({
              user: {
                id: card.userId,
                username: card.username,
                avatar_url: card.avatarUrl,
                country_code: card.countryCode,
                statistics: { global_rank: card.globalRank, pp: card.pp },
              },
              skills,
            });
            const url = await throttleRender(() => renderCardThumbnail(data, 240));
            thumbnailCache.set(key, url);
            if (!cancelled) setThumbnail(url);
          } catch {
            // Sketch stays as the fallback.
          }
        }
      : () => backfillCardMint(card, onApplyMint);
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver !== "function") {
      void work();
      return () => {
        cancelled = true;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void work();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(host);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div ref={hostRef} className="relative" style={{ aspectRatio: "5 / 7" }}>
      {thumbnail ? (
        <img
          src={thumbnail}
          alt={`${card.username} maniacard`}
          className="h-full w-full rounded-[10px] object-cover"
          draggable={false}
        />
      ) : (
        <CardSketch card={card} />
      )}
      {card.copies > 1 && (
        <span className="absolute right-1.5 top-1.5 rounded bg-black/70 px-1 py-px text-[10px] font-bold text-white tabular-nums">
          x{card.copies}
        </span>
      )}
    </div>
  );
}

export function CollectionPanel({
  wallet,
  showLoginNudge,
  syncStatus,
  onRecycleCard,
  onRecycleWhole,
  onRecycleAll,
  onApplyMint,
}: CollectionPanelProps) {
  const [query, setQuery] = useState("");
  const [tierFilter, setTierFilter] = useState<ManiaCardTier | "all" | "unrated">("all");
  // Recycling the last copy removes the card from the collection, so it
  // takes a second tap to confirm.
  const [confirmUserId, setConfirmUserId] = useState<number | null>(null);
  useEffect(() => {
    if (confirmUserId === null) return;
    const timer = setTimeout(() => setConfirmUserId(null), 3000);
    return () => clearTimeout(timer);
  }, [confirmUserId]);

  if (!wallet) return null;

  const cards = ownedCards(wallet).sort((a, b) => tierRank(b.tier) - tierRank(a.tier) || b.pp - a.pp);
  const ownedTiers = [...new Set(cards.map((card) => card.tier))].sort((a, b) => tierRank(b) - tierRank(a));
  const trimmedQuery = query.trim().toLowerCase();
  const visibleCards = cards.filter((card) => {
    if (trimmedQuery && !card.username.toLowerCase().includes(trimmedQuery)) return false;
    if (tierFilter === "all") return true;
    if (tierFilter === "unrated") return card.tier === null;
    return card.tier === tierFilter;
  });
  const recyclable = duplicateShardTotal(wallet);

  return (
    <section className="mx-auto w-full max-w-[820px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-bold text-white">Collection</h2>
          <span className="text-[12px] text-osu-f1 tabular-nums">
            {cards.length}
            {wallet.poolTotal ? ` / ${wallet.poolTotal.toLocaleString()}` : ""} players
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[12px] text-osu-f1">
            <Recycle className="h-3.5 w-3.5" />
            <span className="font-semibold text-white tabular-nums">{wallet.shards.toLocaleString()}</span>
            shards
          </span>
          {recyclable > 0 && (
            <button
              type="button"
              onClick={onRecycleAll}
              className="rounded-lg border border-osu-pink/30 bg-osu-pink/10 px-2.5 py-1 text-[11px] font-semibold text-osu-pink-light transition-colors hover:border-osu-pink/50 hover:bg-osu-pink/20 hover:text-white cursor-pointer"
            >
              Recycle duplicates +{recyclable}
            </button>
          )}
        </div>
      </div>

      {showLoginNudge ? (
        <div className="mt-2 text-[11px] text-osu-f1">
          Saved in this browser only.{" "}
          <a
            href={`/api/auth/osu?next=${encodeURIComponent("/packs")}`}
            className="inline-flex items-center gap-1 font-semibold text-osu-pink-light hover:text-white hover:underline underline-offset-2"
          >
            <LogIn className="h-3 w-3" />
            Log in with osu!
          </a>{" "}
          to sync your collection across devices.
        </div>
      ) : syncStatus !== "local" ? (
        <div className="mt-2 text-[11px] text-osu-f1">
          {syncStatus === "synced" ? "Synced to your osu! account." : "Syncing to your osu! account..."}
        </div>
      ) : null}

      {cards.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="relative w-[220px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-osu-f1" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="find a card..."
              className="w-full rounded-lg border border-osu-b3/40 bg-osu-b4/40 py-1.5 pl-8 pr-3 text-[12px] text-white placeholder:text-osu-f1/70 outline-none transition-colors focus:border-osu-pink/40"
            />
          </div>
          {ownedTiers.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {(["all", ...ownedTiers] as Array<ManiaCardTier | "all" | null>).map((tier) => {
                const value = tier === null ? "unrated" : tier;
                const selected = tierFilter === value;
                const label = tier === "all" ? "All" : tier === null ? "Unrated" : MANIA_TIER_STYLES[tier].label;
                const colorClass =
                  tier === "all" || tier === null
                    ? selected
                      ? "text-white"
                      : "text-osu-f1"
                    : MANIA_TIER_STYLES[tier].badgeColor;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setTierFilter(selected ? "all" : (value as ManiaCardTier | "all" | "unrated"))}
                    className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors cursor-pointer ${
                      selected
                        ? "border-osu-pink/50 bg-osu-b4"
                        : "border-osu-b3/30 bg-osu-b4/30 hover:bg-osu-b4/70"
                    } ${colorClass}`}
                    aria-pressed={selected}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {cards.length === 0 ? (
        <div className="mt-6 rounded-xl border border-osu-b3/40 bg-osu-b4/40 px-6 py-8 text-center text-[12px] text-osu-f1">
          No cards yet. Open a pack to start your collection.
        </div>
      ) : visibleCards.length === 0 ? (
        <div className="mt-6 rounded-xl border border-osu-b3/40 bg-osu-b4/40 px-6 py-8 text-center text-[12px] text-osu-f1">
          No cards match{trimmedQuery ? ` "${query.trim()}"` : " the selected rarity"}.
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-5">
          {visibleCards.map((card) => {
            const dupValue = duplicateShardValue(card);
            const lastCopyValue = shardValueForTier(card.tier);
            const confirming = confirmUserId === card.userId;
            return (
              <div key={card.userId}>
                <Link
                  to="/player/$username"
                  params={{ username: card.username }}
                  className="block transition-transform duration-150 hover:-translate-y-1"
                  aria-label={`Open ${card.username}'s profile`}
                >
                  <CollectionCardTile card={card} onApplyMint={onApplyMint} />
                </Link>
                {card.copies > 1 ? (
                  <button
                    type="button"
                    onClick={() => onRecycleCard(card.userId)}
                    className="mx-auto mt-1.5 flex items-center gap-1 text-[10px] text-osu-f1 transition-colors hover:text-white cursor-pointer"
                    title={`Recycle ${card.copies - 1} duplicate ${card.copies - 1 === 1 ? "copy" : "copies"}`}
                  >
                    <Recycle className="h-3 w-3" />
                    +{dupValue}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (!confirming) {
                        setConfirmUserId(card.userId);
                        return;
                      }
                      setConfirmUserId(null);
                      onRecycleWhole(card.userId);
                    }}
                    className={`mx-auto mt-1.5 flex items-center gap-1 text-[10px] transition-colors cursor-pointer ${
                      confirming ? "font-bold text-osu-pink-light" : "text-osu-f1/70 hover:text-white"
                    }`}
                    title="Recycle this card (removes it from your collection)"
                  >
                    <Recycle className="h-3 w-3" />
                    {confirming ? `sure? +${lastCopyValue}` : `+${lastCopyValue}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
