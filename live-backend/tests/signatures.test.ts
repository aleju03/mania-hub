import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  clearSignatureImages,
  disableUserSignature,
  enableUserSignature,
  getSignaturePurgeTarget,
  getUserSignature,
  listSignaturesForAdmin,
  normalizeSignatureTypes,
  resolveSignatureToken,
  rotateUserSignatureToken,
  setSignatureBlocked,
} from "../src/features/signatures.js";

/* Dynamic renders live behind a URL a player pasted into an osu! profile and
   will never edit again. Two things therefore have to hold: the token is the
   only way to address them (and rotating it really does revoke), and the
   version moves when, and only when, the data a render draws has moved. Get
   the second one wrong and every embed either freezes or re-rasterizes on
   every profile view. */

let dir = "";
let db: Db;

const USER = 101;
const OTHER = 202;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-signatures-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  await exec(db, "insert into users (user_id, username, avatar_url, updated_at) values (?, ?, ?, ?)", [
    USER, "tester", "https://a.ppy.sh/101", "2026-01-01T00:00:00Z",
  ]);
  await exec(db, "insert into users (user_id, username, avatar_url, updated_at) values (?, ?, ?, ?)", [
    OTHER, "other", "https://a.ppy.sh/202", "2026-01-01T00:00:00Z",
  ]);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function versions(userId = USER) {
  const record = await getUserSignature(db, userId);
  const resolved = await resolveSignatureToken(db, record!.token);
  return resolved!.versions;
}

describe("signature opt-in", () => {
  it("mints a token and resolves it back to the player", async () => {
    const record = await enableUserSignature(db, USER, ["maniacard"], null);
    expect(record.token).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    const resolved = await resolveSignatureToken(db, record.token);
    expect(resolved?.userId).toBe(USER);
    expect(resolved?.username).toBe("tester");
    expect(resolved?.enabledTypes).toEqual(["maniacard"]);
  });

  it("gives two players different tokens", async () => {
    const a = await enableUserSignature(db, USER, ["maniacard"], null);
    const b = await enableUserSignature(db, OTHER, ["maniacard"], null);
    expect(a.token).not.toBe(b.token);
  });

  /* Re-enabling must not mint a new token: a player who toggles the feature
     off and on would otherwise silently break every URL already pasted. */
  it("keeps the same token across disable and re-enable", async () => {
    const first = await enableUserSignature(db, USER, ["maniacard"], null);
    await disableUserSignature(db, USER);
    expect(await resolveSignatureToken(db, first.token)).toBeNull();
    const again = await enableUserSignature(db, USER, ["maniacard", "goals"], null);
    expect(again.token).toBe(first.token);
    expect((await resolveSignatureToken(db, first.token))?.enabledTypes).toEqual(["maniacard", "goals"]);
  });

  it("rotating is the revoke: the old token stops resolving", async () => {
    const first = await enableUserSignature(db, USER, ["maniacard"], null);
    const rotated = await rotateUserSignatureToken(db, USER);
    expect(rotated!.token).not.toBe(first.token);
    expect(await resolveSignatureToken(db, first.token)).toBeNull();
    expect((await resolveSignatureToken(db, rotated!.token))?.userId).toBe(USER);
  });

  it("refuses unknown tokens", async () => {
    expect(await resolveSignatureToken(db, "nope")).toBeNull();
  });

  /* One token addresses every published type, so a player who publishes only
     their maniacard must not have a working goals URL hanging off it. */
  it("reports only the types the player published", async () => {
    const record = await enableUserSignature(db, USER, ["maniacard"], null);
    const resolved = await resolveSignatureToken(db, record.token);
    expect(resolved?.enabledTypes).not.toContain("goals");
  });

  it("normalizes the type list and drops junk", () => {
    // Deduped and put back in declaration order, which is the order the page
    // shows them in - so a reorder there reorders a stored list on its next
    // write rather than leaving the two disagreeing.
    expect(normalizeSignatureTypes(["maniacard", "nonsense", "goals", "maniacard"]))
      .toEqual(["goals", "maniacard"]);
    expect(normalizeSignatureTypes("not an array")).toEqual([]);
    expect(normalizeSignatureTypes([])).toEqual([]);
  });
});

