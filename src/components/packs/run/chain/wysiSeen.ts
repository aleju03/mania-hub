/* 727s in a card's hover stats (pp, ranks, plays, base) light up and play the
   stamp sound the first time that card's stats are shown in a run, and pay
   nothing, so hovering cannot be farmed. Remembered per run in
   sessionStorage. */

const KEY = "chain-wysi-seen";

let runKey = "";

/* The table sets the run it is showing (runNo and start time). */
export function setWysiRunKey(key: string): void {
  runKey = key;
}

function read(): { run: string; ids: number[] } {
  try {
    const raw = JSON.parse(window.sessionStorage.getItem(KEY) ?? "null") as { run?: unknown; ids?: unknown } | null;
    if (raw && raw.run === runKey && Array.isArray(raw.ids)) return { run: runKey, ids: raw.ids.filter((id): id is number => typeof id === "number") };
  } catch {
    // Unreadable storage counts as nothing seen.
  }
  return { run: runKey, ids: [] };
}

/* True the first time a card's stat 727 is shown in this run, then false. */
export function firstWysiSight(cardId: number): boolean {
  if (typeof window === "undefined" || !runKey) return false;
  const seen = read();
  if (seen.ids.includes(cardId)) return false;
  seen.ids.push(cardId);
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ run: runKey, ids: seen.ids.slice(-200) }));
  } catch {
    // Storage full or blocked: the sound may play again, nothing else.
  }
  return true;
}
