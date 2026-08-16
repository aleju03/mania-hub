import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import {
  TOP_SCORES_BACKFILL_DONE_META_KEY,
  TOP_SCORES_BACKFILL_JOB,
  TOP_SCORES_BACKFILL_PROGRESS_META_KEY,
} from "./top-scores-backfill.js";
import { SKILL_BASELINE_CURVES_META_KEY, SKILL_BASELINE_JOB } from "./skill-baseline.js";

// ── Sweeps status registry ───────────────────────────────────────────────────
// Read-only introspection over the long-running one-time sweeps and recurring
// background folds that coordinate themselves through live_meta done keys and
// self-chaining job rows. Each entry knows which live_meta keys and job types
// its sweep uses and folds them into a small status report for the admin page.
//
// Chart-analysis and map-search meta keys are module-private in their owning
// files, so this registry carries them as string literals with a pointer back
// to the source; the job-type literals sit next to them for the same reason.
// The skill-vector v5 backfill entry codes against the agreed key contract
// (the module is built separately) and deliberately imports nothing from it.
//
// Everything here is defensive: a missing row, malformed JSON, or a failing
// count query degrades the individual entry, never the endpoint.

export type SweepKind = "one-time" | "recurring";
export type SweepStatusValue = "done" | "running" | "pending" | "unknown";

export interface SweepProgress {
  processed?: number;
  total?: number;
  [extra: string]: number | undefined;
}

export interface SweepReport {
  id: string;
  label: string;
  description: string;
  kind: SweepKind;
  status: SweepStatusValue;
  progress?: SweepProgress;
  updatedAt?: string | null;
  detail?: string | null;
}

interface SweepReading {
  status: SweepStatusValue;
  progress?: SweepProgress;
  updatedAt?: string | null;
  detail?: string | null;
}

interface SweepDefinition {
  id: string;
  label: string;
  description: string;
  kind: SweepKind;
  read: (db: Db) => Promise<SweepReading>;
}

// Job rows in any of these states mean the sweep's chain is still alive:
// queued/running are self-evident, deferred_pressure is parked-but-coming-back,
// and failed retries via the per-type backoff (the boot watchdogs use the same
// set when deciding whether to reseed).
const IN_FLIGHT_JOB_STATUSES = "('queued', 'running', 'failed', 'deferred_pressure')";

// Fallback "progress moved recently" window for chunked sweeps whose chain
// interval we know (top-scores chains every 15 minutes; 2x that) or can only
// assume (the skill-vector contract has no interval, same window applies).
const DEFAULT_RECENT_PROGRESS_MS = 30 * 60_000;

interface MetaReading {
  present: boolean;
  updatedAt: string | null;
  value: Record<string, unknown> | null;
  malformed: boolean;
}

async function readMeta(db: Db, key: string): Promise<MetaReading> {
  const row = (await exec(db, "select value_json, updated_at from live_meta where key = ? limit 1", [key])).rows[0];
  if (!row) return { present: false, updatedAt: null, value: null, malformed: false };
  const raw = String(row.value_json ?? "");
  const parsed = parseJson<unknown>(raw, undefined);
  const malformed = parsed === undefined && raw.trim() !== "";
  const value = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  return { present: true, updatedAt: row.updated_at == null ? null : String(row.updated_at), value, malformed };
}

async function readLatestMetaLike(db: Db, pattern: string): Promise<MetaReading & { key: string | null }> {
  const row = (await exec(
    db,
    "select key, value_json, updated_at from live_meta where key like ? order by updated_at desc limit 1",
    [pattern],
  )).rows[0];
  if (!row) return { present: false, updatedAt: null, value: null, malformed: false, key: null };
  const raw = String(row.value_json ?? "");
  const parsed = parseJson<unknown>(raw, undefined);
  const malformed = parsed === undefined && raw.trim() !== "";
  const value = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  return { present: true, updatedAt: row.updated_at == null ? null : String(row.updated_at), value, malformed, key: String(row.key) };
}

interface JobReading {
  pending: number;
  updatedAt: string | null;
  payload: Record<string, unknown> | null;
}

