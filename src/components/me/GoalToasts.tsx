import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { GradeImg } from "../ui/GradeImg";
import { OsuLogo } from "../ui/OsuLogo";
import { useAuth } from "../../lib/auth-context";
import { openLiveEventSource } from "../../lib/live-backend";
import { playGoalClearedSound } from "../../lib/ui-sounds";
import { celebrationLabel, type GoalCompletedPayload } from "../../lib/goal-format";
import {
  getGoalDeleteToast,
  notifyGoalsChanged,
  subscribeGoalDeleteToast,
  undoGoalDeletes,
  UNDO_DELETE_MS,
  type GoalDeleteToast,
} from "../../lib/goal-toasts";
import type { GoalKind } from "../../lib/goals";

// Site-wide goal toasts, mounted once in the root layout so they follow the user across pages:
// the delete-undo bar (backed by the module-level store in lib/goal-toasts) and the goal-cleared
// celebration (backed by the viewer's country SSE feed).

export function GoalToasts() {
  const auth = useAuth();
  const viewer = auth.viewer;

  const [celebration, setCelebration] = useState<Celebration | null>(null);
  const celebrationSeq = useRef(0);
  const celebrationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (celebrationTimer.current) clearTimeout(celebrationTimer.current);
  }, []);

  const viewerId = viewer?.id;
  const viewerCountry = viewer?.countryCode;
  useEffect(() => {
    if (!viewerId || !viewerCountry) return;
    const source = openLiveEventSource(viewerCountry);
    if (!source) return;
    source.addEventListener("goal_completed", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as GoalCompletedPayload;
        if (data.userId !== viewerId) return;
        celebrationSeq.current += 1;
        setCelebration({ id: celebrationSeq.current, kind: data.kind ?? "reach_pp", label: celebrationLabel(data), targetGrade: data.targetGrade ?? null });
        playGoalClearedSound();
        if (celebrationTimer.current) clearTimeout(celebrationTimer.current);
        celebrationTimer.current = setTimeout(() => setCelebration(null), 6500);
        notifyGoalsChanged();
      } catch {
        notifyGoalsChanged();
      }
    });
    return () => source.close();
  }, [viewerId, viewerCountry]);

  const deleteToast = useSyncExternalStore(subscribeGoalDeleteToast, getGoalDeleteToast, () => null);

  return (
    <>
      <UndoDeleteToast toast={deleteToast} onUndo={undoGoalDeletes} />
      <CelebrationToast celebration={celebration} onDismiss={() => setCelebration(null)} />
    </>
  );
}

function CloseGlyph() {
  return <span className="block text-[15px] leading-none" aria-hidden="true">×</span>;
}

// Bottom-center undo bar shown while a delete waits out its grace window. The countdown bar tracks
// the newest deletion; Undo restores every deletion still inside its window.
function UndoDeleteToast({ toast, onUndo }: { toast: GoalDeleteToast | null; onUndo: () => void }) {
  return (
    <AnimatePresence>
      {toast ? (
        <motion.div
          key="undo-delete"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-x-0 bottom-5 z-[70] flex justify-center px-4"
          role="status"
          aria-live="polite"
        >
          <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-osu-b3/45 bg-osu-b4 shadow-[0_20px_70px_rgba(0,0,0,0.55)]">
            <div className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-osu-f1">{toast.count > 1 ? `${toast.count} goals deleted` : "goal deleted"}</div>
                <div className="mt-0.5 truncate text-[13px] font-bold text-white" title={toast.label}>
                  {toast.label}
                </div>
              </div>
              <button
                type="button"
                onClick={onUndo}
                className="shrink-0 rounded-lg border border-osu-pink/45 bg-osu-pink/15 px-3 py-1.5 text-[12px] font-bold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white"
              >
                Undo
              </button>
            </div>
            <motion.div
              key={toast.seq}
              initial={{ scaleX: 1 }}
              animate={{ scaleX: 0 }}
              transition={{ duration: UNDO_DELETE_MS / 1000, ease: "linear" }}
              style={{ transformOrigin: "left" }}
              className="h-0.5 bg-osu-pink/60"
            />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

interface Celebration {
  id: number;
  kind: GoalKind;
  label: string;
  targetGrade: string | null;
}

export const COMPOSER_TRIANGLES: Array<{ p: string; o: number }> = [
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
