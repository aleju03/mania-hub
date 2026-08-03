import { createFileRoute, Link } from "@tanstack/react-router";
import { LogIn, Swords } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { OsuTriangleBackdrop } from "../../components/layout/OsuTriangleBackdrop";
import { PageHeader } from "../../components/layout/PageHeader";
import { renderCardSkeletonThumbnail, renderCardThumbnail } from "../../components/packs/cardSnapshot";
import { mintDuelCards } from "../../components/packs/duelMint";
import { buildManiaCardRenderDataFromSkills } from "../../components/player/maniacard3d/renderData";
import { CountryFlag } from "../../components/ui/CountryFlag";
import { useAuth } from "../../lib/auth-context";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import {
  fetchLivePackDuel,
  isLiveBackendConfigured,
  warmLivePackPlayers,
  type LivePackDuel,
  type LivePackDuelCard,
} from "../../lib/live-backend";
import { MANIA_TIER_STYLES, type ManiaCardTier } from "../../lib/maniacard";
import {
  duelErrorMessage,
  duelSideOf,
  hitPackDuel,
  joinPackBlackjack,
  joinPackDuel,
  standPackDuel,
  viewPackDuel,
  type PackDuelSide,
} from "../../lib/pack-duels";
import { drawPackPlayers, packTypeById, type PackTypeId } from "../../lib/packs";
import { pageSeo } from "../../lib/seo";
import { useWindowActive } from "../../lib/window-activity";

export const Route = createFileRoute("/duel/$duelId")({
  head: ({ match }) => pageSeo({
    title: "Pack duel",
    description: "Two collectors, two hands of maniacards, one score.",
    path: `/duel/${match.params.duelId}`,
    origin: match.context.origin,
    // An unfinished prototype behind an admin gate has no business in search
    // results, and the page shows nothing to anyone else anyway.
    noindex: true,
  }),
  component: DuelPage,
});

/* How often an unfinished duel re-reads itself. A draft is a turn-based game
   played over a link, so the wait for the other side to pick has to be short
   enough to feel live; polling stops entirely once the duel resolves, and
   pauses while the tab is in the background. */
const DUEL_POLL_MS = 3000;

/* Dev only: lets the challenger take the other seat and keep picking, so a
   whole duel can be played through with one osu! login. Vite strips the DEV
   branch from production builds, and the backend refuses a self-duel outside
   its own dev environment regardless, so this cannot leak to the live site. */
const DEV_SELF_DUEL = import.meta.env.DEV;

function cardTier(card: LivePackDuelCard): ManiaCardTier {
  return card.tier && card.tier in MANIA_TIER_STYLES ? (card.tier as ManiaCardTier) : "common";
}

