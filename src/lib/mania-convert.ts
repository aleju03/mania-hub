// Port of osu!lazer's ManiaBeatmapConverter: turns osu!standard hit objects into
// the mania "convert" chart a player actually plays (including xK keymod charts).
// This must stay bit-exact with lazer/stable: the pattern generators consume a
// shared LegacyRandom stream, so any drift changes every note that follows.
// Reference: osu.Game.Rulesets.Mania/Beatmaps (ManiaBeatmapConverter, Patterns/Legacy/*).

import type { ManiaSampleBank } from "./beatmap-parser";

export const HITSOUND_WHISTLE = 2;
export const HITSOUND_FINISH = 4;
export const HITSOUND_CLAP = 8;

/** Mirrors the sample list lazer builds per object/node in ConvertHitObjectParser.convertSoundType. */
export interface ConvertSampleInfo {
  /** whistle/finish/clap bits present (always 0 when a filename sample replaces the set). */
  additions: number;
  /** hitnormal present (false when a filename sample replaces the set). */
  hasNormal: boolean;
  /** hitnormal attached as a layered sample (additions present without the Normal bit). */
  normalIsLayered: boolean;
  bank: ManiaSampleBank | null;
  additionBank: ManiaSampleBank | null;
  index: number;
  volume: number;
  filename?: string;
}

export type StdHitObjectKind = "circle" | "slider" | "spinner" | "hold";

export interface StdHitObject {
  kind: StdHitObjectKind;
  startTime: number;
  x: number;
  y: number;
  /** Spinners/holds only; equals startTime otherwise. */
  endTime: number;
  samples: ConvertSampleInfo;
  /** Sliders: spans - 1, after lazer's zero-length-slider adjustment. */
  repeatCount: number;
  /** Sliders: the expected distance (null when the length field is absent or 0). */
  length: number | null;
  /** Sliders: per-node samples (head, repeats, tail), after zero-length adjustment. */
  nodeSamples: ConvertSampleInfo[] | null;
}

export interface ConvertTimingPoint {
  time: number;
  /** Clamped to [6, 60000] like lazer's TimingControlPoint bindable. */
  beatLength: number;
}

export interface ConvertDifficultyPoint {
  time: number;
  /** Clamped to [0.1, 10] like lazer's DifficultyControlPoint bindable. */
  sliderVelocity: number;
}

export interface ConvertEffectPoint {
  time: number;
  kiai: boolean;
}

export interface StdConvertBeatmap {
  /** Stably sorted by start time (parse order preserved for equal times). */
  hitObjects: StdHitObject[];
  timingPoints: ConvertTimingPoint[];
  difficultyPoints: ConvertDifficultyPoint[];
  effectPoints: ConvertEffectPoint[];
  /** Float difficulty values after lazer's applyDifficultyRestrictions clamps. */
  drainRate: number;
  circleSize: number;
  overallDifficulty: number;
  approachRate: number;
  /** Clamped to [0.4, 3.6]. */
  sliderMultiplier: number;
  totalBreakTime: number;
}

export interface ConvertedManiaNote {
  column: number;
  startTime: number;
  endTime: number;
  isHold: boolean;
  /** Sample played at the note/hold head; null means a silent head. */
  sample: ConvertSampleInfo | null;
}

export class NotEnoughColumnsError extends Error {
  constructor() {
    super("There were not enough columns to complete conversion.");
  }
}

// PatternType flags (Patterns/Legacy/PatternType.cs).
const FORCE_STACK = 1;
const FORCE_NOT_STACK = 1 << 1;
const KEEP_SINGLE = 1 << 2;
const LOW_PROBABILITY = 1 << 3;
const GATHERED = 1 << 7;
const MIRROR = 1 << 8;
const REVERSE = 1 << 9;
const CYCLE = 1 << 10;
const STAIR = 1 << 11;
const REVERSE_STAIR = 1 << 12;

const INT_MAX = 2147483647;
const fround = Math.fround;

/** C# Math.Round / MathF.Round: round half to even. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** The FastRandom PRNG from osu!stable (osu.Game/Utils/LegacyRandom.cs). */
export class LegacyRandom {
  x: number;
  y = 842502087;
  z = 3579807591;
  w = 273326509;
  private bitBuffer = 0;
  private bitIndex = 32;

  constructor(seed: number) {
    this.x = seed >>> 0;
  }

  nextUInt(): number {
    const t = (this.x ^ ((this.x << 11) >>> 0)) >>> 0;
    this.x = this.y;
    this.y = this.z;
    this.z = this.w;
    this.w = (this.w ^ (this.w >>> 19) ^ t ^ (t >>> 8)) >>> 0;
    return this.w;
  }

  next(): number {
    return (0x7fffffff & this.nextUInt());
  }

  nextDouble(): number {
    return (1 / 2147483648) * this.next();
  }

  nextIntUpper(upperBound: number): number {
    return Math.trunc(this.nextDouble() * upperBound);
  }

  nextIntRange(lowerBound: number, upperBound: number): number {
    return Math.trunc(lowerBound + this.nextDouble() * (upperBound - lowerBound));
  }

  nextBool(): boolean {
    if (this.bitIndex === 32) {
      this.bitBuffer = this.nextUInt();
      this.bitIndex = 1;
      return (this.bitBuffer & 1) === 1;
    }
    this.bitIndex++;
    this.bitBuffer >>>= 1;
    return (this.bitBuffer & 1) === 1;
  }
}

