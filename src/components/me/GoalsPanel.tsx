import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
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

function OsuAssetIcon({ src, className = "", style }: { src: string; className?: string; style?: CSSProperties }) {
  return <img src={src} alt="" className={`object-contain ${className}`} style={style} aria-hidden="true" />;
}

function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return <span className={`${className} inline-block rounded-full border-2 border-current border-r-transparent align-[-2px] animate-spin`} aria-hidden="true" />;
}

function CloseGlyph() {
  return <span className="block text-[15px] leading-none" aria-hidden="true">×</span>;
}

function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <PageHeader iconSrc="/images/icons/contests.svg" title="goals" />
      <div className="min-h-[80vh] bg-osu-b5">
        <div className="mx-auto w-full max-w-[1000px] space-y-5 px-3 py-5 sm:px-5 sm:py-7">{children}</div>
      </div>
    </div>
  );
}

type GoalScope = "pp" | "pp-count" | "rank" | "map-acc" | "map" | "map-grade" | "map-fc";
type GoalGroup = "profile" | "map";
type RankScope = "global" | "country";

interface GoalTypeMeta {
  kind: GoalKind;
  label: string;
  hint: string;
  description: string;
  group: GoalGroup;
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
    group: "profile",
    scope: "pp",
    accent: "#e173a6",
    iconSrc: ICONS.rankings,
    placeholder: "5000",
  },
  {
    kind: "play_pp",
    label: "Big play",
    hint: "single score",
    description: "Land another single play worth a target pp amount.",
    group: "profile",
    scope: "pp",
    accent: "#d8a657",
    iconSrc: ICONS.contests,
    placeholder: "300",
  },
  {
    kind: "play_pp_count",
    label: "PP count",
    hint: "score stack",
    description: "Own a target number of plays above a pp amount.",
    group: "profile",
    scope: "pp-count",
    accent: "#8ccf7e",
    iconSrc: ICONS.contests,
    placeholder: "50",
  },
  {
    kind: "reach_rank",
    label: "Rank",
    hint: "leaderboard climb",
    description: "Climb to a global or country rank.",
    group: "profile",
    scope: "rank",
    accent: "#56b6c2",
    iconSrc: ICONS.rankings,
    placeholder: "500",
  },
  {
    kind: "pass",
    label: "Pass",
    hint: "clear a map",
    description: "Clear a certain map.",
    group: "map",
    scope: "map",
    accent: "#6f9bd8",
    iconSrc: ICONS.beatmapsets,
    placeholder: "map",
  },
  {
    kind: "fc",
    label: "FC",
    hint: "full combo",
    description: "Full-combo a certain map (no misses).",
    group: "map",
    scope: "map-fc",
    accent: "#e8956b",
    iconSrc: ICONS.contests,
    placeholder: "map",
  },
  {
    kind: "accuracy",
    label: "Accuracy",
    hint: "map target",
    description: "Hit a specific accuracy on a certain map.",
    group: "map",
    scope: "map-acc",
    accent: "#7fb89a",
    iconSrc: ICONS.search,
    placeholder: "96",
  },
  {
    kind: "grade",
    label: "Grade",
    hint: "map badge",
    description: "Getting a specific rank on a certain map.",
    group: "map",
    scope: "map-grade",
    accent: "#b06bc0",
    iconSrc: ICONS.tournaments,
    placeholder: "S",
  },
];

const GRADES = ["A", "S", "SS"] as const;

interface GoalSuggestionLabels {
  reachPpPlaceholder: string;
  playPpPlaceholder: string;
  ppCountPlaceholder: string;
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

function nf(value: number): string {
  return Math.round(value).toLocaleString();
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
    reachPpPlaceholder: reach == null ? "" : String(Math.round(reach)),
    playPpPlaceholder: play == null ? "" : String(Math.round(play)),
    ppCountPlaceholder: "50",
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
      return `Reach ${nf(goal.targetValue ?? 0)} total pp`;
    case "reach_rank":
      return `Reach ${goal.targetGrade === "country" ? "country" : "global"} rank #${nf(goal.targetValue ?? 0)}`;
    case "play_pp":
      return `Land a ${Math.round(goal.targetValue ?? 0)}pp play`;
    case "play_pp_count":
      return `Have ${nf(goal.targetCount ?? 0)} ${Math.round(goal.targetValue ?? 0)}pp+ plays`;
    case "accuracy":
      return `${trimZeros(((goal.targetValue ?? 0) * 100).toFixed(2))}% on ${map}`;
    case "pass":
      return `Pass ${map}`;
    case "fc":
      return `FC ${map}`;
    case "grade":
      return `Get ${goal.targetGrade ?? "S"} on ${map}`;
    default:
      return "Goal";
  }
}

function completedDetail(goal: UserGoal): string | null {
  if (goal.status !== "completed" || !goal.completedAt) return null;
  const date = new Date(goal.completedAt).toLocaleDateString();
  if (goal.kind === "accuracy" && goal.completedValue != null) return `cleared ${date} · ${(goal.completedValue * 100).toFixed(2)}%`;
  if ((goal.kind === "play_pp" || goal.kind === "reach_pp") && goal.completedValue != null) return `cleared ${date} · ${nf(goal.completedValue)}pp`;
  if (goal.kind === "play_pp_count" && goal.completedValue != null) return `cleared ${date} · ${nf(goal.completedValue)} plays`;
  return `cleared ${date}`;
}

function beatmapHref(beatmapId: number | null | undefined): string | null {
  return beatmapId ? `https://osu.ppy.sh/beatmaps/${beatmapId}` : null;
}

interface Celebration {
  id: number;
  kind: GoalKind;
  label: string;
  targetGrade: string | null;
}

interface GoalCompletedPayload {
  userId?: number;
  kind?: GoalKind;
  targetValue?: number | null;
  targetCount?: number | null;
  targetGrade?: string | null;
  beatmapLabel?: string | null;
}

