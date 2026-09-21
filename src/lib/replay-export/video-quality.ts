// AV1 uses a fixed quantizer so detail, including the first frame, isn't
// sacrificed to meet a per-second byte target. Bitrate remains an estimate
// for admission; the destination independently enforces actual bytes.
export const REPLAY_EXPORT_AV1_QUANTIZER = 96;
export const REPLAY_EXPORT_KEYFRAME_SECONDS = 2;

export function av1QualityEncoderConfig(
  width: number,
  height: number,
  fps: number,
  bitrate?: number,
): VideoEncoderConfig {
  const pixels = width * height;
  const displayRate = pixels * fps;
  // AV1 Annex A: levels 4.x share a 2,359,296-pixel frame limit. Wider
  // 1080p needs level 5.0, which covers our full 4096×1080@60 admission cap.
  // https://github.com/AOMediaCodec/av1-spec/blob/master/annex.a.levels.md
  const level = pixels > 2_359_296 || displayRate > 141_557_760 || (bitrate ?? 0) > 20_000_000
    ? "12"
    : displayRate > 70_778_880 || (bitrate ?? 0) > 12_000_000 ? "09" : "08";
  return {
    codec: `av01.0.${level}M.08`,
    width,
    height,
    framerate: fps,
    bitrateMode: "quantizer",
    latencyMode: "quality",
    hardwareAcceleration: "prefer-software",
  };
}
