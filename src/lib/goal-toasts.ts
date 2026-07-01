import { deleteGoal, type UserGoal } from "./goals";

// Client-side module state for goal deletion undo and cross-page goal events. Living at module
// level (not inside a component) is what lets the undo window keep counting across route changes:
// the /goals panel queues deletes here, and the root-mounted GoalToasts component renders the undo
// bar wherever the user currently is. The backend delete only fires when a window runs out, so
// Undo restores the goal with its history and progress baseline intact.

export const UNDO_DELETE_MS = 6000;

export interface GoalDeleteToast {
  seq: number;
  label: string;
  count: number;
}

interface PendingDelete {
  goal: UserGoal;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingDelete>();
// Every goal id deleted this session (pending or already committed), so a goals reload that was in
// flight when the delete was clicked can't resurrect the row. Ids are uuids and never reissued;
// leaving committed ones in the set is harmless.
const deletedIds = new Set<string>();

let toast: GoalDeleteToast | null = null;
let seq = 0;

const toastListeners = new Set<() => void>();
const goalsChangedListeners = new Set<(restored?: UserGoal[]) => void>();

function notifyToast(): void {
  for (const listener of toastListeners) listener();
}

/** Tell any mounted goals list to resync (SSE completion, undo restore, or a failed delete). */
export function notifyGoalsChanged(restored?: UserGoal[]): void {
  for (const listener of goalsChangedListeners) listener(restored);
}

export function subscribeGoalDeleteToast(listener: () => void): () => void {
  toastListeners.add(listener);
  return () => {
    toastListeners.delete(listener);
  };
}

export function getGoalDeleteToast(): GoalDeleteToast | null {
  return toast;
}

export function subscribeGoalsChanged(listener: (restored?: UserGoal[]) => void): () => void {
  goalsChangedListeners.add(listener);
  return () => {
    goalsChangedListeners.delete(listener);
  };
}

export function isGoalDeleted(id: string): boolean {
  return deletedIds.has(id);
}

async function commitDelete(id: string): Promise<void> {
  if (!pending.delete(id)) return;
  toast = pending.size === 0 ? null : toast && { ...toast, count: pending.size };
  notifyToast();
  let ok = false;
  try {
    ok = (await deleteGoal({ data: { id } })).ok;
  } catch {
    ok = false;
  }
  // Backend rejected the delete (or the request failed): drop the guard and let any mounted list
  // resync so the goal comes back rather than silently lingering only in the database.
  if (!ok) {
    deletedIds.delete(id);
    notifyGoalsChanged();
  }
}

/** Hide the goal and start its undo window; the backend delete fires only when the window ends. */
export function queueGoalDelete(goal: UserGoal, label: string): void {
  if (deletedIds.has(goal.id)) return;
  deletedIds.add(goal.id);
  const timer = setTimeout(() => void commitDelete(goal.id), UNDO_DELETE_MS);
  pending.set(goal.id, { goal, timer });
  seq += 1;
  toast = { seq, label, count: pending.size };
  notifyToast();
}

/** Cancel every delete still inside its window; the server never saw them, so nothing is lost. */
export function undoGoalDeletes(): void {
  const restored = [...pending.values()].map((entry) => entry.goal);
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    deletedIds.delete(entry.goal.id);
  }
  pending.clear();
  toast = null;
  notifyToast();
  if (restored.length > 0) notifyGoalsChanged(restored);
}
