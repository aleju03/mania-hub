export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/* Counts for icon-and-number stat rows, where two of them share the space one
   spelled-out figure used to hold: "1.2k" rather than "1,203". Only for places
   that keep the exact number within reach (a title, a detail page). */
export function formatCompactCount(n: number): string {
  const value = Math.max(0, Math.floor(n));
  if (value < 1000) return value.toLocaleString("en-US");
  return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
}

/* 1st, 2nd, 3rd, 4th, and the 11th-13th exceptions. */
export function formatOrdinal(n: number): string {
  const value = Math.floor(n);
  const lastTwo = Math.abs(value) % 100;
  const last = Math.abs(value) % 10;
  const suffix =
    lastTwo >= 11 && lastTwo <= 13 ? "th" : last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th";
  return `${value.toLocaleString("en-US")}${suffix}`;
}

export function formatPP(pp: number | null): string {
  if (pp == null) return "-";
  return `${Math.round(pp).toLocaleString("en-US")}pp`;
}

export function formatPpGain(pp: number): string {
  if (Math.abs(pp) < 0.05) return "0";
  return pp.toLocaleString("en-US", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  });
}

export function formatAccuracy(acc: number): string {
  return `${(acc * 100).toFixed(2)}%`;
}

export function formatPlayTime(seconds: number | null): string {
  if (!seconds) return "0h";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/* Hover detail for the year labels above: past a year "5y ago" reads faster
   than "63mo ago", but the month count is still the useful number, so keep it
   one hover away. Undefined below a year, where the label is already exact. */
export function formatTimeAgoTooltip(dateStr: string): string | undefined {
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days < 365) return undefined;
  const months = Math.floor(days / 30);
  return `${months} months ago`;
}

/* Seconds granularity for live tickers; nowMs is a parameter so a ticking
   state value can drive re-renders and tests stay deterministic. */
export function formatPreciseTimeAgo(timestampMs: number, nowMs: number): string {
  const secs = Math.floor((nowMs - timestampMs) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatDetailedTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  if (hours < 24) return remainingMins > 0 ? `${hours}h ${remainingMins}m ago` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatDate(dateStr: string): string {
  // Pinned to UTC: this renders inside server-rendered HTML (e.g. profile
  // "Joined" line), so server and client must produce identical text for any
  // viewer timezone or hydration fails (React #418) and recovery re-renders
  // wipe the <html> theme vars.
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
