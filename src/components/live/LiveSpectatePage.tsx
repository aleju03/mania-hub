import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Trans, useLingui } from "@lingui/react/macro";

import { ReplayInfo } from "../replay/ReplayInfo";
import { SpectatorNotice } from "../replay/LivePauseOverlays";
import { avatarImageSrc } from "../ui/Avatar";
import { MemoReplayViewer, type ReplayLiveFeed } from "../../routes/replay";
import { parseManiaBeatmap, type ManiaBeatmap, type ManiaNote } from "../../lib/beatmap-parser";
import { inferRandomColumnMap } from "../../lib/live-random-columns";
import { liveSpectateChartUrl, liveSpectateSongUrl, useLiveSpectate, type LivePlay, type LiveMap, type LiveSpectateState } from "../../lib/live-spectate";
import { fetchLivePlayerSummaryDirect } from "../../lib/live-backend";
import { getBeatmapFile } from "../../lib/osu";
import type { ServerReplay } from "../../lib/replay-types";
import type { OsuMod, ReplayFrame } from "../../lib/types";

/** How far behind the player the stage runs: the batching gap plus room for a late batch. */
const DELAY_MS = 1_000;

const RATE_MODS = new Set(["DT", "NC", "HT", "DC"]);
/** How long a finished play stays on the stage: its delay, the outro and the results screen. */
const FINISHED_SHOWN_MS = 20_000;

/**
 * The chart the stage draws. A rate edit the app made is drawn as its
 * original under a rate mod, the way lazer shows a custom rate, so the
 * original's song and background come with it; `timeScale` maps the edit's
 * map time onto the original's.
 */
interface LoadedChart {
  md5: string;
  beatmap: ManiaBeatmap;
  content: string;
  beatmapsetId: number | null;
  timeScale: number;
  keepPitch: boolean;
}

async function officialText(beatmapId: number, beatmapsetId: number | null): Promise<string | null> {
  const file = await getBeatmapFile({ data: { beatmapId, beatmapsetId: beatmapsetId ?? undefined } });
  return file.content?.trim() ? file.content : null;
}

async function loadChart(userId: number, map: LiveMap): Promise<LoadedChart | null> {
  const audio = map.audio;
  if (audio && audio.time_scale !== 1 && audio.beatmap_id) {
    const content = await officialText(audio.beatmap_id, audio.beatmapset_id);
    if (content) {
      return { md5: map.md5, beatmap: parseManiaBeatmap(content), content, beatmapsetId: audio.beatmapset_id, timeScale: audio.time_scale, keepPitch: audio.keep_pitch };
    }
  }
  let content: string | null = null;
  if (map.chart === "official" && map.beatmap_id) {
    content = await officialText(map.beatmap_id, map.beatmapset_id);
  } else if (map.chart === "uploaded") {
    const url = liveSpectateChartUrl(userId, map.md5);
    const response = url ? await fetch(url, { credentials: "omit" }) : null;
    content = response?.ok ? await response.text() : null;
  }
  if (!content) return null;
  const beatmap = parseManiaBeatmap(content);
  const setId = map.beatmapset_id ?? (beatmap.beatmapsetId && beatmap.beatmapsetId > 0 ? beatmap.beatmapsetId : null);
  return { md5: map.md5, beatmap, content, beatmapsetId: setId, timeScale: 1, keepPitch: false };
}

/** The play's mods as the viewer reads them: the rate as a speed setting, Random with its seed. */
function viewerMods(play: LivePlay, chart: LoadedChart): OsuMod[] {
  const rate = play.rate * chart.timeScale;
  const mods: OsuMod[] = [];
  for (const acronym of play.mods) {
    if (RATE_MODS.has(acronym) || acronym === "NM") continue;
    // Lazer's Random seed reproduces the shuffle; stable's cannot be read live,
    // so a stable play keeps RD without one and the page works the shuffle out.
    mods.push(acronym === "RD" && play.seed != null && play.client === "lazer" ? { acronym, settings: { seed: play.seed } } : { acronym });
  }
  if (Math.abs(rate - 1) > 0.001) {
    const pitchShifts = chart.timeScale !== 1 ? !chart.keepPitch : play.mods.includes("NC") || play.mods.includes("DC");
    const acronym = rate > 1 ? (pitchShifts ? "NC" : "DT") : (pitchShifts ? "DC" : "HT");
    mods.unshift({ acronym, settings: { speed_change: Math.round(rate * 1000) / 1000 } });
  }
  return mods;
}

