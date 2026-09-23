/* The insight cards' detail modals (mod usage, BPM, PP distribution), shared by
   the player and team profile pages. Each keeps its own view state. */

import { useCallback, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { buildPpCumulativeDistribution, buildPpDistribution } from "../../lib/profile-insights";
import type { InsightScoreSnapshot, OsuScore, UserProfileInsights } from "../../lib/types";
import { ModBadge } from "../ui/ModBadge";
import { KeyModeControl, getAvailableKeyModes, matchesKeyFilter, type KeyFilter } from "./BestScoresControls";

type PpDistributionMode = "bands" | "cumulative";
const PP_DISTRIBUTION_MODE_STORAGE_KEY = "mania-hub-pp-distribution-mode-v1";

function isPpDistributionMode(value: unknown): value is PpDistributionMode {
  return value === "bands" || value === "cumulative";
}

function readPpDistributionModePreference(): PpDistributionMode {
  if (typeof window === "undefined") return "bands";

  try {
    const stored = window.localStorage.getItem(PP_DISTRIBUTION_MODE_STORAGE_KEY);
    return isPpDistributionMode(stored) ? stored : "bands";
  } catch {
    return "bands";
  }
}

function writePpDistributionModePreference(mode: PpDistributionMode): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(PP_DISTRIBUTION_MODE_STORAGE_KEY, mode);
  } catch {
    // Preference storage is best-effort; the modal still works normally.
  }
}

const MOD_USAGE_COLORS: Record<string, string> = {
  NM: "#4d8dff",
  NC: "#aa88ff",
  DT: "#ff6666",
  HR: "#ff6666",
  SD: "#ff6666",
  PF: "#ffcc22",
  AC: "#ff6666",
  BL: "#ff6666",
  ST: "#ff6666",
  MU: "#ff6666",
  EZ: "#b3d944",
  NF: "#b3d944",
  HT: "#b3d944",
  DC: "#b3d944",
  NR: "#b3d944",
  HD: "#ffcc22",
  FL: "#ffcc22",
  FI: "#ffcc22",
  AP: "#66ccff",
  RX: "#66ccff",
  SO: "#66ccff",
  RD: "#66ccff",
  AT: "#66ccff",
  CN: "#66ccff",
  MR: "#66ccff",
  AS: "#66ccff",
  CS: "#66ccff",
  TD: "#ff66aa",
  CL: "#aa88ff",
  CO: "#ffcc22",
  SV2: "#ffcc22",
};

function getModUsageColor(mod: string, fallbackIndex: number): string {
  const fallbackPalette = ["#ff66aa", "#ffcc22", "#34d399", "#fb923c", "#f472b6", "#22d3ee"];
  return MOD_USAGE_COLORS[mod] ?? fallbackPalette[fallbackIndex % fallbackPalette.length];
}

const PP_DISTRIBUTION_COLORS = [
  "var(--color-osu-purple-light)",
  "var(--color-osu-pink-light)",
  "var(--color-osu-orange)",
  "var(--color-osu-yellow)",
  "var(--color-osu-blue)",
  "var(--color-osu-green-light)",
];

function getPpDistributionColor(index: number, isBelowBucket: boolean): string {
  if (isBelowBucket) return "var(--color-osu-f1)";
  return PP_DISTRIBUTION_COLORS[Math.min(index, PP_DISTRIBUTION_COLORS.length - 1)];
}

function formatPpDistributionLabel(entry: UserProfileInsights["ppDistribution"][number]): string {
  if (entry.min == null) return `below ${(entry.max ?? 399) + 1}`;
  if (entry.max == null) return `${entry.min}+`;
  return `${entry.min}-${entry.max}`;
}

function formatPpCumulativeDistributionLabel(threshold: number): string {
  return `${threshold}+`;
}

function formatPpDistributionPercent(count: number, total: number): string {
  if (total <= 0) return "0%";
  return `${((count / total) * 100).toLocaleString("en-US", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  })}%`;
}

