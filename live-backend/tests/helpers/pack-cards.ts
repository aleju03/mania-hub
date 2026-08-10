import type { Db } from "../../src/db.js";
import { exec } from "../../src/db.js";
import { packCardKey } from "../../src/features/pack-wallets.js";

/* Seeds one held card the way the sync path would: the variant's face in the
   pack_cards catalog (shared by every owner) and this owner's ownership row in
   pack_collection_cards. Tests used to write one fat row, so this keeps the
   old one-call shape rather than making every fixture know about the split. */
export interface SeedCollectionCardOptions {
  copies?: number;
  recycledCopies?: number;
  tier?: string | null;
  tierLabel?: string | null;
  username?: string;
  avatarUrl?: string;
  countryCode?: string;
  skillsJson?: string | null;
  pp?: number;
  globalRank?: number;
  firstPulledAt?: number;
  lastPulledAt?: number;
  updatedAt?: number;
}

export async function seedCollectionCard(
  db: Db,
  ownerUserId: number,
  cardUserId: number,
  options: SeedCollectionCardOptions = {},
): Promise<void> {
  const {
    copies = 1,
    recycledCopies = 0,
    tier = "rare",
    tierLabel = tier,
    username = `player${cardUserId}`,
    avatarUrl = "",
    countryCode = "CR",
    skillsJson = null,
    pp = 1000,
    globalRank = 500,
    firstPulledAt = 1000,
    lastPulledAt = 2000,
    updatedAt = 2000,
  } = options;
  const cardKey = packCardKey(cardUserId, tier);
  await seedCardCatalogEntry(db, cardUserId, { tier, tierLabel, username, avatarUrl, countryCode, updatedAt });
  let skillsId: number | null = null;
  if (skillsJson != null) {
    await exec(db, "insert or ignore into pack_card_skills (skills_json) values (?)", [skillsJson]);
    skillsId = Number((await exec(db, "select id from pack_card_skills where skills_json = ?", [skillsJson])).rows[0]?.id) || null;
  }
  await exec(
    db,
    `insert into pack_collection_cards (
       owner_user_id, card_user_id, card_key, tier, skills_id, pp, global_rank,
       copies, recycled_copies, first_pulled_at, last_pulled_at, updated_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ownerUserId, cardUserId, cardKey, tier, skillsId, pp, globalRank, copies, recycledCopies, firstPulledAt, lastPulledAt, updatedAt],
  );
}

/* The catalog half on its own, for a fixture that writes its ownership row by
   hand (a rekey/rebuild test, say) but still needs the card to have a face. */
export async function seedCardCatalogEntry(
  db: Db,
  cardUserId: number,
  options: Omit<SeedCollectionCardOptions, "copies" | "recycledCopies" | "firstPulledAt" | "lastPulledAt"> = {},
): Promise<void> {
  const {
    tier = "rare",
    tierLabel = tier,
    username = `player${cardUserId}`,
    avatarUrl = "",
    countryCode = "CR",
    updatedAt = 2000,
  } = options;
  await exec(
    db,
    `insert or replace into pack_cards (
       card_key, tier, card_user_id, username, avatar_url, country_code, tier_label, updated_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [packCardKey(cardUserId, tier), tier ?? "", cardUserId, username, avatarUrl, countryCode, tierLabel, updatedAt],
  );
}

/* One owner's stored card as the old flat row: ownership columns joined to the
   variant's catalog face, so assertions can keep reading `username`,
   `skills_json` and the rest off a single row. */
export async function readStoredCard(
  db: Db,
  ownerUserId: number,
  cardKey: string,
): Promise<Record<string, unknown> | undefined> {
  return (await exec(
    db,
    `select pack_collection_cards.*,
       pc.username as username, pc.avatar_url as avatar_url, pc.country_code as country_code,
       pc.tier_label as tier_label, sk.skills_json as skills_json
     from pack_collection_cards
     left join pack_cards pc
       on pc.card_key = pack_collection_cards.card_key
       and pc.tier = coalesce(pack_collection_cards.tier, '')
     left join pack_card_skills sk on sk.id = pack_collection_cards.skills_id
     where pack_collection_cards.owner_user_id = ? and pack_collection_cards.card_key = ?`,
    [ownerUserId, cardKey],
  )).rows[0] as Record<string, unknown> | undefined;
}