export function LiveSpectatePage({ user }: { user: string }) {
  const live = useLiveSpectate(user);
  const play = live.play;
  // Quitting to song select leaves the last play behind; the stage goes back to waiting.
  // A finished play stays on the stage while it plays out (the delay, the
  // results screen), then the stage goes back to waiting. One that had
  // already ended when the page opened is never replayed.
  const [now, setNow] = useState(() => performance.now());
  const endedAt = live.endedAt;
  useEffect(() => {
    if (endedAt == null || !Number.isFinite(endedAt)) return;
    const left = endedAt + FINISHED_SHOWN_MS - performance.now();
    if (left <= 0) return;
    const id = window.setTimeout(() => setNow(performance.now()), left + 50);
    return () => window.clearTimeout(id);
  }, [endedAt]);
  // An ended play never comes back, even when the player is already in the
  // next map: the game says "playing" a moment before the new play arrives.
  // Back in the menus after the end (past the results screen) clears it at once.
  const leftRef = useRef<string | null>(null);
  const menuState = live.state?.state;
  if (play && live.end != null && menuState != null && menuState !== "playing" && menuState !== "results") leftRef.current = play.play_id;
  const left = play != null && leftRef.current === play.play_id;
  const finished = left || (endedAt != null && (!Number.isFinite(endedAt) || now >= endedAt + FINISHED_SHOWN_MS));
  // A finished convert goes back to waiting too: it was never drawn.
  const idle = live.status !== "live" || !play || live.end?.reason === "quit" || (play.convert === true && live.end != null) || finished;
  return (
    <div className="flex-1">
      <div className="min-h-[80vh] bg-osu-b5">
        {idle || play.convert ? <LiveIdle live={live} user={user} /> : <LivePlayStage key={play.play_id} live={live} play={play} user={user} />}
      </div>
    </div>
  );
}

