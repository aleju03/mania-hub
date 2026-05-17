import type { ReplayHitCounts } from "./replay-validation";
import type { ReplayOverlaySettings } from "./replay-overlays";
import type { ReplaySkinSettings } from "./replay-skin";
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
}

export interface ReplayRendererLike {
  readonly duration: number;
  readonly displayDuration: number;
  readonly time: number;
  readonly isPlaying: boolean;
  destroy: () => void;
  pause: () => void;
  play: () => void;
  resize: () => void;
  renderFrameAt?: (timeMs: number) => void | Promise<void>;
  seek: (timeMs: number) => void;
  setBackgroundDim: (value: number) => void;
  setBackgroundImage: (image: HTMLImageElement | null) => void;
  setExternalClock: (cb: (() => { time: number; stalled: boolean } | null) | null) => void;
  setScrollSpeed: (value: number) => void;
  setShowInputOverlay: (value: boolean) => void;
  setInputOverlayOptions: (options: { only?: boolean; color?: string; keyHistory?: boolean }) => void;
  setOverlaySettings: (settings: ReplayOverlaySettings) => void;
  setSkinSettings: (settings: ReplaySkinSettings) => void;
  setSpeed: (value: number) => void;
  ready: () => Promise<void>;
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
