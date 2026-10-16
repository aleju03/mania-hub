import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { MOD_BADGE_FILE_NAMES, MOD_BADGE_TYPE_COLORS } from "#/components/ui/ModBadge";
import { starRatingColor } from "#/components/ui/StarRating";
import type { ModDisplay } from "#/lib/score";
import type { ReplayHitEvent } from "#/lib/replay-types";

// osu!lazer's results screen (osu.Game/Screens/Ranking), drawn in its own
// 1024x768 virtual space and scaled the way the game's ScalingContainer
// scales every screen. Sizes, colours, easings and timings are lazer's.

export type LazerRank = "XH" | "X" | "SH" | "S" | "A" | "B" | "C" | "D" | "F";

export interface LazerResultsScore {
  key: string;
  /** Standardised total score, as lazer shows it. */
  totalScore: number;
  /** 0 to 1. */
  accuracy: number;
  rank: LazerRank;
  maxCombo: number;
  maxAchievableCombo: number | null;
  pp: number | null;
  /** Unranked map, unranked mods or a fail: lazer greys the pp out. */
  ppDimmed?: boolean;
  statistics: { perfect: number; great: number; good: number; ok: number; meh: number; miss: number };
  mods: ModDisplay[];
  playedAt: string | null;
  user: { name: string; avatarUrl?: string; coverUrl?: string };
  /** Leaderboard position, shown over a contracted panel. */
  position?: number | null;
  /** Judged hits, for the statistics panel; only a watched replay has them. */
  hitEvents?: ReplayHitEvent[] | null;
  /** The mods' playback rate; unstable rate is measured in real time. */
  rate?: number;
  /** SS pp with these mods, for the performance breakdown. */
  maxPp?: number | null;
  hasReplay?: boolean;
}

export interface LazerResultsBeatmap {
  title: string;
  artist: string;
  version: string;
  creator: string;
  stars: number | null;
  beatmapUrl?: string | null;
  beatmapsetUrl?: string | null;
}

const RANK_VALUE: Record<LazerRank, number> = { F: -1, D: 0, C: 1, B: 2, A: 3, S: 4, SH: 5, X: 6, XH: 7 };

export function normalizeLazerRank(rank: string | null | undefined): LazerRank {
  switch ((rank ?? "").toUpperCase()) {
    case "XH": case "SSH": return "XH";
    case "X": case "SS": return "X";
    case "SH": return "SH";
    case "S": return "S";
    case "A": return "A";
    case "B": return "B";
    case "C": return "C";
    case "D": return "D";
    default: return "F";
  }
}

/** ManiaScoreProcessor.RankFromScore plus the HD/FL/FI silver ranks. */
export function lazerManiaRank(accuracy: number, statistics: LazerResultsScore["statistics"], silver: boolean): LazerRank {
  let rank: LazerRank;
  if (accuracy >= 1) rank = "X";
  else if (accuracy >= 0.95) rank = "S";
  else if (accuracy >= 0.9) rank = "A";
  else if (accuracy >= 0.8) rank = "B";
  else if (accuracy >= 0.7) rank = "C";
  else rank = "D";
  if (rank === "S" && statistics.good + statistics.ok + statistics.meh + statistics.miss === 0) rank = "X";
  if (silver && rank === "S") return "SH";
  if (silver && rank === "X") return "XH";
  return rank;
}

// ── easing (osu-framework Interpolation.ApplyEasing) ──────────────────────

type Ease = (t: number) => number;
const linear: Ease = (t) => t;
const inQuad: Ease = (t) => t * t;
const outQuad: Ease = (t) => 1 - (1 - t) * (1 - t);
const outQuint: Ease = (t) => 1 - (1 - t) ** 5;
const outPow10: Ease = (t) => 1 - (1 - t) ** 10;
const outSine: Ease = (t) => Math.sin((t * Math.PI) / 2);
const outBounce: Ease = (t) => {
  if (t < 1 / 2.75) return 7.5625 * t * t;
  if (t < 2 / 2.75) { t -= 1.5 / 2.75; return 7.5625 * t * t + 0.75; }
  if (t < 2.5 / 2.75) { t -= 2.25 / 2.75; return 7.5625 * t * t + 0.9375; }
  t -= 2.625 / 2.75;
  return 7.5625 * t * t + 0.984375;
};
const outElastic: Ease = (t) => 2 ** (-10 * t) * Math.sin((t - 0.075) * ((2 * Math.PI) / 0.3)) + 1;
const outElasticQuarter: Ease = (t) => 2 ** (-10 * t) * Math.sin((0.25 * t - 0.075) * ((2 * Math.PI) / 0.3)) + 1;

function tween(now: number, start: number, duration: number, from: number, to: number, ease: Ease): number {
  if (now <= start) return from;
  if (duration <= 0 || now >= start + duration) return to;
  return from + (to - from) * ease((now - start) / duration);
}

/** A CSS linear() curve sampled from an osu easing, for hover transitions. */
function cssEasing(ease: Ease, steps = 40): string {
  const points: string[] = [];
  for (let i = 0; i <= steps; i++) points.push(ease(i / steps).toFixed(4));
  return `linear(${points.join(", ")})`;
}
const CSS_OUT_ELASTIC = cssEasing(outElastic);
const CSS_OUT_QUINT = "cubic-bezier(0.22, 1, 0.36, 1)";

// ── colours (OsuColour) ───────────────────────────────────────────────────

function rankColour(rank: LazerRank): string {
  switch (rank) {
    case "XH": case "X": return "#de31ae";
    case "SH": case "S": return "#02b5c3";
    case "A": return "#88da20";
    case "B": return "#e3b130";
    case "C": return "#ff8e5d";
    case "D": return "#ff5a5a";
    default: return "#3f3f3f";
  }
}

function rankLetterStyle(rank: LazerRank): CSSProperties {
  const gradient = (top: string, bottom: string): CSSProperties => ({
    backgroundImage: `linear-gradient(to bottom, ${top}, ${bottom})`,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent",
  });
  switch (rank) {
    case "XH": case "SH": return gradient("#ffffff", "#afdff0");
    case "X": case "S": return gradient("#ffe7a8", "#ffb800");
    case "A": return { color: "#275227" };
    case "B": return { color: "#553a2b" };
    case "C": return { color: "#473625" };
    case "D": return { color: "#512525" };
    default: return { color: "#cc3333" };
  }
}

function rankLetter(rank: LazerRank): string {
  if (rank === "SH") return "S";
  if (rank === "X" || rank === "XH") return "SS";
  return rank;
}

const HIT_RESULTS = [
  { key: "perfect", label: "Perfect", colour: "#99eeff" },
  { key: "great", label: "Great", colour: "#66ccff" },
  { key: "good", label: "Good", colour: "#b3d944" },
  { key: "ok", label: "OK", colour: "#88b300" },
  { key: "meh", label: "Meh", colour: "#ffcc22" },
  { key: "miss", label: "Miss", colour: "#ed1121" },
] as const;

// ── layout constants (ScorePanel, ScorePanelList, AccuracyCircle) ─────────

/** The expanded panel plus a little margin: the narrowest the screen gets. */
const NARROW_MIN_W = 400;
const VIRTUAL_H = 768;
const BOTTOM_BAR_H = 50;
const CONTRACTED_W = 130;
const CONTRACTED_H = 385;
const EXPANDED_W = 360;
const EXPANDED_H = 586;
const EXPANDED_TOP_LAYER_H = 53;
const CONTRACTED_TOP_LAYER_H = 30;
const VERTICAL_FUDGE = 20;
const RESIZE_DURATION = 200;
const TOP_LAYER_EXPAND_DELAY = 100;
const TOP_LAYER_EXPAND_DURATION = 200;
const CONTENT_FADE_DURATION = 50;
const PANEL_SPACING = 5;
const EXPANDED_PANEL_SPACING = 15;

const APPEAR_DURATION = 200;
const ACCURACY_TRANSFORM_DELAY = 450;
const ACCURACY_TRANSFORM_DURATION = 3000;
const TEXT_APPEAR_DELAY = ACCURACY_TRANSFORM_DURATION / 2;
const RANK_CIRCLE_TRANSFORM_DELAY = 150;
const RANK_CIRCLE_TRANSFORM_DURATION = 800;
const RANK_CIRCLE_RADIUS = 0.05;
const ACCURACY_CIRCLE_RADIUS = 0.2;
const VIRTUAL_SS_PERCENTAGE = 0.01;
const GRADE_SPACING_PERCENTAGE = 2 / 360;
const ACCURACY_TOTAL_DURATION = APPEAR_DURATION + ACCURACY_TRANSFORM_DELAY + ACCURACY_TRANSFORM_DURATION;

const ACC_X = 1;
const ACC_S = 0.95;
const ACC_A = 0.9;
const ACC_B = 0.8;
const ACC_C = 0.7;
const ACC_D = 0;

const TORUS = "Torus, sans-serif";
// osu! sizes a font by its full line height, Torus's ascent plus descent
// (1.2 em): a SpriteText of size N draws at N / 1.2 CSS px in a box N tall.
const TORUS_LINE = 1.2;
const VENERA = "Venera, sans-serif";
// Torus weights as the site's @font-face maps them.
const W_LIGHT = 300;
const W_REGULAR = 400;
const W_SEMIBOLD = 600;
const W_BOLD = 800;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function torus(size: number, weight: number): CSSProperties {
  return { fontFamily: TORUS, fontSize: size / TORUS_LINE, lineHeight: TORUS_LINE, fontWeight: weight };
}

/** Where the gauge stops: AccuracyCircle.LoadComplete's notch and SS nudges. */
function gaugeTarget(score: LazerResultsScore): number {
  let target = score.accuracy;
  for (const notch of [ACC_S, ACC_A, ACC_B, ACC_C]) {
    if (Math.abs(notch - target) <= GRADE_SPACING_PERCENTAGE / 2) {
      target = notch + (target - notch >= 0 ? 1 : -1) * (GRADE_SPACING_PERCENTAGE / 2);
      break;
    }
  }
  if (score.rank === "X" || score.rank === "XH") target = 1;
  else target = Math.min(ACC_X - VIRTUAL_SS_PERCENTAGE - GRADE_SPACING_PERCENTAGE / 2, target);
  const visualAlignmentOffset = 0.001;
  if (target < 1 && target >= visualAlignmentOffset) target -= visualAlignmentOffset;
  return target;
}

interface Badge { rank: LazerRank; accuracy: number; position: number }

function badgesFor(score: LazerResultsScore): Badge[] {
  const silver = score.rank === "SH" || score.rank === "XH";
  return [
    { rank: "D", accuracy: ACC_D, position: lerp(ACC_D, ACC_C, 0.5) },
    { rank: "C", accuracy: ACC_C, position: lerp(ACC_C, ACC_B, 0.5) },
    { rank: "B", accuracy: ACC_B, position: lerp(ACC_B, ACC_A, 0.5) },
    { rank: "A", accuracy: ACC_A, position: lerp(ACC_A, ACC_S, 0.25) },
    { rank: silver ? "SH" : "S", accuracy: ACC_S, position: lerp(ACC_S, ACC_X - VIRTUAL_SS_PERCENTAGE, 0.25) },
    { rank: silver ? "XH" : "X", accuracy: ACC_X, position: ACC_X },
  ];
}

