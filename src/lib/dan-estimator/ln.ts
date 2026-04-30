import type { ManiaBeatmap } from "../beatmap-parser";
import type { DanEstimateInput, DanFeatureMetrics } from "./types";

export interface LnDanEstimateResult {
  label: string;
  variant: string | null;
  displayName: string;
  rawDan: number;
  estimatedSr: number;
  confidence: number;
  reason: string;
}

interface KnownLnTarget {
  version: string;
  target: string;
  rate?: number;
}

interface LnReferenceChart {
  level: number;
  n: number;
  s: number;
  h: number;
  d: number;
  o: number;
  r: number;
  c: number;
  p: number;
  u: number;
  q: number;
}

const KNOWN_LN_TARGETS: KnownLnTarget[] = [
  { version: "1st Dan (Marathon)", target: "LN 1" },
  { version: "2nd Dan (Marathon)", target: "LN 2" },
  { version: "3rd Dan (Marathon)", target: "LN 3" },
  { version: "4th Dan (Marathon)", target: "LN 4" },
  { version: "5th Dan (Marathon)", target: "LN 5" },
  { version: "6th Dan (Marathon)", target: "LN 6" },
  { version: "7th Dan (Marathon)", target: "LN 7" },
  { version: "8th Dan (Marathon)", target: "LN 8" },
  { version: "9th Dan (Marathon)", target: "LN 9" },
  { version: "10th Dan (Marathon)", target: "LN 10" },
  { version: "11th Dan - Yoake (Marathon)", target: "LN 11" },
  { version: "12th Dan - Yuugure (Marathon)", target: "LN 12" },
  { version: "13th Dan - Yoru (Marathon)", target: "LN 13" },
  { version: "14th Dan - Yami (Marathon)", target: "LN 14" },
  { version: "15th Dan - Yume (Marathon)", target: "LN 15" },
  { version: "in the dark", target: "LN 14" },
  { version: "Youmu's Dream 1.1x", target: "LN 15", rate: 1.025 },
  { version: "a_hisa - Celestial Exploring (Short Edit) [FULL LN]", target: "LN 9" },
  { version: "Camellia feat. nanahira - finorza [zzzzzzsa6177 feat. Hylotl]", target: "LN 12+" },
  { version: "Hoshino Kanako - Medicine of love", target: "LN 8" },
  { version: "katagiri - Nyan-Nyan Naughty Night", target: "LN 13+" },
  { version: "katagiri - Sendan Life (katagiri bootleg)", target: "LN 13" },
  { version: "Ogura Yui - Heart Forest", target: "LN 9" },
  { version: "sak feat.myui - Unleashed World", target: "LN 12" },
  { version: "SHIKI - Pure Ruby", target: "LN 10" },
  { version: "sound piercer - Ten, Sen, Men, Rittai [LN JACK]", target: "LN 12" },
  { version: "xi - Akasha", target: "LN 10" },
  { version: "Camellia - Kisaragi [zzzzzzsa6177's Tsuki no Youni]", target: "LN 12+" },
  { version: "Co shu Nie - bullet", target: "LN 10" },
  { version: "DJ Sharpnel - Shihen (Piece of Poetry)", target: "LN 11+" },
  { version: "Gothpheus - Rosen Vampir [Muses' Full LN Challenge]", target: "LN 9" },
  { version: "Hana - Sakura no Uta", target: "LN 8" },
  { version: "Kanae Tachibana composed by nmk - Elsa de la bibliotheque [Sayonara]", target: "LN 11" },
  { version: "Kanae Tachibana composed by nmk - Elsa de la bibliotheque [Yumemiru]", target: "LN 6+" },
  { version: "katagiri - ch3rry [Too Sweet!!]", target: "LN 13" },
  { version: "katagiri - ch3rry", target: "LN 10" },
  { version: "katagiri - L4.8TS", target: "LN 11+" },
  { version: "Kurenainagi Tabibito - Otenba Koimusume [zzzzzzsa6177's Frozen World]", target: "LN 9+" },
  { version: "Laur - Exitium", target: "LN 14" },
  { version: "Shaman Cure-All - Tuk Tuk Boshi", target: "LN 13" },
  { version: "Shimotsuki Haruka - Re:Call", target: "LN 7" },
  { version: "Ariabl'eyeS - Kegare Naki Bara Juuji", target: "LN 14+" },
  { version: "Ayase Eli (Yoshino Nanjo) - Kaku mo Yuubi na Hi to Narite (Cut ver.)", target: "LN 13+" },
  { version: "Ayase Eli (Yoshino Nanjo) - Kaku mo Yuubi na Hi to Narite", target: "LN 14" },
  { version: "Feryquitous feat. Aitsuki Nakuru - Kairikou (Cut ver.) [Mapped by zzzzzzsa6177]", target: "LN 12" },
  { version: "Kaneko Chiharu - Zettai Reido [Muses' LN Challenge]", target: "LN 10+" },
  { version: "Kucchi - Sitairyokou (Edit from tera's map)", target: "LN 12" },
  { version: "Omoi, Hatsune Miku - Snow Drive (Cut ver.)", target: "LN 12+" },
  { version: "Silentroom - Shuu no Hazama", target: "LN 13" },
  { version: "Sound piercer feat. DAZBEE - Hanatachi ni Kibouwo", target: "LN 9" },
  { version: "Unison Square Garden - Sugar Song to Bitter Step", target: "LN 9+" },
  { version: "Bad Religion - 21st Century (Kopophobia remix) [Full LN Challenge]", target: "LN 14" },
  { version: "Camellia - Circles of Death", target: "LN 12" },
  { version: "Camellia - Enantiomorphs", target: "LN 11" },
  { version: "Chroma - Hoshi ga Furanai Machi (Cut) [LN Edit]", target: "LN 8+" },
  { version: "EMILIA - Stay Alive (Zekk Remix) [LN Edit]", target: "LN 11+" },
  { version: "goreshit - satori de pon!", target: "LN 13-" },
  { version: "Kaf - Hissei yo [LN Edit]", target: "LN 10" },
  { version: "Lia - I miss you (DJ Sharpnel Remix)", target: "LN 9" },
  { version: "MisomyL - Amnehilesie", target: "LN 12" },
  { version: "MisomyL - Catalinesie", target: "LN 13-" },
  { version: "Papiyon / GUMI - Kokoronashi", target: "LN 8" },
  { version: "Sangatsu no Phantasia - Pastel Rain [LN Edited from hinako1804]", target: "LN 12+" },
  { version: "Camellia as \"fluX Xroise\" - Xronier (\"geneXe\" Long ver.)", target: "LN 13+" },
];

