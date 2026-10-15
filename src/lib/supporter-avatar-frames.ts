/* Supporter avatar frames: art drawn around a supporter's avatar on their
   profile. Each frame is a looping transparent WebM plus a still PNG under
   /images/supporter-frames/, made from the designs in
   local-notes/supporter-decorations/ (export/export-frames.py writes both and
   the geometry below). The parts that pass behind the avatar are already cut
   out of the art, so the frame simply lies on top of it. The backend keeps the
   pick against the same ids (SUPPORTER_AVATAR_FRAMES in features/supporters.ts);
   how the picker groups them lives in SupporterFramePicker. */

interface FrameGeometry {
  /* Where the art's canvas sits: [left, top, width, height] in avatar widths, from the avatar's top-left corner. */
  box: readonly [number, number, number, number];
  /* How far the drawn art reaches past the avatar: [left, top, right, bottom] in avatar widths. */
  overhang: readonly [number, number, number, number];
  /* A CSS filter for the avatar itself, for frames that restyle the picture (a video overlay cannot). */
  avatarFilter?: string;
}

const FRAME_GEOMETRY = {
  "aero-window": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1048, 0.2177, 0.1048, 0.121] },
  "ai-wings-1": { box: [-0.7258, -0.7581, 2.6129, 1.9677], overhang: [0.7258, 0.2401, 0.7611, 0] },
  "ai-wings-2": { box: [-0.7258, -0.7581, 2.6129, 1.9677], overhang: [0.7258, 0.5294, 0.7611, 0] },
  "ai-wings-3": { box: [-0.7258, -0.7581, 2.6129, 1.9677], overhang: [0.7258, 0.7534, 0.7611, 0] },
  "autumn-maple": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.2419, 0.2419, 0.2419, 0.2419] },
  "azimuth-orbit": { box: [-0.3065, -0.371, 1.6129, 1.6774], overhang: [0.246, 0.3266, 0.254, 0.2298] },
  "bronze-laurel": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1129, 0.1008, 0.1331, 0.1855] },
  "cat-parade": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1573, 0.1694, 0.1532, 0.1694] },
  "classic-window": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.0726, 0.2056, 0.0726, 0.0847] },
  "crt-monitor": { box: [-0.2419, -0.2419, 1.4839, 1.6452], overhang: [0.1573, 0.1371, 0.1573, 0.3508] },
  "dan-skip-1-eta": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1048, 0.129, 0.1048, 0.1653] },
  "dan-skip-10-alpha": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1573, 0.0968, 0.121, 0.129] },
  "dan-skip-5-gamma": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.129, 0.129, 0.125, 0.1895] },
  "dan-skip-alpha-kappa": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1089, 0.1048, 0.1169, 0.125] },
  "delta-crest": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1734, 0.1653, 0.1774, 0.1855] },
  "dfjk-keys": { box: [-0.2419, -0.2419, 1.4839, 1.5806], overhang: [0, 0, 0, 0.1411] },
  "disc-bounce": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0, 0, 0, 0] },
  "error-cascade": { box: [-0.2419, -0.2419, 1.6129, 1.4839], overhang: [0, 0.1815, 0.3387, 0] },
  "fairy-lights": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.0927, 0.0565, 0.0927, 0] },
  "gamma-orbit": { box: [-0.3065, -0.371, 1.6129, 1.6774], overhang: [0.246, 0, 0.254, 0] },
  "hakurei-torii": { box: [-0.3548, -0.4839, 1.7097, 1.8226], overhang: [0.3548, 0.4637, 0.3548, 0.2702] },
  "hanging-stellium": { box: [-0.2984, -0.2984, 1.4839, 1.4839], overhang: [0, 0.0847, 0.1008, 0] },
  "ice-fairy": { box: [-0.5645, -0.3548, 2.129, 1.5806], overhang: [0.5081, 0.2016, 0.5161, 0.0927] },
  "ink-plum": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0, 0.2419, 0.2419, 0.1532] },
  "judgement-pop": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0, 0.1371, 0, 0] },
  "kappa-signal": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1169, 0.0484, 0.1532, 0.121] },
  "light-wings-1": { box: [-0.9194, -0.8065, 2.8387, 2.0161], overhang: [0.6573, 0.1241, 0.6573, 0] },
  "light-wings-2": { box: [-0.9194, -0.8065, 2.8387, 2.0161], overhang: [0.7938, 0.3588, 0.7938, 0] },
  "light-wings-3": { box: [-0.9194, -0.8065, 2.8387, 2.0161], overhang: [0.9084, 0.6154, 0.9084, 0] },
  "ln-hold-1": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1008, 0.125, 0.1008, 0.0766] },
  "ln-hold-13": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.125, 0.1048, 0.125, 0.1048] },
  "ln-hold-17": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.125, 0.1048, 0.125, 0.1048] },
  "ln-hold-5": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.1008, 0.125, 0.1008, 0.0766] },
  "ln-hold-9": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.125, 0.125, 0.125, 0.1048] },
  "loading-bar": { box: [-0.2419, -0.2419, 1.4839, 1.5806], overhang: [0, 0, 0, 0.121] },
  "makiba-peek": { box: [-0.2903, -0.3387, 1.5806, 1.5806], overhang: [0, 0.2786, 0.1572, 0] },
  "neon-ears": { box: [-0.2419, -0.3387, 1.4839, 1.5806], overhang: [0, 0.2944, 0, 0] },
  "old-photo": { box: [-0.2419, -0.2419, 1.4839, 1.6129], overhang: [0.1371, 0.2339, 0.1411, 0.3548], avatarFilter: "sepia(0.55) saturate(0.75) contrast(1.05)" },
  "pixel-hearts": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0, 0.0968, 0, 0] },
  "rain-cloud": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0, 0.1371, 0.2258, 0.0524] },
  "rainbow-crystal-wings": { box: [-0.6774, -0.2903, 2.3548, 1.3548], overhang: [0.621, 0.0605, 0.629, 0] },
  "reimu-ribbon": { box: [0.0806, -0.5161, 1.4194, 1.0484], overhang: [0, 0.3831, 0.3548, 0] },
  sakura: { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.2419, 0.2419, 0.0363, 0.2419] },
  "scarlet-moon": { box: [-0.4516, -0.4839, 1.871, 1.6129], overhang: [0.4516, 0.4556, 0.4194, 0] },
  "spell-card": { box: [-0.5484, -0.5484, 2.0968, 2.0968], overhang: [0.5484, 0.5484, 0.5484, 0.5484] },
  stardust: { box: [-0.6935, -0.3548, 2.0323, 2], overhang: [0.6935, 0, 0.2258, 0.3387] },
  "stellium-orbit": { box: [-0.3065, -0.371, 1.6129, 1.6774], overhang: [0.3065, 0.3266, 0.3065, 0.2298] },
  storm: { box: [-0.3226, -0.5968, 1.6452, 1.9194], overhang: [0.3145, 0.4798, 0.3105, 0.1129] },
  "term-boot": { box: [-0.2419, -0.2419, 1.4839, 1.5806], overhang: [0.1169, 0.1815, 0.1169, 0.3065] },
  "term-hud": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.2218, 0.1815, 0.2339, 0.1734] },
  "term-rain": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.2339, 0.2419, 0.2177, 0.2419] },
  "term-window": { box: [-0.2419, -0.2419, 1.4839, 1.6452], overhang: [0.1694, 0.2298, 0.1694, 0.4032] },
  "time-stop-knives": { box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.3306, 0.3226, 0.3306, 0.3427] },
  "wings-feather-1": { box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.7223, 0, 0.7235, 0] },
  "wings-feather-2": { box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.7334, 0.2501, 0.7346, 0] },
  "wings-feather-3": { box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.7334, 0.4931, 0.7346, 0] },
  "wings-gold-1": { box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.6561, 0, 0.6573, 0] },
  "wings-gold-2": { box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.6837, 0.2391, 0.6849, 0] },
  "wings-gold-3": { box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.6837, 0.4544, 0.6849, 0] },
  "wings-pink-1": { box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.7831, 0.0569, 0.7842, 0] },
  "wings-pink-2": { box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.8107, 0.3329, 0.8118, 0] },
  "wings-pink-3": { box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.8107, 0.5648, 0.8118, 0] },
  "wings-soft-1": { box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.5898, 0.1563, 0.5855, 0] },
  "wings-soft-2": { box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.5898, 0.4047, 0.5855, 0] },
  "wings-soft-3": { box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.5898, 0.5869, 0.5855, 0] },
  "wings-swept-1": { box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.6947, 0, 0.6904, 0] },
  "wings-swept-2": { box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.7389, 0.1728, 0.7401, 0] },
  "wings-swept-3": { box: [-0.8548, -0.7581, 2.871, 1.9677], overhang: [0.7389, 0.3992, 0.7401, 0] },
  "winter-pine": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.2419, 0.2419, 0.2419, 0.2419] },
  wisteria: { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.2419, 0.2258, 0, 0.2419] },
  "witch-hat": { box: [-0.4839, -0.7742, 1.2258, 1.0161], overhang: [0.2661, 0.6855, 0, 0] },
  "xp-window": { box: [-0.2419, -0.2419, 1.4839, 1.4839], overhang: [0.0887, 0.2016, 0.0887, 0.0887] },
  "yinyang-orbs": { box: [-0.371, -0.371, 1.7419, 1.7419], overhang: [0.3468, 0.3266, 0.3468, 0.3669] },
  "zenith-orbit": { box: [-0.3065, -0.371, 1.6129, 1.6774], overhang: [0.3065, 0.3266, 0.3065, 0.2298] },
} as const satisfies Record<string, FrameGeometry>;

