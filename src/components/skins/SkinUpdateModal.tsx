import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, RefreshCw, Star, Upload, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SkinBackdropPicker, useSkinBackdropPool } from "./SkinBackdropPicker";
import { track } from "../../lib/analytics";
import { skinEventProperties } from "../../lib/analytics-skins";
import { importReplaySkinFromOsk, type ReplaySkinImportResult } from "../../lib/replay-skin-import";
import {
  applyBackdropPick,
  backdropForKeymode,
  type BackdropScope,
  type PreviewBackdrop,
} from "../../lib/skin-preview-backdrops";
import { renderSkinPreview } from "../../lib/skin-preview-render";
import {
  type DuplicateSkinRef,
  finishSkinEdit,
  formatSkinFileSize,
  markSkinsListStale,
  SKIN_OSK_MAX_BYTES,
  SkinUploadError,
  startSkinEdit,
  uploadErrorMessage,
  uploadSkinPart,
  type SkinSummary,
} from "../../lib/skins";

// Shipping a newer build of an already published skin: drop the new .osk, the
// modal parses it the way the upload flow does, re-renders a playfield preview
// per keymode the new archive declares, and swaps both on the published row.
// Everything else about the skin - its page, slug, description, download count
// and the links people have shared - stays exactly where it was.
//
// The previews are always re-rendered: the notes are what changed, so keeping
// the old images would leave the skin page showing a build nobody can download.

type UpdateStep = "pick" | "review" | "uploading";

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

