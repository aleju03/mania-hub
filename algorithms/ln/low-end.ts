import type { ManiaBeatmap } from "../chart/beatmap";
import { analyzeLnSkill } from "./skill";

export const LN_LOW_END_RATING_AT_FIRST = 12.322;
export const LN_LOW_END_RATING_PER_LEVEL = 1.71;
export const LN_LOW_END_TABLE_TAKEOVER = 5.6;
export const LN_LOW_END_BEND_FROM = 5;

export function lnLowEndDanForRating(rating: number): number {
  if (!(rating > 0)) return 0;
  if (rating < LN_LOW_END_RATING_AT_FIRST) return rating / LN_LOW_END_RATING_AT_FIRST;
  return 1 + (rating - LN_LOW_END_RATING_AT_FIRST) / LN_LOW_END_RATING_PER_LEVEL;
}

export function lnLowEndBounded(level: number): number {
  if (!(level > LN_LOW_END_BEND_FROM)) return Math.max(0, level);
  const room = LN_LOW_END_TABLE_TAKEOVER - LN_LOW_END_BEND_FROM;
  return LN_LOW_END_BEND_FROM + room * (1 - Math.exp(-(level - LN_LOW_END_BEND_FROM) / room));
}

export function lnTableReadsLowEnd(table: { rawDan: number; boundary: "below" | "above" | null }): boolean {
  return table.boundary === "below" || (table.boundary == null && table.rawDan < LN_LOW_END_TABLE_TAKEOVER);
}

const COURSE_GAP_MS = 4500;
const COURSE_SONG_MIN_MS = 60_000;
const COURSE_MIN_SONGS = 3;

type LowEndMap = Pick<ManiaBeatmap, "notes" | "keyCount" | "od">;

export function lnCourseSongs(notes: LowEndMap["notes"]): LowEndMap["notes"][] | null {
  const sorted = [...notes].sort((left, right) => left.time - right.time);
  const songs: LowEndMap["notes"][] = [];
  let current: LowEndMap["notes"] = [];
  let end = -Infinity;
  for (const note of sorted) {
    if (current.length && note.time - end >= COURSE_GAP_MS) {
      songs.push(current);
      current = [];
    }
    current.push(note);
    end = Math.max(end, note.time, note.endTime);
  }
  if (current.length) songs.push(current);
  if (songs.length < COURSE_MIN_SONGS) return null;
  for (const song of songs) {
    const last = song.reduce((latest, note) => Math.max(latest, note.time, note.endTime), song[0].time);
    if (last - song[0].time < COURSE_SONG_MIN_MS) return null;
  }
  return songs;
}

export function lnLowEndDan(map: LowEndMap, options: { rate: number; od: number }): number | null {
  const level = (notes: LowEndMap["notes"]): number | null => {
    const skill = analyzeLnSkill({ notes, keyCount: map.keyCount, od: map.od }, { rate: options.rate, od: options.od, includeSkillsets: false });
    return skill && skill.rating != null ? lnLowEndDanForRating(skill.rating) : null;
  };
  const whole = level(map.notes);
  if (whole == null) return null;
  let reading = whole;
  const songs = lnCourseSongs(map.notes);
  if (songs) {
    const levels = songs.map(level);
    if (levels.every((value): value is number => value != null)) {
      reading = levels.reduce((sum, value) => sum + value, 0) / levels.length;
    }
  }
  return Math.round(lnLowEndBounded(reading * lnLowEndLengthFactor(map.notes)) * 100) / 100;
}

const FULL_LENGTH_MS = 60_000;

export function lnLowEndLengthFactor(notes: LowEndMap["notes"]): number {
  let first = Infinity;
  let last = -Infinity;
  for (const note of notes) {
    first = Math.min(first, note.time);
    last = Math.max(last, note.time, note.endTime);
  }
  if (!(last > first)) return 0;
  return Math.sqrt(Math.min(1, (last - first) / FULL_LENGTH_MS));
}
