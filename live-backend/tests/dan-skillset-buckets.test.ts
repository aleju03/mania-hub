import { describe, expect, it } from "vitest";
import { danSkillsetBucketsForValues, danTagBucketsForTest } from "../src/features/player-skills.js";
import type { MotionFeatures } from "../src/dan/motion-features.js";

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
  clusterTrill: null,
  handstreamCluster: null,
  chordjackScore: 0,
  techScore: 0,
  // No stored motion block, so these fixtures exercise the fallback arms.
  motion: null,
  lnRatio: 0,
  vibro: false,
  danEligible: true,
  rcRawDan: 10,
  lnRawDan: null,
  rcDanLabel: null,
  lnDanLabel: null,
  dtRawDan: null,
  dtFamily: null,
  dtDanLabel: null,
  htRawDan: null,
  htFamily: null,
  htDanLabel: null,
  lengthSeconds: null,
  od: null,
};

// Crescent Moon Island [Kuro 1.05x (181bpm)], beatmap 3090568 at 1.0x: the
// measured case behind the tech tiebreak. Stream edges Technical by 0.33,
// argmax noise on a chart the analyzer calls tech at 0.825.
const CRESCENT_MOON = {
  Stream: 32.67, Jumpstream: 29.66, Handstream: 28.02, Stamina: 31.58,
  JackSpeed: 17.86, Chordjack: 22.90, Technical: 32.34,
};

const techTaggedChart = (techScore: number) => ({
  ...SPEEDJACK_CHART,
  patterns: ["tech"],
  techScore,
});

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

  it("lets a confident tech tag reclaim a near-tie the argmax handed to speed", () => {
    // Without stored analysis the argmax stands and the clear files speed.
    expect(danSkillsetBucketsForValues(4, "rc", CRESCENT_MOON)).toEqual(["speed"]);
    expect(danSkillsetBucketsForValues(4, "rc", CRESCENT_MOON, null, 1, techTaggedChart(0.825))).toEqual(["tech"]);
    // The bar is inclusive at 0.8.
    expect(danSkillsetBucketsForValues(4, "rc", CRESCENT_MOON, null, 1, techTaggedChart(0.8))).toEqual(["tech"]);
  });

  it("keeps speed when the tech score sits under the tiebreak bar", () => {
    // 0.79 is over the 0.5 tag line but under the 0.8 the tiebreak demands:
    // at the tag line the stamina corpus goes 40.5% -> 92.5% tech-tiled.
    expect(danSkillsetBucketsForValues(4, "rc", CRESCENT_MOON, null, 1, techTaggedChart(0.79))).toEqual(["speed"]);
  });

  it("does not let the tiebreak reach past the near-tie band", () => {
    // Technical 2.0 under Stream: not a near-tie, so even a maxed tech score
    // leaves the clear in speed.
    expect(danSkillsetBucketsForValues(4, "rc", {
      Stream: 30.0, Jumpstream: 24.0, Handstream: 22.0, Stamina: 27.0, JackSpeed: 15.0, Chordjack: 20.0, Technical: 28.0,
    }, null, 1, techTaggedChart(1))).toEqual(["speed"]);
  });

  it("lets the jack override outrank the tech tiebreak", () => {
    expect(danSkillsetBucketsForValues(4, "rc", CRESCENT_MOON, null, 1, {
      ...techTaggedChart(0.9),
      patterns: ["speedjack", "tech"],
    })).toEqual(["jack"]);
  });

  it("keeps the real speed packs in speed under the tiebreak", () => {
    // Most of these vectors put Technical inside the near-tie band (the dense
    // ones rate every skillset alike), so the sub-bar tech score is the only
    // thing keeping them in speed. That is the tiebreak's whole trade: the
    // measured speed corpus loses 6 of 940 charts at the 0.8 bar.
    //
    // NEAR_TIE_SPEED[3] and [4] are excluded: Technical leads Stream by 0.90
    // and by 0.50 there, both past the lead arm's 0.35 bar. They are the
    // labelled speed charts that arm costs, and the price of the bar sitting
    // low enough to keep a rated set from splitting across two tiles
    // (TECH_NEAR_TIE_MSD_LEAD has the corpus numbers).
    const held = [...REAL_SPEED, ...NEAR_TIE_SPEED.filter((_, index) => index !== 3 && index !== 4)];
    for (const values of held) {
      expect(danSkillsetBucketsForValues(4, "rc", values, null, 1, techTaggedChart(0.79))).toEqual(["speed"]);
    }
    for (const index of [3, 4]) {
      expect(danSkillsetBucketsForValues(4, "rc", NEAR_TIE_SPEED[index], null, 1, techTaggedChart(0.79)))
        .toEqual(["tech"]);
    }
  });

  it("lets Technical take the near-tie when it outranks Stream on a tech-tagged chart", () => {
    // Matusa Bomber [4K] 2mnd (4189256): Stamina tops the argmax on a 3:02
    // file, so the stamina hold cannot reach it and Stream wins the near-tie
    // from third place. Technical leads Stream by 0.81, past the lead arm.
    const matusaBomber = {
      Stream: 27.63, Jumpstream: 23.06, Handstream: 26.15, Stamina: 28.57,
      JackSpeed: 16.18, Chordjack: 20.58, Technical: 28.44,
    };
    expect(danSkillsetBucketsForValues(4, "rc", matusaBomber, 182, 1, techTaggedChart(0.538)))
      .toEqual(["tech"]);
    // Without the analyzer's tech tag the lead alone does not move it.
    expect(danSkillsetBucketsForValues(4, "rc", matusaBomber, 182, 1, techTaggedChart(0.49)))
      .toEqual(["speed"]);
    // And with no stored analysis at all the argmax near-tie stands.
    expect(danSkillsetBucketsForValues(4, "rc", matusaBomber, 182, 1)).toEqual(["speed"]);
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

  it("gives a chart with nothing ambiguous about it exactly one tile", () => {
    // Two tiles are for charts that earn them (see the shared-tile describe);
    // a lone dominant skillset on a chart with no stored motion block is not
    // one of those, and neither is the speedjack override.
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
      patterns: ["delay"], jackShare: 0, streamShare: 1, techCategory: true, clusterTrill: null, handstreamCluster: null, techScore: 0, chordjackScore: 0, lnRatio: 0, vibro: false,
      danEligible: true,
      rcRawDan: 10, lnRawDan: null, rcDanLabel: null, lnDanLabel: null, dtRawDan: null, dtFamily: null, dtDanLabel: null, htRawDan: null, htFamily: null, htDanLabel: null,
      lengthSeconds: null, od: null,
    })).toContain("speed");
  });
});

