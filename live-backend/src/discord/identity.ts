import type { Db } from "../db.js";
import { exec } from "../db.js";
import { nowIso } from "../shared/score.js";

// A saved link between a Discord user and an osu! account. Trust-based: we only
// confirm the osu! account exists when linking (via the osu! API), we do not
// prove the Discord user owns it. That is the standard bar for community stats
// bots and keeps linking a single command instead of an OAuth dance.
export interface DiscordUserLink {
  discordUserId: string;
  osuUserId: number;
  osuUsername: string;
  countryCode: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToLink(row: Record<string, unknown>): DiscordUserLink {
  return {
    discordUserId: String(row.discord_user_id),
    osuUserId: Number(row.osu_user_id),
    osuUsername: String(row.osu_username),
    countryCode: row.country_code == null ? null : String(row.country_code),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function getUserLink(db: Db, discordUserId: string): Promise<DiscordUserLink | null> {
  const result = await exec(db, "select * from discord_user_links where discord_user_id = ?", [discordUserId]);
  const row = result.rows[0];
  return row ? rowToLink(row) : null;
}

// Upserts the link, preserving the original created_at so /whoami can show how
// long it has been set up.
export async function setUserLink(
  db: Db,
  params: { discordUserId: string; osuUserId: number; osuUsername: string; countryCode: string | null },
): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into discord_user_links (discord_user_id, osu_user_id, osu_username, country_code, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict(discord_user_id)
     do update set osu_user_id = excluded.osu_user_id, osu_username = excluded.osu_username,
                   country_code = excluded.country_code, updated_at = excluded.updated_at`,
    [params.discordUserId, params.osuUserId, params.osuUsername, params.countryCode, now, now],
  );
}

export async function removeUserLink(db: Db, discordUserId: string): Promise<boolean> {
  const result = await exec(db, "delete from discord_user_links where discord_user_id = ?", [discordUserId]);
  return Number(result.rowsAffected ?? 0) > 0;
}

export async function countUserLinks(db: Db): Promise<number> {
  const result = await exec(db, "select count(*) as n from discord_user_links");
  return Number(result.rows[0]?.n ?? 0);
}
