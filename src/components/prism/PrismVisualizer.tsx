import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Loader2, Pause, Play, Search, Volume2, VolumeX } from "lucide-react";
import { explainPrism, type PrismExplanation, type PrismExplainSection } from "#dan/prism/explain";
import type { PrismPattern } from "#dan/prism/workload";
import { parseManiaBeatmap } from "#dan/beatmap-parser";
import { getBeatmapFile } from "../../lib/osu";
import { getBeatmapAudioUrl } from "../../lib/audio-url";
import { fetchLiveMapSearch, loadLiveMapSearchEntry, type LiveMapSearchEntry } from "../../lib/live-backend";
import { readReplayVolume, subscribeReplayVolume } from "../../lib/replay-preferences";
import { getReplaySkinProfile, listSkinAssetFrames, type ReplaySkinImageAsset } from "../../lib/replay-skin";
import { useReplaySkinSettings } from "../../lib/use-replay-skin-settings";
import { SegmentedControl } from "../ui/SegmentedControl";
import { starRatingColor } from "../ui/StarRating";
import { emptySearchParams, entryDiffs, searchPickerMaps } from "../maps/UserCollectionEditor";
import { mapCoverUrl } from "../maps/SearchCard";

/*
 * The Prism article's Visualizer tab: a chart scrolled the way Prism reads
 * it. Each note on the playfield takes the colour of the pattern its row is
 * filed under, and the readout beside it is the section at the hit line. The
 * graph under them is every section's demand across the song, stacked by the
 * patterns carrying it, and seeks on click or drag. Everything is computed in
 * the browser from the .osu (prism/explain.ts), at the chosen rate.
 */

export interface PrismVisualizerProps {
  beatmapId: number | null;
  rate: number;
  onChange: (next: { beatmapId: number | null; rate: number }) => void;
}

type Group = "chordstream" | "bracket" | "jack" | "ln";

// Note colours by the pattern a row is filed under. Single notes (Stream)
// count toward Chordstream like the skillset does, so they share its hue.
const NOTE_COLOR: Record<PrismPattern, string> = {
  stream: "#f2c899",
  chordstream: "#ffa24a",
  bracket: "#b77cff",
  jack: "#ff5d6c",
  chordjack: "#ff5d6c",
  ln: "#4fd1c5",
  technical: "#9a93a6",
  speed: "#9a93a6",
};
const GROUP_COLOR: Record<Group, string> = { chordstream: "#ffa24a", bracket: "#b77cff", jack: "#ff5d6c", ln: "#4fd1c5" };
const GROUPS: Group[] = ["chordstream", "bracket", "jack", "ln"];
const MASH_COLOR = "#e8e4ef";
const SECTION_MS = 500;
const RATES = [0.75, 1, 1.5] as const;
const SPEEDS = [0.1, 0.25, 0.5, 1] as const;
// osu!lazer's scroll: at scroll speed S a note crosses the playfield in
// 11485 / S ms of real time. The visualizer keeps its own scroll speed,
// slower than people play at, since the point is to read the colours.
const LAZER_SCROLL_TIME_MS = 11485;
const SCROLL_STORAGE_KEY = "mania-hub-prism-visualizer-scroll";
const DEFAULT_SCROLL = 18;
const FIELD_HEIGHT = 520;
const HIT_FROM_BOTTOM = 40;
const KEY_FILTER = ["6k", "7k", "8k"];

// Well-played ranked 7K charts, one per kind of pattern, to start from.
const EXAMPLES: Array<{ beatmapId: number; label: string }> = [
  { beatmapId: 646681, label: "MANIERA" },
  { beatmapId: 3797369, label: "Materialize Anything" },
  { beatmapId: 831204, label: "The Limit Does Not Exist" },
  { beatmapId: 421369, label: "FREEDOM DiVE" },
  { beatmapId: 1920630, label: "Kawaki Wo Ameku" },
];

