import { parseManiaBeatmap, type ManiaBeatmap } from "../chart/beatmap";
import { lnPrimaryMinRatioFor } from "../dan-estimator/ln";
import { analyzeEffectiveLn, LN_MIN_WORK_SHARE } from "../dan-estimator/ln-effective";
import { analyzeLnSkill, isLnSkillSupported, LN_SKILL_VERSION, type LnSkillResult } from "../ln/skill";
import { analyzePrismLn } from "./index";
import { prismLnSpans } from "./ln-sections";
import { PRISM_BASE_GOAL, PRISM_KEY_COUNTS } from "./params";

type LnSkillMap = Pick<ManiaBeatmap, "notes" | "keyCount" | "od">;
type LnSkillOptions = NonNullable<Parameters<typeof analyzeLnSkill>[1]>;

const HELD_TIME_MIN_SHARE = 0.8;
const HELD_PRESS_MIN_SHARE = 0.3;
const HELD_PRESSES_PER_SECOND_MIN = 2.5;

const HELD_EDGE_MS = 10;

function isHeldThrough(notes: LnSkillMap["notes"], rate: number): boolean {
  if (notes.length === 0) return false;
  const sorted = [...notes].sort((a, b) => a.time - b.time);
  const holds = sorted.filter((note) => note.isHold && note.endTime > note.time);
  if (holds.length === 0) return false;
  let held = 0;
  let start = holds[0].time;
  let end = holds[0].endTime;
  for (const hold of holds) {
    if (hold.time > end) {
      held += end - start;
      start = hold.time;
      end = hold.endTime;
    } else end = Math.max(end, hold.endTime);
  }
  held += end - start;
  const first = sorted[0].time;
  const last = sorted.reduce((most, note) => Math.max(most, note.time, note.endTime), -Infinity);
  const span = last - first;
  if (span <= 0 || held / span < HELD_TIME_MIN_SHARE) return false;
  const edge = HELD_EDGE_MS * rate;
  const open: typeof holds = [];
  let next = 0;
  let under = 0;
  for (const note of sorted) {
    while (next < holds.length && holds[next].time <= note.time - edge) open.push(holds[next++]);
    for (let i = open.length - 1; i >= 0; i -= 1) if (open[i].endTime < note.time + edge) open.splice(i, 1);
    if (open.some((hold) => hold.column !== note.column)) under += 1;
  }
  return under / sorted.length >= HELD_PRESS_MIN_SHARE && under / (span / 1000 / rate) >= HELD_PRESSES_PER_SECOND_MIN;
}

export function prismLnSkill(map: LnSkillMap, options: Omit<LnSkillOptions, "includeSkillsets"> = {}): LnSkillResult | null {
  return rateLn(map, options, true);
}

const PLAY_SECTION_MIN_RATIO: Readonly<Record<number, number>> = { 7: 0.36 };

export function prismPlayLnSkill(map: LnSkillMap, options: Omit<LnSkillOptions, "includeSkillsets"> = {}): LnSkillResult | null {
  return rateLn(map, options, false);
}

const PRISM_LN_TAPPED_MAX_SHARE = 0.05;

function rateLn(map: LnSkillMap, options: Omit<LnSkillOptions, "includeSkillsets">, chart: boolean): LnSkillResult | null {
  if (!PRISM_KEY_COUNTS.has(map.keyCount)) return null;
  const scoreGoal = Number.isFinite(options.scoreGoal) ? Math.max(0, Math.min(0.999, Number(options.scoreGoal))) : PRISM_BASE_GOAL;
  const holds = map.notes.filter((note) => note.isHold && note.endTime > note.time).length;
  const holdRatio = map.notes.length ? holds / map.notes.length : 0;
  const rate = Number.isFinite(options.rate) && Number(options.rate) > 0 ? Number(options.rate) : 1;
  const rawOd = options.od ?? map.od;
  const od = Number.isFinite(rawOd) ? Math.max(0, Math.min(10, Number(rawOd))) : 8;
  const effective = analyzeEffectiveLn(map.notes, { rate, od, keyCount: map.keyCount });
  const line = lnPrimaryMinRatioFor(map.keyCount);
  const heldThrough = holds > 0 && isHeldThrough(map.notes, rate);
  const tapped = effective.tapCovered && effective.trackedShare < PRISM_LN_TAPPED_MAX_SHARE && !heldThrough;
  const whole = holds > 0 && (holdRatio >= line || heldThrough)
    && effective.identityWorkShare >= LN_MIN_WORK_SHARE && !effective.lnVibro && !tapped;
  const sections = chart || holdRatio >= (PLAY_SECTION_MIN_RATIO[map.keyCount] ?? Infinity);
  const spans = sections && !whole && holds > 0 && holdRatio < line && !effective.lnVibro ? prismLnSpans(map.notes, map.keyCount, od) : [];
  const ln = whole || spans.length > 0;
  const rating = ln && scoreGoal > 0 ? analyzePrismLn(map, { rate, od, goal: scoreGoal }, whole ? undefined : spans) ?? 0 : 0;
  return {
    version: LN_SKILL_VERSION, keyCount: map.keyCount, rating, strain: 0, eligible: ln, rated: ln,
    holdRatio, effectiveRatio: effective.effectiveLnRatio, effectiveHolds: effective.effectiveHolds,
    rate, od, scoreGoal,
  };
}

export function analyzeAnyLnSkill(map: LnSkillMap, options: LnSkillOptions = {}): LnSkillResult | null {
  if (!PRISM_KEY_COUNTS.has(map.keyCount)) return analyzeLnSkill(map, options);
  return isLnSkillSupported(map.keyCount) ? prismLnSkill(map, options) : null;
}

export function analyzeAnyLnSkillFromText(osuText: string, options: LnSkillOptions = {}): LnSkillResult | null {
  return analyzeAnyLnSkill(parseManiaBeatmap(osuText), options);
}