export function SkinUpdateModal({
  skin,
  open,
  onClose,
  onUpdated,
}: {
  skin: SkinSummary;
  open: boolean;
  onClose: () => void;
  onUpdated: (skin: SkinSummary) => void;
}) {
  const [step, setStep] = useState<UpdateStep>("pick");
  const [dragActive, setDragActive] = useState(false);
  const [reading, setReading] = useState<{ name: string; percent: number | null } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [imported, setImported] = useState<ReplaySkinImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set when the picked .osk already belongs to another published skin.
  const [duplicate, setDuplicate] = useState<DuplicateSkinRef | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, label: "" });

  const [renders, setRenders] = useState<Map<number, RenderedPreview>>(new Map());
  const [rendering, setRendering] = useState(false);
  const [selectedKeymode, setSelectedKeymode] = useState(4);
  const [coverKeymode, setCoverKeymode] = useState(4);
  const renderUrlsRef = useRef<string[]>([]);
  const renderedBackdropsRef = useRef<Map<number, PreviewBackdrop>>(new Map());
  const ticketRef = useRef<UploadTicket | null>(null);

  const [backdrop, setBackdrop] = useState<PreviewBackdrop>("flat");
  const [backdropOverrides, setBackdropOverrides] = useState<Map<number, PreviewBackdrop>>(new Map());
  const [scope, setScope] = useState<BackdropScope>("all");
  // A pick made while the first pool draw is still out owns the choice.
  const backdropTouchedRef = useRef(false);
  const pool = useSkinBackdropPool(open);

  const [bodyLockActive, setBodyLockActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const keymodes = imported?.summary.keymodes ?? [];
  const publishedCoverKeymode = useMemo(
    () => skin.previews.find((preview) => preview.url === skin.previewUrl)?.keys ?? null,
    [skin.previews, skin.previewUrl],
  );

  const releaseRenders = useCallback(() => {
    renderUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    renderUrlsRef.current = [];
  }, []);

  useEffect(() => releaseRenders, [releaseRenders]);

  const resetAll = useCallback(() => {
    releaseRenders();
    setStep("pick");
    setDragActive(false);
    setReading(null);
    setFile(null);
    setImported(null);
    setError(null);
    setDuplicate(null);
    setRenders(new Map());
    renderedBackdropsRef.current.clear();
    setBackdrop("flat");
    setBackdropOverrides(new Map());
    setScope("all");
    backdropTouchedRef.current = false;
    ticketRef.current = null;
  }, [releaseRenders]);

  // Closing throws the attempt away: the picked file, its renders and the
  // ticket all belong to one update, and reopening starts a fresh one. The
  // reset waits for the fade-out (see onExitComplete) so the modal does not
  // flash back to the drop zone on its way off screen.

  // The covers land after the modal opens; the first draw picks the backdrop
  // unless someone got there first.
  useEffect(() => {
    if (!open || backdropTouchedRef.current || pool.candidates.length === 0) return;
    backdropTouchedRef.current = true;
    setBackdrop(pool.candidates[Math.floor(Math.random() * pool.candidates.length)].setId);
  }, [open, pool.candidates]);

  const backdropFor = useCallback(
    (keys: number): PreviewBackdrop => backdropForKeymode({ shared: backdrop, overrides: backdropOverrides }, keys),
    [backdrop, backdropOverrides],
  );

  const pickBackdrop = useCallback((choice: PreviewBackdrop) => {
    backdropTouchedRef.current = true;
    const next = applyBackdropPick(
      { shared: backdrop, overrides: backdropOverrides },
      { scope, keymode: selectedKeymode, choice },
    );
    setBackdrop(next.shared);
    setBackdropOverrides(next.overrides);
  }, [backdrop, backdropOverrides, scope, selectedKeymode]);

  const handleFiles = useCallback(async (files: FileList | null) => {
    const picked = files?.[0];
    if (!picked) return;
    setError(null);
    setDuplicate(null);
    if (picked.size > SKIN_OSK_MAX_BYTES) {
      setError(`This file is ${formatSkinFileSize(picked.size)}. The limit is 50 MB.`);
      return;
    }
    setReading({ name: picked.name, percent: null });
    try {
      let lastPercent = -1;
      const result = await importReplaySkinFromOsk(picked, {
        targetKeyCount: 4,
        onProgress: (done, total) => {
          const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
          if (percent !== lastPercent) {
            lastPercent = percent;
            setReading({ name: picked.name, percent });
          }
        },
      });
      releaseRenders();
      setRenders(new Map());
      renderedBackdropsRef.current.clear();
      setFile(picked);
      setImported(result);
      // The card keeps fronting the keymode it already did, as long as the new
      // build still ships it.
      const next = result.summary.keymodes;
      const cover = publishedCoverKeymode != null && next.includes(publishedCoverKeymode)
        ? publishedCoverKeymode
        : next.includes(4) ? 4 : next[0] ?? 4;
      setSelectedKeymode(cover);
      setCoverKeymode(cover);
      setStep("review");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "This .osk could not be read.");
    } finally {
      setReading(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [publishedCoverKeymode, releaseRenders]);

  // One render per keymode the new archive declares, redrawn whenever its
  // backdrop moves. The keymode on screen goes first so the hero fills fast.
  const poolImage = pool.image;
  useEffect(() => {
    if (!imported) return;
    const queue = imported.summary.keymodes
      .filter((keys) => renderedBackdropsRef.current.get(keys) !== backdropFor(keys))
      .sort((a, b) => (a === selectedKeymode ? -1 : b === selectedKeymode ? 1 : a - b));
    if (queue.length === 0) return;
    let cancelled = false;
    setRendering(true);
    (async () => {
      for (const keys of queue) {
        if (cancelled) return;
        const choice = backdropFor(keys);
        const background = choice === "flat" ? null : await poolImage(choice);
        if (cancelled) return;
        const render = await renderSkinPreview(imported.settings, keys, { background });
        if (cancelled) return;
        const url = URL.createObjectURL(render.blob);
        renderUrlsRef.current.push(url);
        setRenders((previous) => {
          const replaced = previous.get(keys);
          if (replaced) {
            URL.revokeObjectURL(replaced.url);
            renderUrlsRef.current = renderUrlsRef.current.filter((candidate) => candidate !== replaced.url);
          }
          return new Map(previous).set(keys, {
            blob: render.blob,
            width: render.width,
            height: render.height,
            url,
            accent: render.accent,
          });
        });
        renderedBackdropsRef.current.set(keys, choice);
      }
    })()
      .catch(() => {
        if (!cancelled) setError("The previews could not be rendered.");
      })
      .finally(() => {
        if (!cancelled) setRendering(false);
      });
    return () => {
      cancelled = true;
    };
  }, [imported, backdropFor, selectedKeymode, poolImage]);

  const save = useCallback(async () => {
    const previewEntries = [...renders.entries()].sort(([a], [b]) => a - b);
    if (!file || previewEntries.length === 0) return;
    setError(null);
    setDuplicate(null);
    setProgress({ done: 0, total: 0, label: "Preparing the update." });
    setStep("uploading");
    try {
      // A still-valid ticket survives a retry, so a network blip does not cost
      // a second round trip through the server fn.
      if (!ticketRef.current) {
        const started = await startSkinEdit({ data: { id: skin.id, scope: "replace" } });
        if (!started.ok) {
          setStep("review");
          setError(started.error === "not_logged_in"
            ? "Log in with osu! again to update this skin."
            : "This skin could not be updated right now. Try again.");
          return;
        }
        ticketRef.current = { id: started.id, token: started.token };
      }
      const ticket = ticketRef.current;
      const totalBytes = file.size + previewEntries.reduce((sum, [, render]) => sum + render.blob.size, 0);
      let doneBytes = 0;

      // The .osk goes first: it is what decides the keymodes the previews are
      // then filed under, and a rejected file costs no preview uploads.
      const oskLabel = (sent: number) =>
        `Uploading the new skin file, ${formatSkinFileSize(sent) || "0 MB"} of ${formatSkinFileSize(file.size)}.`;
      setProgress({ done: 0, total: totalBytes, label: oskLabel(0) });
      await uploadSkinPart({
        id: ticket.id,
        token: ticket.token,
        part: "osk",
        blob: file,
        onProgress: (sent) => setProgress({ done: sent, total: totalBytes, label: oskLabel(sent) }),
      });
      doneBytes += file.size;

      for (const [keys, render] of previewEntries) {
        const label = `Uploading the ${keys}K preview.`;
        setProgress({ done: doneBytes, total: totalBytes, label });
        await uploadSkinPart({
          id: ticket.id,
          token: ticket.token,
          part: "preview",
          blob: render.blob,
          width: render.width,
          height: render.height,
          keys,
          cover: keys === coverKeymode,
          accent: keys === coverKeymode ? render.accent : undefined,
          onProgress: (sent) => setProgress({ done: doneBytes + sent, total: totalBytes, label }),
        });
        doneBytes += render.blob.size;
      }

      setProgress({ done: totalBytes, total: totalBytes, label: "Saving." });
      const updated = await finishSkinEdit(ticket.id, ticket.token);
      track("skin_file_updated", {
        ...skinEventProperties(updated),
        skin_previews_rerendered: previewEntries.length,
      });
      markSkinsListStale();
      onUpdated(updated);
      onClose();
    } catch (saveError) {
      if (saveError instanceof SkinUploadError) {
        if (saveError.code === "invalid_ticket") ticketRef.current = null;
        if (saveError.code === "duplicate") setDuplicate(saveError.duplicate ?? null);
        setError(saveError.message);
      } else {
        setError(uploadErrorMessage("upload_failed"));
      }
      setStep("review");
    }
  }, [file, renders, coverKeymode, skin.id, onUpdated, onClose]);

  const uploading = step === "uploading";

  const handleDismiss = useCallback(() => {
    if (uploading) return;
    onClose();
  }, [uploading, onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, handleDismiss]);

  // The scrollbar-compensated body lock the other skin modals use, so opening
  // this one never reflows the page underneath.
  useLayoutEffect(() => {
    if (open) setBodyLockActive(true);
  }, [open]);

  useLayoutEffect(() => {
    if (!bodyLockActive) return;
    const prevOverflow = document.body.style.overflow;
    const prevPaddingRight = document.body.style.paddingRight;
    const prevScrollbarCompensation = document.documentElement.style.getPropertyValue("--modal-scrollbar-compensation");
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    const hasStableScrollbarGutter = typeof CSS !== "undefined" && CSS.supports?.("scrollbar-gutter", "stable");
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0 && !hasStableScrollbarGutter) {
      const currentPaddingRight = parseFloat(window.getComputedStyle(document.body).paddingRight) || 0;
      document.body.style.paddingRight = `${currentPaddingRight + scrollbarWidth}px`;
      document.documentElement.style.setProperty("--modal-scrollbar-compensation", `${scrollbarWidth}px`);
    }
    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPaddingRight;
      if (prevScrollbarCompensation) {
        document.documentElement.style.setProperty("--modal-scrollbar-compensation", prevScrollbarCompensation);
      } else {
        document.documentElement.style.removeProperty("--modal-scrollbar-compensation");
      }
    };
  }, [bodyLockActive]);

  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const hero = renders.get(selectedKeymode);
  const awaitingRenders = keymodes.some((keys) => !renders.has(keys));
  const addedKeymodes = keymodes.filter((keys) => !skin.keymodes.includes(keys));
  const droppedKeymodes = skin.keymodes.filter((keys) => !keymodes.includes(keys));

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence
      onExitComplete={() => {
        setBodyLockActive(false);
        resetAll();
      }}
    >
      {open && (
        <motion.div
          key="skin-update"
          className="fixed inset-0 z-[120] flex items-center justify-center py-3 pl-3 sm:py-6 sm:pl-6 pr-[calc(0.75rem+var(--modal-scrollbar-compensation,0px))] sm:pr-[calc(1.5rem+var(--modal-scrollbar-compensation,0px))]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <div className="absolute inset-0 bg-black/85" onClick={handleDismiss} />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={`Update ${skin.name}`}
            className="modal-card-mobile-safe relative isolate z-10 flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[720px] flex-col overflow-hidden rounded-2xl bg-osu-b5 ring-1 ring-white/10 shadow-2xl sm:max-h-[calc(100dvh-3rem)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="relative z-10 flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-osu-b3/30 px-4 py-3 sm:px-5">
                <span className="min-w-0 truncate text-[10px] font-extrabold uppercase tracking-[0.18em] text-osu-pink-light">
                  update {skin.name}
                </span>
                {!uploading && (
                  <button
                    type="button"
                    onClick={handleDismiss}
                    aria-label="Close"
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-osu-f1 transition-colors cursor-pointer hover:bg-osu-b3/50 hover:text-white"
                  >
                    <X className="h-4 w-4" strokeWidth={2.4} />
                  </button>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
                {step === "pick" ? (
                  <>
                    <button
                      type="button"
                      disabled={reading !== null}
                      onClick={() => fileInputRef.current?.click()}
                      onDragEnter={(event) => {
                        event.preventDefault();
                        if (!reading) setDragActive(true);
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        if (!reading) setDragActive(true);
                      }}
                      onDragLeave={(event) => {
                        event.preventDefault();
                        setDragActive(false);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDragActive(false);
                        if (!reading) void handleFiles(event.dataTransfer.files);
                      }}
                      className={`block w-full rounded-xl border transition-colors ${
                        reading
                          ? "border-osu-b3/60 bg-osu-b4 cursor-default"
                          : dragActive
                            ? "border-osu-pink/70 bg-osu-b4 cursor-pointer"
                            : "border-osu-b3/60 bg-osu-b4 cursor-pointer hover:border-osu-pink/45"
                      }`}
                    >
                      <div className="flex min-h-[200px] flex-col items-center justify-center gap-2.5 px-6 py-8 text-center">
                        {reading ? (
                          <div className="w-full max-w-[340px]">
                            <div className="truncate text-sm font-semibold text-white">Reading {reading.name}</div>
                            <div className="mt-3 h-2 overflow-hidden rounded-full bg-osu-b5">
                              <div className="h-full bg-osu-pink transition-[width] duration-100" style={{ width: `${reading.percent ?? 2}%` }} />
                            </div>
                            <div className="mt-1.5 text-[11px] tabular-nums text-osu-f1">
                              {reading.percent == null ? "Opening the archive..." : `Decoding the skin's images, ${reading.percent}%`}
                            </div>
                          </div>
                        ) : (
                          <>
                            <Upload className={`h-8 w-8 transition-colors ${dragActive ? "text-osu-pink-light" : "text-osu-f1"}`} aria-hidden="true" />
                            <div>
                              <div className="text-sm font-semibold text-white">
                                {dragActive ? "Drop to read it" : "Drop the new .osk here, or click to browse"}
                              </div>
                              <div className="mt-1 text-[11px] text-osu-f1">Up to 50 MB.</div>
                            </div>
                          </>
                        )}
                      </div>
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".osk,.zip,application/zip"
                      className="sr-only"
                      onChange={(event) => void handleFiles(event.target.files)}
                    />
                    <p className="mt-3 text-[11.5px] leading-relaxed text-osu-f1">
                      The skin page keeps its name, description, link and download count. Only the file people get and the
                      previews rendered from it are replaced.
                    </p>
                    {error && <p className="mt-3 text-[12px] font-semibold text-osu-red-light">{error}</p>}
                  </>
                ) : (
                  <>
                    <div className="relative overflow-hidden rounded-xl border border-osu-b3/30 bg-osu-b4">
                      <div className="aspect-video w-full">
                        {hero ? (
                          <img src={hero.url} alt={`${selectedKeymode}K preview`} className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex h-full items-center justify-center text-[12px] text-osu-f1">
                            Rendering the {selectedKeymode}K playfield...
                          </div>
                        )}
                      </div>
                      {hero && rendering && (
                        <div className="pointer-events-none absolute right-2 top-2 rounded bg-osu-b5/85 px-1.5 py-0.5 text-[10px] font-bold text-osu-l2">
                          rendering
                        </div>
                      )}
                    </div>

                    <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
                      <span className="text-osu-f1">
                        Viewing <span className="font-bold text-osu-l2 tabular-nums">{selectedKeymode}K</span>
                      </span>
                      {coverKeymode === selectedKeymode ? (
                        <span className="flex items-center gap-1 font-bold text-osu-pink">
                          <Star size={11} aria-hidden="true" />
                          card cover
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={uploading}
                          onClick={() => setCoverKeymode(selectedKeymode)}
                          className="flex items-center gap-1 font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l1 disabled:cursor-default"
                        >
                          <Star size={11} aria-hidden="true" />
                          Use {selectedKeymode}K as the card cover
                        </button>
                      )}
                    </div>

                    <div className="mt-2 flex flex-wrap items-start gap-2">
                      {keymodes.map((keys) => {
                        const render = renders.get(keys);
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
                            <div className="aspect-video w-full bg-osu-b4">
                              {render ? (
                                <img src={render.url} alt={`${keys}K thumbnail`} className="h-full w-full object-cover" />
                              ) : (
                                <div className="flex h-full items-center justify-center text-[10px] text-osu-f1/60">rendering</div>
                              )}
                            </div>
                            <div className={`flex items-center gap-1 px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums ${
                              selected ? "bg-osu-pink text-white" : "bg-osu-b4 text-osu-l2"
                            }`}>
                              {keys}K
                              {coverKeymode === keys && (
                                <Star size={9} className={selected ? "text-white" : "text-osu-pink"} aria-label="card cover" />
                              )}
                              {addedKeymodes.includes(keys) && (
                                <span className={selected ? "text-white/80" : "text-osu-green"} title="New in this build" aria-hidden="true">+</span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {!uploading && (
                      <SkinBackdropPicker
                        pool={pool}
                        selected={backdropFor(selectedKeymode)}
                        onPick={pickBackdrop}
                        scope={scope}
                        onScopeChange={setScope}
                        keymodeLabel={`${selectedKeymode}K`}
                        disabled={rendering}
                      />
                    )}

                    {/* What actually changes on the published skin. */}
                    <dl className="mt-3 rounded-lg border border-osu-b3/25 bg-osu-b4 px-3 py-1 text-[12px]">
                      <ChangeRow label="File">
                        <span className="flex items-center gap-1.5 tabular-nums text-osu-l1">
                          <span className="text-osu-f1">{formatSkinFileSize(skin.oskSizeBytes) || "unknown"}</span>
                          <ArrowRight className="h-3 w-3 text-osu-f1" aria-hidden="true" />
                          <span>{formatSkinFileSize(file?.size ?? 0) || "unknown"}</span>
                        </span>
                      </ChangeRow>
                      <ChangeRow label="Keymodes">
                        <span className="text-osu-l1">
                          {keymodes.map((keys) => `${keys}K`).join(", ") || "none"}
                          {addedKeymodes.length > 0 && (
                            <span className="ml-1.5 text-osu-green">+{addedKeymodes.map((keys) => `${keys}K`).join(", ")}</span>
                          )}
                          {droppedKeymodes.length > 0 && (
                            <span className="ml-1.5 text-osu-red-light">-{droppedKeymodes.map((keys) => `${keys}K`).join(", ")}</span>
                          )}
                        </span>
                      </ChangeRow>
                      <ChangeRow label="Previews">
                        <span className="text-osu-l1 tabular-nums">{keymodes.length} re-rendered</span>
                      </ChangeRow>
                    </dl>
                    {droppedKeymodes.length > 0 && (
                      <p className="mt-2 text-[11px] font-semibold text-osu-yellow">
                        The new file has no {droppedKeymodes.map((keys) => `${keys}K`).join(", ")} block, so those previews
                        are dropped from the skin page.
                      </p>
                    )}

                    {error && (
                      <p className="mt-3 text-[12px] font-semibold text-osu-red-light">
                        {error}
                        {duplicate && (
                          <>
                            {" "}
                            <Link
                              to="/skins/$id"
                              params={{ id: duplicate.slug ?? duplicate.id }}
                              onClick={onClose}
                              className="underline underline-offset-2 hover:text-white"
                            >
                              {duplicate.name}
                            </Link>
                          </>
                        )}
                      </p>
                    )}

                    <div className="mt-4 flex flex-col gap-2.5">
                      {uploading ? (
                        <div className="flex flex-col gap-1.5">
                          <div className="h-2 overflow-hidden rounded-full bg-osu-b4">
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
                            onClick={() => void save()}
                            disabled={!file || keymodes.length === 0 || awaitingRenders || rendering}
                            className="flex items-center gap-1.5 rounded-full bg-osu-pink px-6 py-2 text-[13px] font-bold text-white transition cursor-pointer hover:brightness-110 disabled:cursor-default disabled:opacity-50"
                          >
                            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                            Update the skin
                          </button>
                          <button
                            type="button"
                            onClick={() => setStep("pick")}
                            className="text-[12px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l1"
                          >
                            Pick another file
                          </button>
                          <button
                            type="button"
                            onClick={handleDismiss}
                            className="text-[12px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l1"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function ChangeRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-osu-b3/25 py-2 last:border-b-0">
      <dt className="shrink-0 text-osu-f1">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