function celebrationLabel(data: GoalCompletedPayload): string {
  const synthetic = {
    kind: data.kind ?? "reach_pp",
    beatmapLabel: data.beatmapLabel ?? null,
    beatmapId: null,
    targetValue: data.targetValue ?? null,
    targetCount: data.targetCount ?? null,
    targetGrade: data.targetGrade ?? null,
  } as UserGoal;
  return describeGoal(synthetic);
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
  const accent = active.accent;
  const needsMap = scope.startsWith("map");

  const [ppTarget, setPpTarget] = useState("");
  const [ppCountTarget, setPpCountTarget] = useState("");
  const [accPct, setAccPct] = useState("");
  const [grade, setGrade] = useState<(typeof GRADES)[number]>("S");
  const [rankScope, setRankScope] = useState<RankScope>("global");
  const [rankTarget, setRankTarget] = useState("");

  const [mapQuery, setMapQuery] = useState("");
  const [results, setResults] = useState<OsuBeatmapset[]>([]);
  const [searching, setSearching] = useState(false);
  const [mapLookupError, setMapLookupError] = useState<string | null>(null);
  const [pickedSet, setPickedSet] = useState<OsuBeatmapset | null>(null);
  const [resolved, setResolved] = useState<ResolvedMap | null>(null);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [celebration, setCelebration] = useState<Celebration | null>(null);
  const celebrationSeq = useRef(0);
  const celebrationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const celebrate = useCallback((data: GoalCompletedPayload) => {
    celebrationSeq.current += 1;
    setCelebration({ id: celebrationSeq.current, kind: data.kind ?? "reach_pp", label: celebrationLabel(data), targetGrade: data.targetGrade ?? null });
    if (celebrationTimer.current) clearTimeout(celebrationTimer.current);
    celebrationTimer.current = setTimeout(() => setCelebration(null), 6500);
  }, []);
  useEffect(() => () => {
    if (celebrationTimer.current) clearTimeout(celebrationTimer.current);
  }, []);

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
          const data = JSON.parse((event as MessageEvent).data) as GoalCompletedPayload;
          if (data.userId === viewer.id) {
            celebrate(data);
            void loadRef.current();
          }
        } catch {
          void loadRef.current();
        }
      });
    }
    return () => {
      window.removeEventListener("focus", onFocus);
      source?.close();
    };
  }, [viewer, celebrate]);

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
    setPpCountTarget("");
    setRankTarget("");
  };

  // "Go again" from a cleared goal: refill the composer with its shape. Single-play PP goals keep
  // the same target because they now mean "land another one"; total/count goals move to the next
  // sensible milestone.
  const goAgain = (goal: UserGoal) => {
    setKind(goal.kind);
    setCreateError(null);
    resetMapPicker();
    setAccPct("");
    setPpTarget("");
    setPpCountTarget("");
    if (goal.kind === "reach_pp") {
      const next = reachPpSuggestion(suggestionMetrics.currentPp) ?? goal.targetValue ?? null;
      if (next != null) setPpTarget(String(Math.round(next)));
    } else if (goal.kind === "play_pp") {
      if (goal.targetValue != null) setPpTarget(String(Math.round(goal.targetValue)));
    } else if (goal.kind === "play_pp_count") {
      if (goal.targetValue != null) setPpTarget(String(Math.round(goal.targetValue)));
      const base = goal.completedValue ?? goal.targetCount ?? 0;
      const step = base >= 100 ? 25 : base >= 10 ? 10 : 1;
      if (base > 0) setPpCountTarget(String(roundUpToStep(base + 1, step)));
    } else if (goal.kind === "reach_rank") {
      setRankScope(goal.targetGrade === "country" ? "country" : "global");
      if (goal.targetValue != null) setRankTarget(String(Math.round(goal.targetValue)));
    } else if (goal.beatmapId && goal.beatmapsetId) {
      setResolved({ id: goal.beatmapId, beatmapsetId: goal.beatmapsetId, label: goal.beatmapLabel ?? `map #${goal.beatmapId}`, cover: coverUrl(goal.beatmapsetId) ?? "" });
      if (goal.kind === "accuracy" && goal.targetValue != null) setAccPct(String(Math.round(goal.targetValue * 100)));
      if (goal.kind === "grade" && goal.targetGrade && (GRADES as readonly string[]).includes(goal.targetGrade)) setGrade(goal.targetGrade as (typeof GRADES)[number]);
    }
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const canSubmit = (() => {
    if (creating) return false;
    if (scope === "pp") return Number(ppTarget) > 0;
    if (scope === "pp-count") return Number(ppTarget) > 0 && Number.isInteger(Number(ppCountTarget)) && Number(ppCountTarget) > 0;
    if (scope === "rank") return Number(rankTarget) > 0;
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
    else if (scope === "pp-count") {
      input.targetValue = Number(ppTarget);
      input.targetCount = Number(ppCountTarget);
    } else if (scope === "rank") {
      input.targetValue = Number(rankTarget);
      input.targetGrade = rankScope;
    } else if (resolved) {
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
      setPpCountTarget("");
      setAccPct("");
      setRankTarget("");
      resetMapPicker();
      await load();
    } catch {
      setCreateError("Couldn't save that goal. Try again in a moment.");
    } finally {
      setCreating(false);
    }
  }, [canSubmit, kind, scope, ppTarget, ppCountTarget, accPct, rankTarget, rankScope, grade, resolved, load, resetMapPicker]);

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
        <section className="relative rounded-2xl border border-osu-b3/30 bg-osu-b4">
          <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl">
            <ComposerTriangles />
          </div>
          <div className="relative grid gap-5 p-6 sm:grid-cols-[1fr_auto] sm:items-center sm:p-7">
            <div className="min-w-0">
              <div className="text-[10.5px] font-extrabold uppercase tracking-[0.18em] text-osu-pink-light">goal tracker</div>
              <div className="mt-2 text-[16px] font-bold leading-snug text-white">Log in with osu! to set goals.</div>
              <div className="mt-1.5 max-w-md text-[12.5px] leading-5 text-osu-f1">
                Targets track themselves from your mania plays: a pp number, a play worth, a play count, an accuracy, a clear, or a grade.
              </div>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {GOAL_TYPES.map((type) => (
                  <span key={type.kind} className="inline-flex items-center gap-1.5 rounded-lg border border-osu-b3/35 bg-osu-b5/55 px-2 py-1 text-[11px] font-semibold text-osu-l2">
                    <OsuAssetIcon src={type.iconSrc} className="h-3 w-3" style={{ color: type.accent }} />
                    {type.label}
                  </span>
                ))}
              </div>
            </div>
            <a
              href={loginHref}
              className="inline-flex h-11 items-center justify-center gap-2 justify-self-start rounded-xl border border-osu-pink/45 bg-osu-pink/15 px-5 text-[13px] font-bold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white sm:justify-self-end"
            >
              <OsuLogo className="h-4 w-4" />
              Log in with osu!
            </a>
          </div>
        </section>
      </PageShell>
    );
  }

  const open = goals.filter((goal) => goal.status === "open");
  const done = goals.filter((goal) => goal.status === "completed");

  const reachTargetNum = Number(ppTarget);
  let hint: string | null = null;
  if (kind === "reach_pp") {
    const cur = suggestionMetrics.currentPp;
    if (cur != null && Number.isFinite(reachTargetNum) && reachTargetNum > 0) {
      hint = reachTargetNum > cur ? `from ${nf(cur)} now, that's +${nf(reachTargetNum - cur)} to climb` : `you're already past ${nf(reachTargetNum)}`;
    } else if (cur != null) {
      hint = `you're sitting at ${nf(cur)} right now`;
    }
  }

  const mapSlot = resolved ? (
    <MapChip resolved={resolved} accent={accent} onReset={resetMapPicker} />
  ) : pickedSet ? (
    <PendingMapToken set={pickedSet} accent={accent} />
  ) : (
    <PlaceholderToken label="a map" accent={accent} />
  );

  return (
    <PageShell>
      <section className="relative rounded-2xl border border-osu-b3/30 bg-osu-b4">
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl">
          <ComposerTriangles />
        </div>

        <div className="relative">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
            <img src={viewer.avatarUrl} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover ring-1 ring-osu-b3/45" loading="lazy" />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-bold text-white">{viewer.username}</div>
              <div className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-osu-f1">goal tracker</div>
            </div>
            <div className="ml-auto flex items-center gap-4 sm:gap-6">
              <Stat label="current pp" value={suggestionMetrics.currentPp != null ? nf(suggestionMetrics.currentPp) : "—"} tone="pp" />
              <Stat label="in flight" value={String(open.length)} />
              <Stat label="cleared" value={String(done.length)} />
            </div>
          </div>

          <div className="h-px bg-osu-b3/25" />

          <div className="space-y-4 p-4 sm:p-5">
            <TypeSelector kind={kind} onSwitch={switchKind} />

            <div className="flex flex-col gap-3.5 lg:flex-row lg:items-start lg:justify-between lg:gap-5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-2.5 text-[16px] font-semibold text-osu-l2 sm:text-[17px]">
                  {scope === "pp" ? (
                    kind === "reach_pp" ? (
                      <>
                        <span>Reach</span>
                        <NumberToken value={ppTarget} onChange={setPpTarget} placeholder={suggestions.reachPpPlaceholder || "15000"} suffix="pp" accent={accent} width="6.5rem" ariaLabel="Target total pp" />
                        <span>total pp</span>
                      </>
                    ) : (
                      <>
                        <span>Land a play worth</span>
                        <NumberToken value={ppTarget} onChange={setPpTarget} placeholder={suggestions.playPpPlaceholder || "300"} suffix="pp" accent={accent} width="5rem" ariaLabel="Play worth at least" />
                      </>
                    )
                  ) : null}

                  {scope === "pp-count" ? (
                    <>
                      <span>Have</span>
                      <NumberToken value={ppCountTarget} onChange={setPpCountTarget} placeholder={suggestions.ppCountPlaceholder} accent={accent} width="4rem" ariaLabel="Target play count" />
                      <span>plays worth</span>
                      <NumberToken value={ppTarget} onChange={setPpTarget} placeholder={suggestions.playPpPlaceholder || "600"} suffix="pp" accent={accent} width="5rem" ariaLabel="Minimum pp per play" />
                      <span>or more</span>
                    </>
                  ) : null}

                  {scope === "rank" ? (
                    <>
                      <span>Reach</span>
                      <RankScopeToggle value={rankScope} onChange={setRankScope} accent={accent} />
                      <span>rank</span>
                      <NumberToken value={rankTarget} onChange={setRankTarget} placeholder={active.placeholder} prefix="#" accent={accent} width="5rem" ariaLabel="Target rank" />
                    </>
                  ) : null}

                  {scope === "map-acc" ? (
                    <>
                      <span>Hit</span>
                      <NumberToken value={accPct} onChange={setAccPct} placeholder={active.placeholder} suffix="%" accent={accent} width="4rem" decimal ariaLabel="Target accuracy" />
                      <span>accuracy on</span>
                      {mapSlot}
                    </>
                  ) : null}

                  {scope === "map" ? (
                    <>
                      <span>Pass</span>
                      {mapSlot}
                    </>
                  ) : null}

                  {scope === "map-fc" ? (
                    <>
                      <span>FC</span>
                      {mapSlot}
                    </>
                  ) : null}

                  {scope === "map-grade" ? (
                    <>
                      <span>Earn</span>
                      <GradeToken value={grade} onChange={setGrade} accent={accent} />
                      <span>on</span>
                      {mapSlot}
                    </>
                  ) : null}
                </div>
                {hint ? <div className="mt-2.5 text-[11.5px] font-semibold text-osu-f1">{hint}</div> : null}
              </div>

              <SetGoalButton canSubmit={canSubmit} creating={creating} accent={accent} onClick={() => void submit()} />
            </div>

            {needsMap && !resolved ? (
              <MapSearchRow
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
            ) : null}

            {createError ? <div className="text-[12px] font-semibold text-osu-red-light">{createError}</div> : null}
          </div>
        </div>
      </section>

      <GoalSections loading={loading} open={open} done={done} onDelete={remove} onAgain={goAgain} />
      <CelebrationToast celebration={celebration} onDismiss={() => setCelebration(null)} />
    </PageShell>
  );
}

