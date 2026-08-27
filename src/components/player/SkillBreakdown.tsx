import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { MyDataSkillBreakdown, MyDataSkillMode } from "../../lib/my-data";
import { danBareLabel } from "../../lib/dan-images";
import { formatAccuracy } from "../../lib/format";
import { DanLevelBadge } from "./DanLevelBadge";
import {
  lnPlayShare,
  radarAnchor,
  radarLabelDy,
  radarPoints,
  ringPolygon,
  RADAR_RINGS,
  skillModeEntries,
  SKILL_RADAR_PROFILE,
  topSharePercent,
  type SkillAxisEntry,
} from "../../lib/skill-axes";

// Shared renderer for the Etterna-style skill ratings: the My Data "Skill
// rating" card (compact bars) and the public profile Skills tab (radar +
// interactive bars) draw from the same breakdown shape. The axis metadata,
// entry selection and radar geometry live in lib/skill-axes.ts so the
// server-rendered dynamic-render images draw the same chart from the same
// numbers; this file is only the React presentation of them.

// Stale-snapshot marker: the backend is recomputing and the numbers on
// screen may adjust in a moment - showing that beats a silent swap on the
// next visit.
function RefreshingChip({ skills }: { skills: MyDataSkillBreakdown }) {
  const { t } = useLingui();
  if (!skills.stale) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-osu-b3/40 bg-osu-b5/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-osu-l3"
      title={t`A fresh rating is being computed from the latest plays; these numbers may adjust shortly`}
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-osu-pink-light" />
      <Trans>updating</Trans>
    </span>
  );
}

// Thin-evidence marker: the backend shrinks these ratings toward the
// population median, so the number is an estimate, not a standing.
function ProvisionalChip({ mode }: { mode: MyDataSkillMode }) {
  const { t } = useLingui();
  if (!mode.provisional) return null;
  const plays = mode.analyzedPlays;
  const keyCount = mode.keyCount;
  return (
    <span
      className="inline-flex items-center rounded-md border border-osu-b3/40 bg-osu-b5/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-osu-l3"
      title={t`Rated from only ${plays} plays - treat as a rough estimate until more ${keyCount}K plays are rated`}
    >
      <Trans>provisional</Trans>
    </span>
  );
}

// The LN row's context line (4K only, see lnPlayShare): the LN number mostly
// reflects what the player plays, so the share is shown as data next to it.
// "Are LN charts", because the ln tag itself is gated to the analyzer's LN
// verdict (the backend's LN_PATTERN_LN_RATIO_MIN on the chart's hold share):
// this count, the LN bar and the top LN plays list are all the same plays.
function LnShareNote({ mode, className = "" }: { mode: MyDataSkillMode; className?: string }) {
  const share = lnPlayShare(mode);
  if (share == null) return null;
  const percent = Math.round(share * 100);
  const lnPlays = (mode.patterns ?? []).find((entry) => entry.id === "ln")?.plays ?? 0;
  const total = mode.analyzedPlays;
  return (
    <div className={`text-[11px] text-osu-l2 ${className}`}>
      <Trans><span className="font-semibold text-white tabular-nums">{percent}%</span> of the rated plays are LN charts ({lnPlays} of {total})</Trans>
    </div>
  );
}

function percentileTitle(entry: SkillAxisEntry, mode: MyDataSkillMode, i18n: I18n): string | undefined {
  const percentile = mode.percentiles?.[entry.axis];
  if (!percentile) return undefined;
  const label = i18n._(entry.labelMsg);
  const share = i18n._(msg`top ${topSharePercent(percentile.value)}%`);
  const population = percentile.population.toLocaleString("en-US");
  const keyCount = mode.keyCount;
  return i18n._(msg`${label}: ${share} of ${population} tracked ${keyCount}K mains`);
}

