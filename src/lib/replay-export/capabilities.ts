// What this browser can actually encode, asked of the browser rather than
// inferred from its user agent.
//
// The probe returns a concrete configuration or nothing. A configuration that
// passes here has also survived a short disposable encode of video, audio,
// and muxing together, because `canEncodeVideo` answering yes is a statement
// about a codec, not about this machine finishing a ten-minute job.

import {
  BufferTarget,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
  type CanvasSource as CanvasSourceType,
} from "mediabunny";
import { ReplayExportError } from "./errors";
import { MAX_EXPORT_FPS, MAX_EXPORT_HEIGHT, MAX_EXPORT_WIDTH, type ReplayExportEncodingMode } from "./limits";
import { QualityVideoSource } from "./quality-video-source";
import { REPLAY_EXPORT_AV1_QUANTIZER, av1QualityEncoderConfig } from "./video-quality";

export { supportsFileSystemAccess } from "./save-picker";

export type ReplayExportCodecPlan = {
  container: "mp4" | "webm";
  videoCodec: "av1" | "avc" | "vp9" | "vp8";
  videoQuantizer?: number;
  fullCodecString?: string;
  hardwareAcceleration: "prefer-software" | "prefer-hardware" | "no-preference";
  audioCodec: "aac" | "opus" | null;
  /** True when the AAC track needs the lazily loaded WASM extension. */
  usesAacExtension: boolean;
  mimeType: string;
  fileExtension: string;
};

export type ReplayExportCapabilityRequest = {
  encodingMode?: ReplayExportEncodingMode;
  videoBitrateMode?: "variable" | "quantizer";
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  audioBitrate: number;
  sampleRate: number;
  channels: number;
  /** False when the user asked for a silent export; skips every audio probe. */
  wantsAudio: boolean;
  /** H.264 bypasses AV1, including when retrying a failed AV1 smoke encode. */
  preferredVideoCodec?: ReplayExportCodecPlan["videoCodec"];
  videoQuantizer?: number;
};

let aacExtensionRegistration: Promise<boolean> | null = null;

/**
 * Loads and registers the FFmpeg-derived AAC-LC encoder extension. This is a
 * targeted encoder, not a browser FFmpeg distribution, and it is only fetched
 * when the platform has no native AAC encoder.
 */
export function ensureAacEncoderExtension(): Promise<boolean> {
  if (!aacExtensionRegistration) {
    aacExtensionRegistration = import("@mediabunny/aac-encoder")
      .then(({ registerAacEncoder }) => {
        registerAacEncoder();
        return true;
      })
      .catch(() => {
        aacExtensionRegistration = null;
        return false;
      });
  }
  return aacExtensionRegistration;
}

export function supportsWebCodecsVideo(): boolean {
  return typeof VideoEncoder !== "undefined";
}

export function isOutputSizeAllowed(width: number, height: number, fps: number): boolean {
  return Number.isInteger(width) && width >= 2 && width % 2 === 0
    && Number.isInteger(height) && height >= 2 && height % 2 === 0
    && width <= MAX_EXPORT_WIDTH
    && height <= MAX_EXPORT_HEIGHT
    && fps > 0
    && fps <= MAX_EXPORT_FPS;
}

async function pickVideoAcceleration(
  codec: "avc" | "vp9" | "vp8",
  request: ReplayExportCapabilityRequest,
): Promise<"prefer-hardware" | "no-preference" | null> {
  const base = {
    width: request.width,
    height: request.height,
    bitrate: request.videoBitrate,
    bitrateMode: "variable" as const,
    latencyMode: "quality" as const,
  };
  // Hardware is a hint, not proof a GPU encoder is in use.
  if (await canEncodeVideo(codec, { ...base, hardwareAcceleration: "prefer-hardware" })) {
    return "prefer-hardware";
  }
  if (await canEncodeVideo(codec, base)) return "no-preference";
  return null;
}

async function canEncodeAudioCodec(
  codec: "aac" | "opus",
  request: ReplayExportCapabilityRequest,
): Promise<boolean> {
  return canEncodeAudio(codec, {
    numberOfChannels: request.channels,
    sampleRate: request.sampleRate,
    bitrate: request.audioBitrate,
  });
}

