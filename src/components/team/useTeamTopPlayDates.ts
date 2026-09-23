import { useEffect, useState } from "react";
import { fetchLiveTeamTopPlayDatesDirect, openLiveEventSource, type LiveTeamTopPlayDates } from "../../lib/live-backend";

// Event bursts share one read. Even a very active team leaves room in the
// costly-read bucket for its profile and tabs; idle pages never poll.
const MIN_READ_GAP_MS = 3_000;
const EVENT_DELAY_MS = 150;

export function useTeamTopPlayDates(teamId: number, memberIds: number[], enabled: boolean): LiveTeamTopPlayDates | null {
  const [result, setResult] = useState<LiveTeamTopPlayDates | null>(null);
  const signature = enabled ? memberIds.join(",") : "";
  useEffect(() => {
    setResult(null);
    if (!enabled || !signature) return;
    const members = new Set(signature.split(",").map(Number));
    const controller = new AbortController();
    const source = openLiveEventSource("GLOBAL", { observe: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let dirty = true;
    let generation = 0;
    let lastRead = -Infinity;

    const schedule = () => {
      if (controller.signal.aborted || running || !dirty || document.visibilityState === "hidden" || timer != null) return;
      timer = setTimeout(() => { timer = undefined; void read(); }, Math.max(EVENT_DELAY_MS, lastRead + MIN_READ_GAP_MS - Date.now()));
    };
    const read = async () => {
      if (controller.signal.aborted || running || document.visibilityState === "hidden") return;
      running = true;
      dirty = false;
      lastRead = Date.now();
      const startedGeneration = generation;
      try {
        const next = await fetchLiveTeamTopPlayDatesDirect(teamId, controller.signal);
        if (!controller.signal.aborted && startedGeneration === generation && next.teamId === teamId) setResult(next);
      } catch {
        // Keep the last good pair. Another score/reconnect/visible visit can
        // retry; an outage must not turn this event-driven read into polling.
      } finally {
        running = false;
        schedule();
      }
    };
    const invalidate = () => { dirty = true; generation++; schedule(); };
    const onScore = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data);
        const userId = Number(payload?.user_id ?? payload?.score?.user_id ?? payload?.user?.id);
        if (members.has(userId)) invalidate();
      } catch { /* Ignore malformed events. */ }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        clearTimeout(timer);
        timer = undefined;
      } else invalidate();
    };
    source?.addEventListener("tracker_score", onScore);
    source?.addEventListener("top_play", onScore);
    source?.addEventListener("hello", invalidate);
    document.addEventListener("visibilitychange", onVisibility);
    // The full team snapshot has a longer cache lifetime. Refresh this small
    // pair once on entry, including when SSR supplied the initial profile.
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
      source?.close();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [teamId, signature, enabled]);
  return enabled && result?.teamId === teamId ? result : null;
}
