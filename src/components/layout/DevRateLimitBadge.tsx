import { useEffect, useMemo, useState } from "react";
import { getOsuRateStats } from "../../lib/api";

type RecentCall = {
  ts: number;
  path: string;
  caller: string;
  status: number;
};

type Stats = {
  perMin: number;
  remaining: number | null;
  limit: number | null;
  updatedAgoMs: number | null;
  recent: RecentCall[];
};

type CallerGroup = {
  caller: string;
  count: number;
  paths: { path: string; count: number }[];
};

type RecentRun = {
  caller: string;
  template: string;
  count: number;
  firstTs: number;
  lastTs: number;
  lastStatus: number;
  hasError: boolean;
  samplePath: string;
};

function pathTemplate(path: string): string {
  const [p] = path.split("?");
  if (!p) return path;
  return p.replace(/\/\d+(?=\/|$)/g, "/:id");
}

function collapseRuns(recent: RecentCall[]): RecentRun[] {
  const runs: RecentRun[] = [];
  for (const c of recent) {
    const template = pathTemplate(c.path);
    const prev = runs[runs.length - 1];
    if (prev && prev.caller === c.caller && prev.template === template) {
      prev.count += 1;
      if (c.ts < prev.firstTs) prev.firstTs = c.ts;
      if (c.ts > prev.lastTs) {
        prev.lastTs = c.ts;
        prev.lastStatus = c.status;
        prev.samplePath = c.path;
      }
      if (c.status >= 400) prev.hasError = true;
    } else {
      runs.push({
        caller: c.caller,
        template,
        count: 1,
        firstTs: c.ts,
        lastTs: c.ts,
        lastStatus: c.status,
        hasError: c.status >= 400,
        samplePath: c.path,
      });
    }
  }
  return runs;
}

