import { parseManiaBeatmap } from "../chart/beatmap";
import { detectRateVibro } from "./detection";
import { analyzeCollapsedNotes, analyzeStackedHeads, analyzeVibroSections, analyzeWideJumptrill, isUnrateableExclusion, usesSectionVibro, type VibroAnalysis } from "./sections";

export interface RateVibroCheck {
  vibro: boolean;
  unrateable: boolean;
  adjustment?: Pick<VibroAnalysis, "excludedDurationMs" | "timeShare" | "noteShare" | "judgementShare">;
}

export function checkRateVibro(osuText: string, rate: number, hasPpTrust: boolean, baseVibro: boolean): RateVibroCheck | null {
  try {
    const map = parseManiaBeatmap(osuText);
    const analysis = usesSectionVibro(map) ? analyzeVibroSections(map, rate)
      : analyzeStackedHeads(map, rate) ?? analyzeWideJumptrill(map, rate) ?? analyzeCollapsedNotes(map, rate);
    return {
      vibro: analysis ? analysis.status === "excluded"
        : (!hasPpTrust && baseVibro) || (rate !== 1 && detectRateVibro(map, rate)),
      unrateable: isUnrateableExclusion(analysis),
      adjustment: analysis?.status === "adjusted" ? {
        excludedDurationMs: analysis.excludedDurationMs, timeShare: analysis.timeShare,
        noteShare: analysis.noteShare, judgementShare: analysis.judgementShare,
      } : undefined,
    };
  } catch {
    return null;
  }
}