function findLastAtOrBefore<T extends { time: number }>(points: T[], time: number): T | null {
  if (points.length === 0 || time < points[0].time) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (points[mid].time <= time) lo = mid;
    else hi = mid - 1;
  }
  return points[lo];
}

function timingBeatLengthAt(beatmap: StdConvertBeatmap, time: number): number {
  const point = findLastAtOrBefore(beatmap.timingPoints, time);
  if (point) return point.beatLength;
  // Lazer falls back to the first timing point, then TimingControlPoint.DEFAULT (1000ms).
  return beatmap.timingPoints[0]?.beatLength ?? 1000;
}

function sliderVelocityAt(beatmap: StdConvertBeatmap, time: number): number {
  return findLastAtOrBefore(beatmap.difficultyPoints, time)?.sliderVelocity ?? 1;
}

function kiaiAt(beatmap: StdConvertBeatmap, time: number): boolean {
  return findLastAtOrBefore(beatmap.effectPoints, time)?.kiai ?? false;
}

/** LegacyRulesetExtensions.GetPrecisionAdjustedBeatLength for the mania ruleset. */
function getPrecisionAdjustedBeatLength(sliderVelocity: number, timingBeatLength: number): number {
  const sliderVelocityAsBeatLength = -100 / sliderVelocity;
  const bpmMultiplier = sliderVelocityAsBeatLength < 0
    ? Math.min(Math.max(fround(-sliderVelocityAsBeatLength), 10), 10000) / 100.0
    : 1;
  return timingBeatLength * bpmMultiplier;
}

interface GenNote {
  column: number;
  startTime: number;
  endTime: number;
  isHold: boolean;
  sample: ConvertSampleInfo | null;
}

class Pattern {
  notes: GenNote[] = [];
  private columns = new Set<number>();

  columnHasObject(column: number): boolean {
    return this.columns.has(column);
  }

  get columnWithObjects(): number {
    return this.columns.size;
  }

  add(note: GenNote): void {
    this.notes.push(note);
    this.columns.add(note.column);
  }

  addPattern(other: Pattern): void {
    for (const note of other.notes) this.add(note);
  }

  clear(): void {
    this.notes = [];
    this.columns.clear();
  }
}

interface ConversionContext {
  rng: LegacyRandom;
  totalColumns: number;
  randomStart: number;
  beatmap: StdConvertBeatmap;
  conversionDifficulty: number;
}

/** The stable "conversion difficulty" factor (Patterns/Legacy/LegacyPatternGenerator.cs). */
function computeConversionDifficulty(beatmap: StdConvertBeatmap): number {
  const objects = beatmap.hitObjects;
  const lastTime = objects.length > 0 ? objects[objects.length - 1].startTime : 0;
  const firstTime = objects.length > 0 ? objects[0].startTime : 0;

  let drainTime = Math.trunc((lastTime - firstTime - beatmap.totalBreakTime) / 1000);
  if (drainTime === 0) drainTime = 10000;

  const clampedAr = Math.min(Math.max(beatmap.approachRate, 4), 7);
  const value = (fround(beatmap.drainRate + clampedAr) / 1.5 + (objects.length / drainTime) * 9) / 38 * 5 / 1.15;
  return Math.min(value, 12);
}

function computeSeed(beatmap: StdConvertBeatmap): number {
  // (int)MathF.Round(HP + CS) * 20 + (int)(OD * 41.2) + (int)MathF.Round(AR)
  return Math.trunc(roundHalfEven(fround(beatmap.drainRate + beatmap.circleSize))) * 20
    + Math.trunc(beatmap.overallDifficulty * 41.2)
    + Math.trunc(roundHalfEven(beatmap.approachRate));
}

/** Default convert column count when no keymod forces one (ManiaBeatmapConverter.getColumnCount). */
export function getConvertColumnCount(beatmap: StdConvertBeatmap): number {
  const roundedCircleSize = roundHalfEven(beatmap.circleSize);
  const roundedOverallDifficulty = roundHalfEven(beatmap.overallDifficulty);
  const totalObjectCount = beatmap.hitObjects.length;
  let endTimeObjectCount = 0;
  for (const obj of beatmap.hitObjects) {
    if (obj.kind !== "circle") endTimeObjectCount++;
  }

  if (totalObjectCount > 0) {
    const percentSpecialObjects = endTimeObjectCount / totalObjectCount;
    if (percentSpecialObjects < 0.2) return 7;
    if (percentSpecialObjects < 0.3 || roundedCircleSize >= 5) return roundedOverallDifficulty > 5 ? 7 : 6;
    if (percentSpecialObjects > 0.6) return roundedOverallDifficulty > 4 ? 5 : 4;
  }

  return Math.max(4, Math.min(Math.trunc(roundedOverallDifficulty) + 1, 7));
}

interface FindColumnOptions {
  lowerBound?: number | null;
  upperBound?: number | null;
  nextColumn?: (last: number) => number;
  validation?: (column: number) => boolean;
  patterns: Pattern[];
}

abstract class LegacyGenerator {
  protected readonly ctx: ConversionContext;
  protected readonly hitObject: StdHitObject;
  protected readonly previousPattern: Pattern;

  constructor(ctx: ConversionContext, hitObject: StdHitObject, previousPattern: Pattern) {
    this.ctx = ctx;
    this.hitObject = hitObject;
    this.previousPattern = previousPattern;
  }

