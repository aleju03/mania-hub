import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { getModAcronyms, getScoreIdentity, getScoreTimestamp, nowIso } from "../shared/score.js";
import type { OscScore } from "../shared/types.js";

const MAPS_REFRESH_PRIORITY = 20;
const MAPS_FARMED_REFRESH_PRIORITY = 35;
const MAPS_FETCH_CONCURRENCY = 2;
const MAPS_FARMED_SCORE_WINDOW = 200;
const FARMED_SINGLE_PLAYER_PP_MIN = 500;
const USER_FAVOURITES_MAX_PAGES = 10;
const MAPS_FARMED_OVERLAY_META_PREFIX = "maps_farmed_overlay_updated_at:";

export class MapsRosterNotReadyError extends Error {
  constructor(readonly country: string) {
    super(`Roster not ready for ${country}`);
    this.name = "MapsRosterNotReadyError";
  }
}

interface MapsUser {
  id: number;
  username: string;
  avatar_url: string;
}

interface MapsPlayerEntry {
  id: number;
  username: string;
  avatarUrl: string;
  count: number;
}

interface MapsAggregatedBeatmap {
  beatmapId: number;
  version: string;
  difficultyRating: number;
  totalLength: number;
  beatmapsetId: number;
  title: string;
  artist: string;
  creator: string;
  covers: Record<string, string | undefined>;
  status: string;
  globalPlayCount: number;
  totalPlays: number;
  playerCount: number;
  players: MapsPlayerEntry[];
}

interface MapsAggregatedFavourite {
  beatmapsetId: number;
  title: string;
  artist: string;
  creator: string;
  covers: Record<string, string | undefined>;
  status: string;
  globalPlayCount: number;
  globalFavouriteCount: number;
  playerCount: number;
  players: Array<{ id: number; username: string; avatarUrl: string }>;
}

interface MapsFarmedEntry {
  beatmapId: number;
  version: string;
  difficultyRating: number;
  totalLength: number;
  cs: number;
  bpm: number;
  beatmapsetId: number;
  title: string;
  artist: string;
  creator: string;
  covers: Record<string, string | undefined>;
  status: string;
  playerCount: number;
  players: Array<{
    id: number;
    username: string;
    avatarUrl: string;
    mods: string[];
    pp: number;
    scoreUrl: string | null;
    playedAt: string | null;
  }>;
  avgPp: number;
  maxPp: number;
}

interface MapsFavouriteBeatmapset {
  id: number;
  title: string;
  artist: string;
  creator: string;
  covers: Record<string, string | undefined>;
  status: string;
  globalPlayCount: number;
  globalFavouriteCount: number;
  previewUrl: string;
  maniaKeys: number[];
  maniaBeatmaps: Array<{
    id: number;
    version: string;
    difficultyRating: number;
    totalLength: number;
    cs: number;
  }>;
  starMin: number;
  starMax: number;
  bpm: number;
  patterns: string[];
}

interface MapsPlayerFavourites {
  id: number;
  username: string;
  avatarUrl: string;
  beatmapsetIds: number[];
}

export interface CountryMapsData {
  farmed: MapsFarmedEntry[];
  mostPlayed: MapsAggregatedBeatmap[];
  favourites: MapsAggregatedFavourite[];
  favouritesByPlayer: MapsPlayerFavourites[];
  beatmapsetsPool: Record<number, MapsFavouriteBeatmapset>;
  generatedAt: string;
  farmedGeneratedAt: string;
  favouritesGeneratedAt: string;
}

interface CountryMapsFarmedSection {
  farmed: MapsFarmedEntry[];
  generatedAt: string;
}

interface CountryMapsFavouritesSection {
  mostPlayed: MapsAggregatedBeatmap[];
  favourites: MapsAggregatedFavourite[];
  favouritesByPlayer: MapsPlayerFavourites[];
  beatmapsetsPool: Record<number, MapsFavouriteBeatmapset>;
  generatedAt: string;
}

type RawBeatmap = {
  id?: number;
  beatmapset_id?: number;
  difficulty_rating?: number;
  mode?: string;
  status?: string;
  cs?: number;
  bpm?: number;
  total_length?: number;
  version?: string;
  url?: string;
};

type RawBeatmapset = {
  id?: number;
  title?: string;
  artist?: string;
  creator?: string;
  covers?: Record<string, string | undefined>;
  status?: string;
  play_count?: number;
  favourite_count?: number;
  preview_url?: string;
  bpm?: number;
  tags?: string;
  beatmaps?: RawBeatmap[];
};

type RawBeatmapPlaycount = {
  beatmap_id?: number;
  count?: number;
  beatmap?: RawBeatmap;
  beatmapset?: RawBeatmapset;
};

export async function enqueueMapsRefresh(queue: JobQueue, country: string, options: { priority?: number; replaceDone?: boolean } = {}): Promise<void> {
  const normalized = country.toUpperCase();
  await queue.enqueue(
    "refresh_country_maps",
    `maps:${normalized}`,
    { country: normalized },
    { priority: options.priority ?? MAPS_REFRESH_PRIORITY, replaceDone: options.replaceDone ?? true },
  );
}

export async function maybeEnqueueMapsFarmedRefresh(
  db: Db,
  queue: JobQueue,
  country: string,
  score: OscScore,
  marginPp: number,
): Promise<void> {
  if (!isPotentialFarmedScore(score)) return;
  const row = (await exec(
    db,
    "select maps_farmed_min_pp, top_play_min_pp from users where user_id = ?",
    [score.user_id],
  )).rows[0];
  const thresholdSource = row?.maps_farmed_min_pp ?? row?.top_play_min_pp ?? 0;
  const threshold = Math.max(0, Number(thresholdSource ?? 0) - marginPp);
  if ((score.pp ?? 0) < threshold) return;

  const normalized = country.toUpperCase();
  const scoreKey = getMapsFarmedScoreDedupeKey(score);
  await queue.enqueue(
    "refresh_user_maps_farmed_scores",
    `maps-farmed:${normalized}:${score.user_id}:${scoreKey}`,
    { country: normalized, userId: score.user_id, scoreId: scoreKey },
    { priority: MAPS_FARMED_REFRESH_PRIORITY },
  );
}