/** When each shown badge lights up, ms after the panel's content appeared. */
function badgeTimes(score: LazerResultsScore): Array<number | null> {
  const target = gaugeTarget(score);
  return badgesFor(score).map((badge) => {
    if (score.rank === "F" || RANK_VALUE[badge.rank] > RANK_VALUE[score.rank]) return null;
    // inverseEasing(OutPow10, v): the gauge passes the badge's accuracy here.
    const v = Math.min(1, Math.min(ACC_X - VIRTUAL_SS_PERCENTAGE, badge.accuracy) / target);
    return ACCURACY_TRANSFORM_DELAY + (1 - (1 - v) ** 0.1) * ACCURACY_TRANSFORM_DURATION;
  });
}

// ── sounds (osu-resources Samples/Results) ────────────────────────────────

const SAMPLE_NAMES = [
  "badge-dink", "badge-dink-max",
  "rank-impact-fail", "rank-impact-fail-d", "rank-impact-pass", "rank-impact-pass-ss",
  "score-panel-focus", "score-panel-top-appear", "score-tick", "swoosh-up",
  "statistics-panel-pop-in", "statistics-panel-pop-out",
] as const;
type SampleName = (typeof SAMPLE_NAMES)[number];

let sfxContext: AudioContext | null = null;
let sfxBuffers: Promise<Map<SampleName, AudioBuffer>> | null = null;

function getSfxContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!sfxContext) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    sfxContext = new Ctor();
  }
  return sfxContext;
}

/** Fetches and decodes the results samples once; safe to call early. */
export function preloadLazerResultsSounds(): void {
  const ctx = getSfxContext();
  if (!ctx || sfxBuffers) return;
  sfxBuffers = Promise.all(SAMPLE_NAMES.map(async (name) => {
    try {
      const response = await fetch(`/audio/results/${name}.mp3`);
      if (!response.ok) return null;
      const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
      return [name, buffer] as const;
    } catch {
      return null;
    }
  })).then((entries) => new Map(entries.filter((entry): entry is readonly [SampleName, AudioBuffer] => entry !== null)));
}

class ResultsSfx {
  private buffers: Map<SampleName, AudioBuffer> | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  constructor(private volume: () => number) {
    preloadLazerResultsSounds();
    void sfxBuffers?.then((buffers) => { this.buffers = buffers; });
    void sfxContext?.resume().catch(() => {});
  }

  play(name: SampleName, { gain = 1, rate = 1 }: { gain?: number; rate?: number } = {}) {
    const ctx = sfxContext;
    const buffer = this.buffers?.get(name);
    const volume = this.volume() * gain;
    if (!ctx || !buffer || volume <= 0) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const node = ctx.createGain();
    node.gain.value = volume;
    source.connect(node).connect(ctx.destination);
    source.onended = () => this.sources.delete(source);
    this.sources.add(source);
    source.start();
  }

  stopAll() {
    for (const source of this.sources) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.sources.clear();
  }
}

function impactSample(rank: LazerRank): SampleName {
  switch (rank) {
    case "C": case "B": return "rank-impact-fail";
    case "A": case "S": case "SH": return "rank-impact-pass";
    case "X": case "XH": return "rank-impact-pass-ss";
    default: return "rank-impact-fail-d";
  }
}

// ── formatting ────────────────────────────────────────────────────────────

const formatInteger = (value: number) => Math.round(value).toLocaleString("en-US");

/** FormatAccuracy: floored to two decimals. */
function formatAccuracy(accuracy: number): string {
  return `${(Math.floor(accuracy * 10000 + 1e-6) / 100).toFixed(2)}%`;
}

/** "15 October 2026 11:40 AM", PlayedOnText's 12-hour form. */
function formatPlayedOn(iso: string): string | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long", year: "numeric" }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).format(date);
  return `${part("day")} ${part("month")} ${part("year")} ${time}`;
}

const measureCanvas = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
const glyphWidths = new Map<string, number>();

/** Width of "0" in a font: the cell fixed-width digits share. */
function fixedGlyphWidth(size: number, weight: number, family: string): number {
  const key = `${weight} ${size}px ${family}`;
  const cached = glyphWidths.get(key);
  if (cached != null) return cached;
  if (!measureCanvas) return size * 0.6;
  measureCanvas.font = key;
  const width = measureCanvas.measureText("0").width;
  if (typeof document !== "undefined" && document.fonts?.status === "loaded") glyphWidths.set(key, width);
  return width;
}

/** A SpriteText with fixedWidth: digits centred in "0"-wide cells so a
 *  rolling counter does not jitter; separators keep their own width. */
function FixedWidthText({ text, size, weight, spacing = 0, style }: { text: string; size: number; weight: number; spacing?: number; style?: CSSProperties }) {
  const cell = fixedGlyphWidth(size / TORUS_LINE, weight, TORUS);
  const chars = Array.from(text);
  return (
    <span style={{ display: "inline-flex", ...torus(size, weight), whiteSpace: "pre", ...style }}>
      {chars.map((char, i) => (
        <span key={i} style={{ display: "inline-block", width: /\d/.test(char) ? cell : undefined, marginRight: i < chars.length - 1 ? spacing : 0, textAlign: "center" }}>{char}</span>
      ))}
    </span>
  );
}

// ── small drawables ───────────────────────────────────────────────────────

/** DrawableRank: the rank pill, 2:1, drawn at 64x32 and scaled to fit. */
function DrawableRank({ rank, width, height }: { rank: LazerRank; width: number; height: number }) {
  const h = Math.min(height, width / 2);
  const w = h * 2;
  const scale = h / 32;
  return (
    <span
      style={{
        position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: w, height: h, borderRadius: h / 2, background: rankColour(rank), overflow: "hidden", flexShrink: 0,
      }}
    >
      <span
        style={{
          fontFamily: VENERA, fontSize: 25 * scale, lineHeight: 1, letterSpacing: -3 * scale, paddingTop: 5 * scale,
          filter: `drop-shadow(0 ${0.08 * 25 * scale}px 0 rgba(0,0,0,0.3))`,
          ...rankLetterStyle(rank),
        }}
      >
        {rankLetter(rank)}
      </span>
    </span>
  );
}

/** StarRatingDisplay (Regular): star pill in the spectrum colour. */
function StarRatingPill({ stars }: { stars: number }) {
  const text = stars >= 6.5 ? "#ffd966" : "rgba(0,0,0,0.75)";
  return (
    <span style={{ display: "inline-grid", gridTemplateColumns: "auto 3px auto", alignItems: "center", borderRadius: 999, background: starRatingColor(stars), padding: "2px 8px", color: text }}>
      <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 8, height: 8 }}>
        <FaIcon path={FA_STAR} viewBox="0 0 576 512" size={8} />
      </span>
      <span />
      <span style={{ minWidth: 25, display: "flex", justifyContent: "center", marginBottom: 1.5 }}>
        <FixedWidthText text={stars.toFixed(2)} size={14.4} weight={W_BOLD} spacing={-1.4} />
      </span>
    </span>
  );
}

const FA_STAR = "M316.9 18C311.6 7 300.4 0 288.1 0s-23.4 7-28.8 18L195 150.3 51.4 171.5c-12 1.8-22 10.2-25.7 21.7s-.7 24.2 7.9 32.7L137.8 329 113.2 474.7c-2 12 3 24.2 12.9 31.3s23 8 33.8 2.3l128.3-68.5 128.3 68.5c10.8 5.7 23.9 4.9 33.8-2.3s14.9-19.3 12.9-31.3L438.5 329 542.7 225.9c8.6-8.5 11.7-21.2 7.9-32.7s-13.7-19.9-25.7-21.7L381.2 150.3 316.9 18z";
const FA_COG = "M495.9 166.6c3.2 8.7 .5 18.4-6.4 24.6l-43.3 39.4c1.1 8.3 1.7 16.8 1.7 25.4s-.6 17.1-1.7 25.4l43.3 39.4c6.9 6.2 9.6 15.9 6.4 24.6c-4.4 11.9-9.7 23.3-15.8 34.3l-4.7 8.1c-6.6 11-14 21.4-22.1 31.2c-5.9 7.2-15.7 9.6-24.5 6.8l-55.7-17.7c-13.4 10.3-28.2 18.9-44 25.4l-12.5 57.1c-2 9.1-9 16.3-18.2 17.8c-13.8 2.3-28 3.5-42.5 3.5s-28.7-1.2-42.5-3.5c-9.2-1.5-16.2-8.7-18.2-17.8l-12.5-57.1c-15.8-6.5-30.6-15.1-44-25.4L83.1 425.9c-8.8 2.8-18.6 .3-24.5-6.8c-8.1-9.8-15.5-20.2-22.1-31.2l-4.7-8.1c-6.1-11-11.4-22.4-15.8-34.3c-3.2-8.7-.5-18.4 6.4-24.6l43.3-39.4C64.6 273.1 64 264.6 64 256s.6-17.1 1.7-25.4L22.4 191.2c-6.9-6.2-9.6-15.9-6.4-24.6c4.4-11.9 9.7-23.3 15.8-34.3l4.7-8.1c6.6-11 14-21.4 22.1-31.2c5.9-7.2 15.7-9.6 24.5-6.8l55.7 17.7c13.4-10.3 28.2-18.9 44-25.4l12.5-57.1c2-9.1 9-16.3 18.2-17.8C227.3 1.2 241.5 0 256 0s28.7 1.2 42.5 3.5c9.2 1.5 16.2 8.7 18.2 17.8l12.5 57.1c15.8 6.5 30.6 15.1 44 25.4l55.7-17.7c8.8-2.8 18.6-.3 24.5 6.8c8.1 9.8 15.5 20.2 22.1 31.2l4.7 8.1c6.1 11 11.4 22.4 15.8 34.3zM256 336a80 80 0 1 0 0-160 80 80 0 1 0 0 160z";

/** A FontAwesome glyph scaled to fit its box, as SpriteIcon draws it. */
function FaIcon({ path, viewBox, size, colour = "currentColor" }: { path: string; viewBox: string; size: number; colour?: string }) {
  return (
    <svg viewBox={viewBox} width={size} height={size} fill={colour} preserveAspectRatio="xMidYMid meet" aria-hidden="true" style={{ display: "block" }}>
      <path d={path} />
    </svg>
  );
}

