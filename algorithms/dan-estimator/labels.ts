// The 4K rice dan ladder (1-10, then alpha through kappa): a rawDan number to
// its printed label, and the input rate a chart is rated at.

import type { DanEstimateInput } from "./types";

const DAN_LABELS = [
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
  "theta",
  "iota",
  "kappa",
];

// The ladder runs to kappa (level 20), matching LeoBlack's own 4K rice table
// and the full set of greek levels. parseDan clamps the level to this index,
// so a shorter list would print a level-18 rating as the top label with a
// "++" suffix.
const MAX_SUPPORTED_DAN_INDEX = DAN_LABELS.length - 1;

/** The rate to rate at: the input rate when it is between 0.4x and 2.5x (exclusive), otherwise 1. */
export function getInputRate(input: DanEstimateInput): number {
  const rate = Number(input.rate);
  return Number.isFinite(rate) && rate > 0.4 && rate < 2.5 ? rate : 1;
}

/**
 * The level a bare 4K rice ladder label sits on ("10" -> 10, "epsilon" -> 15),
 * the inverse of parseDan's naming. Null for anything off the ladder. Takes a
 * bare label with no +/- variant.
 */
export function danLevelForLabel(label: string): number | null {
  const index = DAN_LABELS.indexOf(label.trim().toLowerCase());
  return index < 0 ? null : index + 1;
}

/**
 * The suffix for a rawDan's offset from its level, on five even tiers
 * (anchors -0.4 / -0.2 / 0 / +0.2 / +0.4, split at the midpoints, the same
 * tiers LeoBlack uses). Charts, player dans and credits all use it, so one
 * number always reads as one label.
 */
export function danVariantForOffset(offset: number): string | null {
  // Round away float noise so 12.7 - 13 reads as exactly -0.3 and lands in "-".
  const rounded = Math.round(offset * 1e6) / 1e6;
  return rounded < -0.3 ? "--" : rounded < -0.1 ? "-" : rounded < 0.1 ? null : rounded < 0.3 ? "+" : "++";
}

/** rawDan to its label ("gamma"), variant ("+") and display name ("gamma+"). */
export function parseDan(rawDan: number) {
  const maxLevel = MAX_SUPPORTED_DAN_INDEX + 1;
  const level = Math.min(maxLevel, Math.max(1, Math.round(rawDan)));
  const variant = danVariantForOffset(rawDan - level);
  const label = DAN_LABELS[level - 1];
  return {
    label,
    variant,
    displayName: `${label}${variant ?? ""}`,
  };
}
