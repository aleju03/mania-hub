import { useCallback, useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";

import { BUG_REPORT_MAX_SCREENSHOTS } from "./bug-reports";
import { MAX_IMAGE_UPLOAD_BYTES, isUploadableImage } from "./catbox-upload";

/* The browser half of a bug report's images, shared by the reporter's form and
   thread on /report and by the owner's reply on /admin/bug-reports.

   All three write the same way: the words are stored first, the row that stored
   them hands back an upload ticket, and the images follow one at a time against
   it. Only the rules and the plumbing live here; each surface renders its own
   strip of thumbnails, because a picker inside a bubble and a picker inside an
   admin field are not the same control. */

export type BugReportUploadStatus = "waiting" | "uploading" | "done" | "failed";

/**
 * The images waiting to go with what is being written. Every surface refuses
 * the same things (three at a time, images only, under the shared size cap) and
 * every one wants a local preview, so none of them owns the rules.
 */
export function useBugReportScreenshots() {
  const { t } = useLingui();
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setPreviews(urls);
    return () => { urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [files]);

  const add = useCallback((picked: FileList | File[] | null) => {
    if (!picked) return;
    const incoming = Array.from(picked);
    if (!incoming.length) return;
    setError(null);
    setFiles((current) => {
      const next = [...current];
      for (const file of incoming) {
        if (next.length >= BUG_REPORT_MAX_SCREENSHOTS) {
          setError(t`Up to ${BUG_REPORT_MAX_SCREENSHOTS} images.`);
          break;
        }
        if (!isUploadableImage(file)) {
          setError(t`That file is not an image.`);
          continue;
        }
        if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
          setError(t`Images have to be under 5MB.`);
          continue;
        }
        next.push(file);
      }
      return next;
    });
  }, [t]);

  const removeAt = useCallback((index: number) => {
    setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }, []);

  const clear = useCallback(() => {
    setFiles([]);
    setError(null);
  }, []);

  return { files, previews, error, setError, add, removeAt, clear };
}

/** The images on a clipboard paste, if that is what was pasted. */
export function imagesFromClipboard(event: React.ClipboardEvent): File[] {
  return Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

/**
 * Uploads run one at a time against the ticket the write handed back: the
 * report's own at submit, or the message's when the images ride a reply. A
 * failure is not fatal: the words are already stored, and they are the part
 * that matters.
 */
export async function uploadBugReportScreenshots(
  id: string,
  token: string,
  files: File[],
  onProgress: (index: number, status: BugReportUploadStatus) => void,
  messageId?: string,
): Promise<number> {
  const message = messageId ? `&messageId=${encodeURIComponent(messageId)}` : "";
  let uploaded = 0;
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!;
    onProgress(index, "uploading");
    try {
      const response = await fetch(
        `/api/bug-report-upload?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}&index=${index}${message}`,
        { method: "POST", headers: { "content-type": file.type || "image/png" }, body: file },
      );
      if (response.ok) {
        uploaded += 1;
        onProgress(index, "done");
      } else {
        onProgress(index, "failed");
      }
    } catch {
      onProgress(index, "failed");
    }
  }
  return uploaded;
}
