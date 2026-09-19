/** Read-only calibration/diagnostics. From live-backend/:
 * node --import tsx scripts/dev/ln-skill-benchmark.ts [path/to/database.db]
 * Course identities select the offline evaluation set only, never runtime ratings.
 */
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { listDanCourses } from "../../src/features/dan-courses.js";
import { analyzeLnSkillFromText, isLnSkillSupported, lnSkillCalibrationFor, LN_SKILL_KEY_COUNTS, LN_SKILL_VERSION } from "../../src/dan/ln-skill.js";
import { danTableLevelForLabel } from "../../src/dan/chart-classifier.js";
import { CHART_ANALYSIS_VERSION } from "../../src/features/chart-analysis.js";
import { parseManiaBeatmap } from "../../src/dan/beatmap-parser.js";
import { analyzeEffectiveLn, chartIsLn, LN_EFFECTIVE_MODEL_VERSION } from "../../src/dan/dan-estimator/ln-effective.js";

const args = process.argv.slice(2);
const db = new DatabaseSync(args.find(arg => !arg.startsWith("--")) ?? "./data/mania-hub-live.db", { readOnly: true });
function chartText(id: number): string | null {
  const row = db.prepare("select content, content_blob, compression from beatmap_osu_files where beatmap_id = ?").get(id);
  if (!row) return null;
  return row.compression === "gzip" && row.content_blob instanceof Uint8Array
    ? gunzipSync(row.content_blob).toString("utf8") : typeof row.content === "string" ? row.content : null;
}
const courses = listDanCourses().filter(course => isLnSkillSupported(course.keyCount) && course.side === "ln");
const rows = courses.flatMap(course => {
  const text = chartText(course.beatmapId);
  if (!text) return [];
  const skill = analyzeLnSkillFromText(text)!;
  const chart = db.prepare("select msd_overall from beatmap_chart_analysis where beatmap_id = ? and analysis_version = ?")
    .get(course.beatmapId, CHART_ANALYSIS_VERSION);
  const level = course.keyCount === 4 ? Number(course.level) : danTableLevelForLabel(course.level, "ln", course.keyCount);
  return [{ id: course.beatmapId, level: Number(level), sha256: createHash("sha256").update(text).digest("hex"),
    ...skill, effective: analyzeEffectiveLn(parseManiaBeatmap(text).notes, { od: skill.od }),
    referenceMsd: Number(chart?.msd_overall ?? 0) }];
});
// Fit only a scale and exponent, against base chart MSD. This puts LN in a
// familiar numerical range; it does not establish equal difficulty across axes.
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const ranks = (values: number[]) => values.map(value => 1 + values.filter(other => other < value).length + (values.filter(other => other === value).length - 1) / 2);
const correlation = (x: number[], y: number[]) => {
  const a = ranks(x), b = ranks(y), ma = mean(a), mb = mean(b);
  return a.reduce((sum, value, i) => sum + (value - ma) * (b[i] - mb), 0)
    / Math.sqrt(a.reduce((sum, value) => sum + (value - ma) ** 2, 0) * b.reduce((sum, value) => sum + (value - mb) ** 2, 0));
};
const byKeyCount = Object.fromEntries([...new Set(courses.map(course => course.keyCount))].map(keyCount => {
  const group = rows.filter(row => row.keyCount === keyCount);
  const training = group.filter(row => row.level % 2 === 1 && row.strain > 0 && row.referenceMsd > 0);
  const diagnostic = group.filter(row => row.level % 2 === 0 && row.referenceMsd > 0);
  const rated = group.filter((row): row is typeof row & { rating: number } => row.rating != null && Number.isFinite(row.rating));
  const xs = training.map(row => Math.log(row.strain)), ys = training.map(row => Math.log(row.referenceMsd));
  const mx = mean(xs), my = mean(ys);
  const exponent = xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0) / xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  const scale = Math.exp(my - exponent * mx);
  return [keyCount, {
    current: lnSkillCalibrationFor(keyCount),
    calibration: { training: training.length, diagnostic: diagnostic.length, scale, exponent,
      diagnosticMsdMae: mean(diagnostic.map(row => Math.abs(scale * row.strain ** exponent - row.referenceMsd))),
      shippedDiagnosticMsdMae: mean(diagnostic.map(row => Math.abs((row.rating ?? NaN) - row.referenceMsd))) },
    courseOrderSpearman: rated.length >= 2 ? correlation(rated.map(row => row.level), rated.map(row => row.rating)) : null,
    unavailableRatings: group.length - rated.length,
    courseEligible: group.filter(row => row.eligible).length, coursesAvailable: group.length,
    coursesExpected: courses.filter(course => course.keyCount === keyCount).length,
  }];
}));
const examples = [3938191, 5635525, 5635526, 3133038].flatMap(id => {
  const text = chartText(id);
  return text ? [1, 1.25, 1.5].map(rate => ({ id, ...analyzeLnSkillFromText(text, { rate })! })) : [];
});
// Smoke-test real cached charts in the supported 4K mode. These samples
// check coverage/finite output, not human-labelled rating accuracy.
const coverage = [...LN_SKILL_KEY_COUNTS].map(keyCount => {
  const ids = db.prepare(`select m.beatmap_id from map_search_index m
    join beatmap_chart_analysis a on a.beatmap_id = m.beatmap_id and a.analysis_version = ?
    join beatmap_osu_files f on f.beatmap_id = m.beatmap_id
    where m.key_count = ? and m.primary_pattern = 'ln' and a.status = 'ready'
    order by m.stars desc limit 3`).all(CHART_ANALYSIS_VERSION, keyCount);
  const samples = ids.flatMap(row => {
    const id = Number(row.beatmap_id), text = chartText(id);
    return text ? [1, 1.37].map(rate => ({ id, ...analyzeLnSkillFromText(text, { rate })! })) : [];
  });
  return { keyCount, charts: ids.length, checkedRates: samples.length,
    finite: samples.length ? samples.every(sample => Number.isFinite(sample.rating) && sample.keyCount === keyCount) : null, samples };
});
// Regression controls are offline evaluation fixtures only. No runtime model
// branches on their identities. Also inspect the nearest sub-45% cached charts.
// The first control is an OD 0 LN vibro pack chart with 74% holds of 43ms:
// once identity read the release window at OD 5 (LN_IDENTITY_MIN_OD) its
// bodies reached the window at 0.75x and chained into an inverse reading,
// which is why LN vibro charts form no chains (ln-effective.ts).
const controlIds = [1146279, 992512];
const incidental = db.prepare(`select beatmap_id from beatmap_chart_analysis
  where analysis_version = ? and key_count = 4 and status = 'ready'
    and json_extract(classification_json, '$.lnRatio') > 0
    and json_extract(classification_json, '$.lnRatio') < 0.45
  order by json_extract(classification_json, '$.lnRatio') desc, beatmap_id limit 1000`).all(CHART_ANALYSIS_VERSION);