export type SupporterAvatarFrameId = keyof typeof FRAME_GEOMETRY;

export const SUPPORTER_AVATAR_FRAMES = Object.keys(FRAME_GEOMETRY) as SupporterAvatarFrameId[];

/* The designs assume a 124px avatar with a 16px corner radius. */
export const FRAMED_AVATAR_RADIUS = `${(16 / 124) * 100}%`;

export function isSupporterAvatarFrame(value: unknown): value is SupporterAvatarFrameId {
  return typeof value === "string" && Object.hasOwn(FRAME_GEOMETRY, value);
}

/* Style for the avatar under a frame: the designs' corner radius, plus the
   frame's avatar filter if it has one. Nothing when there is no frame. */
export function framedAvatarStyle(frame: SupporterAvatarFrameId | null): { borderRadius: string; filter?: string } | undefined {
  if (!frame) return undefined;
  const filter = (FRAME_GEOMETRY[frame] as FrameGeometry).avatarFilter;
  return filter ? { borderRadius: FRAMED_AVATAR_RADIUS, filter } : { borderRadius: FRAMED_AVATAR_RADIUS };
}

export function supporterFrameGeometry(id: SupporterAvatarFrameId): FrameGeometry {
  return FRAME_GEOMETRY[id];
}

/* Bump after re-exporting any frame: /images/ is served cache-first by the
   service worker, so changed art needs a new URL. */
const FRAME_ART_VERSION = 11;

export function supporterFrameSrc(id: SupporterAvatarFrameId, kind: "video" | "still"): string {
  return `/images/supporter-frames/${id}.${kind === "video" ? "webm" : "png"}?v=${FRAME_ART_VERSION}`;
}
