export const MOD_BADGE_FILE_NAMES: Record<string, string> = {
  // Classic / stable mods
  HD: "hidden", HR: "hard-rock", DT: "double-time", FL: "flashlight",
  EZ: "easy", NF: "no-fail", HT: "half-time", NC: "nightcore",
  SD: "sudden-death", PF: "perfect", RX: "relax", AP: "autopilot",
  CL: "classic", SO: "spun-out", TD: "touch-device", MR: "mirror",
  FI: "fade-in", RD: "random", AT: "autoplay",
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
  WG: "wiggle", WD: "wind-down", WU: "wind-up", CO: "cover",
  "1K": "one-key", "2K": "two-keys", "3K": "three-keys", "4K": "four-keys",
  "5K": "five-keys", "6K": "six-keys", "7K": "seven-keys", "8K": "eight-keys",
  "9K": "nine-keys", "10K": "ten-keys",
  AL: "alternate", MO: "moving-fast", TP2: "target-practice",
  NM: "no-mod",
};

// Category colors follow lazer's OsuColour.ForModType / osu-web's mod badges:
// Red1 / Lime1 / Purple1 / Blue1 / Pink1 / yellow.
export const MOD_BADGE_TYPE_COLORS: Record<string, string> = {
  // Difficulty increase (red)
  HR: "#ff6666", DT: "#ff6666", FL: "#ff6666", HD: "#ff6666", NC: "#ff6666",
  FI: "#ff6666", CO: "#ff6666", SD: "#ff6666", PF: "#ff6666", AC: "#ff6666",
  BL: "#ff6666", ST: "#ff6666",
  // Difficulty reduction (lime)
  EZ: "#b2ff66", NF: "#b2ff66", HT: "#b2ff66", DC: "#b2ff66", NR: "#b2ff66",
  // Conversion (purple)
  MR: "#8c66ff", RD: "#8c66ff", IN: "#8c66ff", HO: "#8c66ff", CS: "#8c66ff",
  DS: "#8c66ff", DA: "#8c66ff", CL: "#8c66ff", SW: "#8c66ff", SG: "#8c66ff",
  AL: "#8c66ff", SR: "#8c66ff", TP2: "#8c66ff",
  "1K": "#8c66ff", "2K": "#8c66ff", "3K": "#8c66ff", "4K": "#8c66ff",
  "5K": "#8c66ff", "6K": "#8c66ff", "7K": "#8c66ff", "8K": "#8c66ff",
  "9K": "#8c66ff", "10K": "#8c66ff",
  // Automation (blue)
  AP: "#66ccff", RX: "#66ccff", SO: "#66ccff", AT: "#66ccff", CN: "#66ccff",
  // Fun (pink)
  WU: "#ff66ab", WD: "#ff66ab", AS: "#ff66ab", MU: "#ff66ab", SY: "#ff66ab",
  AD: "#ff66ab", BR: "#ff66ab", BU: "#ff66ab", BM: "#ff66ab", DF: "#ff66ab",
  DP: "#ff66ab", FF: "#ff66ab", FR: "#ff66ab", GR: "#ff66ab", MG: "#ff66ab",
  NS: "#ff66ab", RP: "#ff66ab", SI: "#ff66ab", TC: "#ff66ab", TP: "#ff66ab",
  WG: "#ff66ab",
  // System (yellow)
  TD: "#ffcc22", SV2: "#ffcc22",
};

const iconInset: Record<string, number> = {
  DT: 1,
  NC: 1,
};

export function ModBadge({ mod, size = 1, rate, color }: { mod: string; size?: number; rate?: number; color?: string }) {
  if (!mod) return null;
  const file = MOD_BADGE_FILE_NAMES[mod];
  const bg = color ?? MOD_BADGE_TYPE_COLORS[mod] ?? "#ff6666";
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
  // Spans, not divs: the badge also renders inside <p> prose (dan-estimates
  // explainer), where a div would make the SSR HTML invalid and break hydration.
  const iconPill = file ? (
    <span className="relative inline-block flex-shrink-0 align-middle" style={{ width, height }} title={title}>
      <span className="absolute inset-0" style={mask("/images/badges/mods/mod-icon.svg")} />
      <span
        className="absolute"
        style={{
          inset,
          ...mask(`/images/badges/mods/mod-${file}.svg`),
          backgroundColor: `color-mix(in srgb-linear, black, ${bg} 10%)`,
        }}
      />
    </span>
  ) : (
    <span
      className="relative flex-shrink-0 inline-flex items-center justify-center align-middle"
      style={{ width, height }}
      title={title}
    >
      <span className="absolute inset-0" style={mask("/images/badges/mods/mod-icon.svg")} />
      <span
        className="relative font-bold leading-none"
        style={{ fontSize: `${12 * size}px`, color: `color-mix(in srgb-linear, black, ${bg} 10%)` }}
      >
        {mod}
      </span>
    </span>
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
      <span className="inline-flex items-center flex-shrink-0 align-middle" title={title}>
        {iconPill}
        <span
          className="inline-flex items-center justify-center"
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
        </span>
      </span>
    );
  }

  return iconPill;
}
