// Crash forensics for the replay viewer.
//
// A record in sessionStorage marks a watch session as in progress. A second
// copy in localStorage makes the last marker readable from another same-origin
// tab when the replay tab is hung too hard to reload. Ordinary page exits clear
// both. The record carries periodic JS heap samples (Chrome exposes
// performance.memory) so the report distinguishes a heap OOM (usedJSHeapSize
// climbing toward jsHeapSizeLimit) from a GPU/other renderer death (flat heap).

import { track } from "./analytics";

const STORAGE_KEY = "mh_replay_watch_beacon";
// Shared across same-origin tabs so a second tab can retrieve diagnostics while
// the replay tab's main thread is permanently hung and cannot reload.
export const REPLAY_WATCH_DEBUG_STORAGE_KEY = "mh_replay_watch_beacon_debug";
const SAMPLE_INTERVAL_MS = 10_000;
const MAX_SAMPLES = 40;
const MAX_INIT_TRACE_ENTRIES = 30;

interface ChromeMemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

interface BeaconLastError {
  message: string;
  stack: string | null;
  at: number;
}

interface BeaconRecord {
  sessionId: string;
  startedAt: number;
  lastSampleAt: number;
  watchedMs: number | null;
  heapLimitMb: number | null;
  peakUsedMb: number | null;
  // [seconds since start, used MB] tuples, thinned to cover the whole session.
  samples: Array<[number, number]>;
  context: Record<string, unknown>;
  // Last uncaught error / rejection seen during the session. A crash usually
  // takes the error detail with it, so this is our best chance at a cause.
  lastError: BeaconLastError | null;
}

interface ReplayWatchTraceEntry {
  stage: string;
  atMs: number;
  details?: Record<string, unknown>;
}

// The in-memory handle to the live session so late-arriving diagnostics (the
// resolved renderer backend, a WebGL context-loss event) can be merged in after
// the beacon starts.
let activeRecord: BeaconRecord | null = null;

const MAX_STACK_CHARS = 4000;

function getMemory(): ChromeMemoryInfo | null {
  const memory = (performance as Performance & { memory?: ChromeMemoryInfo }).memory;
  return memory && Number.isFinite(memory.usedJSHeapSize) ? memory : null;
}

function readRecord(): BeaconRecord | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BeaconRecord;
    return typeof parsed?.startedAt === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function writeRecord(record: BeaconRecord) {
  let raw: string;
  try {
    raw = JSON.stringify(record);
  } catch {
    return;
  }
  try {
    window.sessionStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // Keep trying the shared mirror below.
  }
  try {
    window.localStorage.setItem(REPLAY_WATCH_DEBUG_STORAGE_KEY, raw);
  } catch {
    // Quota/security failures just disable the cross-tab mirror.
  }
}

function clearRecord(record: BeaconRecord) {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
  try {
    const sharedRaw = window.localStorage.getItem(REPLAY_WATCH_DEBUG_STORAGE_KEY);
    if (!sharedRaw) return;
    const shared = JSON.parse(sharedRaw) as Partial<BeaconRecord>;
    // Do not let an older replay tab remove a newer tab's diagnostic record.
    if (!record.sessionId || shared.sessionId === record.sessionId) {
      window.localStorage.removeItem(REPLAY_WATCH_DEBUG_STORAGE_KEY);
    }
  } catch {
    // Ignore malformed/unavailable shared storage.
  }
}

const toMb = (bytes: number) => Math.round(bytes / 1048576);

// Probes a throwaway WebGL context for GPU identity + WebGL availability. This
// distinguishes a GPU/driver crash on a specific card (gpu_renderer set, WebGL
// supported) from a no-WebGL Canvas-fallback grind (webgl_supported false). The
// context is dropped immediately so it never counts against the browser's live
// WebGL context limit.
function getGpuInfo(): Record<string, unknown> {
  try {
    if (typeof document === "undefined") return {};
    const canvas = document.createElement("canvas");
    const gl2 = canvas.getContext("webgl2");
    const gl = (gl2 ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return { webgl_supported: false };
    const info: Record<string, unknown> = { webgl_supported: true, webgl_version: gl2 ? 2 : 1 };
    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    if (debugInfo) {
      info.gpu_renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? null;
      info.gpu_vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) ?? null;
    }
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return info;
  } catch {
    return {};
  }
}