describe("signature versions", () => {
  beforeEach(async () => {
    await enableUserSignature(db, USER, ["maniacard", "goals", "skills", "dan", "insights"], null);
  });

  it("is stable while nothing changes", async () => {
    expect(await versions()).toEqual(await versions());
  });

  it("moves the maniacard version when the profile snapshot is rewritten", async () => {
    const before = await versions();
    await exec(
      db,
      `insert into profile_snapshots (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at)
       values (?, 'tester', '{}', '[]', 200, ?, ?, ?)`,
      [USER, "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z"],
    );
    expect((await versions()).maniacard).not.toBe(before.maniacard);
  });

  it("moves the skills and dan versions when a rating is computed", async () => {
    const before = await versions();
    await exec(
      db,
      `insert into player_skill_ratings (user_id, analysis_version, status, computed_at, updated_at)
       values (?, 16, 'ready', ?, ?)`,
      [USER, "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z"],
    );
    const after = await versions();
    expect(after.skills).not.toBe(before.skills);
    expect(after.dan).not.toBe(before.dan);
  });

  /* computePlayerSkillsJob stamps updated_at when it flips status to
     'running', before it has computed anything. Keying on updated_at would
     re-render the identical image every time a recompute merely started. */
  it("does not move the skills version when a job only starts running", async () => {
    await exec(
      db,
      `insert into player_skill_ratings (user_id, analysis_version, status, computed_at, updated_at)
       values (?, 16, 'ready', ?, ?)`,
      [USER, "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z"],
    );
    const before = await versions();
    await exec(
      db,
      "update player_skill_ratings set status = 'ready', updated_at = ? where user_id = ? and analysis_version = 16",
      ["2026-01-03T00:00:00Z", USER],
    );
    expect((await versions()).skills).toBe(before.skills);
  });

  it("moves the goals version when a goal is added", async () => {
    const before = await versions();
    await exec(
      db,
      `insert into user_goals (id, user_id, kind, status, created_at, updated_at)
       values ('g1', ?, 'reach_pp', 'open', 1000, 1000)`,
      [USER],
    );
    expect((await versions()).goals).not.toBe(before.goals);
  });

  /* GoalProgress is computed live and never written back to user_goals, so a
     bar that advances because the player's pp climbed has to be picked up
     from the play-side stamps instead. */
  it("moves the goals version when the player's stats move, not just the goal row", async () => {
    await exec(
      db,
      `insert into user_goals (id, user_id, kind, status, created_at, updated_at)
       values ('g1', ?, 'reach_pp', 'open', 1000, 1000)`,
      [USER],
    );
    const before = await versions();
    await exec(db, "update users set pp = 5000, updated_at = ? where user_id = ?", ["2026-02-01T00:00:00Z", USER]);
    expect((await versions()).goals).not.toBe(before.goals);
  });

  /* An insights render names the player's NEWEST top play, and projectTopPlays
     overlays live score events onto the stored window - so that line can be
     right before the snapshot row is rewritten. Without the event stamp the
     one reading the image exists for would be the last to move. */
  it("moves the insights version when a score event lands", async () => {
    const before = await versions();
    await exec(
      db,
      `insert into score_events
         (score_id, score_identity, user_id, country, beatmap_id, ruleset_id, score_json,
          passed, is_lazer, has_replay, ended_at, received_at, source)
       values (1, 'score:1', ?, 'CR', 5, 3, '{}', 1, 1, 0, ?, ?, 'test')`,
      [USER, "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z"],
    );
    const after = await versions();
    expect(after.insights).not.toBe(before.insights);
    // The same play does not move a maniacard: card power comes off the
    // stored top-play window, not off the event stream.
    expect(after.maniacard).toBe(before.maniacard);
  });

  it("moves the insights version when the top-play window is refreshed", async () => {
    const before = await versions();
    await exec(
      db,
      "update users set top_scores_refreshed_at = ? where user_id = ?",
      ["2026-02-01T00:00:00Z", USER],
    );
    expect((await versions()).insights).not.toBe(before.insights);
  });

  it("does not move the insights version when only a goal changes", async () => {
    const before = await versions();
    await exec(
      db,
      `insert into user_goals (id, user_id, kind, status, created_at, updated_at)
       values ('g3', ?, 'reach_pp', 'open', 1000, 1000)`,
      [USER],
    );
    const after = await versions();
    expect(after.goals).not.toBe(before.goals);
    expect(after.insights).toBe(before.insights);
  });

  it("does not move any version when a different player's data changes", async () => {
    const before = await versions();
    await exec(db, "update users set pp = 9999, updated_at = ? where user_id = ?", ["2026-03-01T00:00:00Z", OTHER]);
    await exec(
      db,
      `insert into user_goals (id, user_id, kind, status, created_at, updated_at)
       values ('g2', ?, 'reach_pp', 'open', 2000, 2000)`,
      [OTHER],
    );
    expect(await versions()).toEqual(before);
  });

  it("keeps each type's version independent", async () => {
    const before = await versions();
    await exec(
      db,
      `insert into player_skill_ratings (user_id, analysis_version, status, computed_at, updated_at)
       values (?, 16, 'ready', ?, ?)`,
      [USER, "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z"],
    );
    const after = await versions();
    // A skills recompute must not invalidate a stored maniacard render.
    expect(after.maniacard).toBe(before.maniacard);
    expect(after.goals).toBe(before.goals);
  });
});

