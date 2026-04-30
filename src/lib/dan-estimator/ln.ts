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
  const lnCandidate = metadataHasLnHint && (
    metrics.holdRatio >= 0.12
    || metrics.lnDensity >= 0.08
    || metrics.lnReleasePressure >= 1.5
    || metrics.lnOverlapPressure >= 0.9
  );
  if (!lnCandidate) return null;

  const sr = starRating > 0 ? starRating : Math.max(1, metrics.peakNps5s * 0.18 + metrics.lnReleasePressure * 0.55);
  const durationMinutes = Math.max(0.6, durationMs / 60000);
  const rawDan = sr * 1.15
    + metrics.holdRatio * 2.2
    + metrics.lnDensity * 2.8
    + metrics.lnReleasePressure * 0.18
    + metrics.lnOverlapPressure * 0.72
    + metrics.lnChordPressure * 0.9
    + Math.min(1.15, Math.log2(durationMinutes + 1) * 0.42)
    + Math.min(0.75, metrics.lnHoldDurationP90 / 2200)
    - 1.65;

  return parseRawLnDan(rawDan);
}