async function readInFlightJobs(db: Db, match: { type?: string; typeLike?: string }): Promise<JobReading> {
  const clause = match.type ? "type = ?" : "type like ?";
  const arg = match.type ?? match.typeLike ?? "";
  const row = (await exec(
    db,
    `select count(*) as pending, max(updated_at) as latest from jobs where ${clause} and status in ${IN_FLIGHT_JOB_STATUSES}`,
    [arg],
  )).rows[0];
  const pending = Math.max(0, Number(row?.pending ?? 0) || 0);
  if (pending === 0) return { pending: 0, updatedAt: null, payload: null };
  const latest = (await exec(
    db,
    `select payload_json from jobs where ${clause} and status in ${IN_FLIGHT_JOB_STATUSES} order by updated_at desc limit 1`,
    [arg],
  )).rows[0];
  const payload = parseJson<Record<string, unknown> | null>(String(latest?.payload_json ?? ""), null);
  return {
    pending,
    updatedAt: row?.latest == null ? null : String(row.latest),
    payload: payload && typeof payload === "object" ? payload : null,
  };
}

function numberField(source: Record<string, unknown> | null, field: string): number | undefined {
  const value = Number(source?.[field]);
  return Number.isFinite(value) ? value : undefined;
}

function collectProgressFields(source: Record<string, unknown> | null, fields: string[]): SweepProgress {
  const progress: SweepProgress = {};
  for (const field of fields) {
    const value = numberField(source, field);
    if (value !== undefined) progress[field] = value;
  }
  return progress;
}

function isRecent(updatedAt: string | null, windowMs: number): boolean {
  if (!updatedAt) return false;
  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) && Date.now() - parsed <= windowMs;
}

/**
 * Shared reader for the done-key/self-chaining playbook: done key wins, then a
 * live chain (in-flight job of the sweep's type, or a progress blob that moved
 * within the recency window) means running, then a progress blob without a
 * chain means pending-with-progress, then never-started pending. Malformed
 * progress JSON is "unknown": the sweep may well be alive, but nothing about
 * its counters can be trusted.
 */
async function readChainSweep(db: Db, options: {
  doneKey: string;
  jobType: string;
  jobTypeLike?: string;
  progressKey?: string;
  progressFields?: string[];
  recentProgressMs?: number;
  total?: (db: Db, progress: SweepProgress) => Promise<number | undefined>;
}): Promise<SweepReading> {
  const done = await readMeta(db, options.doneKey);
  if (done.present) {
    const progress = collectProgressFields(done.value, options.progressFields ?? []);
    return {
      status: "done",
      updatedAt: done.updatedAt,
      progress: Object.keys(progress).length > 0 ? progress : undefined,
      detail: typeof done.value?.finishedAt === "string" ? `finished ${String(done.value.finishedAt)}` : null,
    };
  }

  const progressMeta = options.progressKey ? await readMeta(db, options.progressKey) : null;
  if (progressMeta?.present && progressMeta.malformed) {
    return { status: "unknown", updatedAt: progressMeta.updatedAt, detail: "progress blob is not valid JSON" };
  }

  const progress = collectProgressFields(progressMeta?.value ?? null, options.progressFields ?? []);
  if (options.total && progressMeta?.present) {
    // A total is decoration: if the count query fails the entry keeps its raw
    // counters instead of failing the whole report.
    try {
      const total = await options.total(db, progress);
      if (total !== undefined && Number.isFinite(total) && total >= 0) progress.total = total;
    } catch {
      // progress-only
    }
  }

  const jobs = await readInFlightJobs(db, options.jobTypeLike ? { typeLike: options.jobTypeLike } : { type: options.jobType });
  if (jobs.pending > 0) {
    const cursor = numberField(jobs.payload, "cursor");
    if (cursor !== undefined && progress.cursor === undefined) progress.cursor = cursor;
    return {
      status: "running",
      updatedAt: progressMeta?.updatedAt ?? jobs.updatedAt,
      progress: Object.keys(progress).length > 0 ? progress : undefined,
      detail: `${jobs.pending} chain job${jobs.pending === 1 ? "" : "s"} in flight`,
    };
  }

  if (progressMeta?.present) {
    const recentMs = options.recentProgressMs ?? DEFAULT_RECENT_PROGRESS_MS;
    if (isRecent(progressMeta.updatedAt, recentMs)) {
      return {
        status: "running",
        updatedAt: progressMeta.updatedAt,
        progress: Object.keys(progress).length > 0 ? progress : undefined,
        detail: "progress moved recently, no chain job visible",
      };
    }
    return {
      status: "pending",
      updatedAt: progressMeta.updatedAt,
      progress: Object.keys(progress).length > 0 ? progress : undefined,
      detail: "chain idle; the boot watchdog reseeds it on the next start",
    };
  }

  return { status: "pending", updatedAt: null, detail: "not started" };
}

