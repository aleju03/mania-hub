import { RUN_FEEL } from "./runFeel";

/* The wobble a card, charm or HUD box gives when it fires (feel §4): knocked
   down to a squash, then a fast decaying scale ring and a slower decaying
   rotation ring, 0.4s in all on the real clock. Played as Web Animations
   keyframes so it never fights the springs that place the element: a
   `[data-run-juice]` child takes it when there is one, and it is added on
   top of whatever transform the element already has. */

export interface JuiceAmount {
  amount: number;
  rotateRad: number;
}

const SAMPLES = 24;

function juiceKeyframes({ amount, rotateRad }: JuiceAmount): Keyframe[] {
  const feel = RUN_FEEL.juice;
  const total = feel.durationMs / 1000;
  const sign = Math.random() < 0.5 ? -1 : 1;
  const frames: Keyframe[] = [];
  for (let index = 0; index <= SAMPLES; index += 1) {
    const t = (index / SAMPLES) * total;
    const left = 1 - t / total;
    // The squash recovers within the first beat of the ring.
    const squash = feel.squash * amount * Math.max(0, 1 - t / 0.03);
    const scale = 1 - squash + amount * Math.sin(Math.PI * 2 * feel.scaleHz * t) * left ** 3;
    // The rotation target takes twice the juice rotation (feel §4).
    const rotate = sign * 2 * rotateRad * Math.sin(Math.PI * 2 * feel.rotateHz * t) * left ** 2;
    frames.push({ transform: `scale(${scale.toFixed(4)}) rotate(${((rotate * 180) / Math.PI).toFixed(3)}deg)`, offset: index / SAMPLES });
  }
  return frames;
}

export function juiceTarget(element: Element): HTMLElement | null {
  const inner = element.querySelector<HTMLElement>("[data-run-juice]");
  if (inner) return inner;
  return element instanceof HTMLElement ? element : null;
}

export function juice(element: Element | null | undefined, amount: JuiceAmount): void {
  if (!element) return;
  const target = juiceTarget(element);
  if (!target || typeof target.animate !== "function") return;
  const frames = juiceKeyframes(amount);
  const options: KeyframeAnimationOptions = { duration: RUN_FEEL.juice.durationMs, easing: "linear" };
  try {
    target.animate(frames, { ...options, composite: "add" });
  } catch {
    target.animate(frames, options);
  }
}

/* A HUD number ticking to a new value: a smaller squash-and-ring that grows
   with the digits, so bigger numbers visibly hit harder (feel §3). */
export function punch(element: Element | null | undefined, digits: number): void {
  const amount = Math.min(0.32, 0.1 + 0.025 * Math.max(0, digits - 1));
  juice(element, { amount, rotateRad: 0.02 + 0.004 * digits });
}
