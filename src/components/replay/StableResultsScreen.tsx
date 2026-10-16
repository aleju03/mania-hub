import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import type { OskRankingArt } from "#/lib/replay-skin-import";

// osu!stable's ranking screen for an osu!mania play. Stable lays it out in a
// 768-tall space whose width follows the window, an SD texture covering one
// unit per pixel (@2x art half that); positions are the osu! wiki's skinning
// reference where it gives them and measured off the game otherwise.

export type StableGrade = "XH" | "X" | "SH" | "S" | "A" | "B" | "C" | "D";

export interface StableResultsScore {
  totalScore: number;
  counts: { geki: number; c300: number; katu: number; c100: number; c50: number; miss: number };
  maxCombo: number;
  /** 0 to 1. */
  accuracy: number;
  grade: StableGrade;
  perfect: boolean;
  /** Acronyms, as the play's mods are listed elsewhere. */
  mods: string[];
  playerName: string;
  playedAt: string | null;
  /** The HP line under the panel; empty draws an empty graph. */
  lifeBar: { time: number; health: number }[];
  /** Map-time hit offsets (negative is early), for the graph's tooltip. */
  hitOffsets: number[];
}

export interface StableResultsBeatmap {
  title: string;
  artist: string;
  version: string;
  creator: string;
}

const VIRTUAL_H = 768;
// Stable's outro, timed off an in-game replay with the hold shortened and
// the playfield fade softened to taste: the playfield fades out and the map's
// background eases up to a dim from wherever the play's dim had it, holds,
// the screen cuts to black, stays black a moment, and the ranking fades in
// linearly.
const PLAYFIELD_FADE_MS = 400;
const OUTRO_BRIGHTNESS = 0.4;
const OUTRO_BRIGHTEN_MS = 1500;
const OUTRO_HOLD_MS = 1800;
const FADE_TO_BLACK_MS = 130;
const BLACK_HOLD_MS = 200;
const FADE_IN_MS = 430;
/** When the ranking itself starts fading in; skin art arriving later waits for the next showing. */
export const STABLE_RESULTS_CONTENT_DELAY_MS = OUTRO_HOLD_MS + FADE_TO_BLACK_MS + BLACK_HOLD_MS;
// Narrower than 4:3 the grade would land on the panel; stable never runs
// that narrow, so a portrait screen fits the 4:3 frame by its width.
const MIN_VIRTUAL_W = 1024;

const DEFAULT_ART_BASE = "/images/stable-results";
// The default skin's @2x sizes, so the layout is final before any texture
// arrives.
const DEFAULT_ART_SIZES: Record<string, readonly [number, number]> = {
  "ranking-panel": [1244, 1010],
  "ranking-title": [742, 248],
  "ranking-graph": [634, 304],
  "ranking-accuracy": [384, 116],
  "ranking-maxcombo": [324, 100],
  "ranking-perfect": [956, 300],
  "ranking-XH": [734, 890],
  "ranking-X": [736, 890],
  "ranking-SH": [682, 838],
  "ranking-S": [682, 836],
  "ranking-A": [738, 844],
  "ranking-B": [716, 836],
  "ranking-C": [670, 838],
  "ranking-D": [722, 836],
  "pause-replay": [822, 244],
  "mania-hit300g": [376, 182],
  "mania-hit300": [452, 262],
  "mania-hit200": [414, 240],
  "mania-hit100": [364, 232],
  "mania-hit50": [284, 226],
  "mania-hit0": [362, 198],
  "score-0": [66, 92],
  "score-1": [34, 92],
  "score-2": [62, 90],
  "score-3": [62, 92],
  "score-4": [64, 92],
  "score-5": [62, 90],
  "score-6": [68, 92],
  "score-7": [62, 92],
  "score-8": [68, 92],
  "score-9": [68, 90],
  "score-comma": [30, 108],
  "score-dot": [30, 108],
  "score-percent": [108, 92],
  "score-x": [70, 98],
};
// The default mod icons are SD only.
const DEFAULT_MOD_SIZE = [68, 66] as const;