/* The look a player picks is stored beside the opt-in rather than carried in
   the image URL, so it has to behave exactly like data does: changing it
   supersedes that type's stored render, and changing nothing re-renders
   nothing. */
describe("signature styles", () => {
  const style = (patch: Record<string, unknown> = {}) => ({
    maniacard: { background: "cover", accent: "auto", opacity: 55, blur: 6, ...patch },
  });

  it("stores the style map and hands it back on resolve", async () => {
    const record = await enableUserSignature(db, USER, ["maniacard"], null, JSON.stringify(style()));
    expect(record.styles).toEqual(style());
    const resolved = await resolveSignatureToken(db, record.token);
    expect(resolved?.styles).toEqual(style());
  });

  it("moves only that type's version when its style changes", async () => {
    await enableUserSignature(db, USER, ["maniacard", "goals"], null, JSON.stringify(style()));
    const before = await versions();
    await enableUserSignature(db, USER, ["maniacard", "goals"], null, JSON.stringify(style({ blur: 18 })));
    const after = await versions();
    expect(after.maniacard).not.toBe(before.maniacard);
    // A background change on the card must not re-rasterize the goals image.
    expect(after.goals).toBe(before.goals);
    expect(after.skills).toBe(before.skills);
  });

  /* Skills and dan read the same rating row, so before styles existed they
     shared one version. They are styled apart now and must move apart. */
  it("keeps dan's version independent of skills' style", async () => {
    await enableUserSignature(db, USER, ["skills", "dan"], null, JSON.stringify({
      skills: { background: "none", accent: "auto", opacity: 55, blur: 6 },
      dan: { background: "none", accent: "auto", opacity: 55, blur: 6 },
    }));
    const before = await versions();
    await enableUserSignature(db, USER, ["skills", "dan"], null, JSON.stringify({
      skills: { background: "abyss", accent: "cyan", opacity: 55, blur: 6 },
      dan: { background: "none", accent: "auto", opacity: 55, blur: 6 },
    }));
    const after = await versions();
    expect(after.skills).not.toBe(before.skills);
    expect(after.dan).toBe(before.dan);
  });

  it("does not move a version when the same style is written again", async () => {
    await enableUserSignature(db, USER, ["maniacard"], null, JSON.stringify(style()));
    const before = await versions();
    await enableUserSignature(db, USER, ["maniacard"], null, JSON.stringify(style()));
    expect(await versions()).toEqual(before);
  });

  /* Key order is not part of the identity: the page serializes in a fixed
     order today, and a future reorder must not silently re-render every
     signature on the site. */
  it("treats a reordered style object as unchanged", async () => {
    await enableUserSignature(db, USER, ["maniacard"], null, JSON.stringify({
      maniacard: { background: "cover", accent: "auto", opacity: 55, blur: 6 },
    }));
    const before = await versions();
    await enableUserSignature(db, USER, ["maniacard"], null, JSON.stringify({
      maniacard: { blur: 6, opacity: 55, accent: "auto", background: "cover" },
    }));
    expect(await versions()).toEqual(before);
  });

  /* Publishing a type sends no style, and must not wipe the look the player
     already chose. */
  it("leaves the stored style alone when a publish omits it", async () => {
    await enableUserSignature(db, USER, ["maniacard"], null, JSON.stringify(style()));
    const record = await enableUserSignature(db, USER, ["maniacard", "dan"], null);
    expect(record.styles).toEqual(style());
  });

  it("survives a row written before styles existed", async () => {
    const record = await enableUserSignature(db, USER, ["maniacard"], null);
    expect(record.styles).toBeNull();
    const resolved = await resolveSignatureToken(db, record.token);
    expect(resolved?.styles).toBeNull();
    expect(resolved?.versions.maniacard).toMatch(/^[0-9a-f]{12}$/);
  });
});

