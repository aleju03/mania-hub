import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { AnalysisThread, AnalysisThreadUnavailableError, type AnalysisRequest } from "../src/dan/analysis-thread.js";
import { analyzeLnSkillFromText } from "../src/dan/ln-skill.js";
import { analyzeLnSsr } from "../src/dan/ln-ssr.js";
import { classifyChart } from "../src/dan/chart-classifier.js";
import { chartClassificationData } from "../src/dan/chart-classification-data.js";
import { leanClassification, recomputeDanFloorPinChunk, CHART_ANALYSIS_VERSION } from "../src/features/chart-analysis.js";
import { createDb, exec, migrate } from "../src/db.js";
import { storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";
import * as analysisModule from "../src/dan/analysis-thread.js";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import { invertManiaOsuText } from "../src/dan/invert-mod.js";
import { resolveChartLnIdentity } from "../src/dan/ln-identity.js";
import { msdChartErrorFallback } from "../src/dan/msd.js";
import * as workerModule from "../src/module-worker.js";

const threads: AnalysisThread[] = [];
function makeThread() { const thread = new AnalysisThread(); threads.push(thread); return thread; }
afterEach(async () => {
  await Promise.all(threads.splice(0).map(thread => thread.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function chart(keys = 4, holds = true): string {
  const pattern = [0, 1, 2, 3, 1, 3, 0, 2, 3, 0, 1, 3, 2, 0, 2, 1];
  const notes = Array.from({ length: 1500 }, (_, i) => {
    const x = Math.floor(((pattern[i % pattern.length] % keys + 0.5) * 512) / keys);
    const time = 1000 + i * 100;
    return holds && i % 4 !== 0 ? `${x},192,${time},128,0,${time + 160}:0:0:0:0:` : `${x},192,${time},1,0,0:0:0:0:`;
  });
  return ["osu file format v14", "[General]", "Mode: 3", "[Difficulty]", `CircleSize:${keys}`,
    "OverallDifficulty:8", "[TimingPoints]", "0,400,4,2,0,100,1,0", "[HitObjects]", ...notes].join("\n");
}

it("preserves LN, capped/extrapolated SSR, identity and LeoBlack results while the caller's timers run", async () => {
  const thread = makeThread();
  const requests: AnalysisRequest[] = [];
  const expected: unknown[] = [];
  for (const osuText of [chart(), chart(4, false), chart(7), invertManiaOsuText(chart())!]) {
    const map = parseManiaBeatmap(osuText);
    for (const rate of [0.75, 1, 1.5]) {
      const options = { rate, od: 8, scoreGoal: rate === 1 ? 0.9975 : 0.95 };
      requests.push({ kind: "ln", osuText, options });
      expected.push(analyzeLnSkillFromText(osuText, options));
      requests.push({ kind: "lnSsr", osuText, options });
      expected.push(analyzeLnSsr(osuText, options));
    }
    const input = { rate: 1.5, odFlag: "HR" as const, marathonMsdValues: { Overall: 20 }, adjustVibro: true };
    requests.push({ kind: "classify", map, osuText, input });
    const classified = classifyChart(map, osuText, input);
    const data = chartClassificationData(classified);
    expect(leanClassification(data)).toEqual(leanClassification(classified));
    expected.push(data);
    const options = { rate: 1.5, overall: 20 };
    requests.push({ kind: "lnIdentity", map, options });
    expected.push(resolveChartLnIdentity(map, options));
  }
  // Warm the isolate so imports alone cannot account for the timer progress.
  await thread.run(requests[0]);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    expect(await Promise.all(requests.map(request => thread.run(request)))).toEqual(expected);
    expect(ticks).toBeGreaterThan(0);
  } finally { clearInterval(timer); }
}, 30_000);

function fakeWorker() {
  const worker = Object.assign(new EventEmitter(), {
    ref: vi.fn(), unref: vi.fn(), postMessage: vi.fn(), terminate: vi.fn(async () => 0),
  });
  vi.spyOn(workerModule, "createModuleWorker").mockReturnValue(worker as unknown as Worker);
  return worker;
}
const request = { kind: "ln", osuText: "test", options: {} } as const;

it("bounds admission, rejects all work on a crash and recovers after cooldown", async () => {
  vi.useFakeTimers();
  const worker = fakeWorker();
  const thread = makeThread();
  const queued = Promise.allSettled(Array.from({ length: 32 }, () => thread.run(request)));
  await expect(thread.run(request)).rejects.toBeInstanceOf(AnalysisThreadUnavailableError);
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  worker.emit("error", new Error("crashed"));
  expect((await queued).every(result => result.status === "rejected" && result.reason instanceof AnalysisThreadUnavailableError)).toBe(true);
  expect(worker.terminate).toHaveBeenCalledOnce();
  await expect(thread.run(request)).rejects.toThrow("unavailable");
  await vi.advanceTimersByTimeAsync(60_001);
  const recovered = thread.run(request);
  worker.emit("message", { id: worker.postMessage.mock.lastCall![0].id, result: null });
  await expect(recovered).resolves.toBeNull();
});

it("starts each watchdog at dispatch and does not retry a timed-out calculation inline", async () => {
  vi.useFakeTimers();
  const worker = fakeWorker();
  const thread = makeThread();
  const first = thread.run(request);
  const second = thread.run(request);
  const failed = expect(second).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(119_000);
  worker.emit("message", { id: 1, result: null });
  await first;
  await vi.advanceTimersByTimeAsync(119_000);
  expect(worker.terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1001);
  await failed;
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it("keeps chart errors local and infrastructure errors retryable", async () => {
  const worker = fakeWorker();
  const thread = makeThread();
  const first = expect(thread.run(request)).rejects.toThrow("invalid chart");
  const second = thread.run(request);
  worker.emit("message", { id: 1, error: "invalid chart" });
  worker.emit("message", { id: 2, result: null });
  await first;
  await expect(second).resolves.toBeNull();
  expect(msdChartErrorFallback(new Error("invalid chart"))).toBeNull();
  expect(() => msdChartErrorFallback(new AnalysisThreadUnavailableError("crashed"))).toThrow("crashed");
});

it("leaves a migration retryable when the analysis worker is unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mania-analysis-retry-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  try {
    await migrate(db);
    await storeCachedBeatmapFile(db, 55, chart(4, false), { source: "test" });
    await exec(db, `insert into beatmap_chart_analysis
      (beatmap_id, analysis_version, status, key_count, primary_family, raw_dan, updated_at)
      values (55, ?, 'ready', 4, 'dan', 0.6, '')`, [CHART_ANALYSIS_VERSION]);
    const unavailable = new AnalysisThreadUnavailableError("worker crashed");
    vi.spyOn(analysisModule, "isSunnyFloorPinnedOnThread").mockRejectedValue(unavailable);
    await expect(recomputeDanFloorPinChunk(db, 0, 1)).rejects.toBe(unavailable);
    expect((await exec(db, "select status, raw_dan from beatmap_chart_analysis where beatmap_id = 55")).rows[0])
      .toMatchObject({ status: "ready", raw_dan: 0.6 });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
