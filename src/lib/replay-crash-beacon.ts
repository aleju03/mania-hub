// Crash forensics for the replay viewer.
//
// A record in sessionStorage marks a watch session as in progress. Ordinary
// page exits clear it. The record carries periodic JS heap samples (Chrome exposes
// performance.memory) so the report distinguishes a heap OOM (usedJSHeapSize
// climbing toward jsHeapSizeLimit) from a GPU/other renderer death (flat heap).

import { track } from "./analytics";

const STORAGE_KEY = "mh_replay_watch_beacon";
const LEGACY_DEBUG_STORAGE_KEY = "mh_replay_watch_beacon_debug";
const SAMPLE_INTERVAL_MS = 10_000;
const MAX_SAMPLES = 40;

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
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Quota/security failures just disable the diagnostics.
  }
}

function clearRecord() {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

function clearLegacyDebugRecord() {
  try {
    window.localStorage.removeItem(LEGACY_DEBUG_STORAGE_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}

const toMb = (bytes: number) => Math.round(bytes / 1048576);

// Merges late diagnostics into the live beacon (e.g. the resolved Pixi renderer
// backend once it initialises, or a WebGL context-loss marker). No-op when no
// session is active.
export function updateReplayWatchBeaconContext(patch: Record<string, unknown>) {
  if (typeof window === "undefined" || !activeRecord) return;
  activeRecord.context = { ...activeRecord.context, ...patch };
  writeRecord(activeRecord);
}

// Reports (and clears) a watch session left behind by a previous page load.
// Call once when the replay page mounts, before a new beacon starts.
export function reportCrashedReplayWatchSession() {
  if (typeof window === "undefined") return;
  const record = readRecord();
  clearRecord();
  clearLegacyDebugRecord();
  if (!record) return;

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
  const record: BeaconRecord = {
    startedAt,
    lastSampleAt: startedAt,
    watchedMs: null,
    heapLimitMb: null,
    peakUsedMb: null,
    samples: [],
    context: { ...context, replay_watch_url: window.location.href },
    lastError: null,
  };
  activeRecord = record;
  // Never create a diagnostic WebGL context here. Creating and immediately
  // losing a throwaway context just before Pixi requests the real one can hang
  // ANGLE/the GPU process. GPU identity is read from Pixi's live context after
  // initialization instead.
  writeRecord(record);

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
  const handlePageHide = () => clearRecord();
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
    clearRecord();
  };
}
