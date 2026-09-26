/** Typed replay timestamps for the export range: "83", "1:23", "1:23.4" or
 *  "1:02:03". Returns wall-clock milliseconds, or null for anything else. */
export function parseReplayTimeInput(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(:\d+){0,2}(\.\d+)?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const parts = whole.split(":").map(Number);
  // Only the leading unit may run past 59, so "1:75" is a typo, not 2:15.
  if (parts.slice(1).some((part) => part > 59)) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  const ms = seconds * 1000 + Math.round(Number(`0.${fraction || "0"}`) * 1000);
  return Number.isFinite(ms) ? ms : null;
}

/** m:ss.t, the precision the viewer seeks at. */
export function formatReplayTimeInput(ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100);
  const mins = Math.floor(tenths / 600);
  const secs = Math.floor((tenths % 600) / 10);
  return `${mins}:${String(secs).padStart(2, "0")}.${tenths % 10}`;
}
