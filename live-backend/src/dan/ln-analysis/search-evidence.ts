import type { ManiaTimingPoint } from "../beatmap-parser.js";
import type { LnTimeline4K } from "./timeline.js";

export const LN_SEARCH_EVIDENCE_VERSION = 2;
// A shield is a tap right before a hold in the same column; a reverse shield
// is a tap right after a hold's release in the same column. "Right before"
// means a quarter-beat snap or tighter (0.3 beats leaves room for 1/6 and
// timing drift). On the 300 most played 4K LN charts the half-beat pairs are
// ordinary tap/hold alternation that nobody reads as a shield: a 5-minute LN
// chart had 147 half-beat pairs and 17 quarter-beat ones and no shield
// section, while a chart known for its shields had 138 quarter-beat pairs on
// 2,572 holds (5.4%) and a shield-heavy one 724 on 4,980 (14.5%). Each share
// bar sits at its own top quarter of that corpus: shields are rare (median
// 0%), a tap right after a release is the common LN texture (median 7%), so
// the reverse bar is higher. The count bar keeps short charts from tagging on
// a handful of pairs.
export const LN_SHIELD_MAX_BEATS = 0.3;
export const LN_SHIELD_MIN_SHARE = 0.03;
export const LN_REVERSE_SHIELD_MIN_SHARE = 0.12;
export const LN_SHIELD_MIN_HOLDS = 20;
// Beat length used when the chart carries no timing data (180 BPM).
export const LN_DEFAULT_BEAT_MS = 60000 / 180;

export interface LnSearchEvidence {
  version: number;
  /** Per tag: qualifying holds and their share of the chart's holds. */
  tags: Record<string, { holds: number; share: number }>;
}

export type BeatLengthAt = (playbackMs: number) => number;

/** Beat length in playback milliseconds at a timeline time, from the chart's
 * uninherited timing points (falling back to its nominal BPM). */
export function beatLengthLookup(
  timing: { timingPoints?: ManiaTimingPoint[] | null; bpm?: number | null } | null | undefined,
  rate = 1,
  originMs = 0,
): BeatLengthAt {
  const fallback = timing?.bpm != null && Number.isFinite(timing.bpm) && timing.bpm > 0 ? 60000 / timing.bpm : LN_DEFAULT_BEAT_MS;
  const points = (timing?.timingPoints ?? [])
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.beatLength) && point.beatLength > 0)
    .sort((a, b) => a.time - b.time);
  const scale = Number.isFinite(rate) && rate > 0 ? rate : 1;
  if (points.length === 0) return () => fallback / scale;
  return (playbackMs) => {
    const chartMs = playbackMs * scale + originMs;
    let beatLength = points[0].beatLength;
    for (const point of points) {
      if (point.time > chartMs) break;
      beatLength = point.beatLength;
    }
    return beatLength / scale;
  };
}

/** Holds, shielded holds and reverse-shielded holds over the whole chart. */
export function countLnShields(timeline: LnTimeline4K, beatLengthAt: BeatLengthAt = () => LN_DEFAULT_BEAT_MS): { holds: number; shields: number; reverse: number } {
  const lanes = new Map<number, LnTimeline4K["objects"]>();
  for (const object of timeline.objects) {
    const lane = lanes.get(object.lane) ?? [];
    lane.push(object);
    lanes.set(object.lane, lane);
  }
  let holds = 0, shields = 0, reverse = 0;
  for (const lane of lanes.values()) {
    lane.sort((a, b) => a.startMs - b.startMs);
    for (let i = 0; i < lane.length; i += 1) {
      const current = lane[i];
      if (current.kind === "hold") holds += 1;
      if (i === 0) continue;
      const previous = lane[i - 1];
      if (previous.kind === "tap" && current.kind === "hold") {
        const gap = current.startMs - previous.startMs;
        if (gap >= 0 && gap <= LN_SHIELD_MAX_BEATS * beatLengthAt(current.startMs)) shields += 1;
      } else if (previous.kind === "hold" && current.kind === "tap") {
        const gap = current.startMs - previous.endMs;
        if (gap >= 0 && gap <= LN_SHIELD_MAX_BEATS * beatLengthAt(current.startMs)) reverse += 1;
      }
    }
  }
  return { holds, shields, reverse };
}

export function buildLnSearchEvidence(timeline: LnTimeline4K, beatLengthAt: BeatLengthAt = () => LN_DEFAULT_BEAT_MS): LnSearchEvidence {
  const result: LnSearchEvidence = { version: LN_SEARCH_EVIDENCE_VERSION, tags: {} };
  if (!timeline.valid) return result;
  const { holds, shields, reverse } = countLnShields(timeline, beatLengthAt);
  if (holds === 0) return result;
  for (const [tag, count, minShare] of [["shield", shields, LN_SHIELD_MIN_SHARE], ["reverse_shield", reverse, LN_REVERSE_SHIELD_MIN_SHARE]] as const) {
    const share = count / holds;
    if (count >= LN_SHIELD_MIN_HOLDS && share >= minShare) result.tags[tag] = { holds: count, share };
  }
  return result;
}
