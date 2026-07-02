import { Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { importReplaySkinFromOsk, type ReplaySkinImportResult } from "../../lib/replay-skin-import";
import { loadSkinPreviewBackground, renderSkinPreview } from "../../lib/skin-preview-render";
import {
  finishSkinUpload,
  formatSkinFileSize,
  SKIN_DESCRIPTION_MAX_LENGTH,
  SKIN_MAX_SCREENSHOTS,
  SKIN_OSK_MAX_BYTES,
  SKIN_SCREENSHOT_MAX_BYTES,
  SkinUploadError,
  startSkinUpload,
  uploadErrorMessage,
  uploadSkinPart,
  type SkinSummary,
} from "../../lib/skins";

// The publish flow, entirely client-driven: parse the .osk in the browser
// (jszip via the replay-skin importer), compose the preview on a canvas, then
// stream preview + screenshots + the .osk itself straight to the live backend
// against a ticket minted through the authenticated server fn.

type UploadStep = "pick" | "form" | "uploading" | "done";

interface ProcessedScreenshot {
  blob: Blob;
  width: number;
  height: number;
  url: string;
}

interface RenderedPreview {
  blob: Blob;
  width: number;
  height: number;
  url: string;
  accent: string;
}

interface UploadTicket {
  id: string;
  token: string;
}

const DROP_TRIANGLES = [
  { points: "128,-90 0,132 256,132", opacity: 0.2 },
  { points: "384,-90 256,132 512,132", opacity: 0.11 },
  { points: "512,132 384,-90 640,-90", opacity: 0.16 },
  { points: "256,354 128,132 384,132", opacity: 0.15 },
  { points: "640,132 512,354 768,354", opacity: 0.18 },
  { points: "0,354 -128,132 128,132", opacity: 0.12 },
  { points: "192,21 320,21 256,132", opacity: 0.2 },
  { points: "384,132 320,243 448,243", opacity: 0.17 },
];

export function SkinUploadPanel({
  onPublished,
  onClose,
}: {
  onPublished: (skin: SkinSummary) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<UploadStep>("pick");
  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [imported, setImported] = useState<ReplaySkinImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selectedKeymode, setSelectedKeymode] = useState(4);
  // One rendered playfield per keymode; the selected keymode is the cover.
  const [previews, setPreviews] = useState<Map<number, RenderedPreview>>(new Map());
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewUrlsRef = useRef<string[]>([]);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [screenshots, setScreenshots] = useState<ProcessedScreenshot[]>([]);

  const ticketRef = useRef<UploadTicket | null>(null);
  // One random map cover per picked file, shared by every keymode render so
  // switching keymodes never swaps the backdrop.
  const backgroundRef = useRef<Promise<HTMLImageElement | null> | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, label: "" });
  const [published, setPublished] = useState<SkinSummary | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const screenshotInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    screenshots.forEach((shot) => URL.revokeObjectURL(shot.url));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOskFiles = useCallback(async (files: FileList | null) => {
    const picked = files?.[0];
    if (!picked) return;
    setError(null);
    if (picked.size > SKIN_OSK_MAX_BYTES) {
      setError(`This file is ${formatSkinFileSize(picked.size)}. The limit is 50 MB.`);
      return;
    }
    try {
      const result = await importReplaySkinFromOsk(picked, { targetKeyCount: 4 });
      setFile(picked);
      setImported(result);
      setName(result.summary.name.slice(0, 80));
      setDescription("");
      const keymodes = result.summary.keymodes;
      setSelectedKeymode(keymodes.includes(4) ? 4 : keymodes[0] ?? 4);
      previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      previewUrlsRef.current = [];
      setPreviews(new Map());
      ticketRef.current = null;
      backgroundRef.current = loadSkinPreviewBackground();
      setStep("form");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "This .osk could not be read.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, []);

  // Render every supported keymode once per picked file (4K first so the hero
  // fills fast); switching keymodes afterwards just swaps images.
  useEffect(() => {
    if (!imported) return;
    let cancelled = false;
    setPreviewBusy(true);
    (async () => {
      const background = await Promise.resolve(backgroundRef.current).catch(() => null);
      const keymodes = [...imported.summary.keymodes].sort((a, b) => (a === 4 ? -1 : b === 4 ? 1 : a - b));
      for (const keys of keymodes) {
        if (cancelled) return;
        const render = await renderSkinPreview(imported.settings, keys, { background });
        if (cancelled) return;
        const url = URL.createObjectURL(render.blob);
        previewUrlsRef.current.push(url);
        setPreviews((previous) => new Map(previous).set(keys, { blob: render.blob, width: render.width, height: render.height, url, accent: render.accent }));
      }
    })()
      .catch(() => {
        if (!cancelled) setError("The previews could not be rendered.");
      })
      .finally(() => {
        if (!cancelled) setPreviewBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [imported]);

  const addScreenshots = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    const room = SKIN_MAX_SCREENSHOTS - screenshots.length;
    const picked = [...files].slice(0, room);
    const processed: ProcessedScreenshot[] = [];
    for (const shot of picked) {
      const result = await processScreenshot(shot).catch(() => null);
      if (result) processed.push(result);
      else setError("A screenshot could not be read as a PNG, JPEG, or WebP under 4 MB.");
    }
    if (processed.length > 0) setScreenshots((previous) => [...previous, ...processed]);
    if (screenshotInputRef.current) screenshotInputRef.current.value = "";
  }, [screenshots.length]);

  const removeScreenshot = useCallback((index: number) => {
    setScreenshots((previous) => {
      const removed = previous[index];
      if (removed) URL.revokeObjectURL(removed.url);
      return previous.filter((_, i) => i !== index);
    });
  }, []);

  const publish = useCallback(async () => {
    const previewEntries = [...previews.entries()].sort(([a], [b]) => a - b);
    if (!file || previewEntries.length === 0 || !previews.get(selectedKeymode)) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("The skin needs a name.");
      return;
    }
    setError(null);
    setProgress({ done: 0, total: 0, label: "Preparing the upload." });
    setStep("uploading");
    try {
      // Reuse a still-valid ticket across retries so a network blip does not
      // burn the per-user pending-upload budget.
      if (!ticketRef.current) {
        const started = await startSkinUpload({ data: { name: trimmedName, description: description.trim() } });
        if (!started.ok) {
          setStep("form");
          setError(startErrorMessage(started.error));
          return;
        }
        ticketRef.current = { id: started.id, token: started.token };
      }
      const ticket = ticketRef.current;
      const totalBytes = previewEntries.reduce((sum, [, preview]) => sum + preview.blob.size, 0)
        + screenshots.reduce((sum, shot) => sum + shot.blob.size, 0)
        + file.size;
      let doneBytes = 0;
      const report = (label: string, sent: number) => setProgress({ done: doneBytes + sent, total: totalBytes, label });

      for (const [keys, preview] of previewEntries) {
        const label = `Uploading the ${keys}K preview.`;
        report(label, 0);
        await uploadSkinPart({
          id: ticket.id,
          token: ticket.token,
          part: "preview",
          blob: preview.blob,
          width: preview.width,
          height: preview.height,
          keys,
          cover: keys === selectedKeymode,
          accent: keys === selectedKeymode ? preview.accent : undefined,
          onProgress: (sent) => report(label, sent),
        });
        doneBytes += preview.blob.size;
      }

      for (let index = 0; index < screenshots.length; index += 1) {
        const shot = screenshots[index];
        const label = `Uploading screenshot ${index + 1} of ${screenshots.length}.`;
        report(label, 0);
        await uploadSkinPart({
          id: ticket.id,
          token: ticket.token,
          part: "screenshot",
          blob: shot.blob,
          width: shot.width,
          height: shot.height,
          onProgress: (sent) => report(label, sent),
        });
        doneBytes += shot.blob.size;
      }

      const oskLabel = (sent: number) =>
        `Uploading the skin file, ${formatSkinFileSize(sent) || "0 MB"} of ${formatSkinFileSize(file.size)}.`;
      report(oskLabel(0), 0);
      await uploadSkinPart({
        id: ticket.id,
        token: ticket.token,
        part: "osk",
        blob: file,
        onProgress: (sent) => report(oskLabel(sent), sent),
      });
      doneBytes += file.size;
      report("Publishing.", 0);

      const skin = await finishSkinUpload(ticket.id, ticket.token);
      setPublished(skin);
      setStep("done");
      onPublished(skin);
    } catch (uploadError) {
      if (uploadError instanceof SkinUploadError) {
        if (uploadError.code === "invalid_ticket") ticketRef.current = null;
        setError(uploadError.message);
      } else {
        setError(uploadErrorMessage("upload_failed"));
      }
      setStep("form");
    }
  }, [file, name, description, onPublished, previews, screenshots, selectedKeymode]);

  if (step === "done" && published) {
    return (
      <PanelShell onClose={onClose}>
        <div className="flex flex-col items-center gap-3 py-5 text-center">
          {published.previewUrl && (
            <img
              src={published.previewUrl}
              alt={`${published.name} cover`}
              className="aspect-video w-full max-w-[420px] rounded-lg border border-osu-b3/40 object-cover"
            />
          )}
          <div className="text-sm font-bold text-white">{published.name} is live.</div>
          <div className="text-[12px] text-osu-f1">
            {published.keymodes.length > 1
              ? `Previews for ${published.keymodes.map((keys) => `${keys}K`).join(", ")} are on the skin page.`
              : "The skin page is ready to share."}
          </div>
          <div className="flex items-center gap-3">
            <a
              href={`/skins/${published.slug ?? published.id}`}
              className="rounded-full bg-osu-pink px-5 py-2 text-[13px] font-bold text-white transition hover:brightness-110"
            >
              View the skin page
            </a>
            <button
              type="button"
              onClick={() => {
                setPublished(null);
                setFile(null);
                setImported(null);
                setError(null);
                setStep("pick");
              }}
              className="text-[12px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l1"
            >
              Upload another
            </button>
          </div>
        </div>
      </PanelShell>
    );
  }

  if (step === "pick") {
    return (
      <PanelShell onClose={onClose}>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            setDragActive(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragActive(false);
            void handleOskFiles(event.dataTransfer.files);
          }}
          className={`relative block w-full overflow-hidden rounded-xl border transition-colors cursor-pointer ${
            dragActive ? "border-osu-pink/70 bg-osu-b5" : "border-osu-b3/60 bg-osu-b4 hover:border-osu-pink/45"
          }`}
        >
          <svg
            viewBox="0 0 640 260"
            preserveAspectRatio="xMidYMid slice"
            className={`pointer-events-none absolute inset-0 h-full w-full transition-[color,opacity] duration-150 ${
              dragActive ? "text-osu-pink-light opacity-100" : "text-osu-pink opacity-80"
            }`}
            aria-hidden="true"
          >
            {DROP_TRIANGLES.map((triangle, index) => (
              <polygon key={index} points={triangle.points} fill="currentColor" fillOpacity={triangle.opacity} />
            ))}
          </svg>
          <div className="relative z-10 flex min-h-[196px] flex-col items-center justify-center gap-2.5 px-6 py-10 text-center">
            <Upload
              className={`h-8 w-8 transition-colors ${dragActive ? "text-osu-pink-light" : "text-osu-f1"}`}
              aria-hidden="true"
            />
            <div>
              <div className="text-sm font-semibold text-white">
                {dragActive ? "Drop to read it" : "Drop an .osk here, or click to browse"}
              </div>
              <div className="mt-1 text-[11px] text-osu-f1">Up to 50 MB.</div>
            </div>
          </div>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".osk,.zip,application/zip"
          className="sr-only"
          onChange={(event) => void handleOskFiles(event.target.files)}
        />
        {error && <div className="mt-3 text-center text-[12px] font-semibold text-osu-red-light">{error}</div>}
      </PanelShell>
    );
  }

  const keymodes = imported?.summary.keymodes ?? [];
  const uploading = step === "uploading";
  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const heroPreview = previews.get(selectedKeymode);
  const summary = imported?.summary;
  const contentsLine = summary
    ? [
        `${summary.noteAssets} note images`,
        `${summary.receptorAssets} key images`,
        summary.comboDigits > 0 ? "combo font" : null,
        summary.judgementAssets > 0 ? "judgements" : null,
        summary.soundAssets > 0 ? `${summary.soundAssets} hitsounds` : null,
      ].filter(Boolean).join(" · ")
    : "";

  return (
    <PanelShell onClose={uploading ? undefined : onClose}>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0">
          <div className="relative overflow-hidden rounded-xl border border-osu-b3/40 bg-osu-b5">
            <div className="aspect-video w-full">
              {heroPreview ? (
                <img src={heroPreview.url} alt={`${selectedKeymode}K preview`} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center text-[12px] text-osu-f1">Rendering the {selectedKeymode}K playfield...</div>
              )}
            </div>
          </div>
          {/* Every keymode read from the skin, rendered with the skin's own
              notes; the selected one becomes the browse-card cover. */}
          <div className="mt-2.5 flex flex-wrap items-start gap-2">
            {keymodes.map((keys) => {
              const preview = previews.get(keys);
              const selected = selectedKeymode === keys;
              return (
                <button
                  key={keys}
                  type="button"
                  disabled={uploading}
                  onClick={() => setSelectedKeymode(keys)}
                  aria-pressed={selected}
                  className={`w-[104px] overflow-hidden rounded-lg border text-left transition-colors duration-100 cursor-pointer disabled:cursor-default ${
                    selected ? "border-osu-pink" : "border-osu-b3/40 hover:border-osu-f1/40"
                  }`}
                >
                  <div className="aspect-video w-full bg-osu-b5">
                    {preview ? (
                      <img src={preview.url} alt={`${keys}K thumbnail`} className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center text-[10px] text-osu-f1/60">rendering</div>
                    )}
                  </div>
                  <div className={`px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums ${selected ? "bg-osu-pink text-white" : "bg-osu-b4 text-osu-l2"}`}>
                    {keys}K{selected ? " · cover" : ""}
                  </div>
                </button>
              );
            })}
          </div>
          {contentsLine && (
            <div className="mt-2 text-[11px] text-osu-f1" title="Read from the skin file">
              {contentsLine}
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-3.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">Name</span>
            <input
              type="text"
              value={name}
              maxLength={80}
              disabled={uploading}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded-lg border border-osu-b3/30 bg-osu-b5 px-3 py-2 text-[13.5px] text-osu-l1 transition-colors focus:border-osu-pink/50 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
              Description <span className="normal-case tracking-normal text-osu-f1/70">(optional)</span>
            </span>
            <textarea
              value={description}
              maxLength={SKIN_DESCRIPTION_MAX_LENGTH}
              rows={3}
              disabled={uploading}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What the skin is for, what changed in this edit..."
              className="w-full resize-y rounded-lg border border-osu-b3/30 bg-osu-b5 px-3 py-2 text-[13px] leading-relaxed text-osu-l1 transition-colors placeholder:text-osu-f1/45 focus:border-osu-pink/50 focus:outline-none"
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
              Screenshots <span className="normal-case tracking-normal text-osu-f1/70">(optional, up to {SKIN_MAX_SCREENSHOTS})</span>
            </span>
            <div className="flex flex-wrap gap-2">
              {screenshots.map((shot, index) => (
                <div key={shot.url} className="relative h-14 w-[99px] overflow-hidden rounded-md border border-osu-b3/40">
                  <img src={shot.url} alt={`Screenshot ${index + 1}`} className="h-full w-full object-cover" />
                  {!uploading && (
                    <button
                      type="button"
                      onClick={() => removeScreenshot(index)}
                      aria-label={`Remove screenshot ${index + 1}`}
                      className="absolute right-0.5 top-0.5 rounded bg-osu-b5/85 p-0.5 text-osu-l2 transition-colors cursor-pointer hover:text-white"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
              {screenshots.length < SKIN_MAX_SCREENSHOTS && !uploading && (
                <button
                  type="button"
                  onClick={() => screenshotInputRef.current?.click()}
                  className="flex h-14 w-[99px] items-center justify-center rounded-md border border-dashed border-osu-b3/60 text-[20px] font-light text-osu-f1 transition-colors cursor-pointer hover:border-osu-pink/45 hover:text-osu-l2"
                  aria-label="Add screenshots"
                >
                  +
                </button>
              )}
            </div>
            <input
              ref={screenshotInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              className="sr-only"
              onChange={(event) => void addScreenshots(event.target.files)}
            />
          </div>

          <div className="mt-auto flex flex-col gap-2.5 pt-1">
            {error && <div className="text-[12px] font-semibold text-osu-red-light">{error}</div>}
            {uploading ? (
              <div className="flex flex-col gap-1.5">
                <div className="h-2 overflow-hidden rounded-full bg-osu-b5">
                  <div className="h-full bg-osu-pink transition-[width] duration-150" style={{ width: `${percent}%` }} />
                </div>
                <div className="flex items-baseline justify-between gap-2 text-[11.5px] text-osu-f1">
                  <span className="truncate">{progress.label}</span>
                  <span className="shrink-0 tabular-nums">{percent}%</span>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => void publish()}
                  disabled={previewBusy || !heroPreview}
                  className="rounded-full bg-osu-pink px-6 py-2 text-[13px] font-bold text-white transition cursor-pointer hover:brightness-110 disabled:cursor-default disabled:opacity-50"
                >
                  Upload skin
                </button>
                <button
                  type="button"
                  onClick={() => setStep("pick")}
                  className="text-[12px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l1"
                >
                  Pick a different file
                </button>
                {file && <span className="text-[11px] text-osu-f1 tabular-nums">{formatSkinFileSize(file.size)}</span>}
              </div>
            )}
          </div>
        </div>
      </div>
    </PanelShell>
  );
}

function PanelShell({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  // The close control lives in its own header row (not overlaid on the
  // dropzone) so it never fights the upload button for clicks.
  return (
    <section className="rounded-2xl border border-osu-b3/30 bg-osu-b4 p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-osu-pink-light">upload a skin</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2.5 py-1 text-[12px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:bg-osu-b3 hover:text-osu-l1"
          >
            Close
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function startErrorMessage(code: "not_logged_in" | "unavailable" | "storage_not_configured" | "invalid_name" | "pending_limit" | "skin_limit"): string {
  switch (code) {
    case "not_logged_in":
      return "The session expired. Log in with osu! again to publish.";
    case "invalid_name":
      return "The skin needs a name.";
    case "pending_limit":
      return "An upload is already in progress. Finish it or wait a few minutes.";
    case "skin_limit":
      return "The limit of 30 published skins per account is reached.";
    case "storage_not_configured":
      return "Skin storage is not configured on the server (R2 credentials are missing).";
    default:
      return "Uploads are not available right now.";
  }
}

async function processScreenshot(file: File): Promise<ProcessedScreenshot | null> {
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await decodeImage(sourceUrl);
    const scale = Math.min(1, 1920 / Math.max(1, image.naturalWidth));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((webp) => {
        if (webp && webp.type === "image/webp") resolve(webp);
        else canvas.toBlob((png) => resolve(png), "image/png");
      }, "image/webp", 0.85);
    });
    if (!blob || blob.size > SKIN_SCREENSHOT_MAX_BYTES) return null;
    return { blob, width, height, url: URL.createObjectURL(blob) };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode image."));
    image.src = src;
  });
}
