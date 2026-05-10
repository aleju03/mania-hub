export type DanBenchmarkFamily = "normal" | "ln";

export const NORMAL_BENCHMARK_BEATMAPSET_IDS: number[] = [
  1748375,
  500905,
  828129,
  584698,
  1104418,
  2539883,
  1901547,
  1796144,
  2524546,
  547451,
  1702864,
  224173,
  2180795,
  2180049,
  2184908,
  2182025,
  1079991,
  1079998,
  1156299,
  1188968,
  2221500,
  1320653,
];

export const LN_BENCHMARK_BEATMAPSET_IDS: number[] = [
  1116467,
  891143,
  891152,
  891157,
  891164,
  1672678,
  1736649,
  1626654,
  1536872,
  1117267,
  1498684,
  1490583,
  1482461,
  1508080,
  2181595,
  1117284,
  926593,
];

export function getBenchmarkBeatmapsetIds(family: DanBenchmarkFamily): number[] {
  return family === "ln" ? LN_BENCHMARK_BEATMAPSET_IDS : NORMAL_BENCHMARK_BEATMAPSET_IDS;
}

export const NORMAL_DAN_LABEL_OPTIONS: string[] = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "zeta",
  "eta",
];

export const LN_DAN_LABEL_OPTIONS: string[] = Array.from({ length: 16 }, (_, index) => String(index + 1));

export function getBenchmarkLabelOptions(family: DanBenchmarkFamily): string[] {
  return family === "ln" ? LN_DAN_LABEL_OPTIONS : NORMAL_DAN_LABEL_OPTIONS;
}
