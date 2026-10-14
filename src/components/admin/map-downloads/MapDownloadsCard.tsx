import { useEffect, useState } from "react";
import { formatBytes, formatNumber } from "../../../lib/format";
import {
  fetchLiveBackendMapDownloads,
  type LiveBackendMapDownloads,
  type LiveBackendMirrorHealth,
  type LiveBackendOsuDirectBudget,
} from "../../../lib/live-backend";
import { SectionCard } from "../SectionCard";

/*
 * Where beatmap archives (songs, hitsounds, storyboards, .osu files) come
 * from, and whether they still can. The failure this exists for: osu.direct's
 * per-IP daily budget ran out and every graveyard song went silent with
 * nothing on this page saying why.
 */

const REFRESH_MS = 30_000;
const WARN_SHARE = 0.8;

type Tone = { text: string; fill: string };
const TONE_OK: Tone = { text: "text-osu-green", fill: "bg-osu-green" };
const TONE_WARN: Tone = { text: "text-osu-yellow", fill: "bg-osu-yellow" };
const TONE_BAD: Tone = { text: "text-osu-red", fill: "bg-osu-red" };

function shareTone(used: number, limit: number): Tone {
  if (limit <= 0) return TONE_OK;
  const share = used / limit;
  return share >= 1 ? TONE_BAD : share >= WARN_SHARE ? TONE_WARN : TONE_OK;
}

