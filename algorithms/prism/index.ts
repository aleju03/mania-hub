import { parseManiaBeatmap, type ManiaBeatmap, type ManiaNote } from "../chart/beatmap";
import { buildPrismChart, prismSections, PATTERNS, type PrismChart, type PrismSection } from "./workload";
import { PRISM_BASE_GOAL, PRISM_VERSION, PRISM_EXTRAPOLATION_MAX_SLOPE, PRISM_KEY_COUNTS, PRISM_MAX_GOAL, PRISM_MODELS, PRISM_SKILLSET_FLOOR, PRISM_SKILLSET_SHAPE, PRISM_UNDER_BASE_STRETCH, type PrismModel, type PrismScale } from "./params";

export { PRISM_VERSION, PRISM_ENABLED, PRISM_BASE_GOAL, PRISM_KEY_COUNTS, PRISM_MAX_GOAL, PRISM_MODELS, usesPrism } from "./params";
export { buildPrismChart, prismHands, prismSections, PATTERNS } from "./workload";

type SkillsetSource = (typeof PATTERNS)[number];

const SKILLSET_SOURCES: ReadonlyArray<[string, SkillsetSource | null]> = [
  ["Stream", "stream"],
  ["JumpstreamOnly", "chordstream"],
  ["Handstream", "bracket"],
  ["Stamina", null],
  ["JackSpeed", "jack"],
  ["ChordjackOnly", "chordjack"],
  ["Technical", "technical"],
  ["Speed", "speed"],
];

const MERGED: ReadonlyArray<[string, string, string]> = [
  ["Jumpstream", "Stream", "JumpstreamOnly"],
  ["Chordjack", "JackSpeed", "ChordjackOnly"],
];

export interface PrismResult {
  version: string;
  keyCount: number;
  rate: number;
  goal: number;
  values: Record<string, number>;
  centreHand: 0 | 1;
}

export interface PrismOptions {
  rate?: number;
  od?: number | null;
  goal?: number;
  overallOnly?: boolean;
}

export function isPrismKeyCount(keyCount: number): boolean {
  return PRISM_KEY_COUNTS.has(keyCount);
}

export function prismStrainAtGoal(demand: ArrayLike<number>, weight: ArrayLike<number>, goal: number, goalExponent: number): number {
  let total = 0, peak = 0;
  for (let i = 0; i < demand.length; i += 1) {
    total += weight[i];
    if (demand[i] > peak) peak = demand[i];
  }
  if (!(goal > 0) || !(total > 0) || !(peak > 0)) return 0;
  const logBase = Math.log(PRISM_BASE_GOAL);
  let lo = 0, hi = peak * 8, skill = peak;
  for (let i = 0; i < 60; i += 1) {
    let score = 0, slope = 0;
    for (let j = 0; j < demand.length; j += 1) {
      if (!(demand[j] > 0)) { score += weight[j]; continue; }
      const t = Math.pow(demand[j] / skill, goalExponent);
      const f = weight[j] * Math.exp(logBase * t);
      score += f;
      slope -= f * logBase * goalExponent * t / skill;
    }
    const miss = score / total - goal;
    if (miss < 0) lo = skill;
    else hi = skill;
    if (Math.abs(miss) < 1e-12 || hi - lo < 1e-10 * hi) break;
    const next = slope > 0 ? skill - miss * total / slope : NaN;
    skill = next > lo && next < hi ? next : (lo + hi) / 2;
  }
  return skill;
}

export function prismRatingOfStrain(strain: number, scale: PrismScale): number {
  if (!(strain > 0)) return 0;
  const { strain: xs, rating: ys } = scale;
  const x = Math.log(strain);
  let i = 1;
  while (i < xs.length - 1 && x > Math.log(xs[i])) i += 1;
  const x0 = Math.log(xs[i - 1]), y0 = Math.log(ys[i - 1]), x1 = Math.log(xs[i]), y1 = Math.log(ys[i]);
  return Math.exp(y0 + ((y1 - y0) / (x1 - x0)) * (x - x0));
}

