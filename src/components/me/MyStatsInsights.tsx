// The "My Stats" insight cards and the chrome they share with the rest of
// /my-stats: what the player plays against what they rate on, how their
// sessions look, and their judgement fingerprint. Kept
// out of MyDataPanel so the cards can be rendered (and tested) on their own.

import { useLingui } from "@lingui/react/macro";

import type {
  MyDataInsights,
  MyDataJudgement,
  MyDataSessionShape,
  MyDataSkillMode,
} from "../../lib/my-data";
import { PATTERN_COLOR, usePatternLabel } from "../../lib/pattern-labels";
import { skillModeEntries } from "../../lib/skill-axes";

export const KEY_LABEL: Record<number, string> = { 1: "1K", 2: "2K", 3: "3K", 4: "4K", 5: "5K", 6: "6K", 7: "7K", 8: "8K", 9: "9K", 10: "10K" };
export function InsightCard({ title, children, right, accent = "#e173a6" }: { title: string; children: React.ReactNode; right?: React.ReactNode; accent?: string }) {
  return (
    <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-3.5 w-1 rounded-full" style={{ backgroundColor: accent }} />
        <span className="shrink-0 whitespace-nowrap text-[11px] font-semibold uppercase tracking-wide text-osu-l3">{title}</span>
        {right ? <span className="ml-auto min-w-0 text-[10px] text-osu-f1">{right}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function compact(n: number): string {
  return n >= 10_000 ? n.toLocaleString("en-US") : String(n);
}

export function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00`);
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function StatColumn({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-osu-l3">{label}</div>
      <div className="mt-1 truncate text-[19px] font-bold leading-none text-white tabular-nums" title={value}>{value}</div>
      {sub ? <div className="mt-1 text-[11px] leading-tight text-osu-f1" title={sub}>{sub}</div> : null}
    </div>
  );
}

/**
 * What the player actually plays, next to what they rate on. The diet is the
 * share of their analyzed plays whose chart carries each chart-analysis
 * pattern tag, and the number beside it is the rating aggregated from the
 * same tag, so the two columns are the same charts read two ways. Tags
 * overlap (a chart can be jack and tech), so the shares don't sum to 100.
 */
export function PlayDietCard({ insights, mode }: { insights: MyDataInsights; mode: MyDataSkillMode | null }) {
  const { t, i18n } = useLingui();
  const patternLabel = usePatternLabel();
  const diet = mode ? insights.diet.find((entry) => entry.keyCount === mode.keyCount) ?? null : null;
  if (!mode || !diet || diet.analyzed < 5 || diet.tags.length === 0) return null;

  const ratings = new Map((mode.patterns ?? []).map((pattern) => [pattern.id, pattern.rating]));
  const rows = diet.tags.slice(0, 6);
  const top = rows[0];
  const axes = skillModeEntries(mode);
  const weakest = axes.length >= 3 ? axes[axes.length - 1] : null;

  return (
    <InsightCard
      title={t`What you play`}
      accent={PATTERN_COLOR[top.id] ?? "#5ab2f2"}
      right={t`${compact(diet.analyzed)} analyzed`}
    >
      <div className="space-y-2">
        {rows.map((tag) => {
          const rating = ratings.get(tag.id);
          return (
            <div key={tag.id} className="flex items-center gap-2">
              <span className="w-[68px] shrink-0 truncate text-[11px] font-semibold text-osu-l2">{patternLabel(tag.id)}</span>
              <span className="h-1.5 min-w-0 flex-1 rounded-full bg-osu-b3/35">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${Math.max(4, (tag.pct / top.pct) * 100)}%`, backgroundColor: PATTERN_COLOR[tag.id] ?? "#5ab2f2" }}
                />
              </span>
              <span className="w-[30px] shrink-0 text-right text-[11px] text-osu-l2 tabular-nums">{tag.pct}%</span>
              <span className="w-[38px] shrink-0 text-right text-[11px] text-osu-f1 tabular-nums">
                {rating != null && rating >= 1 ? rating.toFixed(2) : "-"}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-2.5 text-[11px] text-osu-l2">
        {t`${top.pct}% of your analyzed ${mode.keyCount}K plays are ${patternLabel(top.id)}.`}
        {weakest ? ` ${t`Your lowest rating is ${i18n._(weakest.labelMsg)}.`}` : null}
      </div>
    </InsightCard>
  );
}

export function useSpanFormatter(): (minutes: number) => string {
  const { t } = useLingui();
  return (minutes: number) => {
    const total = Math.max(0, Math.round(minutes));
    const hours = Math.floor(total / 60);
    const mins = total % 60;
    return hours > 0 ? t`${hours}h ${mins}m` : t`${mins}m`;
  };
}

export function SessionShapeCard({ sessions }: { sessions: MyDataSessionShape }) {
  const { t } = useLingui();
  const formatSpan = useSpanFormatter();
  return (
    <InsightCard title={t`Sessions`} accent="#d8a657" right={t`${compact(sessions.sessions)} total`}>
      <div className="grid grid-cols-3 gap-3">
        <StatColumn label={t`Avg duration`} value={formatSpan(sessions.avgMinutes)} />
        <StatColumn label={t`Plays / session`} value={sessions.avgPlays.toFixed(1)} />
        <StatColumn
          label={t`Longest`}
          value={sessions.longest ? formatSpan(sessions.longest.minutes) : "-"}
          sub={sessions.longest
            ? `${t`${sessions.longest.plays} plays`} · ${formatDay(sessions.longest.startedAt.slice(0, 10))}`
            : undefined}
        />
      </div>
    </InsightCard>
  );
}

/** "Feb 2021" from either a stored day or a full timestamp. */
function formatMonth(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

export function JudgementCard({ judgement }: { judgement: MyDataJudgement }) {
  const { t } = useLingui();
  return (
    <InsightCard
      title={t`Judgements`}
      accent="#e173a6"
      right={judgement.since
        ? t`${compact(judgement.plays)} plays since ${formatMonth(judgement.since)}`
        : t`${compact(judgement.plays)} plays`}
    >
      <div className="grid grid-cols-3 gap-3">
        <StatColumn
          label={t`MAX:300 ratio`}
          value={judgement.maxRatio != null ? judgement.maxRatio.toFixed(2) : "-"}
          sub={t`${(judgement.maxShare * 100).toFixed(0)}% of notes`}
        />
        <StatColumn label={t`Misses`} value={judgement.missPer1k.toFixed(1)} sub={t`per 1k notes`} />
        <StatColumn label={t`Accuracy`} value={`${(judgement.accuracy * 100).toFixed(2)}%`} />
      </div>
      {judgement.byKey.length > 1 ? (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-white/[0.07] pt-2.5 text-[11px] text-osu-l2 tabular-nums">
          {judgement.byKey.map((key) => (
            <span key={key.keyCount}>
              <span className="font-semibold text-osu-l2">{KEY_LABEL[key.keyCount] ?? `${key.keyCount}K`}</span>
              {" "}
              <span className="text-white">{(key.accuracy * 100).toFixed(2)}%</span>
              <span className="text-osu-f1"> ({compact(key.plays)})</span>
            </span>
          ))}
        </div>
      ) : null}
    </InsightCard>
  );
}
