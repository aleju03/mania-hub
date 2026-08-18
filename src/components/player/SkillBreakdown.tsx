import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { MyDataSkillBreakdown, MyDataSkillMode } from "../../lib/my-data";
import { danBareLabel, danTierColor, danTierSuffix, getDanImageSrc } from "../../lib/dan-images";
import {
  formatTopShare,
  radarAnchor,
  radarLabelDy,
  radarPoints,
  ringPolygon,
  RADAR_RINGS,
  skillModeEntries,
  SKILL_RADAR_PROFILE,
  type SkillAxisEntry,
} from "../../lib/skill-axes";

// Shared renderer for the Etterna-style skill ratings: the My Data "Skill
// rating" card (compact bars) and the public profile Skills tab (radar +
// interactive bars) draw from the same breakdown shape. The axis metadata,
// entry selection and radar geometry live in lib/skill-axes.ts so the
// server-rendered dynamic-render images draw the same chart from the same
// numbers; this file is only the React presentation of them.

function formatDanChip(label: string): string {
  return /^\d/.test(label) ? `${label} dan` : label;
}

// Stale-snapshot marker: the backend is recomputing and the numbers on
// screen may adjust in a moment - showing that beats a silent swap on the
// next visit.
function RefreshingChip({ skills }: { skills: MyDataSkillBreakdown }) {
  if (!skills.stale) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-osu-b3/40 bg-osu-b5/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-osu-l3"
      title="A fresh rating is being computed from the latest plays; these numbers may adjust shortly"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-osu-pink-light" />
      updating
    </span>
  );
}

// Thin-evidence marker: the backend shrinks these ratings toward the
// population median, so the number is an estimate, not a standing.
function ProvisionalChip({ mode }: { mode: MyDataSkillMode }) {
  if (!mode.provisional) return null;
  return (
    <span
      className="inline-flex items-center rounded-md border border-osu-b3/40 bg-osu-b5/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-osu-l3"
      title={`Rated from only ${mode.analyzedPlays} plays - treat as a rough estimate until more ${mode.keyCount}K plays are rated`}
    >
      provisional
    </span>
  );
}

function percentileTitle(entry: SkillAxisEntry, mode: MyDataSkillMode): string | undefined {
  const percentile = mode.percentiles?.[entry.axis];
  if (!percentile) return undefined;
  return `${entry.label}: ${formatTopShare(percentile.value)} of ${percentile.population.toLocaleString("en-US")} tracked ${mode.keyCount}K mains`;
}