/** A beatmap id from a pasted id or osu! / site link. */
export function parseBeatmapInput(text: string): number | null {
  const value = text.trim();
  if (/^\d{1,9}$/.test(value)) return Number(value);
  const patterns = [/[#/](?:mania|osu|taiko|fruits)\/(\d{1,9})/, /\/b(?:eatmaps)?\/(\d{1,9})/, /[?&]map=(\d{1,9})/];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match) return Number(match[1]);
  }
  return null;
}

function readScroll(): number {
  if (typeof window === "undefined") return DEFAULT_SCROLL;
  const stored = Number(window.localStorage.getItem(SCROLL_STORAGE_KEY));
  return Number.isFinite(stored) && stored >= 1 ? Math.min(40, Math.round(stored)) : DEFAULT_SCROLL;
}

function groupShares(section: PrismExplainSection): Record<Group, number> {
  const s = section.shares;
  const raw = { chordstream: s.stream + s.chordstream, bracket: s.bracket, jack: s.jack + s.chordjack, ln: s.ln };
  const total = raw.chordstream + raw.bracket + raw.jack + raw.ln;
  return total > 0
    ? { chordstream: raw.chordstream / total, bracket: raw.bracket / total, jack: raw.jack / total, ln: raw.ln / total }
    : { chordstream: 0, bracket: 0, jack: 0, ln: 0 };
}

/** A section reads LN when its hold share reaches the line at which a chart
 *  gets an LN number; otherwise the pattern carrying most of its work. */
function mainGroup(section: PrismExplainSection, lnLine: number): Group {
  if (section.holdShare >= lnLine) return "ln";
  const shares = groupShares(section);
  return GROUPS.reduce((best, group) => (shares[group] > shares[best] ? group : best), "chordstream" as Group);
}

function formatSongTime(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

interface Loaded {
  beatmapId: number;
  title: string;
  version: string;
  explanation: PrismExplanation;
  /** The song, or null when the chart names none or its set is unknown. */
  audioUrl: string | null;
}

export function PrismVisualizer({ beatmapId, rate, onChange }: PrismVisualizerProps) {
  const { t } = useLingui();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [scrollSpeed, setScrollSpeed] = useState(readScroll);
  const changeScroll = (delta: number) => {
    const next = Math.max(1, Math.min(40, scrollSpeed + delta));
    setScrollSpeed(next);
    window.localStorage.setItem(SCROLL_STORAGE_KEY, String(next));
  };
  // Played ms at the hit line; the ref drives drawing, the state the readout.
  const positionRef = useRef(0);
  const [position, setPosition] = useState(0);
  const textRef = useRef<Map<number, string>>(new Map());

  useEffect(() => {
    if (!beatmapId) { setLoaded(null); setStatus("idle"); return; }
    let cancelled = false;
    setStatus("loading");
    setError(null);
    setPlaying(false);
    (async () => {
      try {
        let text = textRef.current.get(beatmapId);
        if (!text) {
          const result = await getBeatmapFile({ data: { beatmapId } });
          text = result.content;
          if (!text?.trim()) throw new Error("empty");
          textRef.current.set(beatmapId, text);
        }
        const map = parseManiaBeatmap(text);
        const explanation = explainPrism(map, { rate });
        if (cancelled) return;
        if (!explanation) {
          setLoaded(null);
          setStatus("error");
          setError(t`Prism rates 6K, 7K and 8K charts. This one is ${map.keyCount}K.`);
          return;
        }
        positionRef.current = Math.min(positionRef.current, explanation.length);
        setPosition(positionRef.current);
        const beatmapsetId = map.beatmapsetId ?? (await loadLiveMapSearchEntry(beatmapId).catch(() => null))?.beatmapsetId ?? null;
        if (cancelled) return;
        const audioUrl = beatmapsetId && map.audioFilename ? getBeatmapAudioUrl(beatmapsetId, map.audioFilename) : null;
        setLoaded({ beatmapId, title: [map.artist, map.title].filter(Boolean).join(" - "), version: map.version, explanation, audioUrl });
        setStatus("idle");
      } catch {
        if (cancelled) return;
        setLoaded(null);
        setStatus("error");
        setError(t`That chart could not be loaded.`);
      }
    })();
    return () => { cancelled = true; };
  }, [beatmapId, rate, t]);

  const pick = (id: number) => {
    positionRef.current = 0;
    setPosition(0);
    onChange({ beatmapId: id, rate });
  };

  // The song plays at the chart's rate times the playback speed, pitch kept.
  // Song seconds map to played ms as (song - origin) / rate.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [volume, setVolume] = useState(readReplayVolume);
  const [muted, setMuted] = useState(false);
  useEffect(() => subscribeReplayVolume(setVolume), []);
  const audioUrl = loaded?.audioUrl ?? null;
  useEffect(() => {
    if (!audioUrl) { audioRef.current = null; return; }
    const audio = new Audio();
    audio.preload = "auto";
    audio.preservesPitch = true;
    audio.src = audioUrl;
    audioRef.current = audio;
    return () => { audio.pause(); audio.removeAttribute("src"); audio.load(); if (audioRef.current === audio) audioRef.current = null; };
  }, [audioUrl]);
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.playbackRate = Math.max(0.0625, rate * speed);
  }, [audioUrl, rate, speed]);
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.volume = muted ? 0 : volume;
  }, [audioUrl, volume, muted]);
  const songSeconds = useCallback((ms: number) => loaded ? (loaded.explanation.origin + ms * loaded.explanation.rate) / 1000 : 0, [loaded]);

  const seek = useCallback((ms: number) => {
    const length = loaded?.explanation.length ?? 0;
    positionRef.current = Math.max(0, Math.min(length, ms));
    setPosition(positionRef.current);
    const audio = audioRef.current;
    if (audio && audio.readyState >= 1) audio.currentTime = songSeconds(positionRef.current);
  }, [loaded, songSeconds]);

  // Playback runs on the frame clock, eased toward the song's clock: the
  // audio element reports its time in coarse steps, and following it
  // directly makes the notes stutter. The clock waits while the song starts.
  useEffect(() => {
    if (!playing || !loaded) return;
    let frame = 0, last = performance.now(), lastUi = 0;
    const audio = audioRef.current;
    let audioState: "starting" | "on" | "off" = audio ? "starting" : "off";
    if (audio) {
      audio.playbackRate = Math.max(0.0625, rate * speed);
      audio.currentTime = songSeconds(positionRef.current);
      audio.play().then(() => { audioState = "on"; }).catch(() => { audioState = "off"; });
    }
    const tick = (now: number) => {
      const elapsed = Math.min(100, now - last);
      last = now;
      let next = positionRef.current;
      if (audioState === "on" && audio && !audio.paused && audio.readyState >= 2) {
        next += elapsed * speed;
        const heard = (audio.currentTime * 1000 - loaded.explanation.origin) / loaded.explanation.rate;
        const drift = heard - next;
        next = Math.abs(drift) > 150 ? heard : next + drift * 0.05;
      } else if (audioState === "off") {
        next += elapsed * speed;
      }
      if (next >= loaded.explanation.length) {
        positionRef.current = loaded.explanation.length;
        setPosition(positionRef.current);
        setPlaying(false);
        return;
      }
      positionRef.current = next;
      if (now - lastUi > 50) { lastUi = now; setPosition(next); }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); audio?.pause(); };
  }, [playing, loaded, speed, rate, songSeconds]);

  const mashedCount = useMemo(() => loaded?.explanation.sections.filter((s) => s.mash?.taken).length ?? 0, [loaded]);
  const legend: Array<[string, string]> = [
    [t`Chordstream`, GROUP_COLOR.chordstream],
    [t`Bracket`, GROUP_COLOR.bracket],
    [t`Jack`, GROUP_COLOR.jack],
    [t`LN`, GROUP_COLOR.ln],
    ...(mashedCount > 0 ? [[t`Mashed`, MASH_COLOR] as [string, string]] : []),
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <MapPicker onPick={pick} />
        <SegmentedControl
          id="prism-visualizer-rate"
          value={String(rate)}
          options={RATES.map((value) => ({ value: String(value), label: `${value}x` }))}
          onChange={(value) => onChange({ beatmapId, rate: Number(value) })}
        />
      </div>

      {!beatmapId ? (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-osu-f1">
          <Trans>Try:</Trans>
          {EXAMPLES.map((example) => (
            <button
              key={example.beatmapId}
              type="button"
              onClick={() => pick(example.beatmapId)}
              className="cursor-pointer rounded-md bg-osu-b4 px-2.5 py-1 text-[12px] text-osu-l2 hover:brightness-110"
            >
              {example.label}
            </button>
          ))}
        </div>
      ) : null}

      {status === "loading" ? (
        <div className="flex items-center gap-2 text-[13px] text-osu-f1"><Loader2 className="h-4 w-4 animate-spin" /><Trans>Loading chart</Trans></div>
      ) : null}
      {status === "error" && error ? <div className="text-[13px] text-rose-300">{error}</div> : null}

      {loaded ? (
        <>
          <div className="min-w-0 pt-1">
            <div className="truncate text-[18px] font-semibold text-white">{loaded.title}</div>
            <div className="mt-0.5 truncate text-[12px] text-osu-f1">
              {loaded.version} <span className="mx-1.5 inline-block h-3 w-px translate-y-0.5 bg-white/15" /> {loaded.explanation.keyCount}K
              <span className="mx-1.5 inline-block h-3 w-px translate-y-0.5 bg-white/15" /> OD {loaded.explanation.od}
              <span className="mx-1.5 inline-block h-3 w-px translate-y-0.5 bg-white/15" /> {loaded.explanation.rate}x
            </div>
          </div>

          <div className="grid grid-cols-1 gap-8 md:grid-cols-[auto_minmax(0,1fr)]">
            <div className="flex justify-center md:justify-start">
              <Playfield explanation={loaded.explanation} positionRef={positionRef} position={position} pxPerMs={((FIELD_HEIGHT - HIT_FROM_BOTTOM) * scrollSpeed) / LAZER_SCROLL_TIME_MS / speed} playing={playing} />
            </div>
            <div className="flex min-w-0 flex-col gap-8">
              <SectionReadout explanation={loaded.explanation} position={position} />
              <ChartValues values={loaded.explanation.values} />
            </div>
          </div>
          <div className="space-y-2 pt-1">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (positionRef.current >= loaded.explanation.length) seek(0);
                  setPlaying((value) => !value);
                }}
                className="grid h-9 w-9 cursor-pointer place-items-center rounded-md bg-osu-b4 text-white hover:brightness-110"
                aria-label={playing ? t`Pause` : t`Play`}
              >
                {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </button>
              {loaded.audioUrl ? (
                <button
                  type="button"
                  onClick={() => setMuted((value) => !value)}
                  className="grid h-9 w-9 cursor-pointer place-items-center rounded-md bg-osu-b4 text-white hover:brightness-110"
                  aria-label={muted ? t`Unmute` : t`Mute`}
                >
                  {muted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                </button>
              ) : null}
              <span className="px-2 text-[13px] tabular-nums text-osu-l2">
                {formatSongTime(loaded.explanation.origin + position * loaded.explanation.rate)}
                <span className="text-osu-f1"> / {formatSongTime(loaded.explanation.origin + loaded.explanation.length * loaded.explanation.rate)}</span>
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <SegmentedControl
                  id="prism-visualizer-speed"
                  value={String(speed)}
                  options={SPEEDS.map((value) => ({ value: String(value), label: `${value}x` }))}
                  onChange={(value) => setSpeed(Number(value) as (typeof SPEEDS)[number])}
                />
                <div className="flex items-center gap-1 rounded-lg bg-osu-b4/50 p-0.5">
                  <span className="px-2 text-[11px] font-semibold text-osu-f1"><Trans>Scroll</Trans></span>
                  <button type="button" onClick={() => changeScroll(-1)} className="h-7 w-7 cursor-pointer rounded-md text-[14px] font-semibold text-osu-l2 hover:bg-osu-b3/60" aria-label={t`Slower scroll`}>-</button>
                  <span className="w-6 text-center text-[12px] font-semibold tabular-nums text-white">{scrollSpeed}</span>
                  <button type="button" onClick={() => changeScroll(1)} className="h-7 w-7 cursor-pointer rounded-md text-[14px] font-semibold text-osu-l2 hover:bg-osu-b3/60" aria-label={t`Faster scroll`}>+</button>
                </div>
              </div>
            </div>
            <SongGraph explanation={loaded.explanation} position={position} onSeek={seek} />
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {legend.map(([label, color]) => (
                <span key={label} className="flex items-center gap-1.5 text-[11px] text-osu-f1">
                  <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: color }} />
                  {label}
                </span>
              ))}
            </div>
          </div>

        </>
      ) : null}
    </div>
  );
}

