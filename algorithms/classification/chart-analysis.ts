import { LN_MIN_WORK_SHARE } from "../dan-estimator/ln-effective";
import { HYBRID_LN_SECTIONS_VERSION, type HybridLnSectionsReading } from "./hybrid-ln-sections";

export const HYBRID_HOLD_SHARE_MIN = 0.25;
export const HYBRID_HOLD_SHARE_MAX = 0.75;

export const HYBRID_MIN_WORK_SHARE = LN_MIN_WORK_SHARE;
const HYBRID_KEY_COUNTS: ReadonlySet<number> = new Set([4]);

export function isHybridChart(
  chart: { keyCount: unknown; lnRatio: unknown; lnRiceShare?: unknown; lnWorkShare?: unknown } | null | undefined,
): boolean {
  if (!chart || !HYBRID_KEY_COUNTS.has(Number(chart.keyCount))) return false;
  const lnRatio = chart.lnRatio == null ? Number.NaN : Number(chart.lnRatio);
  if (!Number.isFinite(lnRatio) || lnRatio < HYBRID_HOLD_SHARE_MIN || lnRatio > HYBRID_HOLD_SHARE_MAX) return false;
  const riceShare = chart.lnRiceShare == null ? Number.NaN : Number(chart.lnRiceShare);
  if (!Number.isFinite(riceShare) || riceShare < HYBRID_HOLD_SHARE_MIN) return false;
  const workShare = chart.lnWorkShare;
  if (workShare != null && Number.isFinite(Number(workShare)) && Number(workShare) < HYBRID_MIN_WORK_SHARE) return false;
  return true;
}

export const HYBRID_LN_CREDIT_MIN_HOLD_SHARE = 0.35;
export const HYBRID_LN_CREDIT_MIN_SECTION_SHARE = 0.3;
export const HYBRID_LN_CREDIT_MIN_MARGIN = 0.5;

export function hybridLnSectionsCredit(
  keyCount: unknown,
  chart: { lnRatio?: unknown; lnRiceShare?: unknown; lnWorkShare?: unknown; lnSections?: unknown; rc?: { rawDan?: unknown } | null } | null | undefined,
): { rawDan: number; label: string } | null {
  if (!chart || !isHybridChart({ keyCount, lnRatio: chart.lnRatio, lnRiceShare: chart.lnRiceShare, lnWorkShare: chart.lnWorkShare })) return null;
  if (!(Number(chart.lnRatio) >= HYBRID_LN_CREDIT_MIN_HOLD_SHARE)) return null;
  const sections = chart.lnSections as Partial<HybridLnSectionsReading> | null | undefined;
  if (!sections || sections.version !== HYBRID_LN_SECTIONS_VERSION) return null;
  if (!(Number(sections.noteShare) >= HYBRID_LN_CREDIT_MIN_SECTION_SHARE)) return null;
  const rawDan = Number(sections.rawDan);
  if (!Number.isFinite(rawDan) || typeof sections.label !== "string" || !sections.label) return null;
  const riceDan = chart.rc?.rawDan == null ? Number.NaN : Number(chart.rc.rawDan);
  if (!Number.isFinite(riceDan) || rawDan - riceDan < HYBRID_LN_CREDIT_MIN_MARGIN) return null;
  return { rawDan, label: sections.label };
}
