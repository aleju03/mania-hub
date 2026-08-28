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

// Gamma Speedjack Pack 3 [FINAL BOSS], beatmap 4627199 at the reported
// 96.40% play. MinaCalc reads Jumpstream first and JackSpeed last even though
// the chart analyzer confidently calls it speedjack.
const SPEEDJACK_MISREAD = {
  Stream: 22.26, Jumpstream: 33.95, Handstream: 32.29, Stamina: 33.14,
  JackSpeed: 17.94, Chordjack: 31.32, Technical: 32.53,
};

const SPEEDJACK_CHART = {
  patterns: ["speedjack"],
  jackShare: null,
  streamShare: null,
  techCategory: null,
  lnRatio: 0,
  vibro: false,
  rcRawDan: 10,
  lnRawDan: null,
  dtRawDan: null,
  dtFamily: null,
  htRawDan: null,
  htFamily: null,
  lengthSeconds: null,
};

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

  it("moves a speedjack chart MinaCalc misreads as Jumpstream from tech to jack", () => {
    expect(danSkillsetBucketsForValues(4, "rc", SPEEDJACK_MISREAD)).toEqual(["tech"]);
    expect(danSkillsetBucketsForValues(4, "rc", SPEEDJACK_MISREAD, null, 1, SPEEDJACK_CHART))
      .toEqual(["jack"]);
  });

  it("uses the same override for a confident chordjack tag", () => {
    expect(danSkillsetBucketsForValues(4, "rc", SPEEDJACK_MISREAD, null, 1, {
      ...SPEEDJACK_CHART,
      patterns: ["chordjack"],
    })).toEqual(["jack"]);
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
    expect(danSkillsetBucketsForValues(4, "rc", SPEEDJACK_MISREAD, null, 1, SPEEDJACK_CHART))
      .toHaveLength(1);
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
      lengthSeconds: null,
    })).toContain("speed");
  });
});

describe("6K/7K jack bucket (LeoBlack cluster share)", () => {
  const chart = (over: Partial<Parameters<typeof danTagBucketsForTest>[1]>) => ({
    patterns: [], jackShare: null, streamShare: null, techCategory: null, lnRatio: 0, vibro: false,
    rcRawDan: 10, lnRawDan: null, dtRawDan: null, dtFamily: null, htRawDan: null, htFamily: null,
    lengthSeconds: null,
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

  it("falls back to the derived jack tag when a chart has no clusters", async () => {
    const { danTagBucketsForTest } = await import("../src/features/player-skills.js");
    // A no-cluster chart earns the jack tag via chartIsJack's chordjack arm.
    expect(danTagBucketsForTest(7, chart({ patterns: ["jack", "chordjack"], jackShare: null }))).toEqual(["jack"]);
    expect(danTagBucketsForTest(7, chart({ patterns: ["chordstream"], jackShare: null }))).toEqual(["stream"]);
  });

  // The union rule behind the whole-jack tag: LeoBlack jack clusters carrying
  // the chart or the single-note jack score, with chordjack as a no-cluster
  // fallback.
  // KKKC [7K Extreme] (cj 0.77, share 0.405) missed the chordjack tag by 0.03
  // and sat on the Tech tile until the share arm; Ningen Shikkaku [Zenx's 7K
  // Miscreation] (cj 0.35, share 0.26, jack 1.0) is trill jack only the
  // single-note detector sees.
  it("tags whole-jack from the chordjack score, the cluster share or the jack score", async () => {
    const { chartIsJackForTest } = await import("../src/features/player-skills.js");
    expect(chartIsJackForTest(7, 0.8, 0, null)).toBe(true);
    expect(chartIsJackForTest(7, 0.77, 0, 0.405)).toBe(true);
    expect(chartIsJackForTest(7, 0.77, 0, null)).toBe(false);
    expect(chartIsJackForTest(7, 0.35, 1, 0.26)).toBe(true);
    expect(chartIsJackForTest(7, 0, 0.5, null)).toBe(true);
    expect(chartIsJackForTest(7, 0, 0.49, 0.39)).toBe(false);
    // High chordjack confidence does not overrule contrary cluster evidence:
    // this shape is 77.6% stream, with only a secondary jack section.
    expect(chartIsJackForTest(7, 0.93, 0.38, 0.224)).toBe(false);
    // 4K keeps the old rule: chordjack certainty only.
    expect(chartIsJackForTest(4, 0.8, 0, null)).toBe(true);
    expect(chartIsJackForTest(4, 0.77, 1, 0.9)).toBe(false);
  });

  // The tech veto takes the single-note score only at its own certainty bar:
  // EGOISM 440 [EGOMANIA] (jack 0.67, in a mapper-named tech dan pack) keeps
  // its tech tag while wearing the jack one.
  it("vetoes tech from jack certainty, not from the jack tag line", async () => {
    const { jackVetoesTechForTest } = await import("../src/features/player-skills.js");
    expect(jackVetoesTechForTest(7, 0, 0.8, null)).toBe(true);
    expect(jackVetoesTechForTest(7, 0, 0.67, null)).toBe(false);
    expect(jackVetoesTechForTest(7, 0.77, 0, 0.405)).toBe(true);
    expect(jackVetoesTechForTest(7, 0.93, 0.38, 0.224)).toBe(false);
    expect(jackVetoesTechForTest(4, 0.77, 1, 0.9)).toBe(false);
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

describe("the stamina tile's length gate", () => {
  // Infectious Crying [4K] 1.2x (288bpm), beatmap 5066729: a 2:59 tech dump
  // whose Stamina rider edges Technical by 0.15 (0.4%), which is the whole
  // margin the rider is ever capable of.
  const INFECTIOUS_CRYING = {
    Stream: 30.51, Jumpstream: 27.70, Handstream: 30.08,
    Stamina: 32.81, JackSpeed: 19.70, Chordjack: 25.70, Technical: 32.66,
  };

  it("hands a short Stamina-argmax clear to its best base skillset", () => {
    // Unknown length keeps the old reading rather than guessing it short.
    expect(danSkillsetBucketsForValues(4, "rc", INFECTIOUS_CRYING)).toEqual(["stamina"]);
    expect(danSkillsetBucketsForValues(4, "rc", INFECTIOUS_CRYING, 179)).toEqual(["tech"]);
  });

  it("keeps the tile on a file long enough to demand endurance", () => {
    // Galaxy Collapse [Cataclysmic Hypernova] is 6:42; the rider is earned.
    expect(danSkillsetBucketsForValues(4, "rc", INFECTIOUS_CRYING, 402)).toEqual(["stamina"]);
  });

  it("judges the length the play actually lasted, not the 1.0x drain", () => {
    // A 5:00 chart at 1.5x is over in 3:20, so it stops being an endurance
    // clear; the same chart at 1.0x still is.
    expect(danSkillsetBucketsForValues(4, "rc", INFECTIOUS_CRYING, 300)).toEqual(["stamina"]);
    expect(danSkillsetBucketsForValues(4, "rc", INFECTIOUS_CRYING, 300, 1.5)).toEqual(["tech"]);
  });

  it("leaves Handstream-led clears in the tile at any length", () => {
    // Handstream names a pattern rather than riding on one, so the gate never
    // touches it.
    const handstream = { ...INFECTIOUS_CRYING, Handstream: 34.0, Stamina: 33.0 };
    expect(danSkillsetBucketsForValues(4, "rc", handstream, 60)).toEqual(["stamina"]);
  });
});
