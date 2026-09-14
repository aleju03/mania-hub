import type { ManiaNote } from "../beatmap-parser.js";
import { buildLnSearchEvidence, type BeatLengthAt, type LnSearchEvidence } from "./search-evidence.js";
import { buildLnTimeline4K, lnFingerprint, type HandMapping4K, type LnChartObject, type LnScoringProfile, type LnTimeline4K } from "./timeline.js";

export const LN_ANALYSIS_VERSION = 2;
export type LnProfileId = "ln_density" | "ln_coordination" | "ln_release" | "ln_inverse";
const PROFILE_NAMES: Record<LnProfileId, string> = {
  ln_density: "LN Density", ln_coordination: "LN Coordination / Control", ln_release: "LN Release", ln_inverse: "LN Inverse",
};

export interface LnDetection {
  tag: string;
  profile: LnProfileId;
  startMs: number;
  endMs: number;
  lanes: number[];
  objectIds: number[];
  objectCount?: number;
  objectIdsTruncated?: boolean;
  evidence: "direct" | "heuristic";
  measurements: Record<string, number | boolean>;
}

export interface LnProfile {
  id: LnProfileId;
  name: string;
  /** Union of annotation spans, including gaps; not a difficulty or work-time measure. */
  coverage: { objects: number; totalObjects: number; objectShare: number; coveredMs: number; chartSpanMs: number; timeShare: number };
  measurements: Record<string, number>;
}

export interface LnAnalysis4K {
  version: number;
  valid: boolean;
  cacheKey: string;
  timeline: LnTimeline4K;
  profiles: Record<LnProfileId, LnProfile>;
  detections: LnDetection[];
  technical: { tags: string[]; source: "detected_interactions" };
  stamina: { sectionMs: number; longestActiveRunMs: Record<LnProfileId, number>; recoveryMs: number[] };
  sections: Array<{ startMs: number; endMs: number; heldAtStart: number; heldAtEnd: number; workload: Record<LnProfileId, number> }>;
}

/** Compact cache/API form; full paired objects and rows remain in the analyzer. */
export type LnStructureSummary4K = Omit<LnAnalysis4K, "timeline" | "sections" | "detections"> & {
  originMs: number;
  playbackRate: number;
  scoring: LnScoringProfile;
  hands: HandMapping4K;
  diagnostics: LnTimeline4K["diagnostics"];
  diagnosticCount: number;
  detections: LnDetection[];
  detectionCount: number;
  detailsTruncated: boolean;
  /** Shield and reverse shield counts over the whole chart; never inferred from the bounded preview. */
  searchEvidence?: LnSearchEvidence;
};

export function summarizeLnStructure4K(analysis: LnAnalysis4K, limit = 128, beatLengthAt?: BeatLengthAt): LnStructureSummary4K {
  const { timeline, sections: _sections, detections, ...summary } = analysis;
  // Interleave tags so a long stream cannot hide every coordination/release
  // example. The full count and truncation flag keep this preview honest.
  const groups = new Map<string, LnDetection[]>();
  for (const detection of detections) {
    const group = groups.get(detection.tag) ?? [];
    group.push(detection); groups.set(detection.tag, group);
  }
  const preview: LnDetection[] = [];
  for (let i = 0; preview.length < limit; i += 1) {
    let added = false;
    for (const group of groups.values()) {
      if (!group[i] || preview.length >= limit) continue;
      preview.push(group[i]); added = true;
    }
    if (!added) break;
  }
  return { ...summary, originMs: timeline.originMs, playbackRate: timeline.playbackRate, scoring: timeline.scoring, hands: timeline.hands,
    searchEvidence: buildLnSearchEvidence(timeline, beatLengthAt),
    diagnostics: timeline.diagnostics.slice(0, 128), diagnosticCount: timeline.diagnostics.length,
    detections: preview.sort((a, b) => a.startMs - b.startMs || a.tag.localeCompare(b.tag, "en-US")).map((detection) => ({ ...detection,
      objectIds: detection.objectIds.slice(0, 64), objectCount: detection.objectIds.length, objectIdsTruncated: detection.objectIds.length > 64 })),
    detectionCount: detections.length, detailsTruncated: preview.length < detections.length };
}