/**
 * The viewer's replay skin note art per lane (tap and LN head, first frame),
 * when their skin has any; an empty map draws the flat notes.
 */
function useSkinNotes(keyCount: number): Map<number, { tap?: HTMLImageElement; head?: HTMLImageElement }> {
  const settings = useReplaySkinSettings();
  const profile = useMemo(() => getReplaySkinProfile(settings, keyCount), [settings, keyCount]);
  const [notes, setNotes] = useState<Map<number, { tap?: HTMLImageElement; head?: HTMLImageElement }>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    const first = (asset: ReplaySkinImageAsset | undefined) => (asset?.src ? listSkinAssetFrames(asset)[0]?.src ?? asset.src : null);
    const load = (src: string | null) => (src ? new Promise<HTMLImageElement | undefined>((resolve) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => resolve(undefined);
      image.src = src;
    }) : Promise.resolve(undefined));
    Promise.all(Array.from({ length: keyCount }, async (_, lane) => {
      const column = profile.assets.columns[lane] ?? {};
      const tap = await load(first(column.tap));
      const head = (await load(first(column.lnHead))) ?? tap;
      return [lane, { tap, head }] as const;
    })).then((entries) => {
      if (cancelled) return;
      setNotes(new Map(entries.filter(([, art]) => art.tap || art.head)));
    });
    return () => { cancelled = true; };
  }, [profile, keyCount]);
  return notes;
}