const MOD_ICON = 80;
/** ModIcon textures from osu-resources, tinted like a Sprite's Colour. */
function tintedTexture(url: string, colour: string): CSSProperties {
  return {
    backgroundImage: `url(${url})`, backgroundColor: colour, backgroundBlendMode: "multiply",
    backgroundSize: "contain", backgroundRepeat: "no-repeat", backgroundPosition: "center",
    maskImage: `url(${url})`, WebkitMaskImage: `url(${url})`, maskSize: "contain", WebkitMaskSize: "contain",
    maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat", maskPosition: "center", WebkitMaskPosition: "center",
  };
}

/** ModIcon (osu.Game/Rulesets/UI): the hexagon, its extender with the rate,
 *  and the cog marking non-default settings, at the given scale. */
function LazerModIcon({ mod, scale }: { mod: ModDisplay; scale: number }) {
  const colour = MOD_BADGE_TYPE_COLORS[mod.acronym] ?? "#ff6666";
  const dark = `color-mix(in srgb-linear, black, ${colour} 10%)`;
  const file = MOD_BADGE_FILE_NAMES[mod.acronym];
  const extended = mod.rate != null ? `${mod.rate.toFixed(2)}x` : null;
  const mask = (url: string): CSSProperties => ({
    backgroundColor: dark, maskImage: `url(${url})`, WebkitMaskImage: `url(${url})`, maskSize: "contain", WebkitMaskSize: "contain",
    maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat", maskPosition: "center", WebkitMaskPosition: "center",
  });
  return (
    <span title={[mod.acronym, extended].filter(Boolean).join(" ")} style={{ position: "relative", display: "inline-block", flexShrink: 0, width: (extended ? MOD_ICON - 22 + 116 : MOD_ICON) * scale, height: MOD_ICON * scale }}>
      <span style={{ position: "absolute", left: 0, top: 0, width: (extended ? MOD_ICON - 22 + 116 : MOD_ICON), height: MOD_ICON, transform: `scale(${scale})`, transformOrigin: "top left" }}>
        {extended && (
          <span style={{ position: "absolute", left: MOD_ICON - 22, top: 0, width: 116, height: MOD_ICON }}>
            <span style={{ position: "absolute", inset: 0, ...tintedTexture("/images/lazer-results/mod-icon-extender.png", `color-mix(in srgb, black, ${colour} 26.3%)`) }} />
            <span style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(calc(-50% + 6px), -50%)", ...torus(34, W_BOLD), color: colour, whiteSpace: "nowrap" }}>{extended}</span>
          </span>
        )}
        <span style={{ position: "absolute", left: 0, top: 0, width: MOD_ICON, height: MOD_ICON }}>
          <span style={{ position: "absolute", inset: 0, ...tintedTexture("/images/lazer-results/mod-icon.png", colour) }} />
          {file ? (
            <span style={{ position: "absolute", left: "50%", top: "50%", width: (131 / 135) * MOD_ICON, height: (92 / 135) * MOD_ICON, transform: "translate(-50%, -50%)", ...mask(`/images/badges/mods/mod-${file}.svg`) }} />
          ) : (
            <span style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", fontFamily: VENERA, fontSize: 22, lineHeight: 1, color: dark }}>{mod.acronym}</span>
          )}
          {extended && (
            <span style={{ position: "absolute", left: 64 - 10, top: 14 - 10, width: 20, height: 20 }}>
              <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: dark }} />
              <span style={{ position: "absolute", inset: 4, display: "flex" }}><FaIcon path={FA_COG} viewBox="0 0 512 512" size={12} colour={colour} /></span>
            </span>
          )}
        </span>
      </span>
    </span>
  );
}

/** DifficultyIcon: a disc in the difficulty colour under the white mania
 *  ruleset glyph. */
function DifficultyIcon({ stars, size }: { stars: number | null; size: number }) {
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center", width: size, height: size, flexShrink: 0 }}>
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: stars != null ? starRatingColor(stars) : "#666", boxShadow: "0 0 3px rgba(0,0,0,0.06)" }} />
      <span className="mode-icon" style={{ position: "relative", fontSize: size, lineHeight: 1, color: "#fff" }}>{"\ue802"}</span>
    </span>
  );
}

function Avatar({ url, size, radius, shadow }: { url?: string; size: number; radius: number; shadow?: string }) {
  return (
    <span style={{ display: "block", width: size, height: size, borderRadius: radius, overflow: "hidden", background: "#2f2f2f", boxShadow: shadow, flexShrink: 0 }}>
      {url && <img src={url} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
    </span>
  );
}

/** CoverBackground tinted White(0.5) to #444(0), top to bottom. */
function CoverBackground({ url }: { url?: string }) {
  if (!url) return null;
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      style={{
        position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none",
        maskImage: "linear-gradient(to bottom, rgba(0,0,0,0.5), rgba(0,0,0,0))",
        WebkitMaskImage: "linear-gradient(to bottom, rgba(0,0,0,0.5), rgba(0,0,0,0))",
      }}
    />
  );
}

// ── accuracy circle ───────────────────────────────────────────────────────

function Arc({ size, radius, thickness, progress, rotation = 0, stroke, opacity = 1 }: { size: number; radius: number; thickness: number; progress: number; rotation?: number; stroke: string; opacity?: number }) {
  if (progress <= 0) return null;
  const r = radius - thickness / 2;
  const circumference = 2 * Math.PI * r;
  const c = size / 2;
  return (
    <circle
      cx={c} cy={c} r={r} fill="none" stroke={stroke} strokeWidth={thickness} opacity={opacity}
      strokeDasharray={progress >= 1 ? undefined : `${progress * circumference} ${circumference}`}
      transform={`rotate(${-90 + rotation * 360} ${c} ${c})`}
    />
  );
}

