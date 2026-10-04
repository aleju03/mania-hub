import { ChevronDown, ChevronRight } from "lucide-react";
import type React from "react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { formatNumber } from "../../../lib/format";
import {
  fetchLiveBackendSweeps,
  type LiveBackendSweep,
} from "../../../lib/live-backend";

const SWEEPS_TAB_REFRESH_MS = 15_000;
const SWEEPS_SUMMARY_REFRESH_MS = 30_000;
// A running chain with no finished chunk for this long is waiting on its lane
// (or the workers are off), so its ETA is not worth showing.
const CHAIN_IDLE_MS = 20 * 60_000;

interface SweepsState {
  sweeps: LiveBackendSweep[] | null;
  unsupported: boolean;
  error: string | null;
}

function useLiveBackendSweeps(refreshMs: number): SweepsState {
  const [state, setState] = useState<SweepsState>({ sweeps: null, unsupported: false, error: null });
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetchLiveBackendSweeps();
        if (cancelled) return;
        setState(result === null
          ? { sweeps: [], unsupported: true, error: null }
          : { sweeps: result.sweeps, unsupported: false, error: null });
      } catch (err) {
        if (!cancelled) setState((current) => ({ ...current, error: err instanceof Error ? err.message : String(err) }));
      }
    };
    void load();
    const id = window.setInterval(() => void load(), refreshMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refreshMs]);
  return state;
}

