const fileMap: Record<string, string> = {
  HD: "hidden", HR: "hard-rock", DT: "double-time", FL: "flashlight",
  EZ: "easy", NF: "no-fail", HT: "half-time", NC: "nightcore",
  SD: "sudden-death", PF: "perfect", RX: "relax", AP: "autopilot",
  CL: "classic", SO: "spun-out", TD: "touch-device", MR: "mirror",
  FI: "fade-in", RD: "random", CO: "co-op", AT: "autoplay",
};

const typeColor: Record<string, string> = {
  HR: "#ff6666", DT: "#ff6666", FL: "#ff6666", HD: "#ff6666", NC: "#ff6666",
  FI: "#ff6666", MR: "#66ccff",
  EZ: "#b3d944", NF: "#b3d944", HT: "#b3d944",
  AP: "#66ccff", RX: "#66ccff", SO: "#66ccff", RD: "#66ccff",
  TD: "#ff66aa", CL: "#aa88ff", SD: "#ff6666", PF: "#ff6666",
  CO: "#ffcc22", AT: "#66ccff",
};

const iconInset: Record<string, number> = {
  DT: 2,
  NC: 2,
};

export function ModBadge({ mod }: { mod: string }) {
  if (!mod) return null;
  const file = fileMap[mod] || mod.toLowerCase();
  const bg = typeColor[mod] || "#ff6666";
  const inset = iconInset[mod] ?? 1;
  const mask = (url: string) => ({
    backgroundColor: bg,
    maskImage: `url(${url})`, WebkitMaskImage: `url(${url})`,
    maskSize: "contain", WebkitMaskSize: "contain",
    maskPosition: "center", WebkitMaskPosition: "center",
    maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat",
  });
  return (
    <div className="relative flex-shrink-0" style={{ width: 36, height: 24 }} title={mod}>
      <div className="absolute inset-0" style={mask("/images/badges/mods/mod-icon.svg")} />
      <div
        className="absolute"
        style={{
          inset,
          ...mask(`/images/badges/mods/mod-${file}.svg`),
          backgroundColor: `color-mix(in srgb-linear, black, ${bg} 10%)`,
        }}
      />
    </div>
  );
}
