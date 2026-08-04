import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { LogIn, Recycle, Swords } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { OsuTriangleBackdrop } from "../../components/layout/OsuTriangleBackdrop";
import { PageHeader } from "../../components/layout/PageHeader";
import { renderCardSkeletonThumbnail, renderCardThumbnail } from "../../components/packs/cardSnapshot";
import { buildManiaCardRenderDataFromSkills } from "../../components/player/maniacard3d/renderData";
import { CountryFlag } from "../../components/ui/CountryFlag";
import { useAuth } from "../../lib/auth-context";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import {
  fetchLivePackDuel,
  isLiveBackendConfigured,
  type LivePackDuel,
  type LivePackDuelCard,
  type LivePackDuelRound,
} from "../../lib/live-backend";
import { MANIA_TIER_STYLES, type ManiaCardTier } from "../../lib/maniacard";
import {
  duelErrorMessage,
  duelSideOf,
  pickPackDuelStat,
  TRUMP_STAT_LABELS,
  TRUMP_STATS,
  TRUMPS_ROUNDS,
  viewPackDuel,
  type PackDuelSide,
  type TrumpStat,
} from "../../lib/pack-duels";
import { packTypeById, type PackTypeId } from "../../lib/packs";
import { pageSeo } from "../../lib/seo";
import { useWindowActive } from "../../lib/window-activity";

export const Route = createFileRoute("/duel/$duelId")({
  head: ({ match }) => pageSeo({
    title: "Pack duel",
    description: "Two collectors, two hands of maniacards, and the winner keeps the loser's.",
    path: `/duel/${match.params.duelId}`,
    origin: match.context.origin,
    // An unfinished prototype behind an admin gate has no business in search
    // results, and the page shows nothing to anyone else anyway.
    noindex: true,
  }),
  component: DuelPage,
});

/* How often an unfinished duel re-reads itself. Both sides attack at the same
   time, so the wait is only ever for the other player's pick and has to be
   short enough to feel live; polling stops entirely once the duel resolves,
   and pauses while the tab is in the background. */
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

/* Stars are printed to two decimals on the card front and the skills as whole
   numbers, so the board reads them back the same way. */
function statText(card: LivePackDuelCard, stat: TrumpStat): string {
  const value = card.stats[stat];
  if (!Number.isFinite(value)) return "-";
  return stat === "stars" ? value.toFixed(2) : Math.round(value).toLocaleString();
}

/* Card fronts are redrawn from each card's skills snapshot, the same way the
   collection redraws its thumbnails, so a duel page costs no card fetches.
   Cached across renders and duels: the same player shows up on both sides of
   a board often enough. */
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

function CardArt({
  card,
  thumb,
  width = "w-[104px] sm:w-[116px]",
  showName = true,
}: {
  card: LivePackDuelCard | null;
  thumb: string | undefined;
  width?: string;
  /* Off where the name is already printed beside the card, so a round row
     does not say it twice. */
  showName?: boolean;
}) {
  return (
    <div className={width}>
      <div
        className="relative overflow-hidden rounded-[10px]"
        style={{ aspectRatio: "5 / 7", boxShadow: "0 10px 26px rgba(0,0,0,0.45)" }}
      >
        {card && thumb ? (
          <img src={thumb} alt={`${card.username} maniacard`} className="h-full w-full object-cover" draggable={false} />
        ) : (
          <div className="h-full w-full bg-osu-b4/60" />
        )}
      </div>
      {card && showName && (
        <div className="mt-1.5 flex items-center justify-center gap-1">
          <CountryFlag code={card.countryCode} size="xs" decorative />
          <span className="truncate text-[12px] font-bold text-white">{card.username}</span>
        </div>
      )}
    </div>
  );
}

/* One finished round: the two cards that met, what each side attacked with,
   and whether it landed. */
