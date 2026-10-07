// Public osu! beatmap mirrors that serve a full .osz by beatmapset id.
// Shared by the server-side archive layer (beatmap-archive.ts) and the
// client-side "osz" download buttons; keep it dependency-free so it stays
// safe to import from client components.
type BeatmapMirrorEntry = {
  name: string;
  url: (beatmapsetId: string) => string;
  // Range reads go to the redirect target, so the mirror's own endpoint is
  // hit once per extraction instead of once per range request.
  resolveRedirectBeforeRange?: boolean;
  // Answers a range request with the whole archive: no range pass.
  wholeArchiveOnly?: boolean;
  // /api/osz sends the browser straight there instead of probing first.
  skipServerProbe?: boolean;
  // Tried only after every primary mirror.
  fallback?: boolean;
};

export const BEATMAP_MIRRORS = [
  {
    // osu.direct charges every /api/d/ request the full archive size against a
    // per-IP 8 GiB/day budget (200 downloads/hour), a 4-byte probe included
    // (measured 2026-10-07), and 302s to a presigned storage URL valid for
    // 15s. A server probe would spend our budget on the browser's download.
    name: "osu.direct",
    url: (beatmapsetId: string) => `https://osu.direct/api/d/${encodeURIComponent(beatmapsetId)}`,
    resolveRedirectBeforeRange: true,
    skipServerProbe: true,
  },
  {
    // The streaming endpoint, not /d/{id}?redirect=true: the redirect could
    // hand the server to osu.direct and its budget. Streaming pulls from
    // hinai's cascade on hinai's IP.
    name: "hinai",
    url: (beatmapsetId: string) => `https://mirror.hinamizawa.ai/api/v1/hinai/d/${encodeURIComponent(beatmapsetId)}`,
    wholeArchiveOnly: true,
  },
  {
    name: "nekoha",
    url: (beatmapsetId: string) => `https://mirror.nekoha.moe/api/download/${encodeURIComponent(beatmapsetId)}`,
    wholeArchiveOnly: true,
  },
  {
    name: "sayobot",
    url: (beatmapsetId: string) => `https://txy1.sayobot.cn/beatmaps/download/full/${encodeURIComponent(beatmapsetId)}`,
  },
  // Timing out (catboy) or 404ing every set (nerinyan) as of 2026-10-07.
  {
    name: "catboy",
    url: (beatmapsetId: string) => `https://catboy.best/d/${encodeURIComponent(beatmapsetId)}`,
    fallback: true,
  },
  {
    name: "nerinyan",
    url: (beatmapsetId: string) => `https://api.nerinyan.moe/d/${encodeURIComponent(beatmapsetId)}`,
    fallback: true,
  },
] as const satisfies readonly BeatmapMirrorEntry[];

export type BeatmapMirror = (typeof BEATMAP_MIRRORS)[number];
export type BeatmapMirrorName = BeatmapMirror["name"];

export function mirrorHas(mirror: BeatmapMirror, flag: Exclude<keyof BeatmapMirrorEntry, "name" | "url">): boolean {
  return flag in mirror && (mirror as BeatmapMirrorEntry)[flag] === true;
}

const PRIMARY_MIRRORS = BEATMAP_MIRRORS.filter((mirror) => !mirrorHas(mirror, "fallback"));
const FALLBACK_MIRRORS = BEATMAP_MIRRORS.filter((mirror) => mirrorHas(mirror, "fallback"));

function rotate<T>(items: readonly T[], start: number): T[] {
  const offset = start % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

// Probe order for a set: deterministic (beatmapsetId decides the starting
// mirror) so load spreads across the primary mirrors instead of everyone
// hitting the first entry; the fallbacks follow in the same rotation.
export function mirrorOrderFor(beatmapsetId: number): BeatmapMirror[] {
  return [...rotate(PRIMARY_MIRRORS, beatmapsetId), ...rotate(FALLBACK_MIRRORS, beatmapsetId)];
}

// The osz buttons go through our redirect route, which probes the mirrors
// server-side and 302s to the first one that is actually serving archives.
// The download bytes flow mirror-to-browser; only the health check runs here.
export function oszDownloadUrl(beatmapsetId: number): string {
  return `/api/osz?beatmapsetId=${beatmapsetId}`;
}