function DanChips({ mode, onSelect }: { mode: MyDataSkillMode; onSelect?: (side: "rc" | "ln") => void }) {
  const { t, i18n } = useLingui();
  const dan = mode.dan;
  if (!dan) return null;
  // A numbered course reads as a level, not a name, so it needs the word;
  // named ladders (greek letters and the like) already read as one.
  const formatDanChip = (label: string): string => (/^\d/.test(label) ? t`${label} dan` : label);
  // Non-4K LN sides label on the numbered/greek ladder backend-side (the 7K
  // LN dan series is named like the regular one), so every keymode shows its
  // LN chip.
  const sides: Array<{
    id: "rc" | "ln";
    label: MessageDescriptor;
    side: {
      rawDan: number;
      label: string;
      clears: number;
      beyondTable?: boolean;
      courseClear?: { courseName: string; accuracy: number };
    } | null;
  }> = [
    { id: "rc", label: msg`Regular`, side: dan.rc },
    { id: "ln", label: msg`LN`, side: dan.ln },
  ];
  const visible = sides.filter((entry) => entry.side != null);
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {visible.map((entry) => {
        // Past the ladder's last level the backend has nothing left to
        // measure with, so the chip reads "> 9th" instead of dressing the
        // ceiling up as a tier ("9++") the estimate never actually earned.
        const beyond = entry.side!.beyondTable === true;
        const label = beyond ? danBareLabel(entry.side!.label) : entry.side!.label;
        const sideLabel = i18n._(entry.label);
        const chip = formatDanChip(label);
        const clears = entry.side!.clears;
        // A course clear can floor the estimate above every rated pass the
        // player has, which leaves `clears` at 0 - true, and unreadable next
        // to an 8th dan chip. When a course set the level, the tooltip names
        // the course instead of counting passes that are not what backs it.
        const courseClear = entry.side!.courseClear ?? null;
        const courseName = courseClear?.courseName ?? "";
        const courseAccuracy = courseClear ? formatAccuracy(courseClear.accuracy) : "";
        const body = (
          <>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-osu-f1">{sideLabel}</span>
            <DanLevelBadge
              label={entry.side!.label}
              keyCount={mode.keyCount}
              side={entry.id}
              beyondTable={beyond}
              formatLabel={formatDanChip}
            />
          </>
        );
        const keys = mode.keyCount;
        /* `clears` is NOT the player's qualifying total: it counts the clears
           that reach the estimate, which on a side falling back to the quorum
           rule is 4 by construction. Phrased as "backed by N qualifying
           clears" it read as "this player has only 4", when the evidence modal
           right behind it shows 151. Say what the number actually measures -
           passes at or above this level - and leave the total to the modal,
           which re-derives it. */
        const title = courseClear
          ? onSelect
            ? t`${sideLabel} dan estimate: ~${chip}, set by their clear of ${courseName} at ${courseAccuracy} · click for the clears behind it`
            : t`${sideLabel} dan estimate: ~${chip}, set by their clear of ${courseName} at ${courseAccuracy}`
          : beyond
          ? onSelect
            ? t`${sideLabel} dan estimate: above ${chip}, where the ${keys}K ${sideLabel} course ladder ends, with ${clears} passes at or above it (96%+ accuracy) · click for the clears behind it`
            : t`${sideLabel} dan estimate: above ${chip}, where the ${keys}K ${sideLabel} course ladder ends, with ${clears} passes at or above it (96%+ accuracy)`
          : onSelect
            ? t`${sideLabel} dan estimate: ~${chip}, with ${clears} passes at or above this level (96%+ accuracy) · click for the clears behind it`
            : t`${sideLabel} dan estimate: ~${chip}, with ${clears} passes at or above this level (96%+ accuracy)`;
        return onSelect ? (
          <button
            type="button"
            key={entry.id}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md transition-opacity hover:opacity-80"
            title={title}
            onClick={() => onSelect(entry.id)}
          >
            {body}
          </button>
        ) : (
          <span key={entry.id} className="inline-flex items-center gap-1.5" title={title}>
            {body}
          </span>
        );
      })}
    </div>
  );
}

// The two `own` variants spell the whole sentence out rather than swapping a
// "your"/"the" fragment into one: possessives do not slot into other
// languages the way they do into English.
function footnote(skills: MyDataSkillBreakdown, mode: MyDataSkillMode, own: boolean, i18n: I18n): string {
  const plays = mode.analyzedPlays;
  const parts = [
    own
      ? i18n._(msg`rated from ${plays} plays across your top plays and tracked history, DT and HT at their real rate, accuracy weighted by MAX:300 ratio against each chart's OD windows, unranked vibro charts excluded`)
      : i18n._(msg`rated from ${plays} plays across the top plays and tracked history, DT and HT at their real rate, accuracy weighted by MAX:300 ratio against each chart's OD windows, unranked vibro charts excluded`),
  ];
  const pending = skills.pendingPlays;
  if (pending > 0) parts.push(i18n._(msg`${pending} still analyzing`));
  if (skills.baseline) parts.push(i18n._(msg`percentiles are among tracked players`));
  return parts.join(" · ");
}

