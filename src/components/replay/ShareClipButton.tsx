import { useEffect, useRef, useState } from "react";
import { Check, Link2 } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

import { useAuth } from "#/lib/auth-context";
import { peekReplayExportManager } from "#/lib/replay-export/manager";
import type { ReplayExportJobView } from "#/lib/replay-export/types";
import {
  captureSharedClipPoster,
  sharedClipPath,
  SHARED_CLIP_MAX_BYTES,
  SHARED_CLIP_TTL_HOURS,
  startSharedClip,
  uploadSharedClip,
  type StartSharedClipResult,
} from "#/lib/shared-clips";
import { useViewerIsSupporter } from "#/lib/viewer-supporter";

/* The supporter perk on a finished export: send the file up and get a link
   that plays inline in Discord for 24 hours (lib/shared-clips.ts). */

type ShareState =
  | { kind: "idle" }
  | { kind: "uploading"; sent: number; total: number }
  | { kind: "done"; url: string; copied: boolean }
  | { kind: "error"; reason: Exclude<StartSharedClipResult, { ok: true }>["error"] | "upload" | "no_file" };

export function ShareClipButton({ job }: { job: ReplayExportJobView }) {
  const { t, i18n } = useLingui();
  const viewer = useAuth().viewer;
  const supporter = useViewerIsSupporter(viewer?.id);
  const [state, setState] = useState<ShareState>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  // A new export starts the button over; leaving the panel stops an upload.
  useEffect(() => {
    setState({ kind: "idle" });
    return () => abortRef.current?.abort();
  }, [job.id]);

  if (!viewer || !supporter || !job.result) return null;
  const tooBig = job.result.byteLength > SHARED_CLIP_MAX_BYTES;

  const share = async () => {
    const manager = peekReplayExportManager();
    const file = await manager?.resultFile();
    if (!file) {
      setState({ kind: "error", reason: "no_file" });
      return;
    }
    setState({ kind: "uploading", sent: 0, total: file.size });
    const contentType = job.container === "webm" ? "video/webm" : "video/mp4";
    const ticket = await startSharedClip({
      data: { title: job.title, replayPath: job.replayPath ?? null, contentType, sizeBytes: file.size, width: job.width, height: job.height },
    }).catch((): StartSharedClipResult => ({ ok: false, error: "unavailable" }));
    if (!ticket.ok) {
      setState({ kind: "error", reason: ticket.error });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const poster = await captureSharedClipPoster(file);
      await uploadSharedClip({
        id: ticket.id,
        token: ticket.token,
        partBytes: ticket.partBytes,
        file: new Blob([file], { type: contentType }),
        poster,
        signal: controller.signal,
        onProgress: (sent, total) => setState({ kind: "uploading", sent, total }),
      });
      const url = new URL(sharedClipPath(ticket.id), window.location.origin).toString();
      const copied = await navigator.clipboard.writeText(url).then(() => true, () => false);
      setState({ kind: "done", url, copied });
    } catch {
      if (controller.signal.aborted) return;
      setState({ kind: "error", reason: "upload" });
    }
  };

  const copy = async () => {
    if (state.kind !== "done") return;
    const copied = await navigator.clipboard.writeText(state.url).then(() => true, () => false);
    setState({ ...state, copied });
  };

  if (state.kind === "done") {
    return (
      <div className="space-y-1">
        <div className="flex gap-1.5">
          <input
            readOnly
            value={state.url}
            onFocus={(event) => event.currentTarget.select()}
            className="min-w-0 flex-1 rounded bg-osu-b5 px-2 py-1.5 text-[11px] text-osu-l2 outline-none"
          />
          <button
            type="button"
            onClick={copy}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded bg-osu-pink/15 px-2 py-1.5 text-[11px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/25"
          >
            {state.copied ? <Check className="h-3.5 w-3.5" strokeWidth={2.4} /> : <Link2 className="h-3.5 w-3.5" strokeWidth={2.4} />}
            {state.copied ? t`Copied` : t`Copy`}
          </button>
        </div>
        <p className="text-[11px] leading-tight text-osu-f1">{t`Paste it in Discord to play the clip in chat. The link works for ${SHARED_CLIP_TTL_HOURS} hours.`}</p>
      </div>
    );
  }

  if (state.kind === "uploading") {
    const percent = state.total > 0 ? Math.round((state.sent / state.total) * 100) : 0;
    return (
      <div className="space-y-1">
        <div className="flex items-baseline justify-between text-osu-f1">
          <span>{t`Uploading the clip`}</span>
          <span className="tabular-nums font-semibold text-white">{percent}%</span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-osu-b4">
          <div className="h-full rounded-full bg-osu-pink transition-[width] duration-150" style={{ width: `${percent}%` }} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={share}
        disabled={tooBig}
        className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded bg-osu-pink/15 px-2 py-1.5 text-[11px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/25 disabled:cursor-default disabled:opacity-50"
      >
        <Link2 className="h-3.5 w-3.5" strokeWidth={2.4} />
        {state.kind === "error" ? t`Try the share link again` : t`Get a share link`}
      </button>
      {tooBig && <p className="text-[11px] leading-tight text-osu-f1">{t`Share links take videos up to 200 MB.`}</p>}
      {state.kind === "error" && <p className="text-[11px] leading-tight text-red-200">{i18n._(shareErrorText(state.reason))}</p>}
    </div>
  );
}

function shareErrorText(reason: Extract<ShareState, { kind: "error" }>["reason"]): MessageDescriptor {
  switch (reason) {
    case "not_supporter":
      return msg`Share links are a supporter perk.`;
    case "daily_limit":
      return msg`That's 10 share links today. Try again tomorrow.`;
    case "too_large":
      return msg`Share links take videos up to 200 MB.`;
    case "no_file":
      return msg`The saved video couldn't be read back. Export it again to share it.`;
    case "not_logged_in":
      return msg`Log in to get a share link.`;
    default:
      return msg`The upload didn't go through.`;
  }
}