function PlayedRound({
  round,
  challengerCard,
  opponentCard,
  thumbs,
}: {
  round: LivePackDuelRound;
  challengerCard: LivePackDuelCard | undefined;
  opponentCard: LivePackDuelCard | undefined;
  thumbs: Map<string, string>;
}) {
  const side = (card: LivePackDuelCard | undefined, stat: TrumpStat | null, landed: boolean, mirrored: boolean) => (
    <div className={`flex flex-1 items-center gap-2.5 ${mirrored ? "flex-row-reverse text-right" : ""}`}>
      <CardArt
        card={card ?? null}
        thumb={card ? thumbs.get(thumbKey(card)) : undefined}
        width="w-[52px]"
        showName={false}
      />
      <div className="min-w-0">
        <div className="truncate text-[12px] font-bold text-white">{card?.username ?? "?"}</div>
        <div className={`text-[12px] font-semibold tabular-nums ${landed ? "text-osu-pink" : "text-osu-f1"}`}>
          {stat ? `${TRUMP_STAT_LABELS[stat]} ${card ? statText(card, stat) : "-"}` : "-"}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex items-center gap-3 border-t border-osu-b3/30 py-3">
      <span className="w-8 shrink-0 text-[11px] font-semibold text-osu-f1">R{round.round + 1}</span>
      {side(challengerCard, round.challengerStat, round.challengerPoint, false)}
      <span className="shrink-0 text-[11px] font-bold tabular-nums text-white">
        {(round.challengerPoint ? 1 : 0)}-{(round.opponentPoint ? 1 : 0)}
      </span>
      {side(opponentCard, round.opponentStat, round.opponentPoint, true)}
    </div>
  );
}