const COMPOSER_TRIANGLES: Array<{ p: string; o: number }> = [
  { p: "-150,200 0,20 150,200", o: 0.05 },
  { p: "150,200 300,20 450,200", o: 0.07 },
  { p: "450,200 600,20 750,200", o: 0.04 },
  { p: "750,200 900,20 1050,200", o: 0.06 },
  { p: "1050,200 1200,20 1350,200", o: 0.045 },
  { p: "0,20 300,20 150,200", o: 0.03 },
  { p: "300,20 600,20 450,200", o: 0.05 },
  { p: "600,20 900,20 750,200", o: 0.035 },
  { p: "900,20 1200,20 1050,200", o: 0.055 },
  { p: "-150,380 0,200 150,380", o: 0.035 },
  { p: "150,380 300,200 450,380", o: 0.05 },
  { p: "450,380 600,200 750,380", o: 0.03 },
  { p: "750,380 900,200 1050,380", o: 0.045 },
  { p: "0,200 300,200 150,380", o: 0.055 },
  { p: "300,200 600,200 450,380", o: 0.035 },
  { p: "600,200 900,200 750,380", o: 0.05 },
  { p: "900,200 1200,200 1050,380", o: 0.03 },
];

function ComposerTriangles() {
  return (
    <svg viewBox="0 20 1200 360" preserveAspectRatio="xMidYMid slice" className="h-full w-full text-osu-pink" aria-hidden="true">
      {COMPOSER_TRIANGLES.map((triangle, index) => (
        <polygon key={index} points={triangle.p} fill="currentColor" fillOpacity={triangle.o} />
      ))}
    </svg>
  );
}