const bits = (mask: number) => { let n = 0; for (; mask; mask &= mask - 1) n += 1; return n; };
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; };
const quantile = (values: number[], fraction: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) * fraction)] : 0; };
const variation = (values: number[]) => {
  const average = mean(values);
  return average > 0 ? Math.sqrt(mean(values.map((value) => (value - average) ** 2))) / average : 0;
};
const endOf = (object: LnChartObject) => object.kind === "hold" ? object.endMs : object.startMs;

function unionMs(intervals: Array<[number, number]>): number {
  let start = 0, end = 0, total = 0;
  for (const [nextStart, nextEnd] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (nextStart > end) { total += end - start; start = nextStart; end = nextEnd; }
    else end = Math.max(end, nextEnd);
  }
  return total + end - start;
}

export function analyzeLnStructure4K(
  notes: readonly ManiaNote[],
  options: { rate?: number; hands?: HandMapping4K; scoring?: Partial<LnScoringProfile> } = {},
): LnAnalysis4K {
  return analyzeLnTimeline4K(buildLnTimeline4K(notes, options));
}

export function lnAnalysisCacheKey(timeline: LnTimeline4K): string {
  return `ln-analysis:${LN_ANALYSIS_VERSION}:${lnFingerprint(timeline.cacheKey)}`;
}

