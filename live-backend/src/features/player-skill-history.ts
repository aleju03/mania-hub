import { exec, execBatch, json, parseJson, withWriteTurn, type Db, type DbStatement } from "../db.js";
import type { PlayerSkillModeBreakdown } from "./player-skills.js";

export interface PlayerSkillHistorySnapshot {
  ratings: Record<string, number>;
  dan: Record<"rc" | "ln", { label: string; beyondTable: boolean } | null>;
}

export interface PlayerSkillHistoryEntry {
  id: number;
  recordedAt: string;
  version: number;
  snapshot: PlayerSkillHistorySnapshot;
  previous: PlayerSkillHistorySnapshot | null;
}

export interface PlayerSkillHistoryPage {
  items: PlayerSkillHistoryEntry[];
  nextBefore: number | null;
}

// Only values visible on the card are compared. Changes to play counts,
// evidence ordering, percentile ranks or sub-cent precision aren't events.
function snapshotFor(mode: PlayerSkillModeBreakdown): PlayerSkillHistorySnapshot {
  const patterns = (mode.patterns ?? []).filter((entry) =>
    ["chordstream", "bracket", "delay", "stream", "jack", "tech", "ln"].includes(entry.id) && entry.rating >= 1);
  const patternAxes = [6, 7, 8].includes(mode.keyCount) && patterns.length > 0;
  const values: Record<string, number> = { Overall: Number(mode.ratings.Overall ?? 0) };
  if (!patternAxes) {
    for (const [axis, value] of Object.entries(mode.ratings)) {
      if (axis !== "Overall" && value >= 1) values[axis] = value;
    }
  }
  for (const entry of patterns) {
    if (patternAxes || entry.id === "ln") values[`pattern:${entry.id}`] = entry.rating;
  }
  const danSide = (side: "rc" | "ln") => {
    const dan = mode.dan?.[side];
    return dan ? { label: dan.label, beyondTable: dan.beyondTable === true } : null;
  };
  return {
    ratings: Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b, "en-US"))
      .map(([axis, value]) => [axis, Number(value.toFixed(2))])),
    dan: { rc: danSide("rc"), ln: danSide("ln") },
  };
}

function validModes(modes: PlayerSkillModeBreakdown[]): PlayerSkillModeBreakdown[] {
  return modes.filter((mode) => mode && Number.isInteger(mode.keyCount) && mode.keyCount >= 4 && mode.keyCount <= 18
    && mode.ratings && typeof mode.ratings === "object" && Number.isFinite(mode.ratings.Overall));
}

async function latestStoredModes(db: Db, userId: number) {
  const rows = (await exec(db, `select analysis_version, modes_json, computed_at, updated_at, status
    from player_skill_ratings where user_id = ? and modes_json is not null order by analysis_version desc`, [userId])).rows;
  for (const row of rows) {
    const summary = parseJson<{ modes?: PlayerSkillModeBreakdown[] }>(String(row.modes_json), {});
    if (!Array.isArray(summary.modes)) continue;
    return {
      version: Number(row.analysis_version),
      recordedAt: String((row.status === "ready" ? row.updated_at : row.computed_at) ?? row.updated_at),
      modes: validModes(summary.modes),
    };
  }
  return null;
}

/** Commit the rating and its history together, including guarded sweep writes.
 * The first update preserves the last stored rating as an initial reference;
 * it never tries to reconstruct changes that predate history recording. */
export async function writePlayerSkillRatingWithHistory(
  db: Db,
  userId: number,
  version: number,
  modes: PlayerSkillModeBreakdown[],
  recordedAt: string,
  statement: DbStatement,
) {
  return withWriteTurn(db, async () => {
    const previous = await latestStoredModes(db, userId);
    // Runtime import avoids a module-init cycle through the rating engine.
    const { shrinkPlayerSkillModes } = await import("./skill-baseline.js");
    const allModes = await shrinkPlayerSkillModes(db, [...(previous?.modes ?? []), ...validModes(modes)]);
    const oldModes = allModes.slice(0, previous?.modes.length ?? 0);
    const newModes = allModes.slice(previous?.modes.length ?? 0);
    const statements: DbStatement[] = [statement];
    const append = (mode: PlayerSkillModeBreakdown, at: string, analysisVersion: number, initial: boolean) => {
      const snapshot = json(snapshotFor(mode));
      statements.push({
        sql: `insert into player_skill_history (user_id, key_count, analysis_version, recorded_at, snapshot_json)
          select ?, ?, ?, ?, ?
          where exists (select 1 from player_skill_ratings
            where user_id = ? and analysis_version = ? and updated_at = ? and status = 'ready')
          and ${initial
            ? "not exists (select 1 from player_skill_history where user_id = ? and key_count = ?)"
            : "(select snapshot_json from player_skill_history where user_id = ? and key_count = ? order by id desc limit 1) is not ?"}`,
        args: [userId, mode.keyCount, analysisVersion, at, snapshot, userId, version, recordedAt,
          userId, mode.keyCount, ...(initial ? [] : [snapshot])],
      });
    };
    for (const mode of oldModes) append(mode, previous!.recordedAt, previous!.version, true);
    for (const mode of newModes) append(mode, recordedAt, version, false);
    // A keymode removed by a recalculation is a change too.
    for (const mode of oldModes) {
      if (!newModes.some((next) => next.keyCount === mode.keyCount)) {
        append({ ...mode, ratings: { Overall: 0 }, patterns: [], dan: { rc: null, ln: null } }, recordedAt, version, false);
      }
    }
    return (await execBatch(db, statements))[0];
  });
}

/** Read-only, keyset-paged history: a new event cannot shift later pages. */
export async function getPlayerSkillHistory(
  db: Db, userId: number, keyCount: number, options: { before?: number; limit?: number } = {},
): Promise<PlayerSkillHistoryPage> {
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 25)));
  const rows = (await exec(db, `select id, analysis_version, recorded_at, snapshot_json
    from player_skill_history where user_id = ? and key_count = ? ${options.before ? "and id < ?" : ""}
    order by id desc limit ?`, [userId, keyCount, ...(options.before ? [options.before] : []), limit + 1])).rows;
  if (rows.length === 0 && !options.before) {
    const stored = await latestStoredModes(db, userId);
    const mode = stored?.modes.find((entry) => entry.keyCount === keyCount);
    if (stored && mode) {
      const { shrinkPlayerSkillModes } = await import("./skill-baseline.js");
      const [display] = await shrinkPlayerSkillModes(db, [mode]);
      return { items: [{ id: 0, recordedAt: stored.recordedAt, version: stored.version, snapshot: snapshotFor(display), previous: null }], nextBefore: null };
    }
  }
  const entries = rows.map((row) => ({
    id: Number(row.id), recordedAt: String(row.recorded_at), version: Number(row.analysis_version),
    snapshot: parseJson<PlayerSkillHistorySnapshot>(String(row.snapshot_json), { ratings: {}, dan: { rc: null, ln: null } }),
  }));
  const items = entries.slice(0, limit).map((entry, index) => ({ ...entry, previous: entries[index + 1]?.snapshot ?? null }));
  return { items, nextBefore: entries.length > limit ? items[items.length - 1].id : null };
}