/** The stage while there is nothing to draw: offline, in the menus, or waiting for a chart. */
function LiveIdle({ live, user, message }: { live: LiveSpectateState; user: string; message?: string }) {
  const { t } = useLingui();
  // The stream names the player only while they play; otherwise the link may carry just their id.
  const [storedName, setStoredName] = useState<string | null>(null);
  const needsName = live.username == null && live.status === "offline" && /^\d+$/.test(user);
  useEffect(() => {
    if (!needsName) return;
    let cancelled = false;
    fetchLivePlayerSummaryDirect(user, { lookup: "id" })
      .then((summary) => { if (!cancelled && summary) setStoredName(summary.user.username); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [needsName, user]);
  const name = live.username ?? storedName ?? user;
  // In the menus the stage says what stable's spectator screen says, and
  // nothing about the map being browsed.
  const waiting = live.status === "live" && !message;
  const convert = live.status === "live" && live.play?.convert === true && live.end == null;
  const line = message ?? (
    live.status === "loading" ? t`Loading`
      : live.status === "unavailable" ? t`Spectating is not available here.`
        : t`${name} is not playing right now.`
  );
  return (
    <div
      className="relative flex min-h-[calc(100dvh-60px)] w-full flex-col items-center justify-center overflow-hidden px-6 text-center"
      style={{ background: "linear-gradient(180deg, #0a0a18 0%, #1a1016 50%, #0c0c14 100%)" }}
    >
      {waiting ? (
        <SpectatorNotice text={convert ? t`Host is playing a converted map, which can't be spectated.` : t`Host is selecting a song.`} avatarUrl={avatarImageSrc(undefined, live.userId ?? undefined, { proxy: true })} dim={false} />
      ) : (
        <p className="text-[20px] font-semibold text-white">{line}</p>
      )}
      {live.status === "offline" ? (
        <Link to="/player/$username" params={{ username: user }} className="mt-4 text-[13px] text-osu-pink-light hover:brightness-110">
          <Trans>Back to the profile</Trans>
        </Link>
      ) : null}
    </div>
  );
}

function scaleFrames(frames: ReplayFrame[], scale: number): ReplayFrame[] {
  return scale === 1 ? frames : frames.map((frame) => ({ time: frame.time * scale, keyState: frame.keyState }));
}

function LivePlayStage({ live, play, user }: { live: LiveSpectateState; play: LivePlay; user: string }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [loadedChart, setChart] = useState<LoadedChart | null>(null);
  const [chartFailed, setChartFailed] = useState(false);
  const map = live.map;
  const userId = live.userId;
  // Only the chart of the map being played: the one before stays loaded
  // until the next arrives, and must not stand on the stage meanwhile.
  const chart = loadedChart && map && loadedChart.md5 === map.md5 ? loadedChart : null;

  useEffect(() => {
    if (!map || userId == null || (map.chart === "none" && !(map.audio && map.audio.time_scale !== 1))) return;
    if (chart?.md5 === map.md5) return;
    let cancelled = false;
    loadChart(userId, map)
      .then((loaded) => {
        if (cancelled) return;
        setChart(loaded);
        setChartFailed(!loaded);
      })
      .catch(() => {
        if (!cancelled) setChartFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, map?.md5, map?.chart]);

  // A stable Random play: the shuffle is read off the presses once there are enough of them.
  const notesRef = useRef<ManiaNote[] | null>(null);
  const [notesVersion, setNotesVersion] = useState(0);
  const columnMapRef = useRef<string>("");
  // A new play has its own shuffle (and a new map its own notes): nothing
  // worked out for the one before carries over.
  const shuffleOfRef = useRef<string | null>(null);
  const shuffleOf = `${live.playIds[0] ?? ""}:${chart?.md5 ?? ""}`;
  if (shuffleOfRef.current !== shuffleOf) {
    shuffleOfRef.current = shuffleOf;
    notesRef.current = null;
    columnMapRef.current = "";
  }
  // The feed the viewer reads every tick, in the drawn chart's map time.
  const scale = chart?.timeScale ?? 1;
  const clockRef = useRef<ReplayLiveFeed["clockRef"]["current"]>(null);
  const framesRef = useRef<ReplayFrame[]>([]);
  const scaledRef = useRef({ version: -1, scale: 1 });
  clockRef.current = live.clock
    ? {
      paused: live.clock.paused,
      localAt: live.clock.localAt,
      timeline: scale === 1 ? live.clock.timeline : live.clock.timeline.map((segment) => ({ ...segment, time: segment.time * scale })),
      resumingAt: live.clock.resumingAt,
    }
    : null;
  const healthRef = useRef<Array<{ time: number; health: number }>>([]);
  if (healthRef.current.length !== live.health.length) {
    healthRef.current = scale === 1 ? live.health : live.health.map((sample) => ({ time: sample.time * scale, health: sample.health }));
  }
  const pauseInfoRef = useRef({ retries: 0, accuracy: null as number | null });
  pauseInfoRef.current = { retries: play.retries ?? 0, accuracy: live.stats?.acc ?? null };
  if (scaledRef.current.version !== live.framesVersion || scaledRef.current.scale !== scale) {
    scaledRef.current = { version: live.framesVersion, scale };
    framesRef.current = scaleFrames(live.frames, scale);
  }
  // Everything that moves several times a second travels in refs, so the
  // viewer re-renders only when something it shows as React state changes.
  const framesVersionRef = useRef(0);
  framesVersionRef.current = live.framesVersion * 1000 + Math.round(scale * 100);
  const notesVersionRef = useRef(0);
  notesVersionRef.current = notesVersion;
  const failed = live.end?.reason === "failed";
  // Where the play failed, as soon as it shows: the game's word when it gives
  // one, else the start of the health bar's final empty run (a fail without
  // No Fail or Easy, whose extra lives refill it; health that comes back was
  // an extra life, not a fail).
  const failTimeRef = useRef<number | null>(null);
  const songUrl = map?.song_stream && userId != null && chart?.md5 === map.md5 ? liveSpectateSongUrl(userId, map.md5) : null;
  failTimeRef.current = failed && live.end?.time != null ? live.end.time * scale : healthFailTime(healthRef.current, play.mods);
  const feed = useMemo<ReplayLiveFeed>(
    () => ({
      clockRef,
      pauseInfoRef,
      framesRef,
      framesVersionRef,
      healthRef,
      notesRef,
      notesVersionRef,
      spectatorCount: live.viewers,
      delayMs: DELAY_MS,
      failed,
      failTimeRef,
      songUrl,
    }),
    [live.viewers, failed, songUrl],
  );

  const mods = useMemo(() => (chart ? viewerMods(play, chart) : []), [play, chart]);
  const back = useCallback(() => void navigate({ to: "/player/$username", params: { username: user } }), [navigate, user]);
  // The strip under the stage updates with the game's counts; it reads them
  // from its own store so those updates do not re-render the viewer above it.
  const infoStore = useMemo(() => createInfoStore(), []);

  const inferRandom = play.client === "stable" && play.mods.includes("RD") && chart != null;
  useEffect(() => {
    if (!inferRandom || !chart) return;
    const map = inferRandomColumnMap(chart.beatmap.notes, framesRef.current, chart.beatmap.keyCount);
    if (!map) return;
    const key = map.join(",");
    if (key === columnMapRef.current) return;
    columnMapRef.current = key;
    notesRef.current = chart.beatmap.notes.map((note) => ({ ...note, column: map[note.column] ?? note.column }));
    setNotesVersion((value) => value + 1);
  }, [inferRandom, chart, live.framesVersion]);

  const name = live.username ?? user;
  // Built once per chart: the frames after it reach the stage through the feed.
  const replay = useMemo<ServerReplay | null>(() => {
    if (!chart) return null;
    const frames = framesRef.current.length > 0 ? [...framesRef.current] : [{ time: 0, keyState: 0 }];
    return {
      header: { playerName: name, gameMode: 3, totalScore: 0, maxCombo: 0, count300: 0, count100: 0, count50: 0, countGeki: 0, countKatu: 0, countMiss: 0, isPerfect: false },
      frames,
      lifeBarFrames: [],
      keyCount: chart.beatmap.keyCount,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart]);
  // The info strip under the stage shows the game's own counts.
  const stats = live.end ?? live.stats;
  const infoReplay = useMemo<ServerReplay | null>(() => {
    if (!replay) return null;
    const hits = stats?.hits;
    return {
      ...replay,
      header: {
        ...replay.header,
        countGeki: hits?.perfect ?? 0,
        count300: hits?.great ?? 0,
        countKatu: hits?.good ?? 0,
        count100: hits?.ok ?? 0,
        count50: hits?.meh ?? 0,
        countMiss: hits?.miss ?? 0,
        maxCombo: stats?.max_combo ?? 0,
      },
    };
  }, [replay, stats]);

  const infoSlot = useMemo(() => (chart ? (
    <div className="mx-auto w-full max-w-[1200px] px-3 sm:max-w-none sm:px-0">
      <LiveInfoStrip
        store={infoStore}
        score={null}
        beatmap={chart.beatmap}
        stars={null}
        mods={mods}
        fallbackBeatmapsetId={chart.beatmapsetId ?? undefined}
        judgeAsLazer={play.client === "lazer"}
        onClear={back}
        playerProfile={userId != null ? { id: userId, username: name } : null}
        live
      />
    </div>
  ) : null), [chart, infoStore, mods, play.client, back, userId, name]);

  if (!replay || !chart || !infoReplay) {
    return (
      <LiveIdle
        live={live}
        user={user}
        message={chartFailed ? t`The chart for this play could not be loaded.` : map?.chart === "none" ? t`Waiting for the chart` : t`Loading`}
      />
    );
  }

  const sourceIsLazer = play.client === "lazer";
  infoStore.set(infoReplay);
  return (
    <MemoReplayViewer
      replay={replay}
      beatmap={chart.beatmap}
      beatmapFileContent={chart.content}
      scoreInfo={null}
      replayMods={mods}
      judgeAsLazer={sourceIsLazer}
      sourceIsLazer={sourceIsLazer}
      fallbackBeatmapsetId={chart.beatmapsetId ?? undefined}
      presenceKey={null}
      ownerUserId={userId}
      shareUrl={null}
      onClear={back}
      live={feed}
    >
      {infoSlot}
    </MemoReplayViewer>
  );
}

interface InfoStore {
  get: () => ServerReplay | null;
  set: (value: ServerReplay) => void;
  subscribe: (listener: () => void) => () => void;
}

function createInfoStore(): InfoStore {
  let value: ServerReplay | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      // After the render that produced it; a listener may not update mid-render.
      queueMicrotask(() => listeners.forEach((listener) => listener()));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function LiveInfoStrip(props: { store: InfoStore } & Omit<Parameters<typeof ReplayInfo>[0], "replay">) {
  const { store, ...rest } = props;
  const replay = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (!replay) return null;
  return <ReplayInfo replay={replay} {...rest} />;
}

function healthFailTime(health: Array<{ time: number; health: number }>, mods: string[]): number | null {
  if (mods.includes("NF") || mods.includes("EZ") || health.length === 0 || health[health.length - 1].health > 0.001) return null;
  let i = health.length - 1;
  while (i > 0 && health[i - 1].health <= 0.001) i -= 1;
  return health[i].time;
}
