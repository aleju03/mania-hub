import { useCallback, useEffect, useRef, useState } from "react";
import { animate, useMotionValue, type MotionValue } from "framer-motion";
import { SHOP_FEEL } from "./shopFeel";
import { chainSkip727 } from "../../../../backend/src/shared/chain-run";

/* Motion helpers the shop and the charm rail share. */

/* A bought charm's trip from its shop card to its rail slot, flown as a
   ghost drawn over the whole table (RunCharmRail's ghost layer), never by
   moving the rail item itself.

   - The shop starts the ghost on the Buy press, over the card's art, and it
     lifts there while the server answers ("held").
   - The rail's new charm claims it when it mounts, keyed by charm id, and
     stays invisible (a dashed slot) while the ghost is up.
   - The shop confirms on the server's yes ("flying"); the ghost layer flies
     it to the claimed slot and finishes it on landing, which reveals the
     charm and pops the slot.
   - A refusal cancels it ("back"): it fades over its card. */
export interface GhostRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CharmGhost {
  key: number;
  id: string;
  rarity: string;
  from: GhostRect;
  phase: "held" | "flying" | "back";
  uid: number | null;
}

let ghosts: CharmGhost[] = [];
let nextGhostKey = 0;
const ghostListeners = new Set<() => void>();

function setGhosts(next: CharmGhost[]) {
  ghosts = next;
  ghostListeners.forEach((listener) => listener());
}

export function subscribeGhosts(listener: () => void): () => void {
  ghostListeners.add(listener);
  return () => ghostListeners.delete(listener);
}

export function getGhosts(): CharmGhost[] {
  return ghosts;
}

export function startGhost(id: string, rarity: string, from: GhostRect): number {
  const key = ++nextGhostKey;
  setGhosts([...ghosts, { key, id, rarity, from, phase: "held", uid: null }]);
  return key;
}

export function confirmGhost(key: number) {
  setGhosts(ghosts.map((ghost) => (ghost.key === key ? { ...ghost, phase: "flying" } : ghost)));
}

export function cancelGhost(key: number) {
  setGhosts(ghosts.map((ghost) => (ghost.key === key ? { ...ghost, phase: "back" } : ghost)));
}

export function finishGhost(key: number) {
  if (!ghosts.some((ghost) => ghost.key === key)) return;
  setGhosts(ghosts.filter((ghost) => ghost.key !== key));
}

/* A new rail charm takes the oldest unclaimed ghost of its id. */
export function claimGhost(id: string, uid: number): boolean {
  if (ghosts.some((ghost) => ghost.uid === uid)) return true;
  const ghost = ghosts.find((entry) => entry.id === id && entry.uid === null && entry.phase !== "back");
  if (!ghost) return false;
  setGhosts(ghosts.map((entry) => (entry === ghost ? { ...entry, uid } : entry)));
  return true;
}

/* A side-to-side shudder for a refused press. */
export function useShudder(reducedMotion: boolean): [MotionValue<number>, () => void] {
  const x = useMotionValue(0);
  const shudder = useCallback(() => {
    if (reducedMotion) return;
    animate(x, [...SHOP_FEEL.refuse.keyframes], { duration: SHOP_FEEL.refuse.durationMs / 1000, ease: "linear" });
  }, [reducedMotion, x]);
  return [x, shudder];
}

/* A number that ticks to its new value instead of jumping. */
export function useTicker(value: number, reducedMotion: boolean): number {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  useEffect(() => {
    if (reducedMotion || shownRef.current === value) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    const controls = animate(shownRef.current, value, {
      duration: SHOP_FEEL.tickMs / 1000,
      ease: "linear",
      onUpdate: (latest) => {
        // Never lands on a 727 the engine did not flag (the chain run's 727 rule).
        const next = chainSkip727(Math.round(latest), value);
        shownRef.current = next;
        setShown(next);
      },
    });
    return () => controls.stop();
  }, [reducedMotion, value]);
  return shown;
}

/* "+N" / "-N" texts rising off a spot, cleared once they have faded. */
export interface ShardFloat {
  key: number;
  x: number;
  y: number;
  value: number;
}

export function useShardFloats(): [ShardFloat[], (x: number, y: number, value: number) => void] {
  const [floats, setFloats] = useState<ShardFloat[]>([]);
  const nextKey = useRef(0);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  const push = useCallback((x: number, y: number, value: number) => {
    const key = ++nextKey.current;
    setFloats((current) => [...current, { key, x, y, value }]);
    timers.current.push(
      window.setTimeout(() => setFloats((current) => current.filter((entry) => entry.key !== key)), SHOP_FEEL.float.durationMs + 50),
    );
  }, []);
  return [floats, push];
}
