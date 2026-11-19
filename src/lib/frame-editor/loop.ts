import { LOOP_SECONDS, WORKSHOP_SIZE, type Layer } from "./doc";
import { composite, type RenderInput } from "./render";

/* Records a frame's motion as the looping WebM the site plays: VP9 with an
   alpha channel, at the template's 384px, one loop long. The browser's
   MediaRecorder does the encoding, so it needs one that keeps alpha in VP9
   (Chrome, Edge and other Chromium browsers do; Firefox and Safari don't). */

const FPS = 30;
const MIME = "video/webm;codecs=vp9";

export function canRecordLoop(): boolean {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") return false;
  const ua = navigator.userAgent;
  if (!/Chrome|Chromium|Edg\//.test(ua) || /Firefox/.test(ua)) return false;
  return MediaRecorder.isTypeSupported(MIME) && typeof HTMLCanvasElement.prototype.captureStream === "function";
}

export async function recordLoop(layers: readonly Layer[], input: RenderInput, onProgress?: (share: number) => void): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = WORKSHOP_SIZE;
  const ctx = canvas.getContext("2d")!;
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const recorder = new MediaRecorder(stream, { mimeType: MIME, videoBitsPerSecond: 3_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  const frames = LOOP_SECONDS * FPS;
  const draw = (index: number) => {
    ctx.clearRect(0, 0, WORKSHOP_SIZE, WORKSHOP_SIZE);
    composite(ctx, layers, { ...input, size: WORKSHOP_SIZE, time: index / frames });
    track.requestFrame();
  };
  // draw the first frame before starting so the recording opens on it
  draw(0);
  recorder.start();
  const start = performance.now();
  for (let index = 1; index <= frames; index++) {
    const due = start + (index * 1000) / FPS;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    draw(index % frames);
    onProgress?.(index / frames);
  }
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((entry) => entry.stop());
  return new Blob(chunks, { type: "video/webm" });
}
