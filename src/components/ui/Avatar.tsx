import { useEffect, useState } from "react";

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

// Default goes direct to a.ppy.sh so rankings/feeds don't burst N same-origin
// requests (which trips Vercel's DDoS heuristics). The osu CDN doesn't set
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

export function Avatar({
  url,
  userId,
  size = 40,
  shape = "circle",
  online = false,
}: {
  url?: string;
  userId?: number | string | null;
  size?: number;
  shape?: "circle" | "square";
  online?: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const shapeClass = shape === "square" ? "rounded-none" : "rounded-full";
  const onlineClass = online
    ? "ring-2 ring-osu-green-light shadow-[0_0_8px_rgba(179,217,68,0.45)]"
    : "";
  const imageUrl = avatarImageSrc(url, userId);

  useEffect(() => {
    setImageFailed(false);
  }, [url, userId]);

  if (imageUrl && !imageFailed) {
    return (
      <img
        src={imageUrl}
        alt="avatar"
        width={size}
        height={size}
        className={`${shapeClass} ${onlineClass} flex-shrink-0 object-cover`}
        style={{ width: size, height: size }}
        loading="lazy"
        onError={() => setImageFailed(true)}
      />
    );
  }
  return (
    <div
      className={`${shapeClass} ${onlineClass} flex-shrink-0 bg-osu-b6`}
      style={{ width: size, height: size }}
    />
  );
}
