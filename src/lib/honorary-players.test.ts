import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HONORARY_PACK_POOL,
  HONORARY_PLAYERS,
  honoraryPlayerById,
  honoraryPlayerByName,
  searchHonoraryPlayers,
} from "./honorary-players";
import { applyHonoraryHit, PACK_TYPES, packTypeById, type PackPlayer } from "./packs";
import { getHonoraryTier, HONORARY_TIER_USER_IDS, MANIA_TIER_STYLES } from "./maniacard";

function poolPlayer(id: number): PackPlayer {
  return {
    user: {
      id,
      username: `player${id}`,
      avatar_url: "",
      country_code: "US",
      statistics: { global_rank: id, pp: 1000 },
    },
    globalRank: id,
    pp: 1000,
  };
}

const pool = [1, 2, 3, 4, 5].map(poolPlayer);

/* rng stub: returns the queued values in order, then 0. */
function rngOf(...values: number[]) {
  let index = 0;
  return () => values[index++] ?? 0;
}

describe("honorary roster", () => {
  it("matches the maniacard honorary tier list exactly", () => {
    expect(HONORARY_PLAYERS.map((player) => player.id).sort()).toEqual(
      [...HONORARY_TIER_USER_IDS.keys()].sort(),
    );
  });

  it("awards the honorary tier to every roster member and nobody else", () => {
    for (const player of HONORARY_PLAYERS) {
      expect(getHonoraryTier(player.id)).toBe("goat");
    }
    expect(getHonoraryTier(2)).toBeNull();
    expect(getHonoraryTier(null)).toBeNull();
  });

  it("has a style defined for the honorary tier", () => {
    expect(MANIA_TIER_STYLES.goat.label).toBe("GOAT");
  });

  it("finds deleted accounts by name, which the osu! search cannot", () => {
    expect(searchHonoraryPlayers("windy").map((player) => player.username)).toContain("WindyS");
    expect(searchHonoraryPlayers("jakads").map((player) => player.username)).toContain("Jakads");
    expect(searchHonoraryPlayers("")).toEqual([]);
    expect(searchHonoraryPlayers("nobodyhere")).toEqual([]);
  });

  /* What stops the GOAT poll nominating someone who is already a GOAT: the
     manual path has a typed name and nothing else, so the match has to survive
     the punctuation a nominator does not reproduce. */
  it("matches a roster member by name past case and punctuation", () => {
    expect(honoraryPlayerByName("Jakads")?.id).toBe(259972);
    expect(honoraryPlayerByName("jak_ads.")?.id).toBe(259972);
    expect(honoraryPlayerByName("[crz] player")?.id).toBe(1089335);
    // Card names count: that is the name the community knows him by.
    expect(honoraryPlayerByName("KaneMining")?.id).toBe(12253636);
    expect(honoraryPlayerByName("silicosis et")?.id).toBe(12253636);
    expect(honoraryPlayerByName("nobodyhere")).toBeNull();
    expect(honoraryPlayerByName("")).toBeNull();
  });

  it("keeps players without a renderable card out of the draw pool", () => {
    const pending = HONORARY_PLAYERS.filter((player) => !player.cardReady);
    for (const player of pending) {
      expect(HONORARY_PACK_POOL.some((entry) => entry.id === player.id)).toBe(false);
      // Still searchable and still GOAT-tiered, just not dealable.
      expect(getHonoraryTier(player.id)).toBe("goat");
    }
    expect(HONORARY_PACK_POOL.length).toBeGreaterThan(0);
  });

  it("serves a same-origin avatar only when osu! lost the image", () => {
    expect(honoraryPlayerById(259972)?.avatarUrl).toBe("/images/archived-players/jakads.jpg");
    // Live account, deleted avatar: the profile still comes from the API.
    expect(honoraryPlayerById(1089335)?.avatarUrl).toBe("/images/archived-players/attang.png");
    expect(honoraryPlayerById(86188)?.avatarUrl).toContain("a.ppy.sh");
  });

  it("checks in every same-origin avatar it points at", () => {
    const local = HONORARY_PLAYERS.filter((player) => player.avatarUrl.startsWith("/"));
    expect(local.length).toBeGreaterThan(0);
    for (const player of local) {
      expect(existsSync(fileURLToPath(new URL(`../../public${player.avatarUrl}`, import.meta.url)))).toBe(true);
    }
  });
});