export async function enqueueMapsRefreshIfDue(
  db: Db,
  queue: JobQueue,
  country: string,
  maxAgeMs: number,
  options: { priority?: number; replaceDone?: boolean } = {},
): Promise<boolean> {
  const normalized = country.toUpperCase();
  const snapshot = await readMapsSnapshot(db, normalized, maxAgeMs);
  if (!snapshot.isStale) return false;
  if (await hasActiveMapsRefresh(db, normalized)) return true;
  await enqueueMapsRefresh(queue, normalized, options);
  return true;
}

export async function deferMapsRefreshesWaitingForRoster(db: Db, retryDelayMs = 10 * 60_000): Promise<number> {
  const result = await exec(
    db,
    `update jobs
     set status = 'queued',
         locked_by = null,
         locked_until = null,
         run_after = ?,
         last_error = null,
         updated_at = ?
     where type = 'refresh_country_maps'
       and status = 'failed'
       and last_error like 'No tracked roster users available for %'`,
    [new Date(Date.now() + retryDelayMs).toISOString(), nowIso()],
  );
  return Number(result.rowsAffected ?? 0);
}

export type MapsSnapshotSection = "core" | "random";

export async function getMapsSnapshot(
  db: Db,
  queue: JobQueue,
  country: string,
  maxAgeMs: number,
  section: MapsSnapshotSection = "core",
): Promise<{ value: CountryMapsData | null; generatedAt: string | null; refreshedAt: string | null; isStale: boolean; refreshQueued: boolean }> {
  const normalized = country.toUpperCase();
  const snapshot = await readMapsSnapshot(db, normalized, maxAgeMs);
  const value = section === "core" && snapshot.value
    ? await applyMapsFarmedOverlay(db, normalized, snapshot.value, snapshot.refreshedAt)
    : snapshot.value;
  let refreshQueued = await hasActiveMapsRefresh(db, normalized);
  if (snapshot.isStale && !refreshQueued) {
    await enqueueMapsRefresh(queue, normalized);
    refreshQueued = true;
  }
  return { ...snapshot, value: sliceMapsSnapshotSection(value, section), refreshQueued };
}

/**
 * Timestamp-only read of a country's maps snapshot row — no payload_json parse
 * or user hydration. The HTTP layer uses refreshedAt to key its response cache
 * so a cache hit can skip the (expensive) getMapsSnapshot() path entirely.
 */
export async function getMapsSnapshotMeta(
  db: Db,
  country: string,
): Promise<{ generatedAt: string | null; refreshedAt: string | null; farmedOverlayUpdatedAt: string | null }> {
  const normalized = country.toUpperCase();
  const row = (await exec(
    db,
    "select generated_at, refreshed_at from country_maps_snapshots where country = ?",
    [normalized],
  )).rows[0];
  const farmedOverlayUpdatedAt = await readMapsFarmedOverlayUpdatedAt(db, normalized);
  return {
    generatedAt: row?.generated_at == null ? null : String(row.generated_at),
    refreshedAt: row?.refreshed_at == null ? null : String(row.refreshed_at),
    farmedOverlayUpdatedAt,
  };
}

// The maps snapshot is served in two parts so /maps first paint stays small.
// "core" carries the three browsable tabs; "random" carries only the heavy
// beatmapsetsPool the Random tab needs. favouritesByPlayer is tiny, so it
// always rides with "core" — that lets the client tell "no random pool exists"
// apart from "random pool not loaded yet".
function sliceMapsSnapshotSection(value: CountryMapsData | null, section: MapsSnapshotSection): CountryMapsData | null {
  if (!value) return value;
  if (section === "random") {
    return { ...value, farmed: [], mostPlayed: [], favourites: [] };
  }
  return { ...value, beatmapsetsPool: {} };
}

async function readMapsSnapshot(
  db: Db,
  country: string,
  maxAgeMs: number,
): Promise<{ value: CountryMapsData | null; generatedAt: string | null; refreshedAt: string | null; isStale: boolean }> {
  const normalized = country.toUpperCase();
  const row = (await exec(db, "select payload_json, generated_at, refreshed_at from country_maps_snapshots where country = ?", [normalized])).rows[0];
  const refreshedAt = row?.refreshed_at == null ? null : String(row.refreshed_at);
  const refreshedMs = refreshedAt ? new Date(refreshedAt).getTime() : 0;
  const parsed = row ? parseJson<CountryMapsData | null>(row.payload_json, null) : null;
  const isUsable = isUsableMapsData(parsed);
  const value = isUsable && parsed ? await hydrateMapsSnapshotUsers(db, parsed) : null;
  const isStale = !Number.isFinite(refreshedMs) || Date.now() - refreshedMs > maxAgeMs || (!!row && !isUsable);
  return {
    value,
    generatedAt: row?.generated_at == null ? null : String(row.generated_at),
    refreshedAt,
    isStale,
  };
}

