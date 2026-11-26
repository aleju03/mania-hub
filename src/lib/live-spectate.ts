import { useEffect, useRef, useState } from "react";

import { getLiveBackendUrl } from "#/lib/live-backend";
import type { ReplayFrame } from "#/lib/types";

/* Spectating a player's live stream from Mania Bridge. Mirrors
   backend/src/integrations/companella/live-spectate.ts: a snapshot of the
   play so far, then the events after it over the stream's own SSE
   connection (not the shared /api/live one: a long play's frames are too big
   for it, and only the viewers of one player need them). */

export type LiveHitCounts = { perfect: number; great: number; good: number; ok: number; meh: number; miss: number };

export interface LivePlay {
  play_id: string;
  client: "stable" | "lazer";
  beatmap: { md5: string; title: string; artist: string; creator: string; version: string; keys: number };
  mods: string[];
  rate: number;
  seed: number | null;
  rate_of: { md5: string; rate: number; keep_pitch: boolean } | null;
  /** Restarts of this map in a row before this play. */
  retries?: number;
  /** An osu!standard map played as mania; not drawn. */
  convert?: boolean;
}

export interface LiveMap {
  md5: string;
  chart: "official" | "uploaded" | "none";
  beatmap_id: number | null;
  beatmapset_id: number | null;
  audio: {
    beatmap_id: number | null;
    beatmapset_id: number;
    filename: string | null;
    time_scale: number;
    keep_pitch: boolean;
  } | null;
}

/** `resuming`: still paused, with the game counting down to carry on (lazer's 3, 2, 1). */
export interface LiveClock { play_id: string; time: number; paused: boolean; resuming?: boolean; health?: number | null; received_at: number }
/** A reading as this tab holds it: when it arrived, and when the resume countdown it reports began. */
/**
 * One stretch of the player's map clock, in this tab's time: from `at`
 * (performance.now()) the map was at `time` and either ran at the play's
 * rate or stood still. `paused` marks a stop the game reported as a pause.
 */
export interface LiveClockSegment {
  at: number;
  time: number;
  moving: boolean;
  paused: boolean;
  /** A reading after this one fell behind the line and was set aside as late. */
  late?: boolean;
}

export type LocalLiveClock = LiveClock & {
  /** When this reading arrived, in performance.now() time. */
  localAt: number;
  /** What the player's map clock did over the last minute, oldest first; grown in place. */
  timeline: LiveClockSegment[];
  resumingAt: number | null;
};

/**
 * How far past the newest reading the map is taken to run before the stage
 * waits for the next one. Notes past it are not shown as missed until data
 * about them arrives.
 */
const AHEAD_OF_DATA_MS = 150;

/** Where the player's map was at local time `t`, and the stretch it was in; `held` when that is as far as the data goes. */
export function liveClockPosition(clock: Pick<LocalLiveClock, "timeline" | "localAt">, t: number, rate: number): { time: number; segment: LiveClockSegment; held?: boolean } | null {
  const timeline = clock.timeline;
  if (timeline.length === 0) return null;
  let index = timeline.length - 1;
  while (index > 0 && timeline[index].at > t) index -= 1;
  const segment = timeline[index];
  if (!segment.moving) return { time: segment.time, segment };
  if (index + 1 < timeline.length) {
    return { time: segment.time + (Math.min(t, timeline[index + 1].at) - segment.at) * rate, segment };
  }
  const time = segment.time + (t - segment.at) * rate;
  const limit = segment.time + AHEAD_OF_DATA_MS * rate;
  return time >= limit ? { time: limit, segment, held: true } : { time, segment };
}

/**
 * The furthest the stage may go from local time `t` on: the next point where
 * the player's map stops (already known, since the stage runs behind), or
 * just past the newest reading. The stage's own clock can run a little ahead
 * of the player's, and must not run through either.
 */
export function liveClockBarrier(clock: Pick<LocalLiveClock, "timeline">, t: number, rate: number): number | null {
  const timeline = clock.timeline;
  if (timeline.length === 0) return null;
  let index = timeline.length - 1;
  while (index > 0 && timeline[index].at > t) index -= 1;
  for (let i = index; i < timeline.length; i++) {
    if (!timeline[i].moving) return timeline[i].time;
  }
  const last = timeline[timeline.length - 1];
  return last.time + AHEAD_OF_DATA_MS * rate;
}

