import { useMemo, useState, type ReactNode } from "react";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";

import { PageHeader } from "#/components/layout/PageHeader";
import { Empty, Panel } from "#/components/companella/primitives";
import { SegmentedControl } from "#/components/ui/SegmentedControl";
import {
  COMPANELLA_USAGE_WINDOWS,
  fetchCompanellaUsage,
  fetchCompanellaUsagePlayers,
  type CompanellaUsageDay,
  type CompanellaUsagePlayer,
  type CompanellaUsageWindow,
} from "#/lib/companella-usage";
import { formatNumber, formatTimeAgo } from "#/lib/format";

/*
 * /companella/usage: how much the Companella app is used, for the site admins
 * and Companella's developer (the list is in lib/companella-usage.ts; anyone
 * else gets a 404). Counts only Companella's own client id, never Mania
 * Bridge, and names no player. English only, like /companella/docs.
 */

export const Route = createFileRoute("/companella_/usage")({
  validateSearch: (search: Record<string, unknown>): { days?: CompanellaUsageWindow } => {
    const days = Number(search.days);
    return { days: days !== 30 && (COMPANELLA_USAGE_WINDOWS as readonly number[]).includes(days) ? days as CompanellaUsageWindow : undefined };
  },
  loaderDeps: ({ search }) => ({ days: search.days ?? 30 }),
  loader: async ({ deps }) => {
    const [usage, players] = await Promise.all([
      fetchCompanellaUsage({ data: { days: deps.days } }),
      fetchCompanellaUsagePlayers({ data: { days: deps.days } }),
    ]);
    if (!usage || !players) throw notFound();
    return { ...usage, players: players.players, dailyPlayers: players.daily };
  },
  head: () => ({
    meta: [
      { title: "Companella usage" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: CompanellaUsagePage,
});

const WINDOW_OPTIONS = COMPANELLA_USAGE_WINDOWS.map((days) => ({ value: String(days), label: `${days} days` }));

const STATE_LABELS: Record<string, string> = {
  rejected: "Rejected",
  expired: "Never finished uploading",
  deleted: "Deleted by the player",
  awaiting_assets: "Waiting for files",
  queued: "Queued",
  validating: "Validating",
  analyzing: "Analyzing",
  deferred: "Retrying",
};

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "-";
}

function formatSeconds(seconds: number | null): string {
  if (seconds == null) return "-";
  return seconds < 90 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)}s` : `${(seconds / 60).toFixed(1)}m`;
}

function formatDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function CompanellaUsagePage() {
  const usage = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const { window: span, allTime } = usage;

  return (
    <div className="flex-1 bg-osu-b5">
      <PageHeader iconSrc="/images/icons/home.svg" title="Companella usage" />
      <div className="mx-auto max-w-[1200px] px-3 py-4 sm:px-5 sm:py-6">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <SegmentedControl
            id="companella-usage-window"
            value={String(usage.days)}
            options={WINDOW_OPTIONS}
            onChange={(value) => void navigate({ search: { days: value === "30" ? undefined : Number(value) as CompanellaUsageWindow }, replace: true })}
          />
          <span className="ml-auto text-[11px] text-osu-f1">
            Updated {new Date(usage.generatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
          <Stat label="Players sending plays" value={formatNumber(span.players)} detail={`${formatNumber(span.newPlayers)} connected for the first time`} />
          <Stat label="Plays sent" value={formatNumber(span.received)} detail={`${formatNumber(span.inProgress)} still processing`} />
          <Stat label="Accepted" value={percent(span.accepted, span.received)} detail={`${formatNumber(span.accepted)} plays, ${formatNumber(span.held)} held for review`} />
          <Stat label="Connections" value={formatNumber(span.newConnections)} detail={`new, ${formatNumber(span.revokedConnections)} disconnected`} />
        </div>
        <p className="mt-4 text-[11px] text-osu-f1">
          All time: {formatNumber(allTime.players)} players, {formatNumber(allTime.connections)} connections ({formatNumber(allTime.activeConnections)} active), {formatNumber(allTime.acceptedPlays)} accepted plays
        </p>

        <div className="mt-8 space-y-8">
          <Panel title="Plays sent per day">
            <DailyChart days={usage.daily} players={usage.players} dailyPlayers={usage.dailyPlayers} />
          </Panel>

          <div className="grid gap-8 lg:grid-cols-2">
            <div className="lg:col-span-2">
              <Panel title="Client versions">
                <UsageTable
                  empty="No plays in this window."
                  head={["Version", "Players", "Sent", "Accepted"]}
                  rows={usage.versions.map((row) => [
                    <span key="v" className="font-mono text-[12px]">{row.version}</span>,
                    formatNumber(row.players),
                    formatNumber(row.received),
                    percent(row.accepted, row.received),
                  ])}
                />
              </Panel>
            </div>
            <Panel title="Plays not accepted">
              <UsageTable
                empty="Every play sent in this window was accepted."
                head={["Outcome", "Error code", "Plays"]}
                rows={usage.outcomes.map((row) => [
                  STATE_LABELS[row.state] ?? row.state,
                  <span key="c" className="font-mono text-[12px]">{row.errorCode ?? "-"}</span>,
                  formatNumber(row.count),
                ])}
              />
            </Panel>
            <Panel title="Processing time">
              <UsageTable
                empty="No accepted plays in this window."
                head={["From reservation to accepted", "Time"]}
                rows={usage.processing.count > 0 ? [
                  ["Median", formatSeconds(usage.processing.p50Seconds)],
                  ["95th percentile", formatSeconds(usage.processing.p95Seconds)],
                ] : []}
              />
            </Panel>
          </div>

          <Panel title={`Players (${formatNumber(usage.players.length)})`}>
            <PlayerList players={usage.players} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

function PlayerList({ players }: { players: CompanellaUsagePlayer[] }) {
  if (!players.length) return <Empty>Nobody has connected Companella yet.</Empty>;
  return (
    <div className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
      {players.map((player) => (
        <div key={player.userId} className="flex items-center gap-3 border-t border-white/[0.07] py-2.5">
          {player.avatarUrl ? (
            <img src={player.avatarUrl} alt="" className="h-9 w-9 flex-shrink-0 rounded-full object-cover" />
          ) : (
            <span className="block h-9 w-9 flex-shrink-0 rounded-full bg-osu-b4" />
          )}
          <div className="min-w-0 flex-1">
            <Link
              to="/player/$username"
              params={{ username: String(player.userId) }}
              className="block truncate text-[14px] font-semibold text-white hover:text-osu-pink-light"
            >
              {player.username}
            </Link>
            <div className="text-[11px] text-osu-f1">
              {formatNumber(player.plays)} {player.plays === 1 ? "play" : "plays"}
              {player.lastPlayAt ? `, last played ${formatTimeAgo(player.lastPlayAt)}` : ""}
              {player.connected ? "" : ", disconnected"}
            </div>
          </div>
          <span className="flex-shrink-0 text-[11px] text-osu-f1" title="Connected">
            {formatDay(player.connectedAt.slice(0, 10))}
          </span>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-f1">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums text-white">{value}</div>
      <div className="mt-0.5 text-[11px] text-osu-f1">{detail}</div>
    </div>
  );
}

function UsageTable({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-[11px] uppercase tracking-wider text-osu-f1">
          {head.map((cell, index) => (
            <th key={cell} className={`pb-2 font-semibold ${index > 0 ? "text-right" : ""}`}>{cell}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex} className="border-t border-white/[0.07]">
            {row.map((cell, index) => (
              <td key={index} className={`py-1.5 text-white ${index > 0 ? "text-right tabular-nums" : ""}`}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const TOOLTIP_PLAYERS = 8;

/* One bar per UTC day, with the day's numbers and players on hover. */
function DailyChart({
  days,
  players,
  dailyPlayers,
}: {
  days: CompanellaUsageDay[];
  players: CompanellaUsagePlayer[];
  dailyPlayers: Record<string, number[]>;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const byId = useMemo(() => new Map(players.map((player) => [player.userId, player])), [players]);
  const max = Math.max(1, ...days.map((day) => day.received));
  const active = hovered == null ? null : days[hovered];

  return (
    <div>
      <div className="relative h-44">
        <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-white/[0.07]" />
        <span className="pointer-events-none absolute -top-2 left-0 bg-osu-b5 pr-1 text-[11px] tabular-nums text-osu-f1">{formatNumber(max)}</span>
        <div className="absolute inset-0 flex items-end gap-[2px]" onMouseLeave={() => setHovered(null)}>
          {days.map((day, index) => (
            <div
              key={day.date}
              className="flex h-full min-w-0 flex-1 items-end"
              onMouseEnter={() => setHovered(index)}
            >
              <div
                className={`w-full rounded-t ${day.received > 0 ? "bg-osu-pink" : ""} ${hovered === index ? "brightness-125" : ""}`}
                style={{ height: day.received > 0 ? `${Math.max(2, (day.received / max) * 100)}%` : 0 }}
              />
            </div>
          ))}
        </div>
        {active && hovered != null ? (
          <div
            className="pointer-events-none absolute top-2 z-10 w-52 rounded-md bg-osu-b3 px-3 py-2 text-[12px] shadow-lg"
            style={hovered < days.length / 2
              ? { left: `${((hovered + 1) / days.length) * 100}%` }
              : { right: `${((days.length - hovered) / days.length) * 100}%` }}
          >
            <div className="mb-1 font-semibold text-white">{formatDay(active.date)}</div>
            <TooltipRow label="Sent" value={active.received} />
            <TooltipRow label="Accepted" value={active.accepted} />
            <TooltipRow label="Players" value={active.players} />
            <TooltipRow label="New connections" value={active.newConnections} />
            <DayPlayers ids={dailyPlayers[active.date] ?? []} byId={byId} />
          </div>
        ) : null}
      </div>
      <div className="mt-2 flex justify-between border-t border-white/[0.07] pt-1.5 text-[11px] text-osu-f1">
        <span>{days.length ? formatDay(days[0].date) : ""}</span>
        <span>{days.length ? formatDay(days[days.length - 1].date) : ""}</span>
      </div>
    </div>
  );
}

function DayPlayers({ ids, byId }: { ids: number[]; byId: Map<number, CompanellaUsagePlayer> }) {
  if (!ids.length) return null;
  const shown = ids.slice(0, TOOLTIP_PLAYERS);
  return (
    <div className="mt-2 space-y-1 border-t border-white/[0.07] pt-2">
      {shown.map((id) => {
        const player = byId.get(id);
        return (
          <div key={id} className="flex items-center gap-2">
            {player?.avatarUrl ? (
              <img src={player.avatarUrl} alt="" className="h-5 w-5 flex-shrink-0 rounded-full object-cover" />
            ) : (
              <span className="block h-5 w-5 flex-shrink-0 rounded-full bg-osu-b4" />
            )}
            <span className="truncate text-white">{player?.username ?? `#${id}`}</span>
          </div>
        );
      })}
      {ids.length > shown.length ? <div className="text-osu-f1">+{formatNumber(ids.length - shown.length)} more</div> : null}
    </div>
  );
}

function TooltipRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between gap-3 text-osu-f1">
      <span>{label}</span>
      <span className="tabular-nums text-white">{formatNumber(value)}</span>
    </div>
  );
}