async function hydrateMapsSnapshotUsers(db: Db, value: CountryMapsData): Promise<CountryMapsData> {
  const ids = [...collectMapsSnapshotUserIds(value)];
  if (ids.length === 0) return value;
  const placeholders = ids.map(() => "?").join(",");
  const rows = (await exec(
    db,
    `select user_id, username, avatar_url from users where user_id in (${placeholders})`,
    ids,
  )).rows;
  const usersById = new Map(
    rows.map((row) => [
      Number(row.user_id),
      {
        username: String(row.username ?? ""),
        avatarUrl: String(row.avatar_url ?? ""),
      },
    ]),
  );
  const applyUser = (player: { id: number; username: string; avatarUrl: string }) => {
    const user = usersById.get(player.id);
    if (!user) return;
    if (user.username) player.username = user.username;
    if (user.avatarUrl) player.avatarUrl = user.avatarUrl;
  };

  for (const entry of value.farmed) entry.players.forEach(applyUser);
  for (const entry of value.mostPlayed) entry.players.forEach(applyUser);
  for (const entry of value.favourites) entry.players.forEach(applyUser);
  value.favouritesByPlayer.forEach(applyUser);
  return value;
}

function collectMapsSnapshotUserIds(value: CountryMapsData): Set<number> {
  const ids = new Set<number>();
  const add = (player: { id: number }) => {
    if (Number.isSafeInteger(player.id) && player.id > 0) ids.add(player.id);
  };
  for (const entry of value.farmed) entry.players.forEach(add);
  for (const entry of value.mostPlayed) entry.players.forEach(add);
  for (const entry of value.favourites) entry.players.forEach(add);
  value.favouritesByPlayer.forEach(add);
  return ids;
}

async function hasActiveMapsRefresh(db: Db, country: string): Promise<boolean> {
  const now = nowIso();
  const row = (await exec(
    db,
    `select 1 as active
     from jobs
     where dedupe_key = ?
       and (status in ('queued', 'running') or (status = 'failed' and run_after > ?))
     limit 1`,
    [`maps:${country.toUpperCase()}`, now],
  )).rows[0];
  return !!row;
}

export async function refreshCountryMaps(
  db: Db,
  osu: Pick<OsuApiClient, "getUserBestScoresWindow" | "getUserMostPlayed" | "getUserFavourites">,
  payload: { country: string },
): Promise<CountryMapsData> {
  const country = payload.country.toUpperCase();
  const users = await getMapsUsers(db, country);
  if (users.length === 0) throw new MapsRosterNotReadyError(country);
  const emptyGeneratedAt = nowIso();
  let latestFarmed: CountryMapsFarmedSection = { farmed: [], generatedAt: emptyGeneratedAt };
  let latestFavourites: CountryMapsFavouritesSection = {
    mostPlayed: [],
    favourites: [],
    favouritesByPlayer: [],
    beatmapsetsPool: {},
    generatedAt: emptyGeneratedAt,
  };
  let persistChain = Promise.resolve();
  const persistLatest = () => {
    const value = composeCountryMapsData(latestFarmed, latestFavourites);
    persistChain = persistChain.then(() => persistMapsSnapshot(db, country, value));
    return persistChain;
  };

  const farmedPromise = buildCountryFarmed(db, osu, users).then(async (section) => {
    latestFarmed = section;
    await persistLatest();
    return section;
  });
  const favouritesPromise = buildCountryFavourites(osu, users).then(async (section) => {
    latestFavourites = section;
    await persistLatest();
    return section;
  });

  const [farmedSection, favSection] = await Promise.all([farmedPromise, favouritesPromise]);
  const value = composeCountryMapsData(farmedSection, favSection);
  assertUsableMapsData(value, users.length);
  await persistMapsSnapshot(db, country, value);
  return value;
}

async function persistMapsSnapshot(db: Db, country: string, value: CountryMapsData): Promise<void> {
  await exec(
    db,
    `insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at)
     values (?, ?, ?, ?)
     on conflict(country) do update set payload_json = excluded.payload_json, generated_at = excluded.generated_at, refreshed_at = excluded.refreshed_at`,
    [country.toUpperCase(), json(value), value.generatedAt, nowIso()],
  );
}

export async function refreshUserMapsFarmedScores(
  db: Db,
  osu: Pick<OsuApiClient, "getUserBestScoresWindow">,
  payload: { country: string; userId: number },
): Promise<{ country: string; userId: number; scoreCount: number; updatedAt: string }> {
  const country = payload.country.toUpperCase();
  const bestScores = await osu.getUserBestScoresWindow(payload.userId, MAPS_FARMED_SCORE_WINDOW, "job:refresh_user_maps_farmed_scores");
  const updatedAt = nowIso();
  await updateUserMapsFarmedThreshold(db, payload.userId, bestScores, updatedAt);
  const rows = buildMapsFarmedOverlayRows(country, bestScores, updatedAt);
  await replaceUserMapsFarmedOverlay(db, country, payload.userId, rows, updatedAt);
  return { country, userId: payload.userId, scoreCount: rows.length, updatedAt };
}

export async function recordMapsFarmedScore(
  db: Db,
  country: string,
  score: OscScore,
  updatedAt = nowIso(),
): Promise<{ country: string; userId: number; beatmapId: number; updatedAt: string } | null> {
  const rows = buildMapsFarmedOverlayRows(country.toUpperCase(), [score], updatedAt);
  const row = rows[0];
  if (!row) return null;
  const result = await exec(
    db,
    `insert into country_maps_farmed_scores
       (country, user_id, beatmap_id, score_id, pp, score_json, detected_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(country, user_id, beatmap_id) do update set
       score_id = excluded.score_id,
       pp = excluded.pp,
       score_json = excluded.score_json,
       detected_at = excluded.detected_at,
       updated_at = excluded.updated_at
     where excluded.pp > country_maps_farmed_scores.pp
        or (excluded.pp = country_maps_farmed_scores.pp and excluded.detected_at >= country_maps_farmed_scores.detected_at)`,
    [
      row.country,
      row.userId,
      row.beatmapId,
      row.scoreId,
      row.pp,
      row.scoreJson,
      row.detectedAt,
      row.updatedAt,
    ],
  );
  if (Number(result.rowsAffected ?? 0) === 0) return null;
  await touchMapsFarmedOverlay(db, row.country, updatedAt);
  return { country: row.country, userId: row.userId, beatmapId: row.beatmapId, updatedAt };
}

