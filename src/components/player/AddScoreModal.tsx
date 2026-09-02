import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ArrowRight, ArrowUp, Loader2, Search, X } from "lucide-react";
import {
  fetchLiveMapSearch,
  loadLiveMapSearchEntry,
  submitLiveMissingScore,
  type LiveMapSearchEntry,
  type LiveScoreSubmissionFailure,
  type LiveScoreSubmissionPlay,
} from "../../lib/live-backend";
import { track } from "../../lib/analytics";
import { formatAccuracy, formatPP, formatTimeAgo } from "../../lib/format";
import { getModDisplayList } from "../../lib/score";
import { ModBadge } from "../ui/ModBadge";
import { useLocale } from "../../lib/locale-context";
import type { AppLocale } from "../../lib/locale";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";
import { useAuth } from "../../lib/auth-context";
import {
  getLeaderboardImportStatuses,
  importBeatmapLeaderboards,
  type LeaderboardImportFailure,
  type LeaderboardImportStatus,
} from "../../lib/leaderboard-import";
import { StatusChip } from "../maps/FilterChips";

/*
 * Adding a missing score to a player, from their profile page.
 *
 * Anyone can do it, for anyone: the pasted link is fetched from the osu! API
 * and only counts if the score really belongs to this player, so the score
 * itself is the proof. What it earns is decided downstream by the same rules
 * a tracked score faces - this dialog promises nothing beyond "it's in".
 *
 * Shaped as a paste bar rather than a form: pasting is the whole interaction,
 * so the field is the dialog until a play lands, and then the play takes the
 * dialog over as its own score panel. That panel is also the receipt - it
 * names the chart the backend actually matched, which is the only way the
 * submitter can tell a wrong link from a right one. Older ones fall to thin
 * rows underneath, since the bar stays open for the next link.
 */

/* Focusing the field is a convenience for a mouse and keyboard: the link is
   already on the clipboard, so the caret is where the next keystroke belongs.
   On a phone the same call throws the on-screen keyboard over half the dialog
   before the visitor has decided to type anything, so a coarse pointer opens
   the bar unfocused and waits to be tapped. */
function focusOnDesktop(input: HTMLInputElement | null): void {
  if (!input || typeof window === "undefined") return;
  if (window.matchMedia?.("(pointer: coarse)").matches) return;
  input.focus();
}

/* What the analytics feed shows for a submitted play, in the same shape the
   dialog's own panel reads: the chart, not the score id. */
function scoreMapLabel(play: LiveScoreSubmissionPlay): string | null {
  const title = play.title?.trim() || null;
  const version = play.version?.trim() || null;
  if (title && version) return `${title} [${version}]`;
  return title ?? version;
}

interface AcceptedPlay {
  key: string;
  play: LiveScoreSubmissionPlay;
  alreadyTracked: boolean;
  /* Catalog detail (cover, keymode), fetched after the fact. Null until it
     lands, and for charts the map catalog does not know. */
  entry: LiveMapSearchEntry | null;
}

