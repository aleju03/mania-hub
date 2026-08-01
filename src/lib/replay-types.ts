import type { ReplayHitCounts } from "./replay-validation";
import type { ReplayHitsoundTrigger } from "./replay-hitsounds";
import type { ReplayOverlayId, ReplayOverlaySettings } from "./replay-overlays";
import type { ReplaySkinSettings } from "./replay-skin";
import type { ReplayStoryboardData } from "./storyboard/types";
import type { ReplayFrame, ReplayLifeBarFrame, OsuScore } from "./types";

export interface ServerReplay {
  header: {
    playerName: string;
    gameMode: number;
    gameVersion?: number;
    beatmapHash?: string;
    modsUsed?: number;
    totalScore: number;
    maxCombo: number;
    count300: number;
    count100: number;
    count50: number;
    countGeki: number;
    countKatu: number;
    countMiss: number;
    isPerfect: boolean;
  };
  frames: ReplayFrame[];
  lifeBarFrames: ReplayLifeBarFrame[];
  keyCount: number;
  stableScrollSpeedScale?: number;
}

/** Running totals at the playback clock, for chrome drawn outside the canvas
 *  (the side-by-side comparison's stats column). Only populated on renderers
 *  created with `liveStats`; everything here is what the HUD would be showing
 *  at this instant, so the two never disagree. */
export interface ReplayLiveStats {
  /** Judgment-indexed like the renderer: [_, MAX, 300, 200, 100, 50, miss]. */
  counts: number[];
  totalJudgements: number;
  /** Displayed accuracy percent (0-100) under the run's own ruleset. */
  accuracy: number;
  combo: number;
  maxCombo: number;
  score: number;
  pp: number;
  /** SS pp for the whole chart with these mods; constant for the run. */
  maxPp: number;
  /** Unstable rate over every hit so far, not the HUD's rolling window. */
  unstableRate: number;
  /** Hits landed before / after the note. */
  early: number;
  late: number;
  /** Mean hit offset in ms; negative is early. */
  meanOffsetMs: number;
}

export interface ReplayRendererLike {
  readonly duration: number;
  readonly displayDuration: number;
  readonly time: number;
  readonly isPlaying: boolean;
  destroy: () => void;
  getFailTime?: () => number | null;
  getMissTimes?: () => number[];
  /** Client point is on the bare playfield, clear of every draggable overlay. */
  isPlayfieldClickPoint?: (clientX: number, clientY: number) => boolean;
  /** Which overlay sits under a client point, for the right-click menu. */
  getOverlayIdAtClientPoint?: (clientX: number, clientY: number) => ReplayOverlayId | null;
  /** False on phones or with the HUD hidden, where overlays are not editable. */
  canEditOverlays?: () => boolean;
  /**
   * Client point is busy with overlay editing, so bottom chrome must stay down:
   * an edit gesture, the pointer on an overlay, or an overlay below it inside
   * the chrome's band (`chromeBandPx`, measured up from the stage bottom).
   */
  isOverlayEditPoint?: (clientX: number, clientY: number, chromeBandPx?: number) => boolean;
  pause: () => void;
  play: () => void;
  resize: () => void;
  renderFrameAt?: (timeMs: number) => void | Promise<void>;
  seek: (timeMs: number) => void;
  setBackgroundDim: (value: number) => void;
  setBlackPlayfield: (value: boolean) => void;
  setBackgroundImage: (image: HTMLImageElement | null) => void;
  setExternalClock: (cb: (() => { time: number; stalled: boolean } | null) | null) => void;
  setScrollSpeed: (value: number) => void;
  setShowInputOverlay: (value: boolean) => void;
  setInputOverlayOptions: (options: { only?: boolean; color?: string; keyHistory?: boolean }) => void;
  setOverlaySettings: (settings: ReplayOverlaySettings) => void;
  setSkinSettings: (settings: ReplaySkinSettings) => void;
  setSpeed: (value: number) => void;
  setStoryboard?: (data: ReplayStoryboardData | null) => void;
  storyboardReady?: () => Promise<void>;
  setLeaderboard?: (entries: { name: string; score: number; combo: number; rank?: number }[], playerName: string) => void;
  setLeaderboardVisible?: (visible: boolean) => void;
  setSpectatorCount?: (count: number) => void;
  setHitsoundTrigger?: (trigger: ReplayHitsoundTrigger | null) => void;
  ready: () => Promise<void>;
  getLiveStats?: () => ReplayLiveStats;
  getDiagnostics?: () => { rendererBackend: string; judgementBuildMs: number | null };
}

export function getScoreExpectedCounts(score: OsuScore | null, replay: ServerReplay): ReplayHitCounts {
  const stats = score?.statistics ?? {};

  return {
    countGeki: stats.count_geki ?? stats.perfect ?? replay.header.countGeki,
    count300: stats.count_300 ?? stats.great ?? replay.header.count300,
    countKatu: stats.count_katu ?? stats.good ?? replay.header.countKatu,
    count100: stats.count_100 ?? stats.ok ?? replay.header.count100,
    count50: stats.count_50 ?? stats.meh ?? replay.header.count50,
    countMiss: stats.count_miss ?? stats.miss ?? replay.header.countMiss,
  };
}
