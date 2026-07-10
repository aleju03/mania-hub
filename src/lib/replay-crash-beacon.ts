// Crash forensics for the replay viewer.
//
// A record in sessionStorage marks a watch session as in progress. Session
// storage survives a renderer crash + reload of the same tab, but is gone
// after a normal tab close, and the pagehide listener clears it on ordinary
// navigations - so finding a record from a previous page load means the tab
// died without unloading (crash, out-of-memory kill, or force-close of a hung
// page). The record carries periodic JS heap samples (Chrome exposes
// performance.memory) so the report distinguishes a heap OOM (usedJSHeapSize
// climbing toward jsHeapSizeLimit) from a GPU/other renderer death (flat heap).

import { track } from "./posthog";

const STORAGE_KEY = "mh_replay_watch_beacon";
const SAMPLE_INTERVAL_MS = 10_000;
const MAX_SAMPLES = 40;

interface ChromeMemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
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
}

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

const toMb = (bytes: number) => Math.round(bytes / 1048576);

// Reports (and clears) a watch session left behind by a previous page load.
// Call once when the replay page mounts, before a new beacon starts.
export function reportCrashedReplayWatchSession() {
  if (typeof window === "undefined") return;
  const record = readRecord();
  clearRecord();
  if (!record) return;

  const samples = record.samples ?? [];
  const lastSample = samples[samples.length - 1] ?? null;
  track("replay_watch_crash", {
    ...record.context,
    watched_ms: record.watchedMs,
    session_ms: record.lastSampleAt - record.startedAt,
    heap_limit_mb: record.heapLimitMb,
    heap_peak_mb: record.peakUsedMb,
    heap_last_mb: lastSample ? lastSample[1] : null,
    heap_samples: samples,
    device_memory_gb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
  });
}

// Marks a watch session as active and samples the JS heap until stopped.
// Returns a stop function; call it when the replay page unmounts or the
// watched replay changes.
export function startReplayWatchBeacon(
  context: Record<string, unknown>,
  getWatchedMs: () => number | null,
): () => void {
  if (typeof window === "undefined") return () => {};

  const record: BeaconRecord = {
    startedAt: Date.now(),
    lastSampleAt: Date.now(),
    watchedMs: null,
    heapLimitMb: null,
    peakUsedMb: null,
    samples: [],
    context,
  };

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
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("pageshow", handlePageShow);

  return () => {
    window.clearInterval(intervalId);
    window.removeEventListener("pagehide", handlePageHide);
    window.removeEventListener("pageshow", handlePageShow);
    clearRecord();
  };
}