/* Relative times on this page read "12s ago", so they tick between fetches. */
function useNow(intervalMs = 5_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function formatSweepDuration(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

function since(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? now - at : null;
}

interface SweepView {
  sweep: LiveBackendSweep;
  done: number | null;
  total: number | null;
  unit: string | null;
  /** 0-1, null when the sweep's position cannot be read as a share. */
  fraction: number | null;
  idleMs: number | null;
  idle: boolean;
  etaMs: number | null;
}

function viewSweep(sweep: LiveBackendSweep, now: number): SweepView {
  const progress = sweep.progress ?? {};
  const chain = sweep.chain ?? null;
  // A progress blob's processed/total is exact; the chain's table position is
  // the fallback for sweeps that only carry a cursor.
  let done: number | null = null;
  let total: number | null = null;
  let unit: string | null = null;
  if (typeof progress.total === "number" && progress.total > 0 && typeof progress.processed === "number") {
    done = progress.processed;
    total = progress.total;
  } else if (chain && chain.total != null && chain.total > 0 && chain.done != null) {
    done = chain.done;
    total = chain.total;
    unit = chain.unit;
  }
  const fraction = done != null && total ? Math.min(1, Math.max(0, done / total)) : null;
  const idleMs = since(chain?.lastChunkAt, now);
  const idle = sweep.status === "running" && idleMs != null && idleMs > CHAIN_IDLE_MS;
  const etaRemaining = since(chain?.etaAt, now);
  const etaMs = sweep.status === "running" && !idle && etaRemaining != null ? Math.max(0, -etaRemaining) : null;
  return { sweep, done, total, unit, fraction, idleMs, idle, etaMs };
}

function formatPercent(fraction: number): string {
  // Floor so an unfinished sweep never reads 100%.
  const pct = Math.floor(fraction * 1000) / 10;
  return pct < 10 ? `${pct.toFixed(1)}%` : `${Math.floor(pct)}%`;
}

function passLabel(sweep: LiveBackendSweep): string | null {
  const chain = sweep.chain;
  if (!chain?.pass) return null;
  return chain.passIndex && chain.passCount
    ? `pass ${chain.passIndex} of ${chain.passCount} (${chain.pass})`
    : `pass ${chain.pass}`;
}

function MetaLine({ items }: { items: Array<React.ReactNode | null | false> }) {
  const shown = items.filter(Boolean);
  if (shown.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-osu-f1 tabular-nums">
      {shown.map((item, index) => (
        <Fragment key={index}>
          {index > 0 ? <span aria-hidden className="h-3 w-px bg-white/[0.12]" /> : null}
          <span>{item}</span>
        </Fragment>
      ))}
    </div>
  );
}

function ProgressBar({ fraction, tone, thin = false }: { fraction: number | null; tone: "run" | "idle" | "stop"; thin?: boolean }) {
  const fill = tone === "run" ? "bg-osu-blue" : tone === "idle" ? "bg-osu-yellow/70" : "bg-osu-red-light/70";
  return (
    <div className={`flex-1 min-w-0 rounded-full bg-white/[0.07] overflow-hidden ${thin ? "h-1" : "h-1.5"}`}>
      {fraction != null ? (
        <div className={`h-full rounded-full ${fill}`} style={{ width: `${Math.max(fraction * 100, 0.5)}%` }} />
      ) : null}
    </div>
  );
}

function countsText(view: SweepView): string | null {
  if (view.done == null || view.total == null) {
    return view.sweep.chain ? `cursor ${formatNumber(view.sweep.chain.cursor)}` : null;
  }
  return `${formatNumber(view.done)} / ${formatNumber(view.total)}${view.unit ? ` ${view.unit}` : ""}`;
}

function RunningSweepRow({ view, now }: { view: SweepView; now: number }) {
  const { sweep, fraction, idle, idleMs, etaMs } = view;
  const chain = sweep.chain ?? null;
  const pass = passLabel(sweep);
  const startedMs = since(chain?.startedAt, now);
  const right = etaMs != null
    ? `${formatSweepDuration(etaMs)} left`
    : idle && idleMs != null
      ? `idle ${formatSweepDuration(idleMs)}`
      : chain && !chain.lastChunkAt
        ? "first chunk"
        : null;
  return (
    <div className="py-3.5 border-t border-white/[0.07] first:border-t-0">
      <div className="flex items-baseline gap-3 min-w-0">
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-white" title={sweep.description}>
          {sweep.label}
        </span>
        {pass ? <span className="flex-shrink-0 text-[11px] text-osu-f1">{pass}</span> : null}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <span className="w-[60px] flex-shrink-0 text-[20px] font-bold leading-none tabular-nums text-white">
          {fraction != null ? formatPercent(fraction) : "-"}
        </span>
        <ProgressBar fraction={fraction} tone={idle ? "idle" : "run"} />
        <span className={`w-[104px] flex-shrink-0 text-right text-[13px] tabular-nums ${idle ? "text-osu-yellow" : "text-osu-c2"}`}>
          {right ?? ""}
        </span>
      </div>
      <MetaLine
        items={[
          countsText(view),
          chain?.ratePerHour != null && chain.unit ? `${formatNumber(Math.round(chain.ratePerHour))} ${chain.unit} an hour` : null,
          chain && chain.ratePerHour == null && chain.chunksLastHour > 0 ? `${formatNumber(chain.chunksLastHour)} chunks in the last hour` : null,
          chain?.lastChunkAt && idleMs != null ? `last chunk ${formatSweepDuration(idleMs)} ago` : null,
          startedMs != null ? `started ${formatSweepDuration(startedMs)} ago` : null,
          sweep.kind === "recurring" ? "recurring" : null,
        ]}
      />
    </div>
  );
}

function StoppedSweepRow({ view, now }: { view: SweepView; now: number }) {
  const { sweep, fraction } = view;
  const stoppedMs = since(sweep.chain?.lastChunkAt ?? sweep.updatedAt, now);
  return (
    <div className="py-3 border-t border-white/[0.07] first:border-t-0">
      <div className="flex items-baseline gap-3 min-w-0">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white" title={sweep.description}>
          {sweep.label}
        </span>
        <span className="flex-shrink-0 text-[12px] text-osu-red-light tabular-nums">
          {sweep.status === "unknown" ? "unreadable" : stoppedMs != null ? `stopped ${formatSweepDuration(stoppedMs)} ago` : "stopped"}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <span className="w-[60px] flex-shrink-0 text-[15px] font-bold tabular-nums text-osu-c2">
          {fraction != null ? formatPercent(fraction) : "-"}
        </span>
        <ProgressBar fraction={fraction} tone="stop" thin />
      </div>
      <MetaLine items={[countsText(view), sweep.detail]} />
    </div>
  );
}

function WaitingSweepRow({ sweep }: { sweep: LiveBackendSweep }) {
  return (
    <div className="py-2 border-t border-white/[0.07] first:border-t-0 flex items-baseline gap-3 min-w-0">
      <span className="min-w-0 flex-1 truncate text-[13px] text-osu-l2" title={sweep.description}>{sweep.label}</span>
      <span className="flex-shrink-0 max-w-[55%] truncate text-[11px] text-osu-f1">{sweep.detail ?? "not started"}</span>
    </div>
  );
}

function FinishedSweepRow({ sweep, now }: { sweep: LiveBackendSweep; now: number }) {
  const agoMs = since(sweep.updatedAt, now);
  return (
    <div className="py-2 border-t border-white/[0.07] first:border-t-0 flex items-baseline gap-3 min-w-0">
      <span className="min-w-0 flex-1 truncate text-[13px] text-osu-l2" title={sweep.description}>{sweep.label}</span>
      {sweep.kind === "recurring" ? <span className="flex-shrink-0 text-[11px] text-osu-f1">recurring</span> : null}
      <span className="w-[88px] flex-shrink-0 text-right text-[11px] text-osu-f1 tabular-nums">
        {agoMs != null ? `${formatSweepDuration(agoMs)} ago` : "-"}
      </span>
    </div>
  );
}

function GroupHeading({ title, count, tone }: { title: string; count: number; tone?: "warn" }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={`text-[11px] font-semibold uppercase tracking-wider ${tone === "warn" ? "text-osu-red-light" : "text-osu-c2"}`}>{title}</span>
      <span className="text-[11px] text-osu-f1 tabular-nums">{count}</span>
    </div>
  );
}

function groupSweeps(sweeps: LiveBackendSweep[], now: number) {
  const running: SweepView[] = [];
  const stopped: SweepView[] = [];
  const waiting: LiveBackendSweep[] = [];
  const finished: LiveBackendSweep[] = [];
  for (const sweep of sweeps) {
    if (sweep.status === "running") running.push(viewSweep(sweep, now));
    else if (sweep.status === "stalled" || sweep.status === "unknown") stopped.push(viewSweep(sweep, now));
    else if (sweep.status === "pending") waiting.push(sweep);
    else finished.push(sweep);
  }
  // Moving chains first, nearest to done on top; idle ones after.
  running.sort((a, b) => Number(a.idle) - Number(b.idle) || (a.etaMs ?? Infinity) - (b.etaMs ?? Infinity));
  finished.sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0));
  return { running, stopped, waiting, finished };
}

