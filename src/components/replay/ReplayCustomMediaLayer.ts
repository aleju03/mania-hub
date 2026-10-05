// The custom media overlay. A GIF that animates and a video from another site
// are things the stage canvas cannot draw live, so the media is a real
// element laid over the canvas. The canvas still owns
// its placement: it reserves the frame, takes the drags and draws the
// selection outline, and the element follows that frame without ever taking
// a pointer event.
import { resolveReplayCustomMediaUrl } from "../../lib/replay-custom-media";
import { hasReplayCustomMediaSource, measureReplayCustomMedia, type ReplayCustomMedia } from "../../lib/replay-overlays";

type MediaElement = HTMLImageElement | HTMLVideoElement;

export interface ReplayCustomMediaFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class ReplayCustomMediaLayer {
  private element: MediaElement | null = null;
  private sourceKey = "";
  private objectUrl: string | null = null;
  // Width over height once a picture or video reports its own size.
  private aspect: number | null = null;
  private loadToken = 0;
  private placed = "";

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onSizeChange: () => void,
  ) {}

  setMedia(media: ReplayCustomMedia | null) {
    const key = media && hasReplayCustomMediaSource(media) ? `${media.kind}|${media.url}|${media.fileId ?? ""}` : "";
    if (key === this.sourceKey) {
      if (this.element && media) this.element.style.opacity = String(media.opacity);
      return;
    }
    this.sourceKey = key;
    this.teardown();
    if (!media || !key || typeof document === "undefined") return;
    const token = ++this.loadToken;
    void resolveReplayCustomMediaUrl(media).then((resolved) => {
      if (!resolved) return;
      if (token !== this.loadToken) {
        if (resolved.objectUrl) URL.revokeObjectURL(resolved.url);
        return;
      }
      if (resolved.objectUrl) this.objectUrl = resolved.url;
      this.mount(media, resolved.url);
    });
  }

  /** Size at 100% scale, from the shape the element reported. */
  measure(media: ReplayCustomMedia): { width: number; height: number } {
    return measureReplayCustomMedia(media, this.aspect);
  }

  /** Frame in stage pixels, or null to hide. `stageWidth` maps stage pixels onto the canvas's CSS box. */
  place(frame: ReplayCustomMediaFrame | null, stageWidth: number, stageHeight: number, selected: boolean) {
    const element = this.element;
    if (!element) return;
    if (!frame) {
      if (this.placed !== "hidden") {
        element.style.display = "none";
        this.placed = "hidden";
      }
      return;
    }
    const scaleX = this.canvas.clientWidth / Math.max(1, stageWidth);
    const scaleY = this.canvas.clientHeight / Math.max(1, stageHeight);
    const left = this.canvas.offsetLeft + frame.x * scaleX;
    const top = this.canvas.offsetTop + frame.y * scaleY;
    const width = frame.width * scaleX;
    const height = frame.height * scaleY;
    const signature = `${left.toFixed(1)}|${top.toFixed(1)}|${width.toFixed(1)}|${height.toFixed(1)}|${selected}`;
    if (signature === this.placed) return;
    this.placed = signature;
    const style = element.style;
    style.display = "block";
    style.left = `${left}px`;
    style.top = `${top}px`;
    style.width = `${width}px`;
    style.height = `${height}px`;
    // The canvas draws the selection outline underneath; let it show through.
    style.filter = selected ? "brightness(0.75)" : "";
  }

  destroy() {
    this.loadToken++;
    this.sourceKey = "";
    this.teardown();
  }

  private mount(media: ReplayCustomMedia, url: string) {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    let element: MediaElement;
    if (media.kind === "image") {
      const image = document.createElement("img");
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.onload = () => this.setAspect(image.naturalWidth, image.naturalHeight);
      image.src = url;
      element = image;
    } else {
      const video = document.createElement("video");
      video.muted = true;
      video.loop = true;
      video.autoplay = true;
      video.playsInline = true;
      video.onloadedmetadata = () => this.setAspect(video.videoWidth, video.videoHeight);
      video.src = url;
      void video.play().catch(() => {});
      element = video;
    }
    element.setAttribute("aria-hidden", "true");
    element.dataset.replayCustomMedia = "true";
    const style = element.style;
    style.position = "absolute";
    style.display = "none";
    style.pointerEvents = "none";
    style.userSelect = "none";
    style.objectFit = "fill";
    style.opacity = String(media.opacity);
    // One layer above the canvas, whatever the page stacks it at; below it,
    // the opaque playfield would hide the media.
    const canvasLayer = Number.parseInt(getComputedStyle(this.canvas).zIndex, 10);
    style.zIndex = String((Number.isFinite(canvasLayer) ? canvasLayer : 0) + 1);
    parent.insertBefore(element, this.canvas.nextSibling);
    this.element = element;
    this.placed = "";
    this.onSizeChange();
  }

  private setAspect(width: number, height: number) {
    if (!(width > 0 && height > 0)) return;
    this.aspect = width / height;
    this.placed = "";
    this.onSizeChange();
  }

  private teardown() {
    if (this.element) {
      if (this.element instanceof HTMLVideoElement) {
        this.element.pause();
        this.element.removeAttribute("src");
        this.element.load();
      }
      this.element.remove();
      this.element = null;
    }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.aspect = null;
    this.placed = "";
  }
}
