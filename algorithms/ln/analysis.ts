// Structural reading of a 4K LN chart: which LN interactions occur, where,
// and how much of the chart they cover, grouped into four profiles (density,
// coordination, release, inverse). This is measured structure only. It
// carries no rating; the LN difficulty number comes from ./skill.

import type { ManiaNote } from "../chart/beatmap";
import { buildLnTimeline4K, type HandMapping4K, type LnChartObject, type LnScoringProfile, type LnTimeline4K } from "./timeline";

export type LnProfileId = "ln_density" | "ln_coordination" | "ln_release" | "ln_inverse";

export interface LnDetection {
  tag: string;
  profile: LnProfileId;
  startMs: number;
  endMs: number;
  lanes: number[];
  objectIds: number[];
  /** "direct" is read straight off the rows; "heuristic" involves a threshold. */
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
  valid: boolean;
  timeline: LnTimeline4K;
  profiles: Record<LnProfileId, LnProfile>;
  detections: LnDetection[];
  technical: { tags: string[]; source: "detected_interactions" };
  stamina: { sectionMs: number; longestActiveRunMs: Record<LnProfileId, number>; recoveryMs: number[] };
  sections: Array<{ startMs: number; endMs: number; heldAtStart: number; heldAtEnd: number; workload: Record<LnProfileId, number> }>;
}

const PROFILE_NAMES: Record<LnProfileId, string> = {
  ln_density: "LN Density", ln_coordination: "LN Coordination / Control", ln_release: "LN Release", ln_inverse: "LN Inverse",
};

/** Stamina sections, in played ms. Section work counts primitive actions,
 * not how many pattern tags overlap. */
const SECTION_MS = 500;

/** A same-lane hold-to-hold gap at or under this fraction of the head-to-head
 * interval is an inverse link. */
const INVERSE_GAP_FRACTION = 0.45;
/** A run of inverse links counts when the lane is held at least this share of the run's span. */
const INVERSE_MIN_OCCUPANCY = 0.6;

/** Detections whose presence marks a chart as technical. Named interactions only; no generic bonus. */
const TECHNICAL_TAGS = ["nested_holds", "crossing_holds", "press_release_opposition", "hybrid_layering",
  "near_press_release_opposition", "changing_anchor", "variable_gap_inverse", "ln_irregular_rhythm", "release_irregular_rhythm"];

