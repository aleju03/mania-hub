import { useCallback, useRef, useState } from "react";

/* Undo history for the frame editor. Every commit is a whole state; the
   states share everything they didn't change (layers are replaced, pixels
   are copied on write), so keeping a hundred costs little more than the
   pixels that changed. Commits with the same `merge` key in quick succession
   (a slider drag, a nudge held down) fold into one step. */

const LIMIT = 80;
const MERGE_MS = 900;

export function useHistory<T>(initial: T) {
  const [present, setPresent] = useState<T>(initial);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const last = useRef<{ key: string; at: number } | null>(null);
  const current = useRef(present);
  current.current = present;

  const commit = useCallback((next: T | ((value: T) => T), merge?: string) => {
    const value = typeof next === "function" ? (next as (value: T) => T)(current.current) : next;
    if (value === current.current) return;
    const now = Date.now();
    const folds = merge && last.current && last.current.key === merge && now - last.current.at < MERGE_MS;
    if (!folds) {
      past.current.push(current.current);
      if (past.current.length > LIMIT) past.current.shift();
    }
    last.current = merge ? { key: merge, at: now } : null;
    future.current = [];
    current.current = value;
    setPresent(value);
  }, []);

  const undo = useCallback(() => {
    const previous = past.current.pop();
    if (previous === undefined) return;
    future.current.push(current.current);
    last.current = null;
    current.current = previous;
    setPresent(previous);
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(current.current);
    last.current = null;
    current.current = next;
    setPresent(next);
  }, []);

  const reset = useCallback((value: T) => {
    past.current = [];
    future.current = [];
    last.current = null;
    current.current = value;
    setPresent(value);
  }, []);

  /* Jumps to any step: the list is every state, oldest first, with the present at `position`. */
  const jump = useCallback((index: number) => {
    const all = [...past.current, current.current, ...[...future.current].reverse()];
    if (index < 0 || index >= all.length || index === past.current.length) return;
    past.current = all.slice(0, index);
    future.current = all.slice(index + 1).reverse();
    last.current = null;
    current.current = all[index];
    setPresent(all[index]);
  }, []);

  return {
    present,
    commit,
    undo,
    redo,
    reset,
    jump,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    latest: current,
    steps: [...past.current, present, ...[...future.current].reverse()],
    position: past.current.length,
  };
}
