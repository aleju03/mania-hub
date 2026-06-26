// Playstyle pattern taxonomy, mirroring the profile activity page so My Data's fingerprint uses
// the same labels and colors. Keys come from the backend dan-estimator families plus LN subtypes.

export const SKILL_PATTERN_META: Record<string, { label: string; short: string; color: string }> = {
  stream: { label: "Stream", short: "S", color: "#8f6bd8" },
  jumpstream: { label: "Jumpstream", short: "JS", color: "#6f87d8" },
  handstream: { label: "Handstream", short: "HS", color: "#b06bc0" },
  jack: { label: "Jack", short: "J", color: "#c66f84" },
  chordjack: { label: "Chordjack", short: "CJ", color: "#c59a5c" },
  stamina: { label: "Stamina", short: "ST", color: "#ad6b5d" },
  tech: { label: "Tech", short: "T", color: "#83a86f" },
  ln: { label: "LN", short: "LN", color: "#57aeba" },
  lnGeneral: { label: "LN General", short: "LNG", color: "#63bf98" },
  lnRelease: { label: "LN Release", short: "LNR", color: "#58b7d9" },
  lnInverse: { label: "LN Inverse", short: "LNI", color: "#7fbed2" },
  lnTech: { label: "LN Tech", short: "LNT", color: "#9f78df" },
  unknown: { label: "Unknown", short: "", color: "#5f596b" },
};

const FALLBACK_COLORS = ["#8c7fb8", "#b88a7f", "#7fb89a", "#b8a87f", "#7f9ab8"];

export function skillPatternMeta(patternId: string, keyCount: number | null): { label: string; short: string; color: string } {
  if (patternId === "handstream" && keyCount != null && keyCount >= 7) {
    return { label: "Bracket", short: "B", color: SKILL_PATTERN_META.handstream.color };
  }
  const meta = SKILL_PATTERN_META[patternId];
  if (meta) return meta;
  let hash = 0;
  for (let i = 0; i < patternId.length; i++) hash = (hash * 31 + patternId.charCodeAt(i)) | 0;
  return {
    label: patternId.charAt(0).toUpperCase() + patternId.slice(1),
    short: patternId.slice(0, 2).toUpperCase(),
    color: FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length],
  };
}

export interface SkillPatternEntry {
  key: string;
  label: string;
  short: string;
  color: string;
  value: number;
}

export function skillPatternEntries(patterns: Record<string, number> | null | undefined, keyCount: number | null = null): SkillPatternEntry[] {
  return Object.entries(patterns ?? {})
    .map(([key, raw]) => {
      const meta = skillPatternMeta(key, keyCount);
      const clamped = Math.max(0, Math.min(1, Number(raw) || 0));
      return { key, label: meta.label, short: meta.short, color: meta.color, value: Math.round(clamped * 100) };
    })
    .filter((entry) => entry.value >= 5)
    .sort((a, b) => b.value - a.value);
}