  protected get totalColumns(): number {
    return this.ctx.totalColumns;
  }

  protected get randomStart(): number {
    return this.ctx.randomStart;
  }

  protected get conversionDifficulty(): number {
    return this.ctx.conversionDifficulty;
  }

  protected getColumn(position: number, allowSpecial = false): number {
    if (allowSpecial && this.totalColumns === 8) {
      const divisor = fround(512 / 7);
      return Math.min(Math.max(Math.floor(fround(fround(position) / divisor)), 0), 6) + 1;
    }
    const divisor = fround(512 / this.totalColumns);
    return Math.min(Math.max(Math.floor(fround(fround(position) / divisor)), 0), this.totalColumns - 1);
  }

  protected getRandomNoteCountBase(p2: number, p3: number, p4 = 0, p5 = 0, p6 = 0): number {
    const val = this.ctx.rng.nextDouble();
    if (val >= 1 - p6) return 6;
    if (val >= 1 - p5) return 5;
    if (val >= 1 - p4) return 4;
    if (val >= 1 - p3) return 3;
    return val >= 1 - p2 ? 2 : 1;
  }

  protected getRandomColumn(lowerBound?: number | null, upperBound?: number | null): number {
    return this.ctx.rng.nextIntRange(lowerBound ?? this.randomStart, upperBound ?? this.totalColumns);
  }

  protected findAvailableColumn(initialColumn: number, options: FindColumnOptions): number {
    const lowerBound = options.lowerBound ?? this.randomStart;
    const upperBound = options.upperBound ?? this.totalColumns;
    const nextColumn = options.nextColumn ?? (() => this.getRandomColumn(lowerBound, upperBound));

    const isValid = (column: number): boolean => {
      if (options.validation && !options.validation(column)) return false;
      for (const pattern of options.patterns) {
        if (pattern.columnHasObject(column)) return false;
      }
      return true;
    };

    if (isValid(initialColumn)) return initialColumn;

    let hasValidColumns = false;
    for (let i = lowerBound; i < upperBound; i++) {
      hasValidColumns = isValid(i);
      if (hasValidColumns) break;
    }
    if (!hasValidColumns) throw new NotEnoughColumnsError();

    let column = initialColumn;
    do {
      column = nextColumn(column);
    } while (!isValid(column));
    return column;
  }
}

/** Patterns/Legacy/HitCirclePatternGenerator.cs */
class HitCircleGenerator extends LegacyGenerator {
  stairType: number;
  private convertType = 0;

  constructor(
    ctx: ConversionContext,
    hitObject: StdHitObject,
    previousPattern: Pattern,
    previousTime: number,
    previousX: number,
    previousY: number,
    density: number,
    lastStair: number,
  ) {
    super(ctx, hitObject, previousPattern);
    this.stairType = lastStair;

    const beatLength = timingBeatLengthAt(ctx.beatmap, hitObject.startTime);
    const kiai = kiaiAt(ctx.beatmap, hitObject.startTime);

    // Vector2 math happens on floats in lazer.
    const dx = fround(hitObject.x - previousX);
    const dy = fround(hitObject.y - previousY);
    const positionSeparation = fround(Math.sqrt(fround(fround(dx * dx) + fround(dy * dy))));
    const timeSeparation = hitObject.startTime - previousTime;

    if (timeSeparation <= 80) {
      this.convertType |= FORCE_NOT_STACK | KEEP_SINGLE;
    } else if (timeSeparation <= 95) {
      this.convertType |= FORCE_NOT_STACK | KEEP_SINGLE | lastStair;
    } else if (timeSeparation <= 105) {
      this.convertType |= FORCE_NOT_STACK | LOW_PROBABILITY;
    } else if (timeSeparation <= 125) {
      this.convertType |= FORCE_NOT_STACK;
    } else if (timeSeparation <= 135 && positionSeparation < 20) {
      this.convertType |= CYCLE | KEEP_SINGLE;
    } else if (timeSeparation <= 150 && positionSeparation < 20) {
      this.convertType |= FORCE_STACK | LOW_PROBABILITY;
    } else if (positionSeparation < 20 && density >= beatLength / 2.5) {
      this.convertType |= REVERSE | LOW_PROBABILITY;
    } else if (density < beatLength / 2.5 || kiai) {
      // High density.
    } else {
      this.convertType |= LOW_PROBABILITY;
    }

    if (!(this.convertType & KEEP_SINGLE)) {
      if ((hitObject.samples.additions & HITSOUND_FINISH) && this.totalColumns !== 8) {
        this.convertType |= MIRROR;
      } else if (hitObject.samples.additions & HITSOUND_CLAP) {
        this.convertType |= GATHERED;
      }
    }
  }

  generate(): Pattern {
    const pattern = this.generateCore();

    for (const note of pattern.notes) {
      if ((this.convertType & STAIR) && note.column === this.totalColumns - 1) this.stairType = REVERSE_STAIR;
      if ((this.convertType & REVERSE_STAIR) && note.column === this.randomStart) this.stairType = STAIR;
    }

    return pattern;
  }

