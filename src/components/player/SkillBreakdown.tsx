import { useMemo, useState, type ReactElement } from "react";
import { Link } from "@tanstack/react-router";
import type { MyDataSkillBreakdown, MyDataSkillMode } from "../../lib/my-data";
import { useAuth } from "../../lib/auth-context";

// Shared renderer for the Etterna-style skill ratings: the My Data "Skill
// rating" card (compact bars) and the public profile Skills tab (radar +
// interactive bars) draw from the same breakdown shape, so axis metadata and
// entry selection live here. Colors are per-skill site identity and stay
// decorative: identity is always carried by the text label on the mark.

// Etterna's skillset taxonomy (from the MinaCalc analysis), with colors from
// the same palette the old pattern fingerprint used. Native for 4K only.
// searchPattern is the /maps search family the axis maps onto.
export const MSD_SKILLSET_META: Array<{ key: string; label: string; color: string; searchPattern: string | null }> = [
  { key: "Stream", label: "Stream", color: "#8f6bd8", searchPattern: "stream" },
  { key: "Jumpstream", label: "Jumpstream", color: "#6f87d8", searchPattern: "jumpstream" },
  { key: "Handstream", label: "Handstream", color: "#b06bc0", searchPattern: "handstream" },
  { key: "Stamina", label: "Stamina", color: "#ad6b5d", searchPattern: "stamina" },
  { key: "JackSpeed", label: "Jackspeed", color: "#c66f84", searchPattern: "jack" },
  { key: "Chordjack", label: "Chordjack", color: "#c59a5c", searchPattern: "chordjack" },
  { key: "Technical", label: "Technical", color: "#83a86f", searchPattern: "tech" },
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
  // The /maps search family this axis links to, when one exists.
  searchPattern: string | null;
}

// 4K speaks MinaCalc's native skillsets; other keymodes speak the in-house
// pattern vocabulary (falling back to the MSD names while tags are missing).
export function skillModeEntries(mode: MyDataSkillMode): SkillAxisEntry[] {
  if (mode.keyCount !== 4) {
    const byId = new Map((mode.patterns ?? []).map((entry) => [entry.id, entry.rating]));
    const patternEntries = PATTERN_RATING_META
      .map((meta) => ({ ...meta, value: Number(byId.get(meta.key) ?? 0), axis: `pattern:${meta.key}`, searchPattern: meta.key }))
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
  if (ln && ln.rating >= 1) entries.push({ key: "ln", label: "LN", color: "#f07474", value: ln.rating, axis: "pattern:ln", searchPattern: "ln" });
  return entries.sort((a, b) => b.value - a.value);
}

export function skillRatingAccent(mode: MyDataSkillMode | null): string {
  if (!mode) return "#8f6bd8";
  return skillModeEntries(mode)[0]?.color ?? "#8f6bd8";
}

function formatTopShare(percentile: number): string {
  const top = Math.max(1, Math.round(100 - percentile));
  return `top ${top}%`;
}

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

function mapsKeyParam(keyCount: number): "4k" | "7k" | "other" {
  if (keyCount === 4) return "4k";
  if (keyCount === 7) return "7k";
  return "other";
}

function percentileTitle(entry: SkillAxisEntry, mode: MyDataSkillMode): string | undefined {
  const percentile = mode.percentiles?.[entry.axis];
  if (!percentile) return undefined;
  return `${entry.label}: ${formatTopShare(percentile.value)} of ${percentile.population.toLocaleString()} tracked ${mode.keyCount}K players`;
}

function DanChips({ mode }: { mode: MyDataSkillMode }) {
  // Calibration preview: the dan formula is still being anchored against
  // known players, so the chips stay admin-only until the owner trusts them.
  const canSee = useAuth().canUseAdminFeatures;
  const dan = mode.dan;
  if (!canSee || !dan) return null;
  // Non-4K LN sides label on the numbered/greek ladder backend-side (the 7K
  // LN dan series is named like rice), so every keymode shows its LN chip.
  const sides: Array<{ id: string; label: string; side: { rawDan: number; label: string; clears: number } | null }> = [
    { id: "rc", label: "Rice", side: dan.rc },
    { id: "ln", label: "LN", side: dan.ln },
  ];
  const visible = sides.filter((entry) => entry.side != null);
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {visible.map((entry) => (
        <span
          key={entry.id}
          className="inline-flex items-baseline gap-1.5 rounded-md border border-osu-b3/40 bg-osu-b5/60 px-2 py-1"
          title={`Backed by ${entry.side!.clears} qualifying clears (96%+ accuracy) on charts around this dan level`}
        >
          <span className="text-[10px] font-semibold uppercase tracking-wide text-osu-f1">{entry.label}</span>
          <span className="text-[12px] font-bold text-osu-l1">~{formatDanChip(entry.side!.label)}</span>
        </span>
      ))}
    </div>
  );
}

