// Runs one export, start to finish, on this device.
//
// Everything the job needs has already been captured and retained by the
// manager, so nothing in here reads React state, the current route, the live
// audio clock, or global preferences. The only network traffic is whatever
// the renderer's own asset loading still does during preparation; once the
// render loop starts, the pipeline is local.

import { validateExportCodecs, type ReplayExportCodecPlan } from "../capabilities";
import {
  createBufferDestination,
  createFileDestination,
  type ReplayExportDestination,
  type ReplayExportOutputResult,
} from "../destinations";
import { ReplayExportEncoder } from "../encode";
import { ReplayExportError, asReplayExportError } from "../errors";
import {
  AUDIO_BLOCK_LOOKAHEAD,
  MAIN_THREAD_BUDGET_MS,
  REPLAY_EXPORT_ADMISSION,
  REPLAY_EXPORT_WORKING_MEMORY_BUDGET,
  checkExportAdmission,
} from "../limits";
import { createExportRenderer } from "../renderer";
import type { ReplayExportSpecV1 } from "../render-spec";
import { createCooperativeScheduler } from "../scheduler";
import { createExportTimeline, frameSourceMs, type ReplayExportTimeline } from "../timeline";
import type {
  LocalExportResources,
  ReplayExportDestinationTarget,
  ReplayExportPhase,
  ReplayExportWarningCode,
} from "../types";
import { ReplayExportAudioPipeline } from "../audio/pipeline";

export type LocalExportProgress = {
  framesCompleted: number;
  audioSecondsProcessed: number;
  bytesWritten: number;
};

export type LocalExportCallbacks = {
  onPhase: (phase: ReplayExportPhase) => void;
  onProgress: (progress: LocalExportProgress) => void;
  onWarning: (warning: ReplayExportWarningCode) => void;
  /** Reports the resolved plan before any expensive work starts. */
  onPlan: (plan: ReplayExportCodecPlan, timeline: ReplayExportTimeline, estimatedBytes: number) => void;
};

export type LocalExportRunOptions = {
  spec: ReplayExportSpecV1;
  resources: LocalExportResources;
  target: ReplayExportDestinationTarget;
  signal: AbortSignal;
  callbacks: LocalExportCallbacks;
};

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ReplayExportError("export_interrupted");
}

