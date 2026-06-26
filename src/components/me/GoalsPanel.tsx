import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";

import { PageHeader } from "../layout/PageHeader";
import { GradeImg } from "../ui/GradeImg";
import { OsuLogo } from "../ui/OsuLogo";
import { useAuth } from "../../lib/auth-context";
import { getBeatmapsetForBeatmap, searchBeatmaps } from "../../lib/osu";
import { openLiveEventSource } from "../../lib/live-backend";
import {
  createGoal,
  deleteGoal,
  EMPTY_GOAL_SUGGESTION_METRICS,
  fetchMyGoalSuggestionMetrics,
  fetchMyGoals,
  type CreateGoalInput,
  type GoalKind,
  type GoalSuggestionMetrics,
  type UserGoal,
} from "../../lib/goals";
import type { OsuBeatmap, OsuBeatmapset } from "../../lib/types";

const ICONS = {
  beatmapsets: "/images/icons/beatmapsets.svg",
  contests: "/images/icons/contests.svg",
  rankings: "/images/icons/rankings.svg",
  search: "/images/icons/search.svg",
  tournaments: "/images/icons/tournaments.svg",
} as const;

function OsuAssetIcon({ src, className = "" }: { src: string; className?: string }) {
  return <img src={src} alt="" className={`object-contain ${className}`} aria-hidden="true" />;
}

function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return <span className={`${className} inline-block rounded-full border-2 border-current border-r-transparent align-[-2px] animate-spin`} aria-hidden="true" />;
}

function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <PageHeader iconSrc="/images/icons/contests.svg" title="goals" />
      <div className="min-h-[80vh] bg-osu-b5">
        <div className="mx-auto w-full max-w-[960px] space-y-4 px-3 py-5 sm:px-5 sm:py-7">{children}</div>
      </div>
    </div>
  );
}

type GoalScope = "pp" | "map-acc" | "map" | "map-grade";

interface GoalTypeMeta {
  kind: GoalKind;
  label: string;
  hint: string;
  description: string;
  scope: GoalScope;
  accent: string;
  iconSrc: string;
  placeholder: string;
}

const GOAL_TYPES: GoalTypeMeta[] = [
  {
    kind: "reach_pp",
    label: "Reach pp",
    hint: "total performance",
    description: "Climb to a specific total pp number.",
    scope: "pp",
    accent: "#e173a6",
    iconSrc: ICONS.rankings,
    placeholder: "5000",
  },
  {
    kind: "play_pp",
    label: "Big play",
    hint: "single score",
    description: "Set a single play worth a target pp amount.",
    scope: "pp",
    accent: "#d8a657",
    iconSrc: ICONS.contests,
    placeholder: "300",
  },
  {
    kind: "accuracy",
    label: "Accuracy",
    hint: "map target",
    description: "Hit a specific accuracy on a certain map.",
    scope: "map-acc",
    accent: "#7fb89a",
    iconSrc: ICONS.search,
    placeholder: "96",
  },
  {
    kind: "pass",
    label: "Pass",
    hint: "clear a map",
    description: "Clear a certain map.",
    scope: "map",
    accent: "#6f9bd8",
    iconSrc: ICONS.beatmapsets,
    placeholder: "map",
  },
  {
    kind: "grade",
    label: "Grade",
    hint: "map badge",
    description: "Getting a specific rank on a certain map.",
    scope: "map-grade",
    accent: "#b06bc0",
    iconSrc: ICONS.tournaments,
    placeholder: "S",
  },
];

const GRADES = ["A", "S", "SS"] as const;

interface GoalSuggestionLabels {
  reachPpExample: string;
  reachPpPlaceholder: string;
  playPpExample: string;
  playPpPlaceholder: string;
}

function goalMeta(kind: GoalKind) {
  return GOAL_TYPES.find((t) => t.kind === kind) ?? GOAL_TYPES[0];
}

interface ResolvedMap {
  id: number;
  beatmapsetId: number;
  label: string;
  cover: string;
}

function listCover(set: OsuBeatmapset): string {
  return set.covers?.list ?? `https://assets.ppy.sh/beatmaps/${set.id}/covers/list.jpg`;
}

