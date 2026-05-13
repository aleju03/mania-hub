import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { getModAcronyms, getScoreTimestamp, nowIso } from "../shared/score.js";
import type { OscScore } from "../shared/types.js";

const MAPS_REFRESH_PRIORITY = 20;
const MAPS_FETCH_CONCURRENCY = 2;
const FARMED_SINGLE_PLAYER_PP_MIN = 500;
const USER_FAVOURITES_MAX_PAGES = 10;

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

export async function getMapsSnapshot(
  db: Db,
  queue: JobQueue,
  country: string,
  maxAgeMs: number,
): Promise<{ value: CountryMapsData | null; generatedAt: string | null; refreshedAt: string | null; isStale: boolean; refreshQueued: boolean }> {
  const normalized = country.toUpperCase();
  const snapshot = await readMapsSnapshot(db, normalized, maxAgeMs);
  let refreshQueued = await hasActiveMapsRefresh(db, normalized);
  if (snapshot.isStale && !refreshQueued) {
    await enqueueMapsRefresh(queue, normalized);
    refreshQueued = true;
  }
  return { ...snapshot, refreshQueued };
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
  const isStale = !Number.isFinite(refreshedMs) || Date.now() - refreshedMs > maxAgeMs || (!!row && !isUsable);
  return {
    value: isUsable ? parsed : null,
    generatedAt: row?.generated_at == null ? null : String(row.generated_at),
    refreshedAt,
    isStale,
  };
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
  if (users.length === 0) throw new Error(`No tracked roster users available for ${country}`);
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

  const farmedPromise = buildCountryFarmed(osu, users).then(async (section) => {
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
  return { farmed, generatedAt: nowIso() };
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
