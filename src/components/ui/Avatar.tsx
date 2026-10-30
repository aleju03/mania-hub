import { useEffect, useState, useSyncExternalStore } from "react";
import { useLingui } from "@lingui/react/macro";

import { ensureSupporterNameStyles, getSupporterListFrame, subscribeSupporterNameStyles } from "../../lib/live-backend";
import { framedAvatarStyle, supporterFrameGeometry } from "../../lib/supporter-avatar-frames";
import { useHydrated } from "../../lib/use-hydrated";
import { SupporterAvatarFrame } from "../player/SupporterAvatarFrame";
import { scaledPx } from "../../lib/ui-scale-values";

type ParsedAvatarUrl = {
  userId: number;
  version: string | null;
};

function parseAvatarUrl(url: string | undefined): ParsedAvatarUrl | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, "http://localhost");
    if (parsed.hostname !== "a.ppy.sh") return null;
    const id = Number(parsed.pathname.split("/").filter(Boolean)[0]);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const version = parsed.search ? parsed.search.slice(1) : null;
    return { userId: id, version };
  } catch {
    return null;
  }
}

/* The osu! user id in an a.ppy.sh avatar URL, or null. */
export function avatarUrlUserId(url: string | undefined): number | null {
  return parseAvatarUrl(url)?.userId ?? null;
}

// Default goes direct to a.ppy.sh so rankings/feeds don't burst N same-origin
// proxy requests through our own server. The osu CDN doesn't set
// CORS headers, so canvas/Three.js callers must opt in to the proxy.
export function avatarImageSrc(
  url: string | undefined,
  userId?: number | string | null,
  options?: { proxy?: boolean },
): string | undefined {
  // Locally hosted avatars (archived players, whose a.ppy.sh image is gone and
  // now resolves to the guest default) are already same-origin: no id rewrite,
  // no proxy.
  if (url?.startsWith("/")) return url;
  const parsedUrl = parseAvatarUrl(url);
  const parsedUserId = userId == null || userId === "" ? null : Number(userId);
  const id = parsedUserId !== null && Number.isSafeInteger(parsedUserId) && parsedUserId > 0
    ? parsedUserId
    : parsedUrl?.userId;
  const version = parsedUrl && parsedUrl.userId === id ? parsedUrl.version : null;
  if (options?.proxy) {
    if (!id) return url;
    const params = new URLSearchParams({ u: String(id) });
    if (version) params.set("v", version);
    return `/api/avatar?${params.toString()}`;
  }
  if (id) return `https://a.ppy.sh/${id}${version ? `?${version}` : ""}`;
  return url;
}

/* How far a list avatar's frame may reach past its slot, in slot widths: the
   whole frame is shrunk to fit. Past LIST_FRAME_CLIP wide its sides fade out,
   so wide wings keep the picture near full size and melt into the gaps
   beside the slot instead of covering the row's rank and name. */
const LIST_FRAME_REACH = { x: 2.2, y: 1.5 };
const LIST_FRAME_CLIP = 1.8;
const LIST_FRAME_FADE = "linear-gradient(90deg, transparent 0%, #000 12%, #000 88%, transparent 100%)";

export function Avatar({
  url,
  userId,
  size = 40,
  shape = "circle",
  online = false,
  framed = false,
}: {
  url?: string;
  userId?: number | string | null;
  size?: number;
  shape?: "circle" | "square";
  online?: boolean;
  /** Draw the player's supporter frame (still) around the avatar, as lists do. */
  framed?: boolean;
}) {
  const { t } = useLingui();
  const [imageFailed, setImageFailed] = useState(false);
  const hydrated = useHydrated();
  const frameUserId = framed ? (Number(userId) > 0 ? Number(userId) : parseAvatarUrl(url)?.userId ?? null) : null;
  // after hydration only, like styled names, so server and client markup agree
  const frame = useSyncExternalStore(
    subscribeSupporterNameStyles,
    () => (hydrated && frameUserId ? getSupporterListFrame(frameUserId) : null),
    () => null,
  );
  useEffect(() => {
    if (frameUserId) ensureSupporterNameStyles();
  }, [frameUserId]);
  const shapeClass = shape === "square" ? "rounded-none" : "rounded-full";
  const onlineClass = online
    ? "ring-2 ring-osu-green-light shadow-[0_0_8px_rgba(179,217,68,0.45)]"
    : "";
  const imageUrl = avatarImageSrc(url, userId);

  useEffect(() => {
    setImageFailed(false);
  }, [url, userId]);

  if (frame && imageUrl && !imageFailed) {
    const [left, top, right, bottom] = supporterFrameGeometry(frame).overhang;
    const fit = Math.min(1, LIST_FRAME_REACH.x / (1 + left + right), LIST_FRAME_REACH.y / (1 + top + bottom));
    const inner = size * fit;
    // centre the framed whole on the slot, so the row's layout never moves
    const x = (size - inner * (1 + left + right)) / 2 + inner * left;
    const y = (size - inner * (1 + top + bottom)) / 2 + inner * top;
    // wider than the clip: draw it in a box that wide (and tall enough for anything), faded at the sides
    const fade = inner * (1 + left + right) > size * LIST_FRAME_CLIP;
    const pad = { x: fade ? (size * (LIST_FRAME_CLIP - 1)) / 2 : 0, y: fade ? size : 0 };
    return (
      <span className="relative block flex-shrink-0" style={{ width: scaledPx(size), height: scaledPx(size) }}>
        <span
          className="pointer-events-none absolute"
          style={{ left: scaledPx(-pad.x), top: scaledPx(-pad.y), width: scaledPx(size + 2 * pad.x), height: scaledPx(size + 2 * pad.y), ...(fade ? { maskImage: LIST_FRAME_FADE, WebkitMaskImage: LIST_FRAME_FADE } : {}) }}
        >
          <span className="absolute" style={{ left: scaledPx(pad.x + x), top: scaledPx(pad.y + y), width: scaledPx(inner), height: scaledPx(inner) }}>
            <img
              src={imageUrl}
              alt={t`avatar`}
              className="h-full w-full object-cover"
              style={framedAvatarStyle(frame, { round: shape === "circle" })}
              loading="lazy"
              onError={() => setImageFailed(true)}
            />
            <SupporterAvatarFrame frame={frame} still round={shape === "circle"} userId={frameUserId} />
          </span>
        </span>
      </span>
    );
  }

  if (imageUrl && !imageFailed) {
    return (
      <img
        src={imageUrl}
        alt={t`avatar`}
        width={size}
        height={size}
        className={`${shapeClass} ${onlineClass} flex-shrink-0 object-cover`}
        style={{ width: scaledPx(size), height: scaledPx(size) }}
        loading="lazy"
        onError={() => setImageFailed(true)}
      />
    );
  }
  return (
    <div
      className={`${shapeClass} ${onlineClass} flex-shrink-0 bg-osu-b6`}
      style={{ width: scaledPx(size), height: scaledPx(size) }}
    />
  );
}