const LN_REFERENCE_CHARTS: LnReferenceChart[] = [
  { level: 1, n: 717, s: 88.7, h: 0.245, d: 0.153, o: 2.012, r: 4.829, c: 0.594, p: 10.8, u: 10.3, q: 0.577 },
  { level: 1, n: 336, s: 85.7, h: 0.568, d: 0.277, o: 2.506, r: 5.5, c: 0.6, p: 5.4, u: 5.2, q: 0.553 },
  { level: 1, n: 176, s: 111.6, h: 0.602, d: 0.399, o: 2.996, r: 3.42, c: 0.152, p: 2.8, u: 2.1, q: 0.15 },
  { level: 1, n: 613, s: 111.3, h: 0.664, d: 0.235, o: 2.339, r: 7.503, c: 0.21, p: 8.2, u: 7.5, q: 0.19 },
  { level: 2, n: 805, s: 118, h: 0.471, d: 0.269, o: 2.476, r: 7.303, c: 0.718, p: 8.6, u: 8, q: 0.585 },
  { level: 2, n: 805, s: 121.9, h: 0.757, d: 0.395, o: 2.982, r: 9.229, c: 0.388, p: 8.6, u: 8.1, q: 0.374 },
  { level: 2, n: 377, s: 104.1, h: 0.87, d: 0.639, o: 3.957, r: 8.452, c: 0.38, p: 8, u: 6, q: 0.385 },
  { level: 2, n: 805, s: 107, h: 1, d: 0.325, o: 2.698, r: 14.602, c: 0.158, p: 13.2, u: 12.7, q: 0.158 },
  { level: 3, n: 836, s: 107, h: 0.561, d: 0.295, o: 2.581, r: 8.344, c: 0.342, p: 10.2, u: 9.6, q: 0.319 },
  { level: 3, n: 921, s: 128.5, h: 0.457, d: 0.328, o: 2.711, r: 6.504, c: 0.22, p: 15.6, u: 14.6, q: 0.23 },
  { level: 3, n: 612, s: 104, h: 0.438, d: 0.347, o: 2.79, r: 4.732, c: 0.375, p: 9.4, u: 9.2, q: 0.345 },
  { level: 3, n: 1155, s: 111.5, h: 0.466, d: 0.282, o: 2.528, r: 12.565, c: 0.619, p: 13.2, u: 12.7, q: 0.424 },
  { level: 4, n: 907, s: 123.1, h: 0.62, d: 0.316, o: 2.665, r: 11.085, c: 0.418, p: 12.4, u: 10.6, q: 0.389 },
  { level: 4, n: 1053, s: 118.7, h: 0.524, d: 0.197, o: 2.186, r: 12.4, c: 0.436, p: 12, u: 11.3, q: 0.37 },
  { level: 4, n: 413, s: 94.4, h: 0.891, d: 0.711, o: 4.245, r: 9.589, c: 0.412, p: 8.6, u: 6.9, q: 0.363 },
  { level: 4, n: 1066, s: 115.8, h: 1, d: 0.494, o: 3.377, r: 14.813, c: 0.385, p: 13.2, u: 12.2, q: 0.385 },
  { level: 5, n: 1904, s: 166.8, h: 0.553, d: 0.235, o: 2.339, r: 12.739, c: 0.732, p: 15.6, u: 15.3, q: 0.64 },
  { level: 5, n: 887, s: 115.8, h: 0.818, d: 0.414, o: 3.058, r: 12.1, c: 0.483, p: 13.8, u: 11.8, q: 0.414 },
  { level: 5, n: 1380, s: 147.2, h: 0.386, d: 0.344, o: 2.775, r: 11, c: 0.851, p: 14.8, u: 13.3, q: 0.691 },
  { level: 5, n: 1218, s: 118.1, h: 0.543, d: 0.333, o: 2.733, r: 15.531, c: 0.596, p: 14.8, u: 13.3, q: 0.478 },
  { level: 6, n: 1365, s: 150.1, h: 0.703, d: 0.417, o: 3.069, r: 12.7, c: 0.525, p: 13.4, u: 12.1, q: 0.456 },
  { level: 6, n: 745, s: 151, h: 0.895, d: 0.432, o: 3.126, r: 9.903, c: 0.381, p: 8.6, u: 8.4, q: 0.356 },
  { level: 6, n: 1219, s: 118.5, h: 0.551, d: 0.41, o: 3.041, r: 12, c: 0.473, p: 13.6, u: 12.6, q: 0.377 },
  { level: 6, n: 1533, s: 113, h: 0.579, d: 0.269, o: 2.475, r: 15.165, c: 0.491, p: 18.4, u: 17.2, q: 0.434 },
  { level: 7, n: 1394, s: 115.8, h: 0.489, d: 0.321, o: 2.686, r: 16.105, c: 0.327, p: 18.6, u: 16.2, q: 0.376 },
  { level: 7, n: 1119, s: 100.7, h: 0.761, d: 0.451, o: 3.203, r: 14.6, c: 0.535, p: 15.6, u: 15, q: 0.544 },
  { level: 7, n: 832, s: 101.8, h: 1, d: 0.695, o: 4.18, r: 11.076, c: 0.614, p: 10.4, u: 9.6, q: 0.614 },
  { level: 7, n: 1666, s: 117, h: 0.432, d: 0.232, o: 2.326, r: 13.252, c: 0.52, p: 19.2, u: 18.8, q: 0.553 },
  { level: 8, n: 1445, s: 129.5, h: 0.864, d: 0.52, o: 3.478, r: 18.207, c: 0.476, p: 16.4, u: 16, q: 0.473 },
  { level: 8, n: 1318, s: 154.2, h: 0.839, d: 0.524, o: 3.497, r: 12.365, c: 0.505, p: 11.8, u: 11.4, q: 0.482 },
  { level: 8, n: 1258, s: 155.2, h: 0.976, d: 0.614, o: 3.858, r: 15.705, c: 0.379, p: 13.8, u: 11.7, q: 0.389 },
  { level: 8, n: 1265, s: 98.4, h: 0.552, d: 0.234, o: 2.336, r: 19.027, c: 0.387, p: 20.6, u: 19.6, q: 0.371 },
  { level: 8, n: 429, s: 32.2, h: 0.392, d: 0.205, o: 2.222, r: 14.627, c: 0.388, p: 17.6, u: 16.6, q: 0.465 },
  { level: 9, n: 2500, s: 165.5, h: 0.628, d: 0.407, o: 3.028, r: 15.207, c: 0.477, p: 20.8, u: 19.4, q: 0.424 },
  { level: 9, n: 1461, s: 131, h: 0.775, d: 0.449, o: 3.196, r: 20.809, c: 0.546, p: 17.4, u: 16.6, q: 0.477 },
  { level: 9, n: 1187, s: 94.3, h: 0.862, d: 0.453, o: 3.211, r: 20.186, c: 0.347, p: 17.8, u: 16.7, q: 0.331 },
  { level: 9, n: 2305, s: 168.6, h: 0.604, d: 0.347, o: 2.786, r: 22.488, c: 0.565, p: 19.6, u: 19, q: 0.485 },
  { level: 10, n: 2377, s: 157.8, h: 0.651, d: 0.331, o: 2.723, r: 24.347, c: 0.687, p: 23, u: 21.8, q: 0.606 },
  { level: 10, n: 1656, s: 118.1, h: 0.884, d: 0.431, o: 3.125, r: 19.4, c: 0.405, p: 17.4, u: 17, q: 0.379 },
  { level: 10, n: 1689, s: 119, h: 0.993, d: 0.698, o: 4.19, r: 20.586, c: 0.561, p: 19.2, u: 18.4, q: 0.561 },
  { level: 10, n: 2185, s: 139.8, h: 0.673, d: 0.397, o: 2.989, r: 22.275, c: 0.46, p: 22, u: 20.7, q: 0.434 },
  { level: 11, n: 1864, s: 106.5, h: 0.881, d: 0.499, o: 3.396, r: 24.406, c: 0.464, p: 22.4, u: 21, q: 0.461 },
  { level: 11, n: 1493, s: 112.5, h: 0.683, d: 0.614, o: 3.855, r: 13.381, c: 0.597, p: 17, u: 15.9, q: 0.556 },
  { level: 11, n: 2338, s: 151.1, h: 0.895, d: 0.45, o: 3.199, r: 25.4, c: 0.501, p: 23.4, u: 23.2, q: 0.511 },
  { level: 11, n: 2527, s: 165.6, h: 0.79, d: 0.398, o: 2.994, r: 25.888, c: 0.286, p: 22.2, u: 21.1, q: 0.275 },
  { level: 12, n: 1798, s: 108.1, h: 0.661, d: 0.471, o: 3.285, r: 21.908, c: 0.572, p: 23.6, u: 23.1, q: 0.497 },
  { level: 12, n: 2633, s: 166, h: 0.827, d: 0.509, o: 3.436, r: 24.019, c: 0.807, p: 21.8, u: 20.5, q: 0.732 },
  { level: 12, n: 1822, s: 114.2, h: 0.95, d: 0.533, o: 3.533, r: 27.806, c: 0.538, p: 25.4, u: 22.6, q: 0.527 },
  { level: 12, n: 2447, s: 140, h: 0.793, d: 0.434, o: 3.136, r: 24.079, c: 0.344, p: 23.8, u: 22.7, q: 0.335 },
  { level: 13, n: 2570, s: 138.1, h: 0.839, d: 0.535, o: 3.541, r: 29.219, c: 0.625, p: 26.8, u: 25.4, q: 0.592 },
  { level: 13, n: 2452, s: 125.4, h: 0.714, d: 0.457, o: 3.23, r: 21.3, c: 0.745, p: 22.2, u: 21.4, q: 0.704 },
  { level: 13, n: 2123, s: 117.4, h: 0.72, d: 0.341, o: 2.764, r: 29.708, c: 0.569, p: 27.4, u: 26.3, q: 0.452 },
  { level: 13, n: 2814, s: 162.2, h: 0.796, d: 0.433, o: 3.133, r: 27.488, c: 0.222, p: 24.4, u: 23.6, q: 0.224 },
  { level: 14, n: 2319, s: 121.3, h: 0.904, d: 0.506, o: 3.425, r: 32.446, c: 0.389, p: 28.6, u: 26, q: 0.376 },
  { level: 14, n: 2408, s: 147.3, h: 0.794, d: 0.524, o: 3.495, r: 25.859, c: 0.517, p: 27.2, u: 25.9, q: 0.471 },
  { level: 14, n: 4637, s: 274, h: 0.782, d: 0.479, o: 3.315, r: 28.533, c: 0.395, p: 26.4, u: 25.5, q: 0.356 },
  { level: 15, n: 3216, s: 167.7, h: 0.913, d: 0.506, o: 3.423, r: 31.246, c: 0.34, p: 28.6, u: 27.5, q: 0.327 },
  { level: 15, n: 6487, s: 348.6, h: 0.783, d: 0.487, o: 3.347, r: 30.459, c: 0.445, p: 27.4, u: 26.9, q: 0.407 },
  { level: 15, n: 3149, s: 193.3, h: 0.894, d: 0.444, o: 3.175, r: 28.454, c: 0.352, p: 26, u: 24.9, q: 0.34 },
];

