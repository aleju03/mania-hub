import { useEffect, useState } from "react";

function parseAvatarUserId(url: string | undefined): number | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, "http://localhost");
    if (parsed.hostname !== "a.ppy.sh") return null;
    const id = Number(parsed.pathname.split("/").filter(Boolean)[0]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export function avatarImageSrc(url: string | undefined, userId?: number | string | null): string | undefined {
  const parsedUserId = userId == null || userId === "" ? null : Number(userId);
  const id = parsedUserId !== null && Number.isSafeInteger(parsedUserId) && parsedUserId > 0
    ? parsedUserId
    : parseAvatarUserId(url);
  return id ? `/api/avatar?u=${id}` : url;
}

export function getAvatarFallbackSrc(currentSrc: string | undefined, originalUrl: string | undefined): string | null {
  if (!currentSrc || !originalUrl || currentSrc === originalUrl) return null;
  return originalUrl;
}

export function Avatar({
  url,
  userId,
  seed,
  size = 40,
  shape = "circle",
  online = false,
}: {
  url?: string;
  userId?: number | string | null;
  seed?: number;
  size?: number;
  shape?: "circle" | "square";
  online?: boolean;
}) {
  const [useOriginalUrl, setUseOriginalUrl] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const shapeClass = shape === "square" ? "rounded-none" : "rounded-full";
  const onlineClass = online
    ? "ring-2 ring-osu-green-light shadow-[0_0_8px_rgba(179,217,68,0.45)]"
    : "";
  const proxiedUrl = avatarImageSrc(url, userId);
  const imageUrl = useOriginalUrl && url ? url : proxiedUrl;

  useEffect(() => {
    setUseOriginalUrl(false);
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
        onError={() => {
          const fallbackUrl = getAvatarFallbackSrc(imageUrl, url);
          if (!useOriginalUrl && fallbackUrl) {
            setUseOriginalUrl(true);
            return;
          }
          setImageFailed(true);
        }}
      />
    );
  }
  const h = ((seed ?? 0) * 137) % 360;
  return (
    <div
      className={`${shapeClass} ${onlineClass} flex-shrink-0`}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, hsl(${h},60%,40%), hsl(${(h + 60) % 360},50%,30%))`,
      }}
    />
  );
}