function BpmExtremeRow({ label, bpm, snapshot }: { label: string; bpm: number; snapshot: InsightScoreSnapshot }) {
  const { t } = useLingui();
  const backgroundImage = snapshot.coverUrl
    ? `linear-gradient(90deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.60) 50%, rgba(0,0,0,0.80) 100%), url(${JSON.stringify(snapshot.coverUrl)})`
    : "linear-gradient(90deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.60) 50%, rgba(0,0,0,0.80) 100%)";

  return (
    <a
      href={snapshot.beatmapUrl}
      target="_blank"
      rel="noreferrer"
      className="block relative rounded-lg overflow-hidden border border-osu-b3/20 hover:border-osu-pink/30 transition-colors"
      style={{ backgroundImage, backgroundSize: "cover", backgroundPosition: "center" }}
    >
      <div className="relative p-2.5 flex items-center gap-2.5">
        <div className="flex-shrink-0 text-center w-14">
          <div className="text-[9px] uppercase tracking-wider text-osu-f1 font-semibold">{label}</div>
          <div className="text-lg font-bold text-white leading-none tabular-nums mt-0.5">{Math.round(bpm)}</div>
          <div className="text-[9px] text-osu-f1">{t`BPM`}</div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold text-white truncate">{snapshot.title}</div>
          <div className="text-[10px] text-osu-l2 truncate">{snapshot.artist} [{snapshot.version}]</div>
          {snapshot.mods.length > 0 && (
            <div className="mt-1 flex items-center gap-1 flex-wrap">
              {snapshot.mods.map((mod) => (
                <ModBadge key={mod} mod={mod} size={0.7} />
              ))}
            </div>
          )}
        </div>
      </div>
    </a>
  );
}

