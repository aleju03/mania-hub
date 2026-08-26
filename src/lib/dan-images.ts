// Dan badge artwork lookup, shared by the admin classifier page and the maps
// search surfaces. Assets: /images/dans/reform (4K RC, svg 1-10 + webp greeks
// through eta), /images/dans/ln (4K LN 1-17), /images/dans/7k (JinJin 7K, RC
// circles + ln- diamonds, 0-10 + gamma/azimuth/zenith/stellium),
// /images/dans/6k (Arkman regular + sunnyxxy LN, RC hexagons 0-9 + ln- upright
// hexagons 0-9 plus terra/celestial/mystery/nihility/finish). The 6K glyphs are
// traced from the course backgrounds, so a badge carries the course's own mark.

const DAN_IMAGE_EXTENSIONS: Record<string, "webp" | "svg"> = {
  "1": "svg",
  "2": "svg",
  "3": "svg",
  "4": "svg",
  "5": "svg",
  "6": "svg",
  "7": "svg",
  "8": "svg",
  "9": "svg",
  "10": "svg",
  alpha: "webp",
  beta: "webp",
  gamma: "webp",
  delta: "webp",
  epsilon: "webp",
  zeta: "webp",
  eta: "webp",
  theta: "webp",
  iota: "webp",
  kappa: "webp",
};

const SEVENK_DAN_LABELS = new Set([
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
  "gamma", "azimuth", "zenith", "stellium",
]);

// The 6K courses are two separate ladders: the regular course stops at 9th,
// the LN course carries on into named bands past 9th.
const SIXK_DAN_LABELS = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
const SIXK_LN_DAN_LABELS = new Set([
  ...SIXK_DAN_LABELS,
  "terra", "celestial", "mystery", "nihility", "finish",
]);

export function getDanImageSrc(label: string, family?: string, keyCount?: number): string | null {
  if (keyCount === 7) {
    if (!SEVENK_DAN_LABELS.has(label)) return null;
    return family === "ln" ? `/images/dans/7k/ln-${label}.svg` : `/images/dans/7k/${label}.svg`;
  }
  if (keyCount === 6) {
    if (family === "ln") {
      return SIXK_LN_DAN_LABELS.has(label) ? `/images/dans/6k/ln-${label}.svg` : null;
    }
    return SIXK_DAN_LABELS.has(label) ? `/images/dans/6k/${label}.svg` : null;
  }
  if (keyCount != null && keyCount !== 4) {
    // other keymodes have their own dan courses; the 4K logos would be wrong
    return null;
  }
  if (family === "ln" && /^(1[0-7]|[1-9])$/.test(label)) {
    return `/images/dans/ln/${label}.svg`;
  }
  const extension = DAN_IMAGE_EXTENSIONS[label];
  return extension ? `/images/dans/reform/${label}.${extension}` : null;
}

/** Strip the tier suffix from a verdict display name: "10--" -> "10", "gamma+" -> "gamma". */
export function danBareLabel(displayName: string): string {
  return displayName.replace(/[+-]+$/, "").trim().toLowerCase();
}

/** The tier suffix of a verdict display name: "10--" -> "--", "gamma+" -> "+", "9" -> "". */
export function danTierSuffix(displayName: string): string {
  return displayName.trim().match(/[+-]+$/)?.[0] ?? "";
}

// Where inside its level a verdict sits. The sign picks the hue - below the
// level's middle reads cool, above it reads warm - and doubling the marker
// pushes that hue further out, so "-" and "--" never read as two unrelated
// things (a green "-" read as praise). Mid has no suffix, so no color.
const DAN_TIER_COLORS: Record<string, string> = {
  "--": "#4db8ff",
  "-": "#7ac8ea",
  "+": "#ffab74",
  "++": "#ef6f7f",
};

export function danTierColor(suffix: string): string | null {
  return DAN_TIER_COLORS[suffix] ?? null;
}

// ── Dan picker scale ─────────────────────────────────────────────────────────
// The picker filters the classifier's numeric rawDan, which every family maps
// onto its own course ladder: 4K reform 1..10 then alpha(11)..kappa(20), 4K LN
// 1..17, 7K 0..10 then gamma(11)/azimuth(12)/zenith(13)/stellium(14) with the
// same levels for the 7K LN courses (diamond badges), 6K regular 0..9 and 6K LN
// 0..9 then terra(10)/celestial(11)/mystery(12)/nihility(13)/finish(14). The
// scale context picks which ladder names/logos annotate a level.

export type DanScaleContext = "reform" | "ln" | "7k" | "7k-ln" | "6k" | "6k-ln";

const REFORM_GREEK = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];
const SEVENK_BOSSES = ["gamma", "azimuth", "zenith", "stellium"];
const SIXK_LN_BANDS = ["terra", "celestial", "mystery", "nihility", "finish"];

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The badge label for an integer slider value in the given context. */
export function danScaleLabel(value: number, context: DanScaleContext): string {
  const level = Math.round(value);
  if (context === "7k" || context === "7k-ln") {
    if (level <= 10) return String(Math.max(0, level));
    return capitalize(SEVENK_BOSSES[Math.min(level, 14) - 11]);
  }
  if (context === "6k") return String(Math.min(Math.max(0, level), 9));
  if (context === "6k-ln") {
    if (level <= 9) return String(Math.max(0, level));
    return capitalize(SIXK_LN_BANDS[Math.min(level, 14) - 10]);
  }
  if (context === "ln") {
    // The LN ladder ends at 17, Yeehee (see LN_LADDER_TOP in dan-estimator/ln.ts).
    return String(Math.min(Math.max(1, level), 17));
  }
  if (level <= 10) return String(Math.max(1, level));
  return capitalize(REFORM_GREEK[Math.min(level, 20) - 11]);
}

/** The badge image for an integer slider value, or null when no art exists. */
export function danScaleImage(value: number, context: DanScaleContext): string | null {
  const label = danScaleLabel(value, context).toLowerCase();
  if (context === "7k-ln") return getDanImageSrc(label, "ln", 7);
  if (context === "7k") return getDanImageSrc(label, undefined, 7);
  if (context === "6k-ln") return getDanImageSrc(label, "ln", 6);
  if (context === "6k") return getDanImageSrc(label, undefined, 6);
  if (context === "ln") return getDanImageSrc(label, "ln", 4);
  return getDanImageSrc(label, undefined, 4);
}
