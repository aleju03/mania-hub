// The app-level owner of a local replay video export.
//
// One manager per browsing context, created lazily and only in a browser. It
// outlives the replay route: the route submits a job and subscribes to it,
// but the renderers, encoders, abort controller, file writer, retained asset
// bytes, and the finished Blob all belong here. That is what makes an export
// survive client-side navigation, and it is why a progress percentage in a
// store would not have been enough.

import { ReplayExportError, asReplayExportError, isReplayExportError } from "./errors";
import type { ReplayExportCodecPlan } from "./capabilities";
import { REPLAY_EXPORT_ADMISSION } from "./limits";
import { resolveReplayExportResources } from "./snapshot";
import type { ReplayExportTimeline } from "./timeline";
import {
  ACTIVE_EXPORT_PHASES,
  type LocalExportResources,
  type ReplayExportJobView,
  type ReplayExportStartRequest,
  type ReplayExportSubscriber,
  type ReplayExportWarningCode,
} from "./types";

/** Roughly how often the UI is told about progress. Not once per frame. */
const NOTIFY_INTERVAL_MS = 120;
const EXPORT_LOCK_NAME = "mania-hub-replay-export";

type ActiveJob = {
  view: ReplayExportJobView;
  controller: AbortController;
  /** Set once the preparing phase has taken ownership of the input bytes. */
  resources: LocalExportResources | null;
  startedAt: number;
  releaseLock: (() => void) | null;
  wakeLock: WakeLockSentinel | null;
  blob: Blob | null;
};

function phaseWeightedProgress(view: ReplayExportJobView): number {
  switch (view.phase) {
    case "preparing":
      return 0.02;
    case "rendering": {
      const share = view.frameCount > 0 ? view.framesCompleted / view.frameCount : 0;
      return 0.02 + 0.91 * Math.min(1, share);
    }
    case "finalizing":
      return 0.95;
    case "cancelling":
      return view.progress;
    case "ready":
    case "saved-to-file":
    case "download-started":
      return 1;
    default:
      return view.progress;
  }
}

export class ReplayExportManager {
  private job: ActiveJob | null = null;
  private subscribers = new Set<ReplayExportSubscriber>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private notifyPending = false;
  private unloadGuardAttached = false;
  private visibilityWatchAttached = false;
  private counter = 0;

  /** True while a job is running or a finished Blob has not been dealt with. */
  get isBusy(): boolean {
    if (!this.job) return false;
    return ACTIVE_EXPORT_PHASES.has(this.job.view.phase) || this.job.blob !== null;
  }

  get view(): ReplayExportJobView | null {
    return this.job?.view ?? null;
  }

  subscribe(subscriber: ReplayExportSubscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.view);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * Reserves the single job slot synchronously, so two clicks in the same
   * tick cannot both get through, and starts the run.
   */
  start(request: ReplayExportStartRequest): ReplayExportJobView {
    if (this.isBusy) {
      // A ready-but-undownloaded result counts as busy: starting over would
      // silently drop a file the user has not saved yet.
      throw new ReplayExportError("export_busy");
    }
    if (this.job) this.disposeJob();

    const controller = new AbortController();
    const id = `export-${Date.now().toString(36)}-${(this.counter++).toString(36)}`;
    const destination = request.target.kind;
    const view: ReplayExportJobView = {
      id,
      phase: "preparing",
      progress: 0,
      framesCompleted: 0,
      frameCount: 0,
      audioSecondsProcessed: 0,
      outputDurationSeconds: 0,
      bytesWritten: 0,
      estimatedBytes: 0,
      elapsedMs: 0,
      destination,
      container: request.spec.output.container,
      hasAudio: request.spec.output.audioCodec !== null,
      warnings: [],
      errorCode: null,
      result: null,
      title: request.title,
      filename: request.spec.filename,
    };

    this.job = {
      view,
      controller,
      resources: null,
      startedAt: performance.now(),
      releaseLock: null,
      wakeLock: null,
      blob: null,
    };

    this.attachUnloadGuard();
    this.attachVisibilityWatch();
    void this.acquireExclusivity(id);
    void this.acquireWakeLock();
    void this.run(request, controller.signal, id);
    this.notify(true);
    return view;
  }

  cancel(): void {
    const job = this.job;
    if (!job) return;
    if (!ACTIVE_EXPORT_PHASES.has(job.view.phase)) return;
    job.controller.abort();
    this.patch(job.view.id, { phase: "cancelling" });
  }

  /** Called once the user has actually been handed the Blob. */
  markDownloadStarted(): void {
    const job = this.job;
    if (!job || job.view.phase !== "ready") return;
    this.patch(job.view.id, { phase: "download-started" });
  }

