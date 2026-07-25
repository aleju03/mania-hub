import { describe, expect, it } from "vitest";
import { calculateManiaStarRating, calculateManiaStarRatingTimeline } from "./mania-star-rating";
import type { StarRatingNote } from "./mania-star-rating";

// Distinct rounded start times (no sort ties), mixed taps and holds so both
// evaluators' hold branches run.
function buildStreamChart(count: number): StarRatingNote[] {
  const notes: StarRatingNote[] = [];
  for (let i = 0; i < count; i++) {
    const time = 500 + i * 137;
    const isHold = i % 5 === 2;
    notes.push({ time, endTime: isHold ? time + 400 : time, column: i % 4 });
  }
  return notes;
}

// Two-note chords (tied rounded times) plus long holds, to cover the
// unstable-sort tie path and the chord DeltaTime <= 1 branch.
function buildChordChart(count: number): StarRatingNote[] {
  const notes: StarRatingNote[] = [];
  for (let i = 0; i < count; i++) {
    const time = 500 + Math.floor(i / 2) * 173;
    const isHold = i % 7 === 3;
    notes.push({ time, endTime: isHold ? time + 600 : time, column: i % 4 });
  }
  return notes;
}

describe("calculateManiaStarRatingTimeline", () => {
  it("matches whole-map star ratings computed on each prefix", () => {
    const notes = buildStreamChart(120);
    const timeline = calculateManiaStarRatingTimeline(notes, 4, 1);

    // One point per processed strain object (the first sorted note is only an
    // anchor and never generates one).
    expect(timeline).toHaveLength(notes.length - 1);

    for (let k = 0; k < timeline.length; k++) {
      const prefixStars = calculateManiaStarRating(notes.slice(0, k + 2), 4, 1);
      expect(timeline[k].stars).toBeCloseTo(prefixStars, 9);
    }
  });

  it("ends exactly at the whole-map star rating", () => {
    for (const rate of [1, 1.5, 0.75]) {
      const notes = buildChordChart(400);
      const timeline = calculateManiaStarRatingTimeline(notes, 4, rate);
      const full = calculateManiaStarRating(notes, 4, rate);
      expect(timeline[timeline.length - 1].stars).toBe(full);
      expect(full).toBeGreaterThan(0);
    }
  });

  it("produces strictly increasing times and non-decreasing star ratings", () => {
    const timeline = calculateManiaStarRatingTimeline(buildChordChart(400), 4, 1);
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i].time).toBeGreaterThan(timeline[i - 1].time);
      expect(timeline[i].stars).toBeGreaterThanOrEqual(timeline[i - 1].stars - 1e-9);
    }
  });

  it("is empty when the chart cannot produce a rating", () => {
    expect(calculateManiaStarRatingTimeline([], 4, 1)).toEqual([]);
    expect(calculateManiaStarRatingTimeline([{ time: 0, endTime: 0, column: 0 }], 4, 1)).toEqual([]);
    expect(calculateManiaStarRatingTimeline(buildStreamChart(10), 0, 1)).toEqual([]);
    expect(calculateManiaStarRatingTimeline(buildStreamChart(10), 4, 0)).toEqual([]);
  });
});