async function getMapsUsers(db: Db, country: string): Promise<MapsUser[]> {
  const rows = (await exec(
    db,
    `select r.user_id, u.username, u.avatar_url
     from country_rosters r
     left join users u on u.user_id = r.user_id
     where r.country = ? and r.is_tracked = 1
     order by r.rank asc
     limit 50`,
    [country],
  )).rows;
  return rows.map((row) => ({
    id: Number(row.user_id),
    username: String(row.username ?? `User ${row.user_id}`),
    avatar_url: String(row.avatar_url ?? ""),
  }));
}

async function buildCountryFarmed(
  db: Db,
  osu: Pick<OsuApiClient, "getUserBestScoresWindow">,
  users: MapsUser[],
): Promise<CountryMapsFarmedSection> {
  const userResults = await mapWithConcurrency(users, MAPS_FETCH_CONCURRENCY, async (user) => {
    const bestScores = await osu.getUserBestScoresWindow(user.id, 200, "job:refresh_country_maps:farmed")
      .catch((error) => {
        throwIfMapsRefreshShouldAbort(error);
        return [] as OscScore[];
      });
    return { user, bestScores };
  });
  const generatedAt = nowIso();
  await Promise.all(userResults.map(({ user, bestScores }) => updateUserMapsFarmedThreshold(db, user.id, bestScores, generatedAt)));

  const farmedMap = new Map<number, MapsFarmedEntry>();
  for (const { user, bestScores } of userResults) {
    for (const score of bestScores) {
      if (!score.beatmap || score.beatmap.mode !== "mania") continue;
      if (!score.pp || score.pp <= 0) continue;
      if (score.beatmapset?.status !== "ranked") continue;

      const bid = score.beatmap.id;
      const existing = farmedMap.get(bid);
      const player = {
        id: user.id,
        username: user.username,
        avatarUrl: user.avatar_url,
        mods: getModAcronyms(score.mods),
        pp: score.pp,
        scoreUrl: getScoreUrl(score),
        playedAt: getScoreTimestamp(score) || null,
      };
      if (existing) {
        if (!existing.players.some((p) => p.id === user.id)) {
          existing.playerCount++;
          existing.players.push(player);
          existing.maxPp = Math.max(existing.maxPp, score.pp);
        }
      } else {
        farmedMap.set(bid, {
          beatmapId: bid,
          version: score.beatmap.version,
          difficultyRating: score.beatmap.difficulty_rating,
          totalLength: getTotalLength(score.beatmap),
          cs: score.beatmap.cs,
          bpm: score.beatmap.bpm,
          beatmapsetId: score.beatmapset.id,
          title: score.beatmapset.title,
          artist: score.beatmapset.artist,
          creator: score.beatmapset.creator ?? "",
          covers: score.beatmapset.covers,
          status: score.beatmapset.status ?? "",
          playerCount: 1,
          players: [player],
          avgPp: 0,
          maxPp: score.pp,
        });
      }
    }
  }

  const farmed: MapsFarmedEntry[] = [];
  for (const entry of farmedMap.values()) {
    if (entry.playerCount < 2 && entry.maxPp < FARMED_SINGLE_PLAYER_PP_MIN) continue;
    entry.players.sort((a, b) => b.pp - a.pp);
    entry.avgPp = entry.players.reduce((sum, player) => sum + player.pp, 0) / entry.players.length;
    farmed.push(entry);
  }
  farmed.sort((a, b) => b.playerCount - a.playerCount || b.avgPp - a.avgPp);
  return { farmed, generatedAt };
}