const demandsOf = (sections: readonly PrismSection[]) => Float64Array.from(sections, (s) => s.demand);
const weightsOf = (sections: readonly PrismSection[]) => Float64Array.from(sections, (s) => s.work);

export function pickPrismHands(chart: PrismChart, model: PrismModel): { centreHand: 0 | 1; sections: PrismSection[] } {
  const left = prismSections(chart, 0, model);
  if (chart.keyCount % 2 === 0) return { centreHand: 0, sections: left };
  const right = prismSections(chart, 1, model);
  const strain = (s: PrismSection[]) => prismStrainAtGoal(demandsOf(s), weightsOf(s), PRISM_BASE_GOAL, model.goalExponent);
  return strain(left) <= strain(right) ? { centreHand: 0, sections: left } : { centreHand: 1, sections: right };
}

const SKILLSET_SHARE_CAP = 2;

function skillsetDemand(sections: readonly PrismSection[], source: SkillsetSource): Float64Array {
  const { reference, exponent } = PRISM_SKILLSET_SHAPE[source];
  const k = PATTERNS.indexOf(source);
  return Float64Array.from(sections, (section) => {
    const share = section.work > 0 ? section.mix[k] / section.work : 0;
    return section.demand * (PRISM_SKILLSET_FLOOR + (1 - PRISM_SKILLSET_FLOOR) * Math.pow(Math.min(SKILLSET_SHARE_CAP, share / reference), exponent));
  });
}

interface Prepared {
  centreHand: 0 | 1;
  time: Float64Array;
  weight: Float64Array;
  overall: Float64Array;
  skillsets: Array<Float64Array | null> | null;
}

const PREPARED_KEPT = 32;
const prepared = new WeakMap<PrismModel, Map<string, Prepared>>();

function notesKey(notes: readonly ManiaNote[], keyCount: number, rate: number, od: number): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ notes.length;
  const mix = (value: number) => {
    a = Math.imul(a ^ value, 0x01000193) >>> 0;
    b = Math.imul(b ^ (value + 0x9e3779b9), 0x85ebca6b) >>> 0;
  };
  for (const note of notes) {
    mix(Math.round(note.time * 8)); mix(note.column); mix(note.isHold ? Math.round(note.endTime * 8) : -1);
  }
  return `${keyCount}:${rate}:${od}:${notes.length}:${a.toString(36)}:${b.toString(36)}`;
}

function prepare(map: Pick<ManiaBeatmap, "notes" | "keyCount" | "od">, rate: number, od: number, model: PrismModel, withSkillsets: boolean): Prepared {
  let kept = prepared.get(model);
  if (!kept) prepared.set(model, kept = new Map());
  const key = notesKey(map.notes, map.keyCount, rate, od);
  const hit = kept.get(key);
  if (hit && (hit.skillsets || !withSkillsets)) {
    kept.delete(key); kept.set(key, hit);
    return hit;
  }
  const { centreHand, sections } = pickPrismHands(buildPrismChart(map.notes, map.keyCount, rate, od), model);
  const ready: Prepared = {
    centreHand, time: Float64Array.from(sections, (s) => s.timeMs), weight: weightsOf(sections), overall: demandsOf(sections),
    skillsets: withSkillsets ? SKILLSET_SOURCES.map(([, source]) => (source ? skillsetDemand(sections, source) : null)) : null,
  };
  kept.set(key, ready);
  if (kept.size > PREPARED_KEPT) kept.delete(kept.keys().next().value!);
  return ready;
}

