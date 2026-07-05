// Dan badge artwork lookup, shared by the admin classifier page and the maps
// search surfaces. Assets: /images/dans/reform (4K RC, svg 1-10 + webp greeks
// through eta), /images/dans/ln (4K LN 1-16), /images/dans/7k (JinJin 7K, RC
// circles + ln- diamonds, 0-10 + gamma/azimuth/zenith/stellium).

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

export function getDanImageSrc(label: string, family?: string, keyCount?: number): string | null {
  if (keyCount === 7) {
    if (!SEVENK_DAN_LABELS.has(label)) return null;
    return family === "ln" ? `/images/dans/7k/ln-${label}.svg` : `/images/dans/7k/${label}.svg`;
  }
  if (keyCount != null && keyCount !== 4) {
    // other keymodes have their own dan courses; the 4K logos would be wrong
    return null;
  }
  if (family === "ln" && /^(1[0-6]|[1-9])$/.test(label)) {
    return `/images/dans/ln/${label}.svg`;
  }
  const extension = DAN_IMAGE_EXTENSIONS[label];
  return extension ? `/images/dans/reform/${label}.${extension}` : null;
}

/** Strip the tier suffix from a verdict display name: "10--" -> "10", "gamma+" -> "gamma". */
export function danBareLabel(displayName: string): string {
  return displayName.replace(/[+-]+$/, "").trim().toLowerCase();
}

// ── Dan picker scale ─────────────────────────────────────────────────────────
// The picker filters the classifier's numeric rawDan, which every family maps
// onto its own course ladder: 4K reform 1..10 then alpha(11)..kappa(20), 4K LN
// 1..16, 7K 0..10 then gamma(11)/azimuth(12)/zenith(13)/stellium(14) with the
// same levels for the 7K LN courses (diamond badges). The scale context picks
// which ladder names/logos annotate a level.

export type DanScaleContext = "reform" | "ln" | "7k" | "7k-ln";

const REFORM_GREEK = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];
const SEVENK_BOSSES = ["gamma", "azimuth", "zenith", "stellium"];

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
  if (context === "ln") {
    // The LN estimator caps its ladder at 16 (see dan-estimator/ln.ts).
    return String(Math.min(Math.max(1, level), 16));
  }
  if (level <= 10) return String(Math.max(1, level));
  return capitalize(REFORM_GREEK[Math.min(level, 20) - 11]);
}

/** The badge image for an integer slider value, or null when no art exists. */
export function danScaleImage(value: number, context: DanScaleContext): string | null {
  const label = danScaleLabel(value, context).toLowerCase();
  if (context === "7k-ln") return getDanImageSrc(label, "ln", 7);
  if (context === "7k") return getDanImageSrc(label, undefined, 7);
  if (context === "ln") return getDanImageSrc(label, "ln", 4);
  return getDanImageSrc(label, undefined, 4);
}