export async function runLocalExport(options: LocalExportRunOptions): Promise<ReplayExportOutputResult> {
  const { spec, resources, target, signal, callbacks } = options;
  callbacks.onPhase("preparing");

  let timeline: ReplayExportTimeline;
  try {
    timeline = createExportTimeline({
      startMs: spec.range.startMs,
      endMs: spec.range.endMs,
      rate: spec.playback.rate,
      fps: spec.output.fps,
      sampleRate: spec.output.sampleRate,
    });
  } catch (error) {
    throw new ReplayExportError(
      "invalid_range",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }

  const wantsAudio = spec.output.audioCodec !== null;
  const plan = await validateExportCodecs({
    width: spec.output.width,
    height: spec.output.height,
    fps: spec.output.fps,
    videoBitrate: spec.output.videoBitrate,
    audioBitrate: spec.output.audioBitrate,
    sampleRate: spec.output.sampleRate,
    channels: spec.output.channels,
    wantsAudio,
    preferredVideoCodec: spec.output.videoCodec,
    videoQuantizer: spec.output.videoQuantizer,
  });
  if (!plan) throw new ReplayExportError("unsupported_video_codec", "No validated local encoder configuration.");
  throwIfAborted(signal);

  if (plan.container !== spec.output.container) callbacks.onWarning("container-fallback");
  if (wantsAudio && !plan.audioCodec) {
    throw new ReplayExportError("unsupported_audio_codec", "No audio encoder for the selected container.");
  }

  const admission = checkExportAdmission({
    destination: target.kind,
    outputSeconds: timeline.videoDurationSeconds,
    videoBitrate: spec.output.videoBitrate,
    audioBitrate: spec.output.audioBitrate,
    workingMemoryBytes: resources.songFile?.size ?? 0,
  });
  if (!admission.ok) {
    throw new ReplayExportError(
      "resource_limit_exceeded",
      `${admission.reason} limit ${admission.limit} exceeded`,
    );
  }
  callbacks.onPlan(plan, timeline, admission.estimatedBytes);

  const filename = spec.filename.replace(/\.(mp4|webm)$/i, "") + `.${plan.fileExtension}`;
  const policy = REPLAY_EXPORT_ADMISSION[target.kind];

  let renderer: Awaited<ReturnType<typeof createExportRenderer>> | null = null;
  let audio: ReplayExportAudioPipeline | null = null;
  let destination: ReplayExportDestination | null = null;
  let encoder: ReplayExportEncoder | null = null;
  let committed = false;

  try {
    renderer = await createExportRenderer(spec, resources, signal);
    throwIfAborted(signal);

    if (plan.audioCodec) {
      audio = await ReplayExportAudioPipeline.create({
        spec,
        timeline,
        songFile: spec.audio.songEnabled ? resources.songFile : null,
        schedule: renderer.getHitsoundSchedule(),
        samples: resources.hitsoundSamples,
        memoryBudgetBytes: REPLAY_EXPORT_WORKING_MEMORY_BUDGET,
      });
      for (const warning of audio.warnings) {
        if (warning === "hitsound-samples-missing") callbacks.onWarning("audio-decode-skipped");
      }
    }
    throwIfAborted(signal);

    destination = target.kind === "file"
      ? await createFileDestination({
          handle: target.handle,
          filename,
          mimeType: plan.mimeType,
          maxBytes: policy.maxOutputBytes,
        })
      : createBufferDestination({
          filename,
          mimeType: plan.mimeType,
          maxBytes: policy.maxOutputBytes,
        });
    throwIfAborted(signal);

    encoder = new ReplayExportEncoder({
      plan,
      spec,
      timeline,
      destination,
      canvas: renderer.canvas,
    });
    await encoder.start();
    throwIfAborted(signal);

    callbacks.onPhase("rendering");
    const scheduler = createCooperativeScheduler(MAIN_THREAD_BUDGET_MS);
    let audioFramesProduced = 0;
    let audioDone = audio === null;

    const pumpAudio = async (untilOutputSeconds: number) => {
      while (audio && !audioDone && audioFramesProduced / timeline.sampleRate < untilOutputSeconds) {
        const block = await audio.next();
        if (!block) {
          audioDone = true;
          break;
        }
        await encoder!.addAudioBlock(block);
        audioFramesProduced = block.startFrame + block.length;
        throwIfAborted(signal);
        await scheduler.maybeYield();
      }
    };

    for (let index = 0; index < timeline.frameCount; index++) {
      throwIfAborted(signal);
      await renderer.renderFrame(frameSourceMs(timeline, index));
      await encoder.addFrame(index);

      const videoSeconds = (index + 1) / timeline.fps;
      // Keep the two tracks inside one lookahead of each other: letting
      // either run the whole replay first is what makes a muxer hold every
      // packet of the lagging track.
      await pumpAudio(videoSeconds + AUDIO_BLOCK_LOOKAHEAD);

      if (destination.bytesWritten > policy.maxOutputBytes) {
        throw new ReplayExportError("resource_limit_exceeded", "Output grew past its byte limit.");
      }

      callbacks.onProgress({
        framesCompleted: index + 1,
        audioSecondsProcessed: audioFramesProduced / timeline.sampleRate,
        bytesWritten: destination.bytesWritten,
      });
      await scheduler.maybeYield();
    }

    // Any audio past the last video frame's window still belongs in the file.
    await pumpAudio(Infinity);
    throwIfAborted(signal);

    callbacks.onPhase("finalizing");
    await encoder.finalize();
    encoder = null;
    throwIfAborted(signal);

    // Only a clean finalize on a job nobody cancelled may replace the file
    // the user picked.
    const result = await destination.commit();
    committed = true;
    callbacks.onProgress({
      framesCompleted: timeline.frameCount,
      audioSecondsProcessed: audioFramesProduced / timeline.sampleRate,
      bytesWritten: result.byteLength,
    });
    return result;
  } catch (error) {
    await encoder?.cancel();
    if (destination && !committed) await destination.abort();
    throw asReplayExportError(error, "encoder_failed");
  } finally {
    await audio?.close().catch(() => {});
    renderer?.destroy();
  }
}
