import type { Db } from "../db.js";
import { exec } from "../db.js";

// Owner-curated dan benchmark ground truth, migrated from the legacy frontend Turso store. Labels
// pin the expected dan for a beatmap (per estimator family); hidden diffs exclude a beatmap from the
// benchmark entirely. Written from the /admin/dan-classifier page and read by the dan benchmark CLI
// (scripts/dan-benchmark.ts in the frontend repo root). Every endpoint is admin-token gated.
// Timestamps are epoch ms. Durable: retention never touches these tables.

export type DanBenchmarkFamily = "normal" | "ln" | "ranked";

const FAMILIES: readonly DanBenchmarkFamily[] = ["normal", "ln", "ranked"];
const LABEL_MAX = 32;

export function isDanBenchmarkFamily(value: unknown): value is DanBenchmarkFamily {
  return FAMILIES.includes(value as DanBenchmarkFamily);
}

export interface DanBenchmarkLabel {
  beatmapId: number;
  expectedLabel: string;
  family: DanBenchmarkFamily;
  updatedAt: number;
}

function normalizeBeatmapId(value: unknown): number | null {
  const beatmapId = Number(value);
  return Number.isSafeInteger(beatmapId) && beatmapId > 0 ? beatmapId : null;
}

function normalizeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, LABEL_MAX);
  return trimmed.length ? trimmed : null;
}

export async function listDanBenchmarkLabels(db: Db, family: DanBenchmarkFamily): Promise<DanBenchmarkLabel[]> {
  const result = await exec(
    db,
    "select beatmap_id, expected_label, family, updated_at from dan_benchmark_labels where family = ?",
    [family],
  );
  return result.rows.map((row) => ({
    beatmapId: Number(row.beatmap_id),
    expectedLabel: String(row.expected_label),
    family: String(row.family) as DanBenchmarkFamily,
    updatedAt: Number(row.updated_at),
  }));
}

// expectedLabel null clears the label (same contract as the legacy store: the admin page sends an
// empty label to un-pin a beatmap). beatmap_id is the primary key, so a beatmap has at most one
// label regardless of family.
export async function setDanBenchmarkLabel(
  db: Db,
  input: { beatmapId?: unknown; family?: unknown; expectedLabel?: unknown },
): Promise<boolean> {
  const beatmapId = normalizeBeatmapId(input.beatmapId);
  if (beatmapId === null || !isDanBenchmarkFamily(input.family)) return false;
  const expectedLabel = input.expectedLabel === null || input.expectedLabel === "" ? null : normalizeLabel(input.expectedLabel);
  if (expectedLabel === null) {
    await exec(db, "delete from dan_benchmark_labels where beatmap_id = ?", [beatmapId]);
    return true;
  }
  await exec(
    db,
    `insert into dan_benchmark_labels (beatmap_id, expected_label, family, updated_at)
     values (?, ?, ?, ?)
     on conflict(beatmap_id) do update set
       expected_label = excluded.expected_label,
       family = excluded.family,
       updated_at = excluded.updated_at`,
    [beatmapId, expectedLabel, input.family, Date.now()],
  );
  return true;
}

export async function listDanBenchmarkHiddenDiffs(db: Db, family: DanBenchmarkFamily): Promise<number[]> {
  const result = await exec(db, "select beatmap_id from dan_benchmark_hidden_diffs where family = ?", [family]);
  return result.rows.map((row) => Number(row.beatmap_id));
}

export async function setDanBenchmarkHiddenDiff(
  db: Db,
  input: { beatmapId?: unknown; family?: unknown; hidden?: unknown },
): Promise<boolean> {
  const beatmapId = normalizeBeatmapId(input.beatmapId);
  if (beatmapId === null || !isDanBenchmarkFamily(input.family)) return false;
  if (input.hidden !== true) {
    await exec(db, "delete from dan_benchmark_hidden_diffs where beatmap_id = ?", [beatmapId]);
    return true;
  }
  await exec(
    db,
    `insert into dan_benchmark_hidden_diffs (beatmap_id, family, updated_at)
     values (?, ?, ?)
     on conflict(beatmap_id) do update set
       family = excluded.family,
       updated_at = excluded.updated_at`,
    [beatmapId, input.family, Date.now()],
  );
  return true;
}

// One-time bulk import from the Turso JSON export. Upserts row-by-row and preserves the exported
// updated_at stamps so curation history survives the move. Safe to re-run: same input, same rows.
export async function importDanBenchmark(
  db: Db,
  payload: {
    labels?: Array<{ beatmap_id?: unknown; expected_label?: unknown; family?: unknown; updated_at?: unknown }>;
    hidden?: Array<{ beatmap_id?: unknown; family?: unknown; updated_at?: unknown }>;
  },
): Promise<{ labels: number; hidden: number; skipped: number }> {
  let labels = 0;
  let hidden = 0;
  let skipped = 0;
  for (const row of Array.isArray(payload.labels) ? payload.labels : []) {
    const beatmapId = normalizeBeatmapId(row.beatmap_id);
    const expectedLabel = normalizeLabel(row.expected_label);
    if (beatmapId === null || expectedLabel === null || !isDanBenchmarkFamily(row.family)) {
      skipped++;
      continue;
    }
    const updatedAt = Number.isFinite(Number(row.updated_at)) && Number(row.updated_at) > 0 ? Number(row.updated_at) : Date.now();
    await exec(
      db,
      `insert into dan_benchmark_labels (beatmap_id, expected_label, family, updated_at)
       values (?, ?, ?, ?)
       on conflict(beatmap_id) do update set
         expected_label = excluded.expected_label,
         family = excluded.family,
         updated_at = excluded.updated_at`,
      [beatmapId, expectedLabel, row.family, updatedAt],
    );
    labels++;
  }
  for (const row of Array.isArray(payload.hidden) ? payload.hidden : []) {
    const beatmapId = normalizeBeatmapId(row.beatmap_id);
    if (beatmapId === null || !isDanBenchmarkFamily(row.family)) {
      skipped++;
      continue;
    }
    const updatedAt = Number.isFinite(Number(row.updated_at)) && Number(row.updated_at) > 0 ? Number(row.updated_at) : Date.now();
    await exec(
      db,
      `insert into dan_benchmark_hidden_diffs (beatmap_id, family, updated_at)
       values (?, ?, ?)
       on conflict(beatmap_id) do update set
         family = excluded.family,
         updated_at = excluded.updated_at`,
      [beatmapId, row.family, updatedAt],
    );
    hidden++;
  }
  return { labels, hidden, skipped };
}
