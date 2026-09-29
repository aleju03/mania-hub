// Interface to MinaCalc, Etterna's difficulty calculator. The real calculator
// is Etterna's C++ MinaCalc compiled to WebAssembly and driven through the
// LeoBlack harness (leoblack/ett); this file only declares the calls the rest
// of the code makes. MinaCalc rates 4K to 18K and nothing narrower.
//
// Versions per keymode:
// - 4K uses 0.72.3 (DEFAULT_ETTERNA_VERSION).
// - Every other keycount (5K-18K) is pinned to 0.75.0 (calc 527). It carries
//   the n-key pipeline and routes 5K to Etterna's dedicated five-key class,
//   the only non-4K engine that rates Technical.
// - The Companella model's input features always come from 0.74.0, 4K
//   included, because that is the build it was trained on.
// The shipped binaries raise MinaCalc's per-skillset clamp from 40 to 100, so
// the hardest charts are not flattened at 40.

/** The eight skillsets MinaCalc returns, Overall first. */
export type MinaCalcSkillset =
  | "Overall"
  | "Stream"
  | "Jumpstream"
  | "Handstream"
  | "Stamina"
  | "JackSpeed"
  | "Chordjack"
  | "Technical";

export interface MinaCalcOptions {
  /** MinaCalc build to run; omitted picks the keymode's pinned build. */
  etternaVersion?: string;
  /** Music rate, 1 for 1.0x. */
  musicRate: number;
  /**
   * Target Wife3 accuracy, share 0-1. Omitted means 0.93, the MSD baseline;
   * a score's accuracy turns the result into that score's SSR. Goals above
   * 0.965 are clamped by the calc, as Etterna caps SSRs.
   */
  scoreGoal?: number;
  /** Force the keycount instead of reading it from the file. */
  keyOverride: number | null;
  /** Insert every LN tail as an extra tap row (the tail-aware pass). */
  lnTailTaps: boolean;
}

export interface MinaCalcResult {
  /** The build that produced the values; null if the harness did not report one. */
  etternaVersion: string | null;
  /** Skillset name -> rating. Keys are MinaCalcSkillset names. */
  values: Record<string, number>;
}

/** "0.72.3": the build used when neither the caller nor a keymode pin picks one. */
export declare const DEFAULT_ETTERNA_VERSION: "0.72.3";

/** The build a keycount is pinned to: "0.75.0" for 5K-18K, null for 4K. */
export declare function pinnedEtternaVersionForKeycount(keyCount: number): string | null;

/** Parse an .osu file and run MinaCalc on it at the given rate and goal. */
export declare function analyzeEtternaFromText(
  osuText: string,
  options: MinaCalcOptions,
): Promise<MinaCalcResult>;
