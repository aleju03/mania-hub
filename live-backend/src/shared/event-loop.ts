// Event loop stall monitor for the admin dashboard and the journal.
//
// Local libsql runs every query synchronously on the calling thread, so any
// whole-roster read or multi-MB JSON.parse on the serving thread freezes every
// request and SSE write for its duration. Those freezes never showed up
// anywhere: the request journal only records how long a request took, not
// why, and it took a live probe to see 5s stalls once or twice a minute. This
// records them permanently: a 100ms heartbeat timer measures how late it
// fired, anything over the threshold is a stall, and stalls past the log
// threshold are also written to the journal as event_loop_stall with their
// length. perf_hooks' delay histogram sits alongside for the shape of the
// ordinary jitter (p50/p99) over the last completed minute.
//
// Cost: two timers and a few arithmetic ops per tick. Reading the status is a
// walk over at most an hour of stalls.
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { logInfo, logWarn } from "../logger.js";

export interface EventLoopStall {
  at: string;
  ms: number;
}

export interface EventLoopWindow {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface EventLoopDelayPercentiles {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}

export interface EventLoopStatus {
  role: string;
  pid: number;
  at: string;
  /** How long the monitor has been sampling, so a clean hour after boot cannot be confused with a clean hour. */
  sampledForSec: number;
  /** A heartbeat this many ms late counts as a stall. */
  stallThresholdMs: number;
  /** Stalls at least this long are also written to the journal. */
  logThresholdMs: number;
  /** Loop delay over the last completed minute; null until one has completed. */
  lastMinute: EventLoopDelayPercentiles | null;
  stalls: {
    lastHour: EventLoopWindow;
    sinceStart: EventLoopWindow;
    /** Newest first, capped. */
    recent: EventLoopStall[];
  };
  hint: string;
}

export interface EventLoopMonitorOptions {
  heartbeatMs?: number;
  stallThresholdMs?: number;
  logThresholdMs?: number;
  histogramWindowMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 100;
const DEFAULT_STALL_THRESHOLD_MS = 200;
const DEFAULT_LOG_THRESHOLD_MS = 500;
const DEFAULT_HISTOGRAM_WINDOW_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;
const RECENT_STALLS = 20;
const HINT = "A stall is the serving thread running one synchronous job (libsql query, JSON.parse) for that long: every request and SSE write waits it out. p50/p99 are ordinary timer lateness over the last completed minute.";

interface MonitorState {
  role: string;
  startedAt: number;
  heartbeatMs: number;
  stallThresholdMs: number;
  logThresholdMs: number;
  heartbeat: NodeJS.Timeout;
  histogramTimer: NodeJS.Timeout;
  histogram: IntervalHistogram;
  lastMinute: EventLoopDelayPercentiles | null;
  // Every stall of the last hour, oldest first; pruned on read and on record.
  hourStalls: Array<{ at: number; ms: number }>;
  sinceStart: EventLoopWindow;
}

let monitor: MonitorState | null = null;

function nanosToMs(nanos: number): number {
  return Math.round(nanos / 1e4) / 100;
}

function snapshotHistogram(histogram: IntervalHistogram): EventLoopDelayPercentiles | null {
  // An empty histogram reports min as the max safe integer and mean as NaN.
  if (!(histogram.count > 0)) return null;
  return {
    p50Ms: nanosToMs(histogram.percentile(50)),
    p99Ms: nanosToMs(histogram.percentile(99)),
    maxMs: nanosToMs(histogram.max),
    meanMs: nanosToMs(histogram.mean),
  };
}

function pruneHour(state: MonitorState, now: number): void {
  const cutoff = now - HOUR_MS;
  let drop = 0;
  while (drop < state.hourStalls.length && state.hourStalls[drop].at < cutoff) drop += 1;
  if (drop > 0) state.hourStalls.splice(0, drop);
}

function recordStall(state: MonitorState, at: number, ms: number): void {
  state.hourStalls.push({ at, ms });
  pruneHour(state, at);
  state.sinceStart.count += 1;
  state.sinceStart.totalMs += ms;
  if (ms > state.sinceStart.maxMs) state.sinceStart.maxMs = ms;
  if (ms >= state.logThresholdMs) {
    // Warn from a second up: that is the length at which a page visibly hangs.
    (ms >= 1000 ? logWarn : logInfo)("event_loop_stall", { role: state.role, ms });
  }
}

/**
 * Starts sampling this thread's event loop. Idempotent: a second call returns
 * the running monitor. Timers are unref'd, so the monitor never holds the
 * process open.
 */
export function startEventLoopMonitor(role: string, options: EventLoopMonitorOptions = {}): void {
  if (monitor) return;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const histogramWindowMs = options.histogramWindowMs ?? DEFAULT_HISTOGRAM_WINDOW_MS;
  const histogram = monitorEventLoopDelay({ resolution: Math.max(1, Math.min(20, heartbeatMs)) });
  histogram.enable();
  let expectedAt = Date.now() + heartbeatMs;
  const heartbeat = setInterval(() => {
    const now = Date.now();
    const state = monitor;
    if (!state) return;
    // Lateness of this tick alone. The interval keeps its own schedule, so a
    // stall shows up as one late tick followed by a burst of on-time ones
    // rather than as a permanent offset.
    const lateMs = now - expectedAt;
    expectedAt = now + heartbeatMs;
    if (lateMs >= stallThresholdMs) recordStall(state, now - lateMs, lateMs);
  }, heartbeatMs);
  heartbeat.unref();
  const histogramTimer = setInterval(() => {
    const state = monitor;
    if (!state) return;
    state.lastMinute = snapshotHistogram(state.histogram);
    state.histogram.reset();
  }, histogramWindowMs);
  histogramTimer.unref();
  monitor = {
    role,
    startedAt: Date.now(),
    heartbeatMs,
    stallThresholdMs,
    logThresholdMs: options.logThresholdMs ?? DEFAULT_LOG_THRESHOLD_MS,
    heartbeat,
    histogramTimer,
    histogram,
    lastMinute: null,
    hourStalls: [],
    sinceStart: { count: 0, totalMs: 0, maxMs: 0 },
  };
}

/** Stops sampling and forgets everything recorded. Tests only; production monitors live as long as the process. */
export function stopEventLoopMonitor(): void {
  const state = monitor;
  if (!state) return;
  clearInterval(state.heartbeat);
  clearInterval(state.histogramTimer);
  state.histogram.disable();
  monitor = null;
}

/** Null until startEventLoopMonitor has run in this thread. */
export function eventLoopStatus(): EventLoopStatus | null {
  const state = monitor;
  if (!state) return null;
  const now = Date.now();
  pruneHour(state, now);
  const lastHour: EventLoopWindow = { count: 0, totalMs: 0, maxMs: 0 };
  for (const stall of state.hourStalls) {
    lastHour.count += 1;
    lastHour.totalMs += stall.ms;
    if (stall.ms > lastHour.maxMs) lastHour.maxMs = stall.ms;
  }
  const recent: EventLoopStall[] = [];
  for (let i = state.hourStalls.length - 1; i >= 0 && recent.length < RECENT_STALLS; i -= 1) {
    const stall = state.hourStalls[i];
    recent.push({ at: new Date(stall.at).toISOString(), ms: stall.ms });
  }
  return {
    role: state.role,
    pid: process.pid,
    at: new Date(now).toISOString(),
    sampledForSec: Math.round((now - state.startedAt) / 1000),
    stallThresholdMs: state.stallThresholdMs,
    logThresholdMs: state.logThresholdMs,
    // The live window until the first one completes, so a fresh boot is not
    // blank for a minute.
    lastMinute: state.lastMinute ?? snapshotHistogram(state.histogram),
    stalls: { lastHour, sinceStart: { ...state.sinceStart }, recent },
    hint: HINT,
  };
}
