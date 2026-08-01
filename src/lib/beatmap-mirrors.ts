// Public osu! beatmap mirrors that serve a full .osz by beatmapset id.
// Shared by the server-side archive layer (beatmap-archive.ts) and the
// client-side "osz" download buttons; keep it dependency-free so it stays
// safe to import from client components.
export const BEATMAP_MIRRORS = [
  {
    name: "osu.direct",
    url: (beatmapsetId: string) => `https://osu.direct/api/d/${encodeURIComponent(beatmapsetId)}`,
  },
  {
    name: "catboy",
    url: (beatmapsetId: string) => `https://catboy.best/d/${encodeURIComponent(beatmapsetId)}`,
  },
  {
    name: "hinai",
    url: (beatmapsetId: string) => `https://mirror.hinamizawa.ai/d/${encodeURIComponent(beatmapsetId)}?redirect=true`,
  },
  {
    name: "nerinyan",
    url: (beatmapsetId: string) => `https://api.nerinyan.moe/d/${encodeURIComponent(beatmapsetId)}`,
  },
  {
    name: "sayobot",
    url: (beatmapsetId: string) => `https://txy1.sayobot.cn/beatmaps/download/full/${encodeURIComponent(beatmapsetId)}`,
  },
] as const;

export type BeatmapMirror = (typeof BEATMAP_MIRRORS)[number];
export type BeatmapMirrorName = BeatmapMirror["name"];

// Probe order for a set: deterministic (beatmapsetId decides the starting
// mirror) so load spreads across mirrors instead of everyone hitting the
// first entry.
export function mirrorOrderFor(beatmapsetId: number): BeatmapMirror[] {
  const start = beatmapsetId % BEATMAP_MIRRORS.length;
  return [...BEATMAP_MIRRORS.slice(start), ...BEATMAP_MIRRORS.slice(0, start)];
}

// The osz buttons go through our redirect route, which probes the mirrors
// server-side and 302s to the first one that is actually serving archives.
// The download bytes flow mirror-to-browser; only the health check runs here.
export function oszDownloadUrl(beatmapsetId: number): string {
  return `/api/osz?beatmapsetId=${beatmapsetId}`;
}
