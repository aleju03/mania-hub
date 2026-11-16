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

const SCRATCH_EXPORT_FILE = "share-clip-export";

/** True where the browser has private storage a share export can render into. */
export function supportsScratchExportFile(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

/**
 * A file in the origin's private storage, for an export that is only going
 * to be shared as a link: no save dialog, nothing in the user's folders. One
 * fixed name, so an export left behind by a closed tab is overwritten by the
 * next one. Null where the browser has no such storage.
 */
export async function requestScratchExportFileHandle(): Promise<FileSystemFileHandle | null> {
  if (!supportsScratchExportFile()) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getFileHandle(SCRATCH_EXPORT_FILE, { create: true });
  } catch {
    return null;
  }
}

/** Deletes the scratch file once its export has been shared or dropped. */
export async function clearScratchExportFile(): Promise<void> {
  if (!supportsScratchExportFile()) return;
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(SCRATCH_EXPORT_FILE);
  } catch {
    // Already gone, or storage is unavailable: nothing to free either way.
  }
}