async function buildCountryFavourites(
  osu: Pick<OsuApiClient, "getUserMostPlayed" | "getUserFavourites">,
  users: MapsUser[],
): Promise<CountryMapsFavouritesSection> {
  const userResults = await mapWithConcurrency(users, MAPS_FETCH_CONCURRENCY, async (user) => {
    const [mostPlayed, favourites] = await Promise.all([
      osu.getUserMostPlayed(user.id, "job:refresh_country_maps:most_played")
        .then((rows) => rows as RawBeatmapPlaycount[])
        .catch((error) => {
          throwIfMapsRefreshShouldAbort(error);
          return [] as RawBeatmapPlaycount[];
        }),
      osu.getUserFavourites(user.id, USER_FAVOURITES_MAX_PAGES, "job:refresh_country_maps:favourites")
        .then((rows) => rows as RawBeatmapset[])
        .catch((error) => {
          throwIfMapsRefreshShouldAbort(error);
          return [] as RawBeatmapset[];
        }),
    ]);
    return { user, mostPlayed, favourites };
  });

  const mpMap = new Map<number, MapsAggregatedBeatmap>();
  for (const { user, mostPlayed } of userResults) {
    for (const mp of mostPlayed) {
      if (mp.beatmap?.mode !== "mania" || !mp.beatmapset) continue;
      const beatmapId = Number(mp.beatmap_id ?? mp.beatmap.id);
      const count = Number(mp.count ?? 0);
      const existing = mpMap.get(beatmapId);
      const player = { id: user.id, username: user.username, avatarUrl: user.avatar_url, count };
      if (existing) {
        existing.totalPlays += count;
        existing.playerCount++;
        existing.players.push(player);
      } else {
        mpMap.set(beatmapId, {
          beatmapId,
          version: String(mp.beatmap.version ?? ""),
          difficultyRating: Number(mp.beatmap.difficulty_rating ?? 0),
          totalLength: getTotalLength(mp.beatmap),
          beatmapsetId: Number(mp.beatmapset.id ?? 0),
          title: String(mp.beatmapset.title ?? ""),
          artist: String(mp.beatmapset.artist ?? ""),
          creator: String(mp.beatmapset.creator ?? ""),
          covers: mp.beatmapset.covers ?? {},
          status: String(mp.beatmapset.status ?? ""),
          globalPlayCount: Number(mp.beatmapset.play_count ?? 0),
          totalPlays: count,
          playerCount: 1,
          players: [player],
        });
      }
    }
  }

  for (const entry of mpMap.values()) entry.players.sort((a, b) => b.count - a.count);
  const mostPlayed = [...mpMap.values()]
    .filter((entry) => entry.playerCount >= 2)
    .sort((a, b) => b.playerCount - a.playerCount || b.totalPlays - a.totalPlays)
    .slice(0, 200);

  const favMap = new Map<number, MapsAggregatedFavourite>();
  const beatmapsetsPool: Record<number, MapsFavouriteBeatmapset> = {};
  const favouritesByPlayer: MapsPlayerFavourites[] = [];
  for (const { user, favourites } of userResults) {
    const playerIds: number[] = [];
    for (const fav of favourites) {
      const maniaBeatmaps = (fav.beatmaps ?? []).filter((beatmap) => beatmap.mode === "mania" && Number.isFinite(Number(beatmap.id)));
      if (maniaBeatmaps.length === 0 || !fav.id) continue;
      playerIds.push(fav.id);

      if (!beatmapsetsPool[fav.id]) {
        const keys = new Set<number>();
        const stars: number[] = [];
        for (const beatmap of maniaBeatmaps) {
          const keyCount = Number(beatmap.cs ?? 0);
          const star = Number(beatmap.difficulty_rating ?? 0);
          if (Number.isFinite(keyCount)) keys.add(keyCount);
          if (Number.isFinite(star)) stars.push(star);
        }
        beatmapsetsPool[fav.id] = {
          id: fav.id,
          title: String(fav.title ?? ""),
          artist: String(fav.artist ?? ""),
          creator: String(fav.creator ?? ""),
          covers: fav.covers ?? {},
          status: String(fav.status ?? ""),
          globalPlayCount: Number(fav.play_count ?? 0),
          globalFavouriteCount: Number(fav.favourite_count ?? 0),
          previewUrl: String(fav.preview_url ?? ""),
          maniaKeys: [...keys].sort((a, b) => a - b),
          maniaBeatmaps: maniaBeatmaps
            .map((beatmap) => ({
              id: Number(beatmap.id),
              version: String(beatmap.version ?? ""),
              difficultyRating: Number(beatmap.difficulty_rating ?? 0),
              totalLength: getTotalLength(beatmap),
              cs: Number(beatmap.cs ?? 0),
            }))
            .sort((a, b) => b.difficultyRating - a.difficultyRating),
          starMin: stars.length ? Math.min(...stars) : 0,
          starMax: stars.length ? Math.max(...stars) : 0,
          bpm: Number(fav.bpm ?? 0),
          patterns: detectManiaPatterns(String(fav.tags ?? ""), maniaBeatmaps.map((beatmap) => String(beatmap.version ?? "")), String(fav.title ?? "")),
        };
      }

      const existing = favMap.get(fav.id);
      const player = { id: user.id, username: user.username, avatarUrl: user.avatar_url };
      if (existing) {
        existing.playerCount++;
        existing.players.push(player);
      } else {
        favMap.set(fav.id, {
          beatmapsetId: fav.id,
          title: String(fav.title ?? ""),
          artist: String(fav.artist ?? ""),
          creator: String(fav.creator ?? ""),
          covers: fav.covers ?? {},
          status: String(fav.status ?? ""),
          globalPlayCount: Number(fav.play_count ?? 0),
          globalFavouriteCount: Number(fav.favourite_count ?? 0),
          playerCount: 1,
          players: [player],
        });
      }
    }
    if (playerIds.length > 0) {
      favouritesByPlayer.push({ id: user.id, username: user.username, avatarUrl: user.avatar_url, beatmapsetIds: playerIds });
    }
  }

  const favourites = [...favMap.values()]
    .filter((entry) => entry.playerCount >= 2)
    .sort((a, b) => b.playerCount - a.playerCount || b.globalFavouriteCount - a.globalFavouriteCount)
    .slice(0, 100);

  return { mostPlayed, favourites, favouritesByPlayer, beatmapsetsPool, generatedAt: nowIso() };
}

function composeCountryMapsData(farmedSection: CountryMapsFarmedSection, favSection: CountryMapsFavouritesSection): CountryMapsData {
  const farmedAt = farmedSection.generatedAt;
  const favAt = favSection.generatedAt;
  return {
    farmed: farmedSection.farmed,
    mostPlayed: favSection.mostPlayed,
    favourites: favSection.favourites,
    favouritesByPlayer: favSection.favouritesByPlayer,
    beatmapsetsPool: favSection.beatmapsetsPool,
    generatedAt: farmedAt < favAt ? farmedAt : favAt,
    farmedGeneratedAt: farmedAt,
    favouritesGeneratedAt: favAt,
  };
}

function isUsableMapsData(value: CountryMapsData | null): value is CountryMapsData {
  if (!value) return false;
  return (
    value.farmed.length > 0 ||
    value.favourites.length > 0 ||
    value.favouritesByPlayer.length > 0 ||
    Object.keys(value.beatmapsetsPool).length > 0
  );
}

function assertUsableMapsData(value: CountryMapsData, userCount: number): void {
  if (isUsableMapsData(value)) return;
  throw new Error(`Maps refresh produced no usable data for ${userCount} users`);
}

