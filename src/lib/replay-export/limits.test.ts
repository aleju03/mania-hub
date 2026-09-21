import { describe, expect, it } from "vitest";

import {
  REPLAY_EXPORT_ADMISSION,
  REPLAY_EXPORT_AUDIO_BITRATE,
  REPLAY_EXPORT_PRESETS,
  REPLAY_EXPORT_WORKING_MEMORY_BUDGET,
  checkExportAdmission,
  estimateOutputBytes,
  pcmByteLength,
  reservedPacketCounts,
} from "./limits";

describe("size estimates", () => {
  it("quotes the target bitrate without presenting safety headroom as expected output", () => {
    // 6 Mb/s video plus 128 kb/s audio over 60 seconds.
    const bytes = estimateOutputBytes(60, 6_000_000, 128_000);
    expect(bytes).toBe(45_960_000);
  });

  it("budgets a 7:28 full replay at 1080p60 below the 185 MiB reference including audio", () => {
    const bytes = estimateOutputBytes(
      7 * 60 + 28,
      REPLAY_EXPORT_PRESETS["1080p60"].videoBitrate,
      REPLAY_EXPORT_AUDIO_BITRATE,
    );
    expect(bytes / (1024 * 1024)).toBeCloseTo(167.05, 2);
  });

  it("scales with duration and omits audio from silent estimates", () => {
    expect(estimateOutputBytes(60, 4_000_000, 0)).toBe(30_000_000);
    expect(estimateOutputBytes(30, 4_000_000, 0)).toBe(15_000_000);
    expect(estimateOutputBytes(0, 4_000_000, 128_000)).toBe(0);
  });

  it("budgets float32 stereo PCM at the documented rate", () => {
    // Ten minutes at 48 kHz stereo is about 220 MiB, which is the reason the
    // whole-file decode path is gated on a budget check.
    expect(pcmByteLength(600, 48_000, 2)).toBe(230_400_000);
  });
});

describe("admission", () => {
  const video = REPLAY_EXPORT_PRESETS["720p60"].videoBitrate;

  it("admits an ordinary clip on either destination", () => {
    for (const destination of ["file", "buffer"] as const) {
      const verdict = checkExportAdmission({
        destination,
        outputSeconds: 30,
        videoBitrate: video,
        audioBitrate: 128_000,
        workingMemoryBytes: 8 * 1024 * 1024,
      });
      expect(verdict.ok).toBe(true);
    }
  });

  it("refuses an in-memory export past its minute", () => {
    const verdict = checkExportAdmission({
      destination: "buffer",
      outputSeconds: 90,
      videoBitrate: video,
      audioBitrate: 128_000,
      workingMemoryBytes: 0,
    });
    expect(verdict).toMatchObject({ ok: false, reason: "duration" });
  });

  it("refuses an in-memory export past its byte cap before its duration cap", () => {
    const verdict = checkExportAdmission({
      destination: "buffer",
      outputSeconds: 55,
      videoBitrate: 20_000_000,
      audioBitrate: 128_000,
      workingMemoryBytes: 0,
    });
    expect(verdict).toMatchObject({ ok: false, reason: "size" });
  });

  it("counts a huge input song against the working-memory budget", () => {
    const verdict = checkExportAdmission({
      destination: "file",
      outputSeconds: 10,
      videoBitrate: video,
      audioBitrate: 128_000,
      workingMemoryBytes: REPLAY_EXPORT_WORKING_MEMORY_BUDGET + 1,
    });
    // A short clip from an unstreamable long song still fails the input check.
    expect(verdict).toMatchObject({ ok: false, reason: "memory" });
  });

  it("still refuses a file whose expected size fits but whose VBR headroom does not", () => {
    // Expected: 60 MB; reserved with headroom: 75 MB, over the 64 MiB cap.
    const verdict = checkExportAdmission({
      destination: "buffer",
      outputSeconds: 60,
      videoBitrate: 8_000_000,
      audioBitrate: 0,
      workingMemoryBytes: 0,
    });
    expect(verdict).toMatchObject({ ok: false, reason: "size", estimatedBytes: 60_000_000 });
    expect(verdict.estimatedBytes).toBeLessThan(REPLAY_EXPORT_ADMISSION.buffer.maxOutputBytes);
  });

  it("reserves VBR headroom against memory without inflating the displayed estimate", () => {
    const input = {
      outputSeconds: 60,
      videoBitrate: 4_000_000,
      audioBitrate: 0,
      workingMemoryBytes: REPLAY_EXPORT_WORKING_MEMORY_BUDGET - 32_000_000,
    };
    // The 30 MB target fits the remaining memory, but its 37.5 MB budget does not.
    expect(checkExportAdmission({ ...input, destination: "buffer" })).toMatchObject({
      ok: false, reason: "memory", estimatedBytes: 30_000_000,
    });
    expect(checkExportAdmission({ ...input, destination: "file" })).toMatchObject({
      ok: true, estimatedBytes: 30_000_000,
    });
  });

  it("fits a one-minute clip at every preset in the buffer, including headroom", () => {
    for (const preset of Object.values(REPLAY_EXPORT_PRESETS)) {
      expect(checkExportAdmission({
        destination: "buffer",
        outputSeconds: 60,
        videoBitrate: preset.videoBitrate,
        audioBitrate: REPLAY_EXPORT_AUDIO_BITRATE,
        workingMemoryBytes: 8 * 1024 * 1024,
      }).ok).toBe(true);
    }
  });

  it("lets the streaming path run far longer than the in-memory one", () => {
    expect(REPLAY_EXPORT_ADMISSION.file.maxOutputSeconds)
      .toBeGreaterThan(REPLAY_EXPORT_ADMISSION.buffer.maxOutputSeconds);
  });
});

describe("reserved packet counts", () => {
  it("leaves slack over the exact frame and AAC packet counts", () => {
    const reserved = reservedPacketCounts(2400, 40, 48_000);
    expect(reserved.video).toBeGreaterThan(2400);
    expect(reserved.audio).toBeGreaterThan(Math.ceil((40 * 48_000) / 1024));
  });
});

describe("presets", () => {
  it("keeps 4K and over-60 FPS out of the first release", () => {
    for (const preset of Object.values(REPLAY_EXPORT_PRESETS)) {
      expect(preset.width).toBeLessThanOrEqual(1920);
      expect(preset.height).toBeLessThanOrEqual(1080);
      expect(preset.fps).toBeLessThanOrEqual(60);
    }
  });
});