  private generateCore(): Pattern {
    const pattern = new Pattern();

    if (this.totalColumns === 1) {
      this.addToPattern(pattern, 0);
      return pattern;
    }

    const lastColumn = this.previousPattern.notes[0]?.column ?? 0;

    if ((this.convertType & REVERSE) && this.previousPattern.notes.length > 0) {
      // Generate a new pattern by copying the last hit objects in reverse-column order.
      for (let i = this.randomStart; i < this.totalColumns; i++) {
        if (this.previousPattern.columnHasObject(i)) this.addToPattern(pattern, this.randomStart + this.totalColumns - i - 1);
      }
      return pattern;
    }

    if ((this.convertType & CYCLE) && this.previousPattern.notes.length === 1
      // If we convert to 7K + 1, let's not overload the special key.
      && (this.totalColumns !== 8 || lastColumn !== 0)
      // Make sure the last column was not the centre column.
      && (this.totalColumns % 2 === 0 || lastColumn !== Math.trunc(this.totalColumns / 2))) {
      const column = this.randomStart + this.totalColumns - lastColumn - 1;
      this.addToPattern(pattern, column);
      return pattern;
    }

    if ((this.convertType & FORCE_STACK) && this.previousPattern.notes.length > 0) {
      // Generate a new pattern by placing on the already filled columns.
      for (let i = this.randomStart; i < this.totalColumns; i++) {
        if (this.previousPattern.columnHasObject(i)) this.addToPattern(pattern, i);
      }
      return pattern;
    }

    if (this.previousPattern.notes.length === 1) {
      if (this.convertType & STAIR) {
        let targetColumn = lastColumn + 1;
        if (targetColumn === this.totalColumns) targetColumn = this.randomStart;
        this.addToPattern(pattern, targetColumn);
        return pattern;
      }

      if (this.convertType & REVERSE_STAIR) {
        let targetColumn = lastColumn - 1;
        if (targetColumn === this.randomStart - 1) targetColumn = this.totalColumns - 1;
        this.addToPattern(pattern, targetColumn);
        return pattern;
      }
    }

    if (this.convertType & KEEP_SINGLE) return this.generateRandomNotes(1);

    if (this.convertType & MIRROR) {
      if (this.conversionDifficulty > 6.5) return this.generateRandomPatternWithMirrored(0.12, 0.38, 0.12);
      if (this.conversionDifficulty > 4) return this.generateRandomPatternWithMirrored(0.12, 0.17, 0);
      return this.generateRandomPatternWithMirrored(0.12, 0, 0);
    }

    if (this.conversionDifficulty > 6.5) {
      if (this.convertType & LOW_PROBABILITY) return this.generateRandomPattern(0.78, 0.42, 0, 0);
      return this.generateRandomPattern(1, 0.62, 0, 0);
    }

    if (this.conversionDifficulty > 4) {
      if (this.convertType & LOW_PROBABILITY) return this.generateRandomPattern(0.35, 0.08, 0, 0);
      return this.generateRandomPattern(0.52, 0.15, 0, 0);
    }

    if (this.conversionDifficulty > 2) {
      if (this.convertType & LOW_PROBABILITY) return this.generateRandomPattern(0.18, 0, 0, 0);
      return this.generateRandomPattern(0.45, 0, 0, 0);
    }

    return this.generateRandomPattern(0, 0, 0, 0);
  }

  private generateRandomNotes(noteCount: number): Pattern {
    const pattern = new Pattern();

    const allowStacking = !(this.convertType & FORCE_NOT_STACK);
    if (!allowStacking) {
      noteCount = Math.min(noteCount, this.totalColumns - this.randomStart - this.previousPattern.columnWithObjects);
    }

    let nextColumn = this.getColumn(this.hitObject.x, true);

    const getNextColumn = (last: number): number => {
      if (this.convertType & GATHERED) {
        last++;
        if (last === this.totalColumns) last = this.randomStart;
      } else {
        last = this.getRandomColumn();
      }
      return last;
    };

    for (let i = 0; i < noteCount; i++) {
      nextColumn = this.findAvailableColumn(nextColumn, {
        nextColumn: getNextColumn,
        patterns: allowStacking ? [pattern] : [pattern, this.previousPattern],
      });
      this.addToPattern(pattern, nextColumn);
    }

    return pattern;
  }

  private get hasSpecialColumn(): boolean {
    return (this.hitObject.samples.additions & HITSOUND_CLAP) !== 0
      && (this.hitObject.samples.additions & HITSOUND_FINISH) !== 0;
  }

  private generateRandomPattern(p2: number, p3: number, p4: number, p5: number): Pattern {
    const pattern = new Pattern();

    pattern.addPattern(this.generateRandomNotes(this.getRandomNoteCount(p2, p3, p4, p5)));

    if (this.randomStart > 0 && this.hasSpecialColumn) this.addToPattern(pattern, 0);

    return pattern;
  }

  private generateRandomPatternWithMirrored(centreProbability: number, p2: number, p3: number): Pattern {
    if (this.convertType & FORCE_NOT_STACK) {
      return this.generateRandomPattern(1 / 2 + p2 / 2, p2, (p2 + p3) / 2, p3);
    }

    const pattern = new Pattern();

    const { noteCount, addToCentre } = this.getRandomNoteCountMirrored(centreProbability, p2, p3);

    const columnLimit = Math.trunc((this.totalColumns % 2 === 0 ? this.totalColumns : this.totalColumns - 1) / 2);
    let nextColumn = this.getRandomColumn(null, columnLimit);

    for (let i = 0; i < noteCount; i++) {
      nextColumn = this.findAvailableColumn(nextColumn, { upperBound: columnLimit, patterns: [pattern] });

      // Add normal note.
      this.addToPattern(pattern, nextColumn);
      // Add mirrored note.
      this.addToPattern(pattern, this.randomStart + this.totalColumns - nextColumn - 1);
    }

    if (addToCentre) this.addToPattern(pattern, Math.trunc(this.totalColumns / 2));

    if (this.randomStart > 0 && this.hasSpecialColumn) this.addToPattern(pattern, 0);

    return pattern;
  }

