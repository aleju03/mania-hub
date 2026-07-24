import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import type { DiscordInteraction } from "../src/discord/commands.js";
import { COMMAND_HANDLERS, type HandlerDeps } from "../src/discord/handlers.js";
import { getDiscordShowcase } from "../src/discord/showcase.js";
import { getMapsRandomDraw, mapsRandomDrawQuery } from "../src/features/maps.js";
import { JobQueue } from "../src/jobs/queue.js";

// /randomfav and the /discord showcase preview both draw one (player, set)
// pair in SQLite now. Neither may read country_maps_snapshots.payload_json:
// the stored GLOBAL payload is 67 MB, and both used to parse it whole inside
// the serving process (the handler even pinned the hydrated pool for 60 s).

const NOW = "2026-07-01T00:00:00.000Z";
const JACK_SET = 301; // ranked, 4K, jack + chordjack, stars 3.0 - 5.0
const STREAM_SET = 302; // loved, 7K, stream, star 6.5

describe("/randomfav and the showcase random-favourite preview", () => {
  let dir = "";
  let db: Db;
  let queue: JobQueue;
  let payloadReads = 0;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-discord-random-fav-"));
    db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    queue = new JobQueue(db);
    payloadReads = 0;
    await seedFixture();
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function seedFixture(): Promise<void> {
    for (const [id, username] of [[101, "Alpha"], [102, "Bravo"], [103, "Charlie"]] as const) {
      await exec(
        db,
        "insert into users (user_id, username, avatar_url, country_code, updated_at) values (?, ?, ?, 'CR', ?)",
        [id, username, `https://a.ppy.sh/${id}`, NOW],
      );
    }
    // 103 has no rank, so the roster join drops them and their favourite row
    // must never reach a pick.
    for (const [userId, rank] of [[101, 1], [102, 2], [103, null]] as const) {
      await exec(
        db,
        "insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at) values ('CR', ?, ?, 'ranking', 1, ?)",
        [userId, rank, NOW],
      );
    }

    await seedBeatmapset(JACK_SET, "ranked", [4], ["jack", "chordjack"], [3, 5]);
    await seedBeatmapset(STREAM_SET, "loved", [7], ["stream"], [6.5]);

    for (const [userId, setId] of [[101, JACK_SET], [102, JACK_SET], [101, STREAM_SET], [103, JACK_SET]] as const) {
      await exec(
        db,
        "insert into country_maps_favourite_sets (country, user_id, beatmapset_id, updated_at) values ('CR', ?, ?, ?)",
        [userId, setId, NOW],
      );
    }

    // The snapshot row only supplies the stamps and the "already built" signal.
    // Its payload is junk on purpose: nothing on this path may parse it.
    for (const country of ["CR", "GLOBAL"]) {
      await exec(
        db,
        "insert into country_maps_snapshots (country, payload_json, generated_at, refreshed_at) values (?, 'not json', ?, ?)",
        [country, NOW, NOW],
      );
    }
  }

  async function seedBeatmapset(
    id: number,
    status: string,
    maniaKeys: number[],
    patterns: string[],
    stars: number[],
  ): Promise<void> {
    await exec(
      db,
      `insert into maps_beatmapsets
         (beatmapset_id, title, artist, creator, status, covers_json, global_play_count, global_favourite_count, preview_url, bpm, mania_keys_json, patterns_json, updated_at)
       values (?, ?, 'Artist', 'Creator', ?, ?, 1000, 50, 'https://b.ppy.sh/preview.mp3', 180, ?, ?, ?)`,
      [
        id,
        `Set ${id}`,
        status,
        JSON.stringify({ cover: `cover-${id}`, card: `card-${id}`, list: `list-${id}` }),
        JSON.stringify(maniaKeys),
        JSON.stringify(patterns),
        NOW,
      ],
    );
    for (const [index, star] of stars.entries()) {
      await exec(
        db,
        `insert into maps_beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, total_length, version, url, updated_at)
         values (?, ?, 'mania', ?, ?, ?, 180, 120, ?, ?, ?)`,
        [id * 10 + index, id, status, maniaKeys[0] ?? 4, star, `Diff ${index}`, `https://osu.ppy.sh/beatmaps/${id * 10 + index}`, NOW],
      );
    }
  }

  // Counts the expensive whole-payload reads. The cheap stamp read selects
  // generated_at / refreshed_at only and never names the column.
  function countingDb(): Db {
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "execute") {
          return (arg: { sql?: string } | string) => {
            const sql = typeof arg === "string" ? arg : arg?.sql ?? "";
            if (sql.includes("payload_json") && sql.trimStart().startsWith("select")) payloadReads += 1;
            return target.execute(arg as never);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  function deps(overrides: { db?: Db } = {}): HandlerDeps {
    return {
      db: overrides.db ?? db,
      osu: {},
      queue,
      config: {
        nodeEnv: "development",
        allowedOrigins: ["http://localhost:3000"],
        trackedCountries: ["CR"],
        trustProxyHeaders: true,
        publicApiRatePerMinute: 240,
        publicCostlyRatePerMinute: 60,
        mapsRefreshIntervalMs: 7 * 24 * 60 * 60 * 1000,
        discordSiteOrigin: "https://mania-tracker.com",
      },
    } as never as HandlerDeps;
  }

  function interaction(options: Record<string, string | number> = {}): DiscordInteraction {
    return {
      id: "1",
      application_id: "2",
      type: 2,
      token: "token",
      data: {
        name: "randomfav",
        options: Object.entries(options).map(([name, value]) => ({
          name,
          type: typeof value === "number" ? 10 : 3,
          value,
        })),
      },
    };
  }

  async function randomFav(options: Record<string, string | number> = {}, over: { db?: Db } = {}) {
    const body = await COMMAND_HANDLERS.randomfav(deps(over), interaction(options));
    return {
      content: body.content ?? null,
      title: body.embeds?.[0]?.title ?? null,
      description: body.embeds?.[0]?.description ?? null,
      components: JSON.stringify(body.components ?? []),
    };
  }

  it("draws the pick in SQLite instead of reading the maps snapshot payload", async () => {
    const reply = await randomFav({ country: "CR" }, { db: countingDb() });

    expect(reply.title).toMatch(/^Artist - Set 30[12]$/);
    expect(reply.description).toContain("Random favourite pick.");
    // The old handler parsed the whole payload_json row (and cached the
    // hydrated pool for 60 s); the draw never touches the column.
    expect(payloadReads).toBe(0);
  });

  it("keeps the reroll row and its filter params", async () => {
    const reply = await randomFav({ country: "CR", keys: "4k", status: "ranked", stars_min: 3 });
    expect(reply.components).toContain("randomfav");
    expect(reply.components).toContain("4k");
    expect(reply.components).toContain("ranked");
  });

  it("filters by keys, status, pattern and star overlap", async () => {
    // The umbrella "jack" chip expands to its canonical siblings, so a set
    // tagged chordjack matches too.
    const jackOnly: Array<Record<string, string | number>> = [{ keys: "4k" }, { status: "ranked" }, { pattern: "jack" }, { stars_max: 4 }];
    const streamOnly: Array<Record<string, string | number>> = [{ keys: "7k" }, { status: "loved" }, { pattern: "stream" }, { stars_min: 6 }];
    for (const options of jackOnly) {
      const reply = await randomFav({ country: "CR", ...options });
      expect(reply.title, JSON.stringify(options)).toBe(`Artist - Set ${JACK_SET}`);
    }
    for (const options of streamOnly) {
      const reply = await randomFav({ country: "CR", ...options });
      expect(reply.title, JSON.stringify(options)).toBe(`Artist - Set ${STREAM_SET}`);
    }
  });

  it("counts only in-scope favouriters for the 'and N others' note", async () => {
    // 101 and 102 favourited the jack set; unranked 103 does not count.
    const jack = await randomFav({ country: "CR", keys: "4k" });
    expect(jack.description).toMatch(/Favourited by (Alpha|Bravo) and 1 other in CR\./);
    const stream = await randomFav({ country: "CR", keys: "7k" });
    expect(stream.description).toBe("Random favourite pick. Favourited by Alpha in CR.");
  });

  it("keeps the empty-filter notice and the still-generating notice", async () => {
    const empty = await randomFav({ country: "CR", stars_min: 9 });
    expect(empty.content).toBe("No maps match those filters in CR. Loosen the filters and try again.");
    expect(empty.title).toBeNull();

    // US has no maps snapshot row at all: the country is still building.
    const building = await randomFav({ country: "US" });
    expect(building.content).toBe("Favourite maps for US are still generating, try again shortly.");
  });

  it("treats 'any' keys as no filter and defaults to the global scope", async () => {
    const reply = await randomFav({ keys: "any" });
    // No country option means GLOBAL, which folds every country's rows.
    expect(reply.title).toMatch(/^Artist - Set 30[12]$/);
    expect(reply.description).toContain("in Global.");
  });

  it("skips a drawn set whose beatmaps are gone", async () => {
    // 303 is favourited by both ranked players but has no maps_beatmaps rows,
    // so it can never be rendered. The batch is drawn wide enough that the
    // reply falls through to a set that can.
    await seedBeatmapset(303, "ranked", [4], ["jack"], []);
    for (const userId of [101, 102]) {
      await exec(
        db,
        "insert into country_maps_favourite_sets (country, user_id, beatmapset_id, updated_at) values ('CR', ?, 303, ?)",
        [userId, NOW],
      );
    }

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const reply = await randomFav({ country: "CR", keys: "4k" });
      expect(reply.title).toBe(`Artist - Set ${JACK_SET}`);
    }
  });

  it("keeps a seeded draw stable so the cached showcase preview does not churn", async () => {
    const draw = (seed: string, weight: "favourites" | "players") =>
      getMapsRandomDraw(db, queue, "CR", 30 * 24 * 60 * 60_000, mapsRandomDrawQuery({ count: 1, seed, weight }));
    const pairOf = (value: Awaited<ReturnType<typeof draw>>) =>
      (value.value?.picks ?? []).map((pick) => `${pick.player.id}:${pick.beatmapset.id}`);

    for (const weight of ["favourites", "players"] as const) {
      const first = pairOf(await draw("fav:CR", weight));
      expect(first).toHaveLength(1);
      // Eligible pairs only: 103 is unranked and can never be drawn.
      expect(first[0]).toMatch(/^10[12]:30[12]$/);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect(pairOf(await draw("fav:CR", weight)), weight).toEqual(first);
      }
    }
  });

  it("builds the showcase preview from the drawn pick", async () => {
    const showcase = await getDiscordShowcase(deps() as never, "CR", true);
    expect(showcase.randomFav).toMatchObject({
      title: expect.stringMatching(/^Artist - Set 30[12]$/) as unknown as string,
      pickedBy: expect.stringMatching(/^(Alpha|Bravo)$/) as unknown as string,
      status: expect.stringMatching(/^(Ranked|Loved)$/) as unknown as string,
    });
    // "and N others" excludes the drawn player, so a set favourited by one
    // in-scope player reports 0.
    expect(showcase.randomFav?.others).toBeGreaterThanOrEqual(0);
    expect(showcase.randomFav?.others).toBeLessThanOrEqual(1);
  });
});
