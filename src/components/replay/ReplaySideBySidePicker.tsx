import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { ArrowLeftRight, LoaderCircle, Plus, X } from "lucide-react";

import { avatarImageSrc } from "#/components/ui/Avatar";
import { CountryFlag } from "#/components/ui/CountryFlag";
import { GradeImg } from "#/components/ui/GradeImg";
import { ModBadge } from "#/components/ui/ModBadge";
import { ReplayRecentlyViewed } from "#/components/replay/ReplayRecentlyViewed";
import { formatAccuracy, formatPP } from "#/lib/format";
import { getBeatmapScores, getScore } from "#/lib/osu";
import type { RecentReplayEntry } from "#/lib/replay-recent";
import { parseReplayScoreInput } from "#/lib/replay-score-input";
import { getSideBySideCandidateIssue, getSideBySideIssue, getSideBySideScoreIssue } from "#/lib/replay-side-by-side";
import { getDisplayedAccuracy, getDisplayedRank, getModDisplayList } from "#/lib/score";
import type { OsuScore } from "#/lib/types";

/* Setup screen for the Side by Side tab: pick the two runs, then watch them on
   one clock. It is built as the matchup it produces, two cards facing each
   other in the colours the stages will use, so the screen reads as "these two"
   before anything is loaded.

   Two ways in, because both are how people actually arrive: paste a score link
   you were sent, or fill one side and take the other off that map's
   leaderboard. The pair rules live in replay-side-by-side.ts, so a row that
   can't work says why before it is clicked, not after. */

type SlotIndex = 0 | 1;

interface SlotState {
  score: OsuScore | null;
  input: string;
  loading: boolean;
  error: string | null;
}

const EMPTY_SLOT: SlotState = { score: null, input: "", loading: false, error: null };

const SLOT_META = [
  {
    label: "Left",
    accent: "text-osu-pink-light",
    ring: "ring-osu-pink/45",
    glow: "from-osu-pink/25",
    hover: "hover:border-osu-pink/45",
  },
  {
    label: "Right",
    accent: "text-osu-blue",
    ring: "ring-osu-blue/45",
    glow: "from-osu-blue/25",
    hover: "hover:border-osu-blue/45",
  },
] as const;