  private getRandomNoteCount(p2: number, p3: number, p4: number, p5: number): number {
    switch (this.totalColumns) {
      case 2:
        p2 = 0;
        p3 = 0;
        p4 = 0;
        p5 = 0;
        break;
      case 3:
        p2 = Math.min(p2, 0.1);
        p3 = 0;
        p4 = 0;
        p5 = 0;
        break;
      case 4:
        p2 = Math.min(p2, 0.23);
        p3 = Math.min(p3, 0.04);
        p4 = 0;
        p5 = 0;
        break;
      case 5:
        p3 = Math.min(p3, 0.15);
        p4 = Math.min(p4, 0.03);
        p5 = 0;
        break;
    }

    if (this.hitObject.samples.additions & HITSOUND_CLAP) p2 = 1;

    return this.getRandomNoteCountBase(p2, p3, p4, p5);
  }

  private getRandomNoteCountMirrored(centreProbability: number, p2: number, p3: number): { noteCount: number; addToCentre: boolean } {
    switch (this.totalColumns) {
      case 2:
        centreProbability = 0;
        p2 = 0;
        p3 = 0;
        break;
      case 3:
        centreProbability = Math.min(centreProbability, 0.03);
        p2 = 0;
        p3 = 0;
        break;
      case 4:
        centreProbability = 0;
        // Stable uses inverse probabilities multiplied by 2; convert to and from true probability.
        p2 = 1 - Math.max((1 - p2) * 2, 0.8);
        p3 = 0;
        break;
      case 5:
        centreProbability = Math.min(centreProbability, 0.03);
        p3 = 0;
        break;
      case 6:
        centreProbability = 0;
        p2 = 1 - Math.max((1 - p2) * 2, 0.5);
        p3 = 1 - Math.max((1 - p3) * 2, 0.85);
        break;
    }

    p2 = Math.min(Math.max(p2, 0), 1);
    p3 = Math.min(Math.max(p3, 0), 1);

    const centreVal = this.ctx.rng.nextDouble();
    const noteCount = this.getRandomNoteCountBase(p2, p3);

    const addToCentre = this.totalColumns % 2 !== 0 && noteCount !== 3 && centreVal > 1 - centreProbability;
    return { noteCount, addToCentre };
  }

  private addToPattern(pattern: Pattern, column: number): void {
    pattern.add({
      column,
      startTime: this.hitObject.startTime,
      endTime: this.hitObject.startTime,
      isHold: false,
      sample: this.hitObject.samples,
    });
  }
}

/** Patterns/Legacy/SliderPatternGenerator.cs */
class SliderGenerator extends LegacyGenerator {
  readonly startTime: number;
  readonly endTime: number;
  readonly segmentDuration: number;
  readonly spanCount: number;
  private convertType: number;

  constructor(ctx: ConversionContext, hitObject: StdHitObject, previousPattern: Pattern) {
    super(ctx, hitObject, previousPattern);

    this.convertType = 0;
    if (!kiaiAt(ctx.beatmap, hitObject.startTime)) this.convertType = LOW_PROBABILITY;

    const timingBeatLength = timingBeatLengthAt(ctx.beatmap, hitObject.startTime);
    const beatLength = getPrecisionAdjustedBeatLength(sliderVelocityAt(ctx.beatmap, hitObject.startTime), timingBeatLength);

    this.spanCount = hitObject.repeatCount + 1;
    this.startTime = Math.trunc(roundHalfEven(hitObject.startTime));

    const distance = hitObject.length ?? 0;

    // This matches stable's calculation.
    this.endTime = Math.floor(this.startTime + distance * beatLength * this.spanCount * 0.01 / ctx.beatmap.sliderMultiplier);
    this.segmentDuration = Math.trunc((this.endTime - this.startTime) / this.spanCount);
  }

  generate(): Pattern[] {
    const originalPattern = this.generateInner();

    if (originalPattern.notes.length === 1) return [originalPattern];

    // Split the pattern so that objects ending at EndTime seed further pattern generation.
    const intermediatePattern = new Pattern();
    const endTimePattern = new Pattern();

    for (const note of originalPattern.notes) {
      const noteEndTime = note.isHold ? note.endTime : note.startTime;
      if (this.endTime !== Math.trunc(roundHalfEven(noteEndTime))) intermediatePattern.add(note);
      else endTimePattern.add(note);
    }

    return [intermediatePattern, endTimePattern];
  }

