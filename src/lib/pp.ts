// osu!mania PP calculation (approximate, based on osu-performance)
// This is a simplified version for interactive estimation

export interface PPCalcInput {
  starRating: number;
  accuracy: number; // 0-1
  totalHits: number;
  mods: string[];   // mod acronyms
}

export interface PPCalcResult {
  total: number;
  strain: number;
  accuracy: number;
}

// Mod multipliers for mania
function getModMultiplier(mods: string[]): number {
  let mult = 1.0;
  for (const mod of mods) {
    switch (mod) {
      case "EZ": mult *= 0.5; break;
      case "NF": mult *= 0.75; break;
      case "HT": mult *= 0.5; break;
      default: break;
    }
  }
  return mult;
}


export function calculateManiaPP(input: PPCalcInput): PPCalcResult {
  const { starRating, accuracy, totalHits, mods } = input;

  // Strain value
  const strainBase = Math.max(1, starRating / 0.2);
  let strainValue = Math.pow(5 * strainBase - 4, 2.2) / 135;
  strainValue *= 1 + 0.1 * Math.min(1, totalHits / 1500);

  // Scale by accuracy
  if (accuracy < 1) {
    strainValue *= accuracy;
  }

  // Mod multipliers
  const modMult = getModMultiplier(mods);

  // Accuracy value
  // hitWindow300 is approximated based on OD (we'll use a default)
  const hitWindow = 34; // ms, approximate for OD 8
  const accValue = Math.max(0,
    0.2 - ((hitWindow - 34) * 0.006667)
  ) * strainValue * Math.pow(Math.max(0, (accuracy - 0.96)) / 0.04, 1.5);

  // Total PP
  const total = Math.pow(
    Math.pow(strainValue, 1.1) + Math.pow(Math.max(0, accValue), 1.1),
    1.0 / 1.1
  ) * modMult * 0.8;

  return {
    total: Math.max(0, total),
    strain: Math.max(0, strainValue * modMult * 0.8),
    accuracy: Math.max(0, accValue * modMult * 0.8),
  };
}

// Generate curve data for a range of accuracies
export function generatePPCurve(
  starRating: number,
  totalHits: number,
  mods: string[],
  steps = 100,
): { accuracy: number; pp: number }[] {
  const points: { accuracy: number; pp: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const acc = 0.9 + (i / steps) * 0.1; // 90% to 100%
    const result = calculateManiaPP({ starRating, accuracy: acc, totalHits, mods });
    points.push({ accuracy: acc, pp: result.total });
  }
  return points;
}