export function DevRateLimitBadge() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = (await getOsuRateStats()) as Stats;
        if (!cancelled) setStats(res);
      } catch {
        // ignore; dev HUD is best-effort
      }
    };
    void poll();
    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const grouped = useMemo<CallerGroup[]>(() => {
    if (!stats) return [];
    const map = new Map<string, Map<string, number>>();
    for (const c of stats.recent) {
      const template = pathTemplate(c.path);
      let paths = map.get(c.caller);
      if (!paths) {
        paths = new Map();
        map.set(c.caller, paths);
      }
      paths.set(template, (paths.get(template) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([caller, paths]) => ({
        caller,
        count: [...paths.values()].reduce((a, b) => a + b, 0),
        paths: [...paths.entries()]
          .map(([path, count]) => ({ path, count }))
          .sort((a, b) => b.count - a.count),
      }))
      .sort((a, b) => b.count - a.count);
  }, [stats]);

  if (!stats) return null;

  const { perMin, remaining, limit } = stats;
  const cap = limit ?? 1200;
  const low = remaining != null && remaining < cap * 0.2;
  const hot = perMin >= 60;

  const leftText = remaining != null ? `${remaining}/${cap}` : "-/-";
  const ageText =
    stats.updatedAgoMs != null ? `${Math.round(stats.updatedAgoMs / 1000)}s ago` : "idle";

  return (
    <>
      {open ? (
        <div
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 bg-black/50 sm:bg-transparent"
          aria-hidden
        />
      ) : null}
      <div className="fixed bottom-3 left-3 z-50">
        {open ? (
          <CallsPanel stats={stats} grouped={grouped} onClose={() => setOpen(false)} />
        ) : null}
        <button
          onClick={() => setOpen((v) => !v)}
          className={`block rounded-md px-2.5 py-1.5 font-mono text-[10px] leading-tight shadow-lg backdrop-blur-sm select-none cursor-pointer text-left transition-colors touch-manipulation ${
            low ? "bg-red-900/80 text-red-100 hover:bg-red-900/90" : "bg-black/70 text-white/80 hover:bg-black/85"
          } ${open ? "ring-1 ring-white/30" : ""}`}
          title={`osu! API rate-limit tracker (dev only) · tap for call details · last header ${ageText}`}
        >
          <div>
            osu: <span className="text-white">{leftText}</span> left
          </div>
          <div className={hot ? "text-yellow-300" : ""}>{perMin}/min</div>
        </button>
      </div>
    </>
  );
}

function CallsPanel({
  stats,
  grouped,
  onClose,
}: {
  stats: Stats;
  grouped: CallerGroup[];
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (caller: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(caller)) next.delete(caller);
      else next.add(caller);
      return next;
    });
  };

  const runs = useMemo(() => collapseRuns(stats.recent), [stats]);
  const now = Date.now();

  return (
    <div
      className="
        fixed left-2 right-2 bottom-[60px] max-h-[75vh]
        sm:absolute sm:left-0 sm:right-auto sm:bottom-full sm:mb-2 sm:w-[440px] sm:max-h-[70vh]
        rounded-md bg-black/90 backdrop-blur-sm shadow-xl border border-white/10 font-mono text-[10px] text-white/90 flex flex-col overflow-hidden
      "
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 flex-shrink-0 gap-2">
        <div className="text-white/70 truncate">
          osu! calls{" "}
          <span className="text-white/40">
            · {stats.recent.length} tracked · {stats.perMin}/min
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-white/60 hover:text-white cursor-pointer leading-none touch-manipulation w-7 h-7 sm:w-5 sm:h-5 flex items-center justify-center text-base sm:text-sm -mr-1"
          title="close"
          aria-label="Close"
        >
          ×
        </button>
      </div>
      <div className="overflow-y-auto flex-1 p-2 space-y-3">
        <section>
          <div className="text-white/40 uppercase tracking-wider text-[9px] mb-1 px-1">
            By caller
          </div>
          {grouped.length === 0 ? (
            <div className="text-white/40 px-2 py-2">No calls tracked yet.</div>
          ) : (
            <div className="space-y-0.5">
              {grouped.map((g) => {
                const isExpanded = expanded.has(g.caller);
                return (
                  <div key={g.caller}>
                    <button
                      onClick={() => toggle(g.caller)}
                      className="w-full flex items-center justify-between px-2 py-1.5 sm:py-1 rounded hover:bg-white/5 cursor-pointer text-left gap-2 touch-manipulation"
                    >
                      <span className="flex items-center gap-1 min-w-0">
                        <span className="text-white/40 w-3 flex-shrink-0">
                          {isExpanded ? "▾" : "▸"}
                        </span>
                        <span className="text-white/90 truncate">{g.caller}</span>
                      </span>
                      <span className="text-white font-bold flex-shrink-0">{g.count}</span>
                    </button>
                    {isExpanded ? (
                      <div className="pl-7 pr-2 py-1 space-y-0.5">
                        {g.paths.map((p) => (
                          <div
                            key={p.path}
                            className="flex items-center justify-between gap-2 text-white/70"
                            title={p.path}
                          >
                            <span className="truncate min-w-0">{p.path}</span>
                            <span className="text-white/40 flex-shrink-0">×{p.count}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <div className="text-white/40 uppercase tracking-wider text-[9px] mb-1 px-1">
            Recent <span className="text-white/30 normal-case tracking-normal">(collapsed by template)</span>
          </div>
          <div className="space-y-0.5">
            {runs.map((r, i) => {
              const newAge = Math.max(0, Math.round((now - r.lastTs) / 1000));
              const oldAge = Math.max(0, Math.round((now - r.firstTs) / 1000));
              const ageLabel =
                r.count > 1 && oldAge !== newAge ? `${newAge}-${oldAge}s` : `${newAge}s`;
              return (
                <div
                  key={`${r.lastTs}-${i}`}
                  className="flex items-center gap-2 px-2 py-0.5"
                  title={`${r.caller} · ${r.samplePath}${r.count > 1 ? ` (latest of ${r.count})` : ""}`}
                >
                  <span className="text-white/40 w-14 flex-shrink-0 text-right">
                    {ageLabel}
                  </span>
                  <span
                    className={`w-8 flex-shrink-0 ${r.hasError ? "text-red-400" : "text-green-400/70"}`}
                  >
                    {r.lastStatus}
                  </span>
                  <span className="w-8 flex-shrink-0 text-right text-white/50">
                    {r.count > 1 ? `×${r.count}` : ""}
                  </span>
                  <span className="text-white/60 truncate w-[110px] flex-shrink-0">
                    {r.caller}
                  </span>
                  <span className="text-white/80 truncate flex-1 min-w-0">{r.template}</span>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
