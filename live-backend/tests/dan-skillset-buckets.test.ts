import { describe, expect, it } from "vitest";
import { danSkillsetBucketsForValues, danTagBucketsForTest } from "../src/features/player-skills.js";

// Real MSD vectors, kept as data rather than as chart ids: the classifier must
// separate these populations by their shape, so a new speed pack lands in speed
// without anyone adding it to a list.
//
// Charts from a 25-chart 4K speed collection. Every one is Stream-argmax, with
// Stream ahead of Jumpstream by 2.6 to 13.5.
const REAL_SPEED = [
  { Stream: 32.1, Jumpstream: 26.7, Handstream: 20.2, Stamina: 30.0, JackSpeed: 16.7, Chordjack: 24.3, Technical: 29.3 },
  { Stream: 33.4, Jumpstream: 22.2, Handstream: 23.1, Stamina: 30.9, JackSpeed: 18.0, Chordjack: 25.1, Technical: 31.7 },
  { Stream: 32.8, Jumpstream: 20.2, Handstream: 22.4, Stamina: 32.3, JackSpeed: 19.4, Chordjack: 27.2, Technical: 32.0 },
  { Stream: 31.8, Jumpstream: 18.3, Handstream: 21.0, Stamina: 30.9, JackSpeed: 17.6, Chordjack: 26.0, Technical: 30.7 },
  { Stream: 28.8, Jumpstream: 24.2, Handstream: 20.9, Stamina: 25.8, JackSpeed: 15.1, Chordjack: 22.0, Technical: 27.4 },
];

// Jumptrill charts MinaCalc calls Jumpstream and 4K players call tech. Stream
// runs 3.5 to 8.5 BELOW Jumpstream here, the opposite sign from the pack.
const JUMPTRILL = [
  { Stream: 21.6, Jumpstream: 28.4, Handstream: 21.8, Stamina: 26.6, JackSpeed: 19.2, Chordjack: 21.3, Technical: 27.1 },
  { Stream: 21.5, Jumpstream: 30.0, Handstream: 24.3, Stamina: 28.6, JackSpeed: 19.6, Chordjack: 22.8, Technical: 25.7 },
  { Stream: 19.3, Jumpstream: 25.1, Handstream: 20.0, Stamina: 20.2, JackSpeed: 17.2, Chordjack: 20.5, Technical: 24.7 },
];

// Charts from a second, alpha-level speed pack. At this density streaming is
// stamina and tech demanding too, so all three rate within a hair and a hard
// argmax hands the chart to whichever edges ahead: Stamina by 0.08 on the
// first, Technical by 0.02 on the third.
const NEAR_TIE_SPEED = [
  { Stream: 26.20, Jumpstream: 25.07, Handstream: 22.42, Stamina: 26.28, JackSpeed: 14.10, Chordjack: 20.74, Technical: 26.08 },
  { Stream: 29.40, Jumpstream: 23.60, Handstream: 24.10, Stamina: 29.50, JackSpeed: 16.20, Chordjack: 23.30, Technical: 28.90 },
  { Stream: 26.20, Jumpstream: 22.30, Handstream: 20.40, Stamina: 23.10, JackSpeed: 15.10, Chordjack: 20.10, Technical: 26.20 },
  { Stream: 25.30, Jumpstream: 25.00, Handstream: 23.20, Stamina: 26.00, JackSpeed: 15.80, Chordjack: 21.90, Technical: 26.20 },
  { Stream: 27.50, Jumpstream: 25.40, Handstream: 24.00, Stamina: 27.10, JackSpeed: 16.40, Chordjack: 22.60, Technical: 28.00 },
];

