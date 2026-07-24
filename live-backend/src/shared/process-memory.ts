// Process memory counters for the admin dashboard and for job-level memory
// accounting.
//
// Deliberately built on process.memoryUsage() (~6.5us) plus
// process.resourceUsage().maxRSS (~0.9us) and nothing else. /proc/self/status
// is redundant with maxRSS, and /proc/self/smaps_rollup — the only source of
// Private_Dirty — is a page-table walk that measured ~4ms on a 1.15GB process
// on this hardware. Local libsql runs queries synchronously on the event loop,
// so a 4ms stall on a 5s poll is a real latency cost for a number the Phase 0
// baseline already answered once. If Private_Dirty is ever wanted again it
// belongs behind a separate on-demand admin endpoint, never in a polled body.
//
// Reading the numbers:
// * rss / peakRss are per-PROCESS and include every isolate's heap plus the
//   SQLite mmap windows and native allocations.
// * heapUsed / heapTotal are per-ISOLATE — they cover only the isolate that
//   called this. In the serving process the maps snapshot worker thread has
//   its own isolate, so the multi-hundred-MB GLOBAL farmed board it retains
//   shows up in rssBytes and peakRssBytes but NOT in heapUsedBytes. A reader
//   who does not know that will conclude the process is leaking outside the
//   heap; surface the distinction wherever these are rendered.

export interface ProcessMemorySample {
  pid: number;
  role: string;
  at: string;
  uptimeSec: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  // Process-lifetime high-water mark (== VmHWM on Linux), or null where the
  // runtime refuses to report it. Monotonic, so a sample up to 120s stale (the
  // status body's stale-serve window) is still exact.
  peakRssBytes: number | null;
  // Free-text note the UI can render next to the numbers so the per-isolate
  // heap vs per-process rss distinction above is never lost in transit.
  hint: string;
}

const MEMORY_HINT = "rss/peakRss are per-process; heapUsed is per-isolate, so the serving process's maps snapshot thread heap counts in rss but not heapUsed.";

export function readProcessMemory(role: string): ProcessMemorySample {
  const usage = process.memoryUsage();
  return {
    pid: process.pid,
    role,
    at: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
    peakRssBytes: readPeakRssBytes(),
    hint: MEMORY_HINT,
  };
}

// maxRSS is reported in kB on every platform libuv supports (it normalises the
// macOS bytes value), and equals /proc/self/status VmHWM on Linux.
function readPeakRssBytes(): number | null {
  try {
    const maxRssKb = process.resourceUsage().maxRSS;
    return Number.isFinite(maxRssKb) && maxRssKb > 0 ? maxRssKb * 1024 : null;
  } catch {
    return null;
  }
}

export interface JobMemoryMetric {
  at: string;
  pid: number;
  durationMs: number;
  ok: boolean;
  error: string | null;
  startRssBytes: number;
  peakRssBytes: number;
  endRssBytes: number;
  startHeapUsedBytes: number;
  peakHeapUsedBytes: number;
  // Process-lifetime high-water mark at the end of the run. Unlike peakRssBytes
  // this is not scoped to the job, but it is the only value that cannot be
  // missed by a sampler that could not fire.
  processPeakRssBytes: number | null;
  samples: number;
}

export interface PeakMemorySampler {
  stop(ok: boolean, error?: unknown): JobMemoryMetric;
}

const PEAK_SAMPLE_INTERVAL_MS = 500;

/**
 * Samples process RSS/heap while a job runs.
 *
 * Two caveats that belong in whatever renders the result. First, RSS is
 * process-wide: jobs run concurrently across lanes, so a co-resident job's
 * allocations are attributed here too — the honest label is "process peak RSS
 * while the job ran", not "this job's memory". Second, a timer cannot fire
 * inside a long synchronous stretch (a big JSON.parse/stringify); it samples at
 * the surrounding awaits, which is enough to catch a plateau but can miss a
 * spike that starts and ends inside one synchronous block. processPeakRssBytes
 * covers exactly that gap.
 *
 * The interval is unref()'d and cleared in stop(), so a forgotten sampler can
 * never hold a test runner or the process open.
 */
export function startPeakMemorySampler(): PeakMemorySampler {
  const startedAt = Date.now();
  const startedAtMs = performance.now();
  const initial = process.memoryUsage();
  let peakRss = initial.rss;
  let peakHeapUsed = initial.heapUsed;
  let samples = 1;
  const timer = setInterval(() => {
    const usage = process.memoryUsage();
    samples += 1;
    if (usage.rss > peakRss) peakRss = usage.rss;
    if (usage.heapUsed > peakHeapUsed) peakHeapUsed = usage.heapUsed;
  }, PEAK_SAMPLE_INTERVAL_MS);
  timer.unref();
  let stopped = false;
  return {
    stop(ok: boolean, error?: unknown): JobMemoryMetric {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
      const final = process.memoryUsage();
      samples += 1;
      if (final.rss > peakRss) peakRss = final.rss;
      if (final.heapUsed > peakHeapUsed) peakHeapUsed = final.heapUsed;
      return {
        at: new Date(startedAt).toISOString(),
        pid: process.pid,
        durationMs: Math.round(performance.now() - startedAtMs),
        ok,
        error: error == null ? null : error instanceof Error ? error.message : String(error),
        startRssBytes: initial.rss,
        peakRssBytes: peakRss,
        endRssBytes: final.rss,
        startHeapUsedBytes: initial.heapUsed,
        peakHeapUsedBytes: peakHeapUsed,
        processPeakRssBytes: readPeakRssBytes(),
        samples,
      };
    },
  };
}