// Stable's selection-mod filenames, in the order the ranking screen stacks
// them from the right. NC and PF stand in for the DT and SD they imply.
const MOD_ELEMENTS: Array<{ acronyms: string[]; element: string }> = [
  { acronyms: ["PF"], element: "perfect" },
  { acronyms: ["SD"], element: "suddendeath" },
  { acronyms: ["EZ"], element: "easy" },
  { acronyms: ["HD"], element: "hidden" },
  { acronyms: ["FI"], element: "fadein" },
  { acronyms: ["HR"], element: "hardrock" },
  { acronyms: ["NC"], element: "nightcore" },
  { acronyms: ["DT"], element: "doubletime" },
  { acronyms: ["FL"], element: "flashlight" },
  { acronyms: ["V2", "SV2"], element: "scorev2" },
  { acronyms: ["NF"], element: "nofail" },
  { acronyms: ["HT"], element: "halftime" },
  { acronyms: ["MR"], element: "mirror" },
  { acronyms: ["RD"], element: "random" },
  ...Array.from({ length: 9 }, (_, index) => ({ acronyms: [`${index + 1}K`], element: `key${index + 1}` })),
  { acronyms: ["CO", "DS", "2P"], element: "keycoop" },
  { acronyms: ["AT", "AU"], element: "autoplay" },
  { acronyms: ["CN"], element: "cinema" },
];

/** The selection-mod element names for a play's mods, in display order. */
export function stableModElements(mods: string[]): string[] {
  const set = new Set(mods.map((mod) => mod.toUpperCase()));
  if (set.has("NC")) set.delete("DT");
  if (set.has("PF")) set.delete("SD");
  return MOD_ELEMENTS
    .filter((entry) => entry.acronyms.some((acronym) => set.has(acronym)))
    .map((entry) => `selection-mod-${entry.element}`);
}

/** Stable's osu!mania grade: SS at 100%, then 95/90/80/70, silver under HD/FL/FI. */
export function stableManiaGrade(accuracy: number, silver: boolean): StableGrade {
  if (accuracy >= 1) return silver ? "XH" : "X";
  if (accuracy > 0.95) return silver ? "SH" : "S";
  if (accuracy > 0.9) return "A";
  if (accuracy > 0.8) return "B";
  if (accuracy > 0.7) return "C";
  return "D";
}

/** Stable's osu!mania accuracy, where MAX and 300 both count full. */
export function stableManiaAccuracy(counts: StableResultsScore["counts"]): number {
  const total = counts.geki + counts.c300 + counts.katu + counts.c100 + counts.c50 + counts.miss;
  if (total <= 0) return 1;
  return (300 * (counts.geki + counts.c300) + 200 * counts.katu + 100 * counts.c100 + 50 * counts.c50) / (300 * total);
}

export function normalizeStableGrade(rank: string | null | undefined): StableGrade | null {
  switch ((rank ?? "").toUpperCase()) {
    case "XH": case "SSH": return "XH";
    case "X": case "SS": return "X";
    case "SH": return "SH";
    case "S": return "S";
    case "A": return "A";
    case "B": return "B";
    case "C": return "C";
    case "D": return "D";
    default: return null;
  }
}

interface Art {
  src: string;
  /** Size in layout units (SD pixels). */
  w: number;
  h: number;
}

function defaultArt(name: string): Art | null {
  if (name.startsWith("selection-mod-")) {
    return { src: `${DEFAULT_ART_BASE}/mods/${name}.png`, w: DEFAULT_MOD_SIZE[0], h: DEFAULT_MOD_SIZE[1] };
  }
  const size = DEFAULT_ART_SIZES[name];
  if (!size) return null;
  const file = name === "mania-hit300g" ? "mania-hit300g-0" : name;
  return { src: `${DEFAULT_ART_BASE}/${file}@2x.png`, w: size[0] / 2, h: size[1] / 2 };
}