function throwIfMapsRefreshShouldAbort(error: unknown): void {
  if (error instanceof OsuApiError && (error.status === 429 || error.status >= 500)) throw error;
  if (error instanceof Error && error.message.includes("OSU_CLIENT_ID")) throw error;
}

interface MapsFarmedOverlayWriteRow {
  country: string;
  userId: number;
  beatmapId: number;
  scoreId: number;
  pp: number;
  scoreJson: string;
  detectedAt: string;
  updatedAt: string;
}

function buildMapsFarmedOverlayRows(country: string, scores: OscScore[], updatedAt: string): MapsFarmedOverlayWriteRow[] {
  const rows = new Map<string, MapsFarmedOverlayWriteRow>();
  for (const score of scores) {
    if (!isPotentialFarmedScore(score)) continue;
    const beatmapId = Number(score.beatmap_id ?? score.beatmap?.id);
    if (!Number.isFinite(beatmapId) || beatmapId <= 0) continue;
    const scoreId = getMapsFarmedDisplayScoreId(score);
    if (!Number.isFinite(scoreId) || scoreId < 0) continue;
    const pp = Number(score.pp);
    const detectedAt = getScoreTimestamp(score) || updatedAt;
    const key = `${country}:${score.user_id}:${beatmapId}`;
    const candidate = {
      country,
      userId: score.user_id,
      beatmapId,
      scoreId,
      pp,
      scoreJson: json(score),
      detectedAt,
      updatedAt,
    };
    const existing = rows.get(key);
    if (!existing || pp > existing.pp || (pp === existing.pp && detectedAt >= existing.detectedAt)) {
      rows.set(key, candidate);
    }
  }
  return [...rows.values()];
}

async function replaceUserMapsFarmedOverlay(
  db: Db,
  country: string,
  userId: number,
  rows: MapsFarmedOverlayWriteRow[],
  updatedAt: string,
): Promise<void> {
  const deleted = await exec(db, "delete from country_maps_farmed_scores where country = ? and user_id = ?", [country, userId]);
  for (const row of rows) {
    await exec(
      db,
      `insert into country_maps_farmed_scores
         (country, user_id, beatmap_id, score_id, pp, score_json, detected_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(country, user_id, beatmap_id) do update set
         score_id = excluded.score_id,
         pp = excluded.pp,
         score_json = excluded.score_json,
         detected_at = excluded.detected_at,
         updated_at = excluded.updated_at`,
      [row.country, row.userId, row.beatmapId, row.scoreId, row.pp, row.scoreJson, row.detectedAt, row.updatedAt],
    );
  }
  if (rows.length > 0 || Number(deleted.rowsAffected ?? 0) > 0) {
    await touchMapsFarmedOverlay(db, country, updatedAt);
  }
}

async function updateUserMapsFarmedThreshold(db: Db, userId: number, bestScores: OscScore[], refreshedAt: string): Promise<void> {
  const positivePps = bestScores
    .map((score) => score.pp)
    .filter((pp): pp is number => typeof pp === "number" && Number.isFinite(pp) && pp > 0);
  const minPp = positivePps.length >= MAPS_FARMED_SCORE_WINDOW ? Math.min(...positivePps) : 0;
  await exec(
    db,
    `update users
     set maps_farmed_min_pp = ?, maps_farmed_scores_refreshed_at = ?
     where user_id = ?`,
    [minPp, refreshedAt, userId],
  );
}

async function applyMapsFarmedOverlay(
  db: Db,
  country: string,
  value: CountryMapsData,
  refreshedAt: string | null,
): Promise<CountryMapsData> {
  if (!refreshedAt) return value;
  const rows = (await exec(
    db,
    `select
       s.country,
       s.user_id,
       s.beatmap_id,
       s.score_id,
       s.pp,
       s.score_json,
       s.detected_at,
       s.updated_at,
       u.username,
       u.avatar_url,
       u.country_code,
       b.beatmapset_id,
       b.mode,
       b.status as beatmap_status,
       b.cs,
       b.difficulty_rating,
       b.bpm,
       b.max_combo,
       b.version,
       b.url,
       bs.title,
       bs.artist,
       bs.creator,
       bs.status as beatmapset_status,
       bs.covers_json
     from country_maps_farmed_scores s
     left join users u on u.user_id = s.user_id
     left join beatmaps b on b.beatmap_id = s.beatmap_id
     left join beatmapsets bs on bs.beatmapset_id = b.beatmapset_id
     where s.country = ? and s.updated_at > ?
     order by s.updated_at asc`,
    [country, refreshedAt],
  )).rows;
  if (rows.length === 0) return value;

  const byBeatmap = new Map<number, MapsFarmedEntry>();
  for (const entry of value.farmed) {
    byBeatmap.set(entry.beatmapId, {
      ...entry,
      players: entry.players.map((player) => ({ ...player, mods: [...player.mods] })),
    });
  }

  let farmedGeneratedAt = value.farmedGeneratedAt;
  for (const row of rows) {
    const merged = farmedOverlayRowToEntry(row);
    if (!merged) continue;
    mergeFarmedEntry(byBeatmap, merged.entry, merged.player);
    const updatedAt = String(row.updated_at ?? "");
    if (updatedAt > farmedGeneratedAt) farmedGeneratedAt = updatedAt;
  }

  const farmed = [...byBeatmap.values()].flatMap((entry) => {
    finalizeFarmedEntry(entry);
    if (entry.playerCount < 2 && entry.maxPp < FARMED_SINGLE_PLAYER_PP_MIN) return [];
    return [entry];
  });
  farmed.sort((a, b) => b.playerCount - a.playerCount || b.avgPp - a.avgPp);

  return {
    ...value,
    farmed,
    farmedGeneratedAt,
    generatedAt: farmedGeneratedAt < value.favouritesGeneratedAt ? farmedGeneratedAt : value.favouritesGeneratedAt,
  };
}