function SweepsStatusNotice({ state }: { state: SweepsState }) {
  if (state.error) return <div className="text-[12px] text-osu-red-light">{state.error}</div>;
  if (state.unsupported) return <div className="text-[12px] text-osu-f1">The backend does not expose /api/admin/sweeps yet (deploy pending).</div>;
  return <div className="text-[12px] text-osu-f1 py-6 text-center">Loading sweeps...</div>;
}

export function SweepsMonitorPanel() {
  const state = useLiveBackendSweeps(SWEEPS_TAB_REFRESH_MS);
  const now = useNow();
  const [showFinished, setShowFinished] = useState(false);
  const groups = useMemo(() => (state.sweeps ? groupSweeps(state.sweeps, now) : null), [state.sweeps, now]);

  if (!groups || state.unsupported || (state.error && !state.sweeps)) return <SweepsStatusNotice state={state} />;

  return (
    <div className="space-y-7">
      {state.error ? <div className="text-[12px] text-osu-red-light">{state.error}</div> : null}
      <section className="space-y-1">
        <GroupHeading title="Running" count={groups.running.length} />
        {groups.running.length > 0 ? (
          <div>
            {groups.running.map((view) => <RunningSweepRow key={view.sweep.id} view={view} now={now} />)}
          </div>
        ) : (
          <div className="py-3 text-[13px] text-osu-f1">No sweeps running.</div>
        )}
      </section>

      {groups.stopped.length > 0 ? (
        <section className="space-y-1">
          <GroupHeading title="Stopped" count={groups.stopped.length} tone="warn" />
          <div>
            {groups.stopped.map((view) => <StoppedSweepRow key={view.sweep.id} view={view} now={now} />)}
          </div>
        </section>
      ) : null}

      {groups.waiting.length > 0 ? (
        <section className="space-y-1">
          <GroupHeading title="Waiting" count={groups.waiting.length} />
          <div>
            {groups.waiting.map((sweep) => <WaitingSweepRow key={sweep.id} sweep={sweep} />)}
          </div>
        </section>
      ) : null}

      <section className="space-y-1">
        <button
          type="button"
          onClick={() => setShowFinished((value) => !value)}
          className="flex items-center gap-1.5 cursor-pointer text-osu-c2 hover:text-white transition-colors duration-[120ms]"
          aria-expanded={showFinished}
        >
          {showFinished ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <GroupHeading title="Finished" count={groups.finished.length} />
        </button>
        {showFinished ? (
          <div>
            {groups.finished.map((sweep) => <FinishedSweepRow key={sweep.id} sweep={sweep} now={now} />)}
          </div>
        ) : null}
      </section>
    </div>
  );
}

/* Server-tab glance: what is running and how far along, one line each. */
export function SweepsSummary({ onOpen }: { onOpen: () => void }) {
  const state = useLiveBackendSweeps(SWEEPS_SUMMARY_REFRESH_MS);
  const now = useNow();
  const groups = useMemo(() => (state.sweeps ? groupSweeps(state.sweeps, now) : null), [state.sweeps, now]);
  if (!groups || state.unsupported || (state.error && !state.sweeps)) return <SweepsStatusNotice state={state} />;
  return (
    <div className="rounded-lg border border-osu-b3/30 bg-osu-b4/30 px-3 py-2.5 sm:px-4">
      {groups.running.length === 0 ? (
        <div className="py-1 text-[12px] text-osu-f1">No sweeps running.</div>
      ) : (
        groups.running.map((view) => (
          <div key={view.sweep.id} className="flex items-center gap-3 py-1.5 min-w-0">
            <span className="w-[38%] min-w-0 truncate text-[12px] text-osu-l2" title={view.sweep.description}>{view.sweep.label}</span>
            <ProgressBar fraction={view.fraction} tone={view.idle ? "idle" : "run"} thin />
            <span className="w-[44px] flex-shrink-0 text-right text-[12px] font-semibold tabular-nums text-white">
              {view.fraction != null ? formatPercent(view.fraction) : "-"}
            </span>
            <span className={`w-[72px] flex-shrink-0 text-right text-[11px] tabular-nums ${view.idle ? "text-osu-yellow" : "text-osu-f1"}`}>
              {view.etaMs != null ? formatSweepDuration(view.etaMs) : view.idle ? "idle" : ""}
            </span>
          </div>
        ))
      )}
      <div className="mt-1.5 pt-2 border-t border-white/[0.07] flex items-center gap-3 text-[11px]">
        {groups.stopped.length > 0 ? (
          <span className="text-osu-red-light">{groups.stopped.length} stopped</span>
        ) : null}
        <button
          type="button"
          onClick={onOpen}
          className="ml-auto cursor-pointer text-osu-c2 hover:text-white transition-colors duration-[120ms]"
        >
          Open sweeps
        </button>
      </div>
    </div>
  );
}
