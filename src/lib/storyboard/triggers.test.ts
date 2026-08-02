import { describe, expect, it } from "vitest";
import {
  buildStoryboardHitsoundEvents,
  collectStoryboardTriggerTimes,
  parseStoryboardHitsoundTrigger,
  type StoryboardHitsoundEvent,
} from "./triggers";

function event(time: number, partial: Partial<StoryboardHitsoundEvent> = {}): StoryboardHitsoundEvent {
  return { time, bank: "normal", additionBank: "normal", additions: 0, index: 0, ...partial };
}

describe("parseStoryboardHitsoundTrigger", () => {
  it("reads the optional sample set, additions set, addition and custom index", () => {
    expect(parseStoryboardHitsoundTrigger("HitSound")).toEqual({
      bank: null,
      additionBank: null,
      addition: 0,
      index: null,
    });
    expect(parseStoryboardHitsoundTrigger("HitSoundSoftWhistle")).toEqual({
      bank: "soft",
      additionBank: null,
      addition: 2,
      index: null,
    });
    expect(parseStoryboardHitsoundTrigger("HitSoundAllDrumClap3")).toEqual({
      bank: null,
      additionBank: "drum",
      addition: 8,
      index: 3,
    });
    expect(parseStoryboardHitsoundTrigger("HitSoundNormalFinish")).toEqual({
      bank: "normal",
      additionBank: null,
      addition: 4,
      index: null,
    });
  });

  it("rejects the triggers a replay cannot resolve", () => {
    expect(parseStoryboardHitsoundTrigger("Passing")).toBeNull();
    expect(parseStoryboardHitsoundTrigger("Failing")).toBeNull();
    expect(parseStoryboardHitsoundTrigger("HitSoundLoud")).toBeNull();
    expect(parseStoryboardHitsoundTrigger("")).toBeNull();
  });
});

describe("buildStoryboardHitsoundEvents", () => {
  it("sorts by time and defaults notes without samples", () => {
    const events = buildStoryboardHitsoundEvents([
      { time: 200, sample: { bank: "drum", additionBank: "soft", additions: 4, index: 2 } },
      { time: 100 },
    ]);
    expect(events).toEqual([
      event(100),
      event(200, { bank: "drum", additionBank: "soft", additions: 4, index: 2 }),
    ]);
  });
});

describe("collectStoryboardTriggerTimes", () => {
  const events = [
    event(100, { bank: "soft", additionBank: "soft", additions: 2 }),
    event(200, { bank: "soft", additionBank: "soft", additions: 8 }),
    // Chord: two notes, one firing.
    event(300, { bank: "soft", additionBank: "soft", additions: 2 }),
    event(300, { bank: "soft", additionBank: "soft", additions: 2 }),
    event(400, { bank: "drum", additionBank: "drum", additions: 2 }),
    event(500, { bank: "soft", additionBank: "soft", additions: 2, index: 3 }),
  ];

  it("matches on bank, addition and custom index", () => {
    const whistle = parseStoryboardHitsoundTrigger("HitSoundSoftWhistle")!;
    expect(collectStoryboardTriggerTimes(events, whistle, 0, 1000, 100)).toEqual([100, 300, 500]);

    const anyHit = parseStoryboardHitsoundTrigger("HitSound")!;
    expect(collectStoryboardTriggerTimes(events, anyHit, 0, 1000, 100)).toEqual([100, 200, 300, 400, 500]);

    const indexed = parseStoryboardHitsoundTrigger("HitSoundSoftWhistle3")!;
    expect(collectStoryboardTriggerTimes(events, indexed, 0, 1000, 100)).toEqual([500]);
  });

  it("keeps to its window, end exclusive, and honours the firing limit", () => {
    const anyHit = parseStoryboardHitsoundTrigger("HitSound")!;
    expect(collectStoryboardTriggerTimes(events, anyHit, 200, 400, 100)).toEqual([200, 300]);
    expect(collectStoryboardTriggerTimes(events, anyHit, 0, 1000, 2)).toEqual([100, 200]);
    expect(collectStoryboardTriggerTimes(events, anyHit, 600, 900, 100)).toEqual([]);
  });
});
