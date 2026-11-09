import type { HighwayChart } from "./supporter-profile-themes";

/* Playing the Note highway profile theme: a visitor's own keys for each
   keymode, and the judge that scores their presses against the chart the
   highway is drawing (components/supporter/use-highway-play.ts runs it). */

/* --- Keys ------------------------------------------------------------------ */

/* osu!mania's own defaults, by position (KeyboardEvent.code), so they sit
   under the same fingers on any layout. */
const DEFAULT_KEYS: Record<number, string[]> = {
  1: ["Space"],
  2: ["KeyF", "KeyJ"],
  3: ["KeyF", "Space", "KeyJ"],
  4: ["KeyD", "KeyF", "KeyJ", "KeyK"],
  5: ["KeyD", "KeyF", "Space", "KeyJ", "KeyK"],
  6: ["KeyS", "KeyD", "KeyF", "KeyJ", "KeyK", "KeyL"],
  7: ["KeyS", "KeyD", "KeyF", "Space", "KeyJ", "KeyK", "KeyL"],
  8: ["KeyA", "KeyS", "KeyD", "KeyF", "KeyJ", "KeyK", "KeyL", "Semicolon"],
  9: ["KeyA", "KeyS", "KeyD", "KeyF", "Space", "KeyJ", "KeyK", "KeyL", "Semicolon"],
  10: ["KeyA", "KeyS", "KeyD", "KeyF", "KeyV", "KeyN", "KeyJ", "KeyK", "KeyL", "Semicolon"],
};

const KEYS_STORAGE = "mt-highway-keys";

function validKeys(value: unknown, lanes: number): value is string[] {
  return Array.isArray(value) && value.length === lanes && value.every((code) => typeof code === "string" && code.length > 0 && code.length <= 24) && new Set(value).size === lanes;
}

/* The viewer's keys for a keymode: the ones they set on this browser, else the defaults. */
export function readHighwayKeys(lanes: number): string[] {
  const fallback = DEFAULT_KEYS[lanes] ?? DEFAULT_KEYS[4];
  try {
    const stored = JSON.parse(window.localStorage.getItem(KEYS_STORAGE) ?? "{}") as Record<string, unknown>;
    const own = stored?.[String(lanes)];
    return validKeys(own, lanes) ? own : fallback;
  } catch {
    return fallback;
  }
}

export function saveHighwayKeys(lanes: number, codes: string[]): void {
  if (!validKeys(codes, lanes)) return;
  try {
    const stored = JSON.parse(window.localStorage.getItem(KEYS_STORAGE) ?? "{}") as Record<string, unknown>;
    window.localStorage.setItem(KEYS_STORAGE, JSON.stringify({ ...stored, [String(lanes)]: codes }));
  } catch {
    // private mode: the keys last for this visit only
  }
}

const LEGENDS: Record<string, string> = {
  Space: " ", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\", BracketLeft: "[", BracketRight: "]",
  Minus: "-", Equal: "=", Backquote: "`", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
  ShiftLeft: "⇧", ShiftRight: "⇧", Enter: "↵", Tab: "⇥", CapsLock: "⇪",
};

/* What a keycap for this key says: " " is the space bar. */
export function highwayKeyLegend(code: string): string {
  if (LEGENDS[code]) return LEGENDS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  return code.length > 3 ? code.slice(0, 3) : code;
}

/* Keys that can't be bound: they belong to the browser or to leaving the game. */
export function bindableHighwayKey(code: string): boolean {
  return !/^(Escape|F\d+|Meta|OS|Control|Alt|ContextMenu|PrintScreen|Unidentified)/.test(code) && code !== "";
}

/* --- Judge ----------------------------------------------------------------- */

export type HighwayJudgement = "MAX" | "300" | "200" | "100" | "50" | "MISS";

/* How far from a note a press may land for each judgement, ms. Looser than
   the game's: a browser page has no audio to play to and more input lag. */
const WINDOWS: [HighwayJudgement, number][] = [["MAX", 22], ["300", 45], ["200", 80], ["100", 110], ["50", 135]];
export const HIGHWAY_MISS_MS = WINDOWS[WINDOWS.length - 1][1];
const VALUES: Record<HighwayJudgement, number> = { MAX: 300, "300": 300, "200": 200, "100": 100, "50": 50, MISS: 0 };

export interface HighwayPlayStats {
  combo: number;
  maxCombo: number;
  counts: Record<HighwayJudgement, number>;
  /** 0..100, as osu!mania counts it; 100 before anything is judged. */
  accuracy: number;
}

/* Scores presses against a chart that loops: each lane's notes in order, a
   press taking the earliest unjudged note in reach, a note left more than the
   last window behind counting as a miss. Times are ms into the chart's loop. */
export class HighwayJudge {
  private readonly starts: Float64Array[];
  private readonly offsets: number[];
  private readonly done: Uint8Array;
  private readonly cursor: number[];
  private last = 0;
  /** Per lane, the start of the last note it hit this loop; -1 for none. */
  readonly hitUntil: number[];
  readonly stats: HighwayPlayStats = { combo: 0, maxCombo: 0, counts: { MAX: 0, "300": 0, "200": 0, "100": 0, "50": 0, MISS: 0 }, accuracy: 100 };

  constructor(chart: HighwayChart, now: number) {
    let from = 0;
    this.offsets = [];
    this.starts = chart.laneEnd.map((end) => {
      const lane = new Float64Array(end - from);
      for (let i = from; i < end; i += 1) lane[i - from] = chart.notes[i * 4];
      this.offsets.push(from);
      from = end;
      return lane;
    });
    this.done = new Uint8Array(from);
    this.cursor = this.starts.map(() => 0);
    this.hitUntil = this.starts.map(() => -1);
    this.skipTo(now);
  }