export function AddScoreModal({
  userId,
  username,
  onClose,
  onSubmitted,
}: {
  userId: number;
  username: string;
  onClose: () => void;
  /** A score was newly stored (not an already-tracked resubmission). */
  onSubmitted?: () => void;
}) {
  const { t } = useLingui();
  const locale = useLocale();
  const auth = useAuth();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<AcceptedPlay[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);

  useBodyScrollLock(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    focusOnDesktop(inputRef.current);
  }, []);

  /* The dialog is worth counting on its own: a pageview on a profile says
     nothing about whether anyone found this bar, and the outcome of a paste
     (stored, already tracked, or turned down and why) is the only way to see
     whether the feature works for people who are not us. The target player is
     carried on every one of them, since "who gets scores added" is half the
     question. */
  useEffect(() => {
    track("add_score_open", { add_score_player: username });
    // Opening the dialog is the event; a rename mid-dialog is not a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const failureMessage = (reason: LiveScoreSubmissionFailure, owner?: string | null): string => {
    switch (reason) {
      case "invalid_link":
        return t`That doesn't look like an osu! score link.`;
      case "score_not_found":
        return t`No score found at that link.`;
      case "not_mania":
        return t`That score isn't an osu!mania score.`;
      case "not_owned":
        return owner
          ? t`That score belongs to a different player (${owner}).`
          : t`That score belongs to a different player.`;
      case "not_passed":
        return t`That score is a fail, so it can't count.`;
      case "player_untracked":
        return t`This player's country isn't tracked yet.`;
      case "player_not_found":
        return t`This player can't receive scores.`;
      case "osu_unavailable":
        return t`osu! didn't answer. Try again in a minute.`;
      case "rate_limited":
        return t`Too many submissions right now. Try again later.`;
      case "failed":
        return t`Could not send that. Try again.`;
    }
  };

  const send = async (raw: string) => {
    const value = raw.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await submitLiveMissingScore(userId, value);
      /* Counted before the mounted check: the paste's outcome is a fact on the
         backend whether or not the dialog is still open to show it. */
      if (result.ok) {
        track("add_score_submitted", {
          add_score_player: username,
          add_score_map: scoreMapLabel(result.play),
          // The paste landed on a score the backend already had, so nothing
          // new was stored - a different outcome from a first submission, and
          // the one that says how often people re-add what is tracked already.
          add_score_repeat: result.alreadyTracked ? "1" : "0",
        });
      } else {
        track("add_score_failed", { add_score_player: username, add_score_reason: result.reason });
      }
      if (!mountedRef.current) return;
      if (!result.ok) {
        setError(failureMessage(result.reason, result.owner));
        return;
      }
      setLink("");
      const key = `${result.play.scoreId}:${Date.now()}`;
      setAccepted((current) => [
        { key, play: result.play, alreadyTracked: result.alreadyTracked, entry: null },
        ...current.filter((item) => item.play.scoreId !== result.play.scoreId),
      ]);
      if (!result.alreadyTracked) onSubmitted?.();
      if (result.play.beatmapId != null) void fillEntry(key, result.play.beatmapId);
    } catch {
      track("add_score_failed", { add_score_player: username, add_score_reason: "failed" });
      if (mountedRef.current) setError(t`Could not send that. Try again.`);
    } finally {
      if (mountedRef.current) {
        setBusy(false);
        focusOnDesktop(inputRef.current);
      }
    }
  };

  /* The submission answers with the score, not the chart, so the cover art and
     the keymode come from the map catalog afterwards. A miss leaves the panel
     on what the score itself carried. */
  const fillEntry = async (key: string, beatmapId: number) => {
    try {
      const entry = await loadLiveMapSearchEntry(beatmapId);
      if (!mountedRef.current || !entry) return;
      setAccepted((current) => current.map((item) => (item.key === key ? { ...item, entry } : item)));
    } catch {
      /* the panel reads fine without it */
    }
  };

  const [latest, ...older] = accepted;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-black/80 py-3 pl-3 pr-[calc(0.75rem+var(--modal-scrollbar-compensation,0px))] backdrop-blur-sm sm:py-4 sm:pl-4 sm:pr-[calc(1rem+var(--modal-scrollbar-compensation,0px))]"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.16 }}
      >
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={t`Add a missing score`}
          layout
          className="modal-card-mobile-safe relative my-auto w-full max-w-xl overflow-hidden rounded-2xl border border-osu-b3/25 bg-osu-b5 shadow-[0_18px_70px_rgba(0,0,0,0.65)]"
          initial={{ opacity: 0, y: 10, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.985 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >
          {/* Over the art once a play owns the top of the dialog; before that
              the dialog is one row, so it rides the end of that row instead of
              landing on top of the paste button. */}
          {latest ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={t`Close`}
              className="absolute right-2.5 top-2.5 z-20 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-black/45 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/65 hover:text-white"
            >
              <X size={16} />
            </button>
          ) : null}

          <AnimatePresence mode="popLayout" initial={false}>
            {latest ? <ScorePanel key={latest.key} item={latest} locale={locale} /> : null}
          </AnimatePresence>

          {older.length > 0 ? (
            <div className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
              {older.map((item) => (
                <AcceptedRow key={item.key} item={item} />
              ))}
            </div>
          ) : null}

          {error ? (
            <p className="border-t border-white/[0.06] px-4 pt-2.5 text-[11.5px] text-osu-red-light sm:px-5">{error}</p>
          ) : null}

          <form
            className={`relative flex items-center gap-3 px-4 sm:px-5 ${latest || error ? "py-3" : "py-4"} ${
              latest && !error ? "border-t border-white/[0.06]" : ""
            }`}
            onSubmit={(event) => {
              event.preventDefault();
              void send(link);
            }}
          >
            {busy ? (
              <motion.span
                aria-hidden="true"
                className="absolute inset-x-0 top-0 h-px bg-osu-pink"
                initial={{ scaleX: 0, transformOrigin: "0% 50%" }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 2.4, ease: "easeOut" }}
              />
            ) : null}
            <img
              src={`https://a.ppy.sh/${userId}`}
              alt=""
              className="h-8 w-8 shrink-0 rounded-full bg-osu-b4 object-cover"
              onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
            />
            <input
              ref={inputRef}
              type="text"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              onPaste={(event) => {
                // Pasting a score link is the whole interaction, so a paste
                // sends it instead of waiting for a second click.
                const text = event.clipboardData.getData("text");
                if (!text.trim()) return;
                event.preventDefault();
                setLink(text.trim());
                void send(text);
              }}
              placeholder={t`paste a score link for ${username}`}
              spellCheck={false}
              autoComplete="off"
              aria-label={t`osu! score link`}
              className="min-w-0 flex-1 bg-transparent text-[14px] text-osu-l1 outline-none placeholder:text-osu-f1"
            />
            {link.trim() || busy ? (
              <button
                type="submit"
                disabled={busy}
                aria-label={t`Add score`}
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-osu-pink text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-60"
              >
                {busy
                  ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  : <ArrowRight className="h-4 w-4" aria-hidden="true" />}
              </button>
            ) : null}
            {latest ? null : (
              <button
                type="button"
                onClick={onClose}
                aria-label={t`Close`}
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border-l border-white/[0.07] pl-2 text-osu-f1 transition-colors hover:text-white"
              >
                <X size={16} />
              </button>
            )}
          </form>

          {auth.canUseAdminFeatures ? <LeaderboardImportPanel /> : null}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

