import { useEffect, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { ImagePlus, X } from "lucide-react";
import {
  REPLAY_CUSTOM_MEDIA_KINDS,
  REPLAY_CUSTOM_MEDIA_KIND_LABELS,
  guessReplayCustomMediaKind,
  hasReplayCustomMediaSource,
  normalizeReplayCustomMedia,
  normalizeReplayCustomMediaUrl,
  type ReplayCustomMedia,
  type ReplayOverlayPlacement,
} from "#/lib/replay-overlays";
import { REPLAY_CUSTOM_MEDIA_MAX_FILE_BYTES, canReadReplayCustomMediaLink, resolveReplayCustomMediaUrl, saveReplayCustomMediaFile } from "#/lib/replay-custom-media";
import { ReplayOptionChip, ReplayOptionChips } from "./ReplayOptionChip";

const FIELD = "h-8 rounded-md border border-osu-b3/60 bg-osu-b5/70 px-2.5 text-xs font-semibold text-white outline-none transition-colors placeholder:font-normal placeholder:text-osu-f1/60 focus:border-osu-pink/70";

export function ReplayCustomMediaControls({ placement, onChange }: { placement: ReplayOverlayPlacement; onChange: (patch: Partial<ReplayOverlayPlacement>) => void }) {
  const { t, i18n } = useLingui();
  const media = normalizeReplayCustomMedia(placement.media);
  const update = (patch: Partial<ReplayCustomMedia>) => onChange({ media: { ...media, ...patch }, ...(patch.url || patch.fileId ? { enabled: true } : {}) });
  const [link, setLink] = useState(media.url);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => setLink(media.url), [media.url]);
  // An exported video has to read the link's bytes, which its site may not allow.
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const probeUrl = media.url;
  useEffect(() => {
    if (!probeUrl) return;
    const controller = new AbortController();
    void canReadReplayCustomMediaLink(probeUrl, controller.signal).then((readable) => {
      if (!controller.signal.aborted) setUnreadable(readable ? null : probeUrl);
    });
    return () => controller.abort();
  }, [probeUrl]);

  const commitLink = (value: string) => {
    const url = normalizeReplayCustomMediaUrl(value);
    if (!value.trim()) {
      setError(null);
      if (media.url) update({ url: "" });
      return;
    }
    if (!url) {
      setError(t`That link does not work here. Use an http or https link.`);
      return;
    }
    setError(null);
    if (url !== media.url || media.fileId) update({ url, fileId: undefined, fileName: undefined, kind: guessReplayCustomMediaKind(url) });
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > REPLAY_CUSTOM_MEDIA_MAX_FILE_BYTES) {
      setError(t`That file is over 200 MB.`);
      return;
    }
    const fileId = await saveReplayCustomMediaFile(file);
    if (!fileId) {
      setError(t`The browser would not store that file.`);
      return;
    }
    setError(null);
    update({ url: "", fileId, fileName: file.name, kind: guessReplayCustomMediaKind(file.name, file.type) });
  };

  return (
    <div className="space-y-2.5 text-[11px]">
      {media.fileId ? (
        <div className="flex h-8 items-center gap-2 rounded-md bg-white/[0.05] pl-2.5 pr-1">
          <span className="min-w-0 flex-1 truncate font-semibold text-white">{media.fileName ?? t`Local file`}</span>
          <button
            type="button"
            onClick={() => update({ fileId: undefined, fileName: undefined })}
            aria-label={t`Remove file`}
            className="grid h-6 w-6 cursor-pointer place-items-center rounded text-osu-f1 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex gap-1.5">
          <input
            type="url"
            inputMode="url"
            value={link}
            placeholder="https://"
            onChange={(event) => setLink(event.target.value)}
            onBlur={(event) => commitLink(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitLink(event.currentTarget.value);
            }}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData("text");
              if (!pasted) return;
              event.preventDefault();
              setLink(pasted.trim());
              commitLink(pasted);
            }}
            aria-label={t`Link`}
            className={`${FIELD} min-w-0 flex-1`}
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-white/[0.05] px-2.5 font-semibold text-osu-l1 transition-colors hover:bg-white/[0.09] hover:text-white"
          >
            <ImagePlus className="h-3.5 w-3.5" />
            <Trans>File</Trans>
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*,video/*"
            className="hidden"
            onChange={(event) => {
              void pickFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>
      )}
      {error && <p className="leading-snug text-[#ff8a8a]">{error}</p>}
      {!error && probeUrl && unreadable === probeUrl && (
        <p className="leading-snug text-osu-f1"><Trans>Exported videos can't use this link because its site blocks it. Save the file and pick it instead.</Trans></p>
      )}
      <ReplayOptionChips>
        {REPLAY_CUSTOM_MEDIA_KINDS.map((kind) => (
          <ReplayOptionChip key={kind} checked={media.kind === kind} onChange={() => update({ kind })}>
            {i18n._(REPLAY_CUSTOM_MEDIA_KIND_LABELS[kind])}
          </ReplayOptionChip>
        ))}
      </ReplayOptionChips>
      <label className="block">
        <span className="flex items-center justify-between gap-2">
          <span><Trans>Opacity</Trans></span>
          <span className="tabular-nums text-osu-l1">{Math.round(media.opacity * 100)}%</span>
        </span>
        <input
          type="range"
          min={10}
          max={100}
          step={5}
          value={Math.round(media.opacity * 100)}
          onChange={(event) => update({ opacity: Number(event.target.value) / 100 })}
          className="mt-1.5 block w-full cursor-pointer accent-osu-pink"
        />
      </label>
    </div>
  );
}

// The gallery card shows the media itself.
export function ReplayCustomMediaPreview({ media }: { media: ReplayCustomMedia | undefined }) {
  const normalized = normalizeReplayCustomMedia(media);
  const { kind, url: link, fileId, opacity } = normalized;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!hasReplayCustomMediaSource(normalized)) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void resolveReplayCustomMediaUrl(normalized).then((resolved) => {
      if (!resolved) return;
      if (resolved.objectUrl) objectUrl = resolved.url;
      if (cancelled) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        return;
      }
      setUrl(resolved.url);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // The source is all that matters; normalized is rebuilt every render.
  }, [link, fileId]);

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden" aria-hidden="true">
      {!url ? (
        <ImagePlus className="h-8 w-8 text-white/15" strokeWidth={1.5} />
      ) : kind === "image" ? (
        <img src={url} alt="" referrerPolicy="no-referrer" draggable={false} className="max-h-[84%] max-w-[84%] object-contain" style={{ opacity }} />
      ) : (
        <video src={url} autoPlay muted loop playsInline className="max-h-[84%] max-w-[84%] object-contain" style={{ opacity }} />
      )}
    </div>
  );
}