describe("6K/7K jack bucket (LeoBlack cluster share)", () => {
  const chart = (over: Partial<Parameters<typeof danTagBucketsForTest>[1]>) => ({
    patterns: [], jackShare: null, streamShare: null, techCategory: null, clusterTrill: null, handstreamCluster: null, techScore: 0, chordjackScore: 0, lnRatio: 0, vibro: false,
    danEligible: true,
    rcRawDan: 10, lnRawDan: null, rcDanLabel: null, lnDanLabel: null, dtRawDan: null, dtFamily: null, dtDanLabel: null, htRawDan: null, htFamily: null, htDanLabel: null,
    lengthSeconds: null, od: null,
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

describe("the 4K Jumpstream arbitration", () => {
  // [4K] Amber Wishes 1.1 (Stamina), beatmap 3208141: a mapper-named stamina
  // practice cut. Jumpstream 26.29 edges Handstream 25.97 and Stamina 25.76,
  // argmax noise on a dense chordstream file, and the old unconditional
  // Jumpstream->tech pairing filed it tech. LeoBlack labels it "Jumpstream".
  const AMBER_WISHES = {
    Stream: 20.34, Jumpstream: 26.29, Handstream: 25.97, Stamina: 25.76,
    JackSpeed: 14.90, Chordjack: 17.94, Technical: 22.26,
  };

  // goreshit - daddy can change [4K] men (4766898), 54 seconds of jack-heavy
  // chordstream LeoBlack labels "Jumpstream". 4K players read it as stamina,
  // and its length is not allowed to argue: the rule shipped 2026-08-29 with a
  // 90-second floor that filed it tech, which is the reading being corrected.
  const DADDY_CAN_CHANGE = {
    Stream: 22.08, Jumpstream: 31.08, Handstream: 23.23, Stamina: 29.19,
    JackSpeed: 17.87, Chordjack: 20.47, Technical: 23.46,
  };

  // Blastix Riotz [4K] Jinjin's INFINITE (789784) rates Jumpstream over
  // Technical and wears the ambiguous "Jumpstream Tech" label; players call it
  // tech and the runner-up says so.
  const BLASTIX_INFINITE = {
    Stream: 22.26, Jumpstream: 23.27, Handstream: 15.22, Stamina: 23.07,
    JackSpeed: 14.90, Chordjack: 16.74, Technical: 23.85,
  };

  // Finixe [4K] Another (1624796): 222BPM jumpstream over 222BPM streams,
  // labelled "Jumpstream Tech". Stream is the runner-up and it files speed.
  const FINIXE = {
    Stream: 20.64, Jumpstream: 22.14, Handstream: 13.06, Stamina: 19.91,
    JackSpeed: 11.30, Chordjack: 15.38, Technical: 19.62,
  };

  const labelled = (over: Record<string, unknown>) => ({
    ...SPEEDJACK_CHART, patterns: [], techScore: 0.94, ...over,
  });
  /** LeoBlack's plain "Jumpstream"/"Handstream" family label. */
  const plain = labelled({ clusterTrill: false, techCategory: false });
  /** Its "Jumptrill" / "Split Trill Tech" label. */
  const trill = labelled({ clusterTrill: true, techCategory: true });
  /** Its ambiguous "Jumpstream Tech" label. */
  const techSuffixed = labelled({ clusterTrill: false, techCategory: true });

  it("files a Jumpstream argmax with stamina on a plain LeoBlack label", () => {
    // Its analyzer tech score is 0.94 and must not matter: the tech detector
    // saturates on dense chordstream, which is why the label arbitrates.
    expect(danSkillsetBucketsForValues(4, "rc", AMBER_WISHES, 112, 1, plain)).toEqual(["stamina"]);
  });

  it("does that at any length, including a 54-second file", () => {
    // The 90-second floor this replaces filed 4766898 under tech.
    for (const [length, rate] of [[54, 1], [54, 1.5], [30, 1], [600, 1]] as const) {
      expect(danSkillsetBucketsForValues(4, "rc", DADDY_CAN_CHANGE, length, rate, { ...plain, lengthSeconds: length }))
        .toEqual(["stamina"]);
    }
  });

  it("keeps the tech tile on a trill label, or with no label at all", () => {
    expect(danSkillsetBucketsForValues(4, "rc", AMBER_WISHES, 112, 1, trill)).toEqual(["tech"]);
    expect(danSkillsetBucketsForValues(4, "rc", AMBER_WISHES, 112, 1, labelled({ clusterTrill: null, techCategory: null })))
      .toEqual(["tech"]);
    expect(danSkillsetBucketsForValues(4, "rc", AMBER_WISHES)).toEqual(["tech"]);
  });

  it("lets the runner-up skillset decide under the ambiguous tech-suffixed label", () => {
    // Technical -> tech, Stream -> speed, Handstream/Stamina -> stamina.
    expect(danSkillsetBucketsForValues(4, "rc", BLASTIX_INFINITE, 127, 1, techSuffixed)).toEqual(["tech"]);
    expect(danSkillsetBucketsForValues(4, "rc", FINIXE, 155, 1, techSuffixed)).toEqual(["speed"]);
    expect(danSkillsetBucketsForValues(4, "rc", AMBER_WISHES, 112, 1, techSuffixed)).toEqual(["stamina"]);
  });

  it("does not touch other argmaxes or the jack override", () => {
    const technical = { ...AMBER_WISHES, Technical: 28.0 };
    expect(danSkillsetBucketsForValues(4, "rc", technical, 112, 1, { ...plain, techScore: 0 })).toEqual(["tech"]);
    const speedjack = { ...SPEEDJACK_CHART, clusterTrill: false, techCategory: false };
    expect(danSkillsetBucketsForValues(4, "rc", AMBER_WISHES, 112, 1, speedjack)).toEqual(["jack"]);
  });
});

describe("the dense-trill jack arm", () => {
  // A trill is hit by oscillating the wrist, the motion a chordjack asks for,
  // so a dense one is a jack demand however MinaCalc rates it. The bar is the
  // analyzer's raw chordjack score, set on the labelled pair below.
  const NANO_DEATH = {
    Stream: 17.30, Jumpstream: 23.29, Handstream: 18.82, Stamina: 22.57,
    JackSpeed: 16.18, Chordjack: 16.82, Technical: 22.63,
  };
  const BLASTIX_GRAVITY = {
    Stream: 21.22, Jumpstream: 27.91, Handstream: 21.38, Stamina: 26.06,
    JackSpeed: 18.90, Chordjack: 20.82, Technical: 26.71,
  };
  const trill = (chordjackScore: number) => ({
    ...SPEEDJACK_CHART, patterns: [], techScore: 0.73,
    clusterTrill: true, techCategory: true, chordjackScore, lengthSeconds: 139,
  });

  it("files a dense trill under jack", () => {
    // NANO DEATH!!!!! [4K] DEATH (1021312), 240BPM jumptrill at chordjack 0.71.
    expect(danSkillsetBucketsForValues(4, "rc", NANO_DEATH, 139, 1, trill(0.71))).toEqual(["jack"]);
    // QZKago Requiem [4K] NYARMAGEDDON (4152216) sits at 0.65, inside the bar.
    expect(danSkillsetBucketsForValues(4, "rc", NANO_DEATH, 139, 1, trill(0.65))).toEqual(["jack"]);
  });

  it("leaves the Blastix Riotz family on tech", () => {
    // GRAVITY 0.50, GRAVITY Lv.16 0.57: trills, but not dense ones.
    expect(danSkillsetBucketsForValues(4, "rc", BLASTIX_GRAVITY, 127, 1, trill(0.50))).toEqual(["tech"]);
    expect(danSkillsetBucketsForValues(4, "rc", BLASTIX_GRAVITY, 127, 1, trill(0.57))).toEqual(["tech"]);
  });

  it("needs the trill label; it is not a second jack tag", () => {
    const plainLabel = { ...trill(0.71), clusterTrill: false, techCategory: false };
    expect(danSkillsetBucketsForValues(4, "rc", NANO_DEATH, 139, 1, plainLabel)).toEqual(["stamina"]);
  });

  it("runs ahead of the argmax, so a Technical-argmax trill still files jack", () => {
    // Perfect Neglect [4K] Lyz's Another (2031389) rates Technical 20.42 /
    // Stamina 20.23 / Jumpstream 20.13, so nothing inside the Jumpstream
    // arbitration could reach it, and 4K players call it jack.
    const perfectNeglect = {
      Stream: 15.78, Jumpstream: 20.13, Handstream: 16.98, Stamina: 20.23,
      JackSpeed: 14.10, Chordjack: 18.00, Technical: 20.42,
    };
    expect(danSkillsetBucketsForValues(4, "rc", perfectNeglect, 140, 1, {
      ...trill(0.57), jackShare: 0.33, lengthSeconds: 140,
    })).toEqual(["jack"]);
  });

  it("lets jack clusters corroborate a chordjack score under the bar", () => {
    // The score alone cannot order these: FIN4LE [HEAVENLY] (0.59) outranks
    // both charts players call jack, and carries no jack clusters at all.
    const m1917 = {
      Stream: 14.42, Jumpstream: 19.80, Handstream: 15.86, Stamina: 19.89,
      JackSpeed: 13.50, Chordjack: 17.20, Technical: 19.70,
    };
    expect(danSkillsetBucketsForValues(4, "rc", m1917, 239, 1, { ...trill(0.58), jackShare: 0.21, lengthSeconds: 239 }))
      .toEqual(["jack"]);
    const fin4le = {
      Stream: 17.54, Jumpstream: 23.00, Handstream: 18.82, Stamina: 21.96,
      JackSpeed: 15.90, Chordjack: 19.40, Technical: 22.77,
    };
    expect(danSkillsetBucketsForValues(4, "rc", fin4le, 121, 1, { ...trill(0.59), jackShare: 0, lengthSeconds: 121 }))
      .toEqual(["tech"]);
  });

  it("hands a long non-jack trill to its runner-up instead of tech", () => {
    // Villain Virus [4K] Music Virus (1912526): 4:25 of Jumpstream 24.92 /
    // Stamina 24.48 / Technical 24.24, which players call a stamina file. A
    // short trill keeps tech, which is what holds the jumptrill packs.
    const musicVirus = {
      Stream: 19.54, Jumpstream: 24.92, Handstream: 20.66, Stamina: 24.48,
      JackSpeed: 16.20, Chordjack: 21.30, Technical: 24.24,
    };
    const chart = { ...trill(0.55), jackShare: 0.08, lengthSeconds: 265 };
    expect(danSkillsetBucketsForValues(4, "rc", musicVirus, 265, 1, chart)).toEqual(["stamina"]);
    expect(danSkillsetBucketsForValues(4, "rc", musicVirus, 200, 1, { ...chart, lengthSeconds: 200 }))
      .toEqual(["tech"]);
  });
});

describe("the Handstream near-tie", () => {
  // Hold Angel [4K] Worship (5339691), LeoBlack label "Handstream". As a chart
  // Handstream 29.13 tops Technical 28.00, but MinaCalc's Handstream moves
  // with a play's accuracy and real plays of it land Technical 19.51 over
  // Handstream 19.45 - the same chart filing stamina for one player and tech
  // for the next.
  const HOLD_ANGEL_PLAY = {
    Stream: 16.83, Jumpstream: 18.21, Handstream: 19.45, Stamina: 18.58,
    JackSpeed: 13.94, Chordjack: 17.99, Technical: 19.51,
  };
  const handstreamChart = (over: Record<string, unknown> = {}) => ({
    ...SPEEDJACK_CHART, patterns: [], techScore: 0.71,
    clusterTrill: false, techCategory: false, handstreamCluster: true,
    lengthSeconds: 121, ...over,
  });

  it("holds the stamina tile when Handstream loses the argmax by noise", () => {
    expect(danSkillsetBucketsForValues(4, "rc", HOLD_ANGEL_PLAY, 121, 1, handstreamChart()))
      .toEqual(["stamina"]);
  });

  it("needs LeoBlack to read the chart as handstream", () => {
    expect(danSkillsetBucketsForValues(4, "rc", HOLD_ANGEL_PLAY, 121, 1, handstreamChart({ handstreamCluster: false })))
      .toEqual(["tech"]);
    expect(danSkillsetBucketsForValues(4, "rc", HOLD_ANGEL_PLAY, 121, 1, handstreamChart({ handstreamCluster: null })))
      .toEqual(["tech"]);
  });

  it("only covers argmax noise, not a Technical lead past the band", () => {
    // The band is 0.95, so 0.90 holds and 1.00 does not.
    expect(danSkillsetBucketsForValues(4, "rc", { ...HOLD_ANGEL_PLAY, Technical: 20.35 }, 121, 1, handstreamChart()))
      .toEqual(["stamina"]);
    expect(danSkillsetBucketsForValues(4, "rc", { ...HOLD_ANGEL_PLAY, Technical: 20.45 }, 121, 1, handstreamChart()))
      .toEqual(["tech"]);
  });

  it("stays under Matusa Bomber 1.25, which is handstream-labelled and tech", () => {
    // The ceiling on the band: Handstream sits 0.99 under Technical here, on a
    // chart 4K players call tech. Widening past 0.99 reopens it.
    const matusa125 = {
      Stream: 33.10, Jumpstream: 26.98, Handstream: 32.47, Stamina: 33.10,
      JackSpeed: 20.26, Chordjack: 26.66, Technical: 33.46,
    };
    expect(danSkillsetBucketsForValues(4, "rc", matusa125, 146, 1, {
      ...handstreamChart({ techScore: 0.56, lengthSeconds: 146 }),
    })).toEqual(["tech"]);
  });

  it("does not reach a downrated play, which is a different problem", () => {
    // A real 0.75x play of the same chart: the calc shifts the whole vector off
    // Handstream by 1.92, not by argmax noise, and stays on tech by design.
    const downrated = {
      Stream: 12.44, Jumpstream: 14.02, Handstream: 13.19, Stamina: 14.31,
      JackSpeed: 10.11, Chordjack: 13.02, Technical: 15.11,
    };
    expect(danSkillsetBucketsForValues(4, "rc", downrated, 121, 0.75, handstreamChart())).toEqual(["tech"]);
  });

  it("yields to the jack veto like every other stamina entry path", () => {
    expect(danSkillsetBucketsForValues(4, "rc", HOLD_ANGEL_PLAY, 121, 1, handstreamChart({ jackShare: 0.35 })))
      .toEqual(["tech"]);
  });
});

describe("the Matusa Bomber set, which is one chart at seven rates", () => {
  // 4K players call every diff tech. Their Technical-over-Stream leads run
  // 0.35 to 0.81, so the arm has to reach 0.35 or the set splits across two
  // tiles. Analyzer tech score 0.53-0.56, well under the 0.8 bar.
  const DIFFS: Array<[string, Record<string, number>]> = [
    ["0.95", { Stream: 26.53, Jumpstream: 22.18, Handstream: 25.12, Stamina: 27.35, JackSpeed: 15.30, Chordjack: 19.46, Technical: 27.23 }],
    ["1.05", { Stream: 28.85, Jumpstream: 23.54, Handstream: 27.65, Stamina: 29.45, JackSpeed: 16.98, Chordjack: 21.62, Technical: 29.32 }],
    ["1.1", { Stream: 30.25, Jumpstream: 24.66, Handstream: 28.70, Stamina: 30.61, JackSpeed: 17.86, Chordjack: 22.82, Technical: 30.60 }],
    ["1.15", { Stream: 31.31, Jumpstream: 25.62, Handstream: 30.24, Stamina: 31.79, JackSpeed: 18.66, Chordjack: 23.78, Technical: 31.90 }],
    ["1.2", { Stream: 32.05, Jumpstream: 26.50, Handstream: 31.26, Stamina: 32.29, JackSpeed: 19.46, Chordjack: 25.06, Technical: 32.52 }],
    ["1.25", { Stream: 33.10, Jumpstream: 26.98, Handstream: 32.47, Stamina: 33.10, JackSpeed: 20.26, Chordjack: 26.66, Technical: 33.46 }],
    ["2mnd", { Stream: 27.63, Jumpstream: 23.06, Handstream: 26.15, Stamina: 28.57, JackSpeed: 16.18, Chordjack: 20.58, Technical: 28.44 }],
  ];

  it("files every diff under tech", () => {
    for (const [version, values] of DIFFS) {
      expect([version, danSkillsetBucketsForValues(4, "rc", values, 174, 1, techTaggedChart(0.54))])
        .toEqual([version, ["tech"]]);
    }
  });
});

describe("the long Stamina hold's rival skillset", () => {
  // Gate Openerz [4K] Christina (2134877), 4:16: Stamina 22.09 / Jumpstream
  // 22.00 / Stream 21.32 / Technical 18.82. Stream is only third, but reading
  // the hold's band against Technical alone missed it by 2.5 and handed a
  // jumpstream marathon to the speed tile.
  const GATE_OPENERZ = {
    Stream: 21.32, Jumpstream: 22.00, Handstream: 11.14, Stamina: 22.09,
    JackSpeed: 11.22, Chordjack: 14.10, Technical: 18.82,
  };

  it("holds the tile when Jumpstream stands in for Technical", () => {
    expect(danSkillsetBucketsForValues(4, "rc", GATE_OPENERZ, 256, 1)).toEqual(["stamina"]);
  });

  it("still lets a real speed marathon through", () => {
    // Nothing but Stream near the top: the hold does not fire and the near-tie
    // takes it.
    const streamMarathon = { ...GATE_OPENERZ, Jumpstream: 18.0, Technical: 18.0, Handstream: 12.0 };
    expect(danSkillsetBucketsForValues(4, "rc", streamMarathon, 256, 1)).toEqual(["speed"]);
  });
});

describe("the stamina tile's jack veto", () => {
  // AiAe [4K] Wafles' SHD (421066) with DT. LeoBlack reads 62% chordstream
  // against 31% jack and finds no handstream cluster, but DT lifts MinaCalc's
  // Handstream from fourth at 1.0x to first, which used to file it stamina.
  const AIAE_DT = {
    Handstream: 35.50, Stamina: 35.00, Chordjack: 34.43, Jumpstream: 34.31,
    JackSpeed: 34.02, Technical: 33.36, Stream: 24.58,
  };
  const jacky = (jackShare: number | null) => ({
    ...SPEEDJACK_CHART, patterns: [], techScore: 0.943, clusterTrill: false, techCategory: false,
    lengthSeconds: 237, jackShare,
  });

  it("keeps a jack-contaminated chart off the tile even when Handstream wins", () => {
    expect(danSkillsetBucketsForValues(4, "rc", AIAE_DT, 237, 1.5, jacky(0.313))).not.toEqual(["stamina"]);
    // Without the share stored, the old Handstream exemption stands.
    expect(danSkillsetBucketsForValues(4, "rc", AIAE_DT, 237, 1.5, jacky(null))).toEqual(["stamina"]);
  });

  it("sets the bar off the corpora rather than off one chart", () => {
    // Handstream packs run p95 0.280, so 0.30 is past them.
    expect(danSkillsetBucketsForValues(4, "rc", AIAE_DT, 237, 1.5, jacky(0.30))).not.toEqual(["stamina"]);
    expect(danSkillsetBucketsForValues(4, "rc", AIAE_DT, 237, 1.5, jacky(0.29))).toEqual(["stamina"]);
  });

  it("leaves a genuine handstream chart on the tile at any length", () => {
    // The shape the exemption exists for: little jack, so nothing vetoes it.
    expect(danSkillsetBucketsForValues(4, "rc", AIAE_DT, 30, 1, jacky(0.06))).toEqual(["stamina"]);
  });

  it("stops a vetoed chart falling through the arbitration back onto stamina", () => {
    // Jumpstream argmax with a non-tech label is exactly what the arbitration
    // files under stamina, so the veto has to reach it too.
    const values = { ...AIAE_DT, Handstream: 20, Stamina: 20, Chordjack: 20, JackSpeed: 20 };
    expect(danSkillsetBucketsForValues(4, "rc", values, 237, 1, jacky(0.35))).toEqual(["tech"]);
    expect(danSkillsetBucketsForValues(4, "rc", values, 237, 1, jacky(0.05))).toEqual(["stamina"]);
  });

  it("also guards the long Stamina-argmax hold", () => {
    // The hold returns before the ordinary length gate, so it needs the same
    // veto explicitly or a rate-dependent Stamina argmax can bypass the rule.
    const values = {
      ...AIAE_DT,
      Handstream: 20,
      Stamina: 35.5,
      Technical: 35.4,
      Stream: 35.3,
    };
    expect(danSkillsetBucketsForValues(4, "rc", values, 300, 1, { ...jacky(0.35), lengthSeconds: 300 }))
      .not.toEqual(["stamina"]);
    expect(danSkillsetBucketsForValues(4, "rc", values, 300, 1, { ...jacky(0.05), lengthSeconds: 300 }))
      .toEqual(["stamina"]);
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

  it("keeps the tile on an uprated marathon, judged at its 1.0x drain", () => {
    // A 5:00 chart at 1.5x is over in 3:20, but uprating a marathon does not
    // make it stop being one: the 1.0x drain keeps the tile.
    expect(danSkillsetBucketsForValues(4, "rc", INFECTIOUS_CRYING, 300)).toEqual(["stamina"]);
    expect(danSkillsetBucketsForValues(4, "rc", INFECTIOUS_CRYING, 300, 1.5)).toEqual(["stamina"]);
    // A 3:00 chart uprated stays short both ways.
    expect(danSkillsetBucketsForValues(4, "rc", INFECTIOUS_CRYING, 180, 1.5)).toEqual(["tech"]);
  });

  it("still earns the tile on a downrate that stretches the play past the bar", () => {
    // 3:30 at 0.75x lasts 4:40; the endurance was real even if the file is short.
    expect(danSkillsetBucketsForValues(4, "rc", INFECTIOUS_CRYING, 210, 0.75)).toEqual(["stamina"]);
  });

  // PEACE BREAKER [4K] FINAL PUNISHMENT, beatmap 777348: 4:51 with Stamina
  // 30.15, Technical 30.03 and Stream 30.02 inside 0.14, the three-way
  // pile-up shape where the speed near-tie used to take a marathon.
  const FINAL_PUNISHMENT = {
    Stream: 30.02, Jumpstream: 25.54, Handstream: 24.02,
    Stamina: 30.15, JackSpeed: 17.78, Chordjack: 20.34, Technical: 30.03,
  };

  it("lets a length-qualified Stamina argmax hold off the speed near-tie when Stream is third", () => {
    expect(danSkillsetBucketsForValues(4, "rc", FINAL_PUNISHMENT, 291)).toEqual(["stamina"]);
    // Too short to demand endurance: back to near-tie rules, speed takes it.
    expect(danSkillsetBucketsForValues(4, "rc", FINAL_PUNISHMENT, 179)).toEqual(["speed"]);
    // An unknown length cannot verify a marathon, so the near-tie stands.
    expect(danSkillsetBucketsForValues(4, "rc", FINAL_PUNISHMENT)).toEqual(["speed"]);
    // Technical inside STAMINA_HOLD_TECH_BAND of Stream is the same pile-up
    // whichever of the two is ahead, so the hold still fires.
    expect(danSkillsetBucketsForValues(4, "rc", { ...FINAL_PUNISHMENT, Technical: 30.0 }, 291)).toEqual(["stamina"]);
    // Technical further than the band under Stream reads as a real speed
    // file, and the near-tie takes it back.
    expect(danSkillsetBucketsForValues(4, "rc", { ...FINAL_PUNISHMENT, Technical: 29.4 }, 291)).toEqual(["speed"]);
  });

  // Demiourgos [4K], beatmap 3264851: 6:27 at 274 BPM with Stamina 29.18,
  // Stream 29.05 and Technical 28.71. Technical sits third, a third of a point
  // under Stream, which used to hand a seven-minute marathon to the speed tile.
  const DEMIOURGOS = {
    Stream: 29.05, Jumpstream: 28.39, Handstream: 20.58,
    Stamina: 29.18, JackSpeed: 16.58, Chordjack: 20.58, Technical: 28.71,
  };

  it("holds the tile when Technical trails Stream by less than the band", () => {
    expect(danSkillsetBucketsForValues(4, "rc", DEMIOURGOS, 387)).toEqual(["stamina"]);
    // The length gate still rules: the same vector on a 3:00 file is speed.
    expect(danSkillsetBucketsForValues(4, "rc", DEMIOURGOS, 180)).toEqual(["speed"]);
  });

  it("leaves Handstream-led clears in the tile at any length", () => {
    // Handstream names a pattern rather than riding on one, so the gate never
    // touches it.
    const handstream = { ...INFECTIOUS_CRYING, Handstream: 34.0, Stamina: 33.0 };
    expect(danSkillsetBucketsForValues(4, "rc", handstream, 60)).toEqual(["stamina"]);
  });
});

// Real charts, with the motion block dan/motion-features.ts measures off their
// .osu and the analyzer/MSD readings stored beside it. These are the charts a
// 4K dan player labelled by hand on 2026-08-30, plus the two that named the
// shared-tile rules, so a refit that stops agreeing with them shows up here.
const withMotion = (motion: MotionFeatures, techScore: number, extra: Record<string, unknown> = {}) => ({
  ...SPEEDJACK_CHART,
  patterns: [],
  techScore,
  motion,
  ...extra,
});

// Blastix Riotz [4K] GRAVITY (770127). Jumptrill the reporter calls tech.
const GRAVITY = {
  values: { Stream: 21.22, Jumpstream: 27.91, Handstream: 21.38, Stamina: 26.06, JackSpeed: 18.90, Chordjack: 20.82, Technical: 26.71 },
  chart: withMotion({
    sameHand: 0.1608, miniJack: 0.0012, oneHandTrill: 0.0412, crossHandTrill: 0.0547,
    roll4: 0.1875, rhythmBreak: 0.0062, chordSwing: 0.2532, densitySwing: 0.4450,
  }, 0.73, { clusterTrill: true, techCategory: false, chordjackScore: 0.50, jackShare: 0.11 }),
};

// Blastix Riotz [4K] Jinjin's INFINITE (789784). Same reporter, same verdict,
// but the model reads it at 0.49 - the honest answer is both tiles.
const JINJIN = {
  values: { Stream: 22.26, Jumpstream: 23.27, Handstream: 15.22, Stamina: 23.07, JackSpeed: 14.90, Chordjack: 16.74, Technical: 23.85 },
  chart: withMotion({
    sameHand: 0.2173, miniJack: 0.0008, oneHandTrill: 0.0265, crossHandTrill: 0.0601,
    roll4: 0.1258, rhythmBreak: 0.0065, chordSwing: 0.3009, densitySwing: 0.3833,
  }, 0.538, { clusterTrill: false, techCategory: true, chordjackScore: 0.233, jackShare: 0.086 }),
};

// Beajek's 4K Training Pack, a named speed chart the model calls speed at 0.16.
const NAMED_SPEED = {
  values: { Stream: 28.48, Jumpstream: 26.18, Handstream: 16.82, Stamina: 25.84, JackSpeed: 15.78, Chordjack: 22.58, Technical: 26.55 },
  chart: withMotion({
    sameHand: 0.2349, miniJack: 0.0088, oneHandTrill: 0.0030, crossHandTrill: 0.0007,
    roll4: 0.0585, rhythmBreak: 0.0068, chordSwing: 0.3279, densitySwing: 0.4581,
  }, 0.44),
};

// STRONG 280 [4K] Conflagration (3798537): 4:13 of Stamina 25.50 over
// Jumpstream 25.39, filed jack on a 0.79 chordjack score inside a trill label.
const STRONG_280 = {
  values: { Stream: 19.78, Jumpstream: 25.39, Handstream: 23.55, Stamina: 25.50, JackSpeed: 17.22, Chordjack: 20.10, Technical: 24.96 },
  chart: withMotion({
    sameHand: 0.1133, miniJack: 0.0027, oneHandTrill: 0.0135, crossHandTrill: 0.0508,
    roll4: 0.0441, rhythmBreak: 0.0034, chordSwing: 0.5188, densitySwing: 0.2985,
  }, 0.96, { clusterTrill: true, techCategory: true, chordjackScore: 0.79, jackShare: 0.45, lengthSeconds: 253 }),
};

describe("the 4K speed/tech split read off the notes", () => {
  it("calls a jumptrill tech and a rolling speed chart speed", () => {
    expect(danSkillsetBucketsForValues(4, "rc", GRAVITY.values, 127, 1, GRAVITY.chart)).toEqual(["tech"]);
    expect(danSkillsetBucketsForValues(4, "rc", NAMED_SPEED.values, 100, 1, NAMED_SPEED.chart)).toEqual(["speed"]);
  });

  it("keeps the MSD-lead arms on a chart whose motion block is not written yet", () => {
    // What every chart does between this shipping and the sweep reaching it.
    const unread = { ...GRAVITY.chart, motion: null };
    expect(danSkillsetBucketsForValues(4, "rc", GRAVITY.values, 127, 1, unread)).toEqual(["tech"]);
    const unreadSpeed = { ...NAMED_SPEED.chart, motion: null };
    expect(danSkillsetBucketsForValues(4, "rc", NAMED_SPEED.values, 100, 1, unreadSpeed)).toEqual(["speed"]);
  });

  it("ignores a motion block that is missing a share rather than half-reading it", () => {
    const partial = { ...GRAVITY.chart, motion: { sameHand: 0.16, miniJack: 0.001 } as unknown as MotionFeatures };
    expect(danSkillsetBucketsForValues(4, "rc", GRAVITY.values, 127, 1, partial)).toEqual(["tech"]);
  });
});

// PEACE BREAKER [4K] FINAL PUNISHMENT (777348): 4:51 of Stamina 30.15 /
// Technical 30.03 / Stream 30.02. The stamina hold keeps it off the speed tile
// and the model reads its notes at 0.70 tech, so it is a tech marathon.
const FINAL_PUNISHMENT_MOTION = {
  values: { Stream: 30.02, Jumpstream: 25.54, Handstream: 24.02, Stamina: 30.15, JackSpeed: 17.78, Chordjack: 20.34, Technical: 30.03 },
  chart: withMotion({
    sameHand: 0.2274, miniJack: 0.0128, oneHandTrill: 0.0148, crossHandTrill: 0.0768,
    roll4: 0.0772, rhythmBreak: 0.0365, chordSwing: 0.2692, densitySwing: 0.3895,
  }, 0.439, { techCategory: true, chordjackScore: 0.0, jackShare: 0.08, lengthSeconds: 291 }),
};

describe("charts that carry two tiles", () => {
  it("files a tech marathon under stamina and tech, stamina first", () => {
    expect(danSkillsetBucketsForValues(4, "rc", FINAL_PUNISHMENT_MOTION.values, 291, 1, FINAL_PUNISHMENT_MOTION.chart))
      .toEqual(["stamina", "tech"]);
  });

  it("keeps a stamina marathon on stamina alone until its motion block is written", () => {
    const unread = { ...FINAL_PUNISHMENT_MOTION.chart, motion: null };
    expect(danSkillsetBucketsForValues(4, "rc", FINAL_PUNISHMENT_MOTION.values, 291, 1, unread)).toEqual(["stamina"]);
  });

  it("does not share a stamina marathon whose notes read speed", () => {
    const rolling = { ...FINAL_PUNISHMENT_MOTION.chart, motion: NAMED_SPEED.chart.motion, techScore: 0.2 };
    expect(danSkillsetBucketsForValues(4, "rc", FINAL_PUNISHMENT_MOTION.values, 291, 1, rolling)).toEqual(["stamina"]);
  });

  it("does not share a stamina marathon whose base is jumpstream", () => {
    // Jumpstream and handstream are stamina (jumpstreamRunnerUp), whatever the
    // model would say about the trills.
    const jumpstream = { ...FINAL_PUNISHMENT_MOTION.values, Jumpstream: 30.10 };
    expect(danSkillsetBucketsForValues(4, "rc", jumpstream, 291, 1, FINAL_PUNISHMENT_MOTION.chart)).toEqual(["stamina"]);
  });

  it("files a genuinely split speed/tech chart under both, strongest side first", () => {
    const tiles = danSkillsetBucketsForValues(4, "rc", JINJIN.values, 127, 1, JINJIN.chart);
    expect(tiles).toHaveLength(2);
    expect(new Set(tiles)).toEqual(new Set(["tech", "speed"]));
  });

  it("keeps a long jack marathon on jack alone", () => {
    const tiles = danSkillsetBucketsForValues(4, "rc", STRONG_280.values, 253, 1, STRONG_280.chart);
    expect(tiles).toEqual(["jack"]);
  });

  it("leaves a short jack chart on jack alone", () => {
    // Short cuts and marathons demonstrate the same jack skill.
    expect(danSkillsetBucketsForValues(4, "rc", STRONG_280.values, 120, 1, { ...STRONG_280.chart, lengthSeconds: 120 }))
      .toEqual(["jack"]);
  });

  it("does not share a jack chart whose MSD argmax was never endurance", () => {
    const speedjackArgmax = { ...STRONG_280.values, Stamina: 18.0, Handstream: 17.0, Chordjack: 26.0 };
    expect(danSkillsetBucketsForValues(4, "rc", speedjackArgmax, 253, 1, STRONG_280.chart)).toEqual(["jack"]);
  });

  it("never files more than two tiles", () => {
    for (const sample of [GRAVITY, JINJIN, NAMED_SPEED, STRONG_280, FINAL_PUNISHMENT_MOTION]) {
      for (const length of [60, 253, 600]) {
        const tiles = danSkillsetBucketsForValues(4, "rc", sample.values, length, 1, { ...sample.chart, lengthSeconds: length });
        expect(tiles.length).toBeGreaterThanOrEqual(1);
        expect(tiles.length).toBeLessThanOrEqual(2);
        expect(new Set(tiles).size).toBe(tiles.length);
      }
    }
  });
});

describe("4K jack endurance never supplies stamina dan evidence", () => {
  const jackCharts = [
    { ...STRONG_280.chart },
    { ...SPEEDJACK_CHART, patterns: ["chordjack"] },
    { ...SPEEDJACK_CHART },
    { ...SPEEDJACK_CHART, patterns: [], jackDemand: true },
  ];

  it.each(["Stamina", "Handstream"])("keeps every jack override exclusive when %s leads MinaCalc", (top) => {
    const values = { ...STRONG_280.values, [top]: 36 };
    for (const chart of jackCharts) {
      for (const length of [120, 240, 420, 900]) {
        for (const rate of [0.75, 1, 1.5]) {
          expect(danSkillsetBucketsForValues(4, "rc", values, length, rate, { ...chart, lengthSeconds: length }))
            .toEqual(["jack"]);
        }
      }
    }
  });
});