  private generateInner(): Pattern {
    if (this.totalColumns === 1) {
      const pattern = new Pattern();
      this.addToPattern(pattern, 0, this.startTime, this.endTime);
      return pattern;
    }

    if (this.spanCount > 1) {
      if (this.segmentDuration <= 90) return this.generateRandomHoldNotes(this.startTime, 1);

      if (this.segmentDuration <= 120) {
        this.convertType |= FORCE_NOT_STACK;
        return this.generateRandomNotes(this.startTime, this.spanCount + 1);
      }

      if (this.segmentDuration <= 160) return this.generateStair(this.startTime);

      if (this.segmentDuration <= 200 && this.conversionDifficulty > 3) return this.generateRandomMultipleNotes(this.startTime);

      const duration = this.endTime - this.startTime;
      if (duration >= 4000) return this.generateNRandomNotes(this.startTime, 0.23, 0, 0);

      if (this.segmentDuration > 400 && this.spanCount < this.totalColumns - 1 - this.randomStart) {
        return this.generateTiledHoldNotes(this.startTime);
      }

      return this.generateHoldAndNormalNotes(this.startTime);
    }

    if (this.segmentDuration <= 110) {
      if (this.previousPattern.columnWithObjects < this.totalColumns) this.convertType |= FORCE_NOT_STACK;
      else this.convertType &= ~FORCE_NOT_STACK;
      return this.generateRandomNotes(this.startTime, this.segmentDuration < 80 ? 1 : 2);
    }

    if (this.conversionDifficulty > 6.5) {
      if (this.convertType & LOW_PROBABILITY) return this.generateNRandomNotes(this.startTime, 0.78, 0.3, 0);
      return this.generateNRandomNotes(this.startTime, 0.85, 0.36, 0.03);
    }

    if (this.conversionDifficulty > 4) {
      if (this.convertType & LOW_PROBABILITY) return this.generateNRandomNotes(this.startTime, 0.43, 0.08, 0);
      return this.generateNRandomNotes(this.startTime, 0.56, 0.18, 0);
    }

    if (this.conversionDifficulty > 2.5) {
      if (this.convertType & LOW_PROBABILITY) return this.generateNRandomNotes(this.startTime, 0.3, 0, 0);
      return this.generateNRandomNotes(this.startTime, 0.37, 0.08, 0);
    }

    if (this.convertType & LOW_PROBABILITY) return this.generateNRandomNotes(this.startTime, 0.17, 0, 0);
    return this.generateNRandomNotes(this.startTime, 0.27, 0, 0);
  }

  private generateRandomHoldNotes(startTime: number, noteCount: number): Pattern {
    const pattern = new Pattern();

    const usableColumns = this.totalColumns - this.randomStart - this.previousPattern.columnWithObjects;
    let nextColumn = this.getRandomColumn();

    for (let i = 0; i < Math.min(usableColumns, noteCount); i++) {
      nextColumn = this.findAvailableColumn(nextColumn, { patterns: [pattern, this.previousPattern] });
      this.addToPattern(pattern, nextColumn, startTime, this.endTime);
    }

    // This can't be combined with the above loop due to RNG.
    for (let i = 0; i < noteCount - usableColumns; i++) {
      nextColumn = this.findAvailableColumn(nextColumn, { patterns: [pattern] });
      this.addToPattern(pattern, nextColumn, startTime, this.endTime);
    }

    return pattern;
  }

  private generateRandomNotes(startTime: number, noteCount: number): Pattern {
    const pattern = new Pattern();

    let nextColumn = this.getColumn(this.hitObject.x, true);
    if ((this.convertType & FORCE_NOT_STACK) && this.previousPattern.columnWithObjects < this.totalColumns) {
      nextColumn = this.findAvailableColumn(nextColumn, { patterns: [this.previousPattern] });
    }

    let lastColumn = nextColumn;

    for (let i = 0; i < noteCount; i++) {
      this.addToPattern(pattern, nextColumn, startTime, startTime);
      nextColumn = this.findAvailableColumn(nextColumn, { validation: (c) => c !== lastColumn, patterns: [] });
      lastColumn = nextColumn;
      startTime += this.segmentDuration;
    }

    return pattern;
  }

  private generateStair(startTime: number): Pattern {
    const pattern = new Pattern();

    let column = this.getColumn(this.hitObject.x, true);
    let increasing = this.ctx.rng.nextDouble() > 0.5;

    for (let i = 0; i <= this.spanCount; i++) {
      this.addToPattern(pattern, column, startTime, startTime);
      startTime += this.segmentDuration;

      // Check if we're at the borders of the stage, and invert the pattern if so.
      if (increasing) {
        if (column >= this.totalColumns - 1) {
          increasing = false;
          column--;
        } else {
          column++;
        }
      } else {
        if (column <= this.randomStart) {
          increasing = true;
          column++;
        } else {
          column--;
        }
      }
    }

    return pattern;
  }

  private generateRandomMultipleNotes(startTime: number): Pattern {
    const pattern = new Pattern();

    const legacy = this.totalColumns >= 4 && this.totalColumns <= 8;
    const interval = this.ctx.rng.nextIntRange(1, this.totalColumns - (legacy ? 1 : 0));

    let nextColumn = this.getColumn(this.hitObject.x, true);

    for (let i = 0; i <= this.spanCount; i++) {
      this.addToPattern(pattern, nextColumn, startTime, startTime);

      nextColumn += interval;
      if (nextColumn >= this.totalColumns - this.randomStart) {
        nextColumn = nextColumn - this.totalColumns - this.randomStart + (legacy ? 1 : 0);
      }
      nextColumn += this.randomStart;

      // If we're in 2K, let's not add many consecutive doubles.
      if (this.totalColumns > 2) this.addToPattern(pattern, nextColumn, startTime, startTime);

      nextColumn = this.getRandomColumn();
      startTime += this.segmentDuration;
    }

    return pattern;
  }

