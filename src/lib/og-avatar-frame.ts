// A supporter's avatar in their frame, for the pictures /api/og makes. The
// site lays a frame's art over the avatar (SupporterAvatarFrame.tsx); here the
// same still is laid over it with sharp, by the same geometry
// (supporter-avatar-frames.ts). Frames the site draws live with the wearer's
// own name or dans on them come out as their still, without those.

import {
  isSupporterAvatarFrame,
  isWorkshopFrameId,
  supporterFrameGeometry,
  supporterFrameSrc,
  workshopFrameGeometry,
  type FrameGeometry,
  type SupporterAvatarFrameId,
} from "./supporter-avatar-frames";

/** A workshop frame's files, which the site's own frames need none of. */
export interface OgFrameArt {
  still: string;
  /** The still for a round avatar, when the frame has one. */
  round: string | null;
  /** How far the art reaches past the avatar: left, top, right, bottom, in avatar widths. */
  overhang: [number, number, number, number];
}

export interface OgFrame {
  id: string;
  art: OgFrameArt | null;
}

export interface OgFramedAvatar {
  png: Buffer;
  width: number;
  height: number;
  /** Where the avatar itself sits in the picture. */
  avatar: { x: number; y: number; size: number };
}

function geometryOf(frame: OgFrame): FrameGeometry | null {
  if (isWorkshopFrameId(frame.id)) return frame.art ? workshopFrameGeometry({ overhang: frame.art.overhang, round: frame.art.round, video: null }) : null;
  return isSupporterAvatarFrame(frame.id) ? supporterFrameGeometry(frame.id) : null;
}

/** The frame's still: a path on the site for its own frames, a URL for a workshop one. */
function stillOf(frame: OgFrame, round: boolean): string {
  if (frame.art) return (round ? frame.art.round : null) ?? frame.art.still;
  return supporterFrameSrc(frame.id as SupporterAvatarFrameId, "still", { round });
}

type Matrix = [[number, number, number], [number, number, number], [number, number, number]];

// A frame's CSS filter on the avatar (sepia, saturate, contrast), as sharp applies it.
function applyAvatarFilter<T extends { recomb(matrix: Matrix): T; linear(a: number, b: number): T }>(image: T, filter: string): T {
  let out = image;
  for (const [, name, raw] of filter.matchAll(/([a-z]+)\(([\d.]+)\)/g)) {
    const amount = Number(raw);
    if (name === "sepia") {
      const rest = 1 - amount;
      out = out.recomb([
        [0.393 + 0.607 * rest, 0.769 - 0.769 * rest, 0.189 - 0.189 * rest],
        [0.349 - 0.349 * rest, 0.686 + 0.314 * rest, 0.168 - 0.168 * rest],
        [0.272 - 0.272 * rest, 0.534 - 0.534 * rest, 0.131 + 0.869 * rest],
      ]);
    } else if (name === "saturate") {
      out = out.recomb([
        [0.213 + 0.787 * amount, 0.715 - 0.715 * amount, 0.072 - 0.072 * amount],
        [0.213 - 0.213 * amount, 0.715 + 0.285 * amount, 0.072 - 0.072 * amount],
        [0.213 - 0.213 * amount, 0.715 - 0.715 * amount, 0.072 + 0.928 * amount],
      ]);
    } else if (name === "contrast") {
      out = out.linear(amount, 255 * (0.5 - 0.5 * amount));
    }
  }
  return out;
}

export interface OgFramedAvatarOptions {
  avatar: Buffer;
  frame: OgFrame;
  /** The avatar's size without a frame. */
  size: number;
  /** Drawn round, as the site's lists draw avatars. */
  round: boolean;
  /**
   * The room past the avatar's edges, in pixels, on the sides that have a
   * limit. Art that reaches further has the avatar drawn smaller (no smaller
   * than `minScale`) so it fits.
   */
  room?: { left?: number; top?: number; right?: number; bottom?: number };
  minScale?: number;
  /** The art's bytes: a site path (`/images/...`) or a workshop frame's URL. */
  loadArt: (source: string) => Promise<Buffer | null>;
}

/** The avatar in its frame, or null when the frame or its art is unknown: the caller then draws the avatar bare. */
export async function drawFramedAvatar(options: OgFramedAvatarOptions): Promise<OgFramedAvatar | null> {
  const geometry = geometryOf(options.frame);
  if (!geometry) return null;
  // A square-window frame keeps its avatar square in a list too.
  const circle = options.round && !geometry.squareWindow;
  const art = await options.loadArt(stillOf(options.frame, circle && Boolean(geometry.roundStill)));
  if (!art) return null;

  const [overLeft, overTop, overRight, overBottom] = geometry.overhang;
  let size = options.size;
  if (options.room) {
    const { room } = options;
    const side = (reach: number, limit: number | undefined) => (limit != null && reach > 0 ? limit / (reach * size) : Infinity);
    const fit = Math.min(side(overLeft, room.left), side(overTop, room.top), side(overRight, room.right), side(overBottom, room.bottom), 1);
    size = Math.round(size * Math.max(fit, options.minScale ?? 0.8));
  }
  const left = Math.ceil(overLeft * size);
  const top = Math.ceil(overTop * size);
  const width = left + size + Math.ceil(overRight * size);
  const height = top + size + Math.ceil(overBottom * size);

  try {
    const { default: sharp } = await import("sharp");
    const radius = circle ? size / 2 : (size * 16) / 124;
    const mask = Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" ry="${radius}"/></svg>`);
    let picture = sharp(options.avatar).resize(size, size, { fit: "cover" }).removeAlpha();
    if (geometry.avatarFilter) picture = applyAvatarFilter(picture, geometry.avatarFilter);
    const avatar = await sharp(await picture.png().toBuffer()).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();

    // The art's canvas, cut to the part that lands on the picture.
    const [boxLeft, boxTop, boxWidth, boxHeight] = geometry.box;
    const artWidth = Math.round(boxWidth * size);
    const artHeight = Math.round(boxHeight * size);
    const artX = left + Math.round(boxLeft * size);
    const artY = top + Math.round(boxTop * size);
    const cut = {
      left: Math.max(0, -artX),
      top: Math.max(0, -artY),
      right: Math.min(artWidth, width - artX),
      bottom: Math.min(artHeight, height - artY),
    };
    const layers: Array<{ input: Buffer; left: number; top: number }> = [{ input: avatar, left, top }];
    if (cut.right > cut.left && cut.bottom > cut.top) {
      const overlay = await sharp(art)
        .resize(artWidth, artHeight, { fit: "fill" })
        .extract({ left: cut.left, top: cut.top, width: cut.right - cut.left, height: cut.bottom - cut.top })
        .png()
        .toBuffer();
      layers.push({ input: overlay, left: artX + cut.left, top: artY + cut.top });
    }
    const png = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png().toBuffer();
    return { png, width, height, avatar: { x: left, y: top, size } };
  } catch {
    return null;
  }
}