export function analyzeLnStructure4K(
  notes: readonly ManiaNote[],
  options: { rate?: number; hands?: HandMapping4K; scoring?: Partial<LnScoringProfile> } = {},
): LnAnalysis4K {
  return analyzeLnTimeline4K(buildLnTimeline4K(notes, options));
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

  // Head 300 window at the scoring OD (64 - 3 * OD ms). Two windows is "near".
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

  // Row pass: coordination and release interactions. The active set holds
  // only scheduled holds, never invented tap key-ups. Releases on a row are
  // applied before its presses, so a same-lane release and repress read as
  // the lane being free at the press.
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
        // A press while another finger of the same hand is held.
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
      // Releasing and pressing on the same timestamp.
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
      // A release within one 300 window of a press on another lane (but not on the same row).
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
      // An exposed release has no press within one 300 window: it has to be timed on its own.
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

  // Head rows: single heads and head chords, staggered releases of heads
  // pressed together, and holds layered with taps on the same row.
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

  // Per lane: short holds, shields, rearticulation and inverse runs. "Typical"
  // is the lane's median head-to-head interval, so short and close are read
  // against the chart's own pace rather than a fixed ms value.
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
      const closeMs = Math.max(nearMs, typical * 0.35);
      if (object.kind === "tap" && next.kind === "hold" && headGap >= 0 && headGap <= closeMs) {
        add("ln_coordination", "shield", [object, next], { gapMs: headGap, relativeToGreatWindow: headGap / greatWindow }, "heuristic", [object.startMs, next.startMs]);
      }
      if (object.kind === "hold" && next.kind === "tap" && gap >= 0 && gap <= closeMs) {
        add("ln_coordination", "reverse_shield", [object, next], { gapMs: gap, relativeToGreatWindow: gap / greatWindow }, "heuristic", [object.endMs, next.startMs]);
      }
      const inverseLink = object.kind === "hold" && next.kind === "hold" && headGap > 0 && gap >= 0 && gap / headGap <= INVERSE_GAP_FRACTION;
      if (object.kind === "hold" && next.kind === "hold" && headGap > 0 && gap >= 0) {
        allRepressGaps.push(gap);
        add("ln_release", "ln_rearticulation", [object, next], { headGapMs: headGap, repressGapMs: gap, gapFraction: gap / headGap }, "direct", [object.endMs, next.startMs]);
        if (inverseLink) inverseRuns[inverseRuns.length - 1].push({ left: object, right: next, gap, fraction: gap / headGap });
      }
      // Anything that is not an inverse link ends the current run.
      if (!inverseLink && inverseRuns[inverseRuns.length - 1].length) inverseRuns.push([]);
    }
    // Inverse needs recurring gaps (two or more links) and a lane that is
    // mostly held; a static held wall with no gaps is not inverse.
    for (const inversePairs of inverseRuns) if (inversePairs.length >= 2) {
      const objects = [...new Map(inversePairs.flatMap((pair) => [pair.left, pair.right]).map((object) => [object.id, object])).values()];
      const span = objects[objects.length - 1].endMs - objects[0].startMs;
      const occupancy = span > 0 ? objects.reduce((sum, object) => sum + object.endMs - object.startMs, 0) / span : 0;
      if (occupancy >= INVERSE_MIN_OCCUPANCY) {
        for (const pair of inversePairs) workByTime.get(pair.right.startMs)!.ln_inverse += 1;
        if (!inverseLanes.includes(lane)) inverseLanes.push(lane);
        const gaps = inversePairs.map((pair) => pair.gap);
        add("ln_inverse", "inverse", objects, { recurringGaps: gaps.length, laneOccupancy: occupancy,
          meanGapMs: mean(gaps), gapVariation: variation(gaps), medianGapFraction: median(inversePairs.map((pair) => pair.fraction)) }, "heuristic");
        if (variation(gaps) > 0.2) add("ln_inverse", "variable_gap_inverse", objects, { gapVariation: variation(gaps) }, "heuristic");
      }
    }
  }
  // Inverse that never spans all four lanes at once.
  const inverseDetections = detections.filter((detection) => detection.tag === "inverse");
  for (const detection of inverseDetections) {
    const lanes = new Set(inverseDetections.filter((other) => other.startMs < detection.endMs && other.endMs > detection.startMs).flatMap((other) => other.lanes));
    if (lanes.size < 4) add("ln_inverse", "partial_lane_inverse", detection.objectIds.map((id) => byId.get(id)!),
      { participatingLanes: lanes.size }, "heuristic", [detection.startMs, detection.endMs]);
  }
  measurements.ln_inverse = { inverseLanes: inverseLanes.length, rearticulations: allRepressGaps.length,
    meanRepressGapMs: mean(allRepressGaps), repressGapVariation: variation(allRepressGaps) };

  detectSequenceShapes(timeline, headRows, tailRows, byId, add);

  // Bursts: runs of 3-8 head rows separated from the rest by a pause. A
  // chart that is one continuous run has no bursts.
  const burstSeparation = Math.min(1500, Math.max(nearMs * 4, median(headGaps) * 3));
  const headRuns: typeof headRows[] = [[]];
  for (const row of headRows) {
    const run = headRuns[headRuns.length - 1];
    if (run.length && row.timeMs - run[run.length - 1].timeMs > burstSeparation) headRuns.push([]);
    headRuns[headRuns.length - 1].push(row);
  }
  if (headRuns.length > 1) for (const run of headRuns) if (run.length >= 3 && run.length <= 8) {
    add("ln_density", "ln_burst", run.flatMap((row) => row.headIds).map((id) => byId.get(id)!),
      { rows: run.length, spanMs: run[run.length - 1].timeMs - run[0].timeMs }, "heuristic", [run[0].timeMs, run[run.length - 1].timeMs]);
  }

  // Shield streams: three or more shields without a pause between them.
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
  const profiles = buildProfiles(ids, detections, measurements, timeline);
  const sections = buildSections(ids, timeline, workByTime);
  const longestActiveRunMs = Object.fromEntries(ids.map((id) => {
    let longest = 0, current = 0;
    for (const section of sections) {
      current = section.workload[id] ? current + section.endMs - section.startMs : 0;
      longest = Math.max(longest, current);
    }
    return [id, longest];
  })) as Record<LnProfileId, number>;
  // Recovery: pauses longer than one section between detections.
  const activeTimes = [...new Set(detections.map((detection) => detection.startMs))].sort((a, b) => a - b);
  const recoveryMs = activeTimes.slice(1).map((time, i) => time - activeTimes[i]).filter((gap) => gap > SECTION_MS);
  const technicalTags = [...new Set(detections.filter((detection) => TECHNICAL_TAGS.includes(detection.tag)).map((detection) => detection.tag))];
  return { valid: timeline.valid, timeline, profiles, detections, technical: { tags: technicalTags, source: "detected_interactions" },
    sections, stamina: { sectionMs: SECTION_MS, longestActiveRunMs, recoveryMs } };
}

type AddDetection = (profile: LnProfileId, tag: string, objects: LnChartObject[], values?: Record<string, number | boolean>,
  evidence?: LnDetection["evidence"], interval?: [number, number]) => void;

/** Shape of every four consecutive head rows (and, separately, release
 * rows): stream/jumpstream/handstream/chordstream, stairs and rolls, trills,
 * jacks and irregular rhythm. These describe direction and alternation, not
 * pace. A window with one gap over 3x its median gap is skipped. */