function farmedOverlayRowToEntry(row: Record<string, unknown>): { entry: MapsFarmedEntry; player: MapsFarmedEntry["players"][number] } | null {
  const raw = parseJson<OscScore | null>(row.score_json, null);
  if (!raw) return null;
  const score = hydrateMapsFarmedOverlayScore(row, raw);
  if (!isPotentialFarmedScore(score) || !score.beatmap || !score.beatmapset) return null;
  const pp = Number(row.pp ?? score.pp);
  const beatmapId = Number(row.beatmap_id ?? score.beatmap.id);
  const beatmapsetId = Number(score.beatmapset.id ?? score.beatmap.beatmapset_id);
  const userId = Number(row.user_id ?? score.user_id);
  if (!Number.isFinite(pp) || pp <= 0 || !Number.isFinite(beatmapId) || beatmapId <= 0 || !Number.isFinite(userId) || userId <= 0) {
    return null;
  }
  const user = score.user;
  const player = {
    id: userId,
    username: user?.username || String(row.username ?? `User ${userId}`),
    avatarUrl: user?.avatar_url || String(row.avatar_url ?? ""),
    mods: getModAcronyms(score.mods),
    pp,
    scoreUrl: getScoreUrl(score),
    playedAt: getScoreTimestamp(score) || null,
  };
  return {
    entry: {
      beatmapId,
      version: score.beatmap.version,
      difficultyRating: score.beatmap.difficulty_rating,
      totalLength: getTotalLength(score.beatmap),
      cs: score.beatmap.cs,
      bpm: score.beatmap.bpm,
      beatmapsetId,
      title: score.beatmapset.title,
      artist: score.beatmapset.artist,
      creator: score.beatmapset.creator ?? "",
      covers: score.beatmapset.covers,
      status: score.beatmapset.status ?? score.beatmap.status ?? "",
      playerCount: 1,
      players: [player],
      avgPp: pp,
      maxPp: pp,
    },
    player,
  };
}

function hydrateMapsFarmedOverlayScore(row: Record<string, unknown>, score: OscScore): OscScore {
  const userId = Number(row.user_id ?? score.user_id);
  const storedUser = Number.isFinite(userId) && userId > 0
    ? {
        id: userId,
        username: String(row.username ?? score.user?.username ?? `User ${userId}`),
        avatar_url: String(row.avatar_url ?? score.user?.avatar_url ?? ""),
        country_code: String(row.country_code ?? score.user?.country_code ?? ""),
      }
    : score.user;
  const storedBeatmap = rowMapsBeatmap(row);
  const storedBeatmapset = rowMapsBeatmapset(row);
  const beatmap = score.beatmap
    ? {
        ...(storedBeatmap ?? {}),
        ...score.beatmap,
        status: score.beatmap.status ?? storedBeatmap?.status,
      }
    : storedBeatmap;
  const beatmapset = score.beatmapset
    ? {
        ...(storedBeatmapset ?? {}),
        ...score.beatmapset,
        creator: score.beatmapset.creator ?? storedBeatmapset?.creator,
        covers: Object.keys(score.beatmapset.covers ?? {}).length > 0 ? score.beatmapset.covers : storedBeatmapset?.covers ?? {},
        status: score.beatmapset.status ?? storedBeatmapset?.status,
      }
    : storedBeatmapset;
  return { ...score, user: storedUser, beatmap, beatmapset };
}

function rowMapsBeatmap(row: Record<string, unknown>): OscScore["beatmap"] | undefined {
  const id = Number(row.beatmap_id);
  const beatmapsetId = Number(row.beatmapset_id);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(beatmapsetId) || beatmapsetId <= 0 || row.version == null) return undefined;
  return {
    id,
    beatmapset_id: beatmapsetId,
    difficulty_rating: Number(row.difficulty_rating ?? 0),
    mode: String(row.mode ?? "mania"),
    status: row.beatmap_status == null ? undefined : String(row.beatmap_status),
    cs: Number(row.cs ?? 0),
    bpm: Number(row.bpm ?? 0),
    max_combo: row.max_combo == null ? undefined : Number(row.max_combo),
    version: String(row.version),
    url: String(row.url ?? `https://osu.ppy.sh/beatmaps/${id}`),
  };
}

function rowMapsBeatmapset(row: Record<string, unknown>): OscScore["beatmapset"] | undefined {
  const id = Number(row.beatmapset_id);
  if (!Number.isFinite(id) || id <= 0 || row.title == null || row.artist == null) return undefined;
  return {
    id,
    title: String(row.title),
    artist: String(row.artist),
    creator: row.creator == null ? undefined : String(row.creator),
    covers: parseJson<Record<string, string | undefined>>(row.covers_json, {}),
    status: row.beatmapset_status == null ? undefined : String(row.beatmapset_status),
  };
}

function mergeFarmedEntry(
  byBeatmap: Map<number, MapsFarmedEntry>,
  incoming: MapsFarmedEntry,
  player: MapsFarmedEntry["players"][number],
): void {
  const existing = byBeatmap.get(incoming.beatmapId);
  if (!existing) {
    byBeatmap.set(incoming.beatmapId, incoming);
    return;
  }
  const playerIndex = existing.players.findIndex((candidate) => candidate.id === player.id);
  if (playerIndex >= 0) {
    const current = existing.players[playerIndex];
    if (player.pp < current.pp || (player.pp === current.pp && (player.playedAt ?? "") < (current.playedAt ?? ""))) return;
    existing.players[playerIndex] = player;
  } else {
    existing.players.push(player);
  }
}