function AccuracyCircle({ score, e }: { score: LazerResultsScore; e: number }) {
  const size = 230;
  const target = gaugeTarget(score);
  const accuracyProgress = tween(e, ACCURACY_TRANSFORM_DELAY, ACCURACY_TRANSFORM_DURATION, 0, target, outPow10);
  const reveal = tween(e, RANK_CIRCLE_TRANSFORM_DELAY, RANK_CIRCLE_TRANSFORM_DURATION, 0, 1, outPow10);
  const scale = tween(e, 0, APPEAR_DURATION, 0, 1, outQuint);
  const badges = badgesFor(score);
  const times = badgeTimes(score);
  const gradedRadius = (size * 0.8 - 5) / 2;
  const segments: Array<[number, number, LazerRank]> = [
    [0, ACC_C, "D"], [ACC_C, ACC_B, "C"], [ACC_B, ACC_A, "B"], [ACC_A, ACC_S, "A"],
    [ACC_S, ACC_X - VIRTUAL_SS_PERCENTAGE, "S"], [ACC_X - VIRTUAL_SS_PERCENTAGE, 1, "X"],
  ];
  const gradientId = `lazer-acc-${score.key}`.replace(/[^a-zA-Z0-9-_]/g, "_");
  const badgeW = size + 40;
  const badgeH = size + 30;

  return (
    <div style={{ position: "relative", width: size, height: size, transform: `scale(${scale})` }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <defs>
          <linearGradient id={gradientId} x1={size} y1={size / 2} x2="0" y2={size / 2} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#7CF6FF" />
            <stop offset="1" stopColor="#BAFFA9" />
          </linearGradient>
        </defs>
        <Arc size={size} radius={size / 2} thickness={(ACCURACY_CIRCLE_RADIUS + 0.01) * (size / 2)} progress={1} stroke="#2f2f2f" opacity={0.5} />
        <Arc size={size} radius={size / 2} thickness={ACCURACY_CIRCLE_RADIUS * (size / 2)} progress={accuracyProgress} stroke={`url(#${gradientId})`} />
        {segments.map(([from, to, rank]) => {
          const start = from + GRADE_SPACING_PERCENTAGE * 0.5;
          const end = to - GRADE_SPACING_PERCENTAGE * 0.5;
          const progress = Math.min(Math.max(reveal, start), end) - start;
          return <Arc key={rank} size={size} radius={gradedRadius} thickness={RANK_CIRCLE_RADIUS * gradedRadius} progress={progress} rotation={start} stroke={rankColour(rank)} />;
        })}
      </svg>
      <div style={{ position: "absolute", left: -20, top: -15, width: badgeW, height: badgeH }}>
        {badges.map((badge, i) => {
          const at = times[i];
          if (at == null || e < at) return null;
          const angle = -Math.PI / 2 - (1 - badge.position) * Math.PI * 2;
          const glow = tween(e, at, 500, 1, 0, inQuad);
          return (
            <div
              key={badge.rank}
              style={{
                position: "absolute",
                left: badgeW / 2 + Math.cos(angle) * (badgeW / 2) - 14,
                top: badgeH / 2 + Math.sin(angle) * (badgeH / 2) - 7,
                width: 28, height: 14, borderRadius: 7,
                opacity: tween(e, at, 50, 0, 1, linear),
                boxShadow: glow > 0 ? `0 0 10px 0 color-mix(in srgb, ${rankColour(badge.rank)} ${20 * glow}%, transparent)` : undefined,
              }}
            >
              <DrawableRank rank={badge.rank} width={28} height={14} />
            </div>
          );
        })}
      </div>
      <RankText rank={score.rank} e={e - ACCURACY_TRANSFORM_DELAY - TEXT_APPEAR_DELAY} />
    </div>
  );
}

/** RankText: the big letter in the middle, with its flashes. */
function RankText({ rank, e }: { rank: LazerRank; e: number }) {
  if (e < 0) return null;
  const colour = rankColour(rank);
  const letter = rankLetter(rank);
  const low = RANK_VALUE[rank] < RANK_VALUE.A;
  let y = 0;
  let rotate = 0;
  let opacity = 1;
  let scale = 1;
  let flash = 0;
  let superFlash = 0;
  if (low) {
    y = tween(e, 0, 200, -20, 0, outBounce);
    opacity = tween(e, 0, 200, 0, 1, outQuint);
    if (RANK_VALUE[rank] <= RANK_VALUE.D) {
      rotate = tween(e, 700, 150, 0, 5, inQuad);
      y += tween(e, 700, 150, 0, 3, inQuad);
    }
  } else {
    if (RANK_VALUE[rank] >= RANK_VALUE.S) scale = tween(e, 0, 3000, 1.05, 1, outQuint);
    if (RANK_VALUE[rank] >= RANK_VALUE.X) {
      flash = tween(e, 0, 3000, 1, 0, linear);
      superFlash = tween(e, 0, 800, 1, 0, outQuint);
    } else {
      flash = tween(e, 0, 1200, 1, 0, outQuint);
    }
  }
  const text: CSSProperties = { fontFamily: VENERA, fontSize: 76, lineHeight: 1, letterSpacing: -15, whiteSpace: "nowrap", paddingRight: 15 };
  return (
    <div style={{ position: "absolute", left: "50%", top: "50%", transform: `translate(-50%, -50%) translateY(${y}px) rotate(${rotate}deg)`, opacity, pointerEvents: "none" }}>
      <div style={{ ...text, color: "#fff", transform: `scale(${scale})`, textShadow: `0 0 6px ${colour}, 0 0 6px ${colour}` }}>{letter}</div>
      {superFlash > 0 && (
        <div style={{ position: "absolute", left: "50%", top: "50%", width: 600, height: 600, transform: "translate(-50%, -50%)", background: "radial-gradient(closest-side, rgba(255,255,255,0.55), rgba(255,255,255,0.25) 45%, rgba(255,255,255,0) 100%)", opacity: superFlash, mixBlendMode: "plus-lighter", willChange: "opacity" }} />
      )}
      {flash > 0 && (
        <div style={{ ...text, position: "absolute", left: 0, top: 0, color: colour, transform: "scale(1.8)", filter: "blur(35px)", opacity: flash, mixBlendMode: "plus-lighter", willChange: "opacity" }}>{letter}</div>
      )}
    </div>
  );
}

// ── statistics ────────────────────────────────────────────────────────────

function StatisticDisplay({ header, headerColour = "#fff", children, visible }: { header: string; headerColour?: string; children: ReactNode; visible: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 0 }}>
      <div style={{ position: "relative", width: "100%", height: 12, borderRadius: 6, background: "#222", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        <span style={{ ...torus(12, W_SEMIBOLD), color: headerColour, textTransform: "uppercase", whiteSpace: "nowrap" }}>{header}</span>
      </div>
      <div style={{ opacity: visible, display: "flex", alignItems: "flex-end" }}>{children}</div>
    </div>
  );
}

/** RollingCounter: rolls from 0 once the statistic appears. */
function rolled(e: number, appearAt: number, value: number, duration = ACCURACY_TRANSFORM_DURATION, ease: Ease = outPow10) {
  return tween(e, appearAt, duration, 0, value, ease);
}

function MiddleStatistics({ score, e }: { score: LazerResultsScore; e: number }) {
  const { t } = useLingui();
  const appearAt = (index: number) => ACCURACY_TRANSFORM_DELAY + index * 200;
  const visible = (index: number) => tween(e, appearAt(index), 100, 0, 1, linear);
  const perfectCombo = score.maxAchievableCombo != null && score.maxCombo === score.maxAchievableCombo;
  const perfectVisible = perfectCombo ? tween(e, appearAt(1) + ACCURACY_TRANSFORM_DURATION / 2, 50, 0, 1, linear) : 0;
  const counter = (value: number) => <FixedWidthText text={formatInteger(value)} size={20} weight={W_REGULAR} spacing={-2} />;
  const accuracyShown = rolled(e, appearAt(0), score.accuracy, ACCURACY_TRANSFORM_DURATION / 2, outQuad);
  const pp = score.pp != null ? Math.round(score.pp) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)" }}>
        <StatisticDisplay header={t`Accuracy`} visible={visible(0)}>
          <FixedWidthText text={formatAccuracy(accuracyShown)} size={20} weight={W_REGULAR} spacing={-2} />
        </StatisticDisplay>
        <StatisticDisplay header={t`Max Combo`} visible={visible(1)}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            <span style={{ display: "inline-flex", alignItems: "flex-end" }}>
              {counter(rolled(e, appearAt(1), score.maxCombo))}
              {score.maxAchievableCombo != null && (
                <FixedWidthText text={`/${score.maxAchievableCombo}`} size={12} weight={W_REGULAR} spacing={-2} />
              )}
            </span>
            {perfectVisible > 0 && (
              <span
                style={{
                  ...torus(11, W_SEMIBOLD), opacity: perfectVisible,
                  backgroundImage: "linear-gradient(to bottom, #66FFCC, #FF9AD7)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
                }}
              >
                PERFECT
              </span>
            )}
          </span>
        </StatisticDisplay>
        <div style={{ opacity: score.ppDimmed ? 0.5 : 1 }}>
          <StatisticDisplay header="pp" visible={pp != null ? visible(2) : 0}>
            {counter(rolled(e, appearAt(2), pp ?? 0))}
          </StatisticDisplay>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${HIT_RESULTS.length}, 1fr)` }}>
        {HIT_RESULTS.map((result, i) => (
          <StatisticDisplay key={result.key} header={result.label} headerColour={result.colour} visible={visible(3 + i)}>
            {counter(rolled(e, appearAt(3 + i), score.statistics[result.key]))}
          </StatisticDisplay>
        ))}
      </div>
    </div>
  );
}

// ── panel contents ────────────────────────────────────────────────────────

const truncate: CSSProperties = { maxWidth: EXPANDED_W - 20, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

function ExpandedMiddleContent({ score, beatmap, e }: { score: LazerResultsScore; beatmap: LazerResultsBeatmap; e: number }) {
  const { t } = useLingui();
  const playedOn = score.playedAt ? formatPlayedOn(score.playedAt) : null;
  const totalShown = tween(e, ACCURACY_TRANSFORM_DELAY, ACCURACY_TRANSFORM_DURATION, 0, score.totalScore, outPow10);
  return (
    <div style={{ position: "absolute", inset: 0, padding: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 20, height: "100%" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <span style={{ ...truncate, ...torus(20, W_SEMIBOLD) }}>{beatmap.title}</span>
            <span style={{ ...truncate, ...torus(14, W_SEMIBOLD) }}>{beatmap.artist}</span>
          </div>
          <div style={{ marginTop: 40, height: 230, width: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <AccuracyCircle score={score} e={e} />
          </div>
          <div style={{ marginBottom: 5, width: "100%", display: "flex", justifyContent: "center", opacity: e >= ACCURACY_TRANSFORM_DELAY ? 1 : 0 }}>
            <FixedWidthText text={formatInteger(totalShown)} size={60} weight={W_LIGHT} spacing={-5} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            {beatmap.stars != null && <StarRatingPill stars={beatmap.stars} />}
            <DifficultyIcon stars={beatmap.stars} size={20} />
            {score.mods.length > 0 && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 2.5 }}>
                {score.mods.map((mod) => <LazerModIcon key={mod.acronym} mod={mod} scale={0.3} />)}
              </span>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <span style={{ ...truncate, ...torus(16, W_SEMIBOLD) }}>{beatmap.version}</span>
            {beatmap.creator && (
              <span style={{ ...torus(12, W_REGULAR) }}>
                {t`mapped by`} <span style={{ fontWeight: W_SEMIBOLD }}>{beatmap.creator}</span>
              </span>
            )}
          </div>
        </div>
        <MiddleStatistics score={score} e={e} />
      </div>
      {playedOn && (
        <span style={{ position: "absolute", left: "50%", bottom: 10, transform: "translateX(-50%)", ...torus(10, W_SEMIBOLD), whiteSpace: "nowrap" }}>
          {t`Played on ${playedOn}`}
        </span>
      )}
    </div>
  );
}

function ExpandedTopContent({ score }: { score: LazerResultsScore }) {
  return (
    <div style={{ position: "absolute", left: "50%", top: 0, transform: "translate(-50%, -50%)", display: "flex", flexDirection: "column", alignItems: "center" }}>
      <Avatar url={score.user.avatarUrl} size={80} radius={20} />
      <span style={{ ...torus(16, W_SEMIBOLD), whiteSpace: "nowrap" }}>{score.user.name}</span>
    </div>
  );
}

function ContractedStatistic({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", ...torus(12, W_SEMIBOLD) }}>
      <span>{label}</span>
      <span style={{ color: "#FFDD55" }}>{value}</span>
    </div>
  );
}

function ContractedMiddleContent({ score, stars }: { score: LazerResultsScore; stars: number | null }) {
  const { t } = useLingui();
  return (
    <div style={{ position: "absolute", inset: 0, display: "grid", gridTemplateRows: "1fr 45px" }}>
      <div style={{ position: "relative", borderRadius: 20, overflow: "hidden", background: "#444", boxShadow: "0 2px 1px rgba(0,0,0,0.25)" }}>
        <CoverBackground url={score.user.coverUrl} />
        <div style={{ position: "relative", padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ alignSelf: "center" }}>
            <Avatar url={score.user.avatarUrl} size={110} radius={20} shadow="0 1px 8px rgba(0,0,0,0.15)" />
          </div>
          <span style={{ alignSelf: "center", ...truncate, maxWidth: CONTRACTED_W - 20, ...torus(16, W_SEMIBOLD) }}>{score.user.name}</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {HIT_RESULTS.map((result) => <ContractedStatistic key={result.key} label={result.label} value={String(score.statistics[result.key])} />)}
          </div>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 5 }}>
            <ContractedStatistic label={t`Max Combo`} value={`x${score.maxCombo}`} />
            <ContractedStatistic label={t`Accuracy`} value={formatAccuracy(score.accuracy)} />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", alignItems: "flex-start", gap: 3 }}>
            <span style={{ marginRight: 2 }}><DifficultyIcon stars={stars} size={20} /></span>
            {score.mods.map((mod) => <span key={mod.acronym} style={{ marginTop: -6 * 0.3 }}><LazerModIcon mod={mod} scale={0.3} /></span>)}
          </div>
        </div>
      </div>
      <div style={{ padding: "5px 0", display: "grid", gridTemplateRows: "auto 1fr", justifyItems: "center" }}>
        <FixedWidthText text={formatInteger(score.totalScore)} size={20} weight={W_REGULAR} spacing={-1} />
        <div style={{ paddingTop: 2, display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
          <DrawableRank rank={score.rank} width={CONTRACTED_W} height={13} />
        </div>
      </div>
    </div>
  );
}

// ── score panel ───────────────────────────────────────────────────────────

interface PanelAnim {
  stateAt: number;
  fromW: number;
  fromH: number;
  fromOffset: number;
  offsetDelay: number;
  fromExpanded: number;
  flair: boolean;
  previous: boolean | null;
}

function panelFrame(anim: PanelAnim, expanded: boolean, now: number) {
  const toW = expanded ? EXPANDED_W : CONTRACTED_W;
  const toH = expanded ? EXPANDED_H : CONTRACTED_H;
  const offsetStart = anim.stateAt + anim.offsetDelay;
  return {
    w: tween(now, anim.stateAt, RESIZE_DURATION, anim.fromW, toW, outQuint),
    h: tween(now, anim.stateAt, RESIZE_DURATION, anim.fromH, toH, outQuint),
    offset: tween(now, offsetStart, TOP_LAYER_EXPAND_DURATION, anim.fromOffset, (expanded ? EXPANDED_TOP_LAYER_H : CONTRACTED_TOP_LAYER_H) / 2, outQuint),
    // 1 = the expanded colours, 0 = the contracted ones.
    expandedColour: tween(now, anim.stateAt, RESIZE_DURATION, anim.fromExpanded, expanded ? 1 : 0, outQuint),
    topVisible: anim.fromOffset > 0 || now >= offsetStart,
    contentAlpha: tween(now, offsetStart, CONTENT_FADE_DURATION, 0, 1, linear),
    previousAlpha: tween(now, anim.stateAt, CONTENT_FADE_DURATION, 1, 0, linear),
    offsetStart,
  };
}

function mix(a: [number, number, number], b: [number, number, number], t: number): string {
  return `rgb(${a.map((v, i) => Math.round(lerp(v, b[i], t))).join(",")})`;
}
const C353535: [number, number, number] = [0x35, 0x35, 0x35];
const C444: [number, number, number] = [0x44, 0x44, 0x44];
const C555: [number, number, number] = [0x55, 0x55, 0x55];
const C333: [number, number, number] = [0x33, 0x33, 0x33];

/** How long a panel keeps animating after its state changes; past it the
 *  panel is handed a frozen clock so React can skip it. */
function panelSettleAt(anim: PanelAnim): number {
  return anim.stateAt + (anim.flair ? ACCURACY_TOTAL_DURATION + TEXT_APPEAR_DELAY + 3000 : RESIZE_DURATION + TOP_LAYER_EXPAND_DELAY + TOP_LAYER_EXPAND_DURATION + 100);
}

const ScorePanel = memo(function ScorePanel({ score, beatmap, expanded, anim, now, onPanelClick }: {
  score: LazerResultsScore;
  beatmap: LazerResultsBeatmap;
  expanded: boolean;
  anim: PanelAnim;
  now: number;
  onPanelClick: (key: string) => void;
}) {
  const onClick = () => onPanelClick(score.key);
  const frame = panelFrame(anim, expanded, now);
  const t = frame.expandedColour;
  const topBackground = `linear-gradient(to bottom, ${mix(C353535, C444, t)}, ${mix(C353535, C333, t)})`;
  const middleBackground = `linear-gradient(to bottom, ${mix(C353535, C555, t)}, ${mix(C353535, C333, t)})`;
  // Flair runs from when the content was made; without it every transform
  // is finished on load, content alpha included.
  const e = anim.flair ? now - anim.stateAt : Number.POSITIVE_INFINITY;
  const contentAlpha = expanded && !anim.flair ? 1 : frame.contentAlpha;
  const showPrevious = anim.previous != null && frame.previousAlpha > 0;
  const content = (isExpanded: boolean, alpha: number, key: string) => ({
    top: (
      <div key={`top-${key}`} style={{ position: "absolute", inset: 0, opacity: alpha }}>
        {isExpanded ? <ExpandedTopContent score={score} /> : (
          score.position != null && (
            <span style={{ position: "absolute", left: "50%", top: 6, transform: "translateX(-50%)", ...torus(18, W_BOLD) }}>#{score.position}</span>
          )
        )}
      </div>
    ),
    middle: (
      <div key={`middle-${key}`} style={{ position: "absolute", inset: 0, opacity: alpha }}>
        {isExpanded ? <ExpandedMiddleContent score={score} beatmap={beatmap} e={e} /> : <ContractedMiddleContent score={score} stars={beatmap.stars} />}
      </div>
    ),
  });
  const current = content(expanded, contentAlpha, "current");
  const previous = showPrevious ? content(anim.previous!, frame.previousAlpha, "previous") : null;

  return (
    <div
      onClick={onClick}
      style={{ position: "absolute", left: "50%", top: "50%", width: frame.w, height: frame.h, transform: `translate(-50%, -50%) translateY(${VERTICAL_FUDGE}px)`, cursor: "pointer" }}
    >
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 120, transform: `translateY(${-frame.offset}px)`, opacity: frame.topVisible ? 1 : 0 }}>
        <div style={{ position: "absolute", inset: 0, borderRadius: 20, background: topBackground }} />
        <div style={{ position: "absolute", inset: 0 }}>
          {previous?.top}
          {current.top}
        </div>
      </div>
      <div style={{ position: "absolute", inset: 0, transform: `translateY(${frame.offset}px)` }}>
        <div style={{ position: "absolute", inset: 0, borderRadius: 20, overflow: "hidden", background: middleBackground }}>
          <CoverBackground url={score.user.coverUrl} />
        </div>
        <div style={{ position: "absolute", inset: 0 }}>
          {previous?.middle}
          {current.middle}
        </div>
      </div>
    </div>
  );
});

// ── bottom bar ────────────────────────────────────────────────────────────

/** OsuAnimatedButton: rounded, white hover wash, squash on press. */
function AnimatedButton({ width, height, background, title, onClick, children }: { width: number; height: number; background: string; title: string; onClick: () => void; children: ReactNode }) {
  const [hover, setHover] = useState(false);
  const [down, setDown] = useState(false);
  const [flashKey, setFlashKey] = useState(0);
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => { setHover(false); setDown(false); }}
      onPointerDown={() => setDown(true)}
      onPointerUp={() => setDown(false)}
      onClick={() => { setFlashKey((k) => k + 1); onClick(); }}
      style={{
        position: "relative", width, height, borderRadius: 10, overflow: "hidden", background, color: "#fff", cursor: "pointer",
        boxShadow: "0 0 0 0 rgba(0,0,0,0.04)", border: "none", padding: 0,
        transform: `scale(${down ? 0.75 : 1})`,
        transition: down ? `transform 2000ms ${CSS_OUT_QUINT}` : `transform 1000ms ${CSS_OUT_ELASTIC}`,
      }}
    >
      <span style={{ position: "absolute", inset: 0, background: "rgba(255,255,255,0.1)", opacity: hover ? 1 : 0, transition: "opacity 500ms cubic-bezier(0.22, 1, 0.36, 1)" }} />
      {flashKey > 0 && <span key={flashKey} className="lazer-results-flash" style={{ position: "absolute", inset: 0, background: "rgba(255,255,255,0.3)" }} />}
      <span style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%" }}>{children}</span>
    </button>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 512 512" width={13} height={13} fill="currentColor" aria-hidden="true">
      <path d="M288 32c0-17.7-14.3-32-32-32s-32 14.3-32 32v242.7l-73.4-73.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l128 128c12.5 12.5 32.8 12.5 45.3 0l128-128c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L288 274.7V32zM64 352c-35.3 0-64 28.7-64 64v32c0 35.3 28.7 64 64 64h384c35.3 0 64-28.7 64-64v-32c0-35.3-28.7-64-64-64H346.5l-45.3 45.3c-25 25-65.5 25-90.5 0L165.5 352H64zm368 56a24 24 0 1 1 0 48 24 24 0 1 1 0-48z" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg viewBox="0 0 448 512" width={13} height={13} fill="currentColor" aria-hidden="true">
      <path d="M96 0C43 0 0 43 0 96v320c0 53 43 96 96 96h320c17.7 0 32-14.3 32-32s-14.3-32-32-32v-64c17.7 0 32-14.3 32-32V32c0-17.7-14.3-32-32-32H96zm0 384h256v64H96c-17.7 0-32-14.3-32-32s14.3-32 32-32zm32-240c0-8.8 7.2-16 16-16h192c8.8 0 16 7.2 16 16s-7.2 16-16 16H144c-8.8 0-16-7.2-16-16zm16 48h192c8.8 0 16 7.2 16 16s-7.2 16-16 16H144c-8.8 0-16-7.2-16-16s7.2-16 16-16z" />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg viewBox="0 0 512 512" width={13} height={13} fill="currentColor" aria-hidden="true">
      <path d="M225.8 468.2l-2.5-2.3L48.1 303.2C17.4 274.7 0 234.7 0 192.8v-3.3c0-70.4 50-130.8 119.2-144C158.6 37.9 198.9 47 231 69.6c9 6.4 17.4 13.8 25 22.3 4.2-4.8 8.7-9.2 13.5-13.3 3.7-3.2 7.5-6.2 11.5-9 32.1-22.6 72.4-31.7 111.8-24.2C462 58.6 512 119.1 512 189.5v3.3c0 41.9-17.4 81.9-48.1 110.4L288.7 465.9l-2.5 2.3c-8.2 7.6-19 11.9-30.2 11.9s-22-4.2-30.2-11.9zM239.1 145c-.4-.3-.7-.7-1-1.1l-17.8-20-.1-.1c-23.1-25.9-58-37.7-92-31.2-46.6 8.9-80.2 49.5-80.2 96.9v3.3c0 28.5 11.9 55.8 32.8 75.2L256 430.7 431.2 268c20.9-19.4 32.8-46.7 32.8-75.2v-3.3c0-47.3-33.6-88-80.1-96.9-34-6.5-69 5.4-92 31.2l-.1.1-.1.1-17.8 20c-.3.4-.7.7-1 1.1-4.5 4.5-10.6 7-16.9 7s-12.4-2.5-16.9-7z" />
    </svg>
  );
}

/** TwoLayerButton as BackButton: pink, sheared, grows on hover. */
function BackButton({ label, onClick, e }: { label: string; onClick: () => void; e: number }) {
  const [hover, setHover] = useState(false);
  const [flashKey, setFlashKey] = useState(0);
  const x = tween(e, 0, 400, -70, 0, outQuint);
  const opacity = tween(e, 0, 150, 0, 1, outQuint);
  const width = hover ? 140 : 100;
  const layer: CSSProperties = { position: "absolute", top: 0, bottom: 0, boxShadow: "2px 0 2px rgba(0,0,0,0.2)" };
  return (
    <button
      type="button"
      aria-label={label}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onClick={() => { setFlashKey((k) => k + 1); onClick(); }}
      style={{
        position: "absolute", left: 0, bottom: 0, height: BOTTOM_BAR_H, width, padding: 0, border: "none", background: "transparent", cursor: "pointer",
        transform: `translateX(${x}px) skewX(${(Math.atan(5 / 50) * 180) / Math.PI}deg)`, transformOrigin: "bottom left", opacity,
        transition: hover ? `width 600ms ${CSS_OUT_ELASTIC}` : "width 600ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
        color: "#fff",
      }}
    >
      <span style={{ ...layer, left: 0, width: "40%", background: hover ? "#cc5288" : "#ff66aa", transition: hover ? "background-color 300ms cubic-bezier(0.22, 1, 0.36, 1)" : "background-color 600ms ease-out" }}>
        <span style={{ position: "absolute", left: "50%", top: "50%", transform: `translate(-50%, -50%) skewX(${-(Math.atan(5 / 50) * 180) / Math.PI}deg) scale(${hover ? 1.1 : 1})`, transition: hover ? `transform 600ms ${CSS_OUT_ELASTIC}` : "transform 600ms ease-out", display: "flex" }}>
          <svg viewBox="0 0 24 24" width={25} height={25} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M13.5 8l-4 4 4 4" />
          </svg>
        </span>
      </span>
      <span style={{ ...layer, right: 0, width: "60%", background: "#ff66aa" }}>
        <span style={{ position: "absolute", left: "50%", top: "50%", transform: `translate(-50%, -50%) skewX(${-(Math.atan(5 / 50) * 180) / Math.PI}deg)`, ...torus(20, W_REGULAR), whiteSpace: "nowrap" }}>
          {label}
        </span>
      </span>
      {flashKey > 0 && <span key={flashKey} className="lazer-results-flash-back" style={{ position: "absolute", inset: 0, background: "rgba(255,255,255,0.5)" }} />}
    </button>
  );
}

// ── statistics panel (Screens/Ranking/Statistics) ─────────────────────────

const STATISTIC_FONT_SIZE = 13;
const STATISTICS_SIDE_PADDING = 20;
const TIMING_BINS = 50;

/** StatisticItemContainer: a rounded card with an underlined title. */
function StatisticItemBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ padding: 5, width: "100%", boxSizing: "border-box" }}>
      <div style={{ position: "relative", borderRadius: 20, overflow: "hidden", boxShadow: "0 0 2px 0 #2e2e2e" }}>
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, rgba(64,64,64,0.8), rgba(46,46,46,0.95))" }} />
        <div style={{ position: "relative", padding: "42px 17px 17px" }}>{children}</div>
        <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 30, background: "linear-gradient(to bottom, #404040, rgba(64,64,64,0))", pointerEvents: "none" }} />
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 20, background: "linear-gradient(to bottom, rgba(46,46,46,0), #2e2e2e)", pointerEvents: "none" }} />
        <div style={{ position: "absolute", left: 12, top: 8, display: "inline-flex", flexDirection: "column" }}>
          <span style={torus(16, W_BOLD)}>{title}</span>
          <span style={{ marginTop: 4, height: 2, background: "#66FFCC" }} />
        </div>
      </div>
    </div>
  );
}

/** SimpleStatisticTable.Spacer. */
function StatisticSpacer() {
  return <span style={{ justifySelf: "center", alignSelf: "stretch", width: 3, borderRadius: 2, background: "#222" }} />;
}

function PerformanceBreakdownChart({ pp, maxPp }: { pp: number; maxPp: number }) {
  const { t } = useLingui();
  const percentage = maxPp > 0 ? Math.min(1, pp / maxPp) : 0;
  const text: CSSProperties = torus(STATISTIC_FONT_SIZE, W_REGULAR);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 50px 1fr", alignItems: "center" }}>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center" }}>
        <span style={text}>{t`Difficulty`}</span>
        <span style={{ padding: "0 10px" }}>
          <span style={{ display: "block", height: 5, borderRadius: 2.5, overflow: "hidden", background: "rgba(255,255,255,0.5)" }}>
            <span style={{ display: "block", height: "100%", width: `${percentage * 100}%`, background: "#66FFCC" }} />
          </span>
        </span>
        <span style={{ ...text, fontWeight: W_SEMIBOLD }}>{Math.round(percentage * 100)}%</span>
      </div>
      <StatisticSpacer />
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto" }}>
        <span style={{ ...text, color: "#66FFCC" }}>{t`Achieved PP`}</span>
        <span style={{ ...text, color: "#66FFCC", textAlign: "right" }}>{formatInteger(pp)}</span>
        <span style={{ ...text, color: "#b3b3b3" }}>{t`Maximum`}</span>
        <span style={{ ...text, color: "#b3b3b3", textAlign: "right" }}>{formatInteger(maxPp)}</span>
      </div>
    </div>
  );
}

// Bottom of each stacked bar first, in GetIndexForOrderedDisplay order.
const TIMING_COLOURS: Record<number, string> = { 1: "#99eeff", 2: "#66ccff", 3: "#b3d944", 4: "#88b300", 5: "#ffcc22" };

/** HitEventTimingDistributionGraph: 101 stacked bins of hit offsets. */
function HitEventTimingDistributionGraph({ events }: { events: ReplayHitEvent[] }) {
  const { bins, binSize, maxCount } = useMemo(() => {
    const bins = Array.from({ length: TIMING_BINS * 2 + 1 }, () => new Map<number, number>());
    if (events.length === 0) return { bins, binSize: 1, maxCount: 0 };
    const binSize = Math.max(1, Math.ceil(Math.max(...events.map((e) => Math.abs(e.offsetMs))) / TIMING_BINS));
    let roundUp = true;
    for (const event of events) {
      let binOffset = event.offsetMs / binSize;
      // Exact midpoints alternate between the two neighbouring bins.
      if (Math.abs(binOffset - Math.trunc(binOffset)) === 0.5) {
        binOffset = Math.trunc(binOffset) + Math.sign(binOffset) * (roundUp ? 1 : 0);
        roundUp = !roundUp;
      }
      const rounded = Math.sign(binOffset) * Math.round(Math.abs(binOffset));
      const index = TIMING_BINS + rounded;
      if (index < 0 || index >= bins.length) continue;
      bins[index].set(event.judgment, (bins[index].get(event.judgment) ?? 0) + 1);
    }
    const maxCount = Math.max(...bins.map((bin) => [...bin.values()].reduce((a, b) => a + b, 0)));
    return { bins, binSize, maxCount };
  }, [events]);

  if (events.length === 0) return null;
  const barsHeight = 150 - STATISTIC_FONT_SIZE;
  const minimumHeight = 0.02;
  const offsetFor = (value: number) => (maxCount === 0 ? 0 : (1 - minimumHeight) * value / maxCount);
  const heightFor = (value: number) => minimumHeight + offsetFor(value);
  const maxValue = TIMING_BINS * binSize;
  const axis = [{ x: 0, text: "0", alpha: 1 }];
  for (let i = 1; i <= 5; i++) {
    const value = (i * maxValue) / 5;
    const position = maxValue === 0 ? 0 : value / maxValue;
    const alpha = 1 - position * 0.8;
    axis.push({ x: -position / 2, text: `-${Math.round(value)}`, alpha }, { x: position / 2, text: `+${Math.round(value)}`, alpha });
  }

  return (
    <div style={{ padding: "0 5px", height: 150, display: "flex", flexDirection: "column" }}>
      <div style={{ height: barsHeight, display: "grid", gridTemplateColumns: `repeat(${bins.length}, 1fr)` }}>
        {bins.map((bin, i) => {
          const isCentre = i === TIMING_BINS;
          const entries = [...bin.entries()].sort((a, b) => a[0] - b[0]);
          let cumulative = 0;
          const boxes = entries.length > 0
            ? entries.map(([judgment, value], j) => {
              const box = { bottom: offsetFor(cumulative), height: heightFor(value), colour: isCentre && j === 0 ? "#fff" : TIMING_COLOURS[judgment] ?? "#fff" };
              cumulative += value;
              return box;
            })
            : [{ bottom: 0, height: heightFor(0), colour: isCentre ? "#fff" : "#808080" }];
          return (
            <div key={i} style={{ position: "relative", height: "100%", overflow: "hidden" }}>
              {boxes.map((box, j) => (
                <span
                  key={j}
                  style={{
                    position: "absolute", left: 0, right: 0, bottom: box.bottom * barsHeight, height: box.height * barsHeight,
                    borderRadius: 999, background: box.colour, zIndex: boxes.length - j,
                  }}
                />
              ))}
            </div>
          );
        })}
      </div>
      <div style={{ position: "relative", height: STATISTIC_FONT_SIZE }}>
        {axis.map((point) => (
          <span
            key={point.text}
            style={{
              position: "absolute", left: `${50 + point.x * 100}%`, top: 0, transform: "translateX(-50%)", opacity: point.alpha,
              ...torus(STATISTIC_FONT_SIZE, W_SEMIBOLD), whiteSpace: "nowrap",
            }}
          >
            {point.text}
          </span>
        ))}
      </div>
    </div>
  );
}

function SimpleStatisticRow({ name, value }: { name: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", ...torus(STATISTIC_FONT_SIZE, W_REGULAR) }}>
      <span style={{ fontWeight: W_REGULAR }}>{name}</span>
      <span style={{ fontWeight: W_BOLD }}>{value}</span>
    </div>
  );
}

/** HitEventExtensions: mean raw offset, and UR over rate-adjusted offsets. */
function hitErrorStats(events: ReplayHitEvent[], rate: number) {
  if (events.length === 0) return { average: null, unstableRate: null };
  let sum = 0;
  let mean = 0;
  let sumOfSquares = 0;
  events.forEach((event, i) => {
    sum += event.offsetMs;
    const value = event.offsetMs / rate;
    const next = mean + (value - mean) / (i + 1);
    sumOfSquares += (value - mean) * (value - next);
    mean = next;
  });
  return { average: sum / events.length, unstableRate: 10 * Math.sqrt(sumOfSquares / events.length) };
}

const formatTwoDecimals = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function MessagePlaceholder({ message }: { message: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: 20, ...torus(22, W_REGULAR), textAlign: "center" }}>
      <svg viewBox="0 0 512 512" width={20} height={20} fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
        <path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zm0-384c13.3 0 24 10.7 24 24v112c0 13.3-10.7 24-24 24s-24-10.7-24-24V152c0-13.3 10.7-24 24-24zm-32 224a32 32 0 1 1 64 0 32 32 0 1 1-64 0z" />
      </svg>
      <span>{message}</span>
    </div>
  );
}

function StatisticsPanelContent({ score, onWatchReplay }: { score: LazerResultsScore; onWatchReplay?: () => void }) {
  const { t } = useLingui();
  const events = score.hitEvents ?? [];
  const hasEvents = events.length > 0;
  const showPerformance = score.pp != null && score.maxPp != null && score.maxPp > 0;
  const { average, unstableRate } = hitErrorStats(events, score.rate ?? 1);
  const replayButton = onWatchReplay && (
    <div style={{ display: "flex", justifyContent: "center", paddingBottom: 10 }} onClick={(event) => event.stopPropagation()}>
      <AnimatedButton width={75} height={45} background="#444" title={t`Watch replay`} onClick={onWatchReplay}>
        <span style={{ transform: "scale(1.5)", display: "flex" }}><DownloadIcon /></span>
      </AnimatedButton>
    </div>
  );
  if (!hasEvents && !showPerformance) {
    return (
      <div>
        <MessagePlaceholder message={t`Extended statistics are only available after watching a replay!`} />
        {replayButton}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {showPerformance && (
        <StatisticItemBox title={t`Performance Breakdown`}>
          <PerformanceBreakdownChart pp={score.pp!} maxPp={score.maxPp!} />
        </StatisticItemBox>
      )}
      {hasEvents ? (
        <StatisticItemBox title={t`Timing Distribution`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 15 }}>
            <HitEventTimingDistributionGraph events={events} />
            <div>
              <SimpleStatisticRow
                name={t`Average Hit Error`}
                value={average == null ? t`N/A` : average < 0 ? t`${formatTwoDecimals(Math.abs(average))} ms early` : t`${formatTwoDecimals(average)} ms late`}
              />
              <SimpleStatisticRow name={t`Unstable Rate`} value={unstableRate == null ? t`N/A` : formatTwoDecimals(unstableRate)} />
            </div>
          </div>
        </StatisticItemBox>
      ) : (
        <div>
          <MessagePlaceholder message={t`More statistics available after watching a replay!`} />
          {replayButton}
        </div>
      )}
    </div>
  );
}

// ── screen ────────────────────────────────────────────────────────────────

export interface LazerResultsScreenProps {
  score: LazerResultsScore;
  /** The map's other leaderboard scores, drawn as contracted panels. */
  others?: LazerResultsScore[];
  beatmap: LazerResultsBeatmap;
  backgroundUrl?: string | null;
  /** How bright the gameplay background was, so the fade picks up from it. */
  startBrightness?: number;
  /** 0 to 1, for the results samples. */
  volume: number;
  onBack: () => void;
  onWatchReplay: () => void;
  /** Opens another leaderboard score's replay. */
  onWatchScore?: (score: LazerResultsScore) => void;
}

interface StatisticsAnim { at: number; fromX: number; fromAlpha: number; fromContracted: number; fromBrightness: number }

export function LazerResultsScreen({ score, others = [], beatmap, backgroundUrl, startBrightness = 1, volume, onBack, onWatchReplay, onWatchScore }: LazerResultsScreenProps) {
  const { t } = useLingui();
  const rootRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [openedAt] = useState(() => performance.now());
  const [now, setNow] = useState(openedAt);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const sfxRef = useRef<ResultsSfx | null>(null);

  // Highest score leftmost, like ScorePanelList's flow.
  const scores = useMemo(() => {
    const list = [score, ...others.filter((other) => other.key !== score.key)];
    return list.sort((a, b) => b.totalScore - a.totalScore);
  }, [score, others]);
  const [selectedKey, setSelectedKey] = useState(score.key);
  const selectedIndex = Math.max(0, scores.findIndex((s) => s.key === selectedKey));

  const animsRef = useRef(new Map<string, PanelAnim>());
  const expandedRef = useRef(new Map<string, boolean>());
  const nowRef = useRef(now);
  nowRef.current = now;
  for (const s of scores) {
    if (animsRef.current.has(s.key)) continue;
    // A fresh panel loads contracted, finishes its colours, then the list
    // expands the selected one: both grow out of a 40x40 square.
    const isMain = s.key === score.key;
    animsRef.current.set(s.key, {
      stateAt: openedAt, fromW: 40, fromH: 40, fromOffset: 0,
      offsetDelay: RESIZE_DURATION + TOP_LAYER_EXPAND_DELAY, fromExpanded: 0, flair: isMain, previous: null,
    });
    expandedRef.current.set(s.key, s.key === selectedKey);
  }

  const [activeUntil, setActiveUntil] = useState(openedAt + ACCURACY_TOTAL_DURATION + 3000);
  const wake = useCallback((ms: number) => setActiveUntil((until) => Math.max(until, performance.now() + ms)), []);

  // Selection changes: contract the old panel, expand the new one.
  useLayoutEffect(() => {
    const at = nowRef.current;
    for (const s of scores) {
      const shouldExpand = s.key === selectedKey;
      if (expandedRef.current.get(s.key) === shouldExpand) continue;
      const anim = animsRef.current.get(s.key)!;
      const frame = panelFrame(anim, !shouldExpand, at);
      animsRef.current.set(s.key, {
        stateAt: at, fromW: frame.w, fromH: frame.h, fromOffset: frame.offset,
        offsetDelay: frame.offset > 0 ? 0 : RESIZE_DURATION + TOP_LAYER_EXPAND_DELAY,
        fromExpanded: frame.expandedColour, flair: false, previous: !shouldExpand,
      });
      expandedRef.current.set(s.key, shouldExpand);
    }
    wake(1000);
  }, [selectedKey, scores, wake]);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Lazer fits a 1024x768 space into the window. On a narrow stage (a
  // phone) that leaves the panel tiny, so width only has to fit the expanded
  // panel itself; wide stages scale by height exactly as before.
  const uiScale = viewport.width > 0 ? Math.min(viewport.width / NARROW_MIN_W, viewport.height / VIRTUAL_H) : 1;
  const W = viewport.width / uiScale;
  const H = viewport.height / uiScale;

  // Horizontal scroll, damped toward its target like osu!'s ScrollContainer.
  const scrollRef = useRef({
    current: selectedIndex * (CONTRACTED_W + PANEL_SPACING),
    target: selectedIndex * (CONTRACTED_W + PANEL_SPACING),
    // ScrollContainer's DistanceDecayJump; a fling uses DistanceDecayDrag.
    decay: 0.01,
    dragging: false,
  });
  const contentWidth = scores.length * (CONTRACTED_W + PANEL_SPACING) - PANEL_SPACING + (EXPANDED_W - CONTRACTED_W) + EXPANDED_PANEL_SPACING * 2;
  const pad = W / 2 - (EXPANDED_W / 2 + EXPANDED_PANEL_SPACING);
  const maxScroll = Math.max(0, contentWidth + pad * 2 - W);
  useEffect(() => {
    scrollRef.current.target = Math.min(maxScroll, selectedIndex * (CONTRACTED_W + PANEL_SPACING));
    scrollRef.current.decay = 0.01;
    wake(1500);
  }, [selectedIndex, maxScroll, wake]);

  // Frame loop and the flair's sound cues.
  const running = useRef(false);
  const startRef = useRef<() => void>(() => {});
  const activeUntilRef = useRef(activeUntil);
  activeUntilRef.current = activeUntil;
  const firedRef = useRef(new Set<string>());
  const lastTickRef = useRef(Number.NEGATIVE_INFINITY);
  const lastFrameRef = useRef(openedAt);
  useEffect(() => {
    sfxRef.current ??= new ResultsSfx(() => volumeRef.current);
    const sfx = sfxRef.current;
    const target = gaugeTarget(score);
    const times = badgeTimes(score);
    const once = (key: string, at: number, e: number, fire: () => void) => {
      if (e < at || firedRef.current.has(key)) return;
      firedRef.current.add(key);
      // A cue missed by more than a beat (tab in the background) stays quiet.
      if (e - at < 250) fire();
    };
    let raf = 0;
    const loop = () => {
      const time = performance.now();
      const dt = time - lastFrameRef.current;
      lastFrameRef.current = time;
      const scroll = scrollRef.current;
      if (!scroll.dragging) {
        scroll.current = scroll.target + (scroll.current - scroll.target) * Math.exp(-scroll.decay * dt);
        if (Math.abs(scroll.current - scroll.target) < 0.05) scroll.current = scroll.target;
      }

      const e = time - openedAt;
      once("focus", 0, e, () => {
        sfx.play("score-panel-focus", { rate: 0.99 + Math.random() * 0.2 });
        sfx.play("score-panel-top-appear");
      });
      once("swoosh", 443, e, () => sfx.play("swoosh-up", { gain: 0.4 }));
      const tickStart = ACCURACY_TRANSFORM_DELAY;
      const tickEnd = ACCURACY_TRANSFORM_DELAY + TEXT_APPEAR_DELAY;
      if (e >= tickStart && e < tickEnd) {
        const progress = outSine(Math.min(1, (e - tickStart) / ACCURACY_TRANSFORM_DURATION));
        if (e - lastTickRef.current >= lerp(18, 300, progress)) {
          lastTickRef.current = e;
          sfx.play("score-tick", { rate: 1 + target * progress, gain: lerp(0.6, 1, progress) });
        }
      }
      let badgeNum = 0;
      times.forEach((at, i) => {
        if (at == null) return;
        const n = badgeNum++;
        once(`badge-${i}`, at, e, () => sfx.play(n < 5 ? "badge-dink" : "badge-dink-max", { rate: 1 + n * 0.05 }));
      });
      once("impact", tickEnd, e, () => sfx.play(impactSample(score.rank)));

      setNow(time);
      if (time < activeUntilRef.current || scroll.dragging || scroll.current !== scroll.target) raf = requestAnimationFrame(loop);
      else running.current = false;
    };
    const start = () => {
      if (running.current) return;
      running.current = true;
      lastFrameRef.current = performance.now();
      raf = requestAnimationFrame(loop);
    };
    startRef.current = start;
    start();
    return () => {
      cancelAnimationFrame(raf);
      running.current = false;
    };
  }, [score, openedAt]);
  useEffect(() => { startRef.current(); }, [activeUntil]);
  useEffect(() => () => sfxRef.current?.stopAll(), []);

  const select = useCallback((key: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (key === selectedKey) return;
    sfxRef.current?.play("score-panel-focus", { rate: 0.99 + Math.random() * 0.2 });
    setSelectedKey(key);
  }, [selectedKey]);

  // The statistics panel: the expanded panel detaches and slides left, the
  // rest of the list fades and the background dims a little further.
  const [statisticsOpen, setStatisticsOpen] = useState(false);
  const statisticsAnimRef = useRef<StatisticsAnim>({ at: Number.NEGATIVE_INFINITY, fromX: 0, fromAlpha: 0, fromContracted: 1, fromBrightness: 0.5 });
  const listLeftRef = useRef(0);
  const statisticsFrame = (open: boolean, anim: StatisticsAnim, at: number, listLeft: number) => ({
    x: open
      ? tween(at, anim.at, 400, anim.fromX, STATISTICS_SIDE_PADDING, outElasticQuarter)
      : Number.isFinite(anim.at) ? tween(at, anim.at, 250, anim.fromX, listLeft, outElasticQuarter) : listLeft,
    alpha: open ? tween(at, anim.at, 350, anim.fromAlpha, 1, outQuint) : tween(at, anim.at, 250, anim.fromAlpha, 0, outQuint),
    contracted: tween(at, anim.at, 150, anim.fromContracted, open ? 0 : 1, outQuint),
    brightness: open ? tween(at, anim.at, 400, anim.fromBrightness, 0.4, outQuint) : tween(at, anim.at, 250, anim.fromBrightness, 0.5, outQuint),
  });
  const toggleStatistics = useCallback(() => {
    const at = nowRef.current;
    const frame = statisticsFrame(statisticsOpen, statisticsAnimRef.current, at, listLeftRef.current);
    statisticsAnimRef.current = { at, fromX: frame.x, fromAlpha: frame.alpha, fromContracted: frame.contracted, fromBrightness: frame.brightness };
    sfxRef.current?.play(statisticsOpen ? "statistics-panel-pop-out" : "statistics-panel-pop-in");
    setStatisticsOpen(!statisticsOpen);
    wake(800);
  }, [statisticsOpen, wake]);
  const handleBack = useCallback(() => {
    if (statisticsOpen) toggleStatistics();
    else onBack();
  }, [statisticsOpen, toggleStatistics, onBack]);

  // The wheel belongs to the results screen: it scrolls the score list (or
  // the statistics), never the page. Native and non-passive so it can
  // cancel the page scroll React's passive onWheel cannot.
  const statisticsScrollRef = useRef<HTMLDivElement>(null);
  const wheelStateRef = useRef({ statisticsOpen, maxScroll, uiScale });
  wheelStateRef.current = { statisticsOpen, maxScroll, uiScale };
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const { statisticsOpen: open, maxScroll: max, uiScale: scale } = wheelStateRef.current;
      const deltaScale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? el.clientHeight : 1;
      if (open) {
        statisticsScrollRef.current?.scrollBy({ top: event.deltaY * deltaScale });
        return;
      }
      const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * deltaScale;
      const scroll = scrollRef.current;
      scroll.target = Math.min(max, Math.max(0, scroll.target + delta / scale));
      scroll.decay = 0.01;
      wake(1500);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [wake]);

  // Dragging the list: the content follows the pointer, stretches past either
  // end, and a release flings it on with ScrollContainer's drag decay.
  const dragRef = useRef<{ pointerId: number; startX: number; startScroll: number; moved: boolean; samples: Array<{ t: number; x: number }> } | null>(null);
  const suppressClickRef = useRef(false);
  const handleListPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (statisticsOpen || event.button !== 0) return;
    // Pressing catches a list still gliding from a fling or the wheel, like
    // ScrollContainer: it stops where it is, and a drag carries on from there.
    const scroll = scrollRef.current;
    scroll.target = scroll.current;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startScroll: scroll.current, moved: false, samples: [{ t: performance.now(), x: event.clientX }] };
    suppressClickRef.current = false;
  }, [statisticsOpen]);
  const handleListPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const scroll = scrollRef.current;
    let position = drag.startScroll - dx / uiScale;
    // Past either end the list follows at a third of the pointer's pace.
    if (position < 0) position /= 3;
    else if (position > maxScroll) position = maxScroll + (position - maxScroll) / 3;
    scroll.dragging = true;
    scroll.current = position;
    scroll.target = position;
    const now = performance.now();
    drag.samples.push({ t: now, x: event.clientX });
    while (drag.samples.length > 2 && now - drag.samples[0].t > 100) drag.samples.shift();
    wake(500);
  }, [maxScroll, uiScale, wake]);
  const handleListPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (!drag.moved) {
      // A press that caught the list past an end lets it spring back.
      const scroll = scrollRef.current;
      scroll.target = Math.min(maxScroll, Math.max(0, scroll.current));
      scroll.decay = 0.01;
      wake(1500);
      return;
    }
    suppressClickRef.current = true;
    const scroll = scrollRef.current;
    scroll.dragging = false;
    const first = drag.samples[0];
    const last = drag.samples[drag.samples.length - 1];
    const elapsed = last.t - first.t;
    const velocity = elapsed > 0 && performance.now() - last.t < 80 ? -(last.x - first.x) / elapsed / uiScale : 0;
    const DISTANCE_DECAY_DRAG = 0.0035;
    scroll.target = Math.min(maxScroll, Math.max(0, scroll.current + velocity / DISTANCE_DECAY_DRAG));
    scroll.decay = scroll.current < 0 || scroll.current > maxScroll ? 0.01 : DISTANCE_DECAY_DRAG;
    wake(2000);
  }, [maxScroll, uiScale, wake]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        handleBack();
      } else if (event.key === "Enter" && !event.repeat) {
        event.preventDefault();
        event.stopPropagation();
        toggleStatistics();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [handleBack, toggleStatistics]);

  // One stable click handler, so settled panels can skip re-rendering.
  const panelClickRef = useRef<(key: string) => void>(() => {});
  panelClickRef.current = (key: string) => {
    if (key === scores[selectedIndex]?.key) {
      if (suppressClickRef.current) suppressClickRef.current = false;
      else toggleStatistics();
    } else select(key);
  };
  const handlePanelClick = useCallback((key: string) => panelClickRef.current(key), []);

  const e = now - openedAt;
  const screenAlpha = tween(e, 0, 250, 0, 1, linear);
  // The blur comes in as a cross-fade to a copy blurred once, and the dim as
  // a black layer: animating filter values repaints the whole image a frame.
  const blurAlpha = tween(e, 0, 500, 0, 1, outQuint);
  const scrollAreaH = H - BOTTOM_BAR_H;

  // Panel boxes take their final size at once; only their contents animate.
  let cursor = pad;
  const boxes = scores.map((s, i) => {
    const isSelected = i === selectedIndex;
    if (isSelected) cursor += EXPANDED_PANEL_SPACING;
    const width = isSelected ? EXPANDED_W : CONTRACTED_W;
    const left = cursor - scrollRef.current.current;
    cursor += width + (isSelected ? EXPANDED_PANEL_SPACING : 0) + PANEL_SPACING;
    return { s, left, width, height: isSelected ? EXPANDED_H : CONTRACTED_H, isSelected };
  });
  const listLeft = boxes[selectedIndex]?.left ?? 0;
  listLeftRef.current = listLeft;
  const statistics = statisticsFrame(statisticsOpen, statisticsAnimRef.current, now, listLeft);
  const brightness = Number.isFinite(statisticsAnimRef.current.at) ? statistics.brightness : tween(e, 0, 250, startBrightness, 0.5, linear);
  const selectedScore = scores[selectedIndex] ?? score;

  // OsuScrollContainer's horizontal scrollbar along the list's bottom edge.
  const trackWidth = W;
  const scrollContent = contentWidth + pad * 2;
  const thumbWidth = maxScroll > 0 ? Math.max(30, (W / scrollContent) * trackWidth) : 0;
  const thumbLeft = maxScroll > 0 ? (scrollRef.current.current / maxScroll) * (trackWidth - thumbWidth) : 0;

  // A narrow screen keeps the buttons clear of the back button.
  const sideButtons = (beatmap.beatmapUrl ? 80 : 0) + (beatmap.beatmapsetUrl ? 80 : 0);
  const barInset = W < 300 + sideButtons + 2 * 105 ? 105 : 0;
  const replayButtonWidth = Math.max(75, Math.min(300, W - barInset - 5 - sideButtons - 5));
  const grayButton = (title: string, width: number, icon: ReactNode, onClick: () => void) => (
    <AnimatedButton width={width} height={30} background="#444" title={title} onClick={onClick}>{icon}</AnimatedButton>
  );
  const openExternal = (url: string | null | undefined) => {
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 z-[60] overflow-hidden select-none text-white"
      // The stage under this toggles playback on clicks and taps; nothing
      // done on the results screen may reach it.
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      style={{ fontFamily: TORUS, lineHeight: 1 }}
    >
      <style>{`
        @keyframes lazer-results-flash { from { opacity: 1 } to { opacity: 0 } }
        .lazer-results-flash { animation: lazer-results-flash 800ms cubic-bezier(0.22, 1, 0.36, 1) forwards; }
        .lazer-results-flash-back { animation: lazer-results-flash 500ms cubic-bezier(0.22, 1, 0.36, 1) forwards; }
      `}</style>
      <div className="absolute inset-0 bg-black" style={{ opacity: screenAlpha }}>
        {backgroundUrl && (
          <>
            <img src={backgroundUrl} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" style={{ transform: "scale(1.05)", opacity: 1 - blurAlpha }} />
            <img src={backgroundUrl} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" style={{ transform: "scale(1.05)", filter: `blur(${10 * uiScale}px)`, opacity: blurAlpha, willChange: "opacity" }} />
          </>
        )}
        <div className="absolute inset-0 bg-black" style={{ opacity: 1 - brightness, willChange: "opacity" }} />
      </div>
      {viewport.width > 0 && (
        <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H, transform: `scale(${uiScale})`, transformOrigin: "top left", opacity: screenAlpha }}>
          <div
            style={{ position: "absolute", left: 0, top: 0, width: W, height: scrollAreaH, touchAction: "pan-y" }}
            onPointerDown={handleListPointerDown}
            onPointerMove={handleListPointerMove}
            onPointerUp={handleListPointerUp}
            onPointerCancel={handleListPointerUp}
          >
            {statistics.alpha > 0 && (
              <div
                ref={statisticsScrollRef}
                onClick={toggleStatistics}
                style={{
                  position: "absolute", inset: 0, opacity: statistics.alpha, overflowY: "auto", overscrollBehavior: "contain",
                  paddingLeft: EXPANDED_W + STATISTICS_SIDE_PADDING * 2, paddingRight: STATISTICS_SIDE_PADDING,
                  pointerEvents: statisticsOpen ? "auto" : "none",
                }}
              >
                <div style={{ minHeight: "100%", display: "flex", flexDirection: "column", justifyContent: "center" }}>
                  <StatisticsPanelContent
                    score={selectedScore}
                    onWatchReplay={selectedScore.key === score.key ? onWatchReplay : selectedScore.hasReplay && onWatchScore ? () => onWatchScore(selectedScore) : undefined}
                  />
                </div>
              </div>
            )}
            {boxes.map(({ s, left, width, height, isSelected }) => {
              const anim = animsRef.current.get(s.key)!;
              // Off-screen panels skip their frame entirely.
              if (left + width < -60 || left > W + 60) return null;
              return (
                <div
                  key={s.key}
                  style={{
                    position: "absolute", left: 0, top: 0, width, height,
                    transform: `translate3d(${isSelected ? statistics.x : left}px, ${scrollAreaH / 2 - height / 2}px, 0)`,
                    opacity: isSelected ? 1 : statistics.contracted,
                    pointerEvents: !isSelected && statisticsOpen ? "none" : undefined,
                    zIndex: isSelected ? 1 : undefined,
                    willChange: "transform",
                  }}
                >
                  <ScorePanel
                    score={s}
                    beatmap={beatmap}
                    expanded={isSelected}
                    anim={anim}
                    now={Math.min(now, panelSettleAt(anim))}
                    onPanelClick={handlePanelClick}
                  />
                </div>
              );
            })}
            {thumbWidth > 0 && !statisticsOpen && (
              <div style={{ position: "absolute", left: thumbLeft, bottom: 3, width: thumbWidth, height: 5, borderRadius: 3, background: "rgba(255,255,255,0.9)", opacity: statistics.contracted }} />
            )}
          </div>
          <div style={{ position: "absolute", left: 0, bottom: 0, width: W, height: BOTTOM_BAR_H, background: "#333", display: "flex", alignItems: "center", justifyContent: "center", gap: 5, paddingLeft: barInset, paddingRight: barInset > 0 ? 5 : 0, boxSizing: "border-box" }}>
            {grayButton(t`Watch replay`, replayButtonWidth, <DownloadIcon />, onWatchReplay)}
            {beatmap.beatmapUrl && grayButton(t`Open on osu!`, 75, <BookIcon />, () => openExternal(beatmap.beatmapUrl))}
            {beatmap.beatmapsetUrl && grayButton(t`Favourite on osu!`, 75, <HeartIcon />, () => openExternal(beatmap.beatmapsetUrl))}
          </div>
          <BackButton label={t`back`} onClick={handleBack} e={e} />
        </div>
      )}
    </div>
  );
}
