import { useEffect, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { explainPrism, type PrismExplanation } from "#dan/prism/explain";
import { parseManiaBeatmap } from "#dan/beatmap-parser";
import { getBeatmapFile } from "../../lib/osu";
import { loadReplayRenderer } from "../../lib/replay-renderer-loader";
import { parseCachedManiaBeatmap } from "../../lib/parsed-beatmap-cache";
import { useReplaySkinSettings } from "../../lib/use-replay-skin-settings";
import type { ManiaNote } from "../../lib/beatmap-parser";
import type { ReplayFrame } from "../../lib/types";

/*
 * A passage mashed, shown in the site's replay viewer: the presses are the
 * ones Prism picked at the chart's own OD, played back as a replay with the
 * viewer's skin and judged as the game would. The OD slider judges the same
 * presses again at another OD.
 */

// Notes scroll in for this long before the passage starts.
const LEAD_MS = 900;
// How long each mash press holds its keys down.
const PRESS_MS = 45;
const SCROLL_SPEED = 22;
// The renderer's judgement counts, MAX first, in osu!'s colours.
const JUDGEMENTS: Array<[string, string]> = [
  ["MAX", "#d9f5ff"], ["300", "#ffd166"], ["200", "#7ee08a"], ["100", "#5aa9ff"], ["50", "#b08cff"], ["MISS", "#ff5d6c"],
];

interface Passage {
  keyCount: number;
  od: number;
  notes: ManiaNote[];
  frames: ReplayFrame[];
}

function buildPassage(explanation: PrismExplanation, notes: ManiaNote[], fromMs: number, toMs: number): Passage {
  const shift = (time: number) => time - fromMs + LEAD_MS;
  const presses = (explanation.mash ?? [])
    .map((press) => ({ time: explanation.origin + press.time, lanes: press.lanes }))
    .filter((press) => press.time >= fromMs - 20 && press.time <= toMs + 20)
    .sort((a, b) => a.time - b.time);
  // Only the notes the presses cover, and no press from before the passage:
  // with the notes ahead of it cut, it would take the first notes early.
  const first = presses[0]?.time ?? fromMs, last = presses[presses.length - 1]?.time ?? toMs;
  const passageNotes = notes
    .filter((note) => note.time >= Math.max(fromMs, first - 100) && note.time <= Math.min(toMs, last + 100))
    .map((note) => ({ ...note, time: shift(note.time), endTime: shift(note.endTime) }));
  const frames: ReplayFrame[] = [{ time: 0, keyState: 0 }];
  for (const press of presses) {
    frames.push({ time: shift(press.time), keyState: press.lanes });
    frames.push({ time: shift(press.time) + PRESS_MS, keyState: 0 });
  }
  return { keyCount: explanation.keyCount, od: explanation.od, notes: passageNotes, frames };
}

type Renderer = InstanceType<Awaited<ReturnType<typeof loadReplayRenderer>>["ManiaReplayRenderer"]>;

export function MashOdExplorer({ beatmapId, fromMs, toMs }: { beatmapId: number; fromMs: number; toMs: number }) {
  const { t } = useLingui();
  const skinSettings = useReplaySkinSettings();
  const [passage, setPassage] = useState<Passage | null>(null);
  const [failed, setFailed] = useState(false);
  const [od, setOd] = useState<number | null>(null);
  const current = od ?? passage?.od ?? 0;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const skinRef = useRef(skinSettings);
  skinRef.current = skinSettings;
  // What the replay has judged so far, read off the renderer so the numbers match the stage.
  const [stats, setStats] = useState<{ counts: number[]; accuracy: number; totalJudgements: number } | null>(null);
  const odRef = useRef(current);
  odRef.current = current;

  useEffect(() => {
    let cancelled = false;
    getBeatmapFile({ data: { beatmapId } })
      .then((result) => {
        if (cancelled) return;
        const explanation = explainPrism(parseManiaBeatmap(result.content));
        if (!explanation) { setFailed(true); return; }
        const beatmap = parseCachedManiaBeatmap(beatmapId, result.content);
        setPassage(buildPassage(explanation, beatmap.notes, fromMs, toMs));
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [beatmapId, fromMs, toMs]);

  // The replay loops while it is on screen.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !passage) return;
    let cancelled = false, visible = false;
    let timer = 0;
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      const renderer = rendererRef.current;
      if (!renderer) return;
      if (visible) renderer.play(); else renderer.pause();
    });
    void loadReplayRenderer().then(({ ManiaReplayRenderer }) => {
      if (cancelled) return;
      const renderer = new ManiaReplayRenderer(canvas, passage.frames, passage.keyCount, passage.notes, {
        od: odRef.current,
        transparentBackground: true,
        showJudgements: true,
        showCombo: true,
        hideHud: true,
        barePlayfield: true,
        showHealthBar: false,
        liveStats: true,
        skinSettings: skinRef.current,
      });
      renderer.setScrollSpeed(SCROLL_SPEED);
      rendererRef.current = renderer;
      void renderer.ready().then(() => {
        if (cancelled) return;
        observer.observe(canvas);
        timer = window.setInterval(() => {
          if (!visible) return;
          // A new loop starts with nothing judged: keep the last numbers until it has some.
          const live = renderer.getLiveStats();
          if (live.totalJudgements > 0) setStats(live);
          if (renderer.time < renderer.duration) return;
          renderer.seek(0);
          renderer.play();
        }, 100);
      });
    });
    return () => {
      cancelled = true;
      observer.disconnect();
      window.clearInterval(timer);
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, [passage]);

  useEffect(() => {
    rendererRef.current?.setSkinSettings(skinSettings);
  }, [skinSettings]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !passage) return;
    // Judged again at the new OD from where it is, so the replay carries on.
    const time = renderer.time;
    const playing = renderer.isPlaying;
    renderer.setPreviewData(passage.frames, passage.keyCount, passage.notes, { od: current });
    renderer.seek(time);
    if (playing) renderer.play();
    const live = renderer.getLiveStats();
    if (live.totalJudgements > 0) setStats(live);
  }, [passage, current]);

  if (failed) return null;
  const window300 = Math.max(1, 64 - 3 * current);
  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-stretch">
      <div className="relative h-[420px] w-[300px] shrink-0 overflow-hidden rounded-md bg-[#0e0b13]">
        <canvas ref={canvasRef} className="h-full w-full" aria-label={t`A passage mashed on a steady beat at OD ${current}`} />
      </div>
      {/* Hidden until the chart loads: before that there is no OD to put the slider at. */}
      <div className={`flex w-full min-w-0 flex-1 flex-col justify-center gap-5 transition-opacity ${passage ? "" : "pointer-events-none opacity-0"}`}>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-f1"><Trans>Accuracy</Trans></div>
          <div className="text-[40px] font-semibold leading-tight tabular-nums text-white">
            {stats && stats.totalJudgements > 0 ? `${stats.accuracy.toFixed(2)}%` : "-"}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1 text-[13px] tabular-nums sm:grid-cols-6">
            {JUDGEMENTS.map(([label, color], i) => (
              <span key={label} className="flex items-baseline gap-1.5 whitespace-nowrap">
                <span className="text-[11px] font-semibold" style={{ color }}>{label}</span>
                <span className="text-osu-l2">{stats?.counts[i + 1] ?? 0}</span>
              </span>
            ))}
          </div>
        </div>
        <div>
          <div className="flex items-baseline justify-between text-[12px] text-osu-f1">
            <span className="text-[14px] font-semibold text-white">OD {current}</span>
            <span><Trans>300 window ±{window300}ms</Trans></span>
          </div>
          <OdSlider value={current} onChange={setOd} label={t`Overall difficulty`} />
        </div>
      </div>
    </div>
  );
}