function detectSequenceShapes(
  timeline: LnTimeline4K,
  headRows: LnTimeline4K["rows"],
  tailRows: LnTimeline4K["rows"],
  byId: Map<number, LnChartObject>,
  add: AddDetection,
): void {
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
      const interval: [number, number] = [rows[0].timeMs, rows[3].timeMs];
      if (profile === "ln_density") {
        const sizes = masks.map(bits);
        add(profile, sizes.every((size) => size > 1) ? "ln_chordstream" : sizes.includes(3) ? "ln_handstream"
          : sizes.includes(2) ? "ln_jumpstream" : "ln_stream", objects, { medianIntervalMs: median(gaps) }, "heuristic", interval);
      } else add(profile, "release_stream", objects, { medianIntervalMs: median(gaps) }, "heuristic", interval);
      // Stairs step one lane at a time in one direction; a wrap from lane 4
      // to lane 1 (or back) makes it a roll.
      if (single && lanes.every((lane, j) => j === 0 || lane - lanes[j - 1] === 1 || lane - lanes[j - 1] === -3)
        || single && lanes.every((lane, j) => j === 0 || lane - lanes[j - 1] === -1 || lane - lanes[j - 1] === 3)) {
        add(profile, `${prefix}_stairs`, objects, { medianIntervalMs: median(gaps) }, "heuristic", interval);
        if (lanes.some((lane, j) => j > 0 && Math.abs(lane - lanes[j - 1]) === 3)) {
          add(profile, `${prefix}_roll`, objects, { medianIntervalMs: median(gaps) }, "heuristic", interval);
        }
      }
      if (masks[0] === masks[2] && masks[1] === masks[3] && masks[0] !== masks[1]) {
        add(profile, `${prefix}_${single ? "trill" : "chordtrill"}`, objects,
          { medianIntervalMs: median(gaps), sameHand: single && timeline.hands[lanes[0]] === timeline.hands[lanes[1]] }, "heuristic", interval);
      }
      if (masks.every((mask) => mask === masks[0])) add(profile, `${prefix}_${single ? "jacks" : "chordjacks"}`, objects,
        { medianIntervalMs: median(gaps) }, "heuristic", interval);
      if (variation(gaps) > 0.35) add(profile, `${prefix}_irregular_rhythm`, objects, { intervalVariation: variation(gaps) }, "heuristic", interval);
    }
  }
}

/** Coverage per profile: the share of objects any of its detections touch,
 * and the union of their time spans. Coverage describes where a profile
 * appears; it is not additive difficulty. */
function buildProfiles(
  ids: LnProfileId[],
  detections: LnDetection[],
  measurements: Record<LnProfileId, Record<string, number>>,
  timeline: LnTimeline4K,
): Record<LnProfileId, LnProfile> {
  return Object.fromEntries(ids.map((id): [LnProfileId, LnProfile] => {
    const found = detections.filter((detection) => detection.profile === id);
    const covered = new Set(found.flatMap((detection) => detection.objectIds));
    const activeMs = unionMs(found.map((detection) => [detection.startMs, detection.endMs]));
    return [id, { id, name: PROFILE_NAMES[id], measurements: measurements[id],
      coverage: { objects: covered.size, totalObjects: timeline.objects.length, objectShare: covered.size / Math.max(1, timeline.objects.length),
        coveredMs: activeMs, chartSpanMs: timeline.durationMs, timeShare: activeMs / Math.max(1, timeline.durationMs) } }];
  })) as Record<LnProfileId, LnProfile>;
}

/** Splits the chart into 500 ms sections and sums each row's primitive
 * actions per profile. The final row at exactly durationMs lands in the last section. */
function buildSections(
  ids: LnProfileId[],
  timeline: LnTimeline4K,
  workByTime: Map<number, Record<LnProfileId, number>>,
): LnAnalysis4K["sections"] {
  const sections: LnAnalysis4K["sections"] = [];
  let rowCursor = 0, heldMask = 0;
  for (let start = 0; start < timeline.durationMs; start += SECTION_MS) {
    const end = Math.min(timeline.durationMs, start + SECTION_MS);
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
  return sections;
}

function unionMs(intervals: Array<[number, number]>): number {
  let start = 0, end = 0, total = 0;
  for (const [nextStart, nextEnd] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (nextStart > end) { total += end - start; start = nextStart; end = nextEnd; }
    else end = Math.max(end, nextEnd);
  }
  return total + end - start;
}

function bits(mask: number): number {
  let n = 0;
  for (; mask; mask &= mask - 1) n += 1;
  return n;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/** Upper median (index floor(n / 2)), no interpolation. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

/** Nearest-rank quantile at index floor((n - 1) * fraction). */
function quantile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * fraction)] : 0;
}

/** Coefficient of variation (population standard deviation over mean). */
function variation(values: number[]): number {
  const average = mean(values);
  return average > 0 ? Math.sqrt(mean(values.map((value) => (value - average) ** 2))) / average : 0;
}

function endOf(object: LnChartObject): number {
  return object.kind === "hold" ? object.endMs : object.startMs;
}
