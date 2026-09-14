import { LN_ANALYSIS_VERSION, type LnStructureSummary4K } from "./index.js";
import { LN_SEARCH_EVIDENCE_VERSION } from "./search-evidence.js";

/** Search facets refine LN-eligible charts; they do not set difficulty or identity. */
export const LN_SEARCH_PATTERNS = [
  { id: "lnshield", tag: "shield" },
  { id: "lnreverseshield", tag: "reverse_shield" },
] as const;

export const LN_SEARCH_PATTERN_IDS = LN_SEARCH_PATTERNS.map(({ id }) => id);

/** LN-eligible charts with recurring sections, not isolated preview candidates. */
export function readLnSearchPatternIds(structure: LnStructureSummary4K | null | undefined, keyCount: number, eligible = false): string[] {
  if (keyCount !== 4 || !eligible || structure?.valid !== true || structure.version !== LN_ANALYSIS_VERSION
    || structure.playbackRate !== 1 || structure.searchEvidence?.version !== LN_SEARCH_EVIDENCE_VERSION) return [];
  return LN_SEARCH_PATTERNS.filter(({ tag }) => structure.searchEvidence?.tags[tag] != null).map(({ id }) => id);
}