/* ------------------------------------------------- admin: leaderboard import

   Admin-only for now, so its copy is plain English like the rest of the admin
   surfaces. Search is the site's own map index, the one /maps searches, with
   the same token syntax (key=6, stars>5, creator=...) and the same debounce,
   narrowed to ranked or loved. Every chart on the results has one action:
   queue its global leaderboard for the ingest. osu! publishes a map's top 50
   and nothing past it, so that is the whole board. A set-level button queues
   the charts the index returned for that set. */

type ImportStatusFilter = "ranked" | "loved";

/* The index's sorts that mean something here. Its "relevance" is play count
   under another name (no relevance column exists), so it is not offered. */
type ImportSort = "playcount" | "stars" | "date";
type ImportDir = "desc" | "asc";

const IMPORT_SORTS: Array<{ id: ImportSort; label: string }> = [
  { id: "playcount", label: "plays" },
  { id: "stars", label: "stars" },
  { id: "date", label: "date" },
];

const IMPORT_SEARCH_DEBOUNCE_MS = 250;
const IMPORT_SEARCH_PAGE_SIZE = 60;

/* sending: the enqueue request is in flight. queued/running: the backend job,
   as the poll last saw it. done/failed: the job's end, with the retained or
   latest-run stored count and durable import time, or the job's reason. */
type ImportState =
  | { kind: "sending" }
  | { kind: "queued" }
  | { kind: "running" }
  | { kind: "done"; stored: number; importedAt: string | null; recent: boolean }
  | { kind: "failed"; message: string };

