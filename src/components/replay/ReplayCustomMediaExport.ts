// The custom media overlay drawn on the stage itself. The live viewer lays a
// real element over the stage, which a recording of the canvas never sees,
// so an export decodes the media itself and draws it on the stage like any
// other overlay: every frame of a GIF up front, a video one seek per frame.
// The live viewer uses the same source, in live mode, once another overlay is
// stacked above the media: a GIF runs on the wall clock and a video plays on
// its own, drawn whenever it shows a new frame.
// The bytes are fetched first, so a link only works when its site allows
// other pages to read it; a local file always works.
import { Texture } from "pixi.js";
import { loadReplayCustomMediaBlob } from "../../lib/replay-custom-media";
import { hasReplayCustomMediaSource, type ReplayCustomMedia } from "../../lib/replay-overlays";

// Frames are kept at most this big on their long side.
const MAX_FRAME_SIDE = 960;
// What the live viewer lets the file and its decoded frames take, halved on
// phones and other small-memory devices. An export passes its own share of
// the job's budget.
const LIVE_FRAME_BUDGET_BYTES = 128 * 1024 * 1024;
// A video is sampled at this rate; the cache holds what fits the budget.
const VIDEO_SAMPLE_FPS = 30;
// Browsers play a GIF frame that claims no delay at 100 ms.
const MIN_GIF_FRAME_MS = 20;
const DEFAULT_GIF_FRAME_MS = 100;
const SEEK_TIMEOUT_MS = 3000;

function liveCustomMediaFrameBudget(): number {
  const memory = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return memory != null && memory <= 4 ? LIVE_FRAME_BUDGET_BYTES / 2 : LIVE_FRAME_BUDGET_BYTES;
}

export interface ReplayCustomMediaSourceOptions {
  /** Plays on the wall clock for the live viewer instead of being sought by an export. */
  live?: boolean;
  /** Bytes the fetched file and its decoded frames may take together. */
  budgetBytes?: number;
}

interface AnimatedFrame {
  bitmap: ImageBitmap;
  /** When this frame ends, from the start of the loop. */
  endMs: number;
}

export class ReplayCustomMediaExportSource {
  private key = "";
  private loading: Promise<void> | null = null;
  private generation = 0;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private frameTexture: Texture | null = null;
  private frames: AnimatedFrame[] = [];
  private loopMs = 0;
  private video: HTMLVideoElement | null = null;
  private videoUrl: string | null = null;
  private videoCache = new Map<number, ImageBitmap>();
  private videoCacheLimit = 0;
  private drawn = "";
  private naturalAspect: number | null = null;
  private readonly live: boolean;
  private readonly budgetBytes: number;
  private liveStart = 0;

  constructor(options: ReplayCustomMediaSourceOptions = {}) {
    this.live = options.live ?? false;
    this.budgetBytes = Math.max(0, options.budgetBytes ?? liveCustomMediaFrameBudget());
  }

  get texture(): Texture | null {
    return this.frameTexture;
  }

  /** Width over height of the media, once it has loaded. */
  get aspect(): number | null {
    return this.naturalAspect;
  }

  setMedia(media: ReplayCustomMedia | null) {
    const key = media && hasReplayCustomMediaSource(media) ? `${media.kind}|${media.url}|${media.fileId ?? ""}` : "";
    if (key === this.key) return;
    this.key = key;
    this.dispose();
    if (!media || !key) return;
    const generation = this.generation;
    this.loading = this.load(media, generation).catch(() => {
      if (generation === this.generation) this.dispose();
    });
  }

  /** Settles once the media has loaded or failed; never rejects. */
  ready(): Promise<void> {
    return this.loading ?? Promise.resolve();
  }

  /** Draws the media as it looks `ms` after the export started. */
  async seek(ms: number): Promise<void> {
    if (!this.frameTexture) return;
    if (this.video) {
      await this.seekVideo(ms);
      return;
    }
    if (this.frames.length === 0) return;
    let index = 0;
    if (this.frames.length > 1 && this.loopMs > 0) {
      const at = ((ms % this.loopMs) + this.loopMs) % this.loopMs;
      while (index < this.frames.length - 1 && this.frames[index].endMs <= at) index++;
    }
    this.draw(`f${index}`, this.frames[index].bitmap);
  }

  /** Live mode: draws the frame showing now. */
  drawLive(now = performance.now()) {
    if (!this.frameTexture) return;
    const video = this.video;
    if (!video) {
      void this.seek(now - this.liveStart);
      return;
    }
    // Only a new video frame is uploaded again.
    if (video.readyState >= 2) this.draw(`t${video.currentTime}`, video);
  }

  /** Live mode: how long the current frame stays up, or null for a still picture. */
  nextFrameDelayMs(now = performance.now()): number | null {
    if (!this.frameTexture) return null;
    if (this.video) return 1000 / VIDEO_SAMPLE_FPS;
    if (this.frames.length < 2 || this.loopMs <= 0) return null;
    const at = (((now - this.liveStart) % this.loopMs) + this.loopMs) % this.loopMs;
    const next = this.frames.find((frame) => frame.endMs > at);
    return Math.max(MIN_GIF_FRAME_MS, (next?.endMs ?? this.loopMs) - at);
  }

  destroy() {
    this.key = "";
    this.dispose();
  }