// Skin art recoloured to a pattern: its shading kept as grey, multiplied by
// the colour, clipped back to the art. Cached per texture and colour.
const tintCache = new Map<string, HTMLCanvasElement>();
function tintNote(image: HTMLImageElement, color: string): CanvasImageSource {
  const key = `${image.src}|${color}`;
  const cached = tintCache.get(key);
  if (cached) return cached;
  const width = image.naturalWidth, height = image.naturalHeight;
  if (width < 1 || height < 1) return image;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return image;
  ctx.filter = "grayscale(1) brightness(1.25)";
  ctx.drawImage(image, 0, 0);
  ctx.filter = "none";
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(image, 0, 0);
  tintCache.set(key, canvas);
  return canvas;
}

function useCanvasSize(ref: React.RefObject<HTMLCanvasElement | null>, height: number) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => setWidth(canvas.clientWidth));
    observer.observe(canvas);
    setWidth(canvas.clientWidth);
    return () => observer.disconnect();
  }, [ref]);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !width) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }, [ref, width, height]);
  return width;
}

function Playfield({ explanation, positionRef, position, pxPerMs, playing }: {
  explanation: PrismExplanation;
  positionRef: React.RefObject<number>;
  position: number;
  pxPerMs: number;
  playing: boolean;
}) {
  const { t } = useLingui();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const labels = useMemo<Record<Group, string>>(() => ({ chordstream: t`Chordstream`, bracket: t`Bracket`, jack: t`Jack`, ln: t`LN` }), [t]);
  const bySlot = useMemo(() => new Map(explanation.sections.map((s) => [s.start, s])), [explanation]);
  const laneWidth = explanation.keyCount >= 8 ? 40 : 46;
  const width = laneWidth * explanation.keyCount;
  const measured = useCanvasSize(canvasRef, FIELD_HEIGHT);
  const skin = useSkinNotes(explanation.keyCount);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !measured) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0e0b13";
    ctx.fillRect(0, 0, width, FIELD_HEIGHT);
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    for (let lane = 1; lane < explanation.keyCount; lane += 1) ctx.fillRect(lane * laneWidth, 0, 1, FIELD_HEIGHT);
    const hit = FIELD_HEIGHT - HIT_FROM_BOTTOM;
    const now = positionRef.current ?? 0;
    const ahead = hit / pxPerMs, behind = HIT_FROM_BOTTOM / pxPerMs;
    const noteHeight = Math.max(6, Math.min(14, 10 * (pxPerMs / 0.9)));
    // Lanes struck in the last moment light their receptor, held lanes stay lit.
    const lit: Array<string | null> = new Array(explanation.keyCount).fill(null);
    for (const note of explanation.notes) {
      if (note.end < now - behind || note.start > now + ahead) continue;
      const x = note.lane * laneWidth + 3, w = laneWidth - 6;
      const hold = note.end > note.start;
      if (note.start <= now && (now - note.start < 70 || (hold && note.end > now))) lit[note.lane] = NOTE_COLOR[note.pattern];
      // Like the game: a tap leaves at the hit line, a held note's head stays on it.
      if (note.start <= now && (!hold || note.end <= now)) continue;
      const y = note.start <= now ? hit : hit - (note.start - now) * pxPerMs;
      ctx.fillStyle = NOTE_COLOR[note.pattern];
      if (hold) {
        const yEnd = hit - (note.end - now) * pxPerMs;
        ctx.globalAlpha = 0.35;
        ctx.fillRect(x + 6, yEnd, w - 12, y - yEnd);
        ctx.globalAlpha = 1;
      }
      const art = skin.get(note.lane)?.[hold ? "head" : "tap"];
      if (art) {
        const h = Math.min(w * 1.2, w * (art.naturalHeight / Math.max(1, art.naturalWidth)));
        ctx.drawImage(tintNote(art, NOTE_COLOR[note.pattern]), x, y - h, w, h);
        continue;
      }
      ctx.beginPath();
      ctx.roundRect(x, y - noteHeight, w, noteHeight, 3);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillRect(0, hit, width, 2);
    for (let lane = 0; lane < explanation.keyCount; lane += 1) {
      ctx.fillStyle = lit[lane] ?? "#231d2b";
      ctx.globalAlpha = lit[lane] ? 0.85 : 1;
      ctx.beginPath();
      ctx.roundRect(lane * laneWidth + 5, hit + 8, laneWidth - 10, HIT_FROM_BOTTOM - 16, 4);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // The section at the hit line, fixed mid-field where combo sits in game,
    // so the eye has one place to rest while the notes pass.
    const section = heldSection(bySlot, Math.floor(now / SECTION_MS) * SECTION_MS);
    if (section) {
      const reading = blendedReading(bySlot, now);
      const main = mainGroup(section, explanation.lnLine);
      const y = FIELD_HEIGHT * 0.4;
      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(0,0,0,0.85)";
      ctx.shadowBlur = 10;
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.font = "700 40px Torus, sans-serif";
      ctx.fillText(reading.demand.toFixed(1), width / 2, y);
      ctx.fillStyle = GROUP_COLOR[main];
      ctx.font = "700 13px Torus, sans-serif";
      ctx.fillText(labels[main].toUpperCase(), width / 2, y + 24);
      ctx.shadowBlur = 0;
      ctx.shadowColor = "transparent";
    }
  }, [explanation, laneWidth, measured, pxPerMs, positionRef, width, skin, bySlot, labels]);

  useEffect(() => { draw(); }, [draw, position]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const loop = () => { draw(); frame = requestAnimationFrame(loop); };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [draw, playing]);

  return <canvas ref={canvasRef} style={{ width, height: FIELD_HEIGHT }} className="shrink-0 rounded-md" />;
}

