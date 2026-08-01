// osu! storyboard model shared by the parser, the timeline evaluator, and the
// replay renderer. Storyboards are authored in the 640x480 osu! coordinate
// space; widescreen storyboards may place sprites in x [-107, 747].

export const STORYBOARD_WIDTH = 640;
export const STORYBOARD_HEIGHT = 480;

// Layer indices follow the .osb encoding: 0 Background, 1 Fail, 2 Pass,
// 3 Foreground, 4 Overlay. Overlay renders above gameplay.
export const SB_LAYER_BACKGROUND = 0;
export const SB_LAYER_FAIL = 1;
export const SB_LAYER_PASS = 2;
export const SB_LAYER_FOREGROUND = 3;
export const SB_LAYER_OVERLAY = 4;
export const SB_LAYER_COUNT = 5;

// Animation channels a command can drive. Compound commands split: M -> X+Y,
// S -> ScaleX+ScaleY, V -> ScaleX+ScaleY, C -> R+G+B.
export const SB_CHAN_X = 0;
export const SB_CHAN_Y = 1;
export const SB_CHAN_SCALE_X = 2;
export const SB_CHAN_SCALE_Y = 3;
export const SB_CHAN_ROTATION = 4;
export const SB_CHAN_ALPHA = 5;
export const SB_CHAN_COLOR_R = 6;
export const SB_CHAN_COLOR_G = 7;
export const SB_CHAN_COLOR_B = 8;
export const SB_CHANNEL_COUNT = 9;

// Segments are packed [startTime, endTime, easingId, fromValue, toValue].
export const SB_SEG_STRIDE = 5;

// P command intervals.
export const SB_PARAM_FLIP_H = 0;
export const SB_PARAM_FLIP_V = 1;
export const SB_PARAM_ADDITIVE = 2;
export type StoryboardParamType = 0 | 1 | 2;

export interface StoryboardParamInterval {
  type: StoryboardParamType;
  start: number;
  end: number;
}

export interface CompiledStoryboardSprite {
  layer: number;
  // Anchor fractions derived from the declared origin (0..1 in both axes).
  originX: number;
  originY: number;
  // Normalized (lowercased, forward-slash) path of the sprite image.
  filePath: string;
  // Animation frame paths in frame order; null for plain sprites.
  framePaths: string[] | null;
  frameDelay: number;
  frameLoopForever: boolean;
  defaultX: number;
  defaultY: number;
  // Lifetime: earliest command start to latest command end.
  startTime: number;
  endTime: number;
  // Declaration order across the merged .osb + .osu storyboard; higher orders
  // draw above lower ones within the same layer.
  order: number;
  // Command segments grouped by channel, each channel sorted by start time.
  seg: Float32Array;
  // Segment index boundaries per channel: segments of channel c live at
  // indices [chanStart[c], chanStart[c + 1]).
  chanStart: Int32Array;
  params: StoryboardParamInterval[] | null;
}

export interface StoryboardParseResult {
  sprites: CompiledStoryboardSprite[];
  // Every image path the storyboard can reference (animation frames expanded),
  // normalized. Used to select which archive files to bundle/load.
  referencedPaths: Set<string>;
  segmentCount: number;
  droppedSegments: number;
  sampleCount: number;
  videoCount: number;
  triggerCount: number;
  // Order value the next parsed storyboard fragment should start at, so .osu
  // elements stack above .osb ones within the same layer.
  nextOrder: number;
}

// Everything the replay renderer needs to draw a storyboard.
export interface ReplayStoryboardData {
  sprites: CompiledStoryboardSprite[];
  // Normalized image path -> object URL (or same-origin URL) for textures.
  imageUrls: Map<string, string>;
  widescreen: boolean;
  // Map background to draw beneath the storyboard when the storyboard does
  // not use the background image itself; null hides it (osu! behavior).
  backgroundImageUrl: string | null;
}
