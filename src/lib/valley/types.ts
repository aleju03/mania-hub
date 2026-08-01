// Defensive parsing of the live-backend /api/admin/status payload into the
// small typed slice the valley sim needs. The raw payload shape can drift;
// every field degrades to a safe default.

export interface ValleyCountry {
  country: string;
  status: string;
  featureTier: string;
  keepWarm: boolean;
  pinned: boolean;
  isWarm: boolean;
  activeUsers: number;
  lastActiveAt: string | null;
}

export interface ValleyStatus {
  ok: boolean;
  db: boolean;
  fetchedAt: number;
  lastEventAt: string | null;
  osc: {
    connected: boolean;
    stale: boolean;
    restarts: number;
    lastError: string | null;
    staleSinceAt: string | null;
    nextReconnectAt: string | null;
  } | null;
  storage: {
    bytes: number;
    walBytes: number;
    maxBytes: number;
    overLimit: boolean;
  } | null;
  queueDepth: number;
  deferred: number;
  shedding: boolean;
  queueSummary: Array<{ status: string; type: string; count: number }>;
  rate: {
    usedLastMinute: number;
    targetPerMinute: number;
    hardPerMinute: number;
    pending: number;
    byCaller: Array<{ caller: string; count: number }>;
  } | null;
  apiErrors15m: number;
  sqliteBusyLastAt: string | null;
  sqliteBusyExhausted: number;
  scoresFallback: {
    enabled: boolean;
    inserted: number;
    fetched: number;
    updatedAt: string | null;
  } | null;
  sseTotal: number;
  sseIps: number;
  countries: ValleyCountry[];
  workerPaused: boolean;
  lanes: Array<{ name: string; active: number; jobTypes: string[] }>;
  analysis: { analyzed: number; running: number; failed: number } | null;
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function bool(v: unknown): boolean {
  return v === true;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function parseValleyStatus(raw: unknown): ValleyStatus {
  const root = obj(raw) ?? {};
  const osc = obj(root.osc);
  const storage = obj(root.storage);
  const pressure = obj(root.queuePressure);
  const rate = obj(root.rate);
  const busy = obj(root.sqliteBusy);
  const busyServer = obj(busy?.server);
  const busyWorker = obj(busy?.worker);
  const fallback = obj(root.scoresFallback);
  const fallbackResult = obj(fallback?.result);
  const abuse = obj(root.abuse);
  const worker = obj(root.worker);
  const analysis = obj(root.analysis);
  const history = obj(root.apiCallHistory);

  let apiErrors = 0;
  for (const row of arr(history?.byCaller)) {
    apiErrors += num(obj(row)?.errors);
  }

  const busyDates = [str(busyServer?.lastAt), str(busyWorker?.lastAt)].filter(Boolean) as string[];
  busyDates.sort();

  return {
    ok: bool(root.ok),
    db: bool(root.db),
    fetchedAt: Date.now(),
    lastEventAt: str(root.lastEventAt),
    osc: osc
      ? {
          connected: bool(osc.connected),
          stale: bool(osc.stale),
          restarts: num(osc.restarts),
          lastError: str(osc.lastError),
          staleSinceAt: str(osc.staleSinceAt),
          nextReconnectAt: str(osc.nextReconnectAt),
        }
      : null,
    storage: storage
      ? {
          bytes: num(storage.bytes),
          walBytes: num(storage.walBytes),
          maxBytes: num(storage.maxBytes, 1),
          overLimit: bool(storage.overLimit),
        }
      : null,
    queueDepth: num(root.queueDepth),
    deferred: num(pressure?.deferred),
    shedding: bool(pressure?.shedding),
    queueSummary: arr(root.queueSummary).map((row) => {
      const r = obj(row) ?? {};
      return { status: str(r.status) ?? "", type: str(r.type) ?? "", count: num(r.count) };
    }),
    rate: rate
      ? {
          usedLastMinute: num(rate.usedLastMinute),
          targetPerMinute: num(rate.targetPerMinute, 45),
          hardPerMinute: num(rate.hardPerMinute, 120),
          pending: num(rate.pending),
          byCaller: arr(rate.byCaller)
            .map((row) => {
              const r = obj(row) ?? {};
              return { caller: str(r.caller) ?? "?", count: num(r.count) };
            })
            .slice(0, 5),
        }
      : null,
    apiErrors15m: apiErrors,
    sqliteBusyLastAt: busyDates.length ? busyDates[busyDates.length - 1] : null,
    sqliteBusyExhausted: num(busyServer?.exhausted) + num(busyWorker?.exhausted),
    scoresFallback: fallback
      ? {
          enabled: bool(fallback.enabled),
          inserted: num(fallbackResult?.inserted),
          fetched: num(fallbackResult?.fetched),
          updatedAt: str(fallback.updatedAt),
        }
      : null,
    sseTotal: num(abuse?.sseTotal),
    sseIps: num(abuse?.sseIps),
    countries: arr(root.countries).map((row) => {
      const r = obj(row) ?? {};
      return {
        country: str(r.country) ?? "??",
        status: str(r.status) ?? "cold",
        featureTier: str(r.featureTier) ?? "indexed",
        keepWarm: bool(r.keepWarm),
        pinned: bool(r.pinned),
        isWarm: bool(r.isWarm),
        activeUsers: num(r.activeUsers),
        lastActiveAt: str(r.lastActiveAt),
      };
    }),
    workerPaused: bool(worker?.paused),
    lanes: arr(worker?.lanes).map((row) => {
      const r = obj(row) ?? {};
      return {
        name: str(r.name) ?? "?",
        active: arr(r.activeJobs).length,
        jobTypes: arr(r.jobTypes).map((t) => String(t)),
      };
    }),
    analysis: analysis
      ? { analyzed: num(analysis.analyzed), running: num(analysis.running), failed: num(analysis.failed) }
      : null,
  };
}

// --- analytics slice ---

export interface ValleyVisitorEvent {
  key: string; // unique per event, for diffing
  label: string; // short human label, e.g. "RANKINGS"
  path: string;
  country: string | null;
}

export interface ValleyVisitors {
  available: boolean;
  /* True when served by the in-house analytics store (fresher; poll faster). */
  live?: boolean;
  activeVisitors: number;
  recent: ValleyVisitorEvent[];
  fetchedAt: number;
}

export function eventLabelForPath(path: string | null, username?: string | null): string {
  if (!path || path === "/") return "HOME";
  if (path.startsWith("/player/")) return username ? `PLAYER ${username}` : "PLAYER";
  const seg = path.split("/")[1] ?? "";
  const known: Record<string, string> = {
    rankings: "RANKINGS",
    maps: "MAPS",
    tracker: "TRACKER",
    "top-plays": "TOP PLAYS",
    snipes: "SNIPES",
    replay: "REPLAY",
    "farm-helper": "FARM HELPER",
    goals: "GOALS",
    packs: "CARD PACKS",
    skins: "SKINS",
    "my-data": "MY DATA",
    "my-stats": "MY STATS",
    settings: "SETTINGS",
    bbcode: "BBCODE",
    videos: "VIDEOS",
  };
  return known[seg] ?? seg.toUpperCase().slice(0, 14);
}