export function ModUsageModal({ insights, onClose }: { insights: UserProfileInsights; onClose: () => void }) {
  const { t } = useLingui();
  const profileInsights = insights;
  const [includeNoModUsage, setIncludeNoModUsage] = useState(false);
  const [hoveredMod, setHoveredMod] = useState<string | null>(null);
  const setModModalOpen = (_open: false) => onClose();
  return (
  <motion.div
    className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm bg-black/75 cursor-pointer"
    onClick={() => { setModModalOpen(false); setHoveredMod(null); }}
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.2 }}
  >
    <motion.div
      className="relative bg-osu-b4 border border-osu-b3/20 rounded-2xl p-5 w-[380px] max-h-[85vh] overflow-y-auto shadow-[0_12px_60px_rgba(0,0,0,0.7)] cursor-default"
      onClick={(e) => e.stopPropagation()}
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0.9, opacity: 0 }}
      transition={{ type: "spring", damping: 30, stiffness: 500 }}
    >
      <button
        type="button"
        onClick={() => { setModModalOpen(false); setHoveredMod(null); }}
        aria-label={t`Close`}
        className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-full text-osu-f1 hover:text-white hover:bg-osu-b3/50 transition-colors cursor-pointer"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M1 1l12 12M13 1L1 13" />
        </svg>
      </button>
      {(() => {
        const noModCount = profileInsights.sampleSize - (profileInsights.mostUsedMod?.total ?? 0);
        const usageSampleSize = includeNoModUsage
          ? profileInsights.sampleSize
          : Math.max(profileInsights.sampleSize - noModCount, 0);
        const entries = [
          ...profileInsights.modBreakdown,
          ...(includeNoModUsage && noModCount > 0 ? [{ label: "NM", count: noModCount, total: profileInsights.sampleSize }] : []),
        ].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

        const colored = entries.map((e, index) => ({
          ...e,
          color: getModUsageColor(e.label, index),
          pct: usageSampleSize > 0 ? (e.count / usageSampleSize) * 100 : 0,
        }));

        const cx = 110, cy = 110, ro = 96, ri = 62;
        const polar = (r: number, deg: number) => {
          const rad = ((deg - 90) * Math.PI) / 180;
          return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
        };
        const slicePath = (start: number, end: number, ringOuter: number, ringInner: number) => {
          const so = polar(ringOuter, end);
          const eo = polar(ringOuter, start);
          const si = polar(ringInner, start);
          const ei = polar(ringInner, end);
          const large = end - start <= 180 ? 0 : 1;
          return `M ${so.x} ${so.y} A ${ringOuter} ${ringOuter} 0 ${large} 0 ${eo.x} ${eo.y} L ${si.x} ${si.y} A ${ringInner} ${ringInner} 0 ${large} 1 ${ei.x} ${ei.y} Z`;
        };
        const fullDonut = `M ${cx - ro} ${cy} A ${ro} ${ro} 0 1 0 ${cx + ro} ${cy} A ${ro} ${ro} 0 1 0 ${cx - ro} ${cy} Z M ${cx - ri} ${cy} A ${ri} ${ri} 0 1 1 ${cx + ri} ${cy} A ${ri} ${ri} 0 1 1 ${cx - ri} ${cy} Z`;

        // Normalize slice angles by total mod-usages (not sampleSize): plays
        // can stack mods so counts can sum to >100%. Without this the last
        // slice wraps past 360° and overlaps the first one.
        const totalCount = colored.reduce((sum, e) => sum + e.count, 0) || 1;
        let acc = 0;
        const slices = colored.map((entry) => {
          const start = (acc / totalCount) * 360;
          acc += entry.count;
          const end = (acc / totalCount) * 360;
          return { ...entry, start, end };
        });
        const singleSlice = slices.length === 1;
        const focused = hoveredMod ? slices.find((s) => s.label === hoveredMod) : null;
        const HOVER_OFFSET = 8;
        const stacks = totalCount - usageSampleSize;

        return (
          <>
            <div className="pr-8 flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">{t`Mod Usage`}</div>
                <div className="mt-0.5 text-[11px] text-osu-f1/60 flex items-center gap-1.5 flex-wrap">
                  <span>{includeNoModUsage
                    ? t`across ${usageSampleSize} top plays`
                    : t`across ${usageSampleSize} modded top plays`}</span>
                  {stacks > 0 && (
                    <span
                      className="px-1.5 py-[1px] rounded bg-osu-b3/40 text-[9px] font-semibold uppercase tracking-wider text-osu-f1 cursor-help"
                      title={t`${stacks} extra mod-uses from plays that stack mods (e.g. DT+MR). Slice sizes show share of mod-uses; percentages show share of plays.`}
                    >
                      <Trans>+{stacks} stacked</Trans>
                    </span>
                  )}
                </div>
              </div>
              {noModCount > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setIncludeNoModUsage((value) => !value);
                    setHoveredMod(null);
                  }}
                  aria-pressed={includeNoModUsage}
                  title={includeNoModUsage ? t`NM is included in mod usage` : t`NM is excluded from mod usage`}
                  className={`mt-0.5 flex h-6 flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-1.5 text-[9px] font-semibold uppercase tracking-wider transition-colors hover:text-white ${includeNoModUsage
                      ? "border-osu-green-light/45 bg-osu-green-light/12 text-osu-green-light hover:border-osu-green-light/65 hover:bg-osu-green-light/18"
                      : "border-osu-b2/60 bg-osu-b3/30 text-osu-f1 hover:border-osu-b1/80 hover:bg-osu-b3/50"
                    }`}
                >
                  <span>NM</span>
                  <span
                    className={`relative h-3.5 w-7 rounded-full transition-colors ${includeNoModUsage ? "bg-osu-green-light/80 shadow-[0_0_0_1px_rgba(179,217,68,0.28)]" : "bg-osu-b2"
                      }`}
                    aria-hidden="true"
                  >
                    <span
                      className="absolute left-0.5 top-0.5 h-2.5 w-2.5 rounded-full bg-white/95 transition-transform"
                      style={{ transform: includeNoModUsage ? "translateX(14px)" : "translateX(0)" }}
                    />
                  </span>
                </button>
              )}
            </div>
            <div className="mt-3 flex justify-center">
              <svg viewBox="0 0 220 220" className="w-52 h-52" onMouseLeave={() => setHoveredMod(null)}>
                {singleSlice ? (
                  <path d={fullDonut} fill={slices[0].color} fillRule="evenodd" />
                ) : (
                  slices.map((s) => {
                    const isFocused = hoveredMod === s.label;
                    const dimmed = hoveredMod != null && !isFocused;
                    const midRad = (((s.start + s.end) / 2 - 90) * Math.PI) / 180;
                    const dx = isFocused ? Math.cos(midRad) * HOVER_OFFSET : 0;
                    const dy = isFocused ? Math.sin(midRad) * HOVER_OFFSET : 0;
                    return (
                      <path
                        key={s.label}
                        d={slicePath(s.start, s.end, ro, ri)}
                        fill={s.color}
                        stroke="var(--color-osu-b4)"
                        strokeWidth={2}
                        strokeLinejoin="round"
                        transform={`translate(${dx} ${dy})`}
                        style={{
                          opacity: dimmed ? 0.25 : 1,
                          transition: "opacity 150ms, transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1)",
                          cursor: "pointer",
                        }}
                        onMouseEnter={() => setHoveredMod(s.label)}
                      />
                    );
                  })
                )}
                {focused ? (
                  <>
                    <text x={cx} y={cy - 14} textAnchor="middle" fill={focused.color} style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1 }}>
                      {focused.label}
                    </text>
                    <text x={cx} y={cy + 8} textAnchor="middle" fill="#fff" style={{ fontSize: 26, fontWeight: 800 }}>
                      {Math.round(focused.pct)}%
                    </text>
                    <text x={cx} y={cy + 24} textAnchor="middle" fill="var(--color-osu-f1)" style={{ fontSize: 10 }}>
                      <Trans>{focused.count} of {usageSampleSize}</Trans>
                    </text>
                  </>
                ) : (
                  <>
                    <text x={cx} y={cy + 2} textAnchor="middle" fill="#fff" style={{ fontSize: 28, fontWeight: 800 }}>
                      {usageSampleSize}
                    </text>
                    <text x={cx} y={cy + 20} textAnchor="middle" fill="var(--color-osu-f1)" style={{ fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase" }}>
                      {includeNoModUsage ? t`top plays` : t`modded plays`}
                    </text>
                  </>
                )}
              </svg>
            </div>
            <div className="mt-4 flex flex-col gap-1">
              {slices.map((entry) => {
                const isFocused = hoveredMod === entry.label;
                const dimmed = hoveredMod != null && !isFocused;
                return (
                  <button
                    key={entry.label}
                    type="button"
                    onMouseEnter={() => setHoveredMod(entry.label)}
                    onMouseLeave={() => setHoveredMod(null)}
                    className="group flex items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-osu-b3/30"
                    style={{ opacity: dimmed ? 0.4 : 1, transition: "opacity 150ms, background-color 150ms" }}
                  >
                    <span
                      className="h-7 w-1 rounded-full flex-shrink-0"
                      style={{ backgroundColor: entry.color, boxShadow: isFocused ? `0 0 8px ${entry.color}` : undefined }}
                    />
                    <ModBadge mod={entry.label} size={0.85} color={entry.color} />
                    <div className="flex-1 h-1 rounded-full bg-osu-b3/40 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${entry.pct}%`, backgroundColor: entry.color }} />
                    </div>
                    <div className="flex items-baseline gap-1.5 tabular-nums w-16 justify-end">
                      <span className="text-sm font-bold text-white">{Math.round(entry.pct)}%</span>
                      <span className="text-[10px] text-osu-f1/70">{entry.count}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        );
      })()}
    </motion.div>
  </motion.div>
  );
}