// Stable falls back to the default skin one texture at a time, so a skin that
// ships only a panel still gets the default digits and grades around it.
function pickArt(name: string, skin: OskRankingArt | null): Art | null {
  const asset = skin?.images[name];
  if (asset?.src && asset.width && asset.height) {
    const scale = asset.scale && asset.scale > 0 ? asset.scale : 1;
    return { src: asset.src, w: asset.width / scale, h: asset.height / scale };
  }
  return defaultArt(name);
}

/** Warms the browser cache with the default art every play draws. */
export function preloadStableResultsArt(): void {
  if (typeof Image === "undefined") return;
  for (const name of Object.keys(DEFAULT_ART_SIZES)) {
    if (name.startsWith("ranking-") && name.length <= "ranking-XH".length) continue;
    const art = defaultArt(name);
    if (art) new Image().src = art.src;
  }
}

function Sprite({ art, x, y, origin = "top-left", scale = 1, style }: {
  art: Art | null;
  x: number;
  y: number;
  origin?: "top-left" | "top-right" | "centre" | "right";
  scale?: number;
  style?: CSSProperties;
}) {
  if (!art) return null;
  const w = art.w * scale;
  const h = art.h * scale;
  const left = origin === "top-right" || origin === "right" ? x - w : origin === "centre" ? x - w / 2 : x;
  const top = origin === "centre" || origin === "right" ? y - h / 2 : y;
  return (
    <img
      src={art.src}
      alt=""
      draggable={false}
      className="pointer-events-none absolute max-w-none"
      style={{ left, top, width: w, height: h, ...style }}
    />
  );
}

// A number in the score font: each glyph at its own width, ScoreOverlap
// pulling neighbours together. A skin with its own digits keeps to its own
// font: a glyph it lacks (often the x or %) is simply not drawn, never the
// default skin's. The counts hang from their top edge; the score sits on a
// centre line, which is why skins with tall padded digit canvases have no
// visible score in game.
function ScoreText({ text, x, y, scale, skin, overlap, centred = false }: {
  text: string;
  x: number;
  y: number;
  scale: number;
  skin: OskRankingArt | null;
  overlap: number;
  centred?: boolean;
}) {
  const skinFont = Boolean(skin?.images["score-0"]);
  let cursor = x;
  const glyphs: ReactNode[] = [];
  for (const [index, char] of [...text].entries()) {
    const name = char === "." ? "score-dot" : char === "," ? "score-comma" : char === "%" ? "score-percent" : char === "x" ? "score-x" : `score-${char}`;
    const art = skinFont ? pickArt(name, skin?.images[name] ? skin : null) : pickArt(name, null);
    if (!art || (skinFont && !skin?.images[name])) continue;
    glyphs.push(<Sprite key={index} art={art} x={cursor} y={centred ? y - (art.h * scale) / 2 : y} scale={scale} />);
    cursor += (art.w - overlap) * scale;
  }
  return <>{glyphs}</>;
}

// Stable records the HP into the replay every couple of seconds and draws
// the graph through those samples, so dips read as soft Vs rather than one
// spike per miss. Frames denser than that (the per-judgement HP this viewer
// simulates when the .osr carries no graph, which downloaded replays never
// do) are sampled down to that cadence, reading the HP at each sample time.
const LIFE_SAMPLE_INTERVAL_MS = 2500;

function sampleLifeFrames(frames: StableResultsScore["lifeBar"]): StableResultsScore["lifeBar"] {
  if (frames.length < 3) return frames;
  const span = frames[frames.length - 1].time - frames[0].time;
  if (span / (frames.length - 1) >= LIFE_SAMPLE_INTERVAL_MS / 2) return frames;
  const out: StableResultsScore["lifeBar"] = [];
  let index = 0;
  for (let time = frames[0].time; ; time += LIFE_SAMPLE_INTERVAL_MS) {
    const at = Math.min(time, frames[frames.length - 1].time);
    while (index + 1 < frames.length && frames[index + 1].time <= at) index += 1;
    out.push({ time: at, health: frames[index].health });
    if (at >= frames[frames.length - 1].time) break;
  }
  return out;
}