const GRAPH_HEIGHT = 120;
const AXIS_HEIGHT = 18;

/** Every section's demand across the song, stacked by the patterns carrying
 *  it; a mashed section shows its mashed demand in white over the rest. */
function SongGraph({ explanation, position, onSeek }: { explanation: PrismExplanation; position: number; onSeek: (ms: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const height = GRAPH_HEIGHT + AXIS_HEIGHT;
  const width = useCanvasSize(canvasRef, height);
  const dragging = useRef(false);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !width) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const length = Math.max(1, explanation.length);
    const peak = explanation.sections.reduce((max, s) => Math.max(max, s.demand), 0) || 1;
    const xOf = (ms: number) => (ms / length) * width;
    const barWidth = Math.max(1, xOf(SECTION_MS) + 0.5);
    const usable = GRAPH_HEIGHT - 6;
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(0, GRAPH_HEIGHT - 1, width, 1);
    for (const section of explanation.sections) {
      const x = xOf(section.start);
      const total = (section.demand / peak) * usable;
      const shares = section.holdShare >= explanation.lnLine ? { chordstream: 0, bracket: 0, jack: 0, ln: 1 } : groupShares(section);
      const mashed = section.mash?.taken ?? false;
      ctx.globalAlpha = mashed ? 0.3 : 0.9;
      let y = GRAPH_HEIGHT - 1;
      for (const group of GROUPS) {
        const h = total * shares[group];
        if (h <= 0) continue;
        ctx.fillStyle = GROUP_COLOR[group];
        ctx.fillRect(x, y - h, barWidth, h);
        y -= h;
      }
      if (mashed && section.mash) {
        const m = (section.mash.demand / peak) * usable;
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = MASH_COLOR;
        ctx.fillRect(x, GRAPH_HEIGHT - 1 - m, barWidth, m);
      }
    }
    ctx.globalAlpha = 1;
    // Song time along the bottom, every 30 seconds on short charts, every minute on long ones.
    const songLength = length * explanation.rate;
    const step = songLength <= 150_000 ? 30_000 : 60_000;
    ctx.font = "11px Torus, sans-serif";
    ctx.fillStyle = "#8f879c";
    ctx.textBaseline = "alphabetic";
    for (let song = Math.ceil(explanation.origin / step) * step; song <= explanation.origin + songLength; song += step) {
      const x = xOf((song - explanation.origin) / explanation.rate);
      const label = `${Math.floor(song / 60000)}:${String(Math.floor((song % 60000) / 1000)).padStart(2, "0")}`;
      ctx.textAlign = x < 16 ? "left" : x > width - 16 ? "right" : "center";
      ctx.fillText(label, x, height - 3);
    }
    if (hover != null) {
      const x = xOf(hover);
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.fillRect(x, 0, 1, GRAPH_HEIGHT);
      ctx.fillStyle = "#d8d2e2";
      ctx.textAlign = x > width - 60 ? "right" : "left";
      ctx.fillText(formatSongTime(explanation.origin + hover * explanation.rate), x + (x > width - 60 ? -5 : 5), 11);
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(xOf(position) - 1, 0, 2, GRAPH_HEIGHT);
  }, [explanation, position, width, height, hover]);

  const msAt = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * explanation.length;
  };

  return (
    <canvas
      ref={canvasRef}
      style={{ height }}
      className="block w-full cursor-pointer touch-none"
      onPointerDown={(event) => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); onSeek(msAt(event)); }}
      onPointerMove={(event) => { const ms = msAt(event); setHover(ms); if (dragging.current) onSeek(ms); }}
      onPointerUp={() => { dragging.current = false; }}
      onPointerLeave={() => setHover(null)}
    />
  );
}

