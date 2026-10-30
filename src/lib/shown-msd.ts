import { msdHeadline } from "#dan/msd-headline";
import type { LiveMapSearchEntry } from "./live-backend";

// The values the rating panel shows and its OVERALL headline. One function so
// the modal header's big number and the panel can never disagree: under a rate
// mod the rate's own MSD replaces the 1.0x set; otherwise the LN-adjusted
// values win, then the fetched analysis, then the index copy.
export function resolveShownMsd({
  entry,
  msdLn,
  analysisMsd,
  analysisLnIdentity,
  rate = 1,
  rateMsd,
  rateDan,
  inverse = false,
}: {
  entry: Pick<LiveMapSearchEntry, "keyCount" | "primaryPattern" | "dan" | "msd" | "msdLn">;
  msdLn?: Record<string, number> | null;
  analysisMsd?: Record<string, number> | null;
  analysisLnIdentity?: boolean | null;
  rate?: number;
  rateMsd?: Record<string, number> | null;
  rateDan?: { family: string } | null;
  inverse?: boolean;
}): { rateAdjusted: boolean; msd: Record<string, number> | null; overall: number | null } {
  const rateAdjusted = (rate !== 1 || inverse) && rateMsd != null;
  const msd = rateAdjusted ? rateMsd : msdLn ?? analysisMsd ?? entry.msdLn ?? entry.msd ?? null;
  if (!msd) return { rateAdjusted, msd: null, overall: null };
  // An LN number shows on 4K and on the keymodes whose LN axis is published;
  // identity only decides whether LN can be the headline.
  const hasLnIdentity = rateAdjusted
    ? rateDan == null || rateDan.family === "ln"
    : analysisLnIdentity ?? (entry.primaryPattern === "ln" || entry.dan?.family === "ln");
  // On a 4K LN chart the headline is the higher of Overall and LN: native
  // Overall never sees a tail, so on its own it prices the rice that is left
  // once the holds are cut off.
  return { rateAdjusted, msd, overall: msdHeadline(msd, entry.keyCount, hasLnIdentity) };
}