const IMPORT_POLL_MS = 2_500;

function importFailureMessage(reason: LeaderboardImportFailure): string {
  switch (reason) {
    case "rate_limited":
      return "Too many imports right now. Try again later.";
    case "failed":
      return "Could not queue that. Try again.";
  }
}

/* The job's last_error, as the dialog says it. Refusals are the worker's
   "leaderboard import refused: <reason>"; anything else is shown as is. */
function jobErrorMessage(error: string | null): string {
  const refused = /refused: (\w+)/.exec(error ?? "")?.[1];
  switch (refused) {
    case "beatmap_not_found":
      return "osu! doesn't know that chart.";
    case "not_mania":
      return "Not a mania chart.";
    case "no_leaderboard":
      return "That chart has no leaderboard.";
  }
  return error?.trim() || "The import failed.";
}

function importStateFromStatus(status: LeaderboardImportStatus): ImportState | null {
  if (status.status === "queued") return { kind: "queued" };
  if (status.status === "running") return { kind: "running" };
  if (status.status === "failed") return { kind: "failed", message: jobErrorMessage(status.error) };
  if (status.status === "done" || status.lastImportedAt) {
    return {
      kind: "done",
      stored: status.stored,
      importedAt: status.lastImportedAt,
      recent: status.recent === true,
    };
  }
  return null;
}

function importIsBusy(state: ImportState | undefined): boolean {
  return state?.kind === "sending" || state?.kind === "queued" || state?.kind === "running";
}

function importIsCoolingDown(state: ImportState | undefined): boolean {
  return state?.kind === "done" && state.recent;
}