function valuesAt(ready: Prepared, goal: number, model: PrismModel, scale: PrismScale): Record<string, number> {
  const values: Record<string, number> = { Overall: prismRatingOfStrain(prismStrainAtGoal(ready.overall, ready.weight, goal, model.goalExponent), scale) };
  if (ready.skillsets) {
    const raw = ready.skillsets.map((demand) => (demand ? prismStrainAtGoal(demand, ready.weight, goal, model.goalExponent) : 0));
    const top = Math.max(...raw);
    SKILLSET_SOURCES.forEach(([slot], i) => { values[slot] = top > 0 ? values.Overall * (raw[i] / top) : 0; });
    for (const [slot, single, chord] of MERGED) values[slot] = Math.max(values[single], values[chord]);
  }
  return values;
}

export type PrismSpans = ReadonlyArray<readonly [number, number]>;

function within(ready: Prepared, spans: PrismSpans, rate: number): Prepared {
  const keep: number[] = [];
  let j = 0;
  for (let i = 0; i < ready.time.length; i += 1) {
    const at = ready.time[i] * rate;
    while (j < spans.length && spans[j][1] <= at) j += 1;
    if (j < spans.length && spans[j][0] <= at) keep.push(i);
  }
  return {
    centreHand: ready.centreHand, time: Float64Array.from(keep, (i) => ready.time[i]),
    weight: Float64Array.from(keep, (i) => ready.weight[i]), overall: Float64Array.from(keep, (i) => ready.overall[i]), skillsets: null,
  };
}

function rateWith(map: Pick<ManiaBeatmap, "notes" | "keyCount" | "od">, options: PrismOptions, model: PrismModel, scale: PrismScale, spans?: PrismSpans): PrismResult | null {
  if (!isPrismKeyCount(map.keyCount)) return null;
  const rate = Number.isFinite(options.rate) && Number(options.rate) > 0 ? Number(options.rate) : 1;
  const goal = Math.min(0.9999, Math.max(0.1, Number.isFinite(options.goal) ? Number(options.goal) : PRISM_BASE_GOAL));
  const rawOd = options.od ?? map.od;
  const od = Number.isFinite(rawOd) ? Math.max(0, Math.min(10, Number(rawOd))) : 8;
  const prepared = prepare(map, rate, od, model, !options.overallOnly && !spans);
  const ready = spans ? within(prepared, spans, rate) : prepared;
  const solved = goal < PRISM_BASE_GOAL ? Math.max(0.1, PRISM_BASE_GOAL - (PRISM_BASE_GOAL - goal) * PRISM_UNDER_BASE_STRETCH) : goal;
  let values = valuesAt(ready, Math.min(solved, PRISM_MAX_GOAL), model, scale);
  if (goal > PRISM_MAX_GOAL) {
    const base = valuesAt(ready, PRISM_BASE_GOAL, model, scale);
    const exponent = (goal - PRISM_MAX_GOAL) / (PRISM_MAX_GOAL - PRISM_BASE_GOAL);
    values = Object.fromEntries(Object.entries(values).map(([name, atCap]) => {
      const atBase = base[name];
      return [name, atCap > 0 && atBase > 0 && atCap > atBase ? atCap * Math.pow(Math.min(atCap / atBase, PRISM_EXTRAPOLATION_MAX_SLOPE), exponent) : atCap];
    }));
  }
  return { version: PRISM_VERSION, keyCount: map.keyCount, rate, goal, values, centreHand: ready.centreHand };
}

export function analyzePrism(map: Pick<ManiaBeatmap, "notes" | "keyCount" | "od">, options: PrismOptions = {}): PrismResult | null {
  const model = PRISM_MODELS[map.keyCount];
  return model ? rateWith(map, options, model.press, model.scale) : null;
}

export function analyzePrismLn(map: Pick<ManiaBeatmap, "notes" | "keyCount" | "od">, options: Omit<PrismOptions, "overallOnly"> = {}, spans?: PrismSpans): number | null {
  const model = PRISM_MODELS[map.keyCount];
  return model ? rateWith(map, { ...options, overallOnly: true }, model.ln, model.lnScale, spans)?.values.Overall ?? null : null;
}

export function analyzePrismFromText(osuText: string, options: PrismOptions = {}): PrismResult | null {
  return analyzePrism(parseManiaBeatmap(osuText), options);
}
