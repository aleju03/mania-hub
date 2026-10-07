/*
 * Stable mania replay frames: the raw .osr input rows, turned into absolute
 * key-state samples the judge can read.
 *
 * The replay viewer and the judge read one replay the same way through it.
 */

export const MANIA_REPLAY_KEY_MASK = (1 << 20) - 1;

/** One decoded input sample. */
export interface ReplayInputFrame {
  time: number;     // absolute time in ms
  keyState: number; // bitmask: bit N = column N pressed
}

export type RawReplayFrameLike = {
  buttonState?: number;
  mouseX?: number;
  mouseY?: number;
  position?: {
    x?: number;
    y?: number;
  };
  startTime?: number;
  time?: number;
};

type NormalizedReplayFrame = ReplayInputFrame & {
  x: number;
  y: number;
};

function replayFrameTime(frame: RawReplayFrameLike): number {
  return Math.round(Number(frame.startTime ?? frame.time ?? 0));
}

function replayFrameX(frame: RawReplayFrameLike): number {
  return Number(frame.mouseX ?? frame.position?.x ?? frame.buttonState ?? 0);
}

function replayFrameY(frame: RawReplayFrameLike): number {
  return Number(frame.mouseY ?? frame.position?.y ?? 0);
}

function isStableDummyStartupFrame(frame: NormalizedReplayFrame): boolean {
  return Math.round(frame.x) === 256 && Math.round(frame.y) === -500;
}

export function getStableManiaReplayKeyState(frame: RawReplayFrameLike): number {
  return Math.round(replayFrameX(frame)) & MANIA_REPLAY_KEY_MASK;
}

export function getStableManiaReplayScrollSpeedScale(rawFrames: RawReplayFrameLike[]): number | null {
  for (const frame of rawFrames) {
    const x = replayFrameX(frame);
    const y = replayFrameY(frame);
    if (!Number.isFinite(x) || !Number.isFinite(y) || y <= 0) continue;
    return y;
  }

  return null;
}

export function decodeStableManiaReplayFrames(rawFrames: RawReplayFrameLike[]): ReplayInputFrame[] {
  const frames = rawFrames
    .map((frame): NormalizedReplayFrame => {
      const x = replayFrameX(frame);
      const y = replayFrameY(frame);
      return {
        keyState: Math.round(x) & MANIA_REPLAY_KEY_MASK,
        time: replayFrameTime(frame),
        x,
        y,
      };
    })
    .filter((frame) => Number.isFinite(frame.time) && Number.isFinite(frame.x) && Number.isFinite(frame.y));

  // Mirrored from lazer's LegacyScoreDecoder, which cites stable's
  // ReplayWatcher.cs at e53980dd76857ee899f66ce519ba1597e7874f28.
  if (frames.length >= 2 && frames[1].time < frames[0].time) {
    frames[1].time = frames[0].time;
    frames[0].time = 0;
  }

  if (frames.length >= 3 && frames[0].time > frames[2].time) {
    frames[0].time = frames[2].time;
    frames[1].time = frames[2].time;
  }

  if (frames.length >= 2 && isStableDummyStartupFrame(frames[1])) {
    frames.splice(1, 1);
  }

  if (frames.length >= 1 && isStableDummyStartupFrame(frames[0])) {
    frames.splice(0, 1);
  }

  const output: ReplayInputFrame[] = [];
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const frame of frames) {
    if (frame.time < previousTime) continue;
    output.push({ time: frame.time, keyState: frame.keyState });
    previousTime = frame.time;
  }

  return output;
}
