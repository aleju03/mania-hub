export function Avatar({
  url,
  seed,
  size = 40,
  shape = "circle",
}: {
  url?: string;
  seed?: number;
  size?: number;
  shape?: "circle" | "square";
}) {
  const shapeClass = shape === "square" ? "rounded-none" : "rounded-full";

  if (url) {
    return (
      <img
        src={url}
        alt="avatar"
        width={size}
        height={size}
        className={`${shapeClass} flex-shrink-0 object-cover`}
        style={{ width: size, height: size }}
        loading="lazy"
      />
    );
  }
  const h = ((seed ?? 0) * 137) % 360;
  return (
    <div
      className={`${shapeClass} flex-shrink-0`}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, hsl(${h},60%,40%), hsl(${(h + 60) % 360},50%,30%))`,
      }}
    />
  );
}
