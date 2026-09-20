import type { Worker } from "node:worker_threads";
import { createModuleWorker } from "../module-worker.js";
import { logWarn } from "../logger.js";
import type { ManiaBeatmap } from "./beatmap-parser.js";
import type { ClassifyChartInput } from "./chart-classifier.js";
import type { ChartClassificationData } from "./chart-classification-data.js";
import type { analyzeLnSkill, LnSkillResult } from "./ln-skill.js";
import type { analyzeLnSsr } from "./ln-ssr.js";
import type { resolveChartLnIdentity } from "./ln-identity.js";

export type AnalysisRequest =
  | { kind: "ln"; osuText: string; options: Parameters<typeof analyzeLnSkill>[1] }
  | { kind: "lnMap"; map: ManiaBeatmap; options: Parameters<typeof analyzeLnSkill>[1] }
  | { kind: "lnSsr"; osuText: string; options: Parameters<typeof analyzeLnSsr>[1] }
  | { kind: "classify"; map: ManiaBeatmap; osuText: string; input: ClassifyChartInput }
  | { kind: "lnIdentity"; map: ManiaBeatmap; options: Parameters<typeof resolveChartLnIdentity>[1] }
  | { kind: "sunnyFloorPin"; osuText: string };
export interface AnalysisResults {
  ln: LnSkillResult | null;
  lnMap: LnSkillResult | null;
  lnSsr: LnSkillResult | null;
  classify: ChartClassificationData;
  lnIdentity: ReturnType<typeof resolveChartLnIdentity>;
  sunnyFloorPin: boolean;
}
export type AnalysisResponse = { id: number; result: AnalysisResults[keyof AnalysisResults] } | { id: number; error: string };
export class AnalysisThreadUnavailableError extends Error {}

interface PendingAnalysis {
  id: number;
  request: AnalysisRequest;
  resolve: (result: AnalysisResults[keyof AnalysisResults]) => void;
  reject: (error: Error) => void;
}

// One lazy CPU isolate per process, independent of MinaCalc's mutable WASM.
// Bound admission and time only the active calculation. This thread owns no
// DB or writes, so a timeout can terminate it without abandoning a transaction.
export class AnalysisThread {
  private worker: Worker | null = null;
  private active: PendingAnalysis | null = null;
  private waiting: PendingAnalysis[] = [];
  private timer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private brokenUntil = 0;
  private closed = false;

  run<K extends AnalysisRequest["kind"]>(request: Extract<AnalysisRequest, { kind: K }>): Promise<AnalysisResults[K]> {
    if (this.closed || Date.now() < this.brokenUntil || this.waiting.length + (this.active ? 1 : 0) >= 32) {
      return Promise.reject(new AnalysisThreadUnavailableError("Chart analysis thread is busy or unavailable"));
    }
    return new Promise((resolve, reject) => {
      this.waiting.push({ id: this.nextId++, request, resolve: (result) => resolve(result as AnalysisResults[K]), reject });
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.fail(new Error("Chart analysis thread closed"));
  }

  private dispatch(): void {
    if (this.active || !this.waiting.length) return;
    this.active = this.waiting.shift()!;
    try {
      if (!this.worker) {
        const worker = createModuleWorker(new URL("./analysis-thread-worker.js", import.meta.url));
        this.worker = worker;
        worker.on("message", (response: AnalysisResponse) => {
          if (this.worker !== worker || this.active?.id !== response.id) return;
          const pending = this.active;
          this.active = null;
          if (this.timer) clearTimeout(this.timer);
          this.timer = null;
          worker.unref();
          if ("error" in response) pending.reject(new Error(response.error));
          else pending.resolve(response.result);
          this.dispatch();
        });
        worker.on("error", (error) => { if (this.worker === worker) void this.fail(error); });
        worker.on("exit", (code) => { if (this.worker === worker) void this.fail(new Error(`Chart analysis thread exited with code ${code}`)); });
      }
      this.worker.ref();
      this.timer = setTimeout(() => { void this.fail(new Error("Chart analysis timed out after 120000ms")); }, 120_000);
      this.worker.postMessage({ id: this.active.id, request: this.active.request });
    } catch (error) {
      void this.fail(error);
    }
  }

  private async fail(cause: unknown): Promise<void> {
    const error = new AnalysisThreadUnavailableError(cause instanceof Error ? cause.message : String(cause));
    this.brokenUntil = Date.now() + 60_000;
    if (!this.closed) logWarn("analysis_thread_unavailable", { error: error.message });
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const pending of [...(this.active ? [this.active] : []), ...this.waiting]) pending.reject(error);
    this.active = null;
    this.waiting = [];
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate().catch(() => undefined);
  }
}

const thread = new AnalysisThread();
export const analyzeLnSkillOnThread = (osuText: string, options: Parameters<typeof analyzeLnSkill>[1] = {}) =>
  thread.run({ kind: "ln", osuText, options });
export const analyzeLnMapOnThread = (map: ManiaBeatmap, options: Parameters<typeof analyzeLnSkill>[1] = {}) =>
  thread.run({ kind: "lnMap", map, options });
export const analyzeLnSsrOnThread = (osuText: string, options: Parameters<typeof analyzeLnSsr>[1]) =>
  thread.run({ kind: "lnSsr", osuText, options });
export const classifyChartOnThread = (map: ManiaBeatmap, osuText: string, input: ClassifyChartInput = {}) =>
  thread.run({ kind: "classify", map, osuText, input });
export const resolveLnIdentityOnThread = (map: ManiaBeatmap, options: Parameters<typeof resolveChartLnIdentity>[1]) =>
  thread.run({ kind: "lnIdentity", map, options });
export const isSunnyFloorPinnedOnThread = (osuText: string) => thread.run({ kind: "sunnyFloorPin", osuText });