describe("danSkillsetBucketsForValues", () => {
  it("puts real 4K speed charts in speed", () => {
    for (const values of REAL_SPEED) {
      expect(danSkillsetBucketsForValues(4, "rc", values)).toEqual(["speed"]);
    }
  });

  it("puts speed charts in speed when stamina or tech edges out Stream by a hair", () => {
    for (const values of NEAR_TIE_SPEED) {
      expect(danSkillsetBucketsForValues(4, "rc", values)).toEqual(["speed"]);
    }
  });

  it("does not hand speed a chart whose Stream is merely second", () => {
    // Stream 1.5 under the winner: past the near-tie band, so this stays tech.
    expect(danSkillsetBucketsForValues(4, "rc", {
      Stream: 26.5, Jumpstream: 24.0, Handstream: 22.0, Stamina: 25.0, JackSpeed: 15.0, Chordjack: 20.0, Technical: 28.0,
    })).toEqual(["tech"]);
  });

  // The band is 1.25 because dense stream charts split their rating across four
  // skillsets and a hard argmax hands them to whichever edges ahead. ETERNAL
  // DRAIN [4K Eternal] is the measured case, user-labelled speed.
  it("takes a chart Stream trails by just over one MSD", () => {
    const eternalDrain = {
      Stream: 25.24, Jumpstream: 26.36, Handstream: 16.26, Stamina: 25.37,
      JackSpeed: 15.54, Chordjack: 19.70, Technical: 25.90,
    };
    expect(danSkillsetBucketsForValues(4, "rc", eternalDrain)).toEqual(["speed"]);
    // Blastix Riotz [Jinjin's INFINITE], user-labelled tech, sits at a 1.60 gap
    // and must not follow it across.
    expect(danSkillsetBucketsForValues(4, "rc", {
      Stream: 22.26, Jumpstream: 20.0, Handstream: 18.0, Stamina: 21.0,
      JackSpeed: 14.0, Chordjack: 18.0, Technical: 23.86,
    })).toEqual(["tech"]);
  });

  it("keeps jumptrill out of speed and files it as tech", () => {
    for (const values of JUMPTRILL) {
      expect(danSkillsetBucketsForValues(4, "rc", values)).toEqual(["tech"]);
    }
  });

  it("still splits jack and stamina off the other skillsets", () => {
    expect(danSkillsetBucketsForValues(4, "rc", { Chordjack: 30, Stream: 20, Jumpstream: 21, Technical: 22, Stamina: 24, Handstream: 19, JackSpeed: 25 })).toEqual(["jack"]);
    expect(danSkillsetBucketsForValues(4, "rc", { Stamina: 30, Stream: 20, Jumpstream: 21, Technical: 22, Chordjack: 24, Handstream: 26, JackSpeed: 15 })).toEqual(["stamina"]);
  });

  it("assigns every 4K skillset to exactly one tile, so the tiles stay disjoint", () => {
    const skillsets = ["Stream", "Jumpstream", "Handstream", "Stamina", "JackSpeed", "Chordjack", "Technical"];
    for (const winner of skillsets) {
      const values = Object.fromEntries(skillsets.map((key) => [key, key === winner ? 30 : 10]));
      expect(danSkillsetBucketsForValues(4, "rc", values)).toHaveLength(1);
    }
  });

  it("leaves the tag-driven keymodes off the MSD path", () => {
    // 6K/7K bucket on the in-house tags, so an SSR vector alone places nothing.
    expect(danSkillsetBucketsForValues(7, "rc", REAL_SPEED[0])).toEqual([]);
  });
});

describe("pattern tag thresholds", () => {
  // Measured against 131 charts from 23 mapper-named 7K jack packs and 100 from
  // 15 named stream/chordstream packs. The 0.5 bar let 13 of the stream charts
  // wear a chordjack tag; 0.8 leaves 3, while real jack sits at a median score
  // of 1.000 and a p25 of 0.963.
  it("tags a chart chordjack only from 0.8, and most patterns from 0.5", async () => {
    const { patternTagMinScoreForTest } = await import("../src/features/player-skills.js");
    expect(patternTagMinScoreForTest("chordjack")).toBe(0.8);
    for (const id of ["tech", "chordstream", "bracket", "ln"]) {
      expect(patternTagMinScoreForTest(id)).toBe(0.5);
    }
  });

  // The opposite failure to chordjack's: delay under-fires on the charts it
  // names. A 50-chart corpus from named speed/delay packs sits at p10 0.33, so
  // 0.5 cut into real speed charts (78% tagged); 0.25 reaches 96% while the
  // stream corpus moves only 50% -> 54%.
  it("tags delay from 0.25, so a real speed chart is not cut off", async () => {
    const { patternTagMinScoreForTest } = await import("../src/features/player-skills.js");
    expect(patternTagMinScoreForTest("delay")).toBe(0.25);
  });

  // 7K Regular Dan Speed Practice ~ 5th ~, Speed of Link: delay 0.334. It
  // showed a delay tag on the maps page (which tags any non-zero detection)
  // while missing the speed tile entirely, because the two used different bars.
  it("puts a 0.334-delay speed chart in the speed tile", async () => {
    const { danTagBucketsForTest: buckets, patternTagMinScoreForTest } = await import("../src/features/player-skills.js");
    expect(0.334).toBeGreaterThanOrEqual(patternTagMinScoreForTest("delay"));
    expect(buckets(7, {
      patterns: ["delay"], jackShare: 0, streamShare: 1, techCategory: true, lnRatio: 0, vibro: false,
      rcRawDan: 10, lnRawDan: null, dtRawDan: null, dtFamily: null, htRawDan: null, htFamily: null,
    })).toContain("speed");
  });
});