function LeaderboardImportPanel() {
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ImportStatusFilter>("ranked");
  const [sort, setSort] = useState<ImportSort>("playcount");
  const [dir, setDir] = useState<ImportDir>("desc");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<{ sets: ImportSet[]; total: number } | null>(null);
  const [imports, setImports] = useState<Record<number, ImportState>>({});
  const mountedRef = useRef(true);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (open) focusOnDesktop(searchRef.current);
  }, [open]);

  /* Searches as typed, like /maps: the query waits the same 250ms, filters
     fire at once. The counter lets a stale response lose to the newest. */
  const searchSeq = useRef(0);
  useEffect(() => {
    if (!open) return;
    const seq = ++searchSeq.current;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetchLiveMapSearch({
          q: query,
          keys: [],
          keysExclude: [],
          statuses: [status],
          statusesExclude: [],
          patterns: [],
          patternsExclude: [],
          starMin: null,
          starMax: null,
          bpmMin: null,
          bpmMax: null,
          lenMin: null,
          lenMax: null,
          danMin: null,
          danMax: null,
          country: null,
          sort,
          dir,
          page: 0,
          pageSize: IMPORT_SEARCH_PAGE_SIZE,
        });
        if (!mountedRef.current || seq !== searchSeq.current) return;
        setSearchError(null);
        setResults({ sets: groupBySet(res.items), total: res.total });
      } catch {
        if (mountedRef.current && seq === searchSeq.current) setSearchError("Search failed. Try again.");
      } finally {
        if (mountedRef.current && seq === searchSeq.current) setSearching(false);
      }
    }, IMPORT_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, query, status, sort, dir]);

  /* Search results come from the map index, which knows nothing about import
     jobs. Load the durable receipts separately so reopening the dialog still
     marks boards imported during the last seven days. */
  const resultBeatmapIds = results?.sets.flatMap((set) => set.charts.map((chart) => chart.beatmapId)) ?? [];
  const resultBeatmapIdsKey = [...new Set(resultBeatmapIds)].join(",");
  useEffect(() => {
    if (!open || !resultBeatmapIdsKey) return;
    let cancelled = false;
    const ids = resultBeatmapIdsKey.split(",").map(Number);
    const batches: number[][] = [];
    for (let offset = 0; offset < ids.length; offset += 200) batches.push(ids.slice(offset, offset + 200));
    void Promise.all(batches.map((beatmapIds) => getLeaderboardImportStatuses({ data: { beatmapIds } })))
      .then((batchStatuses) => {
        if (cancelled || !mountedRef.current) return;
        setImports((current) => {
          const next = { ...current };
          for (const status of batchStatuses.flat()) {
            // A click can race this background read. Never replace the newer
            // in-flight state with the snapshot taken before that click.
            if (importIsBusy(next[status.beatmapId])) continue;
            const state = importStateFromStatus(status);
            if (state) next[status.beatmapId] = state;
          }
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, resultBeatmapIdsKey]);

  /* One request for the whole list: enqueueing is cheap and the backend's
     lane runs the jobs one at a time, so a set's charts go out together. */
  const importMany = async (beatmapIds: number[]) => {
    setImports((current) => {
      const next = { ...current };
      for (const beatmapId of beatmapIds) next[beatmapId] = { kind: "sending" };
      return next;
    });
    try {
      const result = await importBeatmapLeaderboards({ data: { beatmapIds } });
      if (!mountedRef.current) return;
      setImports((current) => {
        const updated = { ...current };
        if (!result.ok) {
          const failed: ImportState = { kind: "failed", message: importFailureMessage(result.reason) };
          for (const beatmapId of beatmapIds) updated[beatmapId] = failed;
          return updated;
        }
        const byId = new Map(result.statuses.map((status) => [status.beatmapId, status]));
        for (const beatmapId of beatmapIds) {
          const status = byId.get(beatmapId);
          updated[beatmapId] = status ? importStateFromStatus(status) ?? { kind: "queued" } : { kind: "queued" };
        }
        return updated;
      });
    } catch {
      if (!mountedRef.current) return;
      setImports((current) => {
        const updated = { ...current };
        const failed: ImportState = { kind: "failed", message: importFailureMessage("failed") };
        for (const beatmapId of beatmapIds) updated[beatmapId] = failed;
        return updated;
      });
    }
  };
  const importOne = (beatmapId: number) => importMany([beatmapId]);

  /* Watches every queued or running job until it ends. The stored count is
     read off the job's chart, so the row can say what actually landed. */
  const pending = Object.entries(imports)
    .filter(([, state]) => state.kind === "queued" || state.kind === "running")
    .map(([id]) => Number(id));
  const pendingKey = pending.join(",");
  useEffect(() => {
    if (!pendingKey) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const statuses = await getLeaderboardImportStatuses({ data: { beatmapIds: pendingKey.split(",").map(Number) } });
        if (cancelled || !mountedRef.current) return;
        setImports((current) => {
          const next = { ...current };
          for (const status of statuses) {
            const state = next[status.beatmapId];
            if (!state || (state.kind !== "queued" && state.kind !== "running")) continue;
            const updated = importStateFromStatus(status);
            if (updated) next[status.beatmapId] = updated;
            else if (status.status === "none") next[status.beatmapId] = { kind: "failed", message: "The job went missing." };
          }
          return next;
        });
      } catch {
        /* next tick */
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), IMPORT_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pendingKey]);

  return (
    <div className="border-t border-white/[0.06]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-[0.14em] text-osu-f1 transition-colors hover:text-osu-l2 sm:px-5"
      >
        <span>Import a leaderboard</span>
        <span className="text-[10px] font-semibold normal-case tracking-normal">admin</span>
      </button>
      {open ? (
        <div className="px-4 pb-4 sm:px-5">
          <div className="flex items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-osu-b4 px-3 py-2">
              <Search size={14} className="shrink-0 text-osu-f1" aria-hidden="true" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="search maps, e.g. key=6 stars>5 creator=..."
                spellCheck={false}
                autoComplete="off"
                aria-label="Map search"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-osu-l1 outline-none placeholder:text-osu-f1"
              />
              {searching ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-osu-f1" aria-hidden="true" /> : null}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {(["ranked", "loved"] as const).map((option) => (
              <StatusChip key={option} id={option} label={option} active={status === option} onClick={() => setStatus(option)} />
            ))}
            <div className="ml-auto flex items-center gap-0.5 text-[11px] font-bold text-osu-f1">
              {IMPORT_SORTS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={sort === option.id}
                  onClick={() => setSort(option.id)}
                  className={`cursor-pointer rounded-md px-2 py-1 transition-colors ${sort === option.id ? "bg-osu-b4 text-osu-l1" : "hover:text-osu-l2"}`}
                >
                  {option.label}
                </button>
              ))}
              {/* Direction reads in the sort's own words: newest/oldest for
                  date, most/least for the rest. */}
              <button
                type="button"
                onClick={() => setDir((value) => (value === "desc" ? "asc" : "desc"))}
                aria-label={dir === "desc" ? "Sort descending" : "Sort ascending"}
                className="ml-1 flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-osu-l2 transition-colors hover:text-osu-l1"
              >
                {dir === "desc" ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />}
                {sort === "date" ? (dir === "desc" ? "newest" : "oldest") : dir === "desc" ? "most" : "least"}
              </button>
            </div>
          </div>

          {searchError ? <p className="mt-2 text-[11.5px] text-osu-red-light">{searchError}</p> : null}

          {results ? (
            results.sets.length === 0
              ? <p className="mt-3 text-[12px] text-osu-f1">No maps found.</p>
              : (
                <div className="mt-3 max-h-[50vh] space-y-3 overflow-y-auto pr-1">
                  {results.sets.map((set) => {
                    const anyBusy = set.charts.some((chart) => importIsBusy(imports[chart.beatmapId]));
                    const availableCharts = set.charts.filter((chart) => !importIsCoolingDown(imports[chart.beatmapId]));
                    return (
                      <div key={set.beatmapsetId}>
                        <div className="flex items-center gap-2.5">
                          <img
                            src={set.cover ?? `https://assets.ppy.sh/beatmaps/${set.beatmapsetId}/covers/list.jpg`}
                            alt=""
                            className="h-9 w-9 shrink-0 rounded-md bg-osu-b4 object-cover"
                            onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-bold text-osu-l1">
                              {set.title}
                              {set.year ? <span className="ml-1.5 text-[11px] font-semibold text-osu-f1">{set.year}</span> : null}
                            </div>
                            <div className="truncate text-[11px] text-osu-f1">{set.artist} · {set.creator}</div>
                          </div>
                          {set.charts.length > 1 ? (
                            <button
                              type="button"
                              disabled={anyBusy || availableCharts.length === 0}
                              onClick={() => importMany(availableCharts.map((chart) => chart.beatmapId))}
                              className="shrink-0 cursor-pointer rounded-full bg-osu-b3/60 px-2.5 py-1 text-[11px] font-bold text-osu-l2 transition hover:bg-osu-b3 disabled:cursor-default disabled:opacity-60"
                            >
                              {availableCharts.length === set.charts.length ? `Add all ${set.charts.length}` : `Add ${availableCharts.length} available`}
                            </button>
                          ) : null}
                        </div>
                        <div className="mt-1.5 divide-y divide-white/[0.05]">
                          {set.charts.map((chart) => (
                            <ImportChartRow
                              key={chart.beatmapId}
                              chart={chart}
                              state={imports[chart.beatmapId]}
                              locale={locale}
                              onImport={() => void importOne(chart.beatmapId)}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  {results.total > results.sets.length ? (
                    <p className="pb-1 text-[11px] text-osu-f1">Showing the first {IMPORT_SEARCH_PAGE_SIZE} sets of {results.total}. Narrow the search for the rest.</p>
                  ) : null}
                </div>
              )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* The index answers one entry per set, the representative diff on top and
   every filter-matching diff of the set under `diffs` (easiest first); a set
   here is that list, with the representative itself when a cached payload
   predates the field. */
interface ImportSet {
  beatmapsetId: number;
  title: string;
  artist: string;
  creator: string;
  cover: string | null;
  // The set's ranked/loved year, off its representative diff.
  year: string | null;
  charts: LiveMapSearchEntry[];
}

function groupBySet(items: LiveMapSearchEntry[]): ImportSet[] {
  return items.map((item) => {
    const diffs = item.diffs?.length ? item.diffs : [item];
    const charts = diffs.some((diff) => diff.beatmapId === item.beatmapId) ? diffs : [item, ...diffs];
    return {
      beatmapsetId: item.beatmapsetId,
      title: item.title,
      artist: item.artist,
      creator: item.creator,
      cover: item.covers?.list ?? item.covers?.card ?? null,
      year: item.rankedDate ? item.rankedDate.slice(0, 4) : null,
      charts: [...charts].sort((a, b) => a.stars - b.stars),
    };
  });
}

function ImportChartRow({ chart, state, locale, onImport }: { chart: LiveMapSearchEntry; state: ImportState | undefined; locale: AppLocale; onImport: () => void }) {
  const unavailable = importIsBusy(state) || importIsCoolingDown(state);
  return (
    <div className="flex items-center gap-2.5 py-1.5 pl-[46px]">
      <span className="shrink-0 text-[11px] font-bold text-osu-yellow">{chart.keyCount}K</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-osu-l2">{chart.version}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-osu-f1">{chart.stars.toFixed(2)}★</span>
      {state?.kind === "done" ? (
        <span
          className={`shrink-0 text-[11px] tabular-nums font-bold ${state.recent ? "text-osu-green-light" : "text-osu-f1"}`}
          title={state.recent ? "Already imported within the last 7 days" : "Previously imported; available to refresh"}
        >
          imported{state.importedAt ? ` ${formatTimeAgo(state.importedAt, locale)}` : ""} · {state.stored} stored
        </span>
      ) : state?.kind === "failed" ? (
        <span className="shrink-0 text-[11px] text-osu-red-light">{state.message}</span>
      ) : state?.kind === "queued" ? (
        <span className="shrink-0 text-[11px] font-bold text-osu-l2">queued</span>
      ) : state?.kind === "running" ? (
        <span className="shrink-0 text-[11px] font-bold text-osu-yellow">importing</span>
      ) : null}
      <button
        type="button"
        disabled={unavailable}
        onClick={onImport}
        aria-label={importIsCoolingDown(state) ? `${chart.version} was imported within the last 7 days` : `Import the leaderboard of ${chart.version}`}
        className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-osu-pink text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-60"
      >
        {state?.kind === "sending" || state?.kind === "queued" || state?.kind === "running"
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          : <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />}
      </button>
    </div>
  );
}

/* The play that just landed, as the panel the dialog is built around: its own
   cover art behind it, its accuracy at the size the number deserves. */
function ScorePanel({ item, locale }: { item: AcceptedPlay; locale: AppLocale }) {
  const { t } = useLingui();
  const { play, entry, alreadyTracked } = item;
  const cover = entry?.covers?.["cover@2x"]
    ?? entry?.covers?.cover
    ?? (entry?.beatmapsetId ? `https://assets.ppy.sh/beatmaps/${entry.beatmapsetId}/covers/cover@2x.jpg` : null);
  const title = play.title ?? entry?.title ?? t`Unknown chart`;
  const version = play.version ?? entry?.version ?? null;
  const mods = getModDisplayList(play.mods);
  return (
    <motion.a
      // Server-verified URL: the two osu! id spaces overlap, so a link built
      // from a bare id can open a stranger's play.
      href={play.scoreUrl ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative block h-36 overflow-hidden sm:h-40"
      initial={{ opacity: 0, y: -14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -14 }}
      transition={{ duration: 0.24, ease: "easeOut" }}
    >
      {cover ? (
        <img
          src={cover}
          alt=""
          className="absolute inset-0 h-full w-full scale-105 object-cover transition-transform duration-500 group-hover:scale-110"
          onError={(event) => { event.currentTarget.style.display = "none"; }}
        />
      ) : null}
      {/* Everything sits on the bottom edge, so the scrim is vertical: opaque
          under the type, thin enough at the top to leave the art readable. */}
      <div className="absolute inset-0 bg-gradient-to-t from-osu-b5 via-osu-b5/80 to-osu-b5/25" />
      {/* One-shot wash on arrival, so a paste lands somewhere visible. */}
      <motion.span
        className="pointer-events-none absolute inset-0 bg-osu-pink/25"
        aria-hidden="true"
        initial={{ opacity: 1 }}
        animate={{ opacity: 0 }}
        transition={{ duration: 1, ease: "easeOut" }}
      />
      <div className="relative flex h-full items-end justify-between gap-4 px-4 pb-4 pt-10 sm:px-5 sm:pb-5">
        <div className="min-w-0">
          {play.accuracy != null ? (
            <div className="text-[38px] font-black leading-none tabular-nums text-white sm:text-[44px]">
              {formatAccuracy(play.accuracy)}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-osu-l2">
            {/* The mods are part of what the submitter is checking the link
                against, so they sit with the score, not the chart. */}
            {mods.length > 0 ? (
              <span className="flex items-center gap-0.5">
                {mods.map((mod, index) => (
                  <ModBadge key={`${mod.acronym}-${index}`} mod={mod.acronym} rate={mod.rate} size={0.62} />
                ))}
              </span>
            ) : null}
            {play.pp != null ? <span className="font-bold text-osu-pink-light">{formatPP(play.pp, locale)}</span> : null}
            {entry?.keyCount ? <span className="font-bold text-osu-yellow">{entry.keyCount}K</span> : null}
            {play.endedAt ? <span className="text-osu-f1">{formatTimeAgo(play.endedAt, locale)}</span> : null}
          </div>
        </div>
        <div className="min-w-0 max-w-[55%] text-right">
          <div className="truncate text-[15px] font-bold text-white">{title}</div>
          {version ? <div className="truncate text-[11px] text-osu-f1">[{version}]</div> : null}
          <div className={`mt-1.5 text-[10px] font-bold uppercase tracking-[0.16em] ${alreadyTracked ? "text-osu-f1" : "text-osu-green-light"}`}>
            {alreadyTracked ? t`already tracked` : t`added`}
          </div>
        </div>
      </div>
    </motion.a>
  );
}

/* A play the next paste pushed off the panel. */
function AcceptedRow({ item }: { item: AcceptedPlay }) {
  const { t } = useLingui();
  const { play, entry, alreadyTracked } = item;
  const title = play.title ?? entry?.title ?? t`Unknown chart`;
  const version = play.version ?? entry?.version ?? null;
  const mods = getModDisplayList(play.mods);
  return (
    <motion.a
      href={play.scoreUrl ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-baseline gap-2.5 px-4 py-2.5 transition-colors hover:bg-osu-b4/60 sm:px-5"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      transition={{ duration: 0.22, ease: "easeOut" }}
    >
      <span className="truncate text-[12.5px] font-semibold text-osu-l1">{title}</span>
      {version ? <span className="hidden shrink-0 truncate text-[11px] text-osu-f1 sm:inline">[{version}]</span> : null}
      {mods.length > 0 ? (
        <span className="ml-auto flex shrink-0 items-center gap-0.5 self-center">
          {mods.map((mod, index) => (
            <ModBadge key={`${mod.acronym}-${index}`} mod={mod.acronym} rate={mod.rate} size={0.5} />
          ))}
        </span>
      ) : null}
      <span className={`shrink-0 text-[11px] tabular-nums text-osu-f1 ${mods.length > 0 ? "" : "ml-auto"}`}>
        {play.accuracy != null ? formatAccuracy(play.accuracy) : null}
      </span>
      <span className={`shrink-0 text-[10px] font-bold uppercase tracking-[0.14em] ${alreadyTracked ? "text-osu-f1" : "text-osu-green-light"}`}>
        {alreadyTracked ? t`already tracked` : t`added`}
      </span>
    </motion.a>
  );
}
