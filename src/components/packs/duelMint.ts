import type { LivePackDuelCard } from "#/lib/live-backend";
import type { ManiaSkills } from "#/lib/maniacard";
import { fetchPackPlayerScores, PACK_SCORE_PREFETCH_CONCURRENCY, startBoundedPrefetches, type PackPlayer } from "#/lib/packs";
import { buildManiaCardRenderData } from "../player/maniacard3d/renderData";
import type { RevealedCard } from "./RevealStage";

/* Minting for duels: the same card front the packs page deals, reduced to what
   a duel row stores. Card power is the score a duel is decided on, so a card
   that fails to mint (a player with no fetchable plays) is worth nothing and is
   dropped rather than counted as a zero. */

function toDuelCard(player: PackPlayer, mint: { cardPower: number; tier: string; tierLabel: string; skills: ManiaSkills }): LivePackDuelCard {
  return {
    userId: player.user.id,
    username: player.user.username,
    countryCode: player.user.country_code,
    avatarUrl: player.user.avatar_url,
    tier: mint.tier,
    tierLabel: mint.tierLabel,
    cardPower: mint.cardPower,
    // What a round is decided on: the three skills the card front prints,
    // under the names it prints them under, plus its star average. Nothing
    // here has to be explained at the table, because it is all on the card.
    stats: {
      control: mint.skills.fingerControl,
      speed: mint.skills.speed,
      precision: mint.skills.accuracy,
      stars: Math.round(mint.skills.starAvg * 100) / 100,
    },
    globalRank: player.globalRank,
    pp: player.pp,
    skills: mint.skills,
  };
}

/* A hand already revealed on the packs page: no fetching, the mint is done. */
export function duelCardsFromRevealed(cards: readonly RevealedCard[]): LivePackDuelCard[] {
  const minted: LivePackDuelCard[] = [];
  for (const card of cards) {
    const skills = card.skills;
    if (!skills || !Number.isFinite(skills.cardPower)) continue;
    minted.push(
      toDuelCard(card.player, {
        cardPower: skills.cardPower,
        tier: card.tier ?? "common",
        tierLabel: card.tierLabel ?? "",
        skills,
      }),
    );
  }
  return minted;
}

/* Freshly drawn players, minted for a duel deck. Scores come from the same
   bounded prefetch a pack reveal uses, so a deck costs the backend what one
   Wild pack costs - except that a cold player waits on an osu! fetch, and a
   deck is all cold players at once. onProgress reports each card as it lands
   so the caller can show that rather than a frozen button. */
export async function mintDuelCards(
  players: readonly PackPlayer[],
  onProgress?: (done: number, total: number) => void,
): Promise<LivePackDuelCard[]> {
  const scorePromises = startBoundedPrefetches(
    players,
    (player) => fetchPackPlayerScores(player.user.id),
    PACK_SCORE_PREFETCH_CONCURRENCY,
  );
  let done = 0;
  const minted = await Promise.all(
    players.map(async (player, index) => {
      const scores = await scorePromises[index];
      done += 1;
      onProgress?.(done, players.length);
      if (!scores || scores.length === 0) return null;
      const data = buildManiaCardRenderData({ user: player.user, scores });
      if (data.status !== "ready") return null;
      return toDuelCard(player, {
        cardPower: data.skills.cardPower,
        tier: data.tier,
        tierLabel: data.tierStyle.label,
        skills: data.skills,
      });
    }),
  );
  return minted.filter((card): card is LivePackDuelCard => card !== null);
}
