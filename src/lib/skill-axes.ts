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

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { MyDataSkillBreakdown, MyDataSkillMode, MyDataSkillPercentile } from "./my-data";

// Every axis carries both forms of its name: `label` is the English one the
// server-side dynamic renders draw (those images stay English, and the
// renderers run outside any i18n instance), `labelMsg` is what DOM consumers
// resolve through `i18n._` so the site's own charts speak the visitor's
// language.
export interface SkillAxisMeta {
  key: string;
  label: string;
  labelMsg: MessageDescriptor;
  color: string;
}

// Etterna's skillset taxonomy (from the MinaCalc analysis), with colors from
// the same palette the old pattern fingerprint used. Shown for every keymode
// except 6K and 7K (usesPatternSkillAxes).
export const MSD_SKILLSET_META: SkillAxisMeta[] = [
  { key: "Stream", label: "Stream", labelMsg: msg`Stream`, color: "#8f6bd8" },
  { key: "Jumpstream", label: "Jumpstream", labelMsg: msg`Jumpstream`, color: "#6f87d8" },
  { key: "Handstream", label: "Handstream", labelMsg: msg`Handstream`, color: "#b06bc0" },
  { key: "Stamina", label: "Stamina", labelMsg: msg`Stamina`, color: "#ad6b5d" },
  { key: "JackSpeed", label: "Jackspeed", labelMsg: msg`Jackspeed`, color: "#c66f84" },
  { key: "Chordjack", label: "Chordjack", labelMsg: msg`Chordjack`, color: "#c59a5c" },
  { key: "Technical", label: "Technical", labelMsg: msg`Technical`, color: "#83a86f" },
];

// 6K and 7K axes come from the in-house pattern detector instead (MinaCalc's
// skillset names mislead there): each value is the aggregate of the
// player's Overall SSRs on charts tagged with that pattern. Family ids only;
// subtypes (speedjack, lnrelease, ...) stay a maps-page concern. No chordjack
// row: the backend's jack tag covers chord jack and single-note jack alike,
// so the tile is Jack (a still-published chordjack rating stays undisplayed).
export const PATTERN_RATING_META: SkillAxisMeta[] = [
  { key: "chordstream", label: "Chordstream", labelMsg: msg`Chordstream`, color: "#5ab2f2" },
  { key: "bracket", label: "Bracket", labelMsg: msg`Bracket`, color: "#f3c24a" },
  { key: "delay", label: "Delay", labelMsg: msg`Delay`, color: "#46c7b8" },
  { key: "stream", label: "Stream", labelMsg: msg`Stream`, color: "#8f6bd8" },
  { key: "jack", label: "Jack", labelMsg: msg`Jack`, color: "#ec6a9c" },
  { key: "tech", label: "Tech", labelMsg: msg`Tech`, color: "#83cf6b" },
  { key: "ln", label: "LN", labelMsg: msg`LN`, color: "#f07474" },
];

// The dan-evidence skillset buckets (the backend's danSkillsetBuckets): the
// four skills each keymode's scene actually names, not the analyzer's 18-id
// pattern vocabulary. Label and color only - which pattern tags fold into
// which bucket is the backend's call, so the two never disagree by drifting
// apart here. Both name forms for the same reason SkillAxisMeta carries them:
// `label` is what English-only readers (the dynamic renders, the admin
// analytics feed) draw, `labelMsg` is what the site resolves per visitor.
export const DAN_SKILLSET_META: Record<string, { label: string; labelMsg: MessageDescriptor; color: string }> = {
  jack: { label: "Jack", labelMsg: msg`Jack`, color: "#ec6a9c" },
  tech: { label: "Tech", labelMsg: msg`Tech`, color: "#83cf6b" },
  speed: { label: "Speed", labelMsg: msg`Speed`, color: "#5ab2f2" },
  stamina: { label: "Stamina", labelMsg: msg`Stamina`, color: "#ad6b5d" },
  stream: { label: "Stream", labelMsg: msg`Stream`, color: "#8f6bd8" },
  ln: { label: "LN", labelMsg: msg`LN`, color: "#f07474" },
  lngeneral: { label: "General", labelMsg: msg`General`, color: "#f07474" },
  lntech: { label: "Tech", labelMsg: msg`Tech`, color: "#83cf6b" },
  lninverse: { label: "Inverse", labelMsg: msg`Inverse`, color: "#c59a5c" },
  lnrelease: { label: "Release", labelMsg: msg`Release`, color: "#46c7b8" },
};

// The aggregate rating, kept out of MSD_SKILLSET_META on purpose: it is not a
// skill to plot next to the others (a radar with an Overall spoke would just
// draw the average of its own arms), but it IS an axis a leaderboard can rank,
// and the one every keymode rates. Neutral color, because it belongs to no
// single skill.
export const OVERALL_AXIS_META: SkillAxisMeta = {
  key: "Overall",
  label: "Overall",
  labelMsg: msg`Overall`,
  color: "#c9cfdd",
};