interface Reading { demand: number; shares: Record<Group, number>; technical: number; speed: number }

const EMPTY_READING: Reading = { demand: 0, shares: { chordstream: 0, bracket: 0, jack: 0, ln: 0 }, technical: 0, speed: 0 };

function readingOf(section: PrismExplainSection | undefined): Reading {
  if (!section) return EMPTY_READING;
  return { demand: section.demand, shares: groupShares(section), technical: Math.min(1, section.shares.technical), speed: Math.min(1, section.shares.speed) };
}

// A half second with no new press (a long hold, a short break) keeps the
// reading of the last section before it, up to this long.
const HOLD_READING_MS = 2000;

function heldSection(bySlot: Map<number, PrismExplainSection>, slot: number): PrismExplainSection | undefined {
  for (let back = 0; back <= HOLD_READING_MS; back += SECTION_MS) {
    const section = bySlot.get(slot - back);
    if (section) return section;
  }
  return undefined;
}

/** The readout at a position, eased between the two nearest sections'
 *  middles so it glides through a passage instead of stepping every half
 *  second. */
function blendedReading(bySlot: Map<number, PrismExplainSection>, position: number): Reading {
  const half = SECTION_MS / 2;
  const before = Math.floor((position - half) / SECTION_MS) * SECTION_MS;
  const t = Math.max(0, Math.min(1, (position - (before + half)) / SECTION_MS));
  const f = t * t * (3 - 2 * t);
  const a = readingOf(heldSection(bySlot, before)), b = readingOf(heldSection(bySlot, before + SECTION_MS) ?? heldSection(bySlot, before));
  const mix = (x: number, y: number) => x + (y - x) * f;
  return {
    demand: mix(a.demand, b.demand),
    shares: { chordstream: mix(a.shares.chordstream, b.shares.chordstream), bracket: mix(a.shares.bracket, b.shares.bracket), jack: mix(a.shares.jack, b.shares.jack), ln: mix(a.shares.ln, b.shares.ln) },
    technical: mix(a.technical, b.technical),
    speed: mix(a.speed, b.speed),
  };
}

