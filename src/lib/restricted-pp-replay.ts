import { restrictedPpReplayUrl } from "./live-backend";
import { parseUploadedReplayBuffer, type UploadedReplayParseResult } from "./replay-upload";
import type { UploadedReplayBeatmapResolution } from "./uploaded-replay-payload";

// A Companella import that counts toward simulated pp (live-backend
// integrations/companella/restricted-pp.ts) serves its .osr publicly. The
// replay page opens it the way it would open a local file: the bytes are
// parsed here in the browser, so the play never enters the upload store (no
// R2 object, no uploaded_replays row, no upload share link).

/** The parsed .osr, or null when the backend does not serve it (the play does not count right now). */
export async function fetchRestrictedPpReplay(importId: string, signal?: AbortSignal): Promise<UploadedReplayParseResult | null> {
  const url = restrictedPpReplayUrl(importId);
  if (!url) return null;
  const response = await fetch(url, { credentials: "omit", signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Server ${response.status}`);
  return parseUploadedReplayBuffer(await response.arrayBuffer());
}

/**
 * The chart to open an import on, by the same rules an upload follows: osu!'s
 * copy of the exact revision, else a contributed copy of it, else osu!'s copy
 * of another revision (watchable, judged approximately). Imports only count on
 * ranked maps, so the first case is the normal one.
 */
export function pickRestrictedPpReplayChart(resolved: UploadedReplayBeatmapResolution): string | null {
  if (resolved.file && resolved.file.checksumMatched !== false) return resolved.file.content;
  return resolved.community?.content || resolved.file?.content || null;
}