function coverUrl(beatmapsetId: number | null | undefined): string | null {
  return beatmapsetId ? `https://assets.ppy.sh/beatmaps/${beatmapsetId}/covers/list@2x.jpg` : null;
}

function maniaDiffs(set: OsuBeatmapset): OsuBeatmap[] {
  return (set.beatmaps ?? []).filter((b) => b.mode === "mania").sort((a, b) => (a.difficulty_rating ?? 0) - (b.difficulty_rating ?? 0));
}

function readBeatmapIdFromInput(value: string): number | null {
  const text = value.trim();
  const match = text.match(/(?:#(?:osu|taiko|fruits|mania)\/|\/beatmaps\/|\/b\/)(\d+)/i);
  const raw = match?.[1] ?? (/^\d{3,10}$/.test(text) ? text : null);
  if (!raw) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function trimZeros(s: string): string {
  return s.replace(/\.?0+$/, "");
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function roundUpToStep(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function formatPp(value: number): string {
  return `${Math.round(value).toLocaleString()}pp`;
}

function reachPpSuggestion(currentPp: number | null): number | null {
  if (currentPp == null) return null;
  const step = currentPp >= 10_000 ? 250 : currentPp >= 5_000 ? 100 : 50;
  return roundUpToStep(currentPp + 1, step);
}

function playPpSuggestion(lowestTopPlayPp: number | null, currentPp: number | null): number | null {
  const floor = lowestTopPlayPp ?? (currentPp == null ? null : currentPp / 25);
  if (floor == null) return null;
  const step = floor >= 700 ? 25 : floor >= 250 ? 10 : 5;
  return roundUpToStep(floor + 0.1, step);
}

function buildGoalSuggestionLabels(metrics: GoalSuggestionMetrics): GoalSuggestionLabels {
  const reach = reachPpSuggestion(metrics.currentPp);
  const play = playPpSuggestion(metrics.lowestTopPlayPp, metrics.currentPp);
  return {
    reachPpExample: reach == null ? "target pp" : formatPp(reach),
    reachPpPlaceholder: reach == null ? "" : String(Math.round(reach)),
    playPpExample: play == null ? "top play" : formatPp(play),
    playPpPlaceholder: play == null ? "" : String(Math.round(play)),
  };
}

function progressPct(goal: UserGoal): number | null {
  if (goal.status === "completed") return 100;
  if (typeof goal.progress?.pct !== "number") return null;
  return clampPct(goal.progress.pct);
}

function describeGoal(goal: UserGoal): string {
  const map = goal.beatmapLabel ?? (goal.beatmapId ? `map #${goal.beatmapId}` : "a map");
  switch (goal.kind) {
    case "reach_pp":
      return `Reach ${Math.round(goal.targetValue ?? 0).toLocaleString()} total pp`;
    case "play_pp":
      return `Land a ${Math.round(goal.targetValue ?? 0)}pp play`;
    case "accuracy":
      return `${trimZeros(((goal.targetValue ?? 0) * 100).toFixed(2))}% on ${map}`;
    case "pass":
      return `Pass ${map}`;
    case "grade":
      return `Get ${goal.targetGrade ?? "S"} on ${map}`;
    default:
      return "Goal";
  }
}

function targetLabel(goal: UserGoal): string | null {
  switch (goal.kind) {
    case "reach_pp":
      return `${Math.round(goal.targetValue ?? 0).toLocaleString()}pp`;
    case "play_pp":
      return `${Math.round(goal.targetValue ?? 0)}pp`;
    case "accuracy":
      return `${trimZeros(((goal.targetValue ?? 0) * 100).toFixed(2))}%`;
    default:
      return null;
  }
}

function completedDetail(goal: UserGoal): string | null {
  if (goal.status !== "completed" || !goal.completedAt) return null;
  const date = new Date(goal.completedAt).toLocaleDateString();
  if (goal.kind === "accuracy" && goal.completedValue != null) return `Cleared ${date} · ${(goal.completedValue * 100).toFixed(2)}%`;
  if ((goal.kind === "play_pp" || goal.kind === "reach_pp") && goal.completedValue != null) return `Cleared ${date} · ${Math.round(goal.completedValue)}pp`;
  return `Cleared ${date}`;
}

function typeExample(type: GoalTypeMeta, suggestions: GoalSuggestionLabels): string {
  switch (type.kind) {
    case "reach_pp":
      return suggestions.reachPpExample;
    case "play_pp":
      return suggestions.playPpExample;
    case "accuracy":
      return "96%";
    case "pass":
      return "map";
    case "grade":
      return "rank";
    default:
      return type.hint;
  }
}

export function GoalsPanel({ initialSuggestionMetrics = EMPTY_GOAL_SUGGESTION_METRICS }: { initialSuggestionMetrics?: GoalSuggestionMetrics }) {
  const auth = useAuth();
  const location = useLocation();
  const viewer = auth.viewer;

  const [goals, setGoals] = useState<UserGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [suggestionMetrics, setSuggestionMetrics] = useState<GoalSuggestionMetrics>(initialSuggestionMetrics);

  const [kind, setKind] = useState<GoalKind>("reach_pp");
  const active = useMemo(() => goalMeta(kind), [kind]);
  const suggestions = useMemo(() => buildGoalSuggestionLabels(suggestionMetrics), [suggestionMetrics]);
  const scope = active.scope;
  const needsMap = scope !== "pp";

  const [ppTarget, setPpTarget] = useState("");
  const [accPct, setAccPct] = useState("");
  const [grade, setGrade] = useState<(typeof GRADES)[number]>("S");

  const [mapQuery, setMapQuery] = useState("");
  const [results, setResults] = useState<OsuBeatmapset[]>([]);
  const [searching, setSearching] = useState(false);
  const [mapLookupError, setMapLookupError] = useState<string | null>(null);
  const [pickedSet, setPickedSet] = useState<OsuBeatmapset | null>(null);
  const [resolved, setResolved] = useState<ResolvedMap | null>(null);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchMyGoals();
      setGoals(result.goals);
    } catch {
      setGoals([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!viewer) {
      setLoading(false);
      setSuggestionMetrics(EMPTY_GOAL_SUGGESTION_METRICS);
      return;
    }
    void load();
  }, [viewer, load]);

  useEffect(() => {
    if (!viewer) return;
    let cancelled = false;
    void (async () => {
      const metrics = await fetchMyGoalSuggestionMetrics().catch(() => EMPTY_GOAL_SUGGESTION_METRICS);
      if (cancelled) return;
      setSuggestionMetrics(metrics);
    })();
    return () => {
      cancelled = true;
    };
  }, [viewer]);

  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!viewer) return;
    const onFocus = () => void loadRef.current();
    window.addEventListener("focus", onFocus);
    const source = viewer.countryCode ? openLiveEventSource(viewer.countryCode) : null;
    if (source) {
      source.addEventListener("goal_completed", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as { userId?: number };
          if (data.userId === viewer.id) void loadRef.current();
        } catch {
          void loadRef.current();
        }
      });
    }
    return () => {
      window.removeEventListener("focus", onFocus);
      source?.close();
    };
  }, [viewer]);

  const resetMapPicker = useCallback(() => {
    setMapQuery("");
    setResults([]);
    setSearching(false);
    setMapLookupError(null);
    setPickedSet(null);
    setResolved(null);
  }, []);

  const resolveDiff = useCallback((set: OsuBeatmapset, diff: OsuBeatmap) => {
    setResolved({
      id: diff.id,
      beatmapsetId: set.id,
      label: `${set.artist} - ${set.title} [${diff.version}]`,
      cover: listCover(set),
    });
    setResults([]);
    setMapLookupError(null);
    setPickedSet(null);
    setMapQuery("");
  }, []);

  const pickSet = useCallback(
    (set: OsuBeatmapset) => {
      const diffs = maniaDiffs(set);
      if (diffs.length <= 1) {
        if (diffs[0]) resolveDiff(set, diffs[0]);
        return;
      }
      setPickedSet(set);
      setResults([]);
      setMapLookupError(null);
    },
    [resolveDiff],
  );

  useEffect(() => {
    if (!needsMap || resolved || pickedSet) {
      setSearching(false);
      return;
    }
    const query = mapQuery.trim();
    setMapLookupError(null);
    if (query.length < 3) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    const beatmapId = readBeatmapIdFromInput(query);
    setSearching(true);
    const timer = setTimeout(async () => {
      if (beatmapId != null) {
        try {
          const set = await getBeatmapsetForBeatmap({ data: { beatmapId } });
          if (cancelled) return;
          const diff = maniaDiffs(set).find((beatmap) => beatmap.id === beatmapId);
          if (diff) resolveDiff(set, diff);
          else {
            setResults([]);
            setMapLookupError("That beatmap ID is not a mania difficulty.");
          }
        } catch {
          if (!cancelled) {
            setResults([]);
            setMapLookupError("Couldn't find that beatmap ID.");
          }
        } finally {
          if (!cancelled) setSearching(false);
        }
        return;
      }

      try {
        const res = await searchBeatmaps({ data: { query } });
        if (!cancelled) setResults((res.beatmapsets ?? []).slice(0, 8));
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mapQuery, needsMap, resolved, pickedSet, resolveDiff]);

  const switchKind = (next: GoalKind) => {
    setKind(next);
    setCreateError(null);
    resetMapPicker();
    setAccPct("");
  };

  const canSubmit = (() => {
    if (creating) return false;
    if (scope === "pp") return Number(ppTarget) > 0;
    if (!resolved) return false;
    if (scope === "map-acc") return Number(accPct) > 0 && Number(accPct) <= 100;
    return true;
  })();

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setCreating(true);
    setCreateError(null);
    const input: CreateGoalInput = { kind };
    if (scope === "pp") input.targetValue = Number(ppTarget);
    else if (resolved) {
      input.beatmapId = resolved.id;
      input.beatmapsetId = resolved.beatmapsetId;
      input.beatmapLabel = resolved.label;
      if (scope === "map-acc") input.targetValue = Number(accPct) / 100;
      if (scope === "map-grade") input.targetGrade = grade;
    }
    try {
      const result = await createGoal({ data: input });
      if (!result.ok) {
        setCreateError("Couldn't save that goal. Check the values and try again.");
        return;
      }
      setPpTarget("");
      setAccPct("");
      resetMapPicker();
      await load();
    } catch {
      setCreateError("Couldn't save that goal. Try again in a moment.");
    } finally {
      setCreating(false);
    }
  }, [canSubmit, kind, scope, ppTarget, accPct, grade, resolved, load, resetMapPicker]);

  const remove = useCallback(
    async (id: string) => {
      setGoals((prev) => prev.filter((goal) => goal.id !== id));
      try {
        await deleteGoal({ data: { id } });
      } catch {
        void load();
      }
    },
    [load],
  );

  if (!viewer) {
    const loginHref = `/api/auth/osu?next=${encodeURIComponent(`${location.pathname}${location.searchStr}`)}`;
    return (
      <PageShell>
        <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
          <div className="grid gap-5 p-5 sm:grid-cols-[1fr_auto] sm:items-center sm:p-6">
            <div className="min-w-0">
              <div className="mb-3 inline-flex items-center gap-2 rounded-lg border border-osu-b3/40 bg-osu-b5/60 px-2.5 py-1 text-[11px] font-semibold text-osu-l2">
                <OsuAssetIcon src={ICONS.contests} className="h-3.5 w-3.5 opacity-85" />
                personal goals
              </div>
              <div className="text-[22px] font-bold leading-tight text-white">Log in to set goals</div>
              <div className="mt-1 max-w-xl text-[13px] leading-5 text-osu-f1">Targets complete from your tracked mania plays.</div>
              <div className="mt-4 grid max-w-sm grid-cols-2 gap-1.5 min-[480px]:flex min-[480px]:flex-wrap">
                {GOAL_TYPES.map((type) => (
                  <span key={type.kind} className="inline-flex items-center gap-1.5 rounded-md border border-osu-b3/35 bg-osu-b5/55 px-2 py-1 text-[11px] font-semibold text-osu-l2">
                    <OsuAssetIcon src={type.iconSrc} className="h-3 w-3 opacity-65" />
                    {type.label}
                  </span>
                ))}
              </div>
            </div>
            <a href={loginHref} className="inline-flex h-10 justify-self-start items-center justify-center gap-2 rounded-lg border border-osu-pink/40 bg-osu-pink/15 px-4 text-[12px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white sm:justify-self-end">
              <OsuLogo className="h-4 w-4" />
              Log in with osu!
            </a>
          </div>
        </div>
      </PageShell>
    );
  }

  const open = goals.filter((goal) => goal.status === "open");
  const done = goals.filter((goal) => goal.status === "completed");

  return (
    <PageShell>
      <section className="relative rounded-xl border border-osu-b3/20 bg-osu-b4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-osu-b3/20 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-osu-b3/35 bg-osu-b5/60 text-osu-pink-light">
              <OsuAssetIcon src={ICONS.contests} className="h-5 w-5 opacity-90" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[16px] font-bold text-white">New goal</div>
              <div className="text-[11px] font-semibold leading-4 text-osu-f1">{active.description}</div>
            </div>
          </div>
        </div>

        <div>
          <div className="border-b border-osu-b3/20 p-3">
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
              {GOAL_TYPES.map((type) => (
                <GoalTypeButton key={type.kind} type={type} selected={kind === type.kind} example={typeExample(type, suggestions)} onClick={() => switchKind(type.kind)} />
              ))}
            </div>
          </div>

          <div className="p-3 sm:p-4">
            <div className="grid gap-3 lg:grid-cols-[220px_16px_minmax(0,1fr)_auto] lg:items-end">
              <GoalComposerHeader active={active} />
              <div className="hidden h-10 items-center justify-center pb-1 text-[18px] font-bold text-osu-f1 lg:flex" aria-hidden="true">›</div>
              <div className="min-w-0 space-y-3">
                {scope === "pp" ? (
                  <TargetNumberField
                    label={kind === "reach_pp" ? "Target total pp" : "Play worth at least"}
                    value={ppTarget}
                    onChange={setPpTarget}
                    placeholder={kind === "reach_pp" ? suggestions.reachPpPlaceholder : suggestions.playPpPlaceholder}
                    suffix="pp"
                  />
                ) : null}

                {needsMap ? (
                  <>
                    <MapPicker
                      resolved={resolved}
                      pickedSet={pickedSet}
                      mapQuery={mapQuery}
                      results={results}
                      searching={searching}
                      lookupError={mapLookupError}
                      onQueryChange={setMapQuery}
                      onReset={resetMapPicker}
                      onPickSet={pickSet}
                      onResolveDiff={resolveDiff}
                    />

                    {scope === "map-acc" && resolved ? (
                      <TargetNumberField label="Target accuracy" value={accPct} onChange={setAccPct} placeholder={active.placeholder} suffix="%" decimal />
                    ) : null}

                    {scope === "map-grade" && resolved ? <GradePicker value={grade} onChange={setGrade} accent={active.accent} /> : null}
                  </>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSubmit}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-osu-pink/40 bg-osu-pink/15 px-4 text-[12px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white disabled:cursor-default disabled:opacity-45 lg:mb-0.5"
              >
                {creating ? <Spinner /> : <span className="text-[16px] leading-none" aria-hidden="true">+</span>}
                Add goal
              </button>
              {createError ? <div className="text-[12px] font-semibold text-osu-red-light lg:col-span-4">{createError}</div> : null}
            </div>
          </div>
        </div>
      </section>

      <GoalSections loading={loading} open={open} done={done} onDelete={remove} />
    </PageShell>
  );
}

function GoalTypeButton({ type, selected, example, onClick }: { type: GoalTypeMeta; selected: boolean; example: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`group flex min-h-[48px] items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors ${
        selected ? "border-osu-pink/45 bg-osu-pink/15 text-white" : "border-osu-b3/30 bg-osu-b5/45 text-osu-l2 hover:border-osu-b3/55 hover:bg-osu-b3/25 hover:text-white"
      }`}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-osu-b3/35 bg-osu-b4/75" style={{ color: type.accent }}>
        <OsuAssetIcon src={type.iconSrc} className="h-4 w-4 opacity-90" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-bold">{type.label}</span>
        <span className="block truncate text-[10px] font-semibold text-osu-f1">{example}</span>
      </span>
    </button>
  );
}

function GoalComposerHeader({ active }: { active: GoalTypeMeta }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-osu-b3/25 bg-osu-b5/35 px-2.5 py-2">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-osu-b3/35 bg-osu-b4/75" style={{ color: active.accent }}>
        <OsuAssetIcon src={active.iconSrc} className="h-5 w-5 opacity-90" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-bold text-white">{active.label}</div>
        <div className="text-[10.5px] font-semibold leading-4 text-osu-f1">{active.description}</div>
      </div>
    </div>
  );
}