function SectionReadout({ explanation, position }: { explanation: PrismExplanation; position: number }) {
  const { t } = useLingui();
  const labels: Record<Group, string> = { chordstream: t`Chordstream`, bracket: t`Bracket`, jack: t`Jack`, ln: t`LN` };
  const bySlot = useMemo(() => new Map(explanation.sections.map((s) => [s.start, s])), [explanation]);
  const slot = Math.floor(position / SECTION_MS) * SECTION_MS;
  const songTime = formatSongTime(explanation.origin + slot * explanation.rate);
  const section = heldSection(bySlot, slot);
  const reading = blendedReading(bySlot, position);
  // The share of the chart's half seconds this one is harder than.
  const harderThan = section ? explanation.sections.filter((s) => s.demand < section.demand).length / explanation.sections.length : null;
  const main = section ? mainGroup(section, explanation.lnLine) : null;
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-f1">{songTime}</div>
      <div className="mt-1.5 flex items-baseline gap-3">
        <span className="text-[34px] font-semibold leading-none tabular-nums text-white">{section ? reading.demand.toFixed(1) : "-"}</span>
        <span className="text-[13px] text-osu-f1">
          {section && harderThan != null ? <Trans>demand, harder than {Math.round(harderThan * 100)}% of the chart</Trans> : <Trans>No notes</Trans>}
        </span>
      </div>
      <div className="mt-5 flex h-2 overflow-hidden rounded-full bg-white/[0.06]">
        {GROUPS.map((group) => (
          <div key={group} className="h-full" style={{ width: `${((section ? reading.shares[group] : 0) * 100).toFixed(1)}%`, backgroundColor: GROUP_COLOR[group] }} />
        ))}
      </div>
      <div className="mt-2.5 flex min-h-5 flex-wrap gap-x-4 gap-y-1 text-[13px]">
        {section
          ? GROUPS.filter((group) => reading.shares[group] >= 0.03).map((group) => (
            <span key={group} className={`flex items-center gap-1.5 ${group === main ? "font-semibold text-white" : "text-osu-l2"}`}>
              <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: GROUP_COLOR[group] }} />
              {labels[group]}
              <span className="font-normal tabular-nums text-osu-f1">{Math.round(reading.shares[group] * 100)}%</span>
            </span>
          ))
          : null}
      </div>
      {/* Delay and Technical are not patterns a row is filed under: they count
          a share of the same work again, on top of the pattern it went to. */}
      <div className="mt-5 space-y-2">
        {([[t`Delay`, section ? reading.speed : 0], [t`Technical`, section ? reading.technical : 0]] as Array<[string, number]>).map(([label, value]) => (
          <div key={label} className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-[13px] text-osu-l2">{label}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div className="h-full rounded-full bg-[#9a93a6]" style={{ width: `${(value * 100).toFixed(1)}%` }} />
            </div>
            <span className="w-10 shrink-0 text-right text-[13px] tabular-nums text-osu-f1">{Math.round(value * 100)}%</span>
          </div>
        ))}
      </div>
      {section && section.holdShare > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-osu-f1">
          <span><Trans>Holds: {Math.round(section.holdShare * 100)}% of notes</Trans></span>
          <span className="inline-block h-3 w-px bg-white/15" />
          <span><Trans>Finger held under {Math.round(section.heldPressShare * 100)}% of presses</Trans></span>
        </div>
      ) : null}
      {section?.mash ? (
        <div className="mt-4 border-t border-white/[0.07] pt-3 text-[13px] leading-relaxed text-osu-l2">
          <div>
            <Trans>
              Mashed: {Math.round(section.mash.accuracy * 100)}% accuracy at demand {section.mash.demand.toFixed(1)}
            </Trans>
          </div>
          <div className="text-[12px] text-osu-f1">
            {section.mash.taken
              ? <Trans>Prism rates this section as mashed, since that scores higher than playing it as written.</Trans>
              : <Trans>Playing it as written scores higher, so Prism rates it as written.</Trans>}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChartValues({ values }: { values: Record<string, number> }) {
  const { t } = useLingui();
  const rows: Array<[string, number | undefined]> = [
    [t`Overall`, values.Overall],
    [t`Chordstream`, values.Jumpstream],
    [t`Bracket`, values.Handstream],
    [t`Jack`, values.Chordjack],
    [t`Technical`, values.Technical],
    [t`Delay`, values.Speed],
  ];
  return (
    <div className="mt-auto grid grid-cols-3 gap-x-6 gap-y-4 border-t border-white/[0.07] pt-5">
      {rows.map(([label, value], index) => (
        <div key={label}>
          <div className="text-[11px] text-osu-f1">{label}</div>
          <div className={`text-[22px] font-semibold tabular-nums ${index === 0 ? "text-white" : "text-osu-l2"}`}>{value != null ? value.toFixed(2) : "-"}</div>
        </div>
      ))}
    </div>
  );
}

/** 6K-8K charts in the map catalog, by song, artist or mapper, or an id or link. */
async function searchCharts(query: string): Promise<LiveMapSearchEntry[]> {
  const entries = parseBeatmapInput(query) != null
    ? await searchPickerMaps(query)
    : (await fetchLiveMapSearch({ ...emptySearchParams(query), keys: KEY_FILTER })).items;
  return entries
    .map((entry) => ({ ...entry, diffs: entryDiffs(entry).filter((diff) => diff.keyCount >= 6 && diff.keyCount <= 8) }))
    .filter((entry) => entry.diffs.length > 0);
}

function MapPicker({ onPick }: { onPick: (beatmapId: number) => void }) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LiveMapSearchEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) { setResults(null); setSearching(false); return; }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      searchCharts(trimmed)
        .then((items) => { if (!cancelled) setResults(items); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!boxRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  const choose = (beatmapId: number) => {
    onPick(beatmapId);
    setQuery("");
    setResults(null);
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative min-w-0 flex-1">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const id = parseBeatmapInput(query);
          const first = results?.[0]?.diffs?.[0];
          if (id) choose(id);
          else if (first) choose(first.beatmapId);
        }}
      >
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-osu-f1" aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={t`Song, artist, mapper, or a beatmap link`}
          className="h-10 w-full rounded-lg bg-osu-b4 pl-9 pr-9 text-[13px] text-white outline-none ring-1 ring-white/5 placeholder:text-osu-f1 focus:ring-osu-pink/40"
        />
        {searching ? <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-osu-f1" aria-hidden="true" /> : null}
      </form>
      {open && results ? (
        <div className="absolute inset-x-0 top-full z-30 mt-1.5 max-h-[420px] overflow-y-auto rounded-lg bg-osu-b4 p-1.5 shadow-xl ring-1 ring-white/5">
          {results.length === 0 && !searching ? (
            <div className="px-3 py-6 text-center text-[12px] text-osu-f1"><Trans>No 6K-8K charts matched that</Trans></div>
          ) : null}
          {results.map((entry) => (
            <div key={entry.beatmapsetId || entry.beatmapId} className="flex gap-3 rounded-md p-2 hover:bg-white/[0.03]">
              <div className="h-11 w-16 shrink-0 rounded bg-osu-b3/60 bg-cover bg-center" style={{ backgroundImage: `url(${mapCoverUrl(entry)})` }} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-white">{entry.title}</div>
                <div className="truncate text-[11px] text-osu-f1">
                  {entry.artist} <span className="mx-1.5 inline-block h-2.5 w-px translate-y-0.5 bg-white/15" /> {entry.creator}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {(entry.diffs ?? []).map((diff) => (
                    <button
                      key={diff.beatmapId}
                      type="button"
                      onClick={() => choose(diff.beatmapId)}
                      className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-full bg-osu-b3/80 py-0.5 pl-1 pr-2 text-[11px] text-osu-l2 hover:brightness-125"
                    >
                      <span
                        className="rounded-full px-1.5 text-[10.5px] font-bold"
                        // osu!'s badge: dark text, yellow from 6.5 stars where the colour turns dark.
                        style={{ background: starRatingColor(diff.stars), color: diff.stars >= 6.5 ? "hsl(45, 100%, 70%)" : "hsl(200, 10%, 10%)" }}
                      >
                        {diff.keyCount}K {diff.stars.toFixed(2)}
                      </span>
                      <span className="truncate">{diff.version}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default PrismVisualizer;
