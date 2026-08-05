import { memo, useState } from "react";
import { CountryFlag } from "../../ui/CountryFlag";
import { SectionCard } from "../SectionCard";
import { getCountryName } from "../../../lib/country";
import { formatNumber } from "../../../lib/format";
import { analyticsInspectionHref, formatReferrerLabel } from "../../../lib/analytics-feed";
import {
  formatAnalyticsRangeLabel,
  type AnalyticsCountryRow,
  type AnalyticsMonitorData,
  type AnalyticsRange,
  type AnalyticsRecentServerErrorRow,
  type AnalyticsReferrerRow,
  type AnalyticsServerErrorRow,
  type AnalyticsSharePlatformRow,
  type AnalyticsSharedPageRow,
  type AnalyticsTopProfileRow,
  type AnalyticsTopReplayRow,
  type AnalyticsTopRouteRow,
} from "../../../lib/analytics-monitor";
import { AnalyticsViewersCard } from "./AnalyticsViewersCard";
import { AnalyticsEmptyMessage, InlineCountryFlag } from "./shared";

/* The aggregate half of the analytics tab: what the range added up to, once the
   live feed has stopped being the interesting part. */

export const AnalyticsInsights = memo(function AnalyticsInsights({
  data,
  range,
}: {
  data: AnalyticsMonitorData;
  range: AnalyticsRange;
}) {
  return (
    <div className="space-y-4">
      <AnalyticsViewersCard />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="flex lg:col-span-3">
          <TopReplaysCard rows={data.topReplays} range={range} />
        </div>
        <div className="flex lg:col-span-2">
          <TopProfilesCard rows={data.topProfiles} range={range} />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <CountriesCard rows={data.topPhysicalCountries} range={range} />
        <ReferrersCard rows={data.topReferrers} range={range} />
        <TopRoutesCard rows={data.topRoutes} range={range} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SharesCard rows={data.sharesByPlatform} total={data.shareEvents} range={range} />
        <TopSharedPagesCard rows={data.topSharedPages} range={range} />
      </div>
      <ServerErrorsCard rows={data.serverErrors} recent={data.recentServerErrors} range={range} />
    </div>
  );
});

/* Every list in here is the same shape: a label, a count, and a bar behind the
   row sized against the biggest value in the list. The bar is the only frame a
   row gets - a border around each one on top of the card's own border read as
   boxes inside boxes. */
function BarRow({
  children,
  pct,
  gradient,
  className = "",
}: {
  children: React.ReactNode;
  pct: number;
  gradient: string;
  className?: string;
}) {
  return (
    <div className={`relative overflow-hidden rounded-lg bg-osu-b5/50 ${className}`}>
      <div className={`absolute inset-y-0 left-0 ${gradient}`} style={{ width: `${pct}%` }} />
      <div className="relative">{children}</div>
    </div>
  );
}

function barPct(value: number, max: number): number {
  return Math.max(3, Math.round((value / max) * 100));
}

/* The number a row is ranked by. Bigger than the label it sits next to: the
   count is the thing being read down the column. */
function BarCount({ value }: { value: number }) {
  return <span className="flex-shrink-0 text-[13px] font-bold tabular-nums text-white">{formatNumber(value)}</span>;
}

