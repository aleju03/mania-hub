type ReplayAudioClockSource = Pick<HTMLMediaElement, "currentTime" | "paused" | "seeking" | "readyState" | "error">;

/** Null releases playback to the renderer's own clock when song audio is unusable. */
export function readReplayAudioClock(
  audio: ReplayAudioClockSource | null,
  active: boolean,
): { time: number; stalled: boolean } | null {
  if (!active || !audio || audio.error) return null;
  return {
    time: audio.currentTime * 1000,
    // HAVE_FUTURE_DATA is 3; the numeric constant also keeps this pure helper
    // usable in tests without constructing a browser media element.
    stalled: audio.paused || audio.seeking || audio.readyState < 3,
  };
}
