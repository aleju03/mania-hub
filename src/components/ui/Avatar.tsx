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
        src={url}
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