function TopRoutesCard({ rows, range }: { rows: AnalyticsTopRouteRow[]; range: AnalyticsRange }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <SectionCard title="Top routes" subtitle={`pageviews, ${formatAnalyticsRangeLabel(range).toLowerCase()}`}>
      {rows.length === 0 ? (
        <AnalyticsEmptyMessage text="No pageviews captured yet." />
      ) : (
        <div className="space-y-1">
          {rows.map((row) => (
            <BarRow key={row.path} pct={barPct(row.count, max)} gradient="bg-gradient-to-r from-osu-pink/25 to-transparent">
              <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span className="truncate font-mono text-[12px] text-osu-c2">{row.path || "(unknown)"}</span>
                <BarCount value={row.count} />
              </div>
            </BarRow>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function CountriesCard({ rows, range }: { rows: AnalyticsCountryRow[]; range: AnalyticsRange }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <SectionCard title="Where they are" subtitle={`unique visitors by country, ${formatAnalyticsRangeLabel(range).toLowerCase()}`}>
      {rows.length === 0 ? (
        <AnalyticsEmptyMessage text="No country data yet." />
      ) : (
        <div className="space-y-1">
          {rows.map((row) => {
            const code = row.country.toUpperCase();
            return (
              <BarRow key={code} pct={barPct(row.count, max)} gradient="bg-gradient-to-r from-osu-blue/20 to-transparent">
                <div className="flex items-center gap-2.5 px-3 py-2.5">
                  <CountryFlag code={code} size="sm" />
                  <span className="flex-1 truncate text-[12px] text-osu-c2">{getCountryName(code) || code}</span>
                  <BarCount value={row.count} />
                </div>
              </BarRow>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function TopProfilesCard({ rows, range }: { rows: AnalyticsTopProfileRow[]; range: AnalyticsRange }) {
  const max = Math.max(1, ...rows.map((row) => row.views));
  return (
    <SectionCard title="Most viewed players" subtitle={formatAnalyticsRangeLabel(range).toLowerCase()}>
      {rows.length === 0 ? (
        <AnalyticsEmptyMessage text="No profile visits yet." />
      ) : (
        <div className="space-y-1">
          {rows.map((row) => (
            <a
              key={row.username}
              href={analyticsInspectionHref(`/player/${encodeURIComponent(row.username)}`)}
              target="_blank"
              rel="noreferrer"
              className="group block cursor-pointer"
            >
              <BarRow
                pct={barPct(row.views, max)}
                gradient="bg-gradient-to-r from-osu-purple/20 to-transparent"
                className="transition-colors duration-[100ms] group-hover:bg-osu-b3/40"
              >
                <div className="flex items-center justify-between gap-3 px-3 py-2">
                  {/* The name gets its own line: sharing one with "last visited"
                      truncated both on a phone. */}
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-[13px] font-medium text-white group-hover:underline">{row.username}</span>
                    {row.lastViewedLabel ? (
                      <span className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-osu-f1">
                        last visited {row.lastViewedLabel} <InlineCountryFlag country={row.lastVisitorCountry} />
                      </span>
                    ) : null}
                  </span>
                  <BarCount value={row.views} />
                </div>
              </BarRow>
            </a>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function TopReplaysCard({ rows, range }: { rows: AnalyticsTopReplayRow[]; range: AnalyticsRange }) {
  const max = Math.max(1, ...rows.map((row) => row.views));
  return (
    <SectionCard title="Most watched replays" subtitle={`each replay open, ${formatAnalyticsRangeLabel(range).toLowerCase()}`}>
      {rows.length === 0 ? (
        <AnalyticsEmptyMessage text="No replays opened yet." />
      ) : (
        <div className="space-y-1">
          {rows.map((row) => {
            const primary = row.title && row.artist
              ? `${row.artist} - ${row.title}`
              : row.title ?? `#${row.scoreId.slice(-6)}`;
            return (
              <a
                key={row.scoreId}
                href={analyticsInspectionHref(`/replay?scoreId=${encodeURIComponent(row.scoreId)}`)}
                target="_blank"
                rel="noreferrer"
                className="group block cursor-pointer"
              >
                <BarRow
                  pct={barPct(row.views, max)}
                  gradient="bg-gradient-to-r from-osu-yellow/20 to-transparent"
                  className="transition-colors duration-[100ms] group-hover:bg-osu-b3/40"
                >
                  <div className="flex min-w-0 items-center gap-2.5 p-2">
                    {row.coverUrl ? (
                      <img src={row.coverUrl} alt="" className="h-[38px] w-[62px] flex-shrink-0 rounded object-cover" loading="lazy" />
                    ) : (
                      <div className="h-[38px] w-[62px] flex-shrink-0 rounded bg-osu-b3/30" />
                    )}
                    <div className="min-w-0 flex-1 leading-tight">
                      <div className="truncate text-[13px] font-medium text-white group-hover:underline">{primary}</div>
                      {/* Difficulty and player first, when the map ran out of
                          room the tail is the part worth losing. */}
                      <div className="mt-1 flex min-w-0 items-center gap-1 truncate text-[11px] text-osu-f1">
                        {row.difficulty ? <span className="truncate text-osu-c2">[{row.difficulty}]</span> : null}
                        {row.difficulty && (row.player || row.lastViewedLabel) ? <span>·</span> : null}
                        {row.player ? <span className="truncate">{row.player}</span> : null}
                        {row.player && row.lastViewedLabel ? <span className="hidden sm:inline">·</span> : null}
                        {row.lastViewedLabel ? (
                          <>
                            <span className="hidden flex-shrink-0 sm:inline">last watched {row.lastViewedLabel}</span>
                            <span className="hidden sm:inline"><InlineCountryFlag country={row.lastVisitorCountry} /></span>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <span className="flex-shrink-0 pr-1 text-[14px] font-bold tabular-nums text-white">{formatNumber(row.views)}</span>
                  </div>
                </BarRow>
              </a>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function ReferrersCard({ rows, range }: { rows: AnalyticsReferrerRow[]; range: AnalyticsRange }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <SectionCard title="How they got here" subtitle={`unique visitors by referrer, ${formatAnalyticsRangeLabel(range).toLowerCase()}`}>
      {rows.length === 0 ? (
        <AnalyticsEmptyMessage text="No external referrers captured yet." />
      ) : (
        <div className="space-y-1">
          {rows.map((row) => {
            const isDirect = row.domain === "$direct";
            return (
              <BarRow
                key={row.domain}
                pct={barPct(row.count, max)}
                gradient="bg-gradient-to-r from-osu-green-light/20 to-transparent"
              >
                <div className="flex items-center justify-between gap-3 px-3 py-2.5" title={isDirect ? "" : row.domain}>
                  <span className={`truncate text-[12px] ${isDirect ? "italic text-osu-f1" : "text-osu-c2"}`}>
                    {formatReferrerLabel(row.domain)}
                  </span>
                  <BarCount value={row.count} />
                </div>
              </BarRow>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

const SHARE_PLATFORM_LABELS: Record<string, string> = {
  discord: "Discord",
  twitter: "Twitter / X",
  facebook: "Facebook / iMessage",
  slack: "Slack",
  telegram: "Telegram",
  reddit: "Reddit",
  whatsapp: "WhatsApp",
  linkedin: "LinkedIn",
  pinterest: "Pinterest",
  skype: "Skype",
  vk: "VK",
  mastodon: "Mastodon",
  bluesky: "Bluesky",
  embedly: "Embedly",
  iframely: "Iframely",
};

// A shared link's HTML page fetch by an unfurl bot (Discordbot, Twitterbot,
// facebookexternalhit, ...). Captured in src/start.ts as `page_shared`. Counts
// share intent, not reach: one unfurl in a big server looks like one DM.
function SharesCard({
  rows,
  total,
  range,
}: {
  rows: AnalyticsSharePlatformRow[];
  total: number;
  range: AnalyticsRange;
}) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <SectionCard
      title="Link-preview shares"
      subtitle={`${formatNumber(total)} unfurl${total === 1 ? "" : "s"} by platform, ${formatAnalyticsRangeLabel(range).toLowerCase()}`}
    >
      {rows.length === 0 ? (
        <AnalyticsEmptyMessage text="No shares detected yet." />
      ) : (
        <div className="space-y-1">
          {rows.map((row) => (
            <BarRow key={row.platform} pct={barPct(row.count, max)} gradient="bg-gradient-to-r from-osu-pink/25 to-transparent">
              <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span className="truncate text-[12px] text-osu-c2">{SHARE_PLATFORM_LABELS[row.platform] ?? row.platform}</span>
                <BarCount value={row.count} />
              </div>
            </BarRow>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

const SHARE_SURFACE_LABELS: Record<string, string> = {
  home: "Home",
  player: "Player",
  replay: "Replay",
  rankings: "Rankings",
  maps: "Maps",
  tracker: "Tracker",
  "top-plays": "Top plays",
  snipes: "Snipes",
  "farm-helper": "Farm helper",
  goals: "Goals",
  packs: "Packs",
  skins: "Skins",
  bbcode: "BBCode",
  other: "Page",
};

function sharedPagePrimary(row: AnalyticsSharedPageRow): string {
  const surface = SHARE_SURFACE_LABELS[row.subjectType ?? "other"] ?? "Page";
  if (row.subject && (row.subjectType === "player" || row.subjectType === "replay")) {
    return row.subjectType === "replay" ? `${surface} · #${row.subject}` : `${surface} · ${row.subject}`;
  }
  return surface;
}

function TopSharedPagesCard({ rows, range }: { rows: AnalyticsSharedPageRow[]; range: AnalyticsRange }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <SectionCard title="Most shared pages" subtitle={`by unfurl count, ${formatAnalyticsRangeLabel(range).toLowerCase()}`}>
      {rows.length === 0 ? (
        <AnalyticsEmptyMessage text="No shared pages yet." />
      ) : (
        <div className="space-y-1">
          {rows.map((row, index) => {
            const secondary = row.subjectType === "replay" && row.subject
              ? `/replay?scoreId=${row.subject}`
              : row.path || "(unknown)";
            return (
              <BarRow
                key={`${row.path}-${row.subject ?? ""}-${index}`}
                pct={barPct(row.count, max)}
                gradient="bg-gradient-to-r from-osu-purple/20 to-transparent"
              >
                <div className="flex min-w-0 items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1 leading-tight">
                    <div className="truncate text-[13px] font-medium text-white">{sharedPagePrimary(row)}</div>
                    <div className="mt-1 truncate font-mono text-[11px] text-osu-f1">{secondary}</div>
                  </div>
                  <BarCount value={row.count} />
                </div>
              </BarRow>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function statusColorClass(status: number | null): string {
  if (status == null || status >= 500) return "text-osu-red-light";
  if (status === 429) return "text-osu-yellow";
  if (status === 401 || status === 403) return "text-osu-pink-light";
  if (status === 404) return "text-osu-l2";
  return "text-osu-c2";
}

function formatRateLimitContext(row: AnalyticsRecentServerErrorRow): string | null {
  const parts: string[] = [];
  if (row.ratePerMin != null && Number.isFinite(row.ratePerMin)) {
    parts.push(`${formatNumber(row.ratePerMin)}/min`);
  }
  if (row.rateRemaining != null && Number.isFinite(row.rateRemaining) && row.rateLimit != null && Number.isFinite(row.rateLimit)) {
    parts.push(`${formatNumber(row.rateRemaining)}/${formatNumber(row.rateLimit)} left`);
  }
  if (row.retryAfter) parts.push(`retry-after ${row.retryAfter}s`);
  return parts.length ? parts.join(" · ") : null;
}

function ServerErrorsCard({
  rows,
  recent,
  range,
}: {
  rows: AnalyticsServerErrorRow[];
  recent: AnalyticsRecentServerErrorRow[];
  range: AnalyticsRange;
}) {
  const [showRecentLog, setShowRecentLog] = useState(false);
  const total = rows.reduce((acc, row) => acc + row.count, 0);
  const callerCounts = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.caller] = (acc[row.caller] ?? 0) + row.count;
    return acc;
  }, {});
  const callerSummary = Object.entries(callerCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4)
    .map(([caller, count]) => `${caller}x${count}`)
    .join("  ");

  return (
    <SectionCard
      title="Server errors"
      subtitle={`osu! API failures, ${formatAnalyticsRangeLabel(range).toLowerCase()}`}
      actions={recent.length > 0 ? (
        <button
          type="button"
          onClick={() => setShowRecentLog((value) => !value)}
          className="h-7 cursor-pointer rounded-md border border-osu-b3/30 bg-osu-b5/70 px-2.5 text-[11px] font-semibold text-osu-c2 transition-colors duration-[120ms] hover:border-osu-red/35 hover:bg-osu-b3/50 hover:text-white"
          title={showRecentLog ? "Hide detailed recent errors" : "Show detailed recent errors"}
        >
          {showRecentLog ? "Hide log" : "Show log"}
        </button>
      ) : null}
    >
      {rows.length === 0 && recent.length === 0 ? (
        <AnalyticsEmptyMessage text="No server errors recorded." />
      ) : (
        <div className="space-y-3">
          <div className="font-mono text-[11px] text-osu-f1">
            {formatNumber(total)} total
            {callerSummary ? <span className="ml-2 text-osu-l2/70">· {callerSummary}</span> : null}
          </div>

          {rows.length > 0 ? (
            <div className="grid grid-cols-1 gap-1 lg:grid-cols-2">
              {rows.map((row, index) => {
                const statusLabel = row.status == null ? "no-resp" : String(row.status);
                return (
                  <BarRow
                    key={`${row.caller}-${row.path}-${row.status ?? "x"}-${index}`}
                    pct={100}
                    gradient="bg-gradient-to-r from-osu-red/20 to-transparent"
                  >
                    {/* Caller over path rather than beside it: four columns on one
                        line left nothing but ellipses on a phone. */}
                    <div className="flex min-w-0 items-center gap-2.5 px-2.5 py-2">
                      <span className={`w-[52px] flex-shrink-0 text-right font-mono text-[12px] font-bold ${statusColorClass(row.status)}`}>{statusLabel}</span>
                      <div className="min-w-0 flex-1 leading-tight">
                        <div className="truncate text-[12px] font-medium text-white">{row.caller || "unknown"}</div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-osu-f1">{row.path || "(unknown)"}</div>
                      </div>
                      <BarCount value={row.count} />
                    </div>
                  </BarRow>
                );
              })}
            </div>
          ) : null}

          {recent.length > 0 && !showRecentLog ? (
            <div className="text-[11px] text-osu-f1">
              Detailed recent log hidden. Use Show log when you need raw error bodies and rate-limit context.
            </div>
          ) : null}

          {recent.length > 0 && showRecentLog ? (
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-osu-f1">Recent log</div>
              <div className="max-h-[420px] space-y-1 overflow-y-auto pr-1">
                {recent.map((row, index) => {
                  const statusLabel = row.status == null ? "no-resp" : String(row.status);
                  const rateContext = formatRateLimitContext(row);
                  return (
                    <div key={`${row.timestamp}-${index}`} className="overflow-hidden rounded-lg bg-osu-b5/50">
                      <div className="flex min-w-0 items-start gap-2.5 px-2.5 py-2">
                        <span className={`w-[52px] flex-shrink-0 text-right font-mono text-[12px] font-bold ${statusColorClass(row.status)}`}>{statusLabel}</span>
                        <div className="min-w-0 flex-1 leading-tight">
                          <div className="flex min-w-0 items-baseline gap-2">
                            <span className="truncate text-[12px] font-medium text-white">{row.caller || "unknown"}</span>
                            {row.attempts != null && row.attempts > 1 ? <span className="flex-shrink-0 font-mono text-[11px] text-osu-yellow">x{row.attempts}</span> : null}
                            <span className="ml-auto flex-shrink-0 font-mono text-[11px] text-osu-f1">{row.timestamp || "—"}</span>
                          </div>
                          <div className="mt-0.5 truncate font-mono text-[11px] text-osu-f1">{row.path || "(unknown)"}</div>
                        </div>
                      </div>
                      {row.bodyPreview ? (
                        <div className="break-all px-2.5 pb-2 pl-[68px] font-mono text-[11px] text-osu-l2/80">{row.bodyPreview}</div>
                      ) : null}
                      {row.context || rateContext ? (
                        <div className="break-all px-2.5 pb-2 pl-[68px] font-mono text-[11px] text-osu-f1">
                          {row.context ? <span className="text-osu-c2">{row.context}</span> : null}
                          {row.context && rateContext ? <span className="text-osu-l2/50"> · </span> : null}
                          {rateContext ? <span className="text-osu-yellow/90">{rateContext}</span> : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}