function DanChips({ mode }: { mode: MyDataSkillMode }) {
  const dan = mode.dan;
  if (!dan) return null;
  // Non-4K LN sides label on the numbered/greek ladder backend-side (the 7K
  // LN dan series is named like rice), so every keymode shows its LN chip.
  const sides: Array<{ id: string; label: string; side: { rawDan: number; label: string; clears: number } | null }> = [
    { id: "rc", label: "Rice", side: dan.rc },
    { id: "ln", label: "LN", side: dan.ln },
  ];
  const visible = sides.filter((entry) => entry.side != null);
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {visible.map((entry) => {
        const label = entry.side!.label;
        // The course's own logo IS the level, same as the map dan badge; the
        // tier suffix rides top-right like an exponent, colored by where in
        // the level it sits. Keymodes without artwork fall back to the text.
        const image = getDanImageSrc(danBareLabel(label), entry.id === "ln" ? "ln" : undefined, mode.keyCount);
        const suffix = danTierSuffix(label);
        return (
          <span
            key={entry.id}
            className="inline-flex items-center gap-1.5"
            title={`${entry.label} dan estimate: ~${formatDanChip(label)}, backed by ${entry.side!.clears} qualifying clears (96%+ accuracy) on charts around this dan level`}
          >
            <span className="text-[10px] font-semibold uppercase tracking-wide text-osu-f1">{entry.label}</span>
            {image ? (
              <span className="flex items-center gap-0.5">
                <span className="text-[12px] leading-none text-osu-f1">~</span>
                <span className="flex items-start gap-[2px] leading-none">
                  <img src={image} alt={formatDanChip(label)} className="h-9 w-9 object-contain" />
                  {suffix ? (
                    <span
                      className="mt-0.5 text-[14px] font-bold leading-none"
                      style={{ color: danTierColor(suffix) ?? undefined }}
                    >
                      {suffix}
                    </span>
                  ) : null}
                </span>
              </span>
            ) : (
              <span className="text-[12px] font-bold text-osu-l1">~{formatDanChip(label)}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function footnote(skills: MyDataSkillBreakdown, mode: MyDataSkillMode, whose: string): string {
  const parts = [
    `rated from ${mode.analyzedPlays} plays across ${whose} top plays and tracked history, DT and HT at their real rate, accuracy weighted by MAX:300 ratio against each chart's OD windows, unranked vibro charts excluded`,
  ];
  if (skills.pendingPlays > 0) parts.push(`${skills.pendingPlays} still analyzing`);
  if (skills.baseline) parts.push("percentiles are among tracked players");
  return parts.join(" · ");
}

// Cross-keymode scale warning. 4K is rated by MinaCalc, other keymodes by a
// different engine, so the numbers live on unrelated scales; without this,
// players read a lower 7K overall as "the site thinks I'm worse at 7K".
export function KeymodeScaleNote({ className = "" }: { className?: string }) {
  return (
    <div className={`text-[11px] text-osu-l2 ${className}`}>
      Each keymode is rated on its own scale. A lower number in one keymode doesn't mean you're worse at it.
    </div>
  );
}

const SCALE_HINT_SEEN_KEY = "mania-hub-keymode-scale-hint-seen";

// --- Compact card body (My Data) ---

export function SkillBreakdownBody({ skills, mode, own = false }: { skills: MyDataSkillBreakdown | null; mode: MyDataSkillMode | null; own?: boolean }) {
  const whose = own ? "your" : "the";
  // Surface the scale warning at the moment it matters: right after the
  // viewer flips to another keymode tab and is about to compare numbers.
  // It fades back out, and once someone has seen it we assume the point
  // landed - a localStorage flag keeps it from nagging on every tab flip.
  const modeKey = mode?.keyCount ?? null;
  const prevModeKey = useRef<number | null>(null);
  const [showScaleHint, setShowScaleHint] = useState(false);
  useEffect(() => {
    const prev = prevModeKey.current;
    prevModeKey.current = modeKey;
    if (prev == null || modeKey == null || modeKey === prev) return;
    try {
      if (localStorage.getItem(SCALE_HINT_SEEN_KEY)) return;
      localStorage.setItem(SCALE_HINT_SEEN_KEY, "1");
    } catch {
      // Storage unavailable (private mode quirks): fall back to showing it.
    }
    setShowScaleHint(true);
    const timer = setTimeout(() => setShowScaleHint(false), 8000);
    return () => clearTimeout(timer);
  }, [modeKey]);
  const empty = skillEmptyState(skills, mode, own);
  if (empty) return empty;
  const entries = skillModeEntries(mode!);
  const overall = Number(mode!.ratings.Overall ?? 0);
  const overallPercentile = mode!.percentiles?.Overall;
  const max = entries[0]?.value ?? 1;
  return (
    <div>
      {entries[0] ? (
        <div className="mb-2.5 text-[12px] text-osu-l2">
          {own ? "You're strongest" : "Strongest"} in <span className="font-semibold text-white">{entries[0].label}</span>
        </div>
      ) : null}
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[26px] font-bold leading-none text-white tabular-nums">{overall.toFixed(2)}</span>
        <span className="text-[11px] font-semibold uppercase tracking-wide text-osu-l3">overall</span>
        <ProvisionalChip mode={mode!} />
        <RefreshingChip skills={skills!} />
      </div>
      {overallPercentile ? (
        <div className="mb-2.5 text-[11px] text-osu-l2">
          <span className="font-semibold text-osu-pink-light">{formatTopShare(overallPercentile.value)}</span>
          {" "}of {overallPercentile.population.toLocaleString("en-US")} tracked {mode!.keyCount}K mains
        </div>
      ) : (
        <div className="mb-2.5" />
      )}
      <AnimatePresence initial={false}>
        {showScaleHint ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="pb-2.5 text-[11px] text-osu-l2">
              <span className="font-semibold text-white">{mode!.keyCount}K has its own rating scale.</span>{" "}
              A lower number than another keymode doesn't mean you're worse at it.
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <div className="mb-3">
        <DanChips mode={mode!} />
      </div>
      <div className="space-y-2">
        {entries.map((entry) => (
          <div key={entry.key} className="flex items-center gap-2" title={percentileTitle(entry, mode!)}>
            <span className="w-[74px] shrink-0 text-[11px] font-semibold text-osu-l2">{entry.label}</span>
            <span className="h-1.5 min-w-0 flex-1 rounded-full bg-osu-b3/35">
              <span
                className="block h-full rounded-full"
                style={{ width: `${Math.max(4, (entry.value / max) * 100)}%`, backgroundColor: entry.color }}
              />
            </span>
            <span className="w-[42px] shrink-0 text-right text-[11px] text-osu-f1 tabular-nums">{entry.value.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 text-[10px] text-osu-f1">{footnote(skills!, mode!, whose)}</div>
    </div>
  );
}

function skillEmptyState(skills: MyDataSkillBreakdown | null, mode: MyDataSkillMode | null, own: boolean): ReactElement | null {
  const whose = own ? "your" : "the";
  if (!skills || skills.status === "pending") {
    const queue = skills?.queue;
    if (queue?.state === "running") {
      return <div className="text-[12px] text-osu-f1">The chart analyzer is rating {whose} top plays right now.</div>;
    }
    if (queue?.state === "queued" && queue.position != null) {
      return (
        <div className="text-[12px] text-osu-f1">
          {own ? "Your" : "The"} top plays are waiting for the chart analyzer. Position in queue:{" "}
          <span className="text-osu-l2 tabular-nums">{queue.position}</span>
          {queue.waiting > 1 ? <span className="text-osu-f1"> of {queue.waiting}</span> : null}.
        </div>
      );
    }
    return <div className="text-[12px] text-osu-f1">{own ? "Your" : "The"} top plays are being rated by the chart analyzer. The first pass takes a minute or two.</div>;
  }
  if (skills.status === "failed") {
    return <div className="text-[12px] text-osu-f1">Rating {whose} plays failed. It retries automatically, check back in a bit.</div>;
  }
  if (!mode || mode.analyzedPlays === 0) {
    return <div className="text-[12px] text-osu-f1">None of {whose} plays could be rated yet. Converts and unusual keymodes are skipped.</div>;
  }
  return null;
}

// --- Full panel (profile Skills tab): radar + interactive bars ---

const RADAR = SKILL_RADAR_PROFILE;
const RADAR_W = RADAR.width;
const RADAR_H = RADAR.height;
const RADAR_CX = RADAR.cx;
const RADAR_CY = RADAR.cy;
const RADAR_MAX_R = RADAR.maxR;

function SkillRadar({
  entries,
  accent,
  hovered,
  onHover,
}: {
  entries: SkillAxisEntry[];
  accent: string;
  hovered: string | null;
  onHover: (key: string | null) => void;
}) {
  const max = entries.reduce((best, entry) => Math.max(best, entry.value), 1);
  const points = useMemo(() => radarPoints(entries, max, RADAR), [entries, max]);
  const hoveredPoint = points.find((point) => point.entry.key === hovered) ?? null;
  return (
    <svg
      viewBox={`0 0 ${RADAR_W} ${RADAR_H}`}
      className="mx-auto block w-full max-w-[320px]"
      role="img"
      aria-label={`Skill shape: ${entries.map((entry) => `${entry.label} ${entry.value.toFixed(1)}`).join(", ")}`}
      onMouseLeave={() => onHover(null)}
    >
      {RADAR_RINGS.map((fraction) => (
        <polygon key={fraction} points={ringPolygon(entries.length, fraction, RADAR)} fill="none" className="stroke-osu-b3/30" strokeWidth={1} />
      ))}
      {points.map((point) => (
        <line
          key={`spoke-${point.entry.key}`}
          x1={RADAR_CX}
          y1={RADAR_CY}
          x2={RADAR_CX + Math.cos(point.angle) * RADAR_MAX_R}
          y2={RADAR_CY + Math.sin(point.angle) * RADAR_MAX_R}
          className={point.entry.key === hovered ? "stroke-osu-l3/60" : "stroke-osu-b3/30"}
          strokeWidth={1}
        />
      ))}
      <polygon
        points={points.map((point) => `${point.x},${point.y}`).join(" ")}
        fill={accent}
        fillOpacity={0.14}
        stroke={accent}
        strokeWidth={2}
        strokeLinejoin="round"
      />
      {points.map((point) => (
        <circle
          key={`dot-${point.entry.key}`}
          cx={point.x}
          cy={point.y}
          r={point.entry.key === hovered ? 5 : 3}
          fill={point.entry.color}
          className="stroke-osu-b4"
          strokeWidth={2}
        />
      ))}
      {points.map((point) => (
        <text
          key={`label-${point.entry.key}`}
          x={point.labelX}
          y={point.labelY}
          dy={radarLabelDy(point.angle)}
          textAnchor={radarAnchor(point.angle)}
          className={`text-[10px] font-semibold ${point.entry.key === hovered ? "fill-white" : "fill-osu-f1"}`}
        >
          {point.entry.label}
        </text>
      ))}
      {/* Center readout: hovered axis value + population position. */}
      {hoveredPoint ? (
        <g pointerEvents="none">
          <text x={RADAR_CX} y={RADAR_CY - 4} textAnchor="middle" className="fill-white text-[15px] font-bold tabular-nums">
            {hoveredPoint.entry.value.toFixed(2)}
          </text>
          <text x={RADAR_CX} y={RADAR_CY + 12} textAnchor="middle" className="fill-osu-f1 text-[9px] font-semibold uppercase tracking-wide">
            {hoveredPoint.entry.label}
          </text>
        </g>
      ) : null}
      {/* Oversized invisible hit targets, last so they sit on top. */}
      {points.map((point) => (
        <circle
          key={`hit-${point.entry.key}`}
          cx={point.x}
          cy={point.y}
          r={14}
          fill="transparent"
          onMouseEnter={() => onHover(point.entry.key)}
        />
      ))}
    </svg>
  );
}

export function SkillModePanel({
  skills,
  mode,
  onSelectEntry,
}: {
  skills: MyDataSkillBreakdown;
  mode: MyDataSkillMode;
  onSelectEntry?: (entry: SkillAxisEntry, mode: MyDataSkillMode) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const entries = skillModeEntries(mode);
  const accent = entries[0]?.color ?? "#8f6bd8";
  const overall = Number(mode.ratings.Overall ?? 0);
  const overallPercentile = mode.percentiles?.Overall;
  const max = entries[0]?.value ?? 1;
  return (
    <div className="flex h-full flex-col rounded-xl border border-osu-b3/20 bg-osu-b4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="h-3.5 w-1 rounded-full" style={{ backgroundColor: accent }} />
            <span className="text-[11px] font-semibold uppercase tracking-wide text-osu-l3">{mode.keyCount}K skill rating</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-[30px] font-bold leading-none text-white tabular-nums">{overall.toFixed(2)}</span>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-osu-l3">overall</span>
            <ProvisionalChip mode={mode} />
            <RefreshingChip skills={skills} />
          </div>
          {overallPercentile ? (
            <div className="mt-1 text-[11px] text-osu-l2">
              <span className="font-semibold text-osu-pink-light">{formatTopShare(overallPercentile.value)}</span>
              {" "}of {overallPercentile.population.toLocaleString("en-US")} tracked {mode.keyCount}K mains
            </div>
          ) : null}
        </div>
        <DanChips mode={mode} />
      </div>

      <div
        className={`mt-3 grid flex-1 content-center grid-cols-1 items-center gap-4 ${
          entries.length >= 3 ? "sm:grid-cols-[minmax(0,260px)_minmax(0,1fr)]" : ""
        }`}
      >
        {entries.length >= 3 ? (
          <SkillRadar entries={entries} accent={accent} hovered={hovered} onHover={setHovered} />
        ) : null}
        <div className="space-y-0.5" onMouseLeave={() => setHovered(null)}>
          {entries.map((entry) => {
            const percentile = mode.percentiles?.[entry.axis];
            const row = (
              <>
                <span className={`w-[84px] shrink-0 text-[11px] font-semibold ${hovered === entry.key ? "text-white" : "text-osu-l2"}`}>{entry.label}</span>
                <span className="h-1.5 min-w-0 flex-1 rounded-full bg-osu-b3/35">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${Math.max(4, (entry.value / max) * 100)}%`, backgroundColor: entry.color }}
                  />
                </span>
                <span className="w-[44px] shrink-0 text-right text-[11px] text-osu-l2 tabular-nums">{entry.value.toFixed(2)}</span>
                <span className="w-[52px] shrink-0 text-right text-[10px] text-osu-f1 tabular-nums">
                  {percentile ? formatTopShare(percentile.value) : ""}
                </span>
              </>
            );
            const rowClass = `flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-[80ms] ${
              hovered === entry.key ? "bg-osu-b3/30" : ""
            }`;
            // The public profile turns every axis into an explanation of the
            // rating: the strongest plays behind it open in place.
            return onSelectEntry ? (
              <button
                type="button"
                key={entry.key}
                className={rowClass}
                title={`${percentileTitle(entry, mode) ? `${percentileTitle(entry, mode)} · ` : ""}View top ${entry.label.toLowerCase()} plays`}
                onMouseEnter={() => setHovered(entry.key)}
                onClick={() => onSelectEntry(entry, mode)}
              >
                {row}
              </button>
            ) : (
              <div key={entry.key} className={rowClass} title={percentileTitle(entry, mode)} onMouseEnter={() => setHovered(entry.key)}>
                {row}
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-auto pt-3 text-[10px] text-osu-f1">{footnote(skills, mode, "the")}</div>
    </div>
  );
}
