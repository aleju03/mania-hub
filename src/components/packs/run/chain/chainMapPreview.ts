/* The round chart's song: the first few seconds of osu!'s own preview clip
   of the set (it starts at the chorus), played once, quietly, as the round
   opens, then faded out. Never looped. One clip at a time; a set without a
   preview just stays silent. A plain <audio> element: b.ppy.sh sends no
   CORS headers, so WebAudio can't decode it, and the maps page plays the
   same URLs this way. The table's music ducks under it. */

import { duckRunMusic } from "../../packSfx";

const LEVEL = 0.1;
const FADE_IN_MS = 500;
const FADE_OUT_MS = 1500;
/* Fades out from here, well before the clip's own end. */
const PLAY_MS = 4500;

let audio: HTMLAudioElement | null = null;
let timer: number | null = null;
/* A clip the browser would not start (a page loaded straight into a round,
   with no click yet): it starts on the first click or key instead. */
let waiting: (() => void) | null = null;

function stopWaiting(): void {
  if (!waiting) return;
  window.removeEventListener("pointerdown", waiting, true);
  window.removeEventListener("keydown", waiting, true);
  waiting = null;
}

function clearTimer(): void {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
}

/* Ramps the clip's volume to `to` over `ms`, then runs `done`. */
function ramp(el: HTMLAudioElement, to: number, ms: number, done?: () => void): void {
  clearTimer();
  const from = el.volume;
  const started = performance.now();
  timer = window.setInterval(() => {
    const k = Math.min(1, (performance.now() - started) / ms);
    el.volume = Math.max(0, Math.min(1, from + (to - from) * k));
    if (k >= 1) {
      clearTimer();
      done?.();
    }
  }, 30);
}

export function playMapPreview(setId: number): void {
  if (typeof window === "undefined" || !(setId > 0)) return;
  stopMapPreview(0);
  const el = new Audio(`https://b.ppy.sh/preview/${setId}.mp3`);
  el.volume = 0;
  el.preload = "auto";
  audio = el;
  // Fade out before the clip's own end, so it never cuts off hard.
  el.addEventListener("timeupdate", () => {
    if (audio !== el || !Number.isFinite(el.duration) || timer !== null) return;
    if (el.duration - el.currentTime <= FADE_OUT_MS / 1000) ramp(el, 0, FADE_OUT_MS, () => stopMapPreview(0));
  });
  el.addEventListener("ended", () => audio === el && stopMapPreview(0));
  void el.play().then(
    () => {
      if (audio !== el) return;
      duckRunMusic(true);
      ramp(el, LEVEL, FADE_IN_MS);
      window.setTimeout(() => audio === el && ramp(el, 0, FADE_OUT_MS, () => stopMapPreview(0)), PLAY_MS);
    },
    (error: unknown) => {
      if (audio !== el) return;
      stopMapPreview(0);
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        waiting = () => {
          stopWaiting();
          playMapPreview(setId);
        };
        window.addEventListener("pointerdown", waiting, true);
        window.addEventListener("keydown", waiting, true);
      }
    },
  );
}

/* Fades the clip out over `ms` (0 stops it at once). */
export function stopMapPreview(ms = 500): void {
  stopWaiting();
  const el = audio;
  if (!el) return;
  duckRunMusic(false);
  const finish = () => {
    el.pause();
    el.removeAttribute("src");
    el.load();
    if (audio === el) audio = null;
  };
  if (ms <= 0 || el.paused) {
    clearTimer();
    finish();
  } else ramp(el, 0, ms, finish);
}