/** Adds a reading to the timeline: a stop where the map stopped, a start where it went again, a small nudge otherwise. */
function extendTimeline(timeline: LiveClockSegment[], reading: { time: number; at: number; stopped: boolean; paused: boolean }, rate: number): void {
  const last = timeline[timeline.length - 1];
  const { time, at } = reading;
  if (!last) {
    timeline.push({ at, time, moving: !reading.stopped, paused: reading.paused });
    return;
  }
  if (reading.stopped) {
    if (last.moving) {
      // The map stopped somewhere between the last start and now; where it
      // stands says when.
      const stopAt = Math.max(last.at, Math.min(at, last.at + (time - last.time) / rate));
      timeline.push({ at: stopAt, time, moving: false, paused: reading.paused });
    } else if (Math.abs(time - last.time) > 50 * rate) {
      timeline.push({ at, time, moving: false, paused: reading.paused });
    } else if (reading.paused) {
      last.paused = true;
    }
  } else if (!last.moving) {
    // Going again: from the stop, unless the map is somewhere else now (a retry, a seek).
    const ran = time - last.time;
    if (ran >= 0 && ran < 3_000 * rate) timeline.push({ at: Math.max(last.at, at - ran / rate), time: last.time, moving: true, paused: false });
    else timeline.push({ at, time, moving: true, paused: false });
  } else {
    const expected = last.time + (at - last.at) * rate;
    const off = time - expected;
    // A batch that arrived late reads as the map falling behind; the next
    // one is back on the line. Only a second reading behind it moves the
    // line back.
    if (off < -250 * rate && off > -3_000 * rate && !last.late) {
      last.late = true;
      return;
    }
    // Readings are a few tens of ms off each and come in batches; one near
    // the line only leans it, one far off (a seek) moves it.
    timeline.push({ at, time: Math.abs(off) < 250 * rate ? expected + off * 0.2 : time, moving: true, paused: false });
  }
  while (timeline.length > 2 && timeline[1].at < at - 60_000) timeline.shift();
}
export interface LiveStats { play_id: string; hits: LiveHitCounts; combo: number | null; max_combo: number | null; acc: number; columns: number[][] }
export interface LiveEnd {
  play_id: string;
  reason: "passed" | "failed" | "quit" | "retry";
  hits: LiveHitCounts;
  acc: number;
  max_combo: number | null;
  /** Map time the play failed at, when the client knows it. */
  time?: number | null;
}
/** Which screen the player is on outside a play. */
export interface LiveMenuState { state: string; client?: "stable" | "lazer" | null }

interface LiveSnapshot {
  live: boolean;
  seq: number;
  server_time: number;
  user_id: number | null;
  username?: string;
  viewers: number;
  state?: LiveMenuState | null;
  play?: LivePlay | null;
  map?: LiveMap | null;
  frames?: number[];
  frames_capped?: boolean;
  clock?: LiveClock | null;
  stats?: LiveStats | null;
  end?: LiveEnd | null;
}

/**
 * The stream as the page reads it. `frames` is mutable and grows in place;
 * `framesVersion` moves whenever it changes. `clock.localAt` is when the clock
 * reading arrived here, in performance.now() time, so the playhead can run on
 * between readings.
 */
export interface LiveSpectateState {
  status: "loading" | "offline" | "live" | "unavailable";
  userId: number | null;
  username: string | null;
  viewers: number;
  state: LiveMenuState | null;
  play: LivePlay | null;
  /**
   * Every play id the stream has used for the play on screen. A client can
   * report a restart that was not one (the map clock never went back); those
   * ids join this list instead of starting the stage over.
   */
  playIds: string[];
  map: LiveMap | null;
  frames: ReplayFrame[];
  framesVersion: number;
  framesCapped: boolean;
  clock: LocalLiveClock | null;
  /** The game's own health over the play, as the clock readings carried it; grown in place. */
  health: Array<{ time: number; health: number }>;
  stats: LiveStats | null;
  end: LiveEnd | null;
  /** When the play's end arrived here (performance.now()); -Infinity for one that had ended before this page saw it. */
  endedAt: number | null;
}

const INITIAL: LiveSpectateState = {
  status: "loading",
  userId: null,
  username: null,
  viewers: 0,
  state: null,
  play: null,
  playIds: [],
  map: null,
  frames: [],
  framesVersion: 0,
  framesCapped: false,
  clock: null,
  health: [],
  stats: null,
  end: null,
  endedAt: null,
};

function unpackFrames(flat: number[] | undefined): ReplayFrame[] {
  const frames: ReplayFrame[] = [];
  if (!flat) return frames;
  for (let i = 0; i + 1 < flat.length; i += 2) frames.push({ time: flat[i], keyState: flat[i + 1] });
  return frames;
}

/** A clock reading's age at the server, carried over to this tab's clock. */
function localClock(clock: LiveClock, serverNow: number): LocalLiveClock {
  const localAt = performance.now() - Math.max(0, serverNow - clock.received_at);
  return {
    ...clock,
    localAt,
    timeline: [{ at: localAt, time: clock.time, moving: !clock.paused, paused: clock.paused }],
    resumingAt: clock.paused && clock.resuming ? localAt : null,
  };
}

