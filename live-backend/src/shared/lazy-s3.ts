// Lazy loader for @aws-sdk/client-s3, which costs ~28 MiB of RSS the moment it
// is imported. Neither process needs S3 at boot: the serving process first
// touches R2 on a skin/audio request, the worker on retention's skin cleanup or
// a (local-only) replay-video upload. Loading on first use keeps the SDK out of
// both boot module graphs; callers already run in async paths.
export type S3Module = typeof import("@aws-sdk/client-s3");

let s3ModulePromise: Promise<S3Module> | null = null;

export function loadS3Module(): Promise<S3Module> {
  s3ModulePromise ??= import("@aws-sdk/client-s3");
  return s3ModulePromise;
}
