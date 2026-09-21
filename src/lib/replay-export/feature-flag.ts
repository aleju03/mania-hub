// Client-local flag for the on-device replay video exporter.
//
// Turning this on enables the export button and nothing else. It does not
// enable any backend replay-video endpoint: the ordinary local export path
// never calls one, and the backend's own feature switch is separate.

export function isLocalReplayVideoExportEnabled(): boolean {
  return import.meta.env.VITE_ENABLE_LOCAL_REPLAY_VIDEO_EXPORT === "1";
}