describe("6K/7K jack bucket (LeoBlack cluster share)", () => {
  const chart = (over: Partial<Parameters<typeof danTagBucketsForTest>[1]>) => ({
    patterns: [], jackShare: null, streamShare: null, techCategory: null, lnRatio: 0, vibro: false,
    rcRawDan: 10, lnRawDan: null, dtRawDan: null, dtFamily: null, htRawDan: null, htFamily: null,
    ...over,
  });

  // Measured shares: real 7K jack packs p10 41% / median 88%, real stream
  // packs median 5% / p90 19%.
  it("takes jack from the cluster share, not the chordjack tag", async () => {
    const { danTagBucketsForTest } = await import("../src/features/player-skills.js");
    // Rude Buster: chordjack 0.92 by the in-house score, but 265bpm chordstream
    // over 133bpm jacks, so only 24% of its difficulty is jack.
    expect(danTagBucketsForTest(7, chart({ patterns: ["chordjack"], jackShare: 0.24 }))).not.toContain("jack");
    // A real jack chart from the same tile, 96% jack.
    expect(danTagBucketsForTest(7, chart({ patterns: ["chordjack"], jackShare: 0.96 }))).toEqual(["jack"]);
    // Right at the line.
    expect(danTagBucketsForTest(7, chart({ patterns: ["chordjack"], jackShare: 0.4 }))).toEqual(["jack"]);
    expect(danTagBucketsForTest(7, chart({ patterns: ["chordjack"], jackShare: 0.39 }))).not.toContain("jack");
  });

  it("promotes a jack-heavy chart the chordjack tag missed", async () => {
    const { danTagBucketsForTest } = await import("../src/features/player-skills.js");
    expect(danTagBucketsForTest(7, chart({ patterns: [], jackShare: 0.81 }))).toEqual(["jack"]);
  });

  it("falls back to the chordjack tag when a chart has no clusters", async () => {
    const { danTagBucketsForTest } = await import("../src/features/player-skills.js");
    expect(danTagBucketsForTest(7, chart({ patterns: ["chordjack"], jackShare: null }))).toEqual(["jack"]);
    expect(danTagBucketsForTest(7, chart({ patterns: ["chordstream"], jackShare: null }))).toEqual(["stream"]);
  });

  it("leaves speed on its tag, and tech on its tag when no cluster label is stored", async () => {
    const { danTagBucketsForTest } = await import("../src/features/player-skills.js");
    expect(danTagBucketsForTest(7, chart({ patterns: ["tech"], jackShare: 0.1, streamShare: 0.1 }))).toEqual(["tech"]);
    expect(danTagBucketsForTest(7, chart({ patterns: ["delay"], jackShare: 0.1, streamShare: 0.1 }))).toEqual(["speed"]);
  });

  // The in-house tech score fired on 90% of a 107-chart stream corpus against
  // 77% of the tech one, so the tile filled with stream charts. LeoBlack's
  // headline label reads 5% and 68% on the same two.
  it("takes tech from the cluster label, not the tech score", async () => {
    const { danTagBucketsForTest } = await import("../src/features/player-skills.js");
    // A stream chart the in-house score called tech: the label overrules it.
    expect(danTagBucketsForTest(7, chart({ patterns: ["tech"], techCategory: false, streamShare: 0.9 })))
      .toEqual(["stream"]);
    // Terminal 11: "Light Chordstream Tech", tech even where the tag agrees.
    expect(danTagBucketsForTest(7, chart({ patterns: ["tech"], techCategory: true, streamShare: 0.1 })))
      .toEqual(["tech"]);
  });

  it("promotes a tech chart whose in-house score sat under the tag floor", async () => {
    const { danTagBucketsForTest } = await import("../src/features/player-skills.js");
    // "Isometry" from the dan tech ladder scores 0.35, under the 0.5 floor, and
    // LeoBlack calls it Stream Tech.
    expect(danTagBucketsForTest(7, chart({ patterns: [], techCategory: true, streamShare: 0.1 })))
      .toEqual(["tech"]);
  });

  it("does not let the tech label pull a chart out of its other tiles", async () => {
    const { danTagBucketsForTest } = await import("../src/features/player-skills.js");
    // Overlap is by design on 6K/7K: a jack-built chart LeoBlack calls
    // "Chordjacks Tech" backs both.
    expect(danTagBucketsForTest(7, chart({ patterns: [], techCategory: true, jackShare: 0.9 })))
      .toEqual(["jack", "tech"]);
  });

  it("takes stream from the cluster share too, so a chordstream chart the tag missed still lands", async () => {
    const { danTagBucketsForTest } = await import("../src/features/player-skills.js");
    // Rude Buster: chordstream scored 0.248 by the in-house detector, under the
    // 0.5 tag floor, so it used to land in NO tile once jack rejected it. Its
    // clusters are 76% stream.
    expect(danTagBucketsForTest(7, chart({ patterns: [], jackShare: 0.24, streamShare: 0.76 }))).toEqual(["stream"]);
    expect(danTagBucketsForTest(7, chart({ patterns: [], jackShare: 0.1, streamShare: 0.39 }))).not.toContain("stream");
  });

  it("lets a chart carry both tiles, which 6K/7K allows by design", async () => {
    const { danTagBucketsForTest } = await import("../src/features/player-skills.js");
    expect(danTagBucketsForTest(7, chart({ patterns: [], jackShare: 0.45, streamShare: 0.45 }))).toEqual(["jack", "stream"]);
  });
});