export function ReplaySideBySidePicker({
  recentReplays,
  onStart,
}: {
  recentReplays: RecentReplayEntry[];
  onStart: (leftScoreId: number, rightScoreId: number) => void;
}) {
  const [slots, setSlots] = useState<[SlotState, SlotState]>([EMPTY_SLOT, EMPTY_SLOT]);
  const [candidates, setCandidates] = useState<OsuScore[] | null>(null);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  // Per slot: adding to one side must not strand the other side's pending load.
  const requestRefs = useRef<[number, number]>([0, 0]);

  const [left, right] = slots;
  const anchor = left.score ?? right.score;
  const anchorBeatmapId = anchor?.beatmap?.id ?? null;
  const pairIssue = left.score && right.score ? getSideBySideIssue(left.score, right.score) : null;
  const canStart = Boolean(left.score && right.score && !pairIssue);

  const setSlot = useCallback((index: SlotIndex, next: Partial<SlotState>) => {
    setSlots((current) => {
      const updated: [SlotState, SlotState] = [current[0], current[1]];
      updated[index] = { ...updated[index], ...next };
      return updated;
    });
  }, []);

  const loadIntoSlot = useCallback(async (index: SlotIndex, scoreId: number) => {
    const request = ++requestRefs.current[index];
    setSlot(index, { loading: true, error: null });
    try {
      const score = await getScore({ data: { scoreId, mode: "mania" } });
      if (requestRefs.current[index] !== request) return;
      if (!score) throw new Error("That score couldn't be loaded.");
      const issue = getSideBySideScoreIssue(score);
      if (issue) {
        setSlot(index, { loading: false, error: issue.message });
        return;
      }
      setSlot(index, { score, loading: false, error: null, input: "" });
    } catch {
      if (requestRefs.current[index] !== request) return;
      setSlot(index, { loading: false, error: "That score couldn't be loaded. Check the link and try again." });
    }
  }, [setSlot]);

  // One side picked is enough to know the map, so pull its leaderboard and let
  // the other side come from a click instead of hunting for a second link.
  useEffect(() => {
    if (!anchorBeatmapId) {
      setCandidates(null);
      return;
    }
    let cancelled = false;
    setCandidatesLoading(true);
    getBeatmapScores({ data: { beatmapId: anchorBeatmapId, page: 1 } })
      .then((response) => {
        if (cancelled) return;
        setCandidates((response as { scores?: OsuScore[] } | null)?.scores ?? []);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      })
      .finally(() => {
        if (!cancelled) setCandidatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [anchorBeatmapId]);

  const pickCandidate = useCallback((score: OsuScore) => {
    setSlots((current) => {
      // Fill the empty side; with both filled, replace the one that isn't the
      // anchor so the leaderboard stays browsable.
      const target: SlotIndex = !current[0].score ? 0 : !current[1].score ? 1 : 1;
      const updated: [SlotState, SlotState] = [current[0], current[1]];
      updated[target] = { score, input: "", loading: false, error: null };
      return updated;
    });
  }, []);

  const firstEmptySlot: SlotIndex | null = !left.score ? 0 : !right.score ? 1 : null;
  const recentScoreEntries = recentReplays.filter((entry) => entry.scoreId != null);

  return (
    <div className="mx-auto max-w-4xl">
      <h3 className="text-center text-sm font-semibold uppercase tracking-wider text-osu-f1">
        Watch two runs of the same map at once
      </h3>

      <div className="mt-4 grid items-stretch gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:gap-2">
        <Slot
          index={0}
          state={left}
          onSubmitInput={(scoreId) => loadIntoSlot(0, scoreId)}
          onInputChange={(input) => setSlot(0, { input, error: null })}
          onClear={() => setSlot(0, { ...EMPTY_SLOT })}
        />
        <MatchupBadge />
        <Slot
          index={1}
          state={right}
          onSubmitInput={(scoreId) => loadIntoSlot(1, scoreId)}
          onInputChange={(input) => setSlot(1, { input, error: null })}
          onClear={() => setSlot(1, { ...EMPTY_SLOT })}
        />
      </div>

      {pairIssue && (
        <p className="mx-auto mt-3 max-w-lg rounded-lg bg-osu-red/10 px-4 py-2 text-center text-xs text-osu-red-light">
          {pairIssue.message}
        </p>
      )}

      <div className="mt-5 flex justify-center">
        <button
          type="button"
          disabled={!canStart}
          onClick={() => {
            if (left.score && right.score) onStart(left.score.id, right.score.id);
          }}
          className={`rounded-full px-8 py-2.5 text-sm font-bold transition ${
            canStart
              ? "bg-osu-pink text-white hover:brightness-110 cursor-pointer"
              : "cursor-not-allowed bg-osu-b4 text-osu-f1/60"
          }`}
        >
          Watch side by side
        </button>
      </div>

      {anchor ? (
        <div className="mt-8">
          <MapStrip score={anchor} loading={candidatesLoading} />
          <CandidateList
            candidates={candidates}
            loading={candidatesLoading}
            slots={slots}
            targetLabel={firstEmptySlot == null ? SLOT_META[1].label : SLOT_META[firstEmptySlot].label}
            onPick={pickCandidate}
          />
        </div>
      ) : (
        <ReplayRecentlyViewed
          entries={recentScoreEntries}
          title="Start from one you watched"
          onOpen={(entry) => {
            if (entry.scoreId != null) void loadIntoSlot(0, entry.scoreId);
          }}
          onRemove={() => {}}
          onClear={() => {}}
          showRemove={false}
          className="mt-10"
        />
      )}
    </div>
  );
}

// The seam between the two cards, in the colours the stages will use. The
// rotation is what makes it read as a join rather than a third card.
function MatchupBadge() {
  return (
    <div className="flex items-center justify-center sm:px-1">
      <div className="relative flex h-11 w-11 rotate-45 items-center justify-center rounded-xl border border-white/10 bg-gradient-to-br from-osu-pink/30 to-osu-blue/30">
        <ArrowLeftRight className="h-4 w-4 -rotate-45 text-white/85" aria-hidden="true" />
      </div>
    </div>
  );
}

function Slot({ index, state, onSubmitInput, onInputChange, onClear }: {
  index: SlotIndex;
  state: SlotState;
  onSubmitInput: (scoreId: number) => void;
  onInputChange: (input: string) => void;
  onClear: () => void;
}) {
  const meta = SLOT_META[index];
  const parsed = parseReplayScoreInput(state.input);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (parsed) onSubmitInput(parsed);
  };

  return (
    <div
      className={`relative flex min-h-[196px] min-w-0 flex-col overflow-hidden rounded-2xl border bg-osu-b4 transition-colors ${
        state.score ? `border-transparent ring-1 ${meta.ring}` : `border-dashed border-osu-b3/70 ${meta.hover}`
      }`}
    >
      {state.score?.beatmapset?.covers?.["cover@2x"] && (
        <img
          src={state.score.beatmapset.covers["cover@2x"]}
          alt=""
          loading="lazy"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-[0.14]"
        />
      )}
      <div className={`pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b ${meta.glow} to-transparent opacity-60`} />

      <div className="relative flex items-center justify-between gap-2 px-3.5 pt-3">
        <span className={`text-[10px] font-bold uppercase tracking-[0.2em] ${meta.accent}`}>{meta.label}</span>
        {state.score && (
          <button
            type="button"
            onClick={onClear}
            aria-label={`Clear the ${meta.label.toLowerCase()} score`}
            className="rounded-full bg-black/30 p-1 text-osu-f1 transition-colors hover:text-white cursor-pointer"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {state.score ? (
        <PickedScore score={state.score} />
      ) : (
        <form onSubmit={submit} className="relative flex flex-1 flex-col items-center justify-center gap-2.5 px-4 py-4 text-center">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-osu-b5 text-osu-f1">
            {state.loading
              ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              : <Plus className="h-5 w-5" aria-hidden="true" />}
          </span>
          <div>
            <div className="text-[13px] font-semibold text-white">Add the {meta.label.toLowerCase()} run</div>
            <div className="mt-0.5 text-[11px] text-osu-f1">Paste a score link, or pick one below</div>
          </div>
          <div className="flex w-full max-w-[280px] items-center gap-1.5">
            <input
              type="text"
              value={state.input}
              onChange={(event) => onInputChange(event.currentTarget.value)}
              placeholder="osu.ppy.sh/scores/..."
              aria-label={`${meta.label} score link or id`}
              enterKeyHint="go"
              // 16px on phones: anything smaller makes iOS Safari zoom the whole
              // page when the input gains focus.
              className="h-8 min-w-0 flex-1 rounded-md border border-osu-b3/50 bg-osu-b5/80 px-2 text-[16px] text-white outline-none transition-colors placeholder:text-osu-f1/60 focus:border-osu-pink/40 sm:text-[12px]"
            />
            <button
              type="submit"
              disabled={!parsed || state.loading}
              className="h-8 shrink-0 rounded-md bg-osu-pink/15 px-3 text-[12px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white disabled:opacity-40 cursor-pointer"
            >
              Add
            </button>
          </div>
          {state.error && <p className="text-[11px] text-osu-red-light">{state.error}</p>}
        </form>
      )}

      {state.score && state.error && <p className="relative px-3.5 pb-3 text-[11px] text-osu-red-light">{state.error}</p>}
    </div>
  );
}

function PickedScore({ score }: { score: OsuScore }) {
  const mods = getModDisplayList(score.mods);
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative flex flex-1 flex-col items-center justify-center gap-2 px-4 py-3 text-center"
    >
      <img
        src={avatarImageSrc(score.user?.avatar_url, score.user?.id)}
        alt=""
        loading="lazy"
        className="h-12 w-12 rounded-full object-cover ring-2 ring-white/10"
      />
      <div className="flex min-w-0 max-w-full items-center gap-1.5">
        <CountryFlag code={score.user?.country_code} size="xs" decorative />
        <span className="truncate text-[15px] font-bold text-white">{score.user?.username ?? "Unknown"}</span>
      </div>
      <div className="flex items-center gap-2 tabular-nums">
        <GradeImg grade={getDisplayedRank(score)} size={20} />
        <span className="text-[12px] font-semibold text-osu-l2">{formatAccuracy(getDisplayedAccuracy(score))}</span>
        {score.pp != null && <span className="text-[12px] font-bold text-osu-pink-light">{formatPP(score.pp)}</span>}
        {mods.length > 0 && (
          <span className="flex shrink-0 items-center gap-0.5">
            {mods.map((mod, index) => (
              <ModBadge key={`${mod.acronym}-${index}`} mod={mod.acronym} rate={mod.rate} size={0.55} />
            ))}
          </span>
        )}
      </div>
      <div className="max-w-full truncate text-[11px] text-osu-f1">
        {score.beatmapset?.title ?? ""}
        {score.beatmap?.version ? <span className="text-osu-f1/60"> [{score.beatmap.version}]</span> : null}
      </div>
    </motion.div>
  );
}

// The map both sides are locked to once one is picked, so the leaderboard
// below has a header instead of floating loose under the cards.
function MapStrip({ score, loading }: { score: OsuScore; loading: boolean }) {
  const cover = score.beatmapset?.covers?.["card@2x"] ?? score.beatmapset?.covers?.["cover@2x"];
  return (
    <div className="relative mb-2 flex items-center gap-3 overflow-hidden rounded-xl border border-osu-b3/30 bg-osu-b4 px-3 py-2">
      {cover && <img src={cover} alt="" loading="lazy" className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-[0.12]" />}
      <div className="relative min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wider text-osu-f1">Top scores on</div>
        <div className="truncate text-[13px] font-semibold text-white">
          {score.beatmapset?.title ?? "this map"}
          {score.beatmap?.version ? <span className="font-medium text-osu-f1"> [{score.beatmap.version}]</span> : null}
        </div>
      </div>
      {loading && <LoaderCircle className="relative h-4 w-4 shrink-0 animate-spin text-osu-f1" aria-hidden="true" />}
    </div>
  );
}

function CandidateList({ candidates, loading, slots, targetLabel, onPick }: {
  candidates: OsuScore[] | null;
  loading: boolean;
  slots: [SlotState, SlotState];
  targetLabel: string;
  onPick: (score: OsuScore) => void;
}) {
  if (candidates == null) {
    return loading
      ? <div className="h-40 rounded-xl border border-osu-b3/30 bg-osu-b4/40" />
      : <p className="px-1 text-[11px] text-osu-f1">Couldn't load this map's leaderboard.</p>;
  }
  if (candidates.length === 0) {
    return loading ? null : (
      <p className="px-1 text-[11px] text-osu-f1">No leaderboard scores on this map yet. Paste a link for the other side.</p>
    );
  }

  const picked = slots[0].score ?? slots[1].score ?? null;
  const pickedIds = new Set(slots.map((slot) => slot.score?.id).filter((id): id is number => id != null));

  return (
    <div className="replay-score-scroll flex max-h-80 flex-col gap-0.5 overflow-y-auto overscroll-contain rounded-xl border border-osu-b3/30 bg-osu-b4 p-1.5">
      {candidates.map((candidate, index) => {
        const alreadyPicked = pickedIds.has(candidate.id);
        // Rate and map are checked against the side already chosen, so a row
        // that can't be watched next to it says why instead of failing later.
        const issue = alreadyPicked ? null : getSideBySideCandidateIssue(candidate, picked);
        const mods = getModDisplayList(candidate.mods);
        return (
          <button
            key={candidate.id}
            type="button"
            disabled={alreadyPicked || issue != null}
            title={alreadyPicked ? "Already picked" : issue?.message ?? `Use as the ${targetLabel.toLowerCase()} run`}
            onClick={() => onPick(candidate)}
            className="group grid w-full grid-cols-[1.75rem_1.5rem_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-osu-b5 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent cursor-pointer"
          >
            <span className="text-[10px] font-semibold tabular-nums text-osu-f1">#{index + 1}</span>
            <img
              src={avatarImageSrc(candidate.user?.avatar_url, candidate.user?.id)}
              alt=""
              loading="lazy"
              className="h-6 w-6 rounded-full object-cover ring-1 ring-white/10"
            />
            <span className="flex min-w-0 items-center gap-1.5">
              <CountryFlag code={candidate.user?.country_code} size="xs" decorative />
              <span className="truncate text-[12px] font-semibold text-white">{candidate.user?.username ?? "?"}</span>
              {mods.length > 0 && (
                <span className="flex shrink-0 items-center gap-0.5">
                  {mods.map((mod, modIndex) => (
                    <ModBadge key={`${mod.acronym}-${modIndex}`} mod={mod.acronym} rate={mod.rate} size={0.5} />
                  ))}
                </span>
              )}
            </span>
            <span className="flex items-center gap-2 tabular-nums">
              <span className="text-[11px] font-semibold text-osu-l2">{formatAccuracy(getDisplayedAccuracy(candidate))}</span>
              {candidate.pp != null && (
                <span className="w-14 text-right text-[11px] font-bold text-osu-pink-light">{formatPP(candidate.pp)}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
