import type { LivePackCollectorCompletion } from "./live-backend";

/** The same collectible slots as the owner's collection and missing list. */
export function packCompletionCounts(completion: LivePackCollectorCompletion) {
  return {
    owned: completion.poolOwnedCount + completion.goatsOwned + (completion.teamsOwned ?? 0),
    total: completion.poolTotal + completion.goatsTotal + (completion.teamsTotal ?? 0),
  };
}