/** Fast mode never opts into a software codec after hardware probing fails. */
async function* fastExportPlans(
  request: ReplayExportCapabilityRequest,
): AsyncGenerator<ReplayExportCodecPlan> {
  if (!supportsWebCodecsVideo() || !isOutputSizeAllowed(request.width, request.height, request.fps)) return;
  for (const codec of ["avc", "av1", "vp9", "vp8"] as const) {
    const fullCodecString = codec === "av1"
      ? av1QualityEncoderConfig(request.width, request.height, request.fps, request.videoBitrate).codec : undefined;
    try {
      if (!(await canEncodeVideo(codec, {
        width: request.width,
        height: request.height,
        bitrate: request.videoBitrate,
        bitrateMode: "variable",
        latencyMode: "quality",
        hardwareAcceleration: "prefer-hardware",
        ...(fullCodecString ? { fullCodecString } : {}),
      }))) continue;
    } catch {
      continue;
    }
    const mp4 = codec === "avc" || codec === "av1";
    const audioCodec = request.wantsAudio ? (mp4 ? "aac" : "opus") : null;
    let usesAacExtension = false;
    if (audioCodec && !(await canEncodeAudioCodec(audioCodec, request))) {
      if (audioCodec !== "aac" || !(await ensureAacEncoderExtension())
        || !(await canEncodeAudioCodec("aac", request))) continue;
      usesAacExtension = true;
    }
    yield {
      container: mp4 ? "mp4" : "webm",
      videoCodec: codec,
      ...(fullCodecString ? { fullCodecString } : {}),
      hardwareAcceleration: "prefer-hardware",
      audioCodec,
      usesAacExtension,
      mimeType: mp4 ? "video/mp4" : "video/webm",
      fileExtension: mp4 ? "mp4" : "webm",
    };
  }
}

/**
 * Fast exports prefer hardware; compact and legacy exports prefer quality-controlled AV1.
 * Audio is optional in the
 * sense that a user can ask for a silent video; it is never dropped silently
 * to make an unsupported configuration look supported.
 */
export async function planExportCodecs(
  request: ReplayExportCapabilityRequest,
): Promise<ReplayExportCodecPlan | null> {
  if (request.encodingMode === "fast") {
    for await (const plan of fastExportPlans(request)) return plan;
    return null;
  }
  if (!supportsWebCodecsVideo()) return null;
  if (!isOutputSizeAllowed(request.width, request.height, request.fps)) return null;

  if (request.preferredVideoCodec !== "avc") {
    try {
      const variable = request.videoBitrateMode === "variable";
      const config = av1QualityEncoderConfig(request.width, request.height, request.fps, variable ? request.videoBitrate : undefined);
      const support = variable ? null : await VideoEncoder.isConfigSupported(config);
      const supported = variable
        ? await canEncodeVideo("av1", {
          width: request.width, height: request.height, bitrate: request.videoBitrate,
          fullCodecString: config.codec, bitrateMode: "variable", latencyMode: "quality",
          hardwareAcceleration: "prefer-software",
        })
        : support?.supported && support.config?.bitrateMode === "quantizer";
      // Older implementations may discard an unrecognized bitrate mode.
      if (supported) {
        let usesAacExtension = false;
        let audioSupported = !request.wantsAudio || await canEncodeAudioCodec("aac", request);
        if (!audioSupported) {
          usesAacExtension = await ensureAacEncoderExtension();
          audioSupported = usesAacExtension && await canEncodeAudioCodec("aac", request);
        }
        if (audioSupported) return {
          container: "mp4",
          videoCodec: "av1",
          ...(variable ? { fullCodecString: config.codec } : { videoQuantizer: request.videoQuantizer ?? REPLAY_EXPORT_AV1_QUANTIZER }),
          hardwareAcceleration: "prefer-software",
          audioCodec: request.wantsAudio ? "aac" : null,
          usesAacExtension,
          mimeType: "video/mp4",
          fileExtension: "mp4",
        };
      }
    } catch {
      // An unavailable AV1 quality mode leaves the existing codecs usable.
    }
  }

  const avc = await pickVideoAcceleration("avc", request);
  if (avc) {
    if (!request.wantsAudio) {
      return {
        container: "mp4",
        videoCodec: "avc",
        hardwareAcceleration: avc,
        audioCodec: null,
        usesAacExtension: false,
        mimeType: "video/mp4",
        fileExtension: "mp4",
      };
    }
    if (await canEncodeAudioCodec("aac", request)) {
      return {
        container: "mp4",
        videoCodec: "avc",
        hardwareAcceleration: avc,
        audioCodec: "aac",
        usesAacExtension: false,
        mimeType: "video/mp4",
        fileExtension: "mp4",
      };
    }
    if (await ensureAacEncoderExtension() && await canEncodeAudioCodec("aac", request)) {
      return {
        container: "mp4",
        videoCodec: "avc",
        hardwareAcceleration: avc,
        audioCodec: "aac",
        usesAacExtension: true,
        mimeType: "video/mp4",
        fileExtension: "mp4",
      };
    }
  }

  // No validated MP4 path: WebM is an explicit alternative, with the real
  // extension on the file. It is never MP4 under another name.
  for (const codec of ["vp9", "vp8"] as const) {
    const acceleration = await pickVideoAcceleration(codec, request);
    if (!acceleration) continue;
    if (request.wantsAudio && !(await canEncodeAudioCodec("opus", request))) continue;
    return {
      container: "webm",
      videoCodec: codec,
      hardwareAcceleration: acceleration,
      audioCodec: request.wantsAudio ? "opus" : null,
      usesAacExtension: false,
      mimeType: "video/webm",
      fileExtension: "webm",
    };
  }

  return null;
}