  private generateNRandomNotes(startTime: number, p2: number, p3: number, p4: number): Pattern {
    switch (this.totalColumns) {
      case 2:
        p2 = 0;
        p3 = 0;
        p4 = 0;
        break;
      case 3:
        p2 = Math.min(p2, 0.1);
        p3 = 0;
        p4 = 0;
        break;
      case 4:
        p2 = Math.min(p2, 0.3);
        p3 = Math.min(p3, 0.04);
        p4 = 0;
        break;
      case 5:
        p2 = Math.min(p2, 0.34);
        p3 = Math.min(p3, 0.1);
        p4 = Math.min(p4, 0.03);
        break;
    }

    const isDoubleSample = (sample: ConvertSampleInfo): boolean =>
      (sample.additions & HITSOUND_CLAP) !== 0 || (sample.additions & HITSOUND_FINISH) !== 0;

    let canGenerateTwoNotes = !(this.convertType & LOW_PROBABILITY);
    canGenerateTwoNotes &&= isDoubleSample(this.hitObject.samples) || isDoubleSample(this.sampleInfoListAt(this.startTime));

    if (canGenerateTwoNotes) p2 = 1;

    return this.generateRandomHoldNotes(startTime, this.getRandomNoteCountBase(p2, p3, p4));
  }

  private generateTiledHoldNotes(startTime: number): Pattern {
    const pattern = new Pattern();

    const columnRepeat = Math.min(this.spanCount, this.totalColumns);

    // Due to integer rounding, this is not guaranteed to be the same as endTime.
    const endTime = startTime + this.segmentDuration * this.spanCount;

    let nextColumn = this.getColumn(this.hitObject.x, true);
    if ((this.convertType & FORCE_NOT_STACK) && this.previousPattern.columnWithObjects < this.totalColumns) {
      nextColumn = this.findAvailableColumn(nextColumn, { patterns: [this.previousPattern] });
    }

    for (let i = 0; i < columnRepeat; i++) {
      nextColumn = this.findAvailableColumn(nextColumn, { patterns: [pattern] });
      this.addToPattern(pattern, nextColumn, startTime, endTime);
      startTime += this.segmentDuration;
    }

    return pattern;
  }

  private generateHoldAndNormalNotes(startTime: number): Pattern {
    const pattern = new Pattern();

    let holdColumn = this.getColumn(this.hitObject.x, true);
    if ((this.convertType & FORCE_NOT_STACK) && this.previousPattern.columnWithObjects < this.totalColumns) {
      holdColumn = this.findAvailableColumn(holdColumn, { patterns: [this.previousPattern] });
    }

    // Create the hold note.
    this.addToPattern(pattern, holdColumn, startTime, this.endTime);

    let nextColumn = this.getRandomColumn();
    let noteCount: number;
    if (this.conversionDifficulty > 6.5) noteCount = this.getRandomNoteCountBase(0.63, 0);
    else if (this.conversionDifficulty > 4) noteCount = this.getRandomNoteCountBase(this.totalColumns < 6 ? 0.12 : 0.45, 0);
    else if (this.conversionDifficulty > 2.5) noteCount = this.getRandomNoteCountBase(this.totalColumns < 6 ? 0 : 0.24, 0);
    else noteCount = 0;
    noteCount = Math.min(this.totalColumns - 1, noteCount);

    const headSample = this.sampleInfoListAt(startTime);
    const ignoreHead = !(headSample.additions & (HITSOUND_WHISTLE | HITSOUND_FINISH | HITSOUND_CLAP));

    const rowPattern = new Pattern();

    for (let i = 0; i <= this.spanCount; i++) {
      if (!(ignoreHead && startTime === this.startTime)) {
        for (let j = 0; j < noteCount; j++) {
          nextColumn = this.findAvailableColumn(nextColumn, { validation: (c) => c !== holdColumn, patterns: [rowPattern] });
          this.addToPattern(rowPattern, nextColumn, startTime, startTime);
        }
      }

      pattern.addPattern(rowPattern);
      rowPattern.clear();

      startTime += this.segmentDuration;
    }

    return pattern;
  }

  private sampleInfoListAt(time: number): ConvertSampleInfo {
    const nodes = this.hitObject.nodeSamples;
    if (!nodes || nodes.length === 0) return this.hitObject.samples;
    const index = this.segmentDuration === 0 ? 0 : Math.trunc((time - this.startTime) / this.segmentDuration);
    return nodes[Math.min(Math.max(index, 0), nodes.length - 1)];
  }

  private addToPattern(pattern: Pattern, column: number, startTime: number, endTime: number): void {
    pattern.add({
      column,
      startTime,
      endTime,
      isHold: startTime !== endTime,
      // Note samples and hold head samples both resolve to the node sample at the start time.
      sample: this.sampleInfoListAt(startTime),
    });
  }
}

/** Patterns/Legacy/SpinnerPatternGenerator.cs */
class SpinnerGenerator extends LegacyGenerator {
  private readonly endTime: number;
  private readonly convertType: number;

  constructor(ctx: ConversionContext, hitObject: StdHitObject, previousPattern: Pattern) {
    super(ctx, hitObject, previousPattern);
    this.endTime = Math.trunc(hitObject.endTime);
    this.convertType = previousPattern.columnWithObjects === this.totalColumns ? 0 : FORCE_NOT_STACK;
  }