// Merges late diagnostics into the live beacon (e.g. the resolved Pixi renderer
// backend once it initialises, or a WebGL context-loss marker). No-op when no
// session is active.
export function updateReplayWatchBeaconContext(patch: Record<string, unknown>) {
  if (typeof window === "undefined" || !activeRecord) return;
  activeRecord.context = { ...activeRecord.context, ...patch };
  writeRecord(activeRecord);
}

// Persists replay progress synchronously. If GPU work kills the renderer
// process, the last completed marker survives in sessionStorage and is
// reported after the tab reloads. Keep this callback tiny and guarded: crash
// forensics must never become a reason playback fails.
function markReplayStage(
  stage: string,
  details?: Record<string, unknown>,
  rendererInit = false,
) {
  if (typeof window === "undefined" || !activeRecord) return;
  try {
    const atMs = Date.now() - activeRecord.startedAt;
    const existing = Array.isArray(activeRecord.context.replay_watch_trace)
      ? activeRecord.context.replay_watch_trace as ReplayWatchTraceEntry[]
      : [];
    const entry: ReplayWatchTraceEntry = details
      ? { stage, atMs, details }
      : { stage, atMs };
    activeRecord.context = {
      ...activeRecord.context,
      ...details,
      replay_watch_stage: stage,
      replay_watch_stage_at_ms: atMs,
      replay_watch_trace: [...existing, entry].slice(-MAX_INIT_TRACE_ENTRIES),
    };
    if (rendererInit) {
      const existingInit = Array.isArray(activeRecord.context.renderer_init_trace)
        ? activeRecord.context.renderer_init_trace as ReplayWatchTraceEntry[]
        : [];
      activeRecord.context.renderer_init_stage = stage;
      activeRecord.context.renderer_init_stage_at_ms = atMs;
      activeRecord.context.renderer_init_trace = [...existingInit, entry].slice(-MAX_INIT_TRACE_ENTRIES);
    }
    writeRecord(activeRecord);
    console.debug(`[replay watch] +${atMs}ms ${stage}`, details ?? "");
  } catch {
    // Diagnostics are best-effort and must not affect playback.
  }
}

// Generic watch-session marker for visibility/focus/resume work after init.
export function markReplayWatchStage(stage: string, details?: Record<string, unknown>) {
  markReplayStage(stage, details);
}

export function markReplayRendererInitStage(stage: string, details?: Record<string, unknown>) {
  markReplayStage(stage, details, true);
}

// Reports (and clears) a watch session left behind by a previous page load.
// Call once when the replay page mounts, before a new beacon starts.
export function reportCrashedReplayWatchSession() {
  if (typeof window === "undefined") return;
  const record = readRecord();
  if (!record) return;
  clearRecord(record);

  const samples = record.samples ?? [];
  const lastSample = samples[samples.length - 1] ?? null;
  const lastError = record.lastError ?? null;
  const crashReport = {
    ...record.context,
    crash_detected_at: new Date().toISOString(),
    session_started_at: new Date(record.startedAt).toISOString(),
    last_sample_at: new Date(record.lastSampleAt).toISOString(),
    replay_url: window.location.href,
    user_agent: navigator.userAgent,
    watched_ms: record.watchedMs,
    session_ms: record.lastSampleAt - record.startedAt,
    heap_limit_mb: record.heapLimitMb,
    heap_peak_mb: record.peakUsedMb,
    heap_last_mb: lastSample ? lastSample[1] : null,
    heap_samples: samples,
    device_memory_gb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    last_error_message: lastError?.message ?? null,
    last_error_stack: lastError?.stack ? lastError.stack.slice(0, MAX_STACK_CHARS) : null,
    last_error_at_ms: lastError ? lastError.at - record.startedAt : null,
  };

  // This is deliberately local as well as analytics-backed. After reproducing
  // a hard crash, reload the crashed tab and copy the JSON line from DevTools.
  console.error("[replay crash] The previous replay renderer died without unloading.", crashReport);
  console.info("[replay crash] COPY THIS JSON", JSON.stringify(crashReport));
  track("replay_watch_crash", crashReport);
}

