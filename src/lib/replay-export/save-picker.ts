// The save dialog, kept apart from the muxing code on purpose.
//
// The replay route calls this straight from the export click, before any
// awaited work, so the picker still has the page's transient activation. It
// must therefore not drag the encoder or its WASM into the bundle that the
// button lives in.

import { ReplayExportError } from "./errors";

/** True where the browser can write straight to a file the user picks. */
export function supportsFileSystemAccess(): boolean {
  return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";
}

/**
 * Opens the save dialog. Must be called straight from the click that starts
 * the export: any awaited preparation first would have consumed the
 * transient activation the picker needs.
 *
 * Returns null when the user dismisses the dialog, which is an ordinary
 * cancellation rather than a failed export.
 */
export async function requestExportFileHandle(
  suggestedName: string,
  extension: "mp4" | "webm",
): Promise<FileSystemFileHandle | null> {
  const picker = typeof window !== "undefined" ? window.showSaveFilePicker : undefined;
  if (!picker) return null;
  try {
    return await picker({
      suggestedName,
      id: "mania-hub-replay-export",
      startIn: "videos",
      types: [
        {
          description: extension === "mp4" ? "MP4 video" : "WebM video",
          accept: { [extension === "mp4" ? "video/mp4" : "video/webm"]: [`.${extension}`] },
        },
      ],
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw new ReplayExportError(
      "storage_unavailable",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}