/**
 * Encodes a handful of frames at the requested size plus one audio block through the selected
 * path and muxes them, discarding the result. Catches the configurations that
 * pass a capability check and then fail on the first real packet.
 */
export async function smokeTestExportPlan(
  plan: ReplayExportCodecPlan,
  request: ReplayExportCapabilityRequest,
): Promise<void> {
  const { AudioSample, AudioSampleSource, CanvasSource } = await import("mediabunny");
  const width = request.width;
  const height = request.height;
  const fps = request.fps;
  const frames = 3;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new ReplayExportError("renderer_failed", "2D context unavailable for the smoke encode.");

  const output = new Output({
    format: plan.container === "mp4"
      ? new Mp4OutputFormat({ fastStart: false })
      : new WebMOutputFormat(),
    target: new BufferTarget(),
  });

  const qualityVideo = plan.videoCodec === "av1" && plan.videoQuantizer !== undefined
    ? new QualityVideoSource(canvas, fps, plan.videoQuantizer)
    : null;
  const videoSource = qualityVideo?.source ?? new CanvasSource(canvas, {
    codec: plan.videoCodec,
    bitrate: request.videoBitrate,
    bitrateMode: "variable",
    latencyMode: "quality",
    keyFrameInterval: 1,
    hardwareAcceleration: plan.hardwareAcceleration,
    fullCodecString: plan.fullCodecString,
  });
  output.addVideoTrack(videoSource, { frameRate: fps });

  const audioSource = plan.audioCodec
    ? new AudioSampleSource({
        codec: plan.audioCodec,
        bitrate: request.audioBitrate,
      })
    : null;
  if (audioSource) output.addAudioTrack(audioSource);

  try {
    await output.start();
    for (let index = 0; index < frames; index++) {
      ctx.fillStyle = index % 2 === 0 ? "#101018" : "#181020";
      ctx.fillRect(0, 0, width, height);
      if (qualityVideo) await qualityVideo.addFrame(index);
      else await (videoSource as CanvasSourceType).add(index / fps, 1 / fps);
    }
    if (audioSource) {
      const frameCount = Math.round(request.sampleRate * (frames / fps));
      const data = new Float32Array(frameCount * request.channels);
      const sample = new AudioSample({
        data,
        format: "f32",
        numberOfChannels: request.channels,
        sampleRate: request.sampleRate,
        timestamp: 0,
      });
      try {
        await audioSource.add(sample);
      } finally {
        sample.close();
      }
    }
    if (qualityVideo) await qualityVideo.close();
    else videoSource.close();
    audioSource?.close();
    await output.finalize();
  } catch (error) {
    await qualityVideo?.cancel();
    if (output.state === "pending" || output.state === "started") {
      await output.cancel().catch(() => {});
    }
    throw new ReplayExportError(
      plan.audioCodec ? "unsupported_audio_codec" : "unsupported_video_codec",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

/** Advertised encoders must survive a real encode before the job uses them. */
export async function validateExportCodecs(
  request: ReplayExportCapabilityRequest,
): Promise<ReplayExportCodecPlan | null> {
  if (request.encodingMode === "fast") {
    let failure: unknown;
    for await (const plan of fastExportPlans(request)) {
      try {
        await smokeTestExportPlan(plan, request);
        return plan;
      } catch (error) {
        failure = error;
      }
    }
    throw new ReplayExportError("fast_export_unavailable", undefined, { cause: failure });
  }
  const plan = await planExportCodecs(request);
  if (!plan) return null;
  try {
    await smokeTestExportPlan(plan, request);
    return plan;
  } catch (error) {
    if (plan.videoCodec !== "av1") throw error;
    const fallback = await planExportCodecs({ ...request, preferredVideoCodec: "avc" });
    if (!fallback) throw error;
    await smokeTestExportPlan(fallback, request);
    return fallback;
  }
}