function DuelPage() {
  const { duelId } = Route.useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const windowActive = useWindowActive();
  const [duel, setDuel] = useState<LivePackDuel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "joining" | "picking">(null);
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
      // own hand; the public read hides every card still face down.
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

  const runAction = async (kind: "joining" | "picking", action: () => Promise<void>) => {
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

  /* Answering means opening a real pack of the same type: the cards land in
     your collection first and then go on the line, which is the only way a
     duel for keeps is symmetrical. The packs page owns opening a pack (the
     wallet, the charge, the reveal, the pull log), so answering happens
     there and comes back here with a hand. */
  const answerWithPack = () => {
    if (!duel) return;
    void navigate({ to: "/packs", search: { duel: duelId } });
  };

  const attack = (stat: TrumpStat) => {
    if (!duel) return;
    const round = duel.currentRound;
    void runAction("picking", async () => {
      const result = await pickPackDuelStat({ data: { duelId, round, stat } });
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

  /* Dev self-duel: both seats are the same account, so the side still owing an
     attack this round is the one a pick lands on. */
  const selfDuel = Boolean(
    duel && viewerId && duel.challenger.userId === viewerId && duel.opponent.userId === viewerId,
  );
  const liveRound = duel && duel.status === "open" ? duel.rounds[duel.currentRound] : undefined;
  const mySide: PackDuelSide | null = duel && selfDuel
    ? (liveRound?.challengerPicked ? "opponent" : "challenger")
    : side;
  const myCard = duel && mySide ? duel[mySide].cards[duel.currentRound] : undefined;
  const myPick = liveRound ? (mySide === "challenger" ? liveRound.challengerStat : liveRound.opponentStat) : null;
  const theirPicked = liveRound
    ? (mySide === "challenger" ? liveRound.opponentPicked : liveRound.challengerPicked)
    : false;
  const iPicked = liveRound
    ? (mySide === "challenger" ? liveRound.challengerPicked : liveRound.opponentPicked)
    : false;
  /* Your attack is live while the duel is open, you hold a seat, both seats
     are filled, and you have not already attacked this round. */
  const canAttack = Boolean(duel && duel.status === "open" && mySide && duel.opponent.userId && liveRound && !iPicked && myCard);
  /* Dev only: the challenger may also take the other seat. */
  const canTakeOtherSeat = Boolean(
    duel && duel.status === "open" && !duel.opponent.userId && auth.viewer && (!side || DEV_SELF_DUEL),
  );

  /* Which stats each side has already spent. Read straight off the rounds,
     which the server has already redacted: your own picks are all visible to
     you, and of theirs only the ones whose round is over. So the last round is
     played with both sides knowing exactly what the other has left. */
  const statsSpentBy = (target: PackDuelSide): TrumpStat[] =>
    (duel?.rounds ?? [])
      .map((entry) => (target === "challenger" ? entry.challengerStat : entry.opponentStat))
      .filter((stat): stat is TrumpStat => stat !== null);
  const mySpent = mySide ? statsSpentBy(mySide) : [];
  const theirSpent = mySide ? statsSpentBy(mySide === "challenger" ? "opponent" : "challenger") : [];
  const myShards = duel && mySide ? duel[mySide].shards : 0;

  const outcomeFor = (target: PackDuelSide): "won" | "lost" | "tie" | null => {
    if (!duel || duel.status !== "resolved" || !duel.winner) return null;
    if (duel.winner === "tie") return "tie";
    return duel.winner === target ? "won" : "lost";
  };

  const playedRounds = duel?.rounds.filter((round) => round.resolved) ?? [];

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
                  {duel.roundCount || TRUMPS_ROUNDS} rounds, one card each, and you can only attack with each stat
                  once. Both of you pick at the same time, and an attack lands if your card beats theirs on the
                  stat you chose.
                </div>
                <div className="mt-1 text-[12px] text-osu-f1">
                  Their card stays face down until the round is over, so the question is which of your cards
                  should spend your best stat. Both hands are on the line: the winner keeps the loser's cards.
                </div>

                {/* The score, which is the only number that decides this. */}
                <div className="mt-7 flex items-center gap-4">
                  <div className="flex-1">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-f1">
                      {mySide === "challenger" ? "You" : "Challenger"}
                    </div>
                    <div className="mt-0.5 flex items-baseline gap-2">
                      <span className="truncate text-lg font-bold text-white">
                        {duel.challenger.username ?? "Waiting"}
                      </span>
                      {outcomeFor("challenger") === "won" && (
                        <span className="text-[11px] font-bold uppercase tracking-wide text-osu-pink">won</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-baseline gap-2 text-3xl font-bold tabular-nums text-white">
                    <span>{duel.challenger.score}</span>
                    <Swords className="h-5 w-5 shrink-0 text-osu-f1" aria-hidden="true" />
                    <span>{duel.opponent.score}</span>
                  </div>
                  <div className="flex-1 text-right">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-f1">
                      {mySide === "opponent" ? "You" : "Opponent"}
                    </div>
                    <div className="mt-0.5 flex items-baseline justify-end gap-2">
                      {outcomeFor("opponent") === "won" && (
                        <span className="text-[11px] font-bold uppercase tracking-wide text-osu-pink">won</span>
                      )}
                      <span className="truncate text-lg font-bold text-white">
                        {duel.opponent.username ?? "Waiting"}
                      </span>
                    </div>
                  </div>
                </div>

                {duel.status === "resolved" && duel.winner === "tie" && (
                  <div className="mt-3 text-[12px] font-bold text-osu-f1">Dead heat, down to the last card.</div>
                )}
                {duel.status === "resolved" && duel.spoils && (
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, delay: 0.1 }}
                    className="mt-3 text-[13px] font-bold text-white"
                  >
                    {(() => {
                      const won = mySide !== null && duel.spoils.winner === mySide;
                      const cards = duel.spoils.cards.filter((entry) => entry.shards === 0);
                      const names = cards.map((entry) => entry.username).join(", ");
                      const shards = duel.spoils.shards;
                      const winnerName =
                        duel[duel.spoils.winner].username ?? (duel.spoils.winner === "challenger" ? "The challenger" : "The opponent");
                      if (!mySide) {
                        return `${winnerName} took ${cards.length} card${cards.length === 1 ? "" : "s"}: ${names}`;
                      }
                      return won
                        ? `You took ${cards.length} card${cards.length === 1 ? "" : "s"}${names ? `: ${names}` : ""}${
                            shards > 0 ? ` (+${shards} shards for the ones they had already recycled)` : ""
                          }`
                        : `They took ${cards.length} card${cards.length === 1 ? "" : "s"} out of your collection${
                            names ? `: ${names}` : ""
                          }`;
                    })()}
                  </motion.div>
                )}
                {duel.status === "resolved" && myShards > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, delay: 0.15 }}
                    className="mt-3 flex items-center gap-1.5 text-[12px] font-bold text-emerald-400"
                  >
                    <Recycle className="h-3.5 w-3.5" />
                    <span className="tabular-nums">+{myShards}</span>
                    <span>shards</span>
                  </motion.div>
                )}

                {/* The round being played: your card, the four numbers on it,
                    and the card you are guessing against. */}
                {duel.status === "open" && duel.opponent.userId && liveRound && (
                  <div className="mt-8">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-f1">
                      Round {duel.currentRound + 1} of {duel.roundCount}
                    </div>
                    <div className="mt-3 flex items-start gap-5 sm:gap-8">
                      <CardArt card={myCard ?? null} thumb={myCard ? thumbs.get(thumbKey(myCard)) : undefined} />
                      <div className="min-w-0 flex-1">
                        {canAttack && myCard ? (
                          <>
                            <div className="text-[13px] font-bold text-white">
                              Attack with{" "}
                              <span className="font-semibold text-osu-f1">
                                ({TRUMP_STATS.length - mySpent.length} left)
                              </span>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {TRUMP_STATS.map((stat) => {
                                const spent = mySpent.includes(stat);
                                return (
                                  <motion.button
                                    key={stat}
                                    type="button"
                                    onClick={() => attack(stat)}
                                    disabled={busy !== null || spent}
                                    whileTap={spent || busy !== null ? undefined : { scale: 0.94 }}
                                    className={`rounded-full border px-4 py-2 text-[13px] font-bold transition-colors ${
                                      spent
                                        ? "border-osu-b3/20 text-osu-f1/40 line-through"
                                        : busy === null
                                          ? "border-osu-b3/50 text-white hover:border-osu-pink hover:bg-osu-pink/10 cursor-pointer"
                                          : "border-osu-b3/30 text-osu-f1"
                                    }`}
                                  >
                                    {TRUMP_STAT_LABELS[stat]}
                                    <span
                                      className="ml-1.5 tabular-nums"
                                      style={spent ? undefined : { color: tierColor(myCard) }}
                                    >
                                      {statText(myCard, stat)}
                                    </span>
                                  </motion.button>
                                );
                              })}
                            </div>
                            {theirSpent.length > 0 && (
                              <div className="mt-2.5 text-[12px] text-osu-f1">
                                They have spent {theirSpent.map((stat) => TRUMP_STAT_LABELS[stat]).join(", ")}.
                              </div>
                            )}
                            {theirPicked && (
                              <div className="mt-3 text-[12px] text-osu-f1">
                                They have already locked one in.
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="text-[13px] font-bold text-osu-f1">
                            {myPick
                              ? `You attacked with ${TRUMP_STAT_LABELS[myPick]}. Waiting for them.`
                              : mySide
                                ? "Waiting for the other player."
                                : "Two collectors are playing this one out."}
                          </div>
                        )}
                      </div>
                      <CardArt card={null} thumb={undefined} />
                    </div>
                  </div>
                )}

                {duel.status === "open" && !duel.opponent.userId && (
                  <div className="mt-8 text-[13px] font-bold text-osu-f1">
                    {side === "challenger"
                      ? `Your ${duel.challenger.cardCount} cards are sealed until someone takes the other seat.`
                      : `${duel.challenger.username ?? "The challenger"} has ${duel.challenger.cardCount} card${
                          duel.challenger.cardCount === 1 ? "" : "s"
                        } on the line. Open a ${packTypeById(duel.packType as PackTypeId).name} pack to match it.`}
                  </div>
                )}

                {playedRounds.length > 0 && (
                  <div className="mt-9">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-f1">
                      {duel.status === "resolved" ? "How it went" : "Played so far"}
                    </div>
                    <div className="mt-2">
                      <AnimatePresence initial={false}>
                        {playedRounds.map((round) => (
                          <motion.div
                            key={round.round}
                            // A round that has just resolved slides in under the
                            // board, so the reveal is something you watch land.
                            initial={{ opacity: 0, y: -10 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.3, ease: [0.3, 0.7, 0.2, 1] }}
                          >
                            <PlayedRound
                              round={round}
                              challengerCard={duel.challenger.cards[round.round]}
                              opponentCard={duel.opponent.cards[round.round]}
                              thumbs={thumbs}
                            />
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                  </div>
                )}

                <div className="mt-10 flex flex-wrap items-center gap-3">
                  {canTakeOtherSeat && (
                    <button
                      type="button"
                      onClick={answerWithPack}
                      disabled={busy !== null}
                      className={`rounded-full px-7 py-2.5 text-sm font-bold text-white transition ${
                        busy === null ? "bg-osu-pink hover:brightness-110 cursor-pointer" : "bg-osu-b4/60"
                      }`}
                    >
                      {busy === "joining" ? "Opening your pack..." : "Answer with your own pack"}
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