function Stat({ label, value, tone = "default" }: { label: string; value: string; tone?: "pp" | "default" }) {
  return (
    <div className="text-right">
      <div className={`text-[15px] font-extrabold leading-none tabular-nums ${tone === "pp" ? "text-osu-pink-light" : "text-osu-l1"}`}>{value}</div>
      <div className="mt-1 text-[9px] font-bold uppercase tracking-[0.14em] text-osu-f1">{label}</div>
    </div>
  );
}

// Goal kinds split into two groups so eight types don't read as one undifferentiated strip: the
// profile climbs (pp / rank, no map) and the per-map challenges. Compact icon+label chips, no
// per-button example line; the composer sentence below carries the specifics once a type is picked.
const TYPE_GROUPS: Array<{ key: GoalGroup; label: string }> = [
  { key: "profile", label: "profile" },
  { key: "map", label: "on a map" },
];

function TypeSelector({ kind, onSwitch }: { kind: GoalKind; onSwitch: (next: GoalKind) => void }) {
  return (
    <div className="space-y-2.5">
      {TYPE_GROUPS.map((group) => (
        <div key={group.key}>
          <div className="mb-1.5 text-[9px] font-extrabold uppercase tracking-[0.16em] text-osu-f1">{group.label}</div>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {GOAL_TYPES.filter((type) => type.group === group.key).map((type) => {
              const selected = kind === type.kind;
              return (
                <button
                  key={type.kind}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSwitch(type.kind)}
                  style={selected ? { backgroundColor: `${type.accent}1f`, borderColor: `${type.accent}80`, color: "#fff" } : undefined}
                  className={`flex w-full items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-[12px] font-bold transition-colors ${
                    selected ? "" : "border-osu-b3/30 bg-osu-b5/40 text-osu-l2 hover:border-osu-b3/55 hover:bg-osu-b3/25 hover:text-white"
                  }`}
                >
                  <OsuAssetIcon src={type.iconSrc} className="h-3.5 w-3.5 shrink-0" style={{ color: type.accent }} />
                  {type.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function NumberToken({
  value,
  onChange,
  placeholder,
  suffix,
  prefix,
  accent,
  decimal = false,
  width,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  suffix?: string;
  prefix?: string;
  accent: string;
  decimal?: boolean;
  width: string;
  ariaLabel: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1 rounded-md bg-osu-b5/55 px-1.5 pt-0.5 align-middle" style={{ boxShadow: `inset 0 -2px 0 ${accent}` }}>
      {prefix ? <span className="text-[15px] font-extrabold text-osu-f1">{prefix}</span> : null}
      <input
        type="text"
        inputMode={decimal ? "decimal" : "numeric"}
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value.replace(decimal ? /[^0-9.]/g : /[^0-9]/g, ""))}
        placeholder={placeholder}
        style={{ width, caretColor: accent }}
        className="bg-transparent py-1 text-center text-[18px] font-extrabold tabular-nums text-white outline-none placeholder:font-bold placeholder:text-osu-f1/40"
      />
      {suffix ? <span className="pr-0.5 text-[12.5px] font-bold text-osu-f1">{suffix}</span> : null}
    </span>
  );
}

function RankScopeToggle({ value, onChange, accent }: { value: RankScope; onChange: (scope: RankScope) => void; accent: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 rounded-lg border border-osu-b3/45 bg-osu-b5/55 p-0.5 align-middle text-[12.5px] font-bold">
      {(["global", "country"] as RankScope[]).map((option) => {
        const selected = option === value;
        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            aria-pressed={selected}
            className={`rounded-md px-2 py-1 transition-colors ${selected ? "text-white" : "text-osu-l2 hover:text-white"}`}
            style={selected ? { backgroundColor: `${accent}26` } : undefined}
          >
            {option}
          </button>
        );
      })}
    </span>
  );
}

function GradeToken({ value, onChange, accent }: { value: (typeof GRADES)[number]; onChange: (grade: (typeof GRADES)[number]) => void; accent: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 rounded-lg border border-osu-b3/45 bg-osu-b5/55 p-1 align-middle">
      {GRADES.map((option) => {
        const selected = option === value;
        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            aria-pressed={selected}
            className={`flex h-8 items-center justify-center rounded-md px-2 transition-opacity ${selected ? "" : "opacity-40 hover:opacity-80"}`}
            style={selected ? { backgroundColor: `${accent}26` } : undefined}
          >
            <GradeImg grade={option} size={40} className="h-[18px] w-auto" />
          </button>
        );
      })}
    </span>
  );
}

function MapChip({ resolved, accent, onReset }: { resolved: ResolvedMap; accent: string; onReset: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-2 rounded-lg border bg-osu-b5/70 py-1 pl-1 pr-1.5 align-middle" style={{ borderColor: `${accent}66` }}>
      <img src={resolved.cover} alt="" className="h-7 w-12 shrink-0 rounded-md object-cover" loading="lazy" />
      <span className="max-w-[180px] truncate text-[13px] font-bold text-white sm:max-w-[280px]" title={resolved.label}>
        {resolved.label}
      </span>
      <button type="button" onClick={onReset} aria-label="Change map" className="shrink-0 rounded-md p-0.5 text-osu-l2 transition-colors hover:bg-osu-b3/60 hover:text-white">
        <CloseGlyph />
      </button>
    </span>
  );
}

function PendingMapToken({ set, accent }: { set: OsuBeatmapset; accent: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-lg border border-dashed bg-osu-b5/55 py-1 pl-1 pr-2.5 align-middle" style={{ borderColor: `${accent}66` }}>
      <img src={listCover(set)} alt="" className="h-7 w-12 shrink-0 rounded-md object-cover" loading="lazy" />
      <span className="text-[12px] font-bold" style={{ color: accent }}>
        pick a difficulty below
      </span>
    </span>
  );
}

function PlaceholderToken({ label, accent }: { label: string; accent: string }) {
  return (
    <span className="inline-flex items-center rounded-md px-1.5 pt-0.5 align-middle" style={{ boxShadow: `inset 0 -2px 0 ${accent}` }}>
      <span className="py-1 text-[16px] font-extrabold" style={{ color: accent }}>
        {label}
      </span>
    </span>
  );
}

function SetGoalButton({ canSubmit, creating, accent, onClick }: { canSubmit: boolean; creating: boolean; accent: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!canSubmit}
      style={canSubmit ? { backgroundColor: `${accent}24`, borderColor: `${accent}80`, color: "#fff" } : undefined}
      className="inline-flex h-11 w-full shrink-0 items-center justify-center gap-1.5 rounded-xl border px-5 text-[13px] font-bold transition hover:brightness-110 disabled:cursor-default disabled:border-osu-b3/30 disabled:bg-osu-b5/40 disabled:text-osu-f1/55 disabled:hover:brightness-100 lg:w-auto"
    >
      {creating ? <Spinner /> : <span className="text-[17px] leading-none" aria-hidden="true">+</span>}
      Set goal
    </button>
  );
}

function MapSearchRow({
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
  if (pickedSet) {
    return (
      <div className="overflow-hidden rounded-xl border border-osu-b3/30 bg-osu-b5/55">
        <div className="flex items-center gap-2.5 border-b border-osu-b3/25 p-2.5">
          <img src={listCover(pickedSet)} alt="" className="h-10 w-16 shrink-0 rounded-md object-cover" loading="lazy" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-bold text-white">
              {pickedSet.artist} - {pickedSet.title}
            </div>
            <div className="text-[10.5px] font-semibold text-osu-f1">Choose a mania difficulty</div>
          </div>
          <button type="button" onClick={onReset} aria-label="Back" className="shrink-0 rounded-md p-1.5 text-osu-l2 transition-colors hover:bg-osu-b3/55 hover:text-white">
            <CloseGlyph />
          </button>
        </div>
        <div className="flex max-h-[210px] flex-wrap gap-1.5 overflow-y-auto p-2.5">
          {maniaDiffs(pickedSet).map((diff) => (
            <button
              key={diff.id}
              type="button"
              onClick={() => onResolveDiff(pickedSet, diff)}
              className="flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-osu-b3/35 bg-osu-b4 px-2.5 py-1.5 text-[11.5px] text-osu-l2 transition-colors hover:border-osu-pink/45 hover:text-white"
            >
              <span className="font-bold tabular-nums text-osu-yellow">{(diff.difficulty_rating ?? 0).toFixed(2)}★</span>
              <span className="truncate">{diff.version}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="flex h-11 items-center rounded-xl border border-osu-b3/45 bg-osu-b5/70 focus-within:border-osu-pink/55">
        <OsuAssetIcon src={ICONS.search} className="ml-3 h-4 w-4 shrink-0 opacity-55" />
        <input
          value={mapQuery}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search a map or paste a beatmap ID..."
          aria-label="Search for a map"
          className="min-w-0 flex-1 bg-transparent px-2.5 text-[13px] font-semibold text-white outline-none placeholder:text-osu-f1/60"
        />
        {searching ? <Spinner className="mr-3 h-4 w-4 shrink-0 text-osu-f1" /> : null}
      </div>
      {results.length > 0 ? (
        <div className="absolute left-0 right-0 top-full z-40 mt-2 max-h-[300px] space-y-1 overflow-y-auto rounded-xl border border-osu-b3/30 bg-osu-b5 p-1 shadow-[0_18px_60px_rgba(0,0,0,0.5)]">
          {results.map((set) => {
            const diffs = maniaDiffs(set);
            return (
              <button key={set.id} type="button" onClick={() => onPickSet(set)} className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-osu-b3/35">
                <img src={listCover(set)} alt="" className="h-10 w-16 shrink-0 rounded object-cover" loading="lazy" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-bold text-white">{set.title}</span>
                  <span className="block truncate text-[10.5px] text-osu-f1">
                    {set.artist} · {diffs.length} mania diff{diffs.length === 1 ? "" : "s"}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : lookupError ? (
        <div className="mt-2 px-1 text-[11.5px] font-semibold text-osu-red-light">{lookupError}</div>
      ) : mapQuery.trim().length >= 3 && !searching ? (
        <div className="mt-2 px-1 text-[11.5px] text-osu-f1">No mania maps found.</div>
      ) : null}
    </div>
  );
}

function GoalSections({ loading, open, done, onDelete, onAgain }: { loading: boolean; open: UserGoal[]; done: UserGoal[]; onDelete: (id: string) => void | Promise<void>; onAgain: (goal: UserGoal) => void }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-osu-b3/25 bg-osu-b4/50 py-16 text-[13px] text-osu-f1">
        <Spinner />
        Loading goals...
      </div>
    );
  }

  if (open.length === 0 && done.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-osu-b3/35 bg-osu-b4/30 px-5 py-12">
        <div className="text-center">
          <div className="text-[14px] font-bold text-osu-l2">No goals tracked yet</div>
          <div className="mx-auto mt-1 max-w-sm text-[12.5px] leading-5 text-osu-f1">Pick a target above. Progress updates as your mania plays land.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <SectionLabel title="Active" count={open.length} />
        {open.length > 0 ? (
          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            {open.map((goal) => (
              <GoalCard key={goal.id} goal={goal} onDelete={() => void onDelete(goal.id)} />
            ))}
          </div>
        ) : (
          <div className="mt-3 rounded-2xl border border-dashed border-osu-b3/30 bg-osu-b4/30 p-8 text-center text-[12.5px] text-osu-f1">Nothing active right now.</div>
        )}
      </div>

      {done.length > 0 ? (
        <div>
          <SectionLabel title="Cleared" count={done.length} />
          <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {done.map((goal) => (
              <ClearedChip key={goal.id} goal={goal} onDelete={() => void onDelete(goal.id)} onAgain={() => onAgain(goal)} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SectionLabel({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-osu-l2">{title}</span>
      <span className="rounded-md border border-osu-b3/35 bg-osu-b4 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-osu-f1">{count}</span>
      <span className="h-px flex-1 bg-osu-b3/25" />
    </div>
  );
}

function GoalRing({ pct, accent, size, stroke, children }: { pct: number | null; accent: string; size: number; stroke: number; children: ReactNode }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const value = pct == null ? 0 : clampPct(pct);
  const offset = circumference * (1 - value / 100);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" className="text-osu-b3/40" strokeWidth={stroke} />
        {pct != null && value > 0 ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={accent}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(0.4, 0, 0.2, 1)" }}
          />
        ) : null}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="block truncate text-[12px] text-osu-f1">{children}</span>;
}

// A single standing with an optional dimmer "to go" tail. No "X -> Y": the ring shows the climb,
// this just states where you are and how far is left.
function StatLine({ main, sub }: { main: string; sub?: string | null }) {
  return (
    <span className="text-[12px] font-semibold tabular-nums text-osu-l2">
      {main}
      {sub ? <span className="font-normal text-osu-f1"> · {sub}</span> : null}
    </span>
  );
}

// Best grade so far, as a badge. The target grade rides in the media corner, so no arrow is needed.
function GradeProgress({ current }: { current: string | null }) {
  return current ? (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-osu-f1">
      <span className="uppercase tracking-wide">best</span>
      <GradeImg grade={current} size={36} className="h-[19px] w-auto" />
    </span>
  ) : (
    <Muted>not passed yet</Muted>
  );
}

// Best grade so far: prefer the structured field, fall back to parsing the "best A" hint so the
// badge works even before the backend that sends currentGrade is live.
function bestGradeOf(progress: UserGoal["progress"]): string | null {
  if (progress?.currentGrade) return progress.currentGrade;
  const match = progress?.detail?.match(/^best ([A-Z]{1,3})$/i);
  return match ? match[1].toUpperCase() : null;
}

// Accuracy ring fill. A raw best/target arc is useless here: accuracy clusters near the top, so
// 94.59/95 is 99.6% and the circle looks closed when it isn't. Instead fill by how much of the
// final ~1.5 points up to the target is covered, clamped to [10%, 82%] so an open goal always reads
// as in-progress (never empty, never a closed circle). The exact gap lives in the text readout.
function accuracyRingPct(goal: UserGoal): number | null {
  const current = goal.progress?.current ?? null;
  const target = goal.progress?.target ?? goal.targetValue ?? null;
  if (current == null || target == null || target <= 0) return null;
  const gapPoints = Math.max(0, (target - current) * 100);
  const filled = 1 - gapPoints / 1.5;
  return Math.round(Math.max(0.1, Math.min(0.82, filled)) * 100);
}

// The readout is type-specific and arrow-free: a gap for pp, a best for accuracy, a best grade
// badge, a current rank, a play count for passes. Progress is carried by the ring where one fits.
function GoalReadout({ goal }: { goal: UserGoal }) {
  const current = goal.progress?.current ?? null;
  const target = goal.progress?.target ?? goal.targetValue ?? null;
  switch (goal.kind) {
    case "reach_pp": {
      const remaining = current != null && target != null ? Math.max(0, target - current) : null;
      return remaining != null && remaining > 0 ? <StatLine main={`${nf(remaining)}pp to go`} /> : <Muted>{goal.progress?.detail ?? "Tracking your plays"}</Muted>;
    }
    case "reach_rank":
      return current != null ? <StatLine main={`now #${nf(current)}`} /> : <Muted>{goal.progress?.detail ?? "Tracking your rank"}</Muted>;
    case "play_pp":
      if (current != null && current > 0 && target != null && current < target) {
        return <StatLine main={`best ${Math.round(current)}pp`} sub={`+${Math.round(target - current)}pp to go`} />;
      }
      if (current != null && target != null && current >= target) {
        return (
          <Muted>waiting for another {Math.round(target)}pp+ play</Muted>
        );
      }
      return (
        <Muted>chasing your first {target != null ? Math.round(target) : "big"}pp play</Muted>
      );
    case "play_pp_count": {
      const threshold = goal.targetValue != null ? Math.round(goal.targetValue) : null;
      const remaining = current != null && target != null ? Math.max(0, target - current) : null;
      return current != null && target != null ? (
        <StatLine main={`${nf(current)} / ${nf(target)} plays`} sub={remaining != null && remaining > 0 && threshold != null ? `${nf(remaining)} to go at ${threshold}pp+` : null} />
      ) : (
        <Muted>{threshold != null ? `counting ${threshold}pp+ plays` : "counting pp plays"}</Muted>
      );
    }
    case "accuracy":
      return current != null && target != null ? (
        <StatLine main={`best ${(current * 100).toFixed(2)}%`} sub={target - current > 0 ? `${((target - current) * 100).toFixed(2)}% to go` : null} />
      ) : (
        <Muted>{goal.progress?.detail ?? "not played yet"}</Muted>
      );
    case "grade":
      return <GradeProgress current={bestGradeOf(goal.progress)} />;
    default:
      return <Muted>{goal.progress?.detail ?? "Tracking your plays"}</Muted>;
  }
}

// Reach pp / rank / count goals are continuous climbs and keep a progress ring; accuracy gets a
// closeness ring wrapping its cover; big play is a milestone badge; grade / pass show the cover,
// progress in text.
function GoalMedia({ goal, accent, href }: { goal: UserGoal; accent: string; href: string | null }) {
  const meta = goalMeta(goal.kind);
  const cover = coverUrl(goal.beatmapsetId);

  if (goal.kind === "reach_pp" || goal.kind === "reach_rank" || goal.kind === "play_pp_count") {
    const pct = progressPct(goal);
    return (
      <GoalRing pct={pct} accent={accent} size={84} stroke={6}>
        <span className="text-[19px] font-extrabold tabular-nums text-white">{pct == null ? "·" : `${pct}%`}</span>
      </GoalRing>
    );
  }

  if (goal.kind === "accuracy") {
    const pct = accuracyRingPct(goal);
    const inner = cover ? (
      <img src={cover} alt="" className="h-[58px] w-[58px] rounded-full object-cover" loading="lazy" />
    ) : (
      <span className="flex h-[58px] w-[58px] items-center justify-center rounded-full" style={{ backgroundColor: `${accent}1f` }}>
        <OsuAssetIcon src={meta.iconSrc} className="h-6 w-6 opacity-85" />
      </span>
    );
    return (
      <GoalRing pct={pct} accent={accent} size={84} stroke={6}>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="block rounded-full transition-transform hover:scale-[1.04]" aria-label={`Open ${goal.beatmapLabel ?? "map"} on osu!`}>
            {inner}
          </a>
        ) : (
          inner
        )}
      </GoalRing>
    );
  }

  if (goal.kind === "play_pp") {
    return (
      <span className="flex h-[84px] w-[84px] shrink-0 items-center justify-center rounded-full border-2" style={{ borderColor: `${accent}55`, backgroundColor: `${accent}14` }}>
        <OsuAssetIcon src={meta.iconSrc} className="h-9 w-9 opacity-90" />
      </span>
    );
  }

  const disc = cover ? (
    <img src={cover} alt="" className="h-full w-full rounded-full object-cover" loading="lazy" />
  ) : (
    <span className="flex h-full w-full items-center justify-center rounded-full" style={{ backgroundColor: `${accent}1f` }}>
      <OsuAssetIcon src={meta.iconSrc} className="h-7 w-7 opacity-85" />
    </span>
  );
  return (
    <span className="relative h-[84px] w-[84px] shrink-0">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="block h-full w-full rounded-full ring-1 ring-osu-b3/30 transition-transform hover:scale-[1.04]" aria-label={`Open ${goal.beatmapLabel ?? "map"} on osu!`}>
          {disc}
        </a>
      ) : (
        <span className="block h-full w-full rounded-full ring-1 ring-osu-b3/30">{disc}</span>
      )}
      {goal.kind === "grade" ? (
        <span className="pointer-events-none absolute -bottom-1 -right-1 flex items-center justify-center rounded-full bg-osu-b6 p-1 ring-1 ring-osu-b3/50">
          <GradeImg grade={goal.targetGrade ?? "S"} size={30} className="h-[18px] w-auto" />
        </span>
      ) : null}
      {goal.kind === "fc" ? (
        <span className="pointer-events-none absolute -bottom-1 -right-1 flex items-center justify-center rounded-full bg-osu-b6 px-1.5 py-0.5 text-[9px] font-extrabold leading-none ring-1 ring-osu-b3/50" style={{ color: accent }}>
          FC
        </span>
      ) : null}
    </span>
  );
}

function GoalCard({ goal, onDelete }: { goal: UserGoal; onDelete: () => void }) {
  const meta = goalMeta(goal.kind);
  const accent = meta.accent;
  const href = beatmapHref(goal.beatmapId);

  return (
    <article className="group relative flex items-center gap-3.5 rounded-2xl border border-osu-b3/30 bg-osu-b4 p-3.5">
      <GoalMedia goal={goal} accent={accent} href={href} />

      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-extrabold uppercase tracking-[0.14em]" style={{ color: accent }}>
          {meta.label}
        </div>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="mt-1 block truncate text-[14px] font-bold text-white transition-colors hover:text-osu-pink-light hover:underline"
            title={`Open ${goal.beatmapLabel ?? describeGoal(goal)} on osu!`}
          >
            {describeGoal(goal)}
          </a>
        ) : (
          <div className="mt-1 truncate text-[14px] font-bold text-white" title={describeGoal(goal)}>
            {describeGoal(goal)}
          </div>
        )}
        <div className="mt-1.5">
          <GoalReadout goal={goal} />
        </div>
      </div>

      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete goal"
        className="-mr-1 -mt-1 shrink-0 self-start rounded-md p-1 text-osu-f1/60 transition-colors hover:bg-osu-red/10 hover:text-osu-red-light"
      >
        <CloseGlyph />
      </button>
    </article>
  );
}

function ClearedChip({ goal, onDelete, onAgain }: { goal: UserGoal; onDelete: () => void; onAgain: () => void }) {
  const meta = goalMeta(goal.kind);
  const cover = coverUrl(goal.beatmapsetId);
  return (
    <article className="group relative flex items-center gap-3 rounded-xl border border-osu-b3/25 bg-osu-b4/50 p-2.5">
      <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-osu-b5">
        {cover ? (
          <img src={cover} alt="" className="h-full w-full object-cover opacity-40 grayscale" loading="lazy" />
        ) : (
          <span className="flex h-full w-full items-center justify-center" style={{ backgroundColor: `${meta.accent}1f` }}>
            <OsuAssetIcon src={meta.iconSrc} className="h-5 w-5 opacity-80" />
          </span>
        )}
        <span className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full bg-osu-b6 p-0.5 ring-1 ring-osu-b3/50">
          {goal.kind === "grade" ? <GradeImg grade={goal.targetGrade ?? "S"} size={26} className="h-3.5 w-auto" /> : <OsuLogo className="h-3 w-3 text-osu-green-light" />}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        {beatmapHref(goal.beatmapId) ? (
          <a
            href={beatmapHref(goal.beatmapId) ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-[12.5px] font-bold text-osu-l2 transition-colors hover:text-osu-pink-light hover:underline"
            title={`Open ${goal.beatmapLabel ?? describeGoal(goal)} on osu!`}
          >
            {describeGoal(goal)}
          </a>
        ) : (
          <div className="truncate text-[12.5px] font-bold text-osu-l2" title={describeGoal(goal)}>
            {describeGoal(goal)}
          </div>
        )}
        <div className="mt-0.5 truncate text-[10.5px] font-semibold text-osu-green-light">{completedDetail(goal) ?? "cleared"}</div>
      </div>
      <button
        type="button"
        onClick={onAgain}
        className="shrink-0 self-start rounded-md px-1.5 py-1 text-[10.5px] font-bold text-osu-f1 transition-colors hover:bg-osu-pink/10 hover:text-osu-pink-light"
        title="Set this goal again"
      >
        go again
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete goal"
        className="shrink-0 self-start rounded-md p-1 text-osu-f1/55 transition-colors hover:bg-osu-red/10 hover:text-osu-red-light"
      >
        <CloseGlyph />
      </button>
    </article>
  );
}

function CelebrationTriangles() {
  return (
    <svg viewBox="0 20 1200 360" preserveAspectRatio="xMidYMid slice" className="h-full w-full text-osu-green-light" aria-hidden="true">
      {COMPOSER_TRIANGLES.map((triangle, index) => (
        <polygon key={index} points={triangle.p} fill="currentColor" fillOpacity={triangle.o} />
      ))}
    </svg>
  );
}

// One-shot "goal cleared" beat: pops in on the goal_completed SSE for the viewer, runs an osu-green
// burst with the cleared goal, then ticks down a bar and dismisses itself. Not a section animation -
// a deliberate moment for an earned milestone.
function CelebrationToast({ celebration, onDismiss }: { celebration: Celebration | null; onDismiss: () => void }) {
  return (
    <AnimatePresence>
      {celebration ? (
        <motion.div
          key={celebration.id}
          initial={{ opacity: 0, y: 28, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 14, scale: 0.97 }}
          transition={{ type: "spring", stiffness: 340, damping: 26 }}
          className="fixed inset-x-0 bottom-5 z-[80] flex justify-center px-4"
          role="status"
          aria-live="polite"
        >
          <div className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-osu-green/45 bg-osu-b4 shadow-[0_20px_70px_rgba(0,0,0,0.55)]">
            <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl opacity-70">
              <CelebrationTriangles />
            </div>
            <div className="relative flex items-center gap-3 p-3.5">
              <motion.span
                initial={{ scale: 0.5 }}
                animate={{ scale: [0.5, 1.18, 1] }}
                transition={{ duration: 0.5, times: [0, 0.6, 1], ease: "easeOut" }}
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-osu-green/15 ring-1 ring-osu-green/40"
              >
                {celebration.kind === "grade" && celebration.targetGrade ? (
                  <GradeImg grade={celebration.targetGrade} size={44} className="h-6 w-auto" />
                ) : (
                  <OsuLogo className="h-6 w-6 text-osu-green-light" />
                )}
              </motion.span>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-osu-green-light">goal cleared</div>
                <div className="mt-0.5 truncate text-[13.5px] font-bold text-white" title={celebration.label}>
                  {celebration.label}
                </div>
              </div>
              <button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0 self-start rounded-md p-1 text-osu-f1/70 transition-colors hover:bg-osu-b3/60 hover:text-white">
                <CloseGlyph />
              </button>
            </div>
            <motion.div
              initial={{ scaleX: 1 }}
              animate={{ scaleX: 0 }}
              transition={{ duration: 6.5, ease: "linear" }}
              style={{ transformOrigin: "left" }}
              className="h-0.5 bg-osu-green/60"
            />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