// The ranking-graph box's HP line: lime while above half, red below.
function LifeGraph({ frames: rawFrames, x, y }: { frames: StableResultsScore["lifeBar"]; x: number; y: number }) {
  const W = 301;
  const H = 141;
  const frames = sampleLifeFrames(rawFrames);
  if (frames.length < 2) return null;
  const t0 = frames[0].time;
  const t1 = frames[frames.length - 1].time;
  const span = Math.max(1, t1 - t0);
  const point = (frame: { time: number; health: number }) =>
    [((frame.time - t0) / span) * W, (1 - Math.min(1, Math.max(0, frame.health))) * H] as const;
  const segments: Array<{ color: string; points: string }> = [];
  for (let index = 1; index < frames.length; index += 1) {
    const a = frames[index - 1];
    const b = frames[index];
    const color = (a.health + b.health) / 2 >= 0.5 ? "#a0d440" : "#e83c3c";
    const [ax, ay] = point(a);
    const [bx, by] = point(b);
    const last = segments[segments.length - 1];
    if (last?.color === color) last.points += ` ${bx.toFixed(2)},${by.toFixed(2)}`;
    else segments.push({ color, points: `${ax.toFixed(2)},${ay.toFixed(2)} ${bx.toFixed(2)},${by.toFixed(2)}` });
  }
  return (
    <svg className="pointer-events-none absolute overflow-visible" style={{ left: x, top: y, width: W, height: H }} viewBox={`0 0 ${W} ${H}`}>
      {segments.map((segment, index) => (
        <polyline key={index} points={segment.points} fill="none" stroke={segment.color} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
      ))}
    </svg>
  );
}

// The graph's hover tooltip, as stable words it: the mean early and late
// error and the unstable rate, in map time (stable does not divide by the
// mods' rate, so DT reads higher than lazer's figure).
function stableHitError(offsets: number[]): { early: string; late: string; unstableRate: string } | null {
  if (offsets.length === 0) return null;
  let early = 0;
  let earlyCount = 0;
  let late = 0;
  let lateCount = 0;
  let sum = 0;
  for (const offset of offsets) {
    sum += offset;
    if (offset < 0) {
      early += offset;
      earlyCount += 1;
    } else {
      late += offset;
      lateCount += 1;
    }
  }
  const mean = sum / offsets.length;
  let variance = 0;
  for (const offset of offsets) variance += (offset - mean) ** 2;
  const unstableRate = Math.sqrt(variance / offsets.length) * 10;
  const signed = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
  return {
    early: signed(earlyCount ? early / earlyCount : 0),
    late: signed(lateCount ? late / lateCount : 0),
    unstableRate: unstableRate.toFixed(2),
  };
}

// The default skin's back button. Stable's own texture is not shipped with
// lazer's legacy resources, so it is drawn here at the game's size.
function DefaultBackButton({ hovered }: { hovered: boolean }) {
  return (
    <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={100} height={43.5} viewBox="0 0 100 43.5">
      <defs>
        <linearGradient id="stable-back-pink" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={hovered ? "#ee46a6" : "#df3391"} />
          <stop offset="1" stopColor={hovered ? "#ff52b0" : "#f0349a"} />
        </linearGradient>
      </defs>
      <polygon points={`0,0 ${hovered ? 100 : 92},0 ${hovered ? 93 : 85},43.5 0,43.5`} fill="url(#stable-back-pink)" />
      <circle cx={13.3} cy={22.4} r={9.4} fill="#fff" />
      <path d="M15.2 17.1 L10 22.4 L15.2 27.7" fill="none" stroke="#df3391" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
      <text x={40.2} y={29.3} fill="#fff" fontFamily="Aller, sans-serif" fontSize={18}>back</text>
    </svg>
  );
}