// Presentation for an axis key that arrived from the backend rather than from a
// player's own breakdown, which is what the /rankings leaderboards get. Keys are
// the wire form: a bare MSD skillset name, or `pattern:{id}`.
export function skillAxisMeta(axis: string): SkillAxisMeta | null {
  if (axis.startsWith("pattern:")) {
    const id = axis.slice("pattern:".length);
    return PATTERN_RATING_META.find((meta) => meta.key === id) ?? null;
  }
  if (axis === OVERALL_AXIS_META.key) return OVERALL_AXIS_META;
  return MSD_SKILLSET_META.find((meta) => meta.key === axis) ?? null;
}

// Drop trickle keymodes (a few stray plays in an off-keymode) so callers only
// offer modes the player meaningfully plays; always keep at least the
// dominant one.
export function qualifyingSkillModes(skills: MyDataSkillBreakdown | null): MyDataSkillMode[] {
  const modes = skills?.modes ?? [];
  const qualifying = modes.filter((mode) => mode.analyzedPlays >= 3);
  return qualifying.length > 0 ? qualifying : modes.slice(0, 1);
}

export interface SkillAxisEntry extends SkillAxisMeta {
  value: number;
  // The percentile lookup key: skillset name for MSD axes, `pattern:{id}` for
  // pattern-derived axes.
  axis: string;
}

// Keymodes whose card speaks the in-house pattern vocabulary. Mirrors the
// backend's PATTERN_AXIS_KEY_COUNTS (player-skills.ts), which decides what
// percentiles and leaderboards publish: 6K and 7K are where the pattern tiles
// were validated, and 8K speaks the same vocabulary; 5K and 9K-18K tried them
// and read as inaccurate, so they show what MinaCalc rates, like 4K.
export function usesPatternSkillAxes(keyCount: number): boolean {
  return keyCount === 6 || keyCount === 7 || keyCount === 8;
}

// 6K/7K/8K speak the in-house pattern vocabulary (falling back to the MSD names
// while tags are missing); every other keymode speaks MinaCalc's skillsets.
export function skillModeEntries(mode: MyDataSkillMode): SkillAxisEntry[] {
  if (usesPatternSkillAxes(mode.keyCount)) {
    const byId = new Map((mode.patterns ?? []).map((entry) => [entry.id, entry.rating]));
    const patternEntries = PATTERN_RATING_META
      .map((meta) => ({ ...meta, value: Number(byId.get(meta.key) ?? 0), axis: `pattern:${meta.key}` }))
      .filter((entry) => entry.value >= 1)
      .sort((a, b) => b.value - a.value);
    if (patternEntries.length > 0) return patternEntries;
  }
  const entries: SkillAxisEntry[] = MSD_SKILLSET_META
    .map((meta) => ({ ...meta, value: Number(mode.ratings[meta.key] ?? 0), axis: meta.key }))
    // The generic n-key calc engine returns ~0 for skillsets it does not
    // rate; a 0.15 sliver next to 20+ bars is noise, not signal.
    .filter((entry) => entry.value >= 1);
  // Etterna's taxonomy has no LN skillset, so the MSD card grafts in the LN
  // pattern axis (same rating scale: Overall SSRs on LN-tagged charts).
  const ln = (mode.patterns ?? []).find((entry) => entry.id === "ln");
  if (ln && ln.rating >= 1) entries.push({ key: "ln", label: "LN", labelMsg: msg`LN`, color: "#f07474", value: ln.rating, axis: "pattern:ln" });
  return entries.sort((a, b) => b.value - a.value);
}

// 4K only: the LN validation run (scripts/ln-axis/results-2026-08-24.md) found
// the 4K LN percentile tracks how much LN a player plays, not a separable
// skill, so the bar gets its honest companion number: the share of the rated
// pool that is LN charts (the backend tags ln only where the analyzer's
// verdict does). The 7K axis passed the same test and stays unannotated.
export function lnPlayShare(mode: MyDataSkillMode): number | null {
  if (mode.keyCount !== 4) return null;
  const ln = (mode.patterns ?? []).find((entry) => entry.id === "ln");
  if (!ln || !(ln.plays > 0) || !(mode.analyzedPlays > 0)) return null;
  return Math.min(1, ln.plays / mode.analyzedPlays);
}

export function skillRatingAccent(mode: MyDataSkillMode | null): string {
  if (!mode) return "#8f6bd8";
  return skillModeEntries(mode)[0]?.color ?? "#8f6bd8";
}

// The share as a display string, no rounding floor: the top of a 12k-player
// population is a hundredth of a percent, and clamping it to "top 1%" told the
// best player in the database the same thing it told the 120th. Decimals grow
// as the share shrinks, and the share never claims to be finer than one player
// out of the ranked population - the backend measures the tail by exact rank
// (skill-baseline.ts axisPercentile), so 0.008 there means rank 1 of 12,371.
export function topSharePercent(percentile: MyDataSkillPercentile): string {
  // With no population to divide by there is nothing finer to claim, so an
  // unranked payload keeps the old conservative floor of one percent.
  const floor = percentile.population > 0 ? 100 / percentile.population : 1;
  const share = Math.max(100 - percentile.value, floor);
  const digits = share >= 0.95 ? 0 : share >= 0.095 ? 1 : share >= 0.0095 ? 2 : 3;
  return share.toFixed(digits);
}

// English form, for the dynamic-render images. DOM callers phrase it through
// the catalog instead (`t`top ${topSharePercent(p)}%``).
export function formatTopShare(percentile: MyDataSkillPercentile): string {
  return `top ${topSharePercent(percentile)}%`;
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
