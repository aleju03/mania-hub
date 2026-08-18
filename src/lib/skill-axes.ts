// Axis metadata, entry selection and radar geometry for the Etterna-style
// skill ratings.
//
// These are pure and shared by three consumers: the My Data "Skill rating"
// card, the public profile Skills tab, and the server-side dynamic-render
// images. They used to live in SkillBreakdown.tsx, which imports framer-motion
// and the auth context and so cannot be reached from a render path. Keeping
// them here is what stops the embedded radar from drifting away from the one
// on the site.
//
// Colors are per-skill site identity and stay decorative: identity is always
// carried by the text label on the mark.

import type { MyDataSkillBreakdown, MyDataSkillMode } from "./my-data";

// Etterna's skillset taxonomy (from the MinaCalc analysis), with colors from
// the same palette the old pattern fingerprint used. Native for 4K only.
export const MSD_SKILLSET_META: Array<{ key: string; label: string; color: string }> = [
  { key: "Stream", label: "Stream", color: "#8f6bd8" },
  { key: "Jumpstream", label: "Jumpstream", color: "#6f87d8" },
  { key: "Handstream", label: "Handstream", color: "#b06bc0" },
  { key: "Stamina", label: "Stamina", color: "#ad6b5d" },
  { key: "JackSpeed", label: "Jackspeed", color: "#c66f84" },
  { key: "Chordjack", label: "Chordjack", color: "#c59a5c" },
  { key: "Technical", label: "Technical", color: "#83a86f" },
];

// Non-4K axes come from the in-house pattern detector instead (MinaCalc's
// skillset names are 4K vocabulary): each value is the aggregate of the
// player's Overall SSRs on charts tagged with that pattern. Family ids only;
// subtypes (speedjack, lnrelease, ...) stay a maps-page concern.
export const PATTERN_RATING_META: Array<{ key: string; label: string; color: string }> = [
  { key: "chordstream", label: "Chordstream", color: "#5ab2f2" },
  { key: "bracket", label: "Bracket", color: "#f3c24a" },
  { key: "delay", label: "Delay", color: "#46c7b8" },
  { key: "stream", label: "Stream", color: "#8f6bd8" },
  { key: "jack", label: "Jack", color: "#ec6a9c" },
  { key: "chordjack", label: "Chordjack", color: "#c59a5c" },
  { key: "tech", label: "Tech", color: "#83cf6b" },
  { key: "ln", label: "LN", color: "#f07474" },
];

// Drop trickle keymodes (a few stray plays in an off-keymode) so callers only
// offer modes the player meaningfully plays; always keep at least the
// dominant one.
export function qualifyingSkillModes(skills: MyDataSkillBreakdown | null): MyDataSkillMode[] {
  const modes = skills?.modes ?? [];
  const qualifying = modes.filter((mode) => mode.analyzedPlays >= 3);
  return qualifying.length > 0 ? qualifying : modes.slice(0, 1);
}

export interface SkillAxisEntry {
  key: string;
  label: string;
  color: string;
  value: number;
  // The percentile lookup key: skillset name for MSD axes, `pattern:{id}` for
  // pattern-derived axes.
  axis: string;
}

// 4K speaks MinaCalc's native skillsets; other keymodes speak the in-house
// pattern vocabulary (falling back to the MSD names while tags are missing).
export function skillModeEntries(mode: MyDataSkillMode): SkillAxisEntry[] {
  if (mode.keyCount !== 4) {
    const byId = new Map((mode.patterns ?? []).map((entry) => [entry.id, entry.rating]));
    const patternEntries = PATTERN_RATING_META
      .map((meta) => ({ ...meta, value: Number(byId.get(meta.key) ?? 0), axis: `pattern:${meta.key}` }))
      .filter((entry) => entry.value >= 1)
      .sort((a, b) => b.value - a.value);
    if (patternEntries.length > 0) return patternEntries;
  }
  const entries: SkillAxisEntry[] = MSD_SKILLSET_META
    .map((meta) => ({ ...meta, value: Number(mode.ratings[meta.key] ?? 0), axis: meta.key }))
    // The 6K/7K calc engine returns ~0 for skillsets it does not rate
    // (Technical); a 0.15 sliver next to 20+ bars is noise, not signal.
    .filter((entry) => entry.value >= 1);
  // Etterna's taxonomy has no LN skillset, so the 4K card grafts in the LN
  // pattern axis (same rating scale: Overall SSRs on LN-tagged charts).
  const ln = (mode.patterns ?? []).find((entry) => entry.id === "ln");
  if (ln && ln.rating >= 1) entries.push({ key: "ln", label: "LN", color: "#f07474", value: ln.rating, axis: "pattern:ln" });
  return entries.sort((a, b) => b.value - a.value);
}

export function skillRatingAccent(mode: MyDataSkillMode | null): string {
  if (!mode) return "#8f6bd8";
  return skillModeEntries(mode)[0]?.color ?? "#8f6bd8";
}

export function formatTopShare(percentile: number): string {
  const top = Math.max(1, Math.round(100 - percentile));
  return `top ${top}%`;
}

// --- Radar geometry ---

export interface RadarGeometry {
  width: number;
  height: number;
  cx: number;
  cy: number;
  maxR: number;
  labelR: number;
}

export const RADAR_RINGS = [0.25, 0.5, 0.75, 1];

export function radarGeometry(input: { width: number; height: number; maxR: number; labelR: number }): RadarGeometry {
  return { ...input, cx: input.width / 2, cy: input.height / 2 };
}

/* The profile Skills tab preset. Wider than tall: the horizontal margin is
   what keeps long side labels ("Chordstream") inside the viewBox instead of
   clipping at the edge. */
export const SKILL_RADAR_PROFILE = radarGeometry({ width: 344, height: 252, maxR: 84, labelR: 100 });

export interface RadarPoint {
  entry: SkillAxisEntry;
  x: number;
  y: number;
  labelX: number;
  labelY: number;
  angle: number;
}

export function radarPoints(entries: SkillAxisEntry[], max: number, geo: RadarGeometry): RadarPoint[] {
  return entries.map((entry, index) => {
    const angle = -Math.PI / 2 + (index / entries.length) * Math.PI * 2;
    const r = Math.max(0.06, entry.value / max) * geo.maxR;
    return {
      entry,
      angle,
      x: geo.cx + Math.cos(angle) * r,
      y: geo.cy + Math.sin(angle) * r,
      labelX: geo.cx + Math.cos(angle) * geo.labelR,
      labelY: geo.cy + Math.sin(angle) * geo.labelR,
    };
  });
}

export function ringPolygon(count: number, fraction: number, geo: RadarGeometry): string {
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
    const r = fraction * geo.maxR;
    return `${geo.cx + Math.cos(angle) * r},${geo.cy + Math.sin(angle) * r}`;
  }).join(" ");
}

export function radarAnchor(angle: number): "start" | "middle" | "end" {
  const cos = Math.cos(angle);
  if (cos > 0.35) return "start";
  if (cos < -0.35) return "end";
  return "middle";
}

// Vertical alignment via dy, not dominant-baseline (which headless/older
// renderers drop for hanging text): above the point for north labels, below
// for south, centered for the sides.
export function radarLabelDy(angle: number): number {
  const sin = Math.sin(angle);
  if (sin < -0.35) return -2;
  if (sin > 0.35) return 9;
  return 3.5;
}