function TargetNumberField({
  label,
  value,
  onChange,
  placeholder,
  suffix,
  decimal = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  suffix: string;
  decimal?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold text-osu-l3">{label}</span>
      <span className="flex h-11 max-w-[180px] items-center rounded-lg border border-osu-b3/45 bg-osu-b5/70 focus-within:border-osu-pink/55">
        <input
          type="text"
          inputMode={decimal ? "decimal" : "numeric"}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(decimal ? /[^0-9.]/g : /[^0-9]/g, ""))}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent px-3 text-[15px] font-bold text-white outline-none placeholder:text-osu-f1/60"
        />
        <span className="pr-3 text-[11px] font-bold text-osu-f1">{suffix}</span>
      </span>
    </label>
  );
}

function MapPicker({
  resolved,
  pickedSet,
  mapQuery,
  results,
  searching,
  lookupError,
  onQueryChange,
  onReset,
  onPickSet,
  onResolveDiff,
}: {
  resolved: ResolvedMap | null;
  pickedSet: OsuBeatmapset | null;
  mapQuery: string;
  results: OsuBeatmapset[];
  searching: boolean;
  lookupError: string | null;
  onQueryChange: (value: string) => void;
  onReset: () => void;
  onPickSet: (set: OsuBeatmapset) => void;
  onResolveDiff: (set: OsuBeatmapset, diff: OsuBeatmap) => void;
}) {
  return (
    <div className="relative">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-osu-l3">
        <OsuAssetIcon src={ICONS.beatmapsets} className="h-3.5 w-3.5 opacity-70" />
        Map
      </div>

      {resolved ? (
        <div className="flex items-center gap-3 overflow-hidden rounded-lg border border-osu-pink/25 bg-osu-pink/5 p-2">
          <img src={resolved.cover} alt="" className="h-12 w-20 shrink-0 rounded-md object-cover" loading="lazy" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-bold text-white" title={resolved.label}>{resolved.label}</div>
            <div className="mt-0.5 text-[10px] text-osu-f1">#{resolved.id}</div>
          </div>
          <button type="button" onClick={onReset} className="shrink-0 rounded-md p-1.5 text-osu-l3 transition-colors hover:bg-osu-b3/50 hover:text-white" aria-label="Change map">
            <span className="block text-[16px] leading-none" aria-hidden="true">×</span>
          </button>
        </div>
      ) : pickedSet ? (
        <div className="overflow-hidden rounded-lg border border-osu-b3/30 bg-osu-b5/55">
          <div className="flex items-center gap-2 border-b border-osu-b3/25 p-2">
            <img src={listCover(pickedSet)} alt="" className="h-10 w-16 shrink-0 rounded-md object-cover" loading="lazy" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-bold text-white">{pickedSet.artist} - {pickedSet.title}</div>
              <div className="text-[10px] text-osu-f1">Pick difficulty</div>
            </div>
            <button type="button" onClick={onReset} className="shrink-0 rounded-md p-1.5 text-osu-l3 transition-colors hover:bg-osu-b3/50 hover:text-white" aria-label="Back">
              <span className="block text-[16px] leading-none" aria-hidden="true">×</span>
            </button>
          </div>
          <div className="flex max-h-[210px] flex-wrap gap-1.5 overflow-y-auto p-2">
            {maniaDiffs(pickedSet).map((diff) => (
              <button
                key={diff.id}
                type="button"
                onClick={() => onResolveDiff(pickedSet, diff)}
                className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-osu-b3/35 bg-osu-b4 px-2 py-1 text-[11px] text-osu-l2 transition-colors hover:border-osu-pink/40 hover:text-white"
              >
                <span className="font-semibold text-osu-yellow tabular-nums">{(diff.difficulty_rating ?? 0).toFixed(2)}★</span>
                <span className="truncate">{diff.version}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div>
          <div className="flex h-11 items-center rounded-lg border border-osu-b3/45 bg-osu-b5/70 focus-within:border-osu-pink/55">
            <OsuAssetIcon src={ICONS.search} className="ml-3 h-4 w-4 shrink-0 opacity-55" />
            <input
              value={mapQuery}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Search or paste map ID..."
              className="min-w-0 flex-1 bg-transparent px-2.5 text-[13px] font-semibold text-white outline-none placeholder:text-osu-f1/65"
            />
            {searching ? <Spinner className="mr-3 h-4 w-4 shrink-0 text-osu-f1" /> : null}
          </div>
          {results.length > 0 ? (
            <div className="absolute left-0 right-0 top-full z-30 mt-2 max-h-[280px] space-y-1 overflow-y-auto rounded-lg border border-osu-b3/30 bg-osu-b5 p-1 shadow-[0_18px_60px_rgba(0,0,0,0.45)]">
              {results.map((set) => {
                const diffs = maniaDiffs(set);
                return (
                  <button
                    key={set.id}
                    type="button"
                    onClick={() => onPickSet(set)}
                    className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-osu-b3/35"
                  >
                    <img src={listCover(set)} alt="" className="h-10 w-16 shrink-0 rounded object-cover" loading="lazy" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-bold text-white">{set.title}</span>
                      <span className="block truncate text-[10px] text-osu-f1">{set.artist} · {diffs.length} mania diff{diffs.length === 1 ? "" : "s"}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : lookupError ? (
            <div className="mt-2 px-1 text-[11px] font-semibold text-osu-red-light">{lookupError}</div>
          ) : mapQuery.trim().length >= 3 && !searching ? (
            <div className="mt-2 px-1 text-[11px] text-osu-f1">No mania maps found.</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function GradePicker({ value, onChange, accent }: { value: (typeof GRADES)[number]; onChange: (grade: (typeof GRADES)[number]) => void; accent: string }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold text-osu-l3">Target grade</div>
      <div className="inline-grid grid-cols-3 gap-1 rounded-lg border border-osu-b3/35 bg-osu-b5/60 p-1">
        {GRADES.map((grade) => (
          <button
            key={grade}
            type="button"
            onClick={() => onChange(grade)}
            className={`flex h-10 min-w-14 items-center justify-center rounded-md px-2 transition-colors ${
              value === grade ? "bg-osu-pink/15" : "hover:bg-osu-b3/35"
            }`}
            style={value === grade ? { color: accent } : undefined}
          >
            <GradeImg grade={grade} size={42} className="h-5 w-auto" />
          </button>
        ))}
      </div>
    </div>
  );
}

function GoalSections({ loading, open, done, onDelete }: { loading: boolean; open: UserGoal[]; done: UserGoal[]; onDelete: (id: string) => void | Promise<void> }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-osu-b3/20 bg-osu-b4/60 py-16 text-[13px] text-osu-f1">
        <Spinner />
        Loading goals...
      </div>
    );
  }

  if (open.length === 0 && done.length === 0) {
    return (
      <div className="flex items-center justify-center gap-3 px-4 py-4 text-center">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-osu-b3/35 bg-osu-b5/65 text-osu-pink-light">
          <OsuAssetIcon src={ICONS.contests} className="h-5 w-5 opacity-85" />
        </div>
        <div className="text-[14px] font-bold text-osu-l2">No goals yet</div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <GoalSectionHeader title="In progress" count={open.length} />
      {open.length > 0 ? (
        <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
          {open.map((goal) => (
            <GoalCard key={goal.id} goal={goal} onDelete={() => void onDelete(goal.id)} />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-osu-b3/30 bg-osu-b4/35 p-8 text-center text-[13px] text-osu-f1">No active goals.</div>
      )}

      {done.length > 0 ? (
        <>
          <GoalSectionHeader title="Cleared" count={done.length} />
          <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
            {done.map((goal) => (
              <GoalCard key={goal.id} goal={goal} onDelete={() => void onDelete(goal.id)} compact />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function GoalSectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-osu-l3">{title}</div>
      <span className="rounded-md border border-osu-b3/30 bg-osu-b4 px-1.5 py-0.5 text-[10px] font-bold text-osu-f1 tabular-nums">{count}</span>
      <div className="h-px flex-1 bg-osu-b3/20" />
    </div>
  );
}

function GoalCard({ goal, onDelete, compact = false }: { goal: UserGoal; onDelete: () => void; compact?: boolean }) {
  const completed = goal.status === "completed";
  const meta = goalMeta(goal.kind);
  const cover = coverUrl(goal.beatmapsetId);
  const pct = progressPct(goal);
  const target = targetLabel(goal);

  return (
    <article className={`overflow-hidden rounded-xl border ${completed ? "border-osu-b3/20 bg-osu-b4/45" : "border-osu-b3/30 bg-osu-b4"}`}>
      <div className="grid grid-cols-[78px_minmax(0,1fr)_auto] items-stretch">
        <div className="relative min-h-[96px] overflow-hidden bg-osu-b5">
          {cover ? (
            <img src={cover} alt="" className={`h-full w-full object-cover ${completed ? "opacity-35 grayscale" : "opacity-90"}`} loading="lazy" />
          ) : (
            <div className="flex h-full w-full items-center justify-center" style={{ backgroundColor: `${meta.accent}20` }}>
              {goal.kind === "grade" ? <GradeImg grade={goal.targetGrade ?? "S"} size={48} className="h-6 w-auto" /> : <OsuAssetIcon src={meta.iconSrc} className="h-7 w-7 opacity-85" />}
            </div>
          )}
          <div className="absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-osu-b6/70 to-transparent" />
        </div>

        <div className="min-w-0 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-md border border-osu-b3/35 bg-osu-b5/55 px-1.5 py-0.5 text-[10px] font-bold text-osu-l2">
              {goal.kind === "grade" ? <GradeImg grade={goal.targetGrade ?? "S"} size={24} className="h-3 w-auto" /> : <OsuAssetIcon src={meta.iconSrc} className="h-3 w-3 opacity-75" />}
              {meta.label}
            </span>
            {target ? <span className="text-[10px] font-bold tabular-nums" style={{ color: meta.accent }}>{target}</span> : null}
          </div>

          <div className={`mt-1 truncate font-bold ${compact ? "text-[12px]" : "text-[13px]"} ${completed ? "text-osu-l2" : "text-white"}`} title={describeGoal(goal)}>
            {describeGoal(goal)}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-osu-f1">{completed ? completedDetail(goal) : goal.progress?.detail ?? "Tracking your plays"}</div>

          {!compact ? (
            <div className="mt-2.5">
              <ProgressRail pct={pct} accent={meta.accent} completed={completed} />
              <div className="mt-1 flex justify-between text-[10px] font-semibold text-osu-f1 tabular-nums">
                <span>{pct == null ? "live" : `${pct}%`}</span>
                {completed ? <span className="text-osu-green-light">cleared</span> : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex items-start gap-1 p-2">
          {completed ? (
            <span className="hidden h-7 w-7 items-center justify-center rounded-full bg-osu-green/15 text-osu-green-light sm:flex">
              <OsuLogo className="h-4 w-4" />
            </span>
          ) : null}
          <button
            type="button"
            onClick={onDelete}
            aria-label="Delete goal"
            className="rounded-md px-2 py-1 text-[16px] leading-none text-osu-l3 transition-colors hover:bg-osu-red/10 hover:text-osu-red-light"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </div>
    </article>
  );
}

function ProgressRail({ pct, accent, completed = false }: { pct: number | null; accent: string; completed?: boolean }) {
  const value = pct == null ? 0 : clampPct(pct);
  return (
    <div className="h-2 overflow-hidden rounded-full bg-osu-b3/35">
      <div
        className="h-full rounded-full transition-[width]"
        style={{
          width: `${value}%`,
          backgroundColor: completed ? "#88b300" : accent,
          opacity: pct == null ? 0.35 : 0.9,
        }}
      />
    </div>
  );
}