function footnote(skills: MyDataSkillBreakdown, mode: MyDataSkillMode, whose: string): string {
  const parts = [
    `rated from ${mode.analyzedPlays} plays across ${whose} top plays and tracked history, DT and HT at their real rate, accuracy weighted by MAX:300 ratio, unranked vibro charts excluded`,
  ];
  if (skills.pendingPlays > 0) parts.push(`${skills.pendingPlays} still analyzing`);
  if (skills.baseline) parts.push("percentiles are among tracked players");
  return parts.join(" · ");
}

// --- Compact card body (My Data) ---

export function SkillBreakdownBody({ skills, mode, own = false }: { skills: MyDataSkillBreakdown | null; mode: MyDataSkillMode | null; own?: boolean }) {
  const whose = own ? "your" : "the";
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
          {" "}of {overallPercentile.population.toLocaleString()} tracked {mode!.keyCount}K players
        </div>
      ) : (
        <div className="mb-2.5" />
      )}
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

// Wider than tall: the horizontal margin is what keeps long side labels
// ("Chordstream") inside the viewBox instead of clipping at the edge.
const RADAR_W = 344;
const RADAR_H = 252;
const RADAR_CX = RADAR_W / 2;
const RADAR_CY = RADAR_H / 2;
const RADAR_MAX_R = 84;
const RADAR_LABEL_R = 100;
const RADAR_RINGS = [0.25, 0.5, 0.75, 1];

interface RadarPoint {
  entry: SkillAxisEntry;
  x: number;
  y: number;
  labelX: number;
  labelY: number;
  angle: number;
}

function radarPoints(entries: SkillAxisEntry[], max: number): RadarPoint[] {
  return entries.map((entry, index) => {
    const angle = -Math.PI / 2 + (index / entries.length) * Math.PI * 2;
    const r = Math.max(0.06, entry.value / max) * RADAR_MAX_R;
    return {
      entry,
      angle,
      x: RADAR_CX + Math.cos(angle) * r,
      y: RADAR_CY + Math.sin(angle) * r,
      labelX: RADAR_CX + Math.cos(angle) * RADAR_LABEL_R,
      labelY: RADAR_CY + Math.sin(angle) * RADAR_LABEL_R,
    };
  });
}

function ringPolygon(count: number, fraction: number): string {
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
    const r = fraction * RADAR_MAX_R;
    return `${RADAR_CX + Math.cos(angle) * r},${RADAR_CY + Math.sin(angle) * r}`;
  }).join(" ");
}

function radarAnchor(angle: number): "start" | "middle" | "end" {
  const cos = Math.cos(angle);
  if (cos > 0.35) return "start";
  if (cos < -0.35) return "end";
  return "middle";
}

// Vertical alignment via dy, not dominant-baseline (which headless/older
// renderers drop for hanging text): above the point for north labels, below
// for south, centered for the sides.
function radarLabelDy(angle: number): number {
  const sin = Math.sin(angle);
  if (sin < -0.35) return -2;
  if (sin > 0.35) return 9;
  return 3.5;
}

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
  const points = useMemo(() => radarPoints(entries, max), [entries, max]);
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
        <polygon key={fraction} points={ringPolygon(entries.length, fraction)} fill="none" className="stroke-osu-b3/30" strokeWidth={1} />
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

export function SkillModePanel({ skills, mode }: { skills: MyDataSkillBreakdown; mode: MyDataSkillMode }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const entries = skillModeEntries(mode);
  const accent = entries[0]?.color ?? "#8f6bd8";
  const overall = Number(mode.ratings.Overall ?? 0);
  const overallPercentile = mode.percentiles?.Overall;
  const max = entries[0]?.value ?? 1;
  const sKeys = mapsKeyParam(mode.keyCount);
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
              {" "}of {overallPercentile.population.toLocaleString()} tracked {mode.keyCount}K players
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
            // Each axis is a door: click through to the maps search filtered
            // to that pattern in this keymode.
            return entry.searchPattern ? (
              <Link
                key={entry.key}
                to="/maps"
                search={{ tab: "search", sKeys, sPatterns: entry.searchPattern } as never}
                className={rowClass}
                title={percentileTitle(entry, mode) ?? `Browse ${entry.label.toLowerCase()} maps`}
                onMouseEnter={() => setHovered(entry.key)}
              >
                {row}
              </Link>
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
