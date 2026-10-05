// The custom media overlay inside an exported video. The live viewer lays a
// real element over the stage, which a recording of the canvas never sees,
// so an export decodes the media itself and draws it on the stage like any
// other overlay: every frame of a GIF up front, a video one seek per frame.
// The bytes are fetched first, so a link only works when its site allows
// other pages to read it; a local file always works.
import { Texture } from "pixi.js";
import { resolveReplayCustomMediaUrl } from "../../lib/replay-custom-media";
import { hasReplayCustomMediaSource, type ReplayCustomMedia } from "../../lib/replay-overlays";

// Frames are kept at most this big on their long side, and all of them
// together within this many bytes.
const MAX_FRAME_SIDE = 960;
const FRAME_BUDGET_BYTES = 400 * 1024 * 1024;
// A video is sampled at this rate; the cache holds what fits the budget.
const VIDEO_SAMPLE_FPS = 30;
// Browsers play a GIF frame that claims no delay at 100 ms.
const MIN_GIF_FRAME_MS = 20;
const DEFAULT_GIF_FRAME_MS = 100;
const SEEK_TIMEOUT_MS = 3000;

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

  destroy() {
    this.key = "";
    this.dispose();
  }

  private async load(media: ReplayCustomMedia, generation: number) {
    const resolved = await resolveReplayCustomMediaUrl(media);
    if (!resolved) return;
    let blob: Blob;
    try {
      const response = await fetch(resolved.url, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
      if (!response.ok) return;
      blob = await response.blob();
    } finally {
      if (resolved.objectUrl) URL.revokeObjectURL(resolved.url);
    }
    if (generation !== this.generation) return;
    if (media.kind === "video") await this.loadVideo(blob, generation);
    else await this.loadImage(blob, generation);
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
              if (index === 0) limit = Math.min(count, Math.max(1, Math.floor(FRAME_BUDGET_BYTES / (size.width * size.height * 4))));
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
    this.videoCacheLimit = Math.floor(FRAME_BUDGET_BYTES / (size.width * size.height * 4));
    this.createTarget(size.width, size.height);
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