function formatIn(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`;
}

function formatAgo(atMs: number, now: number): string {
  const secs = Math.max(0, Math.round((now - atMs) / 1000));
  if (secs < 60) return `${secs}s ago`;
  return `${formatIn(now - atMs)} ago`;
}

function BudgetMeter({ budget, inUse, now }: { budget: LiveBackendOsuDirectBudget; inUse: boolean; now: number }) {
  const label = `IPv${budget.family}${inUse ? " (what the backend uses)" : ""}`;
  if (budget.error || !budget.daily) {
    return (
      <div className="rounded-md border border-osu-b3/25 bg-osu-b5/50 px-3 py-2.5 text-[11px]">
        <div className="font-semibold text-osu-c2">{label}</div>
        <div className="mt-1 text-osu-f1">Could not read the budget: {budget.error ?? "no daily figures in the reply"}</div>
      </div>
    );
  }
  const { usedBytes, limitBytes, resetAt } = budget.daily;
  const tone = shareTone(usedBytes, limitBytes);
  return (
    <div className="rounded-md border border-osu-b3/25 bg-osu-b5/50 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[11px] font-semibold text-osu-c2">{label}</span>
        <span className={`text-lg font-bold leading-none ${tone.text}`}>{formatBytes(Math.min(usedBytes, limitBytes))}</span>
        <span className="text-[11px] text-osu-f1">of {formatBytes(limitBytes)} today</span>
        <span className={`ml-auto text-[11px] font-semibold ${tone.text}`}>
          {usedBytes >= limitBytes ? "Used up" : `${formatBytes(Math.max(0, limitBytes - usedBytes))} left`}
        </span>
      </div>
      <div className="relative mt-2 h-2 rounded-full bg-osu-b4/70 overflow-hidden">
        <div className={`absolute inset-y-0 left-0 rounded-full ${tone.fill}`} style={{ width: `${Math.min(100, limitBytes > 0 ? (usedBytes / limitBytes) * 100 : 0)}%` }} />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-osu-f1">
        {budget.hourly ? <span>{formatNumber(budget.hourly.used)}/{formatNumber(budget.hourly.limit)} downloads this hour</span> : null}
        {resetAt ? <span>Resets in {formatIn(resetAt - now)}</span> : null}
        {budget.ip ? <span className="font-mono">{budget.ip}</span> : null}
      </div>
    </div>
  );
}

function MirrorRow({ mirror, now }: { mirror: LiveBackendMirrorHealth; now: number }) {
  const cooling = mirror.cooldowns.filter((cooldown) => cooldown.untilMs > now);
  const attempts24h = mirror.served24h + mirror.failed24h;
  const state = cooling.length > 0
    ? { label: "Cooling down", tone: TONE_BAD }
    : attempts24h === 0
      ? { label: "Unused", tone: { text: "text-osu-f1", fill: "" } }
      : mirror.served1h > 0
        ? { label: "Serving", tone: TONE_OK }
        : mirror.failed1h > 0
          ? { label: "Failing", tone: TONE_WARN }
          : { label: "Idle", tone: { text: "text-osu-f1", fill: "" } };
  return (
    <tr className="border-t border-osu-b3/15 align-top">
      <td className="py-1.5 pr-3 font-semibold text-osu-l2">{mirror.source}</td>
      <td className={`py-1.5 pr-3 font-semibold ${state.tone.text}`}>
        {state.label}
        {cooling.map((cooldown) => (
          <div key={cooldown.role} className="font-normal text-[10px] text-osu-f1">
            {cooldown.role} for {formatIn(cooldown.untilMs - now)}{cooldown.reason ? `: ${cooldown.reason}` : ""}
          </div>
        ))}
      </td>
      <td className="py-1.5 pr-3 font-mono text-osu-c2 whitespace-nowrap">{formatNumber(mirror.served1h)} / {formatNumber(mirror.failed1h)}</td>
      <td className="py-1.5 pr-3 font-mono text-osu-c2 whitespace-nowrap">{formatNumber(mirror.served24h)} / {formatNumber(mirror.failed24h)}</td>
      <td className="py-1.5 text-[10px] text-osu-f1 break-words">
        {mirror.lastFailure ? `${formatAgo(mirror.lastFailure.atMs, now)} (${mirror.lastFailure.role}): ${mirror.lastFailure.detail ?? "unknown"}` : "None in 24h"}
      </td>
    </tr>
  );
}

export function MapDownloadsCard() {
  const [report, setReport] = useState<LiveBackendMapDownloads | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await fetchLiveBackendMapDownloads();
        if (cancelled) return;
        if (result === null) setUnsupported(true);
        else setReport(result);
        setError(null);
        setNow(Date.now());
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (unsupported) {
    return (
      <SectionCard title="Map downloads">
        <div className="text-[11px] text-osu-f1">The live backend does not serve this report yet (deploy it to see mirror health).</div>
      </SectionCard>
    );
  }

  const lane = report?.osuFileLane;
  const laneTone = lane ? shareTone(lane.usedLastMinute, lane.targetPerMinute) : TONE_OK;
  const failures = report?.songFailures;

  return (
    <SectionCard
      title="Map downloads"
      subtitle="Beatmap archives come from mirrors: osu.direct (per-IP daily budget, kept for audio), then hinai, nekoha, sayobot and the fallbacks. .osu files come from osu! on their own lane."
    >
      {error ? <div className="mb-2 text-[11px] text-osu-red">{error}</div> : null}
      {!report ? (
        <div className="text-[11px] text-osu-f1">Loading…</div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {report.osuDirect.budgets.map((budget) => (
              <BudgetMeter key={budget.family} budget={budget} inUse={budget.family === report.osuDirect.defaultFamily} now={now} />
            ))}
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="rounded-md border border-osu-b3/25 bg-osu-b5/50 px-3 py-2.5">
              <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Songs no mirror could serve</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className={`text-lg font-bold leading-none ${failures && failures.last1h > 0 ? "text-osu-red" : "text-osu-green"}`}>{formatNumber(failures?.last1h ?? 0)}</span>
                <span className="text-[11px] text-osu-f1">last hour, {formatNumber(failures?.last24h ?? 0)} in 24h</span>
              </div>
            </div>
            <div className="rounded-md border border-osu-b3/25 bg-osu-b5/50 px-3 py-2.5">
              <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">.osu downloads from osu! (own lane, no API quota)</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className={`text-lg font-bold leading-none ${laneTone.text}`}>{formatNumber(lane?.usedLastMinute ?? 0)}</span>
                <span className="text-[11px] text-osu-f1">
                  last minute, paced {formatNumber(lane?.targetPerMinute ?? 0)}/min, ceiling {formatNumber(lane?.hardPerMinute ?? 0)}; {formatNumber(lane?.calls24h ?? 0)} in 24h
                  {lane && lane.failed24h > 0 ? `, ${formatNumber(lane.failed24h)} failed` : ""}
                </span>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto rounded-md border border-osu-b3/25 bg-osu-b5/40 px-3 py-2">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-[9px] uppercase tracking-wider text-osu-f1">
                  <th className="pb-1 pr-3 font-semibold">Mirror</th>
                  <th className="pb-1 pr-3 font-semibold">State</th>
                  <th className="pb-1 pr-3 font-semibold">1h ok / fail</th>
                  <th className="pb-1 pr-3 font-semibold">24h ok / fail</th>
                  <th className="pb-1 font-semibold">Last failure</th>
                </tr>
              </thead>
              <tbody>
                {report.mirrors.map((mirror) => <MirrorRow key={mirror.source} mirror={mirror} now={now} />)}
              </tbody>
            </table>
            <div className="mt-1.5 text-[10px] text-osu-f1">
              A failure is one attempt (a 404 just means that mirror does not carry the set); a song is only lost when every mirror fails.
            </div>
          </div>

          {failures && failures.recent.length > 0 ? (
            <div className="rounded-md border border-osu-b3/25 bg-osu-b5/40 px-3 py-2">
              <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">Latest songs lost</div>
              <ul className="mt-1 space-y-0.5 text-[10px]">
                {failures.recent.map((entry) => (
                  <li key={`${entry.atMs}:${entry.beatmapsetId}`} className="flex gap-2">
                    <span className="text-osu-f1 whitespace-nowrap">{formatAgo(entry.atMs, now)}</span>
                    {entry.beatmapsetId ? (
                      <a className="font-mono text-osu-l2 hover:underline" href={`https://osu.ppy.sh/beatmapsets/${entry.beatmapsetId}`} target="_blank" rel="noreferrer">
                        {entry.beatmapsetId}
                      </a>
                    ) : null}
                    <span className="text-osu-f1 truncate" title={entry.detail ?? undefined}>{entry.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}