/** Remaining tracked roster members without a stored top-plays projection (mirrors selectBackfillUserIds). */
async function countTopScoresBackfillRemaining(db: Db): Promise<number | undefined> {
  const row = (await exec(
    db,
    `select count(distinct r.user_id) as remaining
     from country_rosters r
     where r.is_tracked = 1
       and not exists (select 1 from user_top_scores uts where uts.user_id = r.user_id)
       and not exists (select 1 from users u where u.user_id = r.user_id and u.is_active = 0)`,
  )).rows[0];
  const remaining = Number(row?.remaining ?? Number.NaN);
  return Number.isFinite(remaining) && remaining >= 0 ? remaining : undefined;
}

// One-time chart-analysis recompute sweeps: same playbook, done key plus a
// cursor-chained job, no progress blob (the chunk cursor in the pending job's
// payload is the only progress signal). Keys/types live in
// src/features/chart-analysis.ts next to each sweep's runner.
function chartAnalysisSweep(options: { id: string; label: string; description: string; doneKey: string; jobType: string }): SweepDefinition {
  return {
    id: options.id,
    label: options.label,
    description: options.description,
    kind: "one-time",
    read: (db) => readChainSweep(db, { doneKey: options.doneKey, jobType: options.jobType }),
  };
}

const SWEEP_DEFINITIONS: SweepDefinition[] = [
  {
    id: "top-scores-backfill",
    label: "Top-scores backfill",
    description: "Fetches the best-scores window once for every tracked roster member with no stored top-plays projection, so the skill baseline sees the whole roster.",
    kind: "one-time",
    read: (db) => readChainSweep(db, {
      doneKey: TOP_SCORES_BACKFILL_DONE_META_KEY,
      jobType: TOP_SCORES_BACKFILL_JOB,
      progressKey: TOP_SCORES_BACKFILL_PROGRESS_META_KEY,
      progressFields: ["cursor", "processed", "fetched", "missing", "failed"],
      // Chunks chain every 15 minutes; 2x that before "running" stops being credible.
      recentProgressMs: 30 * 60_000,
      total: async (dbInner, progress) => {
        const remaining = await countTopScoresBackfillRemaining(dbInner);
        if (remaining === undefined) return undefined;
        return (progress.processed ?? 0) + remaining;
      },
    }),
  },
  {
    id: "skill-vector-backfill-v5",
    label: "Skill-vector v5 backfill",
    description: "Recomputes beatmap skill vectors at analysis v5 across the analyzed corpus. Coded against the agreed live_meta key contract.",
    kind: "one-time",
    read: (db) => readChainSweep(db, {
      doneKey: "skill_vector_backfill_done:v5",
      jobType: "skill_vector_backfill",
      // The job type is not part of the contract; match anything that names it.
      jobTypeLike: "%skill_vector%",
      progressKey: "skill_vector_backfill_progress:v5",
      progressFields: ["cursor", "processed", "computed", "unavailable", "failed"],
    }),
  },
  {
    id: "dt-rate-analysis",
    label: "DT-rate MSD sweep",
    description: "Computes 1.5x-rate MSD and a lean dan verdict for DT-farmed 4K/7K charts so the farm helper can screen DT recommendations.",
    kind: "one-time",
    read: (db) => readChainSweep(db, {
      // src/features/chart-analysis.ts DT_RATE_ANALYSIS_META_KEY / DT_RATE_ANALYSIS_JOB
      doneKey: "dt_rate_analysis_done:v2",
      jobType: "recompute_dt_rate_analysis_sweep",
    }),
  },
  chartAnalysisSweep({
    id: "vibro-recompute",
    label: "Vibro recompute sweep",
    description: "Re-derives the vibro flag for stored chart analyses from the cached .osu corpus.",
    doneKey: "vibro_recompute_done:v4",
    jobType: "recompute_vibro_sweep",
  }),
  chartAnalysisSweep({
    id: "note-bpm-recompute",
    label: "Note-BPM recompute sweep",
    description: "Re-derives note-density BPM for stored chart analyses.",
    doneKey: "note_bpm_recompute_done:v3",
    jobType: "recompute_note_bpm_sweep",
  }),
  chartAnalysisSweep({
    id: "dan-floor-pin-recompute",
    label: "Dan floor-pin recompute sweep",
    description: "Re-pins dan floor labels on stored chart analyses.",
    doneKey: "dan_floor_pin_recompute_done:v1",
    jobType: "recompute_dan_floor_pin_sweep",
  }),
  chartAnalysisSweep({
    id: "ln-subtype-recompute",
    label: "LN subtype recompute sweep",
    description: "Re-derives LN subtype tags (general/release/inverse/tech) on stored chart analyses.",
    doneKey: "ln_subtype_recompute_done:v1",
    jobType: "recompute_ln_subtype_sweep",
  }),
  chartAnalysisSweep({
    id: "companella-recompute",
    label: "Companella recompute sweep",
    description: "Re-analyzes 4K LN-hybrid charts under 9 stars whose RC verdict predates the Companella wiring.",
    doneKey: "companella_recompute_done:v1",
    jobType: "recompute_companella_sweep",
  }),
  chartAnalysisSweep({
    id: "chordjack-tag-recompute",
    label: "Chordjack tag recompute sweep",
    description: "Re-derives chordjack pattern tags on stored chart analyses.",
    doneKey: "chordjack_tag_recompute_done:v1",
    jobType: "recompute_chordjack_tag_sweep",
  }),
  chartAnalysisSweep({
    id: "ln-msd-backfill",
    label: "LN-tail MSD backfill sweep",
    description: "Backfills tail-aware LN-adjusted MSD for every ready hold-bearing chart from the cached .osu corpus.",
    doneKey: "ln_msd_backfill_done:v1",
    jobType: "recompute_ln_msd_sweep",
  }),
  chartAnalysisSweep({
    id: "ln-source-recompute",
    label: "LN estimate recompute sweep",
    description: "Re-derives the LN estimate source fields on stored chart analyses.",
    doneKey: "ln_estimate_recompute_done:v1",
    jobType: "recompute_ln_estimate_sweep",
  }),
  chartAnalysisSweep({
    id: "sunny-repin-recompute",
    label: "Sunny re-pin recompute sweep",
    description: "Re-analyzes every ready chart after the leoblack re-pin aligned Sunny SR with the authoritative C# port.",
    doneKey: "sunny_repin_recompute_done:v1",
    jobType: "recompute_sunny_repin_sweep",
  }),
  chartAnalysisSweep({
    id: "sunny-repin-dt-recompute",
    label: "Sunny re-pin DT verdict sweep",
    description: "Re-derives the 1.5x dan verdict from the stored DT MSD on every row carrying one, since the main re-pin sweep preserves the DT columns.",
    doneKey: "sunny_repin_dt_recompute_done:v1",
    jobType: "recompute_sunny_repin_dt_sweep",
  }),
  chartAnalysisSweep({
    id: "msd-poison-recovery",
    label: "MSD poisoning recovery sweep",
    description: "Re-analyzes rows whose stored MSD carries the all-skillsets-equal floor left by the 2026-08-14 corrupted wasm instance.",
    doneKey: "msd_poison_recovery_done:v1",
    jobType: "recompute_msd_poison_sweep",
  }),
  chartAnalysisSweep({
    id: "inverse-cluster-bpm",
    label: "Inverse cluster BPM sweep",
    description: "Re-analyzes rows whose mixed Density pattern cluster stored a BPM inflated by inverse windows' zero-tempo sentinel.",
    doneKey: "inverse_cluster_bpm_recovery_done:v1",
    jobType: "recompute_inverse_cluster_bpm_sweep",
  }),
  {
    id: "skill-baseline",
    label: "Skill baseline fold",
    description: "Weekly fold of approximate per-user rating vectors into population quantile curves; powers the skill-percentile readouts.",
    kind: "recurring",
    read: async (db) => {
      const jobs = await readInFlightJobs(db, { type: SKILL_BASELINE_JOB });
      const curves = await readMeta(db, SKILL_BASELINE_CURVES_META_KEY);
      if (curves.present && curves.malformed) {
        return { status: "unknown", updatedAt: curves.updatedAt, detail: "curves blob is not valid JSON" };
      }
      // User counts per keymode from the curves blob, e.g. { "4": 3120, "7": 940 }.
      const users = curves.value?.users && typeof curves.value.users === "object" && !Array.isArray(curves.value.users)
        ? curves.value.users as Record<string, unknown>
        : null;
      const progress: SweepProgress = {};
      let userParts: string[] = [];
      if (users) {
        userParts = Object.entries(users)
          .filter(([, count]) => Number.isFinite(Number(count)))
          .map(([keymode, count]) => `${keymode}K ${Number(count)}`);
        const totalUsers = Object.values(users).reduce<number>((sum, count) => sum + (Number(count) || 0), 0);
        if (totalUsers > 0) progress.users = totalUsers;
      }
      const computedAt = typeof curves.value?.computedAt === "string" ? curves.value.computedAt : curves.updatedAt;
      if (jobs.pending > 0) {
        return {
          status: "running",
          updatedAt: jobs.updatedAt ?? computedAt,
          progress: Object.keys(progress).length > 0 ? progress : undefined,
          detail: computedAt
            ? `refresh in flight (${jobs.pending} chain job${jobs.pending === 1 ? "" : "s"}); last fold ${computedAt}`
            : `first fold in flight (${jobs.pending} chain job${jobs.pending === 1 ? "" : "s"})`,
        };
      }
      if (curves.present) {
        return {
          status: "done",
          updatedAt: computedAt,
          progress: Object.keys(progress).length > 0 ? progress : undefined,
          detail: userParts.length > 0 ? `users in curves: ${userParts.join(", ")}` : null,
        };
      }
      return { status: "pending", updatedAt: null, detail: "no curves computed yet" };
    },
  },
  {
    id: "map-search-index",
    label: "Map search index build",
    description: "Denormalized search projection over every chart-analyzed map; rebuilt from row zero whenever the build revision or analysis version bumps.",
    kind: "recurring",
    read: async (db) => {
      // BUILD_META_KEY / BUILD_CURSOR_KEY in src/features/map-search.ts carry
      // the analysis version and build revision in the key, so match by prefix
      // and report whichever revision is newest.
      const jobs = await readInFlightJobs(db, { type: "build_map_search_index" });
      const built = await readLatestMetaLike(db, "map_search_index_built:%");
      const cursorMeta = await readLatestMetaLike(db, "map_search_index_build_cursor:%");
      if (jobs.pending > 0) {
        const progress: SweepProgress = {};
        const cursor = numberField(jobs.payload, "cursor") ?? numberField(cursorMeta.value, "cursor");
        if (cursor !== undefined) progress.cursor = cursor;
        return {
          status: "running",
          updatedAt: jobs.updatedAt ?? cursorMeta.updatedAt,
          progress: Object.keys(progress).length > 0 ? progress : undefined,
          detail: cursorMeta.key ?? "build in flight",
        };
      }
      if (built.present) {
        return { status: "done", updatedAt: built.updatedAt, detail: built.key };
      }
      if (cursorMeta.present) {
        if (cursorMeta.malformed) {
          return { status: "unknown", updatedAt: cursorMeta.updatedAt, detail: "build cursor blob is not valid JSON" };
        }
        const progress = collectProgressFields(cursorMeta.value, ["cursor"]);
        return {
          status: "pending",
          updatedAt: cursorMeta.updatedAt,
          progress: Object.keys(progress).length > 0 ? progress : undefined,
          detail: "build idle mid-way; the boot watchdog resumes it",
        };
      }
      return { status: "pending", updatedAt: null, detail: "not built" };
    },
  },
  {
    id: "skin-slug-backfill",
    label: "Skin slug backfill",
    description: "One-shot boot backfill that assigns slugs to skins published before slugs existed.",
    kind: "one-time",
    read: async (db) => {
      // SLUG_BACKFILL_META_KEY in src/features/skins.ts; runs inline at boot,
      // no job chain, so absent simply means the next boot will run it.
      const done = await readMeta(db, "skin_slug_backfill:v1");
      if (done.present) {
        const progress = collectProgressFields(done.value, ["backfilled"]);
        return {
          status: "done",
          updatedAt: done.updatedAt,
          progress: Object.keys(progress).length > 0 ? progress : undefined,
        };
      }
      return { status: "pending", updatedAt: null, detail: "runs inline at the next boot" };
    },
  },
];

export async function getSweepReports(db: Db): Promise<SweepReport[]> {
  const reports: SweepReport[] = [];
  for (const definition of SWEEP_DEFINITIONS) {
    let reading: SweepReading;
    try {
      reading = await definition.read(db);
    } catch (error) {
      // One broken reader must not take the whole admin panel down.
      reading = { status: "unknown", detail: error instanceof Error ? error.message : String(error) };
    }
    reports.push({
      id: definition.id,
      label: definition.label,
      description: definition.description,
      kind: definition.kind,
      status: reading.status,
      progress: reading.progress,
      updatedAt: reading.updatedAt ?? null,
      detail: reading.detail ?? null,
    });
  }
  return reports;
}