describe("honorary pack odds", () => {
  it("uses the configured per-pack chances", () => {
    expect(packTypeById("standard").honoraryChance).toBe(0.0025);
    expect(packTypeById("wild").honoraryChance).toBe(0.0075);
    expect(packTypeById("elite").honoraryChance).toBe(0.01);
    expect(packTypeById("legend").honoraryChance).toBe(0.03);
  });

  /* The shard ladder is pinned because it is what keeps a finished collection
     from printing shards: a pack that costs less than its cards recycle for
     is an income source, not a purchase. Wild went 30 -> 45 for exactly that
     reason - ten whole-pool cards recycle for more than 30 once every card it
     deals is a duplicate. Elite went 100 -> 115 when TIER_SHARD_VALUES was
     buffed, because its top-10% slice tracks the ladder's upper half and would
     otherwise pay back ~97% of its own price. Legend has more room above its
     recycle return, so its premium price can come down without becoming an
     income source. Repricing a pack is a deliberate economy change, so it
     should have to come through here. */
  it("prices the shard packs above what their cards recycle for", () => {
    expect(packTypeById("standard").cost).toEqual({ kind: "charge" });
    expect(packTypeById("wild").cost).toEqual({ kind: "shards", amount: 45 });
    expect(packTypeById("4k").cost).toEqual({ kind: "shards", amount: 40 });
    expect(packTypeById("7k").cost).toEqual({ kind: "shards", amount: 60 });
    expect(packTypeById("elite").cost).toEqual({ kind: "shards", amount: 115 });
    expect(packTypeById("legend").cost).toEqual({ kind: "shards", amount: 200 });
  });

  it("defines a chance for every pack type", () => {
    for (const type of PACK_TYPES) {
      expect(type.honoraryChance).toBeGreaterThan(0);
      expect(type.honoraryChance).toBeLessThan(1);
    }
  });

  it("leaves the draw untouched when the roll misses", () => {
    // Roll lands exactly on the threshold, which must not count as a hit.
    expect(applyHonoraryHit(pool, rngOf(0.0025), 0.0025)).toEqual(pool);
    expect(applyHonoraryHit(pool, rngOf(0.9), 0.0025)).toEqual(pool);
  });

  it("replaces the last slot on a hit, leaving earlier slots alone", () => {
    const result = applyHonoraryHit(pool, rngOf(0, 0), 0.0025);
    expect(result.slice(0, -1)).toEqual(pool.slice(0, -1));
    expect(HONORARY_PACK_POOL.some((player) => player.id === result[result.length - 1].user.id)).toBe(true);
  });

  it("never hits when the chance is zero", () => {
    expect(applyHonoraryHit(pool, rngOf(0, 0), 0)).toEqual(pool);
  });

  it("prefers an unowned honorary player when the pack guarantees new cards", () => {
    const owned = new Set(HONORARY_PACK_POOL.slice(1).map((player) => player.id));
    const result = applyHonoraryHit(pool, rngOf(0, 0), 1, owned);
    expect(result[result.length - 1].user.id).toBe(HONORARY_PACK_POOL[0].id);
  });

  it("still deals a duplicate rather than dropping the hit for a complete set", () => {
    const owned = new Set(HONORARY_PACK_POOL.map((player) => player.id));
    const result = applyHonoraryHit(pool, rngOf(0, 0), 1, owned);
    expect(owned.has(result[result.length - 1].user.id)).toBe(true);
  });

  it("does not deal an honorary player already dealt in the same pack", () => {
    const withHonorary = [...pool.slice(0, 4), poolPlayer(HONORARY_PACK_POOL[0].id)];
    const result = applyHonoraryHit(withHonorary, rngOf(0, 0), 1);
    expect(result[result.length - 1].user.id).not.toBe(HONORARY_PACK_POOL[0].id);
  });

  it("carries peak rank and pp onto the dealt card", () => {
    const result = applyHonoraryHit(pool, rngOf(0, 0), 1);
    const dealt = result[result.length - 1];
    const player = honoraryPlayerById(dealt.user.id);
    expect(player).not.toBeNull();
    expect(dealt.user.statistics.pp).toBe(player?.peakPp);
    expect(dealt.user.statistics.global_rank).toBe(player?.peakRank ?? null);
  });

  it("hits at roughly the configured rate over many draws", () => {
    let hits = 0;
    const runs = 20_000;
    let seed = 12345;
    const rng = () => {
      // Deterministic LCG so the assertion can't flake.
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let run = 0; run < runs; run += 1) {
      const result = applyHonoraryHit(pool, rng, 0.03);
      if (result[result.length - 1].user.id !== pool[pool.length - 1].user.id) hits += 1;
    }
    expect(hits / runs).toBeGreaterThan(0.02);
    expect(hits / runs).toBeLessThan(0.04);
  });
});
