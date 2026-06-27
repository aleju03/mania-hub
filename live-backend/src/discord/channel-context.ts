import type { Db } from "../db.js";
import { exec } from "../db.js";
import { nowIso } from "../shared/score.js";

// Per-channel "last map shown" memory. Map-bearing commands (/recent, /map,
// /dan) record the beatmap they displayed so /pb, /c and /compare can
// look up a player's score on that map without retyping it. One row per channel,
// overwritten on each new map. Bot-DM / private-channel interactions have no
// channel id; those simply skip recording (and /pb falls back to a helpful
// "run /recent or /map first" notice).

export interface ChannelMapContext {
  beatmapId: number;
  beatmapsetId: number | null;
  title: string | null;
  version: string | null;
}

export async function setChannelMapContext(
  db: Db,
  channelId: string | undefined,
  map: ChannelMapContext,
): Promise<void> {
  if (!channelId || !Number.isFinite(map.beatmapId) || map.beatmapId <= 0) return;
  await exec(
    db,
    `insert into discord_channel_map_context (channel_id, beatmap_id, beatmapset_id, title, version, updated_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict(channel_id) do update set
       beatmap_id = excluded.beatmap_id,
       beatmapset_id = excluded.beatmapset_id,
       title = excluded.title,
       version = excluded.version,
       updated_at = excluded.updated_at`,
    [channelId, Math.floor(map.beatmapId), map.beatmapsetId ?? null, map.title ?? null, map.version ?? null, nowIso()],
  );
}

export async function getChannelMapContext(db: Db, channelId: string | undefined): Promise<ChannelMapContext | null> {
  if (!channelId) return null;
  const row = (await exec(
    db,
    "select beatmap_id, beatmapset_id, title, version from discord_channel_map_context where channel_id = ? limit 1",
    [channelId],
  )).rows[0];
  if (!row) return null;
  const beatmapId = Number(row.beatmap_id);
  if (!Number.isFinite(beatmapId) || beatmapId <= 0) return null;
  return {
    beatmapId,
    beatmapsetId: row.beatmapset_id == null ? null : Number(row.beatmapset_id),
    title: row.title == null ? null : String(row.title),
    version: row.version == null ? null : String(row.version),
  };
}