const riceControls = [...new Set([...controlIds, ...incidental.map(row => Number(row.beatmap_id))])].flatMap(id => {
  const text = chartText(id);
  if (!text) return [];
  const map = parseManiaBeatmap(text);
  return [0.75, 1, 1.5].map(rate => {
    const effective = analyzeEffectiveLn(map.notes, { rate, od: map.od });
    return { id, rate, ...effective, eligible: chartIsLn(4, { lnRatio: effective.holdRatio, lnEffectiveRatio: effective.effectiveLnRatio }) };
  });
});
// High-hold DT negatives catch a different failure than the sub-45% controls:
// tap-covered same-lane chains must not supply chart identity. Identities
// select offline fixtures only and are never read by the runtime model.
const highHoldDtControlIds = [3938191, 4148220];
const highHoldDtControls = highHoldDtControlIds.flatMap(id => {
  const text = chartText(id);
  if (!text) return [];
  const map = parseManiaBeatmap(text);
  const effective = analyzeEffectiveLn(map.notes, { rate: 1.5, od: map.od });
  return [{ id, rate: 1.5, ...effective,
    eligible: chartIsLn(4, { lnRatio: effective.holdRatio, lnEffectiveRatio: effective.effectiveLnRatio }) }];
});
const baselinePath = args.find(arg => arg.startsWith("--baseline="))?.slice("--baseline=".length);
const baseline: { courses: Array<{ id: number; sha256: string; rating: number | null; referenceMsd: number }> } | null
  = baselinePath ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;
const comparison = rows.map(row => {
  const before = baseline?.courses.find(entry => entry.id === row.id);
  if (baseline && (!before || before.sha256 !== row.sha256)) throw new Error(`Baseline chart content mismatch at course level ${row.level}`);
  return { level: row.level, lnBefore: before?.rating ?? null, lnAfter: row.rating,
    overallBefore: before?.referenceMsd ?? null, overallAfter: row.referenceMsd };
});
const group = byKeyCount[4];
// Scale and exponent covary in a log fit. Compare the two curves on the
// same measured strains, in rating units, rather than bounding coefficients.
const ratingSpaceComparison = rows.filter(row => row.keyCount === 4).map(row => {
  const refitRating = group.calibration.scale * row.strain ** group.calibration.exponent;
  return { level: row.level, shippedRating: row.rating, refitRating,
    absoluteDifference: row.rating == null ? NaN : Math.abs(row.rating - refitRating) };
});
const maxRatingSpaceDifference = ratingSpaceComparison.length
  ? Math.max(...ratingSpaceComparison.map(row => row.absoluteDifference)) : null;
const rating = (level: number) => rows.find(row => row.keyCount === 4 && row.level === level)?.rating ?? -Infinity;
const acceptance = {
  all17Courses: group?.coursesAvailable === 17 && group.coursesExpected === 17 && group.courseEligible === 17 && group.unavailableRatings === 0,
  spearmanAtLeast095: (group?.courseOrderSpearman ?? 0) >= 0.95,
  topCoursesAbove15: rating(16) > rating(15) && rating(17) > rating(15),
  ratingSpaceDifferenceUnder1: ratingSpaceComparison.length === 17
    && ratingSpaceComparison.every(row => Number.isFinite(row.absoluteDifference) && row.absoluteDifference < 1),
  riceControlsPresent: controlIds.every(id => riceControls.some(row => row.id === id)) && riceControls.length > controlIds.length * 3,
  riceControlsRemainRice: riceControls.length > 0 && riceControls.every(row => row.eligible === false),
  highHoldDtControlsPresent: highHoldDtControls.length === highHoldDtControlIds.length,
  highHoldDtControlsRemainRice: highHoldDtControls.every(row => row.holdRatio >= 0.45 && row.eligible === false),
  nativeReferencePresent: rows.every(row => row.referenceMsd > 0),
};
console.log(JSON.stringify({ modelVersion: LN_SKILL_VERSION, effectiveModelVersion: LN_EFFECTIVE_MODEL_VERSION,
  acceptance, ratingSpaceComparison, maxRatingSpaceDifference, comparison, riceControls, highHoldDtControls,
  byKeyCount, coverage,
  courseEligible: rows.filter(row => row.eligible).length, coursesAvailable: rows.length, coursesExpected: courses.length,
  courses: rows, examples }, null, 2));
db.close();
if (args.includes("--check") && Object.values(acceptance).some(passed => !passed)) process.exitCode = 1;