  private async load(media: ReplayCustomMedia, generation: number) {
    const blob = await loadReplayCustomMediaBlob(media);
    // The file itself counts against the budget; one that leaves no room for
    // a frame is not drawn at all.
    if (!blob || generation !== this.generation || blob.size >= this.budgetBytes) return;
    if (media.kind === "video") await this.loadVideo(blob, generation);
    else await this.loadImage(blob, generation);
    this.liveStart = performance.now();
  }

  private frameLimit(fileBytes: number, frameBytes: number): number {
    return Math.floor(Math.max(0, this.budgetBytes - fileBytes) / Math.max(1, frameBytes));
  }

  private async loadImage(blob: Blob, generation: number) {
    const frames: AnimatedFrame[] = [];
    try {
      const animated = typeof ImageDecoder !== "undefined" && blob.type !== "" && await ImageDecoder.isTypeSupported(blob.type);
      if (animated) {
        const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: blob.type });
        try {
          await decoder.tracks.ready;
          await decoder.completed;
          const count = decoder.tracks.selectedTrack?.frameCount ?? 1;
          let endMs = 0;
          let limit = count;
          for (let index = 0; index < limit; index++) {
            const { image } = await decoder.decode({ frameIndex: index });
            try {
              const size = fitFrame(image.displayWidth, image.displayHeight);
              if (index === 0) limit = Math.min(count, Math.max(1, this.frameLimit(blob.size, size.width * size.height * 4)));
              const delay = (image.duration ?? 0) / 1000;
              endMs += delay >= MIN_GIF_FRAME_MS ? delay : DEFAULT_GIF_FRAME_MS;
              frames.push({ bitmap: await createImageBitmap(image, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high" }), endMs });
            } finally {
              image.close();
            }
            if (generation !== this.generation) break;
          }
        } finally {
          decoder.close();
        }
      }
    } catch {
      // Fall through to a still picture.
    }
    if (frames.length === 0) {
      const still = await createImageBitmap(blob);
      const size = fitFrame(still.width, still.height);
      frames.push({ bitmap: await createImageBitmap(still, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high" }), endMs: 0 });
      still.close();
    }
    if (generation !== this.generation) {
      for (const frame of frames) frame.bitmap.close();
      return;
    }
    this.frames = frames;
    this.loopMs = frames[frames.length - 1].endMs;
    this.createTarget(frames[0].bitmap.width, frames[0].bitmap.height);
  }

  private async loadVideo(blob: Blob, generation: number) {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.loop = this.live;
    const url = URL.createObjectURL(blob);
    video.src = url;
    try {
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error("video failed to load"));
      });
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
    if (generation !== this.generation || !(video.videoWidth > 0) || !(video.duration > 0)) {
      URL.revokeObjectURL(url);
      return;
    }
    this.video = video;
    this.videoUrl = url;
    const size = fitFrame(video.videoWidth, video.videoHeight);
    // Live playback draws the playing element; only an export's seeks are cached.
    this.videoCacheLimit = this.live ? 0 : this.frameLimit(blob.size, size.width * size.height * 4);
    this.createTarget(size.width, size.height);
    if (this.live) void video.play().catch(() => {});
  }

  private async seekVideo(ms: number) {
    const video = this.video!;
    const slots = Math.max(1, Math.floor(video.duration * VIDEO_SAMPLE_FPS));
    const slot = Math.floor(ms / 1000 * VIDEO_SAMPLE_FPS) % slots;
    const key = `v${slot}`;
    if (key === this.drawn) return;
    const cached = this.videoCache.get(slot);
    if (cached) {
      this.draw(key, cached);
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        window.clearTimeout(timer);
        video.removeEventListener("seeked", done);
        resolve();
      };
      const timer = window.setTimeout(done, SEEK_TIMEOUT_MS);
      video.addEventListener("seeked", done);
      // A hair past the slot start lands inside its frame, not on the edge before it.
      video.currentTime = Math.min(video.duration, (slot + 0.01) / VIDEO_SAMPLE_FPS);
    });
    if (this.video !== video) return;
    if (this.videoCache.size < this.videoCacheLimit) {
      const bitmap = await createImageBitmap(video, { resizeWidth: this.canvas!.width, resizeHeight: this.canvas!.height, resizeQuality: "high" });
      if (this.video !== video) {
        bitmap.close();
        return;
      }
      this.videoCache.set(slot, bitmap);
      this.draw(key, bitmap);
      return;
    }
    this.draw(key, video);
  }

  private createTarget(width: number, height: number) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.naturalAspect = width / height;
    this.frameTexture = Texture.from(canvas);
  }

  private draw(key: string, source: CanvasImageSource) {
    if (key === this.drawn || !this.context || !this.canvas || !this.frameTexture) return;
    this.drawn = key;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.drawImage(source, 0, 0, this.canvas.width, this.canvas.height);
    this.frameTexture.source.update();
  }

  private dispose() {
    this.generation++;
    this.loading = null;
    for (const frame of this.frames) frame.bitmap.close();
    this.frames = [];
    this.loopMs = 0;
    for (const bitmap of this.videoCache.values()) bitmap.close();
    this.videoCache.clear();
    if (this.video) {
      this.video.removeAttribute("src");
      this.video.load();
      this.video = null;
    }
    if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
    this.videoUrl = null;
    this.frameTexture?.destroy(true);
    this.frameTexture = null;
    this.canvas = null;
    this.context = null;
    this.drawn = "";
    this.naturalAspect = null;
  }
}

function fitFrame(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(1, width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