export function analyzeLnTimeline4K(timeline: LnTimeline4K): LnAnalysis4K {
  const holds = timeline.objects.filter((object): object is LnChartObject & { kind: "hold" } => object.kind === "hold");
  const byId = new Map(timeline.objects.map((object) => [object.id, object]));
  const detections: LnDetection[] = [];
  const measurements: Record<LnProfileId, Record<string, number>> = {
    ln_density: {}, ln_coordination: { sameHandActions: 0, oppositeHandActions: 0, heldMaskChanges: 0 }, ln_release: {}, ln_inverse: {},
  };
  const add = (profile: LnProfileId, tag: string, objects: LnChartObject[], values: Record<string, number | boolean> = {},
    evidence: LnDetection["evidence"] = "direct", interval?: [number, number]) => {
    if (!objects.length) return;
    detections.push({ profile, tag, startMs: interval?.[0] ?? Math.min(...objects.map((object) => object.startMs)),
      endMs: interval?.[1] ?? Math.max(...objects.map(endOf)),
      lanes: [...new Set(objects.map((object) => object.lane))].sort(), objectIds: [...new Set(objects.map((object) => object.id))].sort((a, b) => a - b),
      evidence, measurements: values });
  };
  const greatWindow = (64 - 3 * timeline.scoring.od) * timeline.scoring.windowScale;
  const nearMs = greatWindow * 2;
  const headRows = timeline.rows.filter((row) => row.holdHeadMask);
  const tailRows = timeline.rows.filter((row) => row.holdTailMask);
  const headGaps = headRows.slice(1).map((row, i) => row.timeMs - headRows[i].timeMs);
  const tailGaps = tailRows.slice(1).map((row, i) => row.timeMs - tailRows[i].timeMs);
  const durations = holds.map((hold) => hold.endMs - hold.startMs);
  measurements.ln_density = {
    holdHeads: holds.length, headRows: headRows.length, headsPerSecond: timeline.durationMs ? holds.length * 1000 / timeline.durationMs : 0,
    medianDurationMs: median(durations), meanDurationMs: mean(durations), medianHeadGapMs: median(headGaps),
    p10DurationMs: quantile(durations, 0.1), p90DurationMs: quantile(durations, 0.9),
    laneOccupancyShare: timeline.durationMs ? durations.reduce((sum, duration) => sum + duration, 0) / (4 * timeline.durationMs) : 0,
  };
  measurements.ln_release = {
    releases: holds.length, releaseRows: tailRows.length, chordReleaseRows: tailRows.filter((row) => bits(row.holdTailMask) > 1).length,
    medianReleaseGapMs: median(tailGaps), releaseRhythmVariation: variation(tailGaps), exposedReleases: 0,
  };

  // Rows preserve exact timing and simultaneous press/release masks. The
  // active set contains only scheduled holds, never invented tap key-ups.
  const active = new Map<number, LnChartObject & { kind: "hold" }>();
  const previousPress = new Map<number, { timeMs: number; object: LnChartObject }>();
  const workByTime = new Map<number, Record<LnProfileId, number>>();
  const pressRows = timeline.rows.filter((row) => row.tapMask || row.holdHeadMask);
  const pressTimes = pressRows.map((row) => row.timeMs);
  let pressCursor = 0;
  for (const row of timeline.rows) {
    const coordinationActions = new Set<number>();
    const endings = row.tailIds.map((id) => byId.get(id)!);
    for (const object of endings) active.delete(object.lane);
    const presses = [...row.tapIds, ...row.headIds].map((id) => byId.get(id)!);
    for (const press of presses) {
      const same = [...active.values()].filter((held) => held.lane !== press.lane && timeline.hands[held.lane] === timeline.hands[press.lane]);
      const opposite = [...active.values()].filter((held) => timeline.hands[held.lane] !== timeline.hands[press.lane]);
      if (same.length) {
        coordinationActions.add(press.id);
        measurements.ln_coordination.sameHandActions += 1;
        const previous = previousPress.get(press.lane);
        const isJack = previous != null && row.timeMs - previous.timeMs <= nearMs * 2;
        add("ln_coordination", isJack ? "hold_and_jack" : "hold_and_tap", [...same, press],
          { sameHand: true, heldFingers: same.length, previousPressGapMs: previous ? row.timeMs - previous.timeMs : 0 }, "direct", [row.timeMs, row.timeMs]);
        if (active.size >= 2) add("ln_coordination", "held_chord_coordination", [...active.values(), press], { heldFingers: active.size }, "direct", [row.timeMs, row.timeMs]);
        add("ln_coordination", "ln_anchor", [...same, press], { activeWhileHeld: true });
      }
      if (opposite.length) measurements.ln_coordination.oppositeHandActions += 1;
      if (press.kind === "hold") for (const held of active.values()) {
        if (held.startMs >= press.startMs) continue;
        if (press.endMs < held.endMs) add("ln_coordination", "nested_holds", [held, press], { sameHand: timeline.hands[held.lane] === timeline.hands[press.lane] });
        else if (press.endMs > held.endMs) add("ln_coordination", "crossing_holds", [held, press], { sameHand: timeline.hands[held.lane] === timeline.hands[press.lane] });
      }
      previousPress.set(press.lane, { timeMs: row.timeMs, object: press });
    }
    if (endings.length && presses.length) {
      for (const object of [...endings, ...presses]) coordinationActions.add(object.id);
      add("ln_coordination", "press_release_opposition", [...endings, ...presses],
        { sameHand: endings.some((tail) => presses.some((head) => timeline.hands[tail.lane] === timeline.hands[head.lane])),
          exactRearticulation: (row.holdHeadMask & row.holdTailMask) !== 0 }, "direct", [row.timeMs, row.timeMs]);
    }
    if (row.heldBeforeMask && row.holdHeadMask && row.heldBeforeMask !== row.heldAfterMask) {
      add("ln_coordination", "changing_anchor", [...endings, ...presses, ...active.values()],
        { beforeMask: row.heldBeforeMask, afterMask: row.heldAfterMask }, "direct", [row.timeMs, row.timeMs]);
    }
    if (row.heldBeforeMask !== row.heldAfterMask) measurements.ln_coordination.heldMaskChanges += 1;
    if (endings.length) {
      if (endings.length > 1) add("ln_release", "chord_release", endings, { chordSize: endings.length }, "direct", [row.timeMs, row.timeMs]);
      if (active.size) {
        for (const object of endings) coordinationActions.add(object.id);
        add("ln_coordination", "release_while_held", [...endings, ...active.values()], { remainingHeldFingers: active.size }, "direct", [row.timeMs, row.timeMs]);
      }
      while (pressCursor < pressTimes.length && pressTimes[pressCursor] < row.timeMs) pressCursor += 1;
      if (!presses.length) for (const nearby of [pressRows[pressCursor - 1], pressRows[pressCursor]]) {
        if (!nearby || Math.abs(nearby.timeMs - row.timeMs) > greatWindow) continue;
        const nearbyObjects = [...nearby.tapIds, ...nearby.headIds].map((id) => byId.get(id)!);
        const interacting = nearbyObjects.filter((head) => endings.some((tail) => tail.lane !== head.lane && tail.id !== head.id));
        if (!interacting.length) continue;
        for (const tail of endings) coordinationActions.add(tail.id);
        add("ln_coordination", "near_press_release_opposition", [...endings, ...interacting],
          { gapMs: Math.abs(nearby.timeMs - row.timeMs), sameHand: endings.some((tail) => interacting.some((head) => timeline.hands[tail.lane] === timeline.hands[head.lane])) },
          "heuristic", [Math.min(nearby.timeMs, row.timeMs), Math.max(nearby.timeMs, row.timeMs)]);
      }
      const distance = Math.min(Math.abs(row.timeMs - (pressTimes[pressCursor - 1] ?? -Infinity)), Math.abs(row.timeMs - (pressTimes[pressCursor] ?? Infinity)));
      if (distance > greatWindow) {
        measurements.ln_release.exposedReleases += endings.length;
        add("ln_release", "exposed_release", endings, { nearestPressGapMs: Number.isFinite(distance) ? distance : timeline.durationMs }, "heuristic", [row.timeMs, row.timeMs]);
      }
    }
    for (const id of row.headIds) {
      const object = byId.get(id)!;
      if (object.kind === "hold") active.set(object.lane, object);
    }
    workByTime.set(row.timeMs, { ln_density: row.headIds.length, ln_coordination: coordinationActions.size,
      ln_release: row.tailIds.length ? 1 : 0, ln_inverse: 0 });
  }

  for (const row of headRows) {
    const objects = row.headIds.map((id) => byId.get(id)!);
    const count = objects.length;
    add("ln_density", count === 1 ? "ln_head" : "ln_head_chord",
      objects, { newHeadChordSize: count, alreadyHeldLanes: bits(row.heldBeforeMask & ~row.holdTailMask) }, "direct");
    const tails = objects.map(endOf);
    if (new Set(tails).size > 1) add("ln_release", "staggered_release", objects,
      { spreadMs: Math.max(...tails) - Math.min(...tails), releaseGroups: new Set(tails).size }, "direct", [Math.min(...tails), Math.max(...tails)]);
    if (row.tapMask) add("ln_coordination", "hybrid_layering", [...objects, ...row.tapIds.map((id) => byId.get(id)!)], { tapChordSize: bits(row.tapMask), holdChordSize: count });
  }

  const inverseLanes: number[] = [];
  const allRepressGaps: number[] = [];
  for (let lane = 0; lane < 4; lane += 1) {
    const laneObjects = timeline.objects.filter((object) => object.lane === lane);
    const localGaps = laneObjects.slice(1).map((object, i) => object.startMs - laneObjects[i].startMs);
    const typical = median(localGaps);
    const inverseRuns: Array<Array<{ left: LnChartObject & { kind: "hold" }; right: LnChartObject & { kind: "hold" }; gap: number; fraction: number }>> = [[]];
    for (let i = 0; i < laneObjects.length; i += 1) {
      const object = laneObjects[i], next = laneObjects[i + 1];
      if (object.kind === "hold" && typical > 0 && object.endMs - object.startMs < typical * 0.4) {
        add("ln_density", "short_hold", [object], { durationMs: object.endMs - object.startMs, localHeadIntervalMs: typical,
          durationFraction: (object.endMs - object.startMs) / typical }, "heuristic");
      }
      if (!next) continue;
      const headGap = next.startMs - object.startMs;
      const gap = next.startMs - endOf(object);
      if (object.kind === "tap" && next.kind === "hold" && headGap >= 0 && headGap <= Math.max(nearMs, typical * 0.35)) {
        add("ln_coordination", "shield", [object, next], { gapMs: headGap, relativeToGreatWindow: headGap / greatWindow }, "heuristic", [object.startMs, next.startMs]);
      }
      if (object.kind === "hold" && next.kind === "tap" && gap >= 0 && gap <= Math.max(nearMs, typical * 0.35)) {
        add("ln_coordination", "reverse_shield", [object, next], { gapMs: gap, relativeToGreatWindow: gap / greatWindow }, "heuristic", [object.endMs, next.startMs]);
      }
      if (object.kind === "hold" && next.kind === "hold" && headGap > 0 && gap >= 0) {
        allRepressGaps.push(gap);
        add("ln_release", "ln_rearticulation", [object, next], { headGapMs: headGap, repressGapMs: gap, gapFraction: gap / headGap }, "direct", [object.endMs, next.startMs]);
        if (gap / headGap <= 0.45) inverseRuns[inverseRuns.length - 1].push({ left: object, right: next, gap, fraction: gap / headGap });
      }
      if (!(object.kind === "hold" && next.kind === "hold" && headGap > 0 && gap >= 0 && gap / headGap <= 0.45)
        && inverseRuns[inverseRuns.length - 1].length) {
        inverseRuns.push([]);
      }
    }
    for (const inversePairs of inverseRuns) if (inversePairs.length >= 2) {
      // Recurring gaps plus occupancy, not static walls or a content ratio.
      const objects = [...new Map(inversePairs.flatMap((pair) => [pair.left, pair.right]).map((object) => [object.id, object])).values()];
      const span = objects[objects.length - 1].endMs - objects[0].startMs;
      const occupancy = span > 0 ? objects.reduce((sum, object) => sum + object.endMs - object.startMs, 0) / span : 0;
      if (occupancy >= 0.6) {
        for (const pair of inversePairs) workByTime.get(pair.right.startMs)!.ln_inverse += 1;
        if (!inverseLanes.includes(lane)) inverseLanes.push(lane);
        const gaps = inversePairs.map((pair) => pair.gap);
        add("ln_inverse", "inverse", objects, { recurringGaps: gaps.length, laneOccupancy: occupancy,
          meanGapMs: mean(gaps), gapVariation: variation(gaps), medianGapFraction: median(inversePairs.map((pair) => pair.fraction)) }, "heuristic");
        if (variation(gaps) > 0.2) add("ln_inverse", "variable_gap_inverse", objects, { gapVariation: variation(gaps) }, "heuristic");
      }
    }
  }
  const inverseDetections = detections.filter((detection) => detection.tag === "inverse");
  for (const detection of inverseDetections) {
    const lanes = new Set(inverseDetections.filter((other) => other.startMs < detection.endMs && other.endMs > detection.startMs).flatMap((other) => other.lanes));
    if (lanes.size < 4) add("ln_inverse", "partial_lane_inverse", detection.objectIds.map((id) => byId.get(id)!),
      { participatingLanes: lanes.size }, "heuristic", [detection.startMs, detection.endMs]);
  }
  measurements.ln_inverse = { inverseLanes: inverseLanes.length, rearticulations: allRepressGaps.length,
    meanRepressGapMs: mean(allRepressGaps), repressGapVariation: variation(allRepressGaps) };

  // Direction and alternation are descriptors of the head/release sequence,
  // independent of pace. Nearby distinct times remain distinct rows.
  for (const [sequence, profile, prefix] of [[headRows, "ln_density", "ln"], [tailRows, "ln_release", "release"]] as const) {
    for (let i = 3; i < sequence.length; i += 1) {
      const rows = sequence.slice(i - 3, i + 1);
      const masks = rows.map((row) => profile === "ln_density" ? row.holdHeadMask : row.holdTailMask);
      const ids = rows.flatMap((row) => profile === "ln_density" ? row.headIds : row.tailIds);
      const objects = [...new Set(ids)].map((id) => byId.get(id)!);
      const lanes = masks.map((mask) => Math.log2(mask));
      const single = masks.every((mask) => bits(mask) === 1);
      const gaps = rows.slice(1).map((row, j) => row.timeMs - rows[j].timeMs);
      if (Math.max(...gaps) > Math.max(1, median(gaps)) * 3) continue;
      if (profile === "ln_density") {
        const sizes = masks.map(bits);
        add(profile, sizes.every((size) => size > 1) ? "ln_chordstream" : sizes.includes(3) ? "ln_handstream"
          : sizes.includes(2) ? "ln_jumpstream" : "ln_stream", objects, { medianIntervalMs: median(gaps) }, "heuristic", [rows[0].timeMs, rows[3].timeMs]);
      } else add(profile, "release_stream", objects, { medianIntervalMs: median(gaps) }, "heuristic", [rows[0].timeMs, rows[3].timeMs]);
      if (single && lanes.every((lane, j) => j === 0 || lane - lanes[j - 1] === 1 || lane - lanes[j - 1] === -3)
        || single && lanes.every((lane, j) => j === 0 || lane - lanes[j - 1] === -1 || lane - lanes[j - 1] === 3)) {
        add(profile, `${prefix}_stairs`, objects, { medianIntervalMs: median(gaps) }, "heuristic", [rows[0].timeMs, rows[3].timeMs]);
        if (lanes.some((lane, j) => j > 0 && Math.abs(lane - lanes[j - 1]) === 3)) {
          add(profile, `${prefix}_roll`, objects, { medianIntervalMs: median(gaps) }, "heuristic", [rows[0].timeMs, rows[3].timeMs]);
        }
      }
      if (masks[0] === masks[2] && masks[1] === masks[3] && masks[0] !== masks[1]) {
        add(profile, `${prefix}_${single ? "trill" : "chordtrill"}`, objects,
          { medianIntervalMs: median(gaps), sameHand: single && timeline.hands[lanes[0]] === timeline.hands[lanes[1]] }, "heuristic", [rows[0].timeMs, rows[3].timeMs]);
      }
      if (masks.every((mask) => mask === masks[0])) add(profile, `${prefix}_${single ? "jacks" : "chordjacks"}`, objects,
        { medianIntervalMs: median(gaps) }, "heuristic", [rows[0].timeMs, rows[3].timeMs]);
      if (variation(gaps) > 0.35) add(profile, `${prefix}_irregular_rhythm`, objects, { intervalVariation: variation(gaps) }, "heuristic", [rows[0].timeMs, rows[3].timeMs]);
    }
  }
  const headRuns: typeof headRows[] = [[]];
  const burstSeparation = Math.min(1500, Math.max(nearMs * 4, median(headGaps) * 3));
  for (const row of headRows) {
    const run = headRuns[headRuns.length - 1];
    if (run.length && row.timeMs - run[run.length - 1].timeMs > burstSeparation) headRuns.push([]);
    headRuns[headRuns.length - 1].push(row);
  }
  if (headRuns.length > 1) for (const run of headRuns) if (run.length >= 3 && run.length <= 8) {
    add("ln_density", "ln_burst", run.flatMap((row) => row.headIds).map((id) => byId.get(id)!),
      { rows: run.length, spanMs: run[run.length - 1].timeMs - run[0].timeMs }, "heuristic", [run[0].timeMs, run[run.length - 1].timeMs]);
  }
  const shields = detections.filter((detection) => detection.tag === "shield").sort((a, b) => a.startMs - b.startMs);
  const shieldRuns: LnDetection[][] = [[]];
  for (const shield of shields) {
    const run = shieldRuns[shieldRuns.length - 1];
    if (run.length && shield.startMs - run[run.length - 1].startMs > Math.min(1500, Math.max(nearMs * 4, median(headGaps) * 3))) shieldRuns.push([]);
    shieldRuns[shieldRuns.length - 1].push(shield);
  }
  for (const run of shieldRuns) if (run.length >= 3) add("ln_coordination", "shield_stream",
    [...new Set(run.flatMap((detection) => detection.objectIds))].map((id) => byId.get(id)!), { shields: run.length }, "heuristic", [run[0].startMs, run[run.length - 1].endMs]);

  const ids = Object.keys(PROFILE_NAMES) as LnProfileId[];
  const profiles = Object.fromEntries(ids.map((id): [LnProfileId, LnProfile] => {
    const found = detections.filter((detection) => detection.profile === id);
    const covered = new Set(found.flatMap((detection) => detection.objectIds));
    const activeMs = unionMs(found.map((detection) => [detection.startMs, detection.endMs]));
    return [id, { id, name: PROFILE_NAMES[id], measurements: measurements[id],
      coverage: { objects: covered.size, totalObjects: timeline.objects.length, objectShare: covered.size / Math.max(1, timeline.objects.length),
        coveredMs: activeMs, chartSpanMs: timeline.durationMs, timeShare: activeMs / Math.max(1, timeline.durationMs) } }];
  })) as Record<LnProfileId, LnProfile>;
  const sectionMs = 500;
  const sections: LnAnalysis4K["sections"] = [];
  let rowCursor = 0, heldMask = 0;
  for (let start = 0; start < timeline.durationMs; start += sectionMs) {
    const end = Math.min(timeline.durationMs, start + sectionMs);
    while (rowCursor < timeline.rows.length && timeline.rows[rowCursor].timeMs < start) heldMask = timeline.rows[rowCursor++].heldAfterMask;
    const before = heldMask;
    const workload = Object.fromEntries(ids.map((id) => [id, 0])) as Record<LnProfileId, number>;
    while (rowCursor < timeline.rows.length && (timeline.rows[rowCursor].timeMs < end || end === timeline.durationMs && timeline.rows[rowCursor].timeMs === end)) {
      const row = timeline.rows[rowCursor++];
      heldMask = row.heldAfterMask;
      const work = workByTime.get(row.timeMs)!;
      for (const id of ids) workload[id] += work[id];
    }
    sections.push({ startMs: start, endMs: end, heldAtStart: before, heldAtEnd: heldMask, workload });
  }
  const longestActiveRunMs = Object.fromEntries(ids.map((id) => {
    let longest = 0, current = 0;
    for (const section of sections) { current = section.workload[id] ? current + section.endMs - section.startMs : 0; longest = Math.max(longest, current); }
    return [id, longest];
  })) as Record<LnProfileId, number>;
  const activeTimes = [...new Set(detections.map((detection) => detection.startMs))].sort((a, b) => a - b);
  const recoveryMs = activeTimes.slice(1).map((time, i) => time - activeTimes[i]).filter((gap) => gap > sectionMs);
  const technicalTags = [...new Set(detections.filter((detection) => ["nested_holds", "crossing_holds", "press_release_opposition", "hybrid_layering",
    "near_press_release_opposition", "changing_anchor", "variable_gap_inverse", "ln_irregular_rhythm", "release_irregular_rhythm"].includes(detection.tag)).map((detection) => detection.tag))];
  return { version: LN_ANALYSIS_VERSION, valid: timeline.valid,
    cacheKey: lnAnalysisCacheKey(timeline),
    timeline, profiles, detections, technical: { tags: technicalTags, source: "detected_interactions" },
    sections, stamina: { sectionMs, longestActiveRunMs, recoveryMs } };
}
