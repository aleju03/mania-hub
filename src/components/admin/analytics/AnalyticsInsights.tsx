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
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
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
   row sized against the biggest value in the list. */
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
    <div className={`relative overflow-hidden rounded-md border border-osu-b3/20 bg-osu-b5/60 ${className}`}>
      <div className={`absolute inset-y-0 left-0 ${gradient}`} style={{ width: `${pct}%` }} />
      <div className="relative">{children}</div>
    </div>
  );
}

function barPct(value: number, max: number): number {
  return Math.max(3, Math.round((value / max) * 100));
}

function TopRoutesCard({ rows, range }: { rows: AnalyticsTopRouteRow[]; range: AnalyticsRange }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <SectionCard title="Top routes" subtitle={`pageviews, ${formatAnalyticsRangeLabel(range).toLowerCase()}`}>
      {rows.length === 0 ? (
        <AnalyticsEmptyMessage text="No pageviews captured yet." />
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <BarRow key={row.path} pct={barPct(row.count, max)} gradient="bg-gradient-to-r from-osu-pink/25 to-osu-pink/5">
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="truncate font-mono text-[11px] text-osu-c2">{row.path || "(unknown)"}</span>
                <span className="flex-shrink-0 text-[11px] font-bold text-white">{formatNumber(row.count)}</span>
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
        <div className="space-y-1.5">
          {rows.map((row) => {
            const code = row.country.toUpperCase();
            return (
              <BarRow key={code} pct={barPct(row.count, max)} gradient="bg-gradient-to-r from-osu-blue/20 to-osu-blue/5">
                <div className="flex items-center gap-2.5 px-3 py-2">
                  <CountryFlag code={code} size="sm" />
                  <span className="flex-1 truncate text-[11px] text-osu-c2">{getCountryName(code) || code}</span>
                  <span className="flex-shrink-0 text-[11px] font-bold text-white">{formatNumber(row.count)}</span>
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
        <div className="space-y-1.5">
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
                gradient="bg-gradient-to-r from-osu-purple/20 to-osu-purple/5"
                className="transition-colors duration-[100ms] group-hover:border-osu-purple/40"
              >
                <div className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-[11px] text-osu-c2">
                    <span className="group-hover:underline">{row.username}</span>
                    {row.lastViewedLabel ? (
                      <span className="text-osu-f1">
                        {" "}· last visited {row.lastViewedLabel} <InlineCountryFlag country={row.lastVisitorCountry} />
                      </span>
                    ) : null}
                  </span>
                  <span className="flex-shrink-0 text-[11px] font-bold text-white">{formatNumber(row.views)}</span>
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
        <div className="space-y-1.5">
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
                  gradient="bg-gradient-to-r from-osu-yellow/20 to-osu-yellow/5"
                  className="transition-colors duration-[100ms] group-hover:border-osu-yellow/40"
                >
                  <div className="flex min-w-0 items-center gap-2.5 px-2 py-1.5">
                    {row.coverUrl ? (
                      <img src={row.coverUrl} alt="" className="h-[34px] w-[56px] flex-shrink-0 rounded-[2px] border border-osu-b3/30 object-cover" loading="lazy" />
                    ) : (
                      <div className="h-[34px] w-[56px] flex-shrink-0 rounded-[2px] bg-osu-b3/30" />
                    )}
                    <div className="min-w-0 flex-1 leading-tight">
                      <div className="truncate text-[11px] font-medium text-white group-hover:underline">{primary}</div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-[9px] text-osu-f1">
                        {row.difficulty ? <span className="text-osu-c2">[{row.difficulty}]</span> : null}
                        {row.difficulty && (row.player || row.lastViewedLabel) ? <span>·</span> : null}
                        {row.player ? <span className="truncate">{row.player}</span> : null}
                        {row.player && row.lastViewedLabel ? <span>·</span> : null}
                        {row.lastViewedLabel ? (
                          <>
                            <span className="flex-shrink-0">last watched {row.lastViewedLabel}</span>
                            <InlineCountryFlag country={row.lastVisitorCountry} />
                          </>
                        ) : null}
                      </div>
                    </div>
                    <span className="flex-shrink-0 text-[12px] font-bold text-white">{formatNumber(row.views)}</span>
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
        <div className="space-y-1.5">
          {rows.map((row) => {
            const isDirect = row.domain === "$direct";
            return (
              <BarRow
                key={row.domain}
                pct={barPct(row.count, max)}
                gradient="bg-gradient-to-r from-osu-green-light/20 to-osu-green-light/5"
              >
                <div className="flex items-center justify-between gap-3 px-3 py-2" title={isDirect ? "" : row.domain}>
                  <span className={`truncate text-[11px] ${isDirect ? "italic text-osu-f1" : "text-osu-c2"}`}>
                    {formatReferrerLabel(row.domain)}
                  </span>
                  <span className="flex-shrink-0 text-[11px] font-bold text-white">{formatNumber(row.count)}</span>
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
        <div className="space-y-1.5">
          {rows.map((row) => (
            <BarRow key={row.platform} pct={barPct(row.count, max)} gradient="bg-gradient-to-r from-osu-pink/25 to-osu-pink/5">
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="truncate text-[11px] text-osu-c2">{SHARE_PLATFORM_LABELS[row.platform] ?? row.platform}</span>
                <span className="flex-shrink-0 text-[11px] font-bold text-white">{formatNumber(row.count)}</span>
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
        <div className="space-y-1.5">
          {rows.map((row, index) => {
            const secondary = row.subjectType === "replay" && row.subject
              ? `/replay?scoreId=${row.subject}`
              : row.path || "(unknown)";
            return (
              <BarRow
                key={`${row.path}-${row.subject ?? ""}-${index}`}
                pct={barPct(row.count, max)}
                gradient="bg-gradient-to-r from-osu-purple/20 to-osu-purple/5"
              >
                <div className="flex min-w-0 items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1 leading-tight">
                    <div className="truncate text-[11px] text-osu-c2">{sharedPagePrimary(row)}</div>
                    <div className="mt-0.5 truncate font-mono text-[9px] text-osu-f1">{secondary}</div>
                  </div>
                  <span className="flex-shrink-0 text-[11px] font-bold text-white">{formatNumber(row.count)}</span>
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
          className="h-7 cursor-pointer rounded-md border border-osu-b3/30 bg-osu-b5/70 px-2 text-[10px] font-semibold text-osu-c2 transition-colors duration-[120ms] hover:border-osu-red/35 hover:bg-osu-b3/50 hover:text-white"
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
          <div className="font-mono text-[10px] text-osu-f1">
            {formatNumber(total)} total
            {callerSummary ? <span className="ml-2 text-osu-l2/70">· {callerSummary}</span> : null}
          </div>

          {rows.length > 0 ? (
            <div className="grid grid-cols-1 gap-1.5 lg:grid-cols-2">
              {rows.map((row, index) => {
                const statusLabel = row.status == null ? "no-resp" : String(row.status);
                return (
                  <BarRow
                    key={`${row.caller}-${row.path}-${row.status ?? "x"}-${index}`}
                    pct={100}
                    gradient="bg-gradient-to-r from-osu-red/20 to-osu-red/5"
                  >
                    <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
                      <span className={`w-12 flex-shrink-0 text-right font-mono text-[10px] font-bold ${statusColorClass(row.status)}`}>{statusLabel}</span>
                      <span className="max-w-[40%] flex-shrink-0 truncate text-[11px] font-medium text-white">{row.caller || "unknown"}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-osu-f1">{row.path || "(unknown)"}</span>
                      <span className="flex-shrink-0 text-[11px] font-bold text-white">{formatNumber(row.count)}</span>
                    </div>
                  </BarRow>
                );
              })}
            </div>
          ) : null}

          {recent.length > 0 && !showRecentLog ? (
            <div className="rounded-md border border-osu-b3/20 bg-osu-b5/40 px-3 py-2 text-[10px] text-osu-f1">
              Detailed recent log hidden. Use Show log when you need raw error bodies and rate-limit context.
            </div>
          ) : null}

          {recent.length > 0 && showRecentLog ? (
            <div>
              <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-wider text-osu-f1">Recent log</div>
              <div className="max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
                {recent.map((row, index) => {
                  const statusLabel = row.status == null ? "no-resp" : String(row.status);
                  const rateContext = formatRateLimitContext(row);
                  return (
                    <div key={`${row.timestamp}-${index}`} className="overflow-hidden rounded-md border border-osu-b3/20 bg-osu-b5/60">
                      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
                        <span className="w-20 flex-shrink-0 font-mono text-[10px] text-osu-f1">{row.timestamp || "—"}</span>
                        <span className={`w-10 flex-shrink-0 text-right font-mono text-[10px] font-bold ${statusColorClass(row.status)}`}>{statusLabel}</span>
                        <span className="max-w-[35%] flex-shrink-0 truncate text-[11px] font-medium text-white">{row.caller || "unknown"}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-osu-f1">{row.path || "(unknown)"}</span>
                        {row.attempts != null && row.attempts > 1 ? <span className="flex-shrink-0 font-mono text-[9px] text-osu-yellow">x{row.attempts}</span> : null}
                      </div>
                      {row.bodyPreview ? (
                        <div className="-mt-0.5 break-all px-2.5 pb-1.5 font-mono text-[10px] text-osu-l2/70">{row.bodyPreview}</div>
                      ) : null}
                      {row.context || rateContext ? (
                        <div className="-mt-0.5 break-all px-2.5 pb-1.5 font-mono text-[10px] text-osu-f1">
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