  /** Drops a finished result the user does not want, freeing its memory. */
  dismiss(): void {
    const job = this.job;
    if (!job) return;
    if (ACTIVE_EXPORT_PHASES.has(job.view.phase)) return;
    this.disposeJob();
    this.notify(true);
  }

  private async run(
    request: ReplayExportStartRequest,
    signal: AbortSignal,
    id: string,
  ): Promise<void> {
    try {
      const resources = await resolveReplayExportResources(request.capture, request.spec, signal)
        .then((resolved) => {
          const current = this.job;
          if (current && current.view.id === id) current.resources = resolved;
          else resolved.release();
          return resolved;
        });
      if (signal.aborted) {
        resources.release();
        this.finishCancelled(id);
        return;
      }

      // Loaded here rather than at module scope: the encoder and its WASM
      // must not reach the bundle that mounts the progress panel on every
      // page of the site.
      const { runLocalExport } = await import("./runners/local");
      const result = await runLocalExport({
        spec: request.spec,
        resources,
        target: request.target,
        signal,
        callbacks: {
          onPhase: (phase) => this.patch(id, { phase }),
          onProgress: (progress) => this.patch(id, progress),
          onWarning: (warning) => this.addWarning(id, warning),
          onPlan: (plan: ReplayExportCodecPlan, timeline: ReplayExportTimeline, estimatedBytes) => {
            this.patch(id, {
              frameCount: timeline.frameCount,
              outputDurationSeconds: timeline.videoDurationSeconds,
              estimatedBytes,
              container: plan.container,
              hasAudio: plan.audioCodec !== null,
            });
          },
        },
      });

      const job = this.job;
      if (!job || job.view.id !== id) return;
      // A job that was cancelled during finalization must not publish a
      // successful result that arrived afterwards.
      if (signal.aborted) {
        this.finishCancelled(id);
        return;
      }

      job.blob = result.blob;
      const downloadUrl = result.blob ? URL.createObjectURL(result.blob) : null;
      this.patch(id, {
        phase: result.kind === "file" ? "saved-to-file" : "ready",
        result: {
          kind: result.kind,
          filename: result.filename,
          byteLength: result.byteLength,
          downloadUrl,
          mimeType: result.mimeType,
        },
        bytesWritten: result.byteLength,
      });
      this.releaseInputs();
      if (result.kind === "file") this.releaseExclusivity();
    } catch (error) {
      const job = this.job;
      if (!job || job.view.id !== id) return;
      if (signal.aborted) {
        this.finishCancelled(id);
        return;
      }
      const exportError = asReplayExportError(error, "encoder_failed");
      this.patch(id, { phase: "failed", errorCode: exportError.code });
      this.releaseInputs();
      this.releaseExclusivity();
      if (!isReplayExportError(error)) {
        // Unknown failures still surface under a stable code, but the
        // original is worth having in the console during development.
        if (import.meta.env.DEV) console.error("Replay export failed", error);
      }
    } finally {
      await this.releaseWakeLock();
      this.detachVisibilityWatch();
      this.updateUnloadGuard();
    }
  }

  private finishCancelled(id: string): void {
    // A job aborted because another tab holds the lock already reported
    // `export_busy`; do not relabel that as an ordinary cancellation.
    const job = this.job;
    if (job && job.view.id === id && !ACTIVE_EXPORT_PHASES.has(job.view.phase)) return;
    this.patch(id, { phase: "cancelled", errorCode: null });
    this.releaseInputs();
    this.releaseExclusivity();
  }