const OD_MAX = 10;
const OD_STEP = 0.5;

/** OD 0 to 10 in half steps, dragged or keyed. The OD 5 tick is marked: Prism checks mashing only below it. */
function OdSlider({ value, onChange, label }: { value: number; onChange: (od: number) => void; label: string }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const at = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return value;
    const share = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round((share * OD_MAX) / OD_STEP) * OD_STEP;
  };
  const set = (od: number) => { const next = Math.max(0, Math.min(OD_MAX, od)); if (next !== value) onChange(next); };
  const share = (value / OD_MAX) * 100;
  return (
    <div className="mt-3 select-none px-2">
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={OD_MAX}
        aria-valuenow={value}
        className="group relative h-8 cursor-pointer touch-none outline-none"
        onPointerDown={(event) => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); set(at(event.clientX)); }}
        onPointerMove={(event) => { if (dragging.current) set(at(event.clientX)); }}
        onPointerUp={() => { dragging.current = false; }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowDown") { event.preventDefault(); set(value - OD_STEP); }
          else if (event.key === "ArrowRight" || event.key === "ArrowUp") { event.preventDefault(); set(value + OD_STEP); }
          else if (event.key === "Home") { event.preventDefault(); set(0); }
          else if (event.key === "End") { event.preventDefault(); set(OD_MAX); }
        }}
      >
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-white/[0.08]" />
        <div className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-osu-pink" style={{ width: `${share}%` }} />
        <div
          className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-osu-pink bg-white shadow transition-transform group-hover:scale-110 group-focus-visible:ring-2 group-focus-visible:ring-white/40"
          style={{ left: `${share}%` }}
        />
      </div>
      <div className="relative mt-1 h-4 text-[11px] tabular-nums">
        {Array.from({ length: OD_MAX + 1 }, (_, od) => (
          <button
            key={od}
            type="button"
            tabIndex={-1}
            onClick={() => set(od)}
            className={`absolute -translate-x-1/2 cursor-pointer ${od === 5 ? "font-semibold text-osu-l2" : "text-osu-f1"} hover:text-white`}
            style={{ left: `${(od / OD_MAX) * 100}%` }}
          >
            {od}
          </button>
        ))}
      </div>
    </div>
  );
}
