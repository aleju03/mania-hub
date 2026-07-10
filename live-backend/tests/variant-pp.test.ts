import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, variantPpUpdateStatement, writeVariantPps, type Db } from "../src/db.js";
import { extractManiaVariantPps } from "../src/shared/score.js";
import { nowIso } from "../src/shared/score.js";

function variants(entries: Array<{ mode?: string; variant?: string; pp?: number | null }>): unknown {
  return { variants: entries };
}

describe("extractManiaVariantPps", () => {
  it("reads 4k and 7k mania variant pp", () => {
    const result = extractManiaVariantPps(variants([
      { mode: "mania", variant: "4k", pp: 1200 },
      { mode: "mania", variant: "7k", pp: 900 },
    ]));
    expect(result).toEqual({ pp4k: 1200, pp7k: 900 });
  });

  it("returns null when there is no variants array (unknown, do not overwrite)", () => {
    expect(extractManiaVariantPps({})).toBeNull();
    expect(extractManiaVariantPps({ variants: "nope" })).toBeNull();
    expect(extractManiaVariantPps(null)).toBeNull();
    expect(extractManiaVariantPps(undefined)).toBeNull();
  });

  it("returns null members when the array is present but a keymode has no positive pp", () => {
    expect(extractManiaVariantPps(variants([]))).toEqual({ pp4k: null, pp7k: null });
    expect(extractManiaVariantPps(variants([{ mode: "mania", variant: "4k", pp: 0 }]))).toEqual({ pp4k: null, pp7k: null });
    expect(extractManiaVariantPps(variants([{ mode: "mania", variant: "4k", pp: 800 }]))).toEqual({ pp4k: 800, pp7k: null });
  });

  it("ignores non-mania and unknown-keymode variants", () => {
    const result = extractManiaVariantPps(variants([
      { mode: "osu", variant: "4k", pp: 5000 },
      { mode: "mania", variant: "10k", pp: 400 },
      { mode: "mania", variant: "7k", pp: 700 },
    ]));
    expect(result).toEqual({ pp4k: null, pp7k: 700 });
  });
});

describe("variantPpUpdateStatement", () => {
  it("returns null for a payload without variants so columns stay intact", () => {
    expect(variantPpUpdateStatement(5, {})).toBeNull();
  });

  it("emits an update that overwrites both columns, including nulls, when variants are present", () => {
    const statement = variantPpUpdateStatement(5, variants([{ mode: "mania", variant: "4k", pp: 800 }]));
    expect(statement).not.toBeNull();
    expect(statement?.args).toEqual([800, null, 5]);
  });
});

describe("writeVariantPps write rule", () => {
  let dir = "";
  let db: Db;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-variant-pp-"));
    db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function insertUser(id: number, profileJson: string | null): Promise<void> {
    await exec(
      db,
      "insert into users (user_id, username, avatar_url, pp, profile_json, updated_at) values (?, ?, ?, ?, ?, ?)",
      [id, `User${id}`, "", 5000, profileJson, nowIso()],
    );
  }

  async function readPps(id: number): Promise<{ pp4k: unknown; pp7k: unknown }> {
    const row = (await exec(db, "select pp_4k, pp_7k from users where user_id = ?", [id])).rows[0];
    return { pp4k: row?.pp_4k ?? null, pp7k: row?.pp_7k ?? null };
  }

  it("leaves existing columns intact when the payload carries no variants", async () => {
    await insertUser(1, null);
    await exec(db, "update users set pp_4k = ?, pp_7k = ? where user_id = ?", [1111, 2222, 1]);
    await writeVariantPps(db, 1, { pp: 5000 });
    expect(await readPps(1)).toEqual({ pp4k: 1111, pp7k: 2222 });
  });

  it("overwrites both columns, nulling a decayed keymode, when variants are present", async () => {
    await insertUser(2, null);
    await exec(db, "update users set pp_4k = ?, pp_7k = ? where user_id = ?", [1111, 2222, 2]);
    await writeVariantPps(db, 2, variants([{ mode: "mania", variant: "4k", pp: 1300 }]));
    expect(await readPps(2)).toEqual({ pp4k: 1300, pp7k: null });
  });

  it("backfills pp columns from stored profile_json on migration", async () => {
    const profile = JSON.stringify({
      id: 3,
      statistics: { pp: 5000, variants: [{ mode: "mania", variant: "4k", pp: 640 }, { mode: "mania", variant: "7k", pp: 910 }] },
    });
    await insertUser(3, profile);
    // The boot migration already ran (over an empty table) and set the backfill
    // guard, so clear it and re-run migrate to exercise the backfill over the
    // seeded row.
    await exec(db, "delete from live_meta where key = 'farm_helper_variant_pp_backfill:v1'");
    await migrate(db);
    expect(await readPps(3)).toEqual({ pp4k: 640, pp7k: 910 });
  });
});