  /* Starts from `now`: notes already behind it are not owed. */
  private skipTo(now: number) {
    this.done.fill(0);
    this.hitUntil.fill(-1);
    this.starts.forEach((lane, index) => {
      let at = 0;
      while (at < lane.length && lane[at] < now - HIGHWAY_MISS_MS) at += 1;
      this.cursor[index] = at;
    });
    this.last = now;
  }

  private count(judgement: HighwayJudgement) {
    const { stats } = this;
    stats.counts[judgement] += 1;
    stats.combo = judgement === "MISS" ? 0 : stats.combo + 1;
    stats.maxCombo = Math.max(stats.maxCombo, stats.combo);
    let total = 0, value = 0;
    for (const name of Object.keys(stats.counts) as HighwayJudgement[]) {
      total += stats.counts[name];
      value += stats.counts[name] * VALUES[name];
    }
    stats.accuracy = total ? (value / (300 * total)) * 100 : 100;
  }

  /* Moves time on: how many notes went by unhit, and whether the loop started over. */
  advance(now: number): { misses: number; wrapped: boolean } {
    const wrapped = now < this.last - 1000;
    if (wrapped) this.skipTo(0);
    this.last = now;
    let misses = 0;
    this.starts.forEach((lane, index) => {
      let at = this.cursor[index];
      while (at < lane.length && lane[at] < now - HIGHWAY_MISS_MS) {
        if (!this.done[this.offsets[index] + at]) {
          misses += 1;
          this.count("MISS");
        }
        at += 1;
      }
      this.cursor[index] = at;
    });
    return { misses, wrapped };
  }

  /* A key went down in `lane`: the judgement it earned and how late it was
     (ms, negative for early), or null when no note was in reach. */
  press(lane: number, now: number): { judgement: HighwayJudgement; error: number } | null {
    const notes = this.starts[lane];
    if (!notes) return null;
    for (let at = this.cursor[lane]; at < notes.length && notes[at] <= now + HIGHWAY_MISS_MS; at += 1) {
      const flag = this.offsets[lane] + at;
      if (this.done[flag] || notes[at] < now - HIGHWAY_MISS_MS) continue;
      const off = Math.abs(notes[at] - now);
      const judgement = WINDOWS.find(([, window]) => off <= window)![0];
      this.done[flag] = 1;
      this.hitUntil[lane] = notes[at];
      this.count(judgement);
      return { judgement, error: now - notes[at] };
    }
    return null;
  }
}

/* --- The highway's own notes, as a chart ----------------------------------- */

/* The notes a highway shows when its owner plays none of their own: the same
   made-up stream the shader draws on its own (every 190 ms each lane tosses a
   coin, about two notes a row), built here as a chart so that a visitor who
   starts playing gets exactly what was already coming down, and the judge
   knows every note. The same every visit. Times in ms. */
export function highwayStockNotes(lanes: number, lengthMs: number): { column: number; time: number; endTime: number }[] {
  let seed = 0x9e3779b9 ^ (lanes * 2654435761);
  const rand = () => {
    seed = (Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x6d2b79f5) >>> 0;
    return seed / 4294967296;
  };
  const chance = 1 - Math.min(0.8, Math.max(0.5, 1 - 2 / lanes));
  const notes: { column: number; time: number; endTime: number }[] = [];
  for (let time = 190; time <= lengthMs; time += 190) {
    for (let column = 0; column < lanes; column += 1) {
      if (rand() < chance) notes.push({ column, time, endTime: time });
    }
  }
  return notes;
}

/* --- The player's own timing ------------------------------------------------ */

const OFFSET_STORAGE = "mt-highway-offset";
const OFFSET_LIMIT = 150;
/* Until a player's own timing is known: a frame or two of display lag. */
const OFFSET_START = 25;

/* How late (ms, negative for early) this player presses on this screen, on
   average. There is no music to play to, so a press is timed by eye against a
   picture that reaches the screen a frame or two after it is drawn, and every
   player reads "on the line" a little differently; judged raw, a steady
   player gets nothing but 200s. The judge takes this off every press. */
export class HighwayTiming {
  private readonly errors: number[] = [];
  offset: number;

  constructor() {
    let stored = Number.NaN;
    try {
      stored = Number(window.localStorage.getItem(OFFSET_STORAGE));
    } catch {
      // private mode
    }
    this.offset = Number.isFinite(stored) && stored !== 0 && Math.abs(stored) <= OFFSET_LIMIT ? stored : OFFSET_START;
  }

  /* A hit landed `error` ms from its note after the offset: learn from it.
     The offset follows the median of the last presses, a few ms at a time,
     so one stray hit moves nothing and it never jumps under the player. */
  learn(error: number) {
    this.errors.push(error + this.offset);
    if (this.errors.length > 31) this.errors.shift();
    if (this.errors.length < 5) return;
    const sorted = [...this.errors].sort((a, b) => a - b);
    const median = Math.min(OFFSET_LIMIT, Math.max(-OFFSET_LIMIT, sorted[Math.floor(sorted.length / 2)]));
    this.offset += Math.min(4, Math.max(-4, median - this.offset));
  }

  save() {
    try {
      window.localStorage.setItem(OFFSET_STORAGE, this.offset.toFixed(1));
    } catch {
      // private mode: learnt again next visit
    }
  }
}