const SCALE_HINT_SEEN_KEY = "mania-hub-keymode-scale-hint-seen";

// --- Compact card body (My Data) ---

export function SkillBreakdownBody({ skills, mode, own = false }: { skills: MyDataSkillBreakdown | null; mode: MyDataSkillMode | null; own?: boolean }) {
  const { i18n } = useLingui();
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
          {own ? (
            <Trans>You're strongest in <span className="font-semibold text-white">{i18n._(entries[0].labelMsg)}</span></Trans>
          ) : (
            <Trans>Strongest in <span className="font-semibold text-white">{i18n._(entries[0].labelMsg)}</span></Trans>
          )}
        </div>
      ) : null}
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[26px] font-bold leading-none text-white tabular-nums">{overall.toFixed(2)}</span>
        <span className="text-[11px] font-semibold uppercase tracking-wide text-osu-l3"><Trans>overall</Trans></span>
        <ProvisionalChip mode={mode!} />
        <RefreshingChip skills={skills!} />
      </div>
      {overallPercentile ? (
        <div className="mb-2.5 text-[11px] text-osu-l2">
          <Trans>
            <span className="font-semibold text-osu-pink-light">top {topSharePercent(overallPercentile.value)}%</span>
            {" "}of {overallPercentile.population.toLocaleString("en-US")} tracked {mode!.keyCount}K mains
          </Trans>
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
              <Trans>
                <span className="font-semibold text-white">{mode!.keyCount}K has its own rating scale.</span>{" "}
                A lower number than another keymode doesn't mean you're worse at it.
              </Trans>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <div className="mb-3">
        <DanChips mode={mode!} />
      </div>
      <div className="space-y-2">
        {entries.map((entry) => (
          <div key={entry.key} className="flex items-center gap-2" title={percentileTitle(entry, mode!, i18n)}>
            <span className="w-[74px] shrink-0 text-[11px] font-semibold text-osu-l2">{i18n._(entry.labelMsg)}</span>
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
      <LnShareNote mode={mode!} className="mt-2" />
      <div className="mt-3 text-[10px] text-osu-f1">{footnote(skills!, mode!, own, i18n)}</div>
    </div>
  );
}

function skillEmptyState(skills: MyDataSkillBreakdown | null, mode: MyDataSkillMode | null, own: boolean): ReactElement | null {
  if (!skills || skills.status === "pending") {
    const queue = skills?.queue;
    if (queue?.state === "running") {
      return (
        <div className="text-[12px] text-osu-f1">
          {own ? (
            <Trans>The chart analyzer is rating your top plays right now.</Trans>
          ) : (
            <Trans>The chart analyzer is rating the top plays right now.</Trans>
          )}
        </div>
      );
    }
    if (queue?.state === "queued" && queue.position != null) {
      const position = <span className="text-osu-l2 tabular-nums">{queue.position}</span>;
      const rest = queue.waiting > 1 ? <span className="text-osu-f1"> <Trans>of {queue.waiting}</Trans></span> : null;
      return (
        <div className="text-[12px] text-osu-f1">
          {own ? (
            <Trans>Your top plays are waiting for the chart analyzer. Position in queue: {position}</Trans>
          ) : (
            <Trans>The top plays are waiting for the chart analyzer. Position in queue: {position}</Trans>
          )}
          {rest}.
        </div>
      );
    }
    return (
      <div className="text-[12px] text-osu-f1">
        {own ? (
          <Trans>Your top plays are being rated by the chart analyzer. The first pass takes a minute or two.</Trans>
        ) : (
          <Trans>The top plays are being rated by the chart analyzer. The first pass takes a minute or two.</Trans>
        )}
      </div>
    );
  }
  if (skills.status === "failed") {
    return (
      <div className="text-[12px] text-osu-f1">
        {own ? (
          <Trans>Rating your plays failed. It retries automatically, check back in a bit.</Trans>
        ) : (
          <Trans>Rating the plays failed. It retries automatically, check back in a bit.</Trans>
        )}
      </div>
    );
  }
  if (!mode || mode.analyzedPlays === 0) {
    return (
      <div className="text-[12px] text-osu-f1">
        {own ? (
          <Trans>None of your plays could be rated yet. Converts and unusual keymodes are skipped.</Trans>
        ) : (
          <Trans>None of the plays could be rated yet. Converts and unusual keymodes are skipped.</Trans>
        )}
      </div>
    );
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
  const { t, i18n } = useLingui();
  const max = entries.reduce((best, entry) => Math.max(best, entry.value), 1);
  const points = useMemo(() => radarPoints(entries, max, RADAR), [entries, max]);
  const hoveredPoint = points.find((point) => point.entry.key === hovered) ?? null;
  const shape = entries.map((entry) => `${i18n._(entry.labelMsg)} ${entry.value.toFixed(1)}`).join(", ");
  return (
    <svg
      viewBox={`0 0 ${RADAR_W} ${RADAR_H}`}
      className="mx-auto block w-full max-w-[320px]"
      role="img"
      aria-label={t`Skill shape: ${shape}`}
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
          {i18n._(point.entry.labelMsg)}
        </text>
      ))}
      {/* Center readout: hovered axis value + population position. */}
      {hoveredPoint ? (
        <g pointerEvents="none">
          <text x={RADAR_CX} y={RADAR_CY - 4} textAnchor="middle" className="fill-white text-[15px] font-bold tabular-nums">
            {hoveredPoint.entry.value.toFixed(2)}
          </text>
          <text x={RADAR_CX} y={RADAR_CY + 12} textAnchor="middle" className="fill-osu-f1 text-[9px] font-semibold uppercase tracking-wide">
            {i18n._(hoveredPoint.entry.labelMsg)}
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
  onSelectDan,
}: {
  skills: MyDataSkillBreakdown;
  mode: MyDataSkillMode;
  onSelectEntry?: (entry: SkillAxisEntry, mode: MyDataSkillMode) => void;
  onSelectDan?: (side: "rc" | "ln", mode: MyDataSkillMode) => void;
}) {
  const { t, i18n } = useLingui();
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
            <span className="text-[11px] font-semibold uppercase tracking-wide text-osu-l3"><Trans>{mode.keyCount}K skill rating</Trans></span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-[30px] font-bold leading-none text-white tabular-nums">{overall.toFixed(2)}</span>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-osu-l3"><Trans>overall</Trans></span>
            <ProvisionalChip mode={mode} />
            <RefreshingChip skills={skills} />
          </div>
          {overallPercentile ? (
            <div className="mt-1 text-[11px] text-osu-l2">
              <Trans>
                <span className="font-semibold text-osu-pink-light">top {topSharePercent(overallPercentile.value)}%</span>
                {" "}of {overallPercentile.population.toLocaleString("en-US")} tracked {mode.keyCount}K mains
              </Trans>
            </div>
          ) : null}
        </div>
        <DanChips mode={mode} onSelect={onSelectDan ? (side) => onSelectDan(side, mode) : undefined} />
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
            const entryLabel = i18n._(entry.labelMsg);
            const row = (
              <>
                <span className={`w-[84px] shrink-0 text-[11px] font-semibold ${hovered === entry.key ? "text-white" : "text-osu-l2"}`}>{entryLabel}</span>
                <span className="h-1.5 min-w-0 flex-1 rounded-full bg-osu-b3/35">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${Math.max(4, (entry.value / max) * 100)}%`, backgroundColor: entry.color }}
                  />
                </span>
                <span className="w-[44px] shrink-0 text-right text-[11px] text-osu-l2 tabular-nums">{entry.value.toFixed(2)}</span>
                <span className="w-[52px] shrink-0 text-right text-[10px] text-osu-f1 tabular-nums">
                  {percentile ? t`top ${topSharePercent(percentile.value)}%` : ""}
                </span>
              </>
            );
            const rowClass = `flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-[80ms] ${
              hovered === entry.key ? "bg-osu-b3/30" : ""
            }`;
            // The public profile turns every axis into an explanation of the
            // rating: the strongest plays behind it open in place.
            const share = percentileTitle(entry, mode, i18n);
            return onSelectEntry ? (
              <button
                type="button"
                key={entry.key}
                className={rowClass}
                title={`${share ? `${share} · ` : ""}${t`View top ${entryLabel} plays`}`}
                onMouseEnter={() => setHovered(entry.key)}
                onClick={() => onSelectEntry(entry, mode)}
              >
                {row}
              </button>
            ) : (
              <div key={entry.key} className={rowClass} title={share} onMouseEnter={() => setHovered(entry.key)}>
                {row}
              </div>
            );
          })}
          <LnShareNote mode={mode} className="px-2 pt-1.5" />
        </div>
      </div>

      <div className="mt-auto pt-3 text-[10px] text-osu-f1">{footnote(skills, mode, false, i18n)}</div>
    </div>
  );
}