  generate(): Pattern {
    const pattern = new Pattern();

    const generateHold = this.endTime - this.hitObject.startTime >= 100;

    if (this.totalColumns === 8
      && (this.hitObject.samples.additions & HITSOUND_FINISH)
      && this.endTime - this.hitObject.startTime < 1000) {
      this.addToPattern(pattern, 0, generateHold);
    } else if (this.totalColumns === 8) {
      this.addToPattern(pattern, this.getRandomAvailableColumn(null), generateHold);
    } else {
      this.addToPattern(pattern, this.getRandomAvailableColumn(0), generateHold);
    }

    return pattern;
  }

  private getRandomAvailableColumn(lowerBound: number | null): number {
    if (this.convertType & FORCE_NOT_STACK) {
      return this.findAvailableColumn(this.getRandomColumn(lowerBound), { lowerBound, patterns: [this.previousPattern] });
    }
    return this.findAvailableColumn(this.getRandomColumn(lowerBound), { lowerBound, patterns: [] });
  }

  private addToPattern(pattern: Pattern, column: number, holdNote: boolean): void {
    const samples = this.hitObject.samples;
    if (holdNote) {
      // The hold head plays only the hitnormal part of the spinner's samples.
      const headSample: ConvertSampleInfo | null = samples.hasNormal
        ? { ...samples, additions: 0, filename: undefined }
        : null;
      pattern.add({
        column,
        startTime: this.hitObject.startTime,
        endTime: this.endTime,
        isHold: true,
        sample: headSample,
      });
    } else {
      pattern.add({
        column,
        startTime: this.hitObject.startTime,
        endTime: this.hitObject.startTime,
        isHold: false,
        sample: samples,
      });
    }
  }
}

export interface ConvertDebugInfo {
  objectIndex: number;
  rng: { x: number; y: number; z: number; w: number };
  notes: ConvertedManiaNote[];
}

/**
 * Runs the full std -> mania conversion. targetColumns must already account for
 * any xK keymod; pass getConvertColumnCount(beatmap) when no keymod is active.
 * Returned notes are stably sorted by start time.
 */
export function convertStdBeatmapToMania(
  beatmap: StdConvertBeatmap,
  targetColumns: number,
  onObjectConverted?: (info: ConvertDebugInfo) => void,
): ConvertedManiaNote[] {
  const rng = new LegacyRandom(computeSeed(beatmap));
  const ctx: ConversionContext = {
    rng,
    totalColumns: targetColumns,
    randomStart: targetColumns === 8 ? 1 : 0,
    beatmap,
    conversionDifficulty: computeConversionDifficulty(beatmap),
  };

  let lastPattern = new Pattern();
  let lastStair = STAIR;
  let lastTime = 0;
  let lastX = 0;
  let lastY = 0;
  const prevNoteTimes: number[] = [];
  let density = INT_MAX;

  const computeDensity = (newNoteTime: number): void => {
    if (prevNoteTimes.length === 7) prevNoteTimes.shift();
    prevNoteTimes.push(newNoteTime);
    if (prevNoteTimes.length >= 2) {
      density = (prevNoteTimes[prevNoteTimes.length - 1] - prevNoteTimes[0]) / prevNoteTimes.length;
    }
  };

  const recordNote = (time: number, x: number, y: number): void => {
    lastTime = time;
    lastX = x;
    lastY = y;
  };

  const output: ConvertedManiaNote[] = [];

  for (let index = 0; index < beatmap.hitObjects.length; index++) {
    const obj = beatmap.hitObjects[index];
    const generated: ConvertedManiaNote[] = [];

    switch (obj.kind) {
      case "circle": {
        // Density is intentionally computed before the generator reads it.
        computeDensity(obj.startTime);
        const generator = new HitCircleGenerator(ctx, obj, lastPattern, lastTime, lastX, lastY, density, lastStair);
        recordNote(obj.startTime, obj.x, obj.y);
        const pattern = generator.generate();
        lastStair = generator.stairType;
        lastPattern = pattern;
        generated.push(...pattern.notes);
        break;
      }

      case "slider": {
        const generator = new SliderGenerator(ctx, obj, lastPattern);
        for (let i = 0; i <= generator.spanCount; i++) {
          const time = obj.startTime + generator.segmentDuration * i;
          recordNote(time, obj.x, obj.y);
          computeDensity(time);
        }
        for (const pattern of generator.generate()) {
          lastPattern = pattern;
          generated.push(...pattern.notes);
        }
        break;
      }

      case "spinner": {
        const generator = new SpinnerGenerator(ctx, obj, lastPattern);
        recordNote(obj.endTime, 256, 192);
        computeDensity(obj.endTime);
        generated.push(...generator.generate().notes);
        break;
      }

      case "hold": {
        // BMS-style holds inside a non-mania file pass through at their x position.
        recordNote(obj.endTime, obj.x, obj.y);
        computeDensity(obj.endTime);
        const divisor = fround(512 / targetColumns);
        const column = Math.min(Math.max(Math.floor(fround(fround(obj.x) / divisor)), 0), targetColumns - 1);
        const isHold = obj.endTime > obj.startTime;
        generated.push({
          column,
          startTime: obj.startTime,
          endTime: isHold ? obj.endTime : obj.startTime,
          isHold,
          sample: isHold && obj.samples.hasNormal
            ? { ...obj.samples, additions: 0, filename: undefined }
            : obj.samples,
        });
        break;
      }
    }

    output.push(...generated);
    onObjectConverted?.({ objectIndex: index, rng: { x: rng.x, y: rng.y, z: rng.z, w: rng.w }, notes: generated });
  }

  return output.slice().sort((a, b) => a.startTime - b.startTime);
}
