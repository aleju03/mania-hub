import { Link } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  fetchLiveStreakBoard,
  removeLiveStreakBest,
  type LiveStreakBoard,
  type LiveStreakBoardEntry,
} from "#/lib/live-backend";
import type { StreakPool } from "#/lib/streak-game";

// The blitz board, read next to the game that writes it. Only blitz runs
// reach it: a casual streak is scored in the browser, so it is a personal best
// rather than a claim about anyone else.

function Row({
  entry,
  isViewer,
  moderation,
}: {
  entry: LiveStreakBoardEntry;
  isViewer: boolean;
  moderation?: {
    armed: boolean;
    busy: boolean;
    onArm: () => void;
    onCancel: () => void;
    onRemove: () => void;
  };
}) {
  return (
    <li className="flex items-center gap-2 py-1">
      <span className={`w-4 shrink-0 text-right text-[11px] tabular-nums ${isViewer ? "text-white" : "text-osu-f1"}`}>
        {entry.rank}
      </span>
      <Link
        to="/player/$username"
        params={{ username: entry.username }}
        className="group flex min-w-0 flex-1 items-center gap-2"
      >
        {/* The board rows carry a user id and nothing else, so the avatar comes
            off the same proxy the game's own cards fall back to. */}
        <img
          src={`/api/avatar?u=${entry.userId}`}
          alt=""
          loading="lazy"
          className="h-5 w-5 shrink-0 rounded-full object-cover"
          draggable={false}
        />
        <span
          className={`min-w-0 truncate text-[13px] group-hover:underline underline-offset-4 decoration-osu-f1/60 ${
            isViewer ? "font-bold text-osu-pink-light" : "font-semibold text-white"
          }`}
        >
          {entry.username}
        </span>
      </Link>
      <span className="shrink-0 text-[15px] font-bold tabular-nums text-white">{entry.streak}</span>
      {/* Only ever rendered for a true admin, and the server checks again. Two
          clicks because it sits on a page that is mostly a game. */}
      {moderation ? (
        moderation.armed ? (
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              disabled={moderation.busy}
              onClick={moderation.onRemove}
              className="rounded bg-osu-red px-1.5 py-0.5 text-[10px] font-semibold text-white transition-colors hover:bg-osu-red-light disabled:opacity-50 cursor-pointer"
            >
              {moderation.busy ? "..." : "remove"}
            </button>
            <button
              type="button"
              disabled={moderation.busy}
              onClick={moderation.onCancel}
              className="text-[10px] text-osu-f1 transition-colors hover:text-white disabled:opacity-50 cursor-pointer"
            >
              no
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={moderation.onArm}
            title={`Remove ${entry.username}'s streak`}
            aria-label={`Remove ${entry.username}'s streak`}
            className="shrink-0 rounded p-0.5 text-osu-f1/50 transition-colors hover:bg-osu-red/20 hover:text-osu-red-light cursor-pointer"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )
      ) : null}
    </li>
  );
}

/* The read lives here rather than in the component because the page mounts the
   board twice, once for the rail and once for the phone layout, and hides one
   of them in CSS. Held by the parent, both of those are the same fetch.
   `version` is bumped when a blitz run ends, so the board re-reads without
   polling. */
export function useStreakBoard(pool: StreakPool, viewerId: number | null, version: number) {
  const [board, setBoard] = useState<LiveStreakBoard | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchLiveStreakBoard(pool, viewerId)
      .then((result) => {
        if (!cancelled) {
          setBoard(result);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pool, viewerId, version]);

  return { board, failed };
}

export function StreakLeaderboard({
  board,
  failed,
  viewerId,
  compact = false,
  canModerate = false,
  onRemoved,
}: {
  board: LiveStreakBoard | null;
  failed: boolean;
  viewerId: number | null;
  /* The phone layout: three rows and a way to see the rest, so the board never
     pushes the guess buttons off the screen. */
  compact?: boolean;
  /* True admins get a remove button per row: a record that cannot be explained
     comes off here, where it is being read, rather than from a settings page
     somewhere else. Removing is not a ban and the account can set another one. */
  canModerate?: boolean;
  onRemoved?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [armed, setArmed] = useState<number | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const remove = (entry: LiveStreakBoardEntry) => {
    if (!board) return;
    setRemoving(entry.userId);
    setRemoveError(null);
    removeLiveStreakBest({ data: { userId: entry.userId, pool: board.pool } })
      .then(() => onRemoved?.())
      .catch((error) => setRemoveError(error instanceof Error ? error.message : "Removal failed."))
      .finally(() => { setRemoving(null); setArmed(null); });
  };

  const moderationFor = (entry: LiveStreakBoardEntry) => (canModerate
    ? {
        armed: armed === entry.userId,
        busy: removing === entry.userId,
        onArm: () => { setArmed(entry.userId); setRemoveError(null); },
        onCancel: () => setArmed(null),
        onRemove: () => remove(entry),
      }
    : undefined);

  const shown = board && compact && !expanded ? board.entries.slice(0, 3) : board?.entries ?? [];
  /* Their own line, kept below the board when they are not on it. Someone on
     the board is already highlighted in place. */
  const viewer = board?.viewer && !shown.some((entry) => entry.userId === board.viewer?.userId)
    ? board.viewer
    : null;

  return (
    <div className="w-full">
      <div className="flex items-baseline justify-between gap-2 border-b border-osu-b3/40 pb-1.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-osu-f1">Longest blitz streaks</h2>
        {compact && board && board.entries.length > 3 && (
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            className="text-[11px] text-osu-f1 transition-colors hover:text-white cursor-pointer"
          >
            {expanded ? "less" : "all 10"}
          </button>
        )}
      </div>

      {failed ? (
        <div className="pt-3 text-[12px] text-osu-f1">The board is not answering right now.</div>
      ) : !board ? (
        <ul className="pt-2" aria-hidden>
          {[0, 1, 2].map((slot) => (
            <li key={slot} className="py-1.5">
              <span className="block h-3 w-full animate-pulse rounded-full bg-osu-b4/60" />
            </li>
          ))}
        </ul>
      ) : board.entries.length === 0 ? (
        <div className="pt-3 text-[12px] text-osu-f1">Nobody has finished a blitz run yet.</div>
      ) : (
        <>
          {/* translate="no" on the rows: usernames and streak counts, redrawn
              on every board re-read — auto-translate's <font> rewrites make
              React's commits over translated text throw NotFoundError. */}
          <ul translate="no" className="pt-1.5">
            {shown.map((entry) => (
              <Row
                key={entry.userId}
                entry={entry}
                isViewer={entry.userId === viewerId}
                moderation={moderationFor(entry)}
              />
            ))}
          </ul>
          {viewer && (
            <ul translate="no" className="mt-1 border-t border-osu-b3/40 pt-1">
              <Row entry={viewer} isViewer />
            </ul>
          )}
          {removeError ? <div className="mt-1 text-[11px] text-osu-red-light">{removeError}</div> : null}
        </>
      )}
    </div>
  );
}
