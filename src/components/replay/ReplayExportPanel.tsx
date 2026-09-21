import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, Download, Film, X } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

import { describeReplayExportError, isRetryableExportError } from "#/lib/replay-export/errors";
import { peekReplayExportManager } from "#/lib/replay-export/manager";
import { useReplayExportJob } from "#/lib/replay-export/use-replay-export-job";
import type { ReplayExportJobView } from "#/lib/replay-export/types";
import { formatBytes } from "#/lib/format";

// The export's only permanent surface. It lives in the app shell rather than
// on /replay, because the job it reports on outlives that route: the point of
// the whole design is that you can walk off to a profile page and come back
// to a finished file.

export function ReplayExportPanel() {
  const { t, i18n } = useLingui();
  const job = useReplayExportJob();
  const [collapsed, setCollapsed] = useState(false);
  const lastAnnouncedRef = useRef<string>("");
  const [announcement, setAnnouncement] = useState("");

  const phase = job?.phase ?? null;

  useEffect(() => {
    // Collapsing is a per-job choice; a new export opens the panel again.
    if (phase === "preparing") setCollapsed(false);
  }, [phase, job?.id]);

  // Screen readers get phase changes, not every percent.
  useEffect(() => {
    if (!job) return;
    const key = `${job.id}:${job.phase}`;
    if (lastAnnouncedRef.current === key) return;
    lastAnnouncedRef.current = key;
    setAnnouncement(i18n._(phaseLabel(job.phase)));
  }, [job, i18n]);

  const onCancel = useCallback(() => {
    peekReplayExportManager()?.cancel();
  }, []);

  const onDismiss = useCallback(() => {
    peekReplayExportManager()?.dismiss();
  }, []);

  const onDownload = useCallback(() => {
    const manager = peekReplayExportManager();
    const url = manager?.view?.result?.downloadUrl;
    const filename = manager?.view?.result?.filename;
    if (!manager || !url || !filename) return;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // A click on an anchor is not proof the user now has a durable copy.
    manager.markDownloadStarted();
  }, []);

  const active = job
    ? job.phase === "preparing" || job.phase === "rendering" || job.phase === "finalizing"
    : false;
  const cancelling = job?.phase === "cancelling";
  const failed = job?.phase === "failed";
  const percent = Math.round((job?.progress ?? 0) * 100);

  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
      <AnimatePresence>
        {job && (
          <motion.div
            key={job.id}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.16 }}
            className="fixed bottom-4 right-4 z-[90] w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-osu-b2 bg-osu-b3 p-3 text-[12px] text-osu-f0 shadow-2xl"
          >
            <div className="flex items-center gap-2">
              <Film className="h-4 w-4 shrink-0 text-osu-pink-light" strokeWidth={2.2} />
              <span className="min-w-0 flex-1 truncate font-semibold text-white">{job.title}</span>
              <button
                type="button"
                onClick={() => setCollapsed((value) => !value)}
                aria-expanded={!collapsed}
                aria-label={collapsed ? t`Show export details` : t`Hide export details`}
                className="cursor-pointer rounded p-0.5 text-osu-f1 transition-colors hover:text-white"
              >
                <ChevronDown className={`h-4 w-4 transition-transform ${collapsed ? "rotate-180" : ""}`} strokeWidth={2.2} />
              </button>
              {!active && !cancelling && (
                <button
                  type="button"
                  onClick={onDismiss}
                  aria-label={t`Dismiss`}
                  className="cursor-pointer rounded p-0.5 text-osu-f1 transition-colors hover:text-white"
                >
                  <X className="h-4 w-4" strokeWidth={2.2} />
                </button>
              )}
            </div>

            {!collapsed && (
              <div className="mt-2 space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-osu-f1">{i18n._(phaseLabel(job.phase))}</span>
                  {(active || cancelling) && <span className="tabular-nums font-semibold text-white">{percent}%</span>}
                </div>

                {(active || cancelling) && (
                  <div className="h-1 w-full overflow-hidden rounded-full bg-osu-b4">
                    <div
                      className="h-full rounded-full bg-osu-pink transition-[width] duration-150"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                )}

                {job.phase === "rendering" && job.frameCount > 0 && (
                  <div className="tabular-nums text-osu-f1">
                    {job.framesCompleted.toLocaleString("en-US")} / {job.frameCount.toLocaleString("en-US")} {t`frames`}
                  </div>
                )}

                {job.result && (
                  <div className="tabular-nums text-osu-f1">
                    {job.result.filename} · {formatBytes(job.result.byteLength)}
                  </div>
                )}

                {job.warnings.includes("audio-decode-skipped") && (
                  <div className="text-osu-yellow">{t`Some hitsound samples couldn't be decoded and were left out.`}</div>
                )}
                {job.warnings.includes("container-fallback") && (
                  <div className="text-osu-yellow">{t`MP4 isn't available here, so the file is WebM.`}</div>
                )}
                {job.warnings.includes("hidden-while-exporting") && active && (
                  <div className="text-osu-f1">{t`This tab went to the background, which can pause the export.`}</div>
                )}

                {failed && job.errorCode && (
                  <div className="text-red-200">{i18n._(describeReplayExportError(job.errorCode))}</div>
                )}
                {job.phase === "cancelled" && <div className="text-osu-f1">{t`Export cancelled.`}</div>}

                {active && (
                  <p className="text-[11px] leading-tight text-osu-f1">
                    {t`The video is created on your device. You can browse other pages while it exports. Keep this tab open; refreshing or closing it will cancel the unfinished export.`}
                  </p>
                )}

                <div className="flex gap-1.5">
                  {(active || cancelling) && (
                    <button
                      type="button"
                      onClick={onCancel}
                      disabled={cancelling}
                      className="flex-1 cursor-pointer rounded bg-osu-b4 px-2 py-1.5 text-[11px] font-semibold text-osu-f0 transition-colors hover:text-white disabled:cursor-default disabled:opacity-60"
                    >
                      {cancelling ? t`Cancelling` : t`Cancel`}
                    </button>
                  )}
                  {job.phase === "ready" && (
                    <button
                      type="button"
                      onClick={onDownload}
                      className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded bg-osu-pink px-2 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-osu-pink-light"
                    >
                      <Download className="h-3.5 w-3.5" strokeWidth={2.4} />
                      {t`Download`}
                    </button>
                  )}
                  {job.phase === "download-started" && (
                    <button
                      type="button"
                      onClick={onDownload}
                      className="flex-1 cursor-pointer rounded bg-osu-b4 px-2 py-1.5 text-[11px] font-semibold text-osu-f0 transition-colors hover:text-white"
                    >
                      {t`Download again`}
                    </button>
                  )}
                  {failed && job.errorCode && isRetryableExportError(job.errorCode) && (
                    <button
                      type="button"
                      onClick={onDismiss}
                      className="flex-1 cursor-pointer rounded bg-osu-b4 px-2 py-1.5 text-[11px] font-semibold text-osu-f0 transition-colors hover:text-white"
                    >
                      {t`Close`}
                    </button>
                  )}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

// Descriptors rather than `t` template literals: this runs outside the
// component, so the caller resolves it against its own i18n instance.
function phaseLabel(phase: ReplayExportJobView["phase"]): MessageDescriptor {
  switch (phase) {
    case "preparing":
      return msg`Preparing`;
    case "rendering":
      return msg`Rendering`;
    case "finalizing":
      return msg`Finishing the file`;
    case "cancelling":
      return msg`Cancelling`;
    case "cancelled":
      return msg`Cancelled`;
    case "failed":
      return msg`Export failed`;
    case "ready":
      return msg`Ready to download`;
    case "saved-to-file":
      return msg`Saved`;
    case "download-started":
      return msg`Download started`;
  }
}
