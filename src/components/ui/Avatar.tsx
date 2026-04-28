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
  const id = Number.isSafeInteger(parsedUserId) && parsedUserId > 0
    ? parsedUserId
    : parseAvatarUserId(url);
  return id ? `/api/avatar?u=${id}` : url;
}

export function Avatar({
  url,
  seed,
  size = 40,
  shape = "circle",
  online = false,
}: {
  url?: string;
  seed?: number;
  size?: number;
  shape?: "circle" | "square";
  online?: boolean;
}) {
  const shapeClass = shape === "square" ? "rounded-none" : "rounded-full";
  const onlineClass = online
    ? "ring-2 ring-osu-green-light shadow-[0_0_8px_rgba(179,217,68,0.45)]"
    : "";

  if (url) {
    return (
      <img
        src={avatarImageSrc(url)}
        alt="avatar"
        width={size}
        height={size}
        className={`${shapeClass} ${onlineClass} flex-shrink-0 object-cover`}
        style={{ width: size, height: size }}
        loading="lazy"
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
