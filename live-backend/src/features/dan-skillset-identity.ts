import { createHash } from "node:crypto";
import { parseManiaBeatmap } from "../dan/beatmap-parser.js";
import type { DbStatement } from "../db.js";
import { DAN_SKILLSET_CHARTS } from "./dan-skillset-registry.js";

/** Player credentials only: never consumed by the chart difficulty estimator. */
export interface DanSkillsetChart {
  beatmapId: number; // provenance/link only; matching never reads this id
  beatmapsetId: number;
  keyCount: number;
  side: "rc" | "ln";
  skillset: string;
  level: string;
  name: string;
  od: number;
  noteCount: number;
  fingerprint: string;
}

function setting(text: string, section: string, property: string): number {
  const parts = text.split(new RegExp(`^\\[${section}\\]\\s*$`, "m"));
  if (parts.length !== 2) return NaN;
  const body = parts[1].split(/^\[/m)[0];
  const values = [...body.matchAll(new RegExp(`^${property}\\s*:\\s*([^\\r\\n]+)$`, "gm"))];
  return values.length === 1 ? Number(values[0][1]) : NaN;
}

/** Exact note geometry and OD, invariant only to metadata and global offset.
 * No rate normalization, rounding, padding allowance or chart-family shortcut. */
export function danSkillsetFingerprint(text: string): string | null {
  if (setting(text, "General", "Mode") !== 3) return null;
  const od = setting(text, "Difficulty", "OverallDifficulty");
  const keys = setting(text, "Difficulty", "CircleSize");
  if (!Number.isFinite(od) || od < 0 || od > 10 || !Number.isInteger(keys) || keys < 1) return null;
  const map = parseManiaBeatmap(text);
  if (!map.notes.length || map.keyCount !== keys || map.od !== od || map.notes.some((n) =>
    !Number.isFinite(n.time) || !Number.isFinite(n.endTime) || n.endTime < n.time)) return null;
  const notes = [...map.notes].sort((a, b) => a.time - b.time || a.column - b.column || a.endTime - b.endTime);
  const origin = notes[0].time;
  const hash = createHash("sha256").update(`dan-skillset-v1:${keys}:${od}:`);
  for (const note of notes) hash.update(`${note.column},${note.time - origin},${note.endTime - origin},${Number(note.isHold)};`);
  return hash.digest("hex");
}

export const DAN_SKILLSET_BY_FINGERPRINT = new Map<string, DanSkillsetChart>(
  DAN_SKILLSET_CHARTS.map((chart) => [chart.fingerprint, chart]),
);

/** Written in the same transaction as a cached file replacement, so an edit
 * cannot keep a credential that belonged to the previous file. */
export function danSkillsetMatchStatement(beatmapId: number, text: string, fetchedAt: string): DbStatement {
  const fingerprint = danSkillsetFingerprint(text);
  return fingerprint && DAN_SKILLSET_BY_FINGERPRINT.has(fingerprint)
    ? {
      sql: `insert into dan_skillset_chart_matches (beatmap_id, fingerprint, checksum)
        select ?, ?, ? where exists (select 1 from beatmap_osu_files where beatmap_id = ? and fetched_at = ?)
        on conflict(beatmap_id) do update set fingerprint = excluded.fingerprint, checksum = excluded.checksum`,
      args: [beatmapId, fingerprint, createHash("md5").update(text).digest("hex"), beatmapId, fetchedAt],
    }
    : {
      sql: `delete from dan_skillset_chart_matches where beatmap_id = ?
        and exists (select 1 from beatmap_osu_files where beatmap_id = ? and fetched_at = ?)`,
      args: [beatmapId, beatmapId, fetchedAt],
    };
}
