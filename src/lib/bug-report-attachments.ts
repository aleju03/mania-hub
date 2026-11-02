// What a bug report attachment is, read from its storage key. Pure, so the
// upload route, the signed-URL server function and both thread views agree.
//
// An image is stored as `<index>.<ext>` and shown inline. Any other file (a
// replay, a clip, a log) is stored as `<index>/<name>`; videos play inline and
// everything else is a download. The backend's isBugReportScreenshotKey
// accepts exactly these two shapes.

export type BugReportAttachmentKind = "image" | "video" | "file";

export interface BugReportAttachmentLink {
  url: string;
  kind: BugReportAttachmentKind;
  /** The file name as stored; the index for images. */
  name: string;
}

const IMAGE_KEY = /\/[0-2]\.(png|jpg|gif|webp|bmp|avif)$/;
const FILE_KEY = /\/[0-2]\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/;

const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

/**
 * A browser file name reduced to one key segment: letters, digits, dot, dash
 * and underscore, starting with a letter or digit, at most 100 characters with
 * the extension kept.
 */
export function safeBugReportAttachmentName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[^A-Za-z0-9]+/, "");
  if (!cleaned) return "file";
  if (cleaned.length <= 100) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 11 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, 100 - ext.length) + ext;
}

/** The video type for a file name, when browsers can play it inline. */
export function bugReportVideoMime(name: string): string | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  return ext ? VIDEO_MIME[ext] ?? null : null;
}

export function describeBugReportAttachmentKey(key: string): { kind: BugReportAttachmentKind; name: string } | null {
  const image = IMAGE_KEY.exec(key);
  if (image) return { kind: "image", name: key.split("/").at(-1) ?? "" };
  const file = FILE_KEY.exec(key);
  if (!file) return null;
  const name = file[1]!;
  return { kind: bugReportVideoMime(name) ? "video" : "file", name };
}