export function StableResultsScreen({
  score,
  beatmap,
  backgroundUrl,
  startBrightness,
  skinArt,
  onBack,
  onWatchReplay,
}: {
  score: StableResultsScore;
  beatmap: StableResultsBeatmap;
  backgroundUrl: string | null;
  /** The background's brightness during play, held through the outro. */
  startBrightness: number;
  /** The loaded skin's ranking elements; null draws the default skin. */
  skinArt: OskRankingArt | null;
  onBack: () => void;
  onWatchReplay: () => void;
}) {
  const { t } = useLingui();
  const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [phase, setPhase] = useState<"start" | "outro" | "black" | "shown">("start");
  const [gradeReady, setGradeReady] = useState(false);
  const [replayHover, setReplayHover] = useState(false);
  const [backHover, setBackHover] = useState(false);
  const [graphTip, setGraphTip] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => setSize({ w: root.clientWidth, h: root.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setPhase("outro"));
    const black = window.setTimeout(() => setPhase("black"), OUTRO_HOLD_MS);
    const shown = window.setTimeout(() => setPhase("shown"), STABLE_RESULTS_CONTENT_DELAY_MS);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(black);
      window.clearTimeout(shown);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onBack();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onBack]);

  const handleGradeLoad = useCallback(() => setGradeReady(true), []);

  const s = size ? Math.min(size.h / VIRTUAL_H, size.w / MIN_VIRTUAL_W) : 0;
  const VW = s > 0 ? size!.w / s : MIN_VIRTUAL_W;
  const VH = s > 0 ? size!.h / s : VIRTUAL_H;
  // A screen taller than the frame keeps it centred under the top bar.
  const oy = Math.max(0, (VH - VIRTUAL_H) / 2);
  const legacy = (skinArt?.version ?? 2.7) < 2;
  const overlap = skinArt?.scoreOverlap ?? 0;

  const panelTop = legacy ? 74 : 102;
  const labelTop = legacy ? 500 : 480;
  const graph = legacy ? { x: 259, y: 582 } : { x: 259, y: 614 };
  const perfect = legacy ? { x: 320, y: 688 } : { x: 416, y: 688 };
  const gradeY = legacy ? 272 : 320;

  // osu!mania's six judgements, MAX opposite 300 and 100 opposite 200.
  const hitRows: Array<[string, number, string, number]> = [
    ["mania-hit300", score.counts.c300, "mania-hit300g", score.counts.geki],
    ["mania-hit200", score.counts.katu, "mania-hit100", score.counts.c100],
    ["mania-hit50", score.counts.c50, "mania-hit0", score.counts.miss],
  ];
  const ROW_STEP = 97.3;
  const COUNT_SCALE = 1.14;
  const SCORE_SCALE = 1.335;

  const playedOn = score.playedAt ? formatPlayedAt(score.playedAt) : null;
  const hitError = stableHitError(score.hitOffsets);
  const hitErrorLines = hitError
    ? [t`Accuracy:`, t`Error: ${hitError.early}ms - ${hitError.late}ms avg`, t`Unstable Rate: ${hitError.unstableRate}`]
    : null;
  const gradeArt = pickArt(`ranking-${score.grade}`, skinArt);
  // 1.0 skins name the button ranking-replay; later ones use the pause
  // screen's art and stable ignores a ranking-replay they still carry.
  const replayArt = legacy && skinArt?.images["ranking-replay"] ? pickArt("ranking-replay", skinArt) : pickArt("pause-replay", skinArt);
  const backArt = skinArt?.images["menu-back"] ? pickArt("menu-back", skinArt) : null;
  const modArts = stableModElements(score.mods).map((name) => pickArt(name, skinArt));

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 z-[60] overflow-hidden select-none text-white"
      // The stage under this toggles playback on clicks and taps.
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      style={{ fontFamily: "Aller, sans-serif", lineHeight: 1 }}
    >
      {/* The play with its playfield gone: just the map's background. */}
      <div className="pointer-events-none absolute inset-0 bg-black" style={{ opacity: phase === "start" ? 0 : 1, transition: `opacity ${PLAYFIELD_FADE_MS}ms linear` }}>
        {backgroundUrl && (
          <img
            src={backgroundUrl}
            alt=""
            draggable={false}
            className="absolute inset-0 h-full w-full object-cover"
            style={{
              opacity: phase === "start" ? Math.max(0, Math.min(1, startBrightness)) : OUTRO_BRIGHTNESS,
              transition: `opacity ${OUTRO_BRIGHTEN_MS}ms cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
            }}
          />
        )}
      </div>
      <div className="pointer-events-none absolute inset-0 bg-black" style={{ opacity: phase === "black" || phase === "shown" ? 1 : 0, transition: `opacity ${FADE_TO_BLACK_MS}ms linear` }} />
      <div className="absolute inset-0" style={{ opacity: phase === "shown" ? 1 : 0, transition: `opacity ${FADE_IN_MS}ms linear`, pointerEvents: phase === "shown" ? undefined : "none" }}>
      {backgroundUrl && (
        <img src={backgroundUrl} alt="" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full object-cover" />
      )}
      {s > 0 && (
        <div className="absolute left-0 top-0 origin-top-left" style={{ width: VW, height: VH, transform: `scale(${s})` }}>
          <div className="absolute inset-0" style={{ top: oy }}>
            <Sprite art={pickArt("ranking-panel", skinArt)} x={0} y={panelTop} />
            <ScoreText text={String(Math.max(0, Math.round(score.totalScore))).padStart(7, "0")} x={204} y={panelTop + 48.5} scale={SCORE_SCALE} skin={skinArt} overlap={overlap} centred />
            {hitRows.map(([leftArt, leftCount, rightArt, rightCount], row) => (
              <div key={row}>
                <Sprite art={pickArt(leftArt, skinArt)} x={64} y={panelTop + 155.5 + row * ROW_STEP} origin="centre" scale={0.5} />
                <ScoreText text={`${leftCount}x`} x={128.75} y={panelTop + 129.2 + row * ROW_STEP} scale={COUNT_SCALE} skin={skinArt} overlap={overlap} />
                <Sprite art={pickArt(rightArt, skinArt)} x={388} y={panelTop + 155.5 + row * ROW_STEP} origin="centre" scale={0.5} />
                <ScoreText text={`${rightCount}x`} x={452.75} y={panelTop + 129.2 + row * ROW_STEP} scale={COUNT_SCALE} skin={skinArt} overlap={overlap} />
              </div>
            ))}
            <Sprite art={pickArt("ranking-maxcombo", skinArt)} x={8} y={labelTop} />
            <Sprite art={pickArt("ranking-accuracy", skinArt)} x={291} y={labelTop} />
            <ScoreText text={`${score.maxCombo}x`} x={23} y={panelTop + 430.5} scale={COUNT_SCALE} skin={skinArt} overlap={overlap} />
            <ScoreText text={`${(score.accuracy * 100).toFixed(2)}%`} x={314} y={panelTop + 430.5} scale={COUNT_SCALE} skin={skinArt} overlap={overlap} />
            {score.perfect && <Sprite art={pickArt("ranking-perfect", skinArt)} x={perfect.x} y={perfect.y} origin="centre" />}
            <Sprite art={pickArt("ranking-graph", skinArt)} x={graph.x} y={graph.y} />
            <LifeGraph frames={score.lifeBar} x={graph.x + 7} y={graph.y + 7 + (legacy ? 8 : 0)} />
            {hitErrorLines && (
              <div
                className="absolute"
                style={{ left: graph.x + 7, top: graph.y + 7 + (legacy ? 8 : 0), width: 301, height: 141 }}
                onPointerMove={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  setGraphTip({ x: graph.x + 7 + (event.clientX - box.left) / s, y: graph.y + 7 + (legacy ? 8 : 0) + (event.clientY - box.top) / s });
                }}
                onPointerLeave={() => setGraphTip(null)}
              />
            )}

            {gradeArt && (
              <img
                src={gradeArt.src}
                alt={score.grade}
                draggable={false}
                onLoad={handleGradeLoad}
                className="pointer-events-none absolute max-w-none"
                style={{
                  left: VW - 192 - gradeArt.w / 2,
                  top: gradeY - gradeArt.h / 2,
                  width: gradeArt.w,
                  height: gradeArt.h,
                  opacity: gradeReady ? 1 : 0,
                  transform: gradeReady ? "scale(1)" : "scale(1.15)",
                  transition: "opacity 400ms ease-out, transform 400ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                }}
              />
            )}
            {modArts.map((art, index) => art && (
              <Sprite key={index} art={art} x={VW - 32 - index * 32 - art.w / 2} y={416} origin="centre" />
            ))}
            {replayArt && (
              <button
                type="button"
                aria-label={t`Watch replay`}
                className="absolute cursor-pointer border-0 bg-transparent p-0"
                style={{
                  left: VW - replayArt.w,
                  top: 576 - replayArt.h / 2,
                  width: replayArt.w,
                  height: replayArt.h,
                  opacity: replayHover ? 1 : 0.5,
                  transition: "opacity 120ms ease-out",
                }}
                onPointerEnter={() => setReplayHover(true)}
                onPointerLeave={() => setReplayHover(false)}
                onClick={onWatchReplay}
              >
                <img src={replayArt.src} alt="" draggable={false} className="pointer-events-none block h-full w-full max-w-none" />
              </button>
            )}
          </div>

          {/* The top bar keeps to the screen's top edge. */}
          <div className="pointer-events-none absolute left-0 top-0 w-full" style={{ height: 96 + oy, background: "rgba(0, 0, 0, 0.8)" }} />
          <div className="pointer-events-none absolute left-0 top-0 w-full" style={{ top: oy }}>
            <div className="absolute whitespace-nowrap" style={{ left: 5, top: 2, fontSize: 30 }}>
              {`${beatmap.artist} - ${beatmap.title} [${beatmap.version}]`}
            </div>
            <div className="absolute whitespace-nowrap" style={{ left: 5, top: 33.7, fontSize: 22 }}>
              {t`Beatmap by ${beatmap.creator}`}
            </div>
            <div className="absolute whitespace-nowrap" style={{ left: 5, top: 52.7, fontSize: 22 }}>
              {playedOn ? t`Played by ${score.playerName} on ${playedOn}.` : t`Played by ${score.playerName}.`}
            </div>
            <Sprite art={pickArt("ranking-title", skinArt)} x={VW - 32} y={0} origin="top-right" />
          </div>

          {graphTip && hitErrorLines && (
            <div
              className="pointer-events-none absolute whitespace-pre rounded-[3px] px-[5px] py-[3px]"
              style={{ left: graphTip.x + 12, top: oy + graphTip.y + 16, fontSize: 13, lineHeight: 1.25, background: "rgba(0, 0, 0, 0.8)", border: "1px solid rgba(255, 255, 255, 0.35)" }}
            >
              {hitErrorLines.join("\n")}
            </div>
          )}
          <button
            type="button"
            aria-label={t`back`}
            className="absolute left-0 bottom-0 cursor-pointer border-0 bg-transparent p-0"
            style={backArt ? { width: backArt.w, height: backArt.h } : { width: 100, height: 43.5, bottom: 6.5 }}
            onPointerEnter={() => setBackHover(true)}
            onPointerLeave={() => setBackHover(false)}
            onClick={onBack}
          >
            {backArt
              ? <img src={backArt.src} alt="" draggable={false} className="pointer-events-none block h-full w-full max-w-none" style={{ filter: backHover ? "brightness(1.2)" : undefined }} />
              : <DefaultBackButton hovered={backHover} />}
          </button>
        </div>
      )}
      </div>
    </div>
  );
}

// Stable's "10/14/2026 4:26:08 PM", in the viewer's local time.
function formatPlayedAt(value: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date).replace(",", "");
}