function fromSnapshot(snapshot: LiveSnapshot, previous: LiveSpectateState): LiveSpectateState {
  if (!snapshot.live) {
    return { ...INITIAL, status: "offline", userId: snapshot.user_id, username: previous.username, viewers: snapshot.viewers };
  }
  return {
    status: "live",
    userId: snapshot.user_id,
    username: snapshot.username ?? previous.username,
    viewers: snapshot.viewers,
    state: snapshot.state ?? null,
    play: snapshot.play ?? null,
    playIds: snapshot.play ? [snapshot.play.play_id] : [],
    map: snapshot.map ?? null,
    frames: unpackFrames(snapshot.frames),
    framesVersion: previous.framesVersion + 1,
    framesCapped: snapshot.frames_capped === true,
    clock: snapshot.clock ? localClock(snapshot.clock, snapshot.server_time) : null,
    health: snapshot.clock?.health != null ? [{ time: snapshot.clock.time, health: snapshot.clock.health }] : [],
    stats: snapshot.stats ?? null,
    end: snapshot.end ?? null,
    endedAt: snapshot.end ? -Infinity : null,
  };
}

export function liveSpectateChartUrl(userId: number, md5: string): string | null {
  const base = getLiveBackendUrl();
  return base ? `${base}/api/live/spectate/${userId}/chart/${md5}` : null;
}