function finalizeFarmedEntry(entry: MapsFarmedEntry): void {
  entry.players.sort((a, b) => b.pp - a.pp);
  entry.playerCount = entry.players.length;
  entry.maxPp = Math.max(...entry.players.map((player) => player.pp), 0);
  entry.avgPp = entry.players.length > 0
    ? entry.players.reduce((sum, player) => sum + player.pp, 0) / entry.players.length
    : 0;
}

function isPotentialFarmedScore(score: OscScore): boolean {
  if (score.pp == null || score.pp <= 0) return false;
  if (score.beatmap && score.beatmap.mode !== "mania") return false;
  if (score.ranked === false) return false;
  const knownStatus = String(score.beatmapset?.status ?? score.beatmap?.status ?? "").toLowerCase();
  return knownStatus === "" || knownStatus === "ranked";
}

function getMapsFarmedDisplayScoreId(score: OscScore): number {
  return score.legacy_score_id != null && score.legacy_score_id > 0 ? score.legacy_score_id : score.id;
}

function getMapsFarmedScoreDedupeKey(score: OscScore): string {
  const scoreId = getMapsFarmedDisplayScoreId(score);
  return scoreId > 0 ? String(scoreId) : getScoreIdentity(score);
}

async function readMapsFarmedOverlayUpdatedAt(db: Db, country: string): Promise<string | null> {
  const row = (await exec(db, "select value_json from live_meta where key = ?", [mapsFarmedOverlayMetaKey(country)])).rows[0];
  const parsed = parseJson<string | null>(row?.value_json, null);
  return typeof parsed === "string" && parsed ? parsed : null;
}

async function touchMapsFarmedOverlay(db: Db, country: string, updatedAt: string): Promise<void> {
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at)
     values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [mapsFarmedOverlayMetaKey(country), json(updatedAt), updatedAt],
  );
}

function mapsFarmedOverlayMetaKey(country: string): string {
  return `${MAPS_FARMED_OVERLAY_META_PREFIX}${country.toUpperCase()}`;
}

function getTotalLength(beatmap: RawBeatmap | NonNullable<OscScore["beatmap"]>): number {
  return Number("total_length" in beatmap ? beatmap.total_length ?? 0 : 0);
}

function getScoreUrl(score: OscScore): string | null {
  if (score.id <= 0) return null;
  if (score.type === "solo_score") return `https://osu.ppy.sh/scores/${score.id}`;
  return `https://osu.ppy.sh/scores/${score.beatmap?.mode ?? "mania"}/${score.id}`;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const PATTERN_VARIANTS: Array<{ canonical: string; variants: string[]; sources?: Array<"tags" | "version" | "title"> }> = [
  { canonical: "chordjack", variants: ["chordjack", "chord jack"] },
  { canonical: "longjack", variants: ["longjack", "long jack"] },
  { canonical: "speedjack", variants: ["speedjack", "speed jack", "jackspeed", "jack speed"] },
  { canonical: "minijack", variants: ["minijack", "mini jack"] },
  { canonical: "jack", variants: ["jack"] },
  { canonical: "jumpstream", variants: ["jumpstream", "jump stream"] },
  { canonical: "chordstream", variants: ["chordstream", "chord stream"] },
  { canonical: "handstream", variants: ["handstream", "hand stream"] },
  { canonical: "dumpstream", variants: ["dumpstream", "dump stream"] },
  { canonical: "stream", variants: ["stream"] },
  { canonical: "stamina", variants: ["stamina"] },
  { canonical: "tech", variants: ["tech", "technical"] },
  { canonical: "ln", variants: ["ln", "long note", "long notes", "noodle", "noodles"] },
  { canonical: "rice", variants: ["rice"] },
  { canonical: "sv", variants: ["sv", "scroll velocity"] },
  { canonical: "bracket", variants: ["bracket", "brackets"] },
  { canonical: "speed", variants: ["speed"], sources: ["version", "title"] },
  { canonical: "tiebreaker", variants: ["tiebreaker", "tb"] },
];

const SUBSUMED: Record<string, string[]> = {
  jack: ["chordjack", "longjack", "speedjack", "minijack"],
  stream: ["jumpstream", "chordstream", "handstream", "dumpstream"],
};

function detectManiaPatterns(tagsText: string, versionNames: string[] = [], title = ""): string[] {
  const pack = isPackTitle(title);
  const sources = [
    { kind: "tags" as const, text: tagsText },
    ...(pack
      ? [{ kind: "title" as const, text: title }]
      : versionNames.map((version) => ({ kind: "version" as const, text: version }))),
  ].filter((source) => source.text.trim());
  if (sources.length === 0) return [];

  const detected = new Set<string>();
  for (const { canonical, variants, sources: allowedSources } of PATTERN_VARIANTS) {
    const candidateSources = allowedSources ? sources.filter((source) => allowedSources.includes(source.kind)) : sources;
    for (const variant of variants) {
      if (candidateSources.some((source) => sourceHasVariant(source.text, variant))) {
        detected.add(canonical);
        break;
      }
    }
  }
  for (const [generic, specifics] of Object.entries(SUBSUMED)) {
    if (specifics.some((specific) => detected.has(specific))) detected.delete(generic);
  }
  return [...detected];
}

function isPackTitle(title: string): boolean {
  const tokens = new Set(title.toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean));
  return ["pack", "packs", "collection", "compilation", "marathon"].some((hint) => tokens.has(hint));
}

function sourceHasVariant(text: string, variant: string): boolean {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);
  if (!variant.includes(" ")) return tokens.includes(variant);
  for (let index = 0; index < tokens.length - 1; index++) {
    if (`${tokens[index]} ${tokens[index + 1]}` === variant) return true;
  }
  return false;
}