function tierColor(card: LivePackDuelCard): string {
  const match = MANIA_TIER_STYLES[cardTier(card)].badgeHalo.match(/([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  return match ? `rgb(${match[1]}, ${match[2]}, ${match[3]})` : "rgb(226, 232, 240)";
}

/* Card fronts are redrawn from each card's skills snapshot, the same way the
   collection redraws its thumbnails, so a duel page costs no card fetches.
   Cached across renders and duels: the same player shows up on both sides of
   a draft board. */
const duelThumbCache = new Map<string, string>();

function thumbKey(card: LivePackDuelCard): string {
  return `${card.userId}:${card.tier ?? "none"}`;
}

function useDuelThumbnails(cards: LivePackDuelCard[]): Map<string, string> {
  const [thumbs, setThumbs] = useState<Map<string, string>>(() => new Map(duelThumbCache));
  const keys = cards.map(thumbKey).join(",");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const card of cards) {
        const key = thumbKey(card);
        if (duelThumbCache.has(key)) continue;
        const skills = card.skills;
        let url: string | null = null;
        if (skills && Number.isFinite(skills.cardPower)) {
          const data = buildManiaCardRenderDataFromSkills({
            user: {
              id: card.userId,
              username: card.username,
              avatar_url: card.avatarUrl,
              country_code: card.countryCode,
              statistics: { global_rank: card.globalRank, pp: card.pp },
            },
            skills,
            tierOverride: cardTier(card),
          });
          url = await renderCardThumbnail(data, 240).catch(() => null);
        }
        url ??= renderCardSkeletonThumbnail(cardTier(card), 240);
        if (cancelled) return;
        if (url) {
          duelThumbCache.set(key, url);
          setThumbs(new Map(duelThumbCache));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);

  return thumbs;
}

function DuelCard({
  card,
  thumb,
  showValue,
  dimmed,
  onPick,
}: {
  card: LivePackDuelCard;
  thumb: string | undefined;
  /* Blackjack counts stars, a challenge counts card power. */
  showValue?: boolean;
  dimmed?: boolean;
  onPick?: () => void;
}) {
  const body = (
    <>
      <div
        className="relative overflow-hidden rounded-[10px]"
        style={{
          aspectRatio: "5 / 7",
          boxShadow: "0 10px 26px rgba(0,0,0,0.45)",
          opacity: dimmed ? 0.35 : 1,
        }}
      >
        {thumb ? (
          <img src={thumb} alt={`${card.username} maniacard`} className="h-full w-full object-cover" draggable={false} />
        ) : (
          <div className="h-full w-full bg-osu-b4/70" />
        )}
      </div>
      <div className="mt-1.5 text-center">
        <div className="flex items-center justify-center gap-1">
          <CountryFlag code={card.countryCode} size="xs" decorative />
          <span className="truncate text-[12px] font-bold text-white">{card.username}</span>
        </div>
        <div className="text-[13px] font-bold tabular-nums" style={{ color: tierColor(card) }}>
          {showValue ? card.value.toFixed(2) : Math.round(card.cardPower).toLocaleString()}
          <span className="ml-1 text-[10px] font-semibold text-osu-f1">{showValue ? "\u2605" : "power"}</span>
        </div>
      </div>
    </>
  );

  if (!onPick) return <div className="w-[104px] sm:w-[116px]">{body}</div>;
  return (
    <button
      type="button"
      onClick={onPick}
      className="w-[104px] cursor-pointer transition-transform duration-150 hover:-translate-y-1 sm:w-[116px]"
      aria-label={`Draft ${card.username}`}
    >
      {body}
    </button>
  );
}

function SideColumn({
  label,
  side,
  blackjack,
  thumbs,
  outcome,
}: {
  label: string;
  side: LivePackDuel["challenger"];
  blackjack: boolean;
  thumbs: Map<string, string>;
  outcome: "won" | "lost" | "tie" | null;
}) {
  return (
    <div className="flex-1">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-f1">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="truncate text-lg font-bold text-white">{side.username ?? "Waiting"}</span>
        {outcome === "won" && <span className="text-[11px] font-bold uppercase tracking-wide text-osu-pink">won</span>}
        {outcome === "tie" && <span className="text-[11px] font-bold uppercase tracking-wide text-osu-f1">tie</span>}
        {side.bust && <span className="text-[11px] font-bold uppercase tracking-wide text-osu-pink-light">bust</span>}
      </div>
      <div className="flex items-baseline gap-1.5">
        {/* A hidden hand shows its size, never its total: that number is the
            whole thing the other player must not know yet. */}
        <span className="text-3xl font-bold text-white tabular-nums">
          {side.hidden ? "?" : blackjack ? side.score.toFixed(2) : side.score.toLocaleString()}
        </span>
        <span className="text-[11px] text-osu-f1">
          {blackjack ? `${side.cardCount} card${side.cardCount === 1 ? "" : "s"}` : "total power"}
        </span>
        {blackjack && side.done && !side.bust && (
          <span className="text-[11px] text-osu-f1">standing</span>
        )}
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        {side.hidden
          ? Array.from({ length: side.cardCount }, (_, index) => (
              <div
                key={`hidden-${index}`}
                className="w-[104px] rounded-[10px] bg-osu-b4/50 sm:w-[116px]"
                style={{ aspectRatio: "5 / 7" }}
                aria-hidden="true"
              />
            ))
          : side.cards.map((card, index) => (
              <DuelCard
                key={`${card.userId}-${index}`}
                card={card}
                thumb={thumbs.get(thumbKey(card))}
                showValue={blackjack}
              />
            ))}
      </div>
    </div>
  );
}

function DuelPage() {
  const { duelId } = Route.useParams();
  const auth = useAuth();
  const windowActive = useWindowActive();
  const [duel, setDuel] = useState<LivePackDuel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "accepting" | "joining" | "moving">(null);
  const [copied, setCopied] = useState(false);
  const busyRef = useRef(false);

  /* Prototype gate: the mode is unfinished, so it stays admin-only. The duel
     server functions refuse a non-admin caller too, so this is the curtain
     rather than the lock. */
  const canDuel = canUseAdminFeatures(auth);

  const load = useCallback(async () => {
    if (!canDuel) return;
    if (!isLiveBackendConfigured()) {
      setLoadError("Duels need the live backend.");
      return;
    }
    try {
      // Signed in, the authenticated read is the one that can show you your
      // own hand; the public read hides every hand still in play.
      if (auth.viewer) {
        const seat = await viewPackDuel({ data: { duelId } });
        if (seat.ok) {
          setDuel(seat.duel);
          setLoadError(null);
          return;
        }
        if (seat.error !== "not_found") {
          setDuel(await fetchLivePackDuel(duelId));
          setLoadError(null);
          return;
        }
        setLoadError("That duel does not exist.");
        return;
      }
      setDuel(await fetchLivePackDuel(duelId));
      setLoadError(null);
    } catch {
      setLoadError("That duel does not exist.");
    }
  }, [auth.viewer, canDuel, duelId]);

  useEffect(() => {
    void load();
  }, [load]);

  // An unfinished duel is waiting on the other side, so it re-reads itself
  // until it resolves. A finished one never polls again.
  useEffect(() => {
    if (!canDuel || !duel || duel.status === "resolved" || !windowActive) return;
    const timer = window.setInterval(() => {
      if (!busyRef.current) void load();
    }, DUEL_POLL_MS);
    return () => window.clearInterval(timer);
  }, [canDuel, duel, windowActive, load]);

  const viewerId = auth.viewer?.id ?? null;
  const side = duel ? duelSideOf(duel, viewerId) : null;

  const runAction = async (kind: "accepting" | "joining" | "moving", action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(kind);
    setActionError(null);
    try {
      await action();
    } catch {
      setActionError("That did not go through. Try again.");
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  /* Answering a challenge: your own pack of the same type, dealt and minted
     here, then submitted. Nothing enters your collection. */
  const acceptChallenge = () => {
    if (!duel) return;
    void runAction("accepting", async () => {
      const type = packTypeById(duel.packType as PackTypeId);
      const draw = await drawPackPlayers(Math.random, {
        topFraction: type.topFraction,
        count: type.cardCount,
        honoraryChance: type.honoraryChance,
        // Answering a challenge deals throwaway cards, so it never falls back
        // to the osu! API draw the way a real pack does.
        poolOnly: true,
      });
      if (isLiveBackendConfigured()) {
        void warmLivePackPlayers(draw.players.map((player) => player.user.id)).catch(() => {});
      }
      const cards = await mintDuelCards(draw.players);
      if (cards.length === 0) {
        setActionError("None of those cards would mint. Try again.");
        return;
      }
      const result = await joinPackDuel({ data: { duelId, cards } });
      if (result.ok) setDuel(result.duel);
      else setActionError(duelErrorMessage(result.error));
    });
  };

  const takeBlackjackSeat = () => {
    void runAction("joining", async () => {
      const result = await joinPackBlackjack({ data: { duelId } });
      if (result.ok) setDuel(result.duel);
      else setActionError(duelErrorMessage(result.error));
    });
  };

  const move = (action: "hit" | "stand") => {
    void runAction("moving", async () => {
      const result = action === "hit"
        ? await hitPackDuel({ data: { duelId } })
        : await standPackDuel({ data: { duelId } });
      if (result.ok) setDuel(result.duel);
      else {
        setActionError(duelErrorMessage(result.error));
        await load();
      }
    });
  };

  const copyLink = () => {
    if (typeof window === "undefined") return;
    void navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  const visibleCards = duel ? [...duel.challenger.cards, ...duel.opponent.cards] : [];
  const thumbs = useDuelThumbnails(visibleCards);

  const blackjack = duel?.kind === "blackjack";
  /* Dev self-duel: both seats are the same account, so the hand still in play
     is the one your moves land on. */
  const selfDuel = Boolean(
    duel && viewerId && duel.challenger.userId === viewerId && duel.opponent.userId === viewerId,
  );
  const mySide: PackDuelSide | null = duel && selfDuel
    ? (duel.challenger.done ? "opponent" : "challenger")
    : side;
  const myHand = duel && mySide ? duel[mySide] : null;
  /* Your hand is live while the duel is open, you hold a seat, both seats are
     filled, and you have neither stood nor busted. */
  const canMove = Boolean(
    duel && blackjack && duel.status === "open" && myHand && !myHand.done && duel.opponent.userId,
  );
  /* Dev only: the challenger may answer or seat themselves. */
  const canTakeOtherSeat = Boolean(duel && duel.status === "open" && auth.viewer && (!side || DEV_SELF_DUEL));

  const outcomeFor = (target: PackDuelSide): "won" | "lost" | "tie" | null => {
    if (!duel || duel.status !== "resolved" || !duel.winner) return null;
    if (duel.winner === "tie") return "tie";
    return duel.winner === target ? "won" : "lost";
  };

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col overflow-clip bg-osu-b5">
        <OsuTriangleBackdrop />
        <div className="relative z-10 flex flex-1 flex-col">
          <PageHeader iconSrc="/images/icons/packs.svg" title="Pack duel" />
          <div className="mx-auto w-full max-w-[960px] flex-1 px-4 py-8 sm:px-5 sm:py-12">
            {!canDuel ? (
              <div className="mx-auto max-w-[420px] py-16 text-center">
                <div className="text-sm font-bold text-white">Pack duels are not open yet</div>
                <div className="mt-2 text-[12px] text-osu-f1">
                  The mode is still being built. Packs are open in the meantime.
                </div>
                <Link
                  to="/packs"
                  className="mt-5 inline-block rounded-full bg-osu-pink px-6 py-2 text-sm font-bold text-white transition hover:brightness-110"
                >
                  Open a pack
                </Link>
              </div>
            ) : loadError ? (
              <div className="mx-auto max-w-[420px] py-16 text-center">
                <div className="text-sm font-bold text-white">{loadError}</div>
                <Link
                  to="/packs"
                  className="mt-5 inline-block rounded-full bg-osu-pink px-6 py-2 text-sm font-bold text-white transition hover:brightness-110"
                >
                  Open a pack
                </Link>
              </div>
            ) : !duel ? (
              <div className="py-16 text-center text-[12px] text-osu-f1">Loading the duel...</div>
            ) : (
              <>
                {/* The rules first: nobody can play a game they have to infer
                    from the pieces. */}
                <div className="text-[13px] text-white">
                  {blackjack ? (
                    <>
                      Blackjack. Get as close to {duel.target} as you can without going over. A card is
                      worth its star rating.
                    </>
                  ) : (
                    <>
                      Both sides open a {packTypeById(duel.packType as PackTypeId).name} pack. Highest total
                      power wins.
                    </>
                  )}
                </div>
                {blackjack && (
                  <div className="mt-1 text-[12px] text-osu-f1">
                    You both play at the same time and neither hand is shown until both of you stop.
                  </div>
                )}

                <div className="mt-7 flex items-start gap-4 sm:gap-8">
                  <SideColumn
                    label={mySide === "challenger" ? "You" : "Challenger"}
                    side={duel.challenger}
                    blackjack={blackjack}
                    thumbs={thumbs}
                    outcome={outcomeFor("challenger")}
                  />
                  <Swords className="mt-8 h-5 w-5 shrink-0 text-osu-f1" aria-hidden="true" />
                  <SideColumn
                    label={mySide === "opponent" ? "You" : "Opponent"}
                    side={duel.opponent}
                    blackjack={blackjack}
                    thumbs={thumbs}
                    outcome={outcomeFor("opponent")}
                  />
                </div>

                {blackjack && duel.status === "open" && (
                  <div className="mt-8 text-[13px] font-bold text-osu-f1">
                    {!duel.opponent.userId
                      ? "Waiting for someone to take the other seat"
                      : canMove
                        ? `Your hand is at ${(myHand?.score ?? 0).toFixed(2)}. Hit or stand.`
                        : myHand?.bust
                          ? "You went over. Waiting for them to finish."
                          : myHand?.done
                            ? "You are standing. Waiting for them to finish."
                            : "Waiting for the other player"}
                  </div>
                )}

                {duel.kind === "challenge" && duel.challenger.hidden ? (
                  <div className="mt-8 text-[12px] text-osu-f1">
                    {side === "challenger"
                      ? `Your ${duel.challenger.cardCount} cards stay sealed until someone answers.`
                      : `${duel.challenger.username ?? "The challenger"} sealed ${duel.challenger.cardCount} card${
                          duel.challenger.cardCount === 1 ? "" : "s"
                        }. Answer to see them.`}
                  </div>
                ) : null}

                {blackjack && canMove && (
                  <div className="mt-6 flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => move("hit")}
                      disabled={busy !== null}
                      className={`rounded-full px-7 py-2.5 text-sm font-bold text-white transition ${
                        busy === null ? "bg-osu-pink hover:brightness-110 cursor-pointer" : "bg-osu-b4/60"
                      }`}
                    >
                      {busy === "moving" ? "Dealing..." : "Hit"}
                    </button>
                    <button
                      type="button"
                      onClick={() => move("stand")}
                      disabled={busy !== null}
                      className="rounded-full border border-osu-b3/50 px-7 py-2.5 text-sm font-bold text-osu-f1 transition-colors hover:border-osu-f1/40 hover:text-white cursor-pointer"
                    >
                      Stand
                    </button>
                  </div>
                )}

                <div className="mt-10 flex flex-wrap items-center gap-3">
                  {canTakeOtherSeat && duel.kind === "challenge" && (
                    <button
                      type="button"
                      onClick={acceptChallenge}
                      disabled={busy !== null}
                      className={`rounded-full px-7 py-2.5 text-sm font-bold text-white transition ${
                        busy === null ? "bg-osu-pink hover:brightness-110 cursor-pointer" : "bg-osu-b4/60"
                      }`}
                    >
                      {busy === "accepting" ? "Opening your pack..." : "Answer with your own pack"}
                    </button>
                  )}
                  {canTakeOtherSeat && blackjack && !duel.opponent.userId && (
                    <button
                      type="button"
                      onClick={takeBlackjackSeat}
                      disabled={busy !== null}
                      className={`rounded-full px-7 py-2.5 text-sm font-bold text-white transition ${
                        busy === null ? "bg-osu-pink hover:brightness-110 cursor-pointer" : "bg-osu-b4/60"
                      }`}
                    >
                      {busy === "joining" ? "Sitting down..." : "Take the other seat"}
                    </button>
                  )}
                  {duel.status === "open" && !auth.viewer && auth.loginAvailable && (
                    <a
                      href={`/api/auth/osu?next=${encodeURIComponent(`/duel/${duelId}`)}`}
                      className="inline-flex items-center gap-1.5 rounded-full bg-osu-pink px-6 py-2.5 text-sm font-bold text-white transition hover:brightness-110"
                    >
                      <LogIn className="h-4 w-4" />
                      Sign in to duel
                    </a>
                  )}
                  {side === "challenger" && duel.status === "open" && (
                    <button
                      type="button"
                      onClick={copyLink}
                      className="rounded-full border border-osu-b3/50 px-6 py-2.5 text-sm font-bold text-osu-f1 transition-colors hover:border-osu-f1/40 hover:text-white cursor-pointer"
                    >
                      {copied ? "Link copied" : "Copy the duel link"}
                    </button>
                  )}
                  <Link
                    to="/packs"
                    className="rounded-full border border-osu-b3/50 px-6 py-2.5 text-sm font-bold text-osu-f1 transition-colors hover:border-osu-f1/40 hover:text-white"
                  >
                    Back to packs
                  </Link>
                </div>

                {actionError && <div className="mt-3 text-[12px] text-osu-pink-light">{actionError}</div>}
                <div className="mt-3 text-[11px] text-osu-f1">
                  Duel cards are not added to anyone's collection.
                  {DEV_SELF_DUEL && side === "challenger" && (
                    <span className="text-amber-300"> Dev build: you can take both seats.</span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
