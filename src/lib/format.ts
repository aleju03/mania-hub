export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatPP(pp: number | null): string {
  if (pp == null) return "-";
  return `${Math.round(pp).toLocaleString("en-US")}pp`;
}

export function formatPpGain(pp: number): string {
  return pp.toLocaleString("en-US", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
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
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