function normalize(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function parseLnLabel(displayName: string): LnDanEstimateResult {
  const match = displayName.match(/^LN\s*(\d{1,2})([+-])?$/i);
  const level = Math.max(1, Math.min(15, Number(match?.[1] ?? 1)));
  const variant = match?.[2] ?? null;
  const rawDan = level + (variant === "+" ? 0.25 : variant === "-" ? -0.25 : 0);
  return {
    label: String(level),
    variant,
    displayName: `LN ${level}${variant ?? ""}`,
    rawDan,
    estimatedSr: rawDan,
    confidence: 0.94,
    reason: "known-ln-reference",
  };
}

function knownLnTarget(map: ManiaBeatmap, input: DanEstimateInput, rate: number): LnDanEstimateResult | null {
  const versions = [map.version, input.version].map(normalize).filter(Boolean);
  for (const target of KNOWN_LN_TARGETS) {
    const targetVersion = normalize(target.version);
    if (!versions.includes(targetVersion)) continue;
    if (target.rate && Math.abs(target.rate - rate) > 0.001) continue;
    return parseLnLabel(target.target);
  }
  return null;
}

function officialReferenceTarget(metrics: DanFeatureMetrics, durationMs: number): LnDanEstimateResult | null {
  const seconds = durationMs / 1000;
  let best: { reference: LnReferenceChart; distance: number } | null = null;
  for (const reference of LN_REFERENCE_CHARTS) {
    const distance =
      Math.abs(metrics.noteCount - reference.n) / Math.max(metrics.noteCount, reference.n, 1) / 0.025
      + Math.abs(seconds - reference.s) / Math.max(seconds, reference.s, 1) / 0.03
      + Math.abs(metrics.holdRatio - reference.h) / 0.05
      + Math.abs(metrics.lnDensity - reference.d) / 0.05
      + Math.abs(metrics.lnOverlapPressure - reference.o) / 0.18
      + Math.abs(metrics.lnReleasePressure - reference.r) / 1.4
      + Math.abs(metrics.lnChordPressure - reference.c) / 0.06
      + Math.abs(metrics.peakNps5s - reference.p) / 1.4
      + Math.abs(metrics.sustainedNps10s - reference.u) / 1.4
      + Math.abs(metrics.chordRatio - reference.q) / 0.06;
    if (!best || distance < best.distance) best = { reference, distance };
  }
  if (!best || best.distance > 2.4) return null;
  return {
    ...parseLnLabel(`LN ${best.reference.level}`),
    confidence: Math.max(0.82, 0.96 - best.distance * 0.04),
    reason: "official-ln-reference-chart",
  };
}

function parseRawLnDan(rawDan: number): LnDanEstimateResult {
  const level = Math.max(1, Math.min(15, Math.round(rawDan)));
  const offset = rawDan - level;
  const variant = offset <= -0.18 ? "-" : offset >= 0.18 ? "+" : null;
  return {
    label: String(level),
    variant,
    displayName: `LN ${level}${variant ?? ""}`,
    rawDan,
    estimatedSr: rawDan,
    confidence: 0.72,
    reason: "ln-pressure",
  };
}

export function estimateLnDan(
  map: ManiaBeatmap,
  input: DanEstimateInput,
  metrics: DanFeatureMetrics,
  starRating: number,
  durationMs: number,
  rate: number,
): LnDanEstimateResult | null {
  const known = knownLnTarget(map, input, rate);
  if (known) return known;

  const metadata = normalize(`${map.title} ${map.version} ${input.title ?? ""} ${input.version ?? ""}`);
  const metadataHasLnHint = /\bln\b|long note|full ln|ln edit|ln hybrid|ln wall|ln jack|ln speed|ln jumpstream/.test(metadata);
  const metadataLnSignal = metadataHasLnHint && (
    metrics.holdRatio >= 0.12
    || metrics.lnDensity >= 0.08
    || metrics.lnReleasePressure >= 1.5
    || metrics.lnOverlapPressure >= 0.9
  );
  const chartLnSignal = (
    metrics.holdRatio >= 0.28
    && metrics.lnDensity >= 0.14
    && metrics.lnHoldDurationP90 >= 220
    && metrics.lnChordPressure >= 0.12
  ) || (
    metrics.holdRatio >= 0.34
    && metrics.lnDensity >= 0.1
    && metrics.lnOverlapPressure >= 0.75
  );
  const lnCandidate = metadataLnSignal || chartLnSignal;
  if (!lnCandidate) return null;

  const reference = officialReferenceTarget(metrics, durationMs);
  if (reference) return reference;

  const sr = starRating > 0 ? starRating : Math.max(1, metrics.peakNps5s * 0.18 + metrics.lnReleasePressure * 0.55);
  const durationMinutes = Math.max(0.6, durationMs / 60000);
  const rawDan = -8.15
    + sr * 2.6502
    + Math.max(0, sr - 5) * -1.3038
    + Math.max(0, sr - 6.5) * 0.5527
    + (metrics.peakNps5s / 20) * 0.5802
    + (metrics.lnReleasePressure / 20) * 1.057
    + metrics.lnDensity * 0.3841
    + (metrics.lnOverlapPressure / 4) * 0.3841
    + metrics.lnChordPressure * 0.1443
    + Math.log2(durationMinutes) * 0.4391;

  return parseRawLnDan(rawDan);
}
