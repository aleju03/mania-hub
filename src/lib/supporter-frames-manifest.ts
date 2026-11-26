import {
  parseWorkshopFrameArt,
  SUPPORTER_AVATAR_FRAMES,
  supporterFrameGeometry,
  supporterFrameSrc,
  workshopFrameGeometry,
  type FrameGeometry,
  type WorkshopFrameArt,
} from "./supporter-avatar-frames";

/* Every avatar frame as files and geometry, for apps that draw them outside
   the site (Hashi's leaderboard), served at /supporter-frames.json. `box` and
   `overhang` are supporterFrameGeometry's, in avatar widths; `square` marks a
   frame whose avatar stays square in a list (framedAvatarStyle's round
   exception). `video` only for a frame that loops, `roundVideo` only for one
   whose round still loops too. Frames the site draws live (the name label, the
   dan badge, the trophy shelf) give their still alone. */

export interface FrameManifestEntry {
  box: readonly [number, number, number, number];
  overhang: readonly [number, number, number, number];
  still: string;
  round?: string;
  video?: string;
  roundVideo?: string;
  square?: true;
  avatarFilter?: string;
}

function drawnLive(geometry: FrameGeometry): boolean {
  return Boolean(geometry.nameLabel || geometry.danShelf || geometry.danWindow);
}

function entryOf(geometry: FrameGeometry, files: { still: string; round: string | null; video: string | null; roundVideo: string | null }): FrameManifestEntry {
  const loops = !geometry.stillOnly && !drawnLive(geometry);
  return {
    box: geometry.box,
    overhang: geometry.overhang,
    still: files.still,
    ...(geometry.roundStill && files.round ? { round: files.round } : {}),
    ...(loops && files.video ? { video: files.video } : {}),
    ...(geometry.roundStill && geometry.roundLoop && files.roundVideo ? { roundVideo: files.roundVideo } : {}),
    ...(geometry.squareWindow ? { square: true as const } : {}),
    ...(geometry.avatarFilter ? { avatarFilter: geometry.avatarFilter } : {}),
  };
}

export function buildFramesManifest(origin: string, workshop: Record<string, WorkshopFrameArt>): { frames: Record<string, FrameManifestEntry> } {
  const frames: Record<string, FrameManifestEntry> = {};
  for (const id of SUPPORTER_AVATAR_FRAMES) {
    frames[id] = entryOf(supporterFrameGeometry(id), {
      still: `${origin}${supporterFrameSrc(id, "still")}`,
      round: `${origin}${supporterFrameSrc(id, "still", { round: true })}`,
      video: `${origin}${supporterFrameSrc(id, "video")}`,
      roundVideo: null,
    });
  }
  for (const [id, art] of Object.entries(workshop)) {
    frames[id] = entryOf(workshopFrameGeometry(art), art);
  }
  return { frames };
}

/* The workshop frames a list can meet: the listed ones, and every one an
   active supporter wears (an unlisted frame is worn by its maker only). */
export async function readWorkshopFrames(base: string, timeoutMs = 4_000): Promise<Record<string, WorkshopFrameArt>> {
  const [listed, worn] = await Promise.all([
    fetch(`${base}/api/supporters/frames`, { signal: AbortSignal.timeout(timeoutMs) }).then((r) => (r.ok ? r.json() : null)) as Promise<{ frames?: unknown } | null>,
    fetch(`${base}/api/supporters/name-styles`, { signal: AbortSignal.timeout(timeoutMs) }).then((r) => (r.ok ? r.json() : null)) as Promise<{ frameArt?: unknown } | null>,
  ]);
  if (!listed || !worn) throw new Error("workshop frames unavailable");
  const listedById = Array.isArray(listed.frames)
    ? Object.fromEntries((listed.frames as { id?: unknown }[]).filter((frame) => typeof frame?.id === "string").map((frame) => [frame.id as string, frame]))
    : {};
  return { ...parseWorkshopFrameArt(listedById), ...parseWorkshopFrameArt(worn.frameArt) };
}