/** Follows one player's stream: the snapshot, then its events, re-reading the snapshot on any gap. */
export function useLiveSpectate(user: string): LiveSpectateState {
  const [state, setState] = useState<LiveSpectateState>(INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const base = getLiveBackendUrl();
    if (!base) {
      setState({ ...INITIAL, status: "unavailable" });
      return;
    }
    let cancelled = false;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let seq = 0;
    let lastRaw: { time: number; paused: boolean; at: number; playId: string } | null = null;
    let slowBefore = false;
    // A new play of the same map, held back until its first clock reading
    // says whether the map really started over.
    let pending: { play: LivePlay; map: LiveMap; frames: ReplayFrame[] | null } | null = null;
    const owns = (s: LiveSpectateState, playId: string) => s.playIds.includes(playId);
    const freshPlay = (s: LiveSpectateState, play: LivePlay, map: LiveMap, frames: ReplayFrame[] = []): LiveSpectateState => ({
      ...s,
      status: "live",
      play,
      playIds: [play.play_id],
      map,
      frames,
      framesVersion: s.framesVersion + 1,
      framesCapped: false,
      clock: null,
      health: [],
      stats: null,
      end: null,
      endedAt: null,
    });
    const path = `${base}/api/live/spectate/${encodeURIComponent(user)}`;

    const update = (next: (current: LiveSpectateState) => LiveSpectateState) => {
      if (cancelled) return;
      const value = next(stateRef.current);
      stateRef.current = value;
      setState(value);
    };

    const scheduleRetry = (ms: number) => {
      if (retryTimer || cancelled) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void connect();
      }, ms);
    };

    const handlers: Record<string, (data: any) => void> = {
      state: (data) => update((s) => ({ ...s, status: "live", state: data })),
      play_start: (data: { play: LivePlay; map: LiveMap }) => update((s) => {
        if (s.play && s.play.beatmap.md5 === data.play.beatmap.md5 && s.clock) {
          pending = { play: data.play, map: data.map, frames: null };
          return s;
        }
        pending = null;
        return freshPlay(s, data.play, data.map);
      }),
      map: (data: LiveMap) => update((s) => (s.play?.beatmap.md5 === data.md5 ? { ...s, map: data } : s)),
      frames: (data: { play_id: string; reset: boolean; frames: number[] }) => update((s) => {
        if (pending?.play.play_id === data.play_id) {
          const held = data.reset || !pending.frames ? [] : pending.frames;
          for (let i = 0; i + 1 < data.frames.length; i += 2) held.push({ time: data.frames[i], keyState: data.frames[i + 1] });
          pending.frames = held;
          return s;
        }
        if (!owns(s, data.play_id)) return s;
        // A reset to a list that ends before the one here, on the same play,
        // is a short copy, not a restart: only its newer frames are taken.
        const incomingEnd = data.frames.length >= 2 ? data.frames[data.frames.length - 2] : -Infinity;
        const currentEnd = s.frames.length > 0 ? s.frames[s.frames.length - 1].time : -Infinity;
        const shortCopy = data.reset && s.playIds.length > 1 && incomingEnd < currentEnd;
        const frames = data.reset && !shortCopy ? [] : s.frames;
        const after = data.reset && !shortCopy ? -Infinity : currentEnd;
        for (let i = 0; i + 1 < data.frames.length; i += 2) {
          if (data.frames[i] > after || !data.reset) frames.push({ time: data.frames[i], keyState: data.frames[i + 1] });
        }
        return { ...s, frames, framesVersion: s.framesVersion + 1 };
      }),
      frames_capped: () => update((s) => ({ ...s, frames: [], framesCapped: true, framesVersion: s.framesVersion + 1 })),
      clock: (data: LiveClock) => update((s) => {
        if (pending?.play.play_id === data.play_id) {
          const held = pending;
          pending = null;
          const rate = s.play?.rate || 1;
          const before = s.clock?.time;
          if (before != null && data.time >= before - 2000 * rate) {
            // The map never went back: the same play under a new id. Its
            // "every frame so far" can come up short, so it only adds frames
            // newer than the ones already here.
            const frames = s.frames;
            const lastTime = frames.length > 0 ? frames[frames.length - 1].time : -Infinity;
            let added = 0;
            for (const frame of held.frames ?? []) {
              if (frame.time > lastTime) {
                frames.push(frame);
                added += 1;
              }
            }
            s = {
              ...s,
              playIds: [...s.playIds, data.play_id],
              frames,
              framesVersion: added > 0 ? s.framesVersion + 1 : s.framesVersion,
              end: null,
              endedAt: null,
            };
            if (lastRaw) lastRaw = { ...lastRaw, playId: data.play_id };
          } else {
            s = freshPlay(s, held.play, held.map, held.frames ?? []);
          }
        }
        if (!owns(s, data.play_id)) return s;
        const localAt = performance.now();
        if (data.health != null) s.health.push({ time: data.time, health: data.health });
        const rate = s.play?.rate || 1;
        const before = lastRaw;
        lastRaw = { time: data.time, paused: data.paused, at: localAt, playId: data.play_id };
        // The game marks a pause late (stable notices it after half a second
        // of a still clock), and the readings in between just stop advancing:
        // the map stopped either way.
        // One slow reading is just a late batch; a stop shows on two in a row.
        const slow = !data.paused && before != null && before.playId === data.play_id && !before.paused
          && localAt - before.at > 150 && data.time - before.time < (localAt - before.at) * rate * 0.3;
        const stalled = slow && slowBefore;
        slowBefore = slow && !stalled;
        if (slowBefore) return s;
        const timeline = s.clock?.timeline ?? [];
        extendTimeline(timeline, { time: data.time, at: localAt, stopped: data.paused || stalled, paused: data.paused }, rate);
        // The countdown began with the first reading that reports it; later ones only repeat it.
        const resumingAt = data.paused && data.resuming ? s.clock?.resumingAt ?? localAt : null;
        return { ...s, clock: { ...data, localAt, timeline, resumingAt } };
      }),
      stats: (data: LiveStats) => update((s) => (owns(s, data.play_id) ? { ...s, stats: data } : s)),
      play_end: (data: LiveEnd) => update((s) => (owns(s, data.play_id) ? { ...s, end: data, endedAt: performance.now() } : s)),
      viewers: (data: { count: number }) => update((s) => ({ ...s, viewers: Number(data.count) || 0 })),
      offline: () => update((s) => {
        pending = null;
        return { ...INITIAL, status: "offline", userId: s.userId, username: s.username, viewers: s.viewers };
      }),
    };

    async function connect(): Promise<void> {
      source?.close();
      source = null;
      let snapshot: LiveSnapshot;
      try {
        const response = await fetch(path, { credentials: "omit", cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        snapshot = await response.json() as LiveSnapshot;
      } catch {
        scheduleRetry(5_000);
        return;
      }
      if (cancelled) return;
      seq = snapshot.seq;
      pending = null;
      update((s) => fromSnapshot(snapshot, s));
      // A name only resolves while that player streams; follow the id from here.
      const target = snapshot.user_id ?? null;
      if (target == null) {
        scheduleRetry(15_000);
        return;
      }
      const es = new EventSource(`${base}/api/live/spectate/${target}/stream?from=${seq}`);
      source = es;
      const track = (event: MessageEvent) => {
        const id = Number(event.lastEventId);
        if (Number.isFinite(id) && id > seq) seq = id;
      };
      for (const [type, handle] of Object.entries(handlers)) {
        es.addEventListener(type, (event) => {
          track(event as MessageEvent);
          try {
            handle(JSON.parse((event as MessageEvent).data));
          } catch {
            // A malformed event is dropped.
          }
        });
      }
      // A new stream or a gap the server's log no longer covers: start over from the snapshot.
      es.addEventListener("resync", () => void connect());
      es.addEventListener("capacity", () => {
        es.close();
        scheduleRetry(30_000);
      });
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          scheduleRetry(3_000);
        }
      };
    }

    setState(INITIAL);
    void connect();
    return () => {
      cancelled = true;
      source?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [user]);

  return state;
}
