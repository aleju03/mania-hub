import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { bindableHighwayKey, HighwayJudge, highwayStockNotes, HighwayTiming, readHighwayKeys, saveHighwayKeys, type HighwayJudgement } from "../../lib/highway-play";
import type { HighwayChart, HighwayPlay } from "../../lib/supporter-profile-themes";
import { buildHighwayChart, HIGHWAY_SECTION_MS } from "./use-highway-chart";

/* Playing the Note highway on a profile: press your keys for its keymode and
   the notes coming down answer them. The first press starts it (the highway
   stops lighting its keys by itself and judges yours instead); a few seconds
   without a press, or Escape, hands it back. It plays what the highway is
   already showing: the owner's chart, or the highway's own notes, which this
   hands the backdrop as a chart from the start so that nothing changes when
   a game begins. The renderer owns the clock (HighwayPlay.epoch), and each
   press is judged after taking off the player's own average lateness
   (HighwayTiming), which it keeps learning. Keys and that timing are per
   browser (lib/highway-play.ts). */

/* Seconds without a press before the highway plays itself again. */
const IDLE_S = 6;

export interface HighwayHud {
  judgement: HighwayJudgement | null;
  combo: number;
  accuracy: number;
  /** Changes with every judgement, to restart its pop. */
  tick: number;
}

const EMPTY_HUD: HighwayHud = { judgement: null, combo: 0, accuracy: 100, tick: 0 };

function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

export function useHighwayPlay({ active, lanes, chart }: {
  /** The highway is this page's backdrop. */
  active: boolean;
  lanes: number;
  /** The chart the owner shows, if any. */
  chart: HighwayChart | null;
}) {
  const play = useMemo<HighwayPlay>(() => ({ on: false, epoch: null, down: [], pressedAt: [], hitAt: [], hitUntil: [] }), []);
  const [playing, setPlaying] = useState(false);
  const [hud, setHud] = useState<HighwayHud>(EMPTY_HUD);
  const [keys, setKeys] = useState<string[]>([]);
  /* Rebinding: the keys pressed so far, left to right; null when not rebinding. */
  const [binding, setBinding] = useState<string[] | null>(null);
  const bindingRef = useRef(binding);
  bindingRef.current = binding;

  useEffect(() => {
    setKeys(readHighwayKeys(lanes));
  }, [lanes]);

  const stock = useMemo(() => (active ? buildHighwayChart(highwayStockNotes(lanes, HIGHWAY_SECTION_MS), lanes, 0, `stock:${lanes}`) : null), [active, lanes]);
  const played = chart ?? stock;
  const timing = useRef<HighwayTiming | null>(null);

  const session = useRef<{ judge: HighwayJudge; lastPress: number } | null>(null);

  const stop = useCallback(() => {
    if (session.current) timing.current?.save();
    session.current = null;
    play.on = false;
    play.down.fill(false);
    setPlaying(false);
  }, [play]);

  // a new chart or keymode ends the game in progress
  useEffect(() => stop, [played, lanes, active, stop]);

  useEffect(() => {
    if (!active || !played || keys.length !== lanes) return;
    const seconds = (stamp: number) => (play.epoch === null ? null : (stamp - play.epoch) / 1000);
    // the chart's loop time a moment means to this player: their usual lateness taken off
    const loopMs = (sec: number) => (((sec * 1000 - (timing.current?.offset ?? 0)) % played.period) + played.period) % played.period;
    let tick = 0;
    const publish = (judgement: HighwayJudgement) => {
      const stats = session.current?.judge.stats;
      if (!stats) return;
      tick += 1;
      setHud({ judgement, combo: stats.combo, accuracy: stats.accuracy, tick });
    };

    const onDown = (event: KeyboardEvent) => {
      const bound = bindingRef.current;
      if (bound) {
        // rebinding takes every key until it has one per lane
        event.preventDefault();
        if (event.code === "Escape") {
          setBinding(null);
          return;
        }
        if (event.repeat || !bindableHighwayKey(event.code) || bound.includes(event.code)) return;
        const next = [...bound, event.code];
        if (next.length < lanes) {
          setBinding(next);
          return;
        }
        saveHighwayKeys(lanes, next);
        setKeys(next);
        setBinding(null);
        return;
      }
      if (event.code === "Escape" && session.current) {
        stop();
        return;
      }
      const lane = keys.indexOf(event.code);
      if (lane < 0 || event.ctrlKey || event.metaKey || event.altKey || typingInto(event.target)) return;
      // only while the playfield is on screen
      if (window.scrollY > window.innerHeight * 0.6) return;
      const sec = seconds(event.timeStamp);
      if (sec === null) return;
      if (!session.current) {
        // the space bar still scrolls the page until a game is on
        if (event.code === "Space") return;
        for (const list of [play.pressedAt, play.hitAt, play.hitUntil]) {
          list.length = lanes;
          list.fill(-1);
        }
        play.down.length = lanes;
        play.down.fill(false);
        play.on = true;
        timing.current ??= new HighwayTiming();
        session.current = { judge: new HighwayJudge(played, loopMs(sec)), lastPress: sec };
        setHud(EMPTY_HUD);
        setPlaying(true);
      }
      event.preventDefault();
      if (event.repeat || play.down[lane]) return;
      play.down[lane] = true;
      play.pressedAt[lane] = sec;
      session.current.lastPress = sec;
      const hit = session.current.judge.press(lane, loopMs(sec));
      if (hit) {
        play.hitAt[lane] = sec;
        play.hitUntil[lane] = session.current.judge.hitUntil[lane];
        timing.current?.learn(hit.error);
        publish(hit.judgement);
      }
    };
    const onUp = (event: KeyboardEvent) => {
      const lane = keys.indexOf(event.code);
      if (lane >= 0) play.down[lane] = false;
    };
    const onBlur = () => play.down.fill(false);

    let frame = 0;
    const loop = () => {
      frame = requestAnimationFrame(loop);
      const game = session.current;
      const sec = seconds(performance.now());
      if (!game || sec === null) return;
      const { misses, wrapped } = game.judge.advance(loopMs(sec));
      if (wrapped) play.hitUntil.fill(-1);
      if (misses > 0) publish("MISS");
      if (sec - game.lastPress > IDLE_S) stop();
    };
    frame = requestAnimationFrame(loop);

    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [active, played, keys, lanes, play, stop]);

  return {
    /** For the backdrop: null where there is no highway. */
    play: active ? play : null,
    /** The chart the backdrop should draw: the owner's, or the highway's own notes. */
    chart: played,
    playing,
    hud,
    keys,
    binding,
    startBinding: useCallback(() => {
      stop();
      setBinding([]);
    }, [stop]),
  };
}