/* Moderation. The kill switch has to be something the moderated account cannot
   undo, which is why it is its own column rather than a reuse of `enabled` -
   that one is the player's own switch and they can flip it straight back. */
describe("signature moderation", () => {
  const custom = (url: string) => JSON.stringify({
    maniacard: { background: "custom", accent: "auto", opacity: 55, blur: 6, imageUrl: url, keyCount: null },
    goals: { background: "none", accent: "auto", opacity: 55, blur: 6, imageUrl: null, keyCount: null },
  });

  it("stops a blocked token resolving, so every pasted image 404s", async () => {
    const record = await enableUserSignature(db, USER, ["maniacard"], null);
    expect(await resolveSignatureToken(db, record.token)).not.toBeNull();
    expect(await setSignatureBlocked(db, USER, true)).toBe(true);
    expect(await resolveSignatureToken(db, record.token)).toBeNull();
  });

  /* The whole point of a separate column: re-enabling is the player's own
     action, and it must not clear a moderator's decision. */
  it("keeps a block through the player turning their signature off and on", async () => {
    const record = await enableUserSignature(db, USER, ["maniacard"], null);
    await setSignatureBlocked(db, USER, true);
    await disableUserSignature(db, USER);
    await enableUserSignature(db, USER, ["maniacard", "goals"], null);
    expect(await resolveSignatureToken(db, record.token)).toBeNull();
    expect((await getUserSignature(db, USER))?.blockedAt).toBeGreaterThan(0);
  });

  it("keeps a block through a token rotation", async () => {
    await enableUserSignature(db, USER, ["maniacard"], null);
    await setSignatureBlocked(db, USER, true);
    const rotated = await rotateUserSignatureToken(db, USER);
    expect(await resolveSignatureToken(db, rotated!.token)).toBeNull();
  });

  it("restores the player's own setting on unblock rather than forcing it on", async () => {
    const record = await enableUserSignature(db, USER, ["maniacard"], null);
    await setSignatureBlocked(db, USER, true);
    await disableUserSignature(db, USER);
    await setSignatureBlocked(db, USER, false);
    // Unblocked, but the player had switched it off themselves.
    expect(await resolveSignatureToken(db, record.token)).toBeNull();
    await enableUserSignature(db, USER, ["maniacard"], null);
    expect(await resolveSignatureToken(db, record.token)).not.toBeNull();
  });

  it("lists rows newest first and names the owner", async () => {
    await enableUserSignature(db, USER, ["maniacard"], null);
    await enableUserSignature(db, OTHER, ["goals"], null);
    const rows = await listSignaturesForAdmin(db);
    expect(rows.map((row) => row.userId)).toEqual([OTHER, USER]);
    expect(rows[0]!.username).toBe("other");
  });

  it("never hands a token to the moderation list", async () => {
    await enableUserSignature(db, USER, ["maniacard"], null);
    const [row] = await listSignaturesForAdmin(db);
    expect(row).not.toHaveProperty("token");
    expect(JSON.stringify(row)).not.toContain((await getUserSignature(db, USER))!.token);
  });

  it("surfaces the player-supplied urls, deduped, and can filter to just those", async () => {
    await enableUserSignature(db, USER, ["maniacard"], null, custom("https://example.com/a.png"));
    await enableUserSignature(db, OTHER, ["goals"], null);
    const all = await listSignaturesForAdmin(db);
    expect(all).toHaveLength(2);
    const flagged = await listSignaturesForAdmin(db, { customOnly: true });
    expect(flagged.map((row) => row.userId)).toEqual([USER]);
    expect(flagged[0]!.customImageUrls).toEqual(["https://example.com/a.png"]);
  });

  it("clears an image without breaking the signature, and moves the version", async () => {
    const record = await enableUserSignature(db, USER, ["maniacard"], null, custom("https://example.com/a.png"));
    const before = await versions();
    expect(await clearSignatureImages(db, USER)).toBe(true);
    const after = await versions();
    // Superseded, not left waiting for some other change to the player.
    expect(after.maniacard).not.toBe(before.maniacard);
    expect(await resolveSignatureToken(db, record.token)).not.toBeNull();
    expect((await listSignaturesForAdmin(db, { customOnly: true }))).toHaveLength(0);
  });

  it("reports nothing to clear when no picture was set", async () => {
    await enableUserSignature(db, USER, ["maniacard"], null);
    expect(await clearSignatureImages(db, USER)).toBe(false);
  });

  it("reports a miss for a player with no signature", async () => {
    expect(await setSignatureBlocked(db, 999999, true)).toBe(false);
    expect(await clearSignatureImages(db, 999999)).toBe(false);
  });

  /* Clearing is silent and the player can immediately set another picture, so
     the tally is the only thing that makes a repeat visible. */
  it("counts every clear, so a repeat offender is obvious", async () => {
    await enableUserSignature(db, USER, ["maniacard"], null, custom("https://example.com/a.png"));
    expect((await listSignaturesForAdmin(db))[0]!.clearedCount).toBe(0);

    await clearSignatureImages(db, USER);
    expect((await listSignaturesForAdmin(db))[0]!.clearedCount).toBe(1);

    // They set another one and it gets cleared again.
    await enableUserSignature(db, USER, ["maniacard"], null, custom("https://example.com/b.png"));
    await clearSignatureImages(db, USER);
    expect((await listSignaturesForAdmin(db))[0]!.clearedCount).toBe(2);
  });

  it("does not count a clear that found nothing to remove", async () => {
    await enableUserSignature(db, USER, ["maniacard"], null);
    await clearSignatureImages(db, USER);
    expect((await listSignaturesForAdmin(db))[0]!.clearedCount).toBe(0);
  });

  it("keeps the tally across a block, an unblock and a token rotation", async () => {
    await enableUserSignature(db, USER, ["maniacard"], null, custom("https://example.com/a.png"));
    await clearSignatureImages(db, USER);
    await setSignatureBlocked(db, USER, true);
    await setSignatureBlocked(db, USER, false);
    await rotateUserSignatureToken(db, USER);
    expect((await listSignaturesForAdmin(db))[0]!.clearedCount).toBe(1);
  });
});

