import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import {
  LN_CHAINED_MIN_RATIO,
  LN_EFFECTIVE_MIN_RATIO,
  LN_EFFECTIVE_MODEL_VERSION,
  analyzeEffectiveLn,
  chartIsLn,
  chartLnShareFor,
  demoteFreeHolds,
  effectiveHoldMask,
  lnIdentityMinRatioFor,
  lnTailPassText,
  releaseGreatWindowMs,
} from "../src/dan/dan-estimator/ln-effective.js";
import { CHART_ANALYSIS_VERSION, recomputeLnEffectiveChunk, runLnEffectiveRecomputeJob } from "../src/features/chart-analysis.js";
import { JobQueue } from "../src/jobs/queue.js";
import { storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";
import { ACTIVITY_SKILL_ANALYSIS_VERSION } from "../src/features/activity.js";
import { upsertMapSearchIndexRow } from "../src/features/map-search.js";
import { LN_SKILL_VERSION } from "../src/dan/ln-skill.js";

interface ChartNote { column: number; time: number; end?: number }

function osuText(notes: ChartNote[], od = 8, keyCount = 4): string {
  const lines = notes.map((note) => {
    const x = Math.floor((note.column + 0.5) * (512 / keyCount));
    return note.end != null
      ? `${x},192,${note.time},128,0,${note.end}:0:0:0:0:`
      : `${x},192,${note.time},1,0,0:0:0:0:`;
  });
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: Effective LN Test
Artist: Test
Creator: Mapper
Version: ${keyCount}K

[Difficulty]
CircleSize:${keyCount}
OverallDifficulty:${od}

[TimingPoints]
0,270,4,2,0,100,1,0

[HitObjects]
${lines.join("\n")}
`;
}

// A FREEDOM DiVE-shaped chart: 222bpm 1/4 (67.5ms), every note held to the
// next one in a rolling 4-column stream, with a rice note every 8th.
function fullLnStream(count = 600, step = 67.5): ChartNote[] {
  const pattern = [0, 1, 2, 3, 1, 3, 0, 2];
  return Array.from({ length: count }, (_, i) => {
    const time = Math.round(1000 + i * step);
    const column = pattern[i % pattern.length];
    return i % 8 === 7 ? { column, time } : { column, time, end: Math.round(1000 + (i + 1) * step) };
  });
}

describe("releaseGreatWindowMs", () => {
  it("is 1.5x the ScoreV2-style head window at the OD, assuming OD8 when unknown", () => {
    expect(releaseGreatWindowMs(8)).toBeCloseTo(60, 5);
    expect(releaseGreatWindowMs(7.5)).toBeCloseTo(62.25, 5);
    expect(releaseGreatWindowMs(0)).toBeCloseTo(96, 5);
    expect(releaseGreatWindowMs(null)).toBeCloseTo(60, 5);
  });
});

describe("analyzeEffectiveLn", () => {
  it("retains recurring near-window same-lane rearticulation, not isolated pairs", () => {
    const notes = Array.from({ length: 100 }, (_, i) => ({ column: 0, time: i * 114, end: i * 114 + 57 }));
    const parsed = parseManiaBeatmap(osuText(notes, 8.5)).notes;
    expect(analyzeEffectiveLn(parsed, { od: 8.5 })).toMatchObject({ effectiveHolds: 99, chainedShortHolds: 99, longTails: 0 });
    expect(effectiveHoldMask(parsed.slice(0, 2), { od: 8.5 })).toEqual([false, false]);
    // A tail/next-head contact still has two distinct same-lane actions.
    const touching = parsed.slice(0, 3).map((n, i) => ({ ...n, time: i * 57, endTime: (i + 1) * 57 }));
    expect(effectiveHoldMask(touching, { od: 8.5 })).toEqual([true, true, false]);
    const transformed = parsed.map(n => ({ ...n, column: 3 - n.column, time: n.time - 3000, endTime: n.endTime - 3000 })).reverse();
    expect(analyzeEffectiveLn(transformed, { od: 8.5 })).toEqual(analyzeEffectiveLn(parsed, { od: 8.5 }));
  });

  it("bounds chains by played duration and same-lane recovery gap", () => {
    const chain = (duration: number, gap: number) => Array.from({ length: 12 }, (_, i) => ({
      column: 0, time: i * (duration + gap), endTime: i * (duration + gap) + duration, isHold: true,
    }));
    expect(analyzeEffectiveLn(chain(40, 60), { od: 8 }).chainedShortHolds).toBe(11);
    expect(analyzeEffectiveLn(chain(39.99, 60), { od: 8 }).effectiveHolds).toBe(0);
    expect(analyzeEffectiveLn(chain(40, 60.01), { od: 8 }).effectiveHolds).toBe(0);
    expect(analyzeEffectiveLn(chain(43, 43), { od: 0 }).effectiveHolds).toBe(0);
    const notes = chain(57, 57);
    expect(analyzeEffectiveLn(notes, { rate: 1.5, od: 8.5 }).effectiveHolds).toBe(11);
    expect(analyzeEffectiveLn(notes, { rate: 2, od: 8.5 }).effectiveHolds).toBe(0);
    const baked = notes.map(n => ({ ...n, time: n.time / 1.5, endTime: n.endTime / 1.5 }));
    expect(effectiveHoldMask(notes, { rate: 1.5, od: 8.5 })).toEqual(effectiveHoldMask(baked, { od: 8.5 }));
    expect(effectiveHoldMask(chain(57, -1), { od: 8.5 }).some(Boolean)).toBe(false);
  });

  it.each([4, 400])("keeps %s tap-covered repeated holds LN when the whole window is release work", (count) => {
    // Repeated half-duty holds: 67.5ms bodies become 45ms at DT. Unlike
    // a four-column roll, these have short enough same-lane gaps to qualify
    // as a chain, and a window made entirely of chained holds is inverse:
    // no body clears the window, but every note is a release and a repress.
    // Both the short-chart fallback and windowed identity read it that way.
    const notes = Array.from({ length: count }, (_, i) => ({
      column: 0, time: i * 135, endTime: i * 135 + 67.5, isHold: true,
    }));
    const nomod = analyzeEffectiveLn(notes, { rate: 1, od: 7.5 });
    expect(chartIsLn(4, { lnRatio: nomod.holdRatio, lnEffectiveRatio: nomod.effectiveLnRatio })).toBe(true);
    const dt = analyzeEffectiveLn(notes, { rate: 1.5, od: 7.5 });
    expect(dt).toMatchObject({ holdRatio: 1, longTails: 0, chainedShortHolds: count - 1 });
    // Chart-wide fallback for the short chart, windowed median for the long one; both read the chain share on the 0.4 line.
    expect(dt.effectiveLnRatio).toBeGreaterThanOrEqual(LN_EFFECTIVE_MIN_RATIO);
    expect(dt.effectiveLnRatio).toBeLessThanOrEqual(LN_EFFECTIVE_MIN_RATIO / LN_CHAINED_MIN_RATIO);
    expect(chartIsLn(4, { lnRatio: dt.holdRatio, lnEffectiveRatio: dt.effectiveLnRatio })).toBe(true);
    const baked = notes.map(note => ({ ...note, time: note.time / 1.5, endTime: note.endTime / 1.5 }));
    expect(analyzeEffectiveLn(baked, { od: 7.5 })).toEqual(dt);
    const mirrored = notes.map(note => ({ ...note, column: 3, time: note.time - 3000, endTime: note.endTime - 3000 })).reverse();
    expect(analyzeEffectiveLn(mirrored, { rate: 1.5, od: 7.5 })).toEqual(dt);
  });

  it("needs 60% of a window's notes in chains when no body clears the window", () => {
    // The same DT chain, diluted with taps in another column. Hold share
    // stays past the 45% line either way; only the release-work share moves.
    const chain = Array.from({ length: 400 }, (_, i) => ({ column: 0, time: i * 135, endTime: i * 135 + 67.5, isHold: true }));
    const span = 400 * 135;
    const taps = (count: number) => Array.from({ length: count }, (_, i) => {
      const time = Math.round((i * span) / count) + 30;
      return { column: 1 + (i % 3), time, endTime: time, isHold: false };
    });
    const dense = analyzeEffectiveLn([...chain, ...taps(250)], { rate: 1.5, od: 7.5 });
    expect(dense.longTails).toBe(0);
    expect(dense.holdRatio).toBeCloseTo(400 / 650, 3);
    expect(chartIsLn(4, { lnRatio: dense.holdRatio, lnEffectiveRatio: dense.effectiveLnRatio })).toBe(true);
    const diluted = analyzeEffectiveLn([...chain, ...taps(350)], { rate: 1.5, od: 7.5 });
    expect(diluted.holdRatio).toBeCloseTo(400 / 750, 3);
    expect(diluted.effectiveLnRatio).toBeLessThan(LN_EFFECTIVE_MIN_RATIO);
    expect(chartIsLn(4, { lnRatio: diluted.holdRatio, lnEffectiveRatio: diluted.effectiveLnRatio })).toBe(false);
  });

  it("keeps incidental short chains in rice behind both LN identity gates", () => {
    const chain = Array.from({ length: 100 }, (_, i) => ({ column: 0, time: i * 114, end: i * 114 + 57 }));
    const rice = Array.from({ length: 150 }, (_, i) => ({ column: 1 + i % 3, time: i * 76 }));
    const measured = analyzeEffectiveLn(parseManiaBeatmap(osuText([...chain, ...rice], 8.5)).notes, { od: 8.5 });
    expect(measured.chainedShortHolds).toBe(99);
    expect(measured.holdRatio).toBe(0.4);
    expect(chartIsLn(4, { lnRatio: measured.holdRatio, lnEffectiveRatio: measured.effectiveLnRatio })).toBe(false);
    // An LN-shaped minority section cannot override a rice majority either.
    const sparse = Array.from({ length: 200 }, (_, i) => ({ column: i % 4, time: 20_000 + i * 200, end: 20_000 + i * 200 + 10 }));
    const mostlyFree = analyzeEffectiveLn(parseManiaBeatmap(osuText([...chain, ...sparse], 8.5)).notes, { od: 8.5 });
    expect(mostlyFree.holdRatio).toBe(1);
    expect(mostlyFree.effectiveLnRatio).toBeLessThan(LN_EFFECTIVE_MIN_RATIO);
    expect(chartIsLn(4, { lnRatio: 1, lnEffectiveRatio: mostlyFree.effectiveLnRatio })).toBe(false);
  });

  it("reads a 1/4-held stream as LN at 1.0x and rice at 1.5x", () => {
    const notes = parseManiaBeatmap(osuText(fullLnStream(), 7.5)).notes;
    const nomod = analyzeEffectiveLn(notes, { rate: 1, od: 7.5 });
    expect(nomod.holdRatio).toBeCloseTo(0.875, 2);
    // 67ms tails clear the 62ms window: every hold demands a release.
    expect(nomod.longTails).toBe(nomod.holds);
    expect(nomod.effectiveLnRatio).toBeGreaterThanOrEqual(LN_EFFECTIVE_MIN_RATIO);

    const dt = analyzeEffectiveLn(notes, { rate: 1.5, od: 7.5 });
    // 45ms tails sit inside the window with nothing pressed under them.
    expect(dt.shortTails).toBe(dt.holds);
    expect(dt.effectiveHoldRatio).toBe(0);
    expect(dt.effectiveLnRatio).toBe(0);
  });

  it("does not turn a tap-covered hold into mandatory coordination just because it spans a head", () => {
    // 80ms holds at OD 0 (96ms window) with a head 40ms in on another column.
    const notes: ChartNote[] = [];
    for (let i = 0; i < 200; i += 1) {
      const time = 1000 + i * 200;
      notes.push({ column: i % 2, time, end: time + 80 });
      notes.push({ column: 2 + (i % 2), time: time + 40 });
    }
    const analysis = analyzeEffectiveLn(parseManiaBeatmap(osuText(notes, 0)).notes, { rate: 1, od: 0 });
    expect(analysis.shortSpanning).toBe(analysis.holds);
    expect(analysis.shortTails).toBe(0);
    expect(analysis.effectiveHoldRatio).toBe(0);
    expect(analysis.effectiveLnRatio).toBe(0);
    expect(effectiveHoldMask(parseManiaBeatmap(osuText(notes, 0)).notes, { od: 0 }).some(Boolean)).toBe(false);
  });

  it.each([0.75, 1, 1.5])("keeps dense overlapping short rolls tap-like at %sx", (rate) => {
    const notes = Array.from({ length: 400 }, (_, i) => ({
      column: i % 4, time: Math.round(1000 + i * 21.67), end: Math.round(1000 + i * 21.67 + 43.34),
    }));
    const analysis = analyzeEffectiveLn(parseManiaBeatmap(osuText(notes, 0)).notes, { rate, od: 0 });
    expect(analysis.effectiveHolds).toBe(0);
    expect(chartIsLn(4, { lnRatio: analysis.holdRatio, lnEffectiveRatio: analysis.effectiveLnRatio })).toBe(false);
  });

  it("weights the chart-level share by notes, so a sparse rice intro does not dilute a dense LN body", () => {
    // 20s of sparse rice (1 note per 500ms), then 40s of dense long holds.
    const intro: ChartNote[] = Array.from({ length: 40 }, (_, i) => ({ column: i % 4, time: 1000 + i * 500 }));
    const body: ChartNote[] = Array.from({ length: 400 }, (_, i) => {
      const time = 21000 + i * 100;
      return { column: i % 4, time, end: time + 300 };
    });
    const notes = parseManiaBeatmap(osuText([...intro, ...body])).notes;
    const analysis = analyzeEffectiveLn(notes, { rate: 1, od: 8 });
    expect(analysis.effectiveLnRatio).toBeGreaterThan(0.9);
    // And the reverse: one dense LN wall in a long rice chart stays rice.
    const rice: ChartNote[] = Array.from({ length: 1200 }, (_, i) => ({ column: i % 4, time: 1000 + i * 100 }));
    const wall: ChartNote[] = Array.from({ length: 200 }, (_, i) => {
      const time = 130000 + i * 100;
      return { column: i % 4, time, end: time + 300 };
    });
    const riceChart = analyzeEffectiveLn(parseManiaBeatmap(osuText([...rice, ...wall])).notes, { rate: 1, od: 8 });
    expect(riceChart.effectiveLnRatio).toBe(0);
  });
});

describe("lnIdentityMinRatioFor", () => {
  it("pairs the effective line with 4K and the hold-share line with everything else", () => {
    expect(lnIdentityMinRatioFor(4)).toBe(LN_EFFECTIVE_MIN_RATIO);
    expect(lnIdentityMinRatioFor(7)).toBe(0.375);
    expect(lnIdentityMinRatioFor(6)).toBe(0.45);
  });

  it("accepts the charts players labelled LN and keeps both kinds of negative rice", () => {
    // Anchors from scripts/dev/ln-effective-impact.ts, 2026-09-03. Moving the
    // line past either bound needs new labels, not a nudge.
    const labelledLn = [
      { name: "Thule [Snaefellsjokull]", hold: 0.541, effective: 0.415 },
      { name: "magical, very magical world [farewell: to my memories]", hold: 0.476, effective: 0.419 },
      { name: "SYSTEM ERROR [Anisotropic System]", hold: 0.622, effective: 0.421 },
      { name: "SYSTEM ERROR [COMPLEX MISCONCEPTION | ULTRA]", hold: 0.559, effective: 0.439 },
      { name: "Last Wish", hold: 0.727, effective: 0.476 },
    ];
    for (const chart of labelledLn) {
      expect(chartIsLn(4, { lnRatio: chart.hold, lnEffectiveRatio: chart.effective }), chart.name).toBe(true);
    }

    // High hold share but free tails: the effective gate demotes these.
    for (const chart of [
      { name: "Chaoz Airflow [FULL LN]", hold: 1, effective: 0.302 },
      { name: "FREEDOM DiVE [FULL DiMENSiONS] DT", hold: 0.84, effective: 0.207 },
    ]) {
      expect(chartIsLn(4, { lnRatio: chart.hold, lnEffectiveRatio: chart.effective }), chart.name).toBe(false);
    }

    // Low hold share but a high section median: the effective statistic may
    // not promote ordinary jumpstream past the established hold-share gate.
    expect(chartIsLn(4, {
      lnRatio: 0.37796123474515436,
      lnEffectiveRatio: 0.4122137404580153,
    }), "Ange du Blanc Pur [Extra]").toBe(false);
  });
});

describe("chartLnShareFor", () => {
  it("routes 4K on the effective share and every other keymode on the hold share", () => {
    expect(chartLnShareFor(4, { lnRatio: 0.84, lnEffectiveRatio: 0.12 })).toBe(0.12);
    expect(chartLnShareFor(7, { lnRatio: 0.84, lnEffectiveRatio: 0.12 })).toBe(0.84);
    // A 4K row the sweep has not patched falls back to its hold share.
    expect(chartLnShareFor(4, { lnRatio: 0.84, lnEffectiveRatio: null })).toBe(0.84);
    expect(chartLnShareFor(4, { lnRatio: null })).toBeNull();
  });

  it("requires both the old hold-share gate and the effective gate on 4K", () => {
    expect(chartIsLn(4, { lnRatio: 0.44, lnEffectiveRatio: 0.8 })).toBe(false);
    expect(chartIsLn(4, { lnRatio: 0.8, lnEffectiveRatio: 0.39 })).toBe(false);
    expect(chartIsLn(4, { lnRatio: 0.45, lnEffectiveRatio: 0.4 })).toBe(true);
    expect(chartIsLn(4, { lnRatio: 0.8, lnEffectiveRatio: null })).toBe(true);
    expect(chartIsLn(4, { lnRatio: null, lnEffectiveRatio: 0.8 })).toBeNull();
  });
});

describe("demoteFreeHolds / lnTailPassText", () => {
  it("rewrites free holds as notes and leaves effective holds alone", () => {
    const text = osuText(fullLnStream(), 7.5);
    const holdsBefore = (text.match(/,128,/g) ?? []).length;
    const nomod = demoteFreeHolds(text, { rate: 1 });
    expect((nomod.match(/,128,/g) ?? []).length).toBe(holdsBefore);
    const dt = demoteFreeHolds(text, { rate: 1.5 });
    expect((dt.match(/,128,/g) ?? []).length).toBe(0);
    // The demoted lines are well-formed notes the parser reads as rice.
    const parsed = parseManiaBeatmap(dt);
    expect(parsed.notes.length).toBe(600);
    expect(parsed.notes.every((note) => !note.isHold)).toBe(true);
    // The mask is index-aligned with the parsed notes.
    const mask = effectiveHoldMask(parseManiaBeatmap(text).notes, { rate: 1, od: 7.5 });
    expect(mask.filter(Boolean).length).toBe(holdsBefore);
  });

  it("skips the tail pass when nothing effective remains, and keeps other keymodes' full pass", () => {
    const text = osuText(fullLnStream(), 7.5);
    expect(lnTailPassText(text, 4, { rate: 1.5, minHoldRatio: 0.02 })).toBeNull();
    expect(lnTailPassText(text, 4, { rate: 1, minHoldRatio: 0.02 })).toBe(text.split("\n").join("\n"));
    const sevenKey = osuText(fullLnStream(), 8, 7);
    expect(lnTailPassText(sevenKey, 7, { rate: 1.5, minHoldRatio: 0.02 })).toBe(sevenKey);
    const rice = osuText(fullLnStream().map(({ column, time }) => ({ column, time })));
    expect(lnTailPassText(rice, 7, { rate: 1, minHoldRatio: 0.02 })).toBeNull();
  });

  it("skips the 4K tail pass below the established hold-share gate", () => {
    const lowHold = Array.from({ length: 600 }, (_, i): ChartNote => {
      const time = 1000 + i * 100;
      return i % 5 < 2
        ? { column: i % 4, time, end: time + 300 }
        : { column: i % 4, time };
    });
    const text = osuText(lowHold);
    const analysis = analyzeEffectiveLn(parseManiaBeatmap(text).notes);
    expect(analysis.holdRatio).toBeCloseTo(0.4, 5);
    expect(analysis.effectiveHoldRatio).toBeCloseTo(0.4, 5);
    expect(lnTailPassText(text, 4, { rate: 1, minHoldRatio: 0.02 })).toBeNull();
  });
});

describe("recomputeLnEffectiveChunk", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  async function makeDb(): Promise<Db> {
    dir = await mkdtemp(join(tmpdir(), "mania-ln-effective-"));
    const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
    return db;
  }

  const lnHalf = { kind: "ln", source: "leoblack-sunny-table", label: "10", variant: null, displayName: "10", rawDan: 10.8, estimatedSr: 6, confidence: 0.6 };
  const rcHalf = { kind: "rc", source: "leoblack-mixed", label: "epsilon", variant: null, displayName: "epsilon", rawDan: 10.25, estimatedSr: 6, confidence: 0.7 };

  async function insertReady(db: Db, beatmapId: number, primary: "ln" | "rc", extra: Record<string, unknown> = {}): Promise<void> {
    const half = primary === "ln" ? lnHalf : rcHalf;
    await exec(
      db,
      `insert into beatmap_chart_analysis
         (beatmap_id, analysis_version, status, key_count, primary_label, primary_family, raw_dan,
          classification_json, dan_dt_json, dan_ht_json, updated_at)
       values (?, ?, 'ready', 4, ?, ?, ?, ?, ?, ?, ?)`,
      [
        beatmapId,
        CHART_ANALYSIS_VERSION,
        half.displayName,
        primary === "ln" ? "ln" : "dan",
        half.rawDan,
        JSON.stringify({ keyCount: 4, lnRatio: 0.875, ln: lnHalf, rc: rcHalf, primary: half, patterns: [] }),
        extra.danDt == null ? null : JSON.stringify(extra.danDt),
        extra.danHt == null ? null : JSON.stringify(extra.danHt),
        new Date().toISOString(),
      ],
    );
  }

  it("patches the share, re-routes a flipped 1.0x primary, and repairs stored rate verdicts", async () => {
    const db = await makeDb();
    // 4K full-LN stream at 1/4: LN at 1.0x, rice at 1.5x, LN at 0.75x.
    await storeCachedBeatmapFile(db, 701, osuText(fullLnStream(), 7.5), { source: "test" });
    await insertReady(db, 701, "ln", {
      danDt: { primaryLabel: "12", primaryFamily: "ln", rawDan: 12 },
      danHt: { primaryLabel: "8", primaryFamily: "ln", rawDan: 8 },
    });
    // The same chart at 1/2 (135ms tails): LN everywhere, but stored as rice.
    await storeCachedBeatmapFile(db, 702, osuText(fullLnStream(600, 135), 7.5), { source: "test" });
    await insertReady(db, 702, "rc");

    const result = await recomputeLnEffectiveChunk(db, 0, 10);
    expect(result.done).toBe(true);
    expect(result.patched).toBe(2);
    // 701 stays LN at 1.0x; 702 was stored rice and reads LN now.
    expect(result.repinned).toEqual([702]);

    const rows = (await exec(
      db,
      `select beatmap_id, primary_family, primary_label, raw_dan,
              json_extract(classification_json, '$.lnEffectiveRatio') as eff,
              json_extract(classification_json, '$.lnEffectiveVersion') as eff_version,
              json_extract(classification_json, '$.primary.kind') as primary_kind,
              dan_dt_json, dan_ht_json
       from beatmap_chart_analysis order by beatmap_id`,
    )).rows;
    const byId = new Map(rows.map((row) => [Number(row.beatmap_id), row]));

    const fd = byId.get(701)!;
    expect(Number(fd.eff)).toBeGreaterThanOrEqual(LN_EFFECTIVE_MIN_RATIO);
    expect(Number(fd.eff_version)).toBe(LN_EFFECTIVE_MODEL_VERSION);
    expect(String(fd.primary_family)).toBe("ln");
    // The DT verdict flipped to rice. With no stored MSD, the migration falls
    // back to the ordinary local rate computation instead of preserving a
    // family it now knows is wrong.
    expect(JSON.parse(String(fd.dan_dt_json))).toMatchObject({
      primaryFamily: "dan",
      lnEffectiveRatio: 0,
      lnEffectiveVersion: LN_EFFECTIVE_MODEL_VERSION,
    });
    // The HT verdict did not flip and gets the share patched in.
    const ht = JSON.parse(String(fd.dan_ht_json));
    expect(ht.primaryFamily).toBe("ln");
    expect(Number(ht.lnEffectiveRatio)).toBeGreaterThanOrEqual(LN_EFFECTIVE_MIN_RATIO);

    const slow = byId.get(702)!;
    expect(String(slow.primary_family)).toBe("ln");
    expect(String(slow.primary_label)).toBe("10");
    expect(Number(slow.raw_dan)).toBeCloseTo(10.8, 5);
    expect(String(slow.primary_kind)).toBe("ln");

    // A second pass finds nothing left to do.
    const again = await recomputeLnEffectiveChunk(db, 0, 10);
    expect(again.scanned).toBe(0);
    expect(again.done).toBe(true);
  });

  it("re-routes a row whose stored share already disagrees with the line, and leaves one with no half to route to", async () => {
    const db = await makeDb();
    // Already patched, share above the line, but wearing a rice verdict: the
    // shape a line change leaves behind. Its .osu is the slow full-LN chart,
    // so the re-derived share stays above the line.
    await storeCachedBeatmapFile(db, 801, osuText(fullLnStream(600, 135), 7.5), { source: "test" });
    await insertReady(db, 801, "rc");
    await exec(
      db,
      `update beatmap_chart_analysis
       set classification_json = json_set(classification_json, '$.lnEffectiveRatio', 0.9)
       where beatmap_id = 801`,
    );
    // Same disagreement, but the row carries no LN half, so it can never route
    // and must not re-match forever.
    await storeCachedBeatmapFile(db, 802, osuText(fullLnStream(600, 135), 7.5), { source: "test" });
    await exec(
      db,
      `insert into beatmap_chart_analysis
         (beatmap_id, analysis_version, status, key_count, primary_label, primary_family, raw_dan, classification_json, updated_at)
       values (?, ?, 'ready', 4, 'epsilon', 'dan', 10.25, ?, ?)`,
      [802, CHART_ANALYSIS_VERSION, JSON.stringify({ lnRatio: 0.875, rc: rcHalf, primary: rcHalf, lnEffectiveRatio: 0.9, patterns: [] }), new Date().toISOString()],
    );

    const result = await recomputeLnEffectiveChunk(db, 0, 10);
    // Both unversioned v1 shares must migrate, even without a half to route
    // to. Once stamped current, the no-half row must not churn forever.
    expect(result.scanned).toBe(2);
    expect(result.repinned).toEqual([801]);
    const family = (await exec(db, "select beatmap_id, primary_family from beatmap_chart_analysis order by beatmap_id")).rows;
    expect(String(family.find((row) => Number(row.beatmap_id) === 801)!.primary_family)).toBe("ln");
    expect(String(family.find((row) => Number(row.beatmap_id) === 802)!.primary_family)).toBe("dan");

    const again = await recomputeLnEffectiveChunk(db, 0, 10);
    expect(again.scanned).toBe(0);
  });

  it("refreshes MSD in the search index even when LN identity does not change", async () => {
    const db = await makeDb();
    const id = 851;
    const notes = fullLnStream(600, 135).map((note, i) => note.end != null && i % 4 === 0 ? { ...note, end: note.time + 30 } : note);
    await storeCachedBeatmapFile(db, id, osuText(notes), { source: "test" });
    await insertReady(db, id, "ln");
    await exec(db, `insert into beatmapsets (beatmapset_id, title, artist, creator, status, covers_json, metadata_json, updated_at)
      values (1, 'Test', 'Test', 'Test', 'ranked', '{}', '{}', '2026-01-01')`);
    await exec(db, `insert into beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, bpm, max_combo, version, url, metadata_json, updated_at)
      values (?, 1, 'mania', 'ranked', 4, 5, 180, 1000, '4K', '', '{"mode":"mania","status":"ranked"}', '2026-01-01')`, [id]);
    await exec(db, `insert into beatmap_skill_vectors (beatmap_id, analysis_version, status, skills_json, updated_at)
      values (?, ?, 'ready', '{}', '2026-01-01')`, [id, ACTIVITY_SKILL_ANALYSIS_VERSION]);
    await exec(db, `update beatmap_chart_analysis set msd_json = ?, msd_ln_json = ?, msd_dt_json = ?, updated_at = '2026-01-01' where beatmap_id = ?`,
      [JSON.stringify({ values: { Overall: 20 } }), JSON.stringify({ values: { Overall: 99 } }), JSON.stringify({ values: { Overall: 30 } }), id]);
    await upsertMapSearchIndexRow(db, id);
    const result = await recomputeLnEffectiveChunk(db, 0, 10);
    expect(result.repinned).toEqual([]);
    const row = (await exec(db, `select a.msd_json, a.msd_dt_json, a.msd_ln_json as tails, i.msd_ln_json as index_tails,
      i.msd_json as index_msd, a.updated_at from beatmap_chart_analysis a join map_search_index i using (beatmap_id) where a.beatmap_id = ?`, [id])).rows[0];
    expect(row.tails).toBe(row.index_tails);
    expect(row.tails).toBeNull(); // Obsolete 4K tails-as-taps artifacts are cleared.
    expect(row.msd_json).toBe(row.index_msd);
    expect(JSON.parse(String(row.msd_json))).toMatchObject({ values: { Overall: 20 }, lnSkill: { version: LN_SKILL_VERSION } });
    expect(JSON.parse(String(row.msd_dt_json))).toMatchObject({ values: { Overall: 30 }, lnSkill: { version: LN_SKILL_VERSION, rate: 1.5 } });
    expect(row.updated_at).not.toBe("2026-01-01");
    expect((await recomputeLnEffectiveChunk(db, 0, 10)).scanned).toBe(0);
    db.close();
  });

  it("migrates overlap-only short LN charts to rice and clears published LN difficulty at every cached rate", async () => {
    const db = await makeDb();
    const id = 852;
    const notes = Array.from({ length: 400 }, (_, i) => ({
      column: i % 4, time: Math.round(1000 + i * 21.67), end: Math.round(1000 + i * 21.67 + 43.34),
    }));
    await storeCachedBeatmapFile(db, id, osuText(notes, 0), { source: "test" });
    await insertReady(db, id, "ln");
    const artifact = JSON.stringify({ values: { Overall: 24.31, LN: 34.49 }, lnSkill: { version: 4, eligible: true } });
    await exec(db, `update beatmap_chart_analysis set msd_json = ?, msd_dt_json = ?, msd_ht_json = ?,
      classification_json = json_set(classification_json, '$.lnEffectiveVersion', 1, '$.lnEffectiveRatio', 0.8)
      where beatmap_id = ?`, [artifact, artifact, artifact, id]);
    const result = await recomputeLnEffectiveChunk(db, id - 1, 1);
    expect(result.repinned).toEqual([id]);
    const row = (await exec(db, "select * from beatmap_chart_analysis where beatmap_id = ?", [id])).rows[0];
    expect(row.primary_family).toBe("dan");
    expect(JSON.parse(String(row.classification_json))).toMatchObject({ lnEffectiveRatio: 0, lnEffectiveVersion: LN_EFFECTIVE_MODEL_VERSION });
    for (const column of ["msd_json", "msd_dt_json", "msd_ht_json"]) {
      expect(JSON.parse(String(row[column]))).toMatchObject({ values: { Overall: 24.31, LN: 0 },
        lnSkill: { version: LN_SKILL_VERSION, eligible: false, rating: 0, effectiveHolds: 0 } });
    }
    expect((await recomputeLnEffectiveChunk(db, id - 1, 1)).scanned).toBe(0);
    db.close();
  });

  it("re-reads a chain-dense chart as LN at 1.0x and HT while DT, under the chain floor, stays rice", async () => {
    const db = await makeDb();
    // 56ms bodies on a 114ms grid at OD 8 (60ms window, 40ms chain floor):
    // chained at 1.0x, long at 0.75x, free at 1.5x (37ms bodies).
    const notes = Array.from({ length: 200 }, (_, i) => ({ column: i % 2, time: i * 57, end: i * 57 + 56 }));
    await storeCachedBeatmapFile(db, 735, osuText(notes, 8), { source: "test" });
    await insertReady(db, 735, "rc", {
      danDt: { primaryFamily: "dan", lnEffectiveRatio: 0, lnEffectiveVersion: 4 },
      danHt: { primaryFamily: "ln", lnEffectiveRatio: 1, lnEffectiveVersion: 4 },
    });
    const stale = JSON.stringify({ values: { Overall: 20, LN: 0 }, lnSkill: { version: 7, eligible: false, rating: 25 } });
    await exec(db, `update beatmap_chart_analysis set
      classification_json = json_set(classification_json, '$.lnRatio', 1, '$.lnEffectiveRatio', 0, '$.lnEffectiveVersion', 4),
      msd_json = ?, msd_dt_json = ?, msd_ht_json = ? where beatmap_id = 735`, [stale, stale, stale]);
    expect((await recomputeLnEffectiveChunk(db, 0, 10)).patched).toBe(1);
    const row = (await exec(db, "select * from beatmap_chart_analysis where beatmap_id = 735")).rows[0];
    expect(row.primary_family).toBe("ln");
    expect(JSON.parse(String(row.classification_json)).lnEffectiveVersion).toBe(LN_EFFECTIVE_MODEL_VERSION);
    expect(JSON.parse(String(row.dan_dt_json))).toMatchObject({ primaryFamily: "dan", lnEffectiveRatio: 0,
      lnEffectiveVersion: LN_EFFECTIVE_MODEL_VERSION });
    expect(JSON.parse(String(row.dan_ht_json))).toMatchObject({ primaryFamily: "ln", lnEffectiveRatio: 1,
      lnEffectiveVersion: LN_EFFECTIVE_MODEL_VERSION });
    for (const column of ["msd_json", "msd_dt_json", "msd_ht_json"]) {
      const artifact = JSON.parse(String(row[column]));
      expect(artifact.values.Overall).toBe(20);
      const eligible = column !== "msd_dt_json";
      // Past the hold line the LN number is published at every rate that has
      // LN work to rate; at DT the free bodies leave none, so nothing is rated.
      expect(artifact.lnSkill).toMatchObject({ version: LN_SKILL_VERSION, eligible, rated: eligible });
      if (eligible) expect(artifact.values.LN).toBeGreaterThan(0);
      else expect(artifact.values.LN).toBe(0);
      expect(artifact.lnSkill).not.toHaveProperty("structure");
    }
    expect((await recomputeLnEffectiveChunk(db, 0, 10)).scanned).toBe(0);
    db.close();
  });

  it("lets the stored LN rating decide identity for a hold-heavy chart structure left rice", async () => {
    const db = await makeDb();
    // Sparse long holds plus free short holds: 55% holds, 9% long share.
    const notes: ChartNote[] = [
      ...Array.from({ length: 20 }, (_, i) => ({ column: 0, time: i * 2000, end: i * 2000 + 300 })),
      ...Array.from({ length: 100 }, (_, i) => ({ column: 1, time: 50 + i * 400, end: 50 + i * 400 + 30 })),
      ...Array.from({ length: 100 }, (_, i) => ({ column: 2 + (i % 2), time: 25 + i * 400 })),
    ];
    await storeCachedBeatmapFile(db, 736, osuText(notes, 8), { source: "test" });
    await insertReady(db, 736, "rc", { danDt: { primaryFamily: "dan", lnEffectiveRatio: 0.09, lnEffectiveVersion: 4 } });
    const lowOverall = JSON.stringify({ values: { Overall: 0.5, LN: 0 }, lnSkill: { version: 7, eligible: false, rating: 3 } });
    const highOverall = JSON.stringify({ values: { Overall: 100, LN: 0 }, lnSkill: { version: 7, eligible: false, rating: 3 } });
    await exec(db, `update beatmap_chart_analysis set
      classification_json = json_set(classification_json, '$.lnRatio', 0.545, '$.lnEffectiveRatio', 0.09, '$.lnEffectiveVersion', 4),
      msd_json = ?, msd_dt_json = ? where beatmap_id = 736`, [lowOverall, highOverall]);
    expect((await recomputeLnEffectiveChunk(db, 0, 10)).repinned).toEqual([736]);
    const row = (await exec(db, "select * from beatmap_chart_analysis where beatmap_id = 736")).rows[0];
    expect(row.primary_family).toBe("ln");
    const stored = JSON.parse(String(row.classification_json));
    expect(stored).toMatchObject({ lnEffectiveRatio: LN_EFFECTIVE_MIN_RATIO, lnRatingIdentity: true, lnEffectiveVersion: LN_EFFECTIVE_MODEL_VERSION });
    expect(stored.lnStructuralRatio).toBeLessThan(LN_EFFECTIVE_MIN_RATIO);
    // At DT the stored Overall is far above the LN rating: structure stands.
    expect(JSON.parse(String(row.dan_dt_json))).toMatchObject({ primaryFamily: "dan", lnRatingIdentity: false });
    expect(JSON.parse(String(row.dan_dt_json)).lnEffectiveRatio).toBeLessThan(LN_EFFECTIVE_MIN_RATIO);
    // The published LN number does not depend on identity.
    expect(JSON.parse(String(row.msd_json)).values.LN).toBeGreaterThan(0);
    expect((await recomputeLnEffectiveChunk(db, 0, 10)).scanned).toBe(0);
    db.close();
  });

  it("does not regenerate removed search evidence when rating and identity versions are current", async () => {
    const db = await makeDb();
    const id = 853;
    await storeCachedBeatmapFile(db, id, osuText(fullLnStream(600, 135), 7.5), { source: "test" });
    await insertReady(db, id, "ln");
    await exec(db, `update beatmap_chart_analysis set msd_json = ?,
      classification_json = json_set(classification_json, '$.lnEffectiveVersion', ?, '$.lnEffectiveRatio', 0.875)
      where beatmap_id = ?`, [JSON.stringify({ values: { Overall: 20, LN: 14 },
      lnSkill: { version: LN_SKILL_VERSION, eligible: true } }), LN_EFFECTIVE_MODEL_VERSION, id]);
    expect((await recomputeLnEffectiveChunk(db, id - 1, 1)).scanned).toBe(0);
    const row = (await exec(db, "select msd_json from beatmap_chart_analysis where beatmap_id = ?", [id])).rows[0];
    expect(JSON.parse(String(row.msd_json)).lnSkill).not.toHaveProperty("structure");
    expect((await recomputeLnEffectiveChunk(db, id - 1, 1)).scanned).toBe(0);
    db.close();
  });

  it.each(Array.from({ length: 14 }, (_, i) => i + 5))("excludes %iK charts from the LN v2 sweep", async keyCount => {
    const db = await makeDb();
    const id = 861;
    const notes = fullLnStream(600, 135).map((note, i) => ({ ...note, column: i % keyCount }));
    await storeCachedBeatmapFile(db, id, osuText(notes, 8, keyCount), { source: "test" });
    await insertReady(db, id, "ln", { danDt: { primaryFamily: "ln", primaryLabel: "10", rawDan: 10 } });
    const base = JSON.stringify({ values: { Overall: 20, Stream: 15 } });
    const tails = JSON.stringify({ values: { Overall: 40, Stream: 25 } });
    await exec(db, `update beatmap_chart_analysis set key_count = ?, msd_json = ?, msd_dt_json = ?, msd_ht_json = ?, msd_ln_json = ?
      where beatmap_id = ?`, [keyCount, base, base, base, tails, id]);
    const before = (await exec(db, "select * from beatmap_chart_analysis where beatmap_id = ?", [id])).rows[0];
    const result = await recomputeLnEffectiveChunk(db, 0);
    expect(result).toMatchObject({ scanned: 0, patched: 0, repinned: [], rateRewritten: 0, done: true });
    const row = (await exec(db, "select * from beatmap_chart_analysis where beatmap_id = ?", [id])).rows[0];
    expect(row.classification_json).toBe(before.classification_json);
    expect(row.primary_family).toBe(before.primary_family);
    expect(row.dan_dt_json).toBe(before.dan_dt_json);
    expect(row.msd_ln_json).toBe(tails);
    expect(row).toEqual(before);
    expect((await recomputeLnEffectiveChunk(db, 0)).scanned).toBe(0);
    db.close();
  });

  it("rewinds a previous model's sweep so stale 4K artifacts below its cursor are not skipped", async () => {
    const db = await makeDb();
    await storeCachedBeatmapFile(db, 50, osuText(fullLnStream(600, 135), 8, 4), { source: "test" });
    await insertReady(db, 50, "ln");
    await exec(db, "update beatmap_chart_analysis set key_count = 4, msd_json = ? where beatmap_id = 50", [JSON.stringify({ values: { Overall: 20 } })]);
    expect(await runLnEffectiveRecomputeJob(db, new JobQueue(db), { cursor: 1000, modelVersion: LN_SKILL_VERSION - 1 })).toBe(true);
    const row = (await exec(db, "select msd_json from beatmap_chart_analysis where beatmap_id = 50")).rows[0];
    expect(JSON.parse(String(row.msd_json)).lnSkill).toMatchObject({ version: LN_SKILL_VERSION, keyCount: 4 });
    db.close();
  });

  it("demotes a legacy effective-only primary that never passed the hold-share gate", async () => {
    const db = await makeDb();
    await storeCachedBeatmapFile(db, 901, osuText(fullLnStream(600, 135), 7.5), { source: "test" });
    await insertReady(db, 901, "ln");
    await exec(
      db,
      `update beatmap_chart_analysis
       set msd_json = json(?), msd_ln_json = json(?),
           classification_json = json_set(
         classification_json,
         '$.lnRatio', 0.37796123474515436,
         '$.lnEffectiveRatio', 0.4122137404580153
       )
       where beatmap_id = 901`,
      [JSON.stringify({ values: { Overall: 21.66 } }), JSON.stringify({ values: { Overall: 32.21 } })],
    );

    const result = await recomputeLnEffectiveChunk(db, 0, 10);
    expect(result).toMatchObject({ scanned: 1, repinned: [901], done: true });
    const row = (await exec(
      db,
      `select primary_family, msd_ln_json,
              json_extract(classification_json, '$.lnEffectiveVersion') as effective_version
       from beatmap_chart_analysis where beatmap_id = 901`,
    )).rows[0];
    expect(String(row.primary_family)).toBe("dan");
    expect(row.msd_ln_json).toBeNull();
    expect(Number(row.effective_version)).toBe(LN_EFFECTIVE_MODEL_VERSION);
    db.close();
  });
});