// Marks a watch session as active and samples the JS heap until stopped.
// Returns a stop function; call it when the replay page unmounts or the
// watched replay changes.
export function startReplayWatchBeacon(
  context: Record<string, unknown>,
  getWatchedMs: () => number | null,
): () => void {
  if (typeof window === "undefined") return () => {};

  const startedAt = Date.now();
  const initialStage: ReplayWatchTraceEntry = { stage: "gpu_probe_started", atMs: 0 };
  const record: BeaconRecord = {
    sessionId: crypto.randomUUID(),
    startedAt,
    lastSampleAt: startedAt,
    watchedMs: null,
    heapLimitMb: null,
    peakUsedMb: null,
    samples: [],
    context: {
      ...context,
      replay_watch_url: window.location.href,
      replay_watch_stage: initialStage.stage,
      replay_watch_stage_at_ms: initialStage.atMs,
      replay_watch_trace: [initialStage],
      renderer_init_stage: initialStage.stage,
      renderer_init_stage_at_ms: initialStage.atMs,
      renderer_init_trace: [initialStage],
    },
    lastError: null,
  };
  activeRecord = record;
  // Persist before asking the browser for the diagnostic WebGL context. A bad
  // driver can die during the probe itself, in which case this is the only
  // marker that can survive.
  writeRecord(record);
  markReplayRendererInitStage("gpu_probe_finished", getGpuInfo());

  const sample = () => {
    record.lastSampleAt = Date.now();
    record.watchedMs = getWatchedMs();
    const memory = getMemory();
    if (memory) {
      const usedMb = toMb(memory.usedJSHeapSize);
      record.heapLimitMb = toMb(memory.jsHeapSizeLimit);
      record.peakUsedMb = Math.max(record.peakUsedMb ?? 0, usedMb);
      record.samples.push([Math.round((record.lastSampleAt - record.startedAt) / 1000), usedMb]);
      if (record.samples.length > MAX_SAMPLES) {
        // Drop every other sample so the retained set still spans the session.
        record.samples = record.samples.filter((_, index) => index % 2 === 0);
      }
    }
    writeRecord(record);
  };

  sample();
  const intervalId = window.setInterval(sample, SAMPLE_INTERVAL_MS);

  // A real navigation/close unloads the page; a crash never fires pagehide.
  const handlePageHide = () => clearRecord(record);
  // Restored from bfcache: the session is live again, re-arm the record.
  const handlePageShow = (event: PageTransitionEvent) => {
    if (event.persisted) sample();
  };
  // Capture the last uncaught error/rejection so a crash report can carry a
  // cause. The report is inferred on the next load, after the error itself is
  // gone, so this is the only place to record it.
  const rememberError = (message: string, stack: string | null) => {
    record.lastError = { message: message.slice(0, 500), stack, at: Date.now() };
    writeRecord(record);
  };
  const handleError = (event: ErrorEvent) => {
    rememberError(event.message || "error", event.error instanceof Error ? event.error.stack ?? null : null);
  };
  const handleRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    rememberError(
      reason instanceof Error ? reason.message : String(reason),
      reason instanceof Error ? reason.stack ?? null : null,
    );
  };
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("pageshow", handlePageShow);
  window.addEventListener("error", handleError);
  window.addEventListener("unhandledrejection", handleRejection);

  return () => {
    window.clearInterval(intervalId);
    window.removeEventListener("pagehide", handlePageHide);
    window.removeEventListener("pageshow", handlePageShow);
    window.removeEventListener("error", handleError);
    window.removeEventListener("unhandledrejection", handleRejection);
    if (activeRecord === record) activeRecord = null;
    clearRecord(record);
  };
}