/* What a caller needs to erase the live copies of a render: the token names the
   URLs an edge cache holds, the versions name the stored objects in R2. */
describe("signature purge target", () => {
  const custom = (url: string) => JSON.stringify({
    maniacard: { background: "custom", accent: "auto", opacity: 55, blur: 6, imageUrl: url, keyCount: null },
  });

  it("names the token and a version for every type", async () => {
    const record = await enableUserSignature(db, USER, ["maniacard"], null);
    const target = await getSignaturePurgeTarget(db, USER);
    expect(target?.token).toBe(record.token);
    for (const type of ["maniacard", "goals", "skills", "dan"] as const) {
      expect(target?.versions[type]).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  /* The reason the route reads this BEFORE it writes: clearing moves the
     version, so a target read afterwards names objects nobody has cached and
     leaves the stale ones in place. */
  it("names the pre-clear versions, which are the ones actually cached", async () => {
    await enableUserSignature(db, USER, ["maniacard"], null, custom("https://example.com/a.png"));
    const before = await getSignaturePurgeTarget(db, USER);
    await clearSignatureImages(db, USER);
    const after = await getSignaturePurgeTarget(db, USER);
    expect(after?.versions.maniacard).not.toBe(before?.versions.maniacard);
  });

  it("follows the token through a rotation", async () => {
    await enableUserSignature(db, USER, ["maniacard"], null);
    const rotated = await rotateUserSignatureToken(db, USER);
    expect((await getSignaturePurgeTarget(db, USER))?.token).toBe(rotated!.token);
  });

  it("has nothing to name for a player with no signature", async () => {
    expect(await getSignaturePurgeTarget(db, 999999)).toBeNull();
  });
});
