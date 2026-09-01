/**
 * Re-folds the dan block of one or more stored rows from their plays_json, the
 * way the dan sweep does, so a local database shows the current credit rules
 * without waiting on workers that are not running.
 *
 * The sweep only touches rows stamped at the current PLAYER_SKILLS_VERSION,
 * and a local snapshot is usually a few versions back, so each named row is
 * restamped before the fold. That is a local convenience, not something to run
 * against prod: it calls a row current whose plays were gathered under an
 * older pipeline.
 *
 * Run:
 *   npx tsx scripts/dev/recompute-user-dan.ts Aleju03 Lovelyn
 */
import { createClient } from "@libsql/client";
import { PLAYER_SKILLS_VERSION, recomputePlayerSkillDanChunk } from "../../src/features/player-skills.js";

const DB_URL = process.env.SWEEP_DB_URL ?? "file:data/mania-hub-live.db";

function danSummary(modesJson: unknown): string {
  try {
    const parsed = JSON.parse(String(modesJson ?? ""));
    const modes = Array.isArray(parsed?.modes) ? parsed.modes : [];
    return modes
      .map((mode: any) => {
        const parts = (["rc", "ln"] as const)
          .map((side) => (mode.dan?.[side] ? `${side} ${mode.dan[side].label} (${mode.dan[side].rawDan.toFixed(2)}, ${mode.dan[side].clears} clears)` : null))
          .filter(Boolean);
        return parts.length ? `${mode.keyCount}K ${parts.join(" | ")}` : null;
      })
      .filter(Boolean)
      .join("\n    ");
  } catch {
    return "(unreadable)";
  }
}

async function main(): Promise<void> {
  const usernames = process.argv.slice(2);
  if (usernames.length === 0) throw new Error("pass one or more usernames");
  const db = createClient({ url: DB_URL });

  const users = (await db.execute({
    sql: `select user_id, username from users where username in (${usernames.map(() => "?").join(",")})`,
    args: usernames,
  })).rows;
  for (const username of usernames) {
    if (!users.some((row) => String(row.username) === username)) console.log(`! no user named ${username}`);
  }

  for (const user of users) {
    const userId = Number(user.user_id);
    const before = (await db.execute({
      sql: "select modes_json, analysis_version from player_skill_ratings where user_id = ? and status = 'ready' order by analysis_version desc limit 1",
      args: [userId],
    })).rows[0];
    if (!before) {
      console.log(`! ${user.username} (${userId}) has no ready row`);
      continue;
    }
    console.log(`\n${user.username} (${userId}), stored at v${before.analysis_version}:\n    ${danSummary(before.modes_json)}`);

    await db.execute({
      sql: "update player_skill_ratings set analysis_version = ? where user_id = ? and analysis_version = ?",
      args: [PLAYER_SKILLS_VERSION, userId, Number(before.analysis_version)],
    });
    // The chunk reads rows with user_id > cursor in id order, so one id behind
    // this user with a limit of one folds exactly this user.
    const result = await recomputePlayerSkillDanChunk(db as any, userId - 1, 1, "all");
    const after = (await db.execute({
      sql: "select modes_json from player_skill_ratings where user_id = ? and analysis_version = ?",
      args: [userId, PLAYER_SKILLS_VERSION],
    })).rows[0];
    console.log(`  refolded (scanned ${result.scanned}, rewritten ${result.rewritten}):\n    ${danSummary(after?.modes_json)}`);
  }
}

await main();