  /**
   * Cross-tab exclusion where Web Locks exist. `ifAvailable` means a second
   * tab is refused outright rather than silently queued behind the first.
   */
  private async acquireExclusivity(id: string): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.locks) return;
    try {
      await navigator.locks.request(EXPORT_LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (!lock) {
          const job = this.job;
          if (job && job.view.id === id && ACTIVE_EXPORT_PHASES.has(job.view.phase)) {
            job.controller.abort();
            this.patch(id, { phase: "failed", errorCode: "export_busy" });
          }
          return;
        }
        return new Promise<void>((resolve) => {
          const job = this.job;
          if (!job || job.view.id !== id) {
            resolve();
            return;
          }
          job.releaseLock = resolve;
        });
      });
    } catch {
      // No lock is a degraded guarantee, not a reason to refuse the export.
    }
  }

  private releaseExclusivity(): void {
    const job = this.job;
    if (!job?.releaseLock) return;
    job.releaseLock();
    job.releaseLock = null;
  }

  private readonly onVisibilityChange = () => {
    const job = this.job;
    if (!job || !ACTIVE_EXPORT_PHASES.has(job.view.phase)) return;
    if (document.visibilityState === "visible") {
      void this.acquireWakeLock();
      return;
    }
    // Best effort from here: the browser may freeze or discard the page, and
    // the panel should not imply otherwise.
    this.addWarning(job.view.id, "hidden-while-exporting");
  };

  private attachVisibilityWatch(): void {
    if (this.visibilityWatchAttached || typeof document === "undefined") return;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.visibilityWatchAttached = true;
  }

  private detachVisibilityWatch(): void {
    if (!this.visibilityWatchAttached || typeof document === "undefined") return;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.visibilityWatchAttached = false;
  }

  private async acquireWakeLock(): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.wakeLock) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    try {
      const sentinel = await navigator.wakeLock.request("screen");
      const job = this.job;
      if (!job || !ACTIVE_EXPORT_PHASES.has(job.view.phase)) {
        await sentinel.release().catch(() => {});
        return;
      }
      job.wakeLock = sentinel;
    } catch {
      // Convenience against screen sleep only; never required.
    }
  }

  private async releaseWakeLock(): Promise<void> {
    const job = this.job;
    if (!job?.wakeLock) return;
    const sentinel = job.wakeLock;
    job.wakeLock = null;
    await sentinel.release().catch(() => {});
  }

  /** Drops replay inputs and decoded assets; the output stays. */
  private releaseInputs(): void {
    this.job?.resources?.release();
  }

  private disposeJob(): void {
    const job = this.job;
    if (!job) return;
    job.controller.abort();
    job.releaseLock?.();
    job.releaseLock = null;
    void job.wakeLock?.release().catch(() => {});
    job.wakeLock = null;
    job.resources?.release();
    this.detachVisibilityWatch();
    if (job.view.result?.downloadUrl) URL.revokeObjectURL(job.view.result.downloadUrl);
    job.blob = null;
    this.job = null;
    this.updateUnloadGuard();
  }

  private addWarning(id: string, warning: ReplayExportWarningCode): void {
    const job = this.job;
    if (!job || job.view.id !== id || job.view.warnings.includes(warning)) return;
    this.patch(id, { warnings: [...job.view.warnings, warning] });
  }

  private patch(id: string, changes: Partial<ReplayExportJobView>): void {
    const job = this.job;
    if (!job || job.view.id !== id) return;
    const next: ReplayExportJobView = {
      ...job.view,
      ...changes,
      elapsedMs: performance.now() - job.startedAt,
    };
    next.progress = phaseWeightedProgress(next);
    job.view = next;
    const terminal = !ACTIVE_EXPORT_PHASES.has(next.phase);
    this.updateUnloadGuard();
    this.notify(terminal || changes.phase !== undefined);
  }

  /**
   * Terminal transitions and phase changes publish immediately; ordinary
   * frame progress is coalesced, so a 60 FPS render does not schedule 60
   * React updates a second.
   */
  private notify(immediate: boolean): void {
    if (immediate) {
      if (this.notifyTimer) {
        clearTimeout(this.notifyTimer);
        this.notifyTimer = null;
      }
      this.notifyPending = false;
      this.flush();
      return;
    }
    if (this.notifyPending) return;
    this.notifyPending = true;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.notifyPending = false;
      this.flush();
    }, NOTIFY_INTERVAL_MS);
  }

  private flush(): void {
    const view = this.view;
    for (const subscriber of this.subscribers) subscriber(view);
  }

  private readonly onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!this.isBusy) return;
    // Custom text is not supported; the browser shows its own wording.
    event.preventDefault();
    event.returnValue = "";
  };

  private attachUnloadGuard(): void {
    if (this.unloadGuardAttached || typeof window === "undefined") return;
    window.addEventListener("beforeunload", this.onBeforeUnload);
    this.unloadGuardAttached = true;
  }

  private updateUnloadGuard(): void {
    if (typeof window === "undefined") return;
    if (this.isBusy) {
      this.attachUnloadGuard();
      return;
    }
    if (!this.unloadGuardAttached) return;
    window.removeEventListener("beforeunload", this.onBeforeUnload);
    this.unloadGuardAttached = false;
  }
}

let manager: ReplayExportManager | null = null;

/**
 * The one manager for this browsing context. Never call this during SSR: a
 * mutable job owner in a server module would be shared between requests.
 */
export function getReplayExportManager(): ReplayExportManager {
  if (typeof window === "undefined") {
    throw new Error("The replay export manager is browser-only.");
  }
  if (!manager) manager = new ReplayExportManager();
  return manager;
}

export function peekReplayExportManager(): ReplayExportManager | null {
  return manager;
}

/** Longest output the current destination choice admits, in seconds. */
export function maxOutputSecondsFor(destination: "file" | "buffer"): number {
  return REPLAY_EXPORT_ADMISSION[destination].maxOutputSeconds;
}

