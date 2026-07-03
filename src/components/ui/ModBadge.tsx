const fileMap: Record<string, string> = {
  // Classic / stable mods
  HD: "hidden", HR: "hard-rock", DT: "double-time", FL: "flashlight",
  EZ: "easy", NF: "no-fail", HT: "half-time", NC: "nightcore",
  SD: "sudden-death", PF: "perfect", RX: "relax", AP: "autopilot",
  CL: "classic", SO: "spun-out", TD: "touch-device", MR: "mirror",
  FI: "fade-in", RD: "random", CO: "co-op", AT: "autoplay",
  SV2: "score-v2",
  // Lazer mods
  AC: "accuracy-challenge", AD: "approach-different", AS: "adaptive-speed",
  BL: "blinds", BM: "bloom", BR: "barrel-roll", BU: "bubbles",
  CN: "cinema", CS: "constant-speed", DA: "difficulty-adjust",
  DC: "daycore", DF: "deflate", DP: "depth", DS: "dual-stages",
  FF: "floating-fruits", FR: "freeze-frame", GR: "grow",
  HO: "hold-off", IN: "invert", MG: "magnetised", MU: "muted",
  NR: "no-release", NS: "no-scope", RP: "repel", SG: "single-tap",
  SI: "spin-in", SR: "simplified-rhythm", ST: "strict-tracking",
  SW: "swap", SY: "synesthesia", TC: "traceable", TP: "transform",
  WG: "wiggle", WD: "wind-down", WU: "wind-up",
  "1K": "one-key", "2K": "two-keys", "3K": "three-keys", "4K": "four-keys",
  "5K": "five-keys", "6K": "six-keys", "7K": "seven-keys", "8K": "eight-keys",
  "9K": "nine-keys", "10K": "ten-keys",
  AL: "alternate", MO: "moving-fast", TP2: "target-practice",
  NM: "no-mod",
};

const typeColor: Record<string, string> = {
  // Difficulty increase (red)
  HR: "#ff6666", DT: "#ff6666", FL: "#ff6666", HD: "#ff6666", NC: "#ff6666",
  FI: "#ff6666", SD: "#ff6666", PF: "#ff6666", AC: "#ff6666", BL: "#ff6666",
  ST: "#ff6666", MU: "#ff6666",
  // Difficulty decrease (green)
  EZ: "#b3d944", NF: "#b3d944", HT: "#b3d944", DC: "#b3d944", NR: "#b3d944",
  // Automation / fun (blue)
  AP: "#66ccff", RX: "#66ccff", SO: "#66ccff", RD: "#66ccff", AT: "#66ccff",
  CN: "#66ccff", MR: "#66ccff", AS: "#66ccff", CS: "#66ccff",
  // Special (pink/purple/yellow)
  TD: "#ff66aa", CL: "#aa88ff", CO: "#ffcc22", SV2: "#ffcc22",
};

const iconInset: Record<string, number> = {
  DT: 1,
  NC: 1,
};

export function ModBadge({ mod, size = 1, rate, color }: { mod: string; size?: number; rate?: number; color?: string }) {
  if (!mod) return null;
  const file = fileMap[mod];
  const bg = color ?? typeColor[mod] ?? "#ff6666";
  const inset = (iconInset[mod] ?? 1) * size;
  const width = 36 * size;
  const height = 24 * size;
  const mask = (url: string) => ({
    backgroundColor: bg,
    maskImage: `url(${url})`, WebkitMaskImage: `url(${url})`,
    maskSize: "contain", WebkitMaskSize: "contain",
    maskPosition: "center", WebkitMaskPosition: "center",
    maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat",
  });

  // Format matches osu-web: 2 decimals + "×" (U+00D7). E.g. 0.9 → "0.90×".
  const rateText = rate != null ? `${rate.toFixed(2)}×` : null;
  const title = rateText != null ? `${mod} ${rateText}` : mod;
  const iconPill = file ? (
    <div className="relative flex-shrink-0" style={{ width, height }} title={title}>
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
  ) : (
    <div
      className="relative flex-shrink-0 flex items-center justify-center"
      style={{ width, height }}
      title={title}
    >
      <div className="absolute inset-0" style={mask("/images/badges/mods/mod-icon.svg")} />
      <span
        className="relative font-bold leading-none"
        style={{ fontSize: `${12 * size}px`, color: `color-mix(in srgb-linear, black, ${bg} 10%)` }}
      >
        {mod}
      </span>
    </div>
  );

  if (rateText != null) {
    // Dimensions cross-reference osu-web's .mod__extender (resources/css/bem/mod.less):
    // extender width = 2.2em, margin-left = -0.5em, padding-left = 0.5em, font-size = 0.5em
    // where 1em = height. Darker tail color = color-mix(in srgb, black, bg 26.3%)
    // which matches osu-framework's .Darken(2.8f).
    const extenderWidth = Math.round(height * 2.2);
    const overlap = Math.round(height * 0.5);
    const fontSize = Math.round(height * 0.5);
    const darkerBg = `color-mix(in srgb, black, ${bg} 26.3%)`;
    return (
      <div className="flex items-center flex-shrink-0" title={title}>
        {iconPill}
        <div
          className="flex items-center justify-center"
          style={{
            width: extenderWidth,
            height,
            marginLeft: -overlap,
            paddingLeft: overlap,
            paddingRight: 3 * size,
            paddingBottom: 1 * size,
            backgroundColor: darkerBg,
            maskImage: "url(/images/badges/mods/mod-icon-extender.svg)",
            WebkitMaskImage: "url(/images/badges/mods/mod-icon-extender.svg)",
            maskSize: "contain",
            WebkitMaskSize: "contain",
            maskPosition: "center",
            WebkitMaskPosition: "center",
            maskRepeat: "no-repeat",
            WebkitMaskRepeat: "no-repeat",
          }}
        >
          <span className="font-bold leading-none" style={{ fontSize, color: bg }}>
            {rateText}
          </span>
        </div>
      </div>
    );
  }

  return iconPill;
}
