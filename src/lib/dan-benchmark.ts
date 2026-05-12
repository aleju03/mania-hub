import { createServerFn } from "@tanstack/react-start";
import { requireTrueAdminAccess } from "./auth";
import { db, ensureCacheSchema, hasDb } from "./db";
import type { DanBenchmarkFamily } from "./dan-benchmark-sets";

export interface DanBenchmarkLabel {
  beatmapId: number;
  expectedLabel: string;
  family: DanBenchmarkFamily;
  updatedAt: number;
}

function isBenchmarkFamily(value: unknown): value is DanBenchmarkFamily {
  return value === "normal" || value === "ln" || value === "ranked";
}

function normalizeListPayload(input: unknown): { family: DanBenchmarkFamily } {
  if (!input || typeof input !== "object") throw new Error("Invalid payload.");
  const data = input as { family?: unknown };
  if (!isBenchmarkFamily(data.family)) throw new Error("Invalid family.");
  return { family: data.family };
}

function normalizeSavePayload(input: unknown): {
  beatmapId: number;
  family: DanBenchmarkFamily;
  expectedLabel: string | null;
} {
  if (!input || typeof input !== "object") throw new Error("Invalid payload.");
  const data = input as { beatmapId?: unknown; family?: unknown; expectedLabel?: unknown };
  const beatmapId = Number(data.beatmapId);
  if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) throw new Error("Invalid beatmapId.");
  if (!isBenchmarkFamily(data.family)) throw new Error("Invalid family.");
  const expectedLabel = data.expectedLabel === null || data.expectedLabel === ""
    ? null
    : typeof data.expectedLabel === "string" && data.expectedLabel.length <= 32
      ? data.expectedLabel
      : null;
  return { beatmapId, family: data.family, expectedLabel };
}

export const getDanBenchmarkLabels = createServerFn({ method: "GET" })
  .inputValidator(normalizeListPayload)
  .handler(async ({ data }: { data: { family: DanBenchmarkFamily } }): Promise<DanBenchmarkLabel[]> => {
    await requireTrueAdminAccess("getDanBenchmarkLabels");
    if (!hasDb() || !db) return [];
    await ensureCacheSchema();

    const result = await db.execute({
      sql: `
        SELECT beatmap_id, expected_label, family, updated_at
        FROM dan_benchmark_labels
        WHERE family = ?
      `,
      args: [data.family],
    });

    return result.rows.map((row) => ({
      beatmapId: Number(row.beatmap_id),
      expectedLabel: String(row.expected_label),
      family: String(row.family) as DanBenchmarkFamily,
      updatedAt: Number(row.updated_at),
    }));
  });

function normalizeHidePayload(input: unknown): {
  beatmapId: number;
  family: DanBenchmarkFamily;
  hidden: boolean;
} {
  if (!input || typeof input !== "object") throw new Error("Invalid payload.");
  const data = input as { beatmapId?: unknown; family?: unknown; hidden?: unknown };
  const beatmapId = Number(data.beatmapId);
  if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) throw new Error("Invalid beatmapId.");
  if (!isBenchmarkFamily(data.family)) throw new Error("Invalid family.");
  const hidden = data.hidden === true;
  return { beatmapId, family: data.family, hidden };
}

export const getDanBenchmarkHiddenDiffs = createServerFn({ method: "GET" })
  .inputValidator(normalizeListPayload)
  .handler(async ({ data }: { data: { family: DanBenchmarkFamily } }): Promise<number[]> => {
    await requireTrueAdminAccess("getDanBenchmarkHiddenDiffs");
    if (!hasDb() || !db) return [];
    await ensureCacheSchema();

    const result = await db.execute({
      sql: `SELECT beatmap_id FROM dan_benchmark_hidden_diffs WHERE family = ?`,
      args: [data.family],
    });

    return result.rows.map((row) => Number(row.beatmap_id));
  });

export const setDanBenchmarkHiddenDiff = createServerFn({ method: "POST" })
  .inputValidator(normalizeHidePayload)
  .handler(async ({ data }: { data: { beatmapId: number; family: DanBenchmarkFamily; hidden: boolean } }): Promise<{ ok: true }> => {
    await requireTrueAdminAccess("setDanBenchmarkHiddenDiff");
    if (!hasDb() || !db) return { ok: true };
    await ensureCacheSchema();

    if (!data.hidden) {
      await db.execute({
        sql: `DELETE FROM dan_benchmark_hidden_diffs WHERE beatmap_id = ?`,
        args: [data.beatmapId],
      });
      return { ok: true };
    }

    const now = Date.now();
    await db.execute({
      sql: `
        INSERT INTO dan_benchmark_hidden_diffs (beatmap_id, family, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(beatmap_id) DO UPDATE SET
          family = excluded.family,
          updated_at = excluded.updated_at
      `,
      args: [data.beatmapId, data.family, now],
    });

    return { ok: true };
  });

export const setDanBenchmarkLabel = createServerFn({ method: "POST" })
  .inputValidator(normalizeSavePayload)
  .handler(async ({ data }: { data: { beatmapId: number; family: DanBenchmarkFamily; expectedLabel: string | null } }): Promise<{ ok: true }> => {
    await requireTrueAdminAccess("setDanBenchmarkLabel");
    if (!hasDb() || !db) return { ok: true };
    await ensureCacheSchema();

    if (data.expectedLabel === null) {
      await db.execute({
        sql: `DELETE FROM dan_benchmark_labels WHERE beatmap_id = ?`,
        args: [data.beatmapId],
      });
      return { ok: true };
    }

    const now = Date.now();
    await db.execute({
      sql: `
        INSERT INTO dan_benchmark_labels (beatmap_id, expected_label, family, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(beatmap_id) DO UPDATE SET
          expected_label = excluded.expected_label,
          family = excluded.family,
          updated_at = excluded.updated_at
      `,
      args: [data.beatmapId, data.expectedLabel, data.family, now],
    });

    return { ok: true };
  });
