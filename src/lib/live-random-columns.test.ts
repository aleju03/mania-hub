import { describe, expect, it } from "vitest";

import type { ManiaNote } from "#/lib/beatmap-parser";
import type { ReplayFrame } from "#/lib/types";
import { inferRandomColumnMap } from "./live-random-columns";

function chart(keyCount: number, count: number): ManiaNote[] {
  const notes: ManiaNote[] = [];
  let seed = 7;
  for (let i = 0; i < count; i++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    notes.push({ time: 1000 + i * 120, column: (seed >> 16) % keyCount, isHold: false, endTime: 1000 + i * 120 } as ManiaNote);
  }
  return notes;
}

function play(notes: ManiaNote[], map: number[], jitter = 0, miss = 0): ReplayFrame[] {
  const events: Array<[number, number, boolean]> = [];
  notes.forEach((note, index) => {
    if (miss && index % miss === 0) return;
    const at = note.time + (index % 2 ? jitter : -jitter);
    events.push([at, map[note.column], true], [at + 40, map[note.column], false]);
  });
  events.sort((a, b) => a[0] - b[0] || Number(a[2]) - Number(b[2]));
  let keys = 0;
  return events.map(([time, column, down]) => {
    keys = down ? keys | (1 << column) : keys & ~(1 << column);
    return { time, keyState: keys };
  });
}

describe("inferRandomColumnMap", () => {
  it("finds the shuffle from the presses", () => {
    for (const [keyCount, map] of [[4, [2, 0, 3, 1]], [7, [6, 3, 0, 5, 1, 4, 2]], [10, [9, 1, 7, 3, 5, 0, 8, 2, 6, 4]]] as const) {
      const notes = chart(keyCount, 80);
      expect(inferRandomColumnMap(notes, play(notes, [...map], 25, 9), keyCount)).toEqual(map);
    }
  });

  it("waits until enough notes have been played", () => {
    const notes = chart(4, 80);
    expect(inferRandomColumnMap(notes, play(notes.slice(0, 10), [1, 0, 3, 2]), 4)).toBeNull();
  });

  it("keeps the columns of a play without a shuffle", () => {
    const notes = chart(7, 60);
    expect(inferRandomColumnMap(notes, play(notes, [0, 1, 2, 3, 4, 5, 6]), 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