export function BpmBreakdownModal({ insights, onClose }: { insights: UserProfileInsights; onClose: () => void }) {
  const { t } = useLingui();
  const profileInsights = insights;
  const setBpmModalOpen = (_open: false) => onClose();
  return (
  <motion.div
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 sm:backdrop-blur-sm cursor-pointer p-4"
    onClick={() => setBpmModalOpen(false)}
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.2 }}
  >
    <motion.div
      className="modal-card-mobile-safe relative isolate bg-osu-b4 border border-osu-b3/20 rounded-2xl w-[420px] max-w-full max-h-[85vh] overflow-hidden shadow-[0_12px_60px_rgba(0,0,0,0.7)] cursor-default"
      onClick={(e) => e.stopPropagation()}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
    >
      <div className="pointer-events-none absolute inset-0 bg-osu-b4" aria-hidden="true" />
      <button
        type="button"
        onClick={() => setBpmModalOpen(false)}
        aria-label={t`Close`}
        className="absolute top-3 right-3 z-20 w-7 h-7 flex items-center justify-center rounded-full text-osu-f1 hover:text-white hover:bg-osu-b3/50 transition-colors cursor-pointer"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M1 1l12 12M13 1L1 13" />
        </svg>
      </button>
      <div className="relative z-10 max-h-[85vh] overflow-y-auto p-5 [scrollbar-gutter:stable]">
        <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">{t`BPM Breakdown`}</div>
        <div className="mt-0.5 text-[11px] text-osu-f1/60">
          <Trans>across {profileInsights.sampleSize} top plays · note-density tempo where available · adjusted for rate mods · weighted toward your highest plays</Trans>
        </div>

        <div className="mt-4 flex items-baseline gap-2">
          <span className="text-2xl font-bold text-white">{Math.round(profileInsights.medianBpm ?? 0)}</span>
          <span className="text-[11px] text-osu-f1">{t`median BPM`}</span>
        </div>

        {profileInsights.bpmByKeyMode && profileInsights.bpmByKeyMode.length > 1 && (
          <div className="mt-4">
            <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold mb-2">{t`Median by Keymode`}</div>
            <div className="space-y-2">
              {(() => {
                const maxMedian = Math.max(...profileInsights.bpmByKeyMode.map((b) => b.median));
                return profileInsights.bpmByKeyMode.map((bucket) => {
                  const pct = maxMedian > 0 ? (bucket.median / maxMedian) * 100 : 0;
                  return (
                    <div key={bucket.keyCount} className="flex items-center gap-2.5">
                      <span className="text-xs font-semibold text-white w-8 tabular-nums">{bucket.keyCount}K</span>
                      <div className="flex-1 h-1.5 rounded-full bg-osu-b3/40 overflow-hidden">
                        <div className="h-full rounded-full bg-osu-yellow" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-[11px] text-osu-f1 tabular-nums w-20 text-right">
                        {Math.round(bucket.median)} ({bucket.count})
                      </span>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}

        {profileInsights.bpmRange?.minScore && profileInsights.bpmRange?.maxScore && (
          <div className="mt-4">
            <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold mb-2">{t`Range`}</div>
            <div className="space-y-2">
              <BpmExtremeRow label={t`Slowest`} bpm={profileInsights.bpmRange.min} snapshot={profileInsights.bpmRange.minScore} />
              <BpmExtremeRow label={t`Fastest`} bpm={profileInsights.bpmRange.max} snapshot={profileInsights.bpmRange.maxScore} />
            </div>
          </div>
        )}
      </div>
    </motion.div>
  </motion.div>
  );
}

export function PpDistributionModal({ insights, scores, onClose }: { insights: UserProfileInsights; scores: OsuScore[]; onClose: () => void }) {
  const { t } = useLingui();
  const profileInsights = insights;
  const setPpModalOpen = (_open: false) => onClose();
  const [ppDistributionMode, setPpDistributionModeState] = useState<PpDistributionMode>(() =>
    readPpDistributionModePreference(),
  );
  const [ppKeyFilter, setPpKeyFilter] = useState<KeyFilter>("all");
  const ppManiaBestScores = useMemo(
    () => scores.filter((score) => score.beatmap?.mode === "mania"),
    [scores],
  );
  const ppAvailableKeyModes = useMemo(
    () => getAvailableKeyModes(ppManiaBestScores),
    [ppManiaBestScores],
  );
  const ppKeyFilterActive: KeyFilter =
    ppKeyFilter !== "all" && !ppAvailableKeyModes.includes(ppKeyFilter) ? "all" : ppKeyFilter;
  const ppModalDistribution = useMemo(() => {
    const scoped = ppManiaBestScores.filter((score) => matchesKeyFilter(score, ppKeyFilterActive));
    const ppValues = scoped
      .map((score) => score.pp)
      .filter((pp): pp is number => pp != null && pp > 0)
      .sort((a, b) => b - a);
    return {
      bands: buildPpDistribution(ppValues),
      cumulative: buildPpCumulativeDistribution(scoped),
      top: ppValues[0] ?? null,
      bottom: ppValues.length ? ppValues[ppValues.length - 1] : null,
    };
  }, [ppManiaBestScores, ppKeyFilterActive]);
  const setPpDistributionMode = useCallback((mode: PpDistributionMode) => {
    setPpDistributionModeState(mode);
    writePpDistributionModePreference(mode);
  }, []);
  return (
  <motion.div
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 sm:backdrop-blur-sm cursor-pointer p-4"
    onClick={() => setPpModalOpen(false)}
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.2 }}
  >
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={t`PP distribution`}
      className="modal-card-mobile-safe relative isolate bg-osu-b4 border border-osu-b3/20 rounded-2xl w-[420px] max-w-full max-h-[85vh] overflow-hidden shadow-[0_12px_60px_rgba(0,0,0,0.7)] cursor-default"
      onClick={(e) => e.stopPropagation()}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
    >
      <div className="pointer-events-none absolute inset-0 bg-osu-b4" aria-hidden="true" />
      <button
        type="button"
        onClick={() => setPpModalOpen(false)}
        aria-label={t`Close`}
        className="absolute top-3 right-3 z-20 w-7 h-7 flex items-center justify-center rounded-full text-osu-f1 hover:text-white hover:bg-osu-b3/50 transition-colors cursor-pointer"
      >
        <X size={14} />
      </button>
      <div className="relative z-10 max-h-[85vh] overflow-y-auto p-5 [scrollbar-gutter:stable]">
        {(() => {
          const ppDistribution = ppModalDistribution.bands;
          const ppCumulativeDistribution = ppModalDistribution.cumulative;
          const ppTotal = ppDistribution[0]?.total ?? 0;
          const ppTop = ppModalDistribution.top ?? profileInsights.ppRange?.top ?? 0;
          const ppBottom = ppModalDistribution.bottom ?? profileInsights.ppRange?.bottom ?? 0;
          const showCumulative = ppDistributionMode === "cumulative" && ppCumulativeDistribution.length > 0;
          const ppRows = showCumulative
            ? ppCumulativeDistribution.map((entry, index) => ({
                key: `cumulative:${entry.threshold}`,
                label: formatPpCumulativeDistributionLabel(entry.threshold),
                count: entry.count,
                total: entry.total,
                color: getPpDistributionColor(index, false),
              }))
            : ppDistribution.map((entry, index) => ({
                key: `${entry.min ?? "below"}:${entry.max ?? "up"}`,
                label: formatPpDistributionLabel(entry),
                count: entry.count,
                total: ppTotal,
                color: getPpDistributionColor(index, entry.min == null),
              }));

          return (
            <>
              <div className="pr-8 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">{t`PP Distribution`}</div>
                  <div className="mt-0.5 text-[11px] text-osu-f1/60">
                    <Trans>across {ppTotal} profile top plays with PP</Trans>
                  </div>
                </div>
                <div className="inline-flex w-fit items-center gap-0.5 rounded-lg border border-osu-b3/20 bg-osu-b4/60 p-0.5">
                  {(["bands", "cumulative"] as const).map((mode) => {
                    const active = ppDistributionMode === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setPpDistributionMode(mode)}
                        aria-pressed={active}
                        className={`rounded-md px-2 py-1 text-[10px] font-semibold transition-colors cursor-pointer ${active
                          ? "bg-osu-pink/15 text-osu-pink-light"
                          : "text-osu-f1 hover:bg-osu-b3/40 hover:text-osu-l2"
                        }`}
                      >
                        {mode === "bands" ? t`Bands` : t`Cumulative`}
                      </button>
                    );
                  })}
                </div>
              </div>

              {ppAvailableKeyModes.length > 1 && (
                <div className="mt-3">
                  <KeyModeControl
                    availableKeyModes={ppAvailableKeyModes}
                    keyFilter={ppKeyFilterActive}
                    onChangeKeyFilter={setPpKeyFilter}
                  />
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-2xl font-bold text-osu-pink-light tabular-nums">{Math.round(ppTop)}</span>
                <span className="text-[11px] text-osu-f1">{t`top pp`}</span>
                <span className="text-osu-f1/40">/</span>
                <span className="text-xl font-bold text-white tabular-nums">{Math.round(ppBottom)}</span>
                <span className="text-[11px] text-osu-f1">{t`bottom pp`}</span>
              </div>

              <div className="mt-4 space-y-2">
                {ppRows.map((entry) => {
                  const pct = entry.total > 0 ? (entry.count / entry.total) * 100 : 0;
                  const fillWidth = entry.count > 0 ? Math.max(4, pct) : 0;

                  return (
                    <div key={entry.key} className="rounded-lg px-2.5 py-2 transition-colors hover:bg-osu-b3/25">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-sm font-bold text-white tabular-nums">{entry.label}</span>
                          <span className="text-[10px] text-osu-f1">pp</span>
                        </div>
                        <div className="flex items-baseline gap-1.5 tabular-nums">
                          <span className="text-sm font-bold text-white">{entry.count}</span>
                          <span className="text-[10px] text-osu-f1"><Plural value={entry.count} one="play" other="plays" /></span>
                          <span className="text-[10px] text-osu-f1/60">({formatPpDistributionPercent(entry.count, entry.total)})</span>
                        </div>
                      </div>
                      <div className="mt-1.5 h-1.5 rounded-full bg-osu-b3/40 overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${fillWidth}%`, backgroundColor: entry.color }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          );
        })()}
      </div>
    </motion.div>
  </motion.div>
  );
}
