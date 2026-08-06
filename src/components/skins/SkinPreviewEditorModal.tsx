import { AnimatePresence, motion } from "framer-motion";
import { Star, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SkinBackdropPicker, useSkinBackdropPool } from "./SkinBackdropPicker";
import { track } from "../../lib/analytics";
import { skinEventProperties } from "../../lib/analytics-skins";
import { importReplaySkinFromOsk, type ReplaySkinImportResult } from "../../lib/replay-skin-import";
import type { BackdropScope, PreviewBackdrop } from "../../lib/skin-preview-backdrops";
import { renderSkinPreview } from "../../lib/skin-preview-render";
import {
  finishSkinEdit,
  formatSkinFileSize,
  markSkinsListStale,
  setSkinCoverKeymode,
  skinOskFileUrl,
  SkinUploadError,
  startSkinEdit,
  uploadSkinPart,
  type SkinSummary,
} from "../../lib/skins";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";

// Post-publish editing of what a skin looks like on the browse card: which
// keymode fronts it, and what map cover sits behind the rendered playfields.
// Both are decided at upload time and were stuck there afterwards.
//
// Changing the cover keymode is a pointer move on the backend (every keymode's
// render is stored). Changing a backdrop is a re-render, so the modal pulls the
// published .osk back down, parses it the way the upload modal does, and
// re-uploads only the keymodes that were actually retargeted.

interface RenderedPreview {
  blob: Blob;
  width: number;
  height: number;
  url: string;
  accent: string;
}

interface LoadingState {
  label: string;
  percent: number | null;
}

export function SkinPreviewEditorModal({
  skin,
  open,
  onClose,
  onSaved,
}: {
  skin: SkinSummary;
  open: boolean;
  onClose: () => void;
  onSaved: (skin: SkinSummary) => void;
}) {
  const [loading, setLoading] = useState<LoadingState | null>(null);
  const [imported, setImported] = useState<ReplaySkinImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, label: "" });

  // The keymode whose preview is on screen, and the one that fronts the card.
  const publishedCoverKeymode = useMemo(() => {
    const match = skin.previews.find((preview) => preview.url === skin.previewUrl);
    return match?.keys ?? skin.previews[0]?.keys ?? null;
  }, [skin.previews, skin.previewUrl]);
  const [selectedKeymode, setSelectedKeymode] = useState(() => publishedCoverKeymode ?? skin.keymodes[0] ?? 4);
  const [coverKeymode, setCoverKeymode] = useState<number | null>(publishedCoverKeymode);

  // Retargeted keymodes only: a keymode with no entry here keeps the render it
  // was published with, so opening the editor and saving nothing changes
  // nothing. Renders land in `renders` once they are drawn.
  const [pending, setPending] = useState<Map<number, PreviewBackdrop>>(new Map());
  const [renders, setRenders] = useState<Map<number, RenderedPreview>>(new Map());
  const [rendering, setRendering] = useState(false);
  // The .osk only comes down once a backdrop is actually picked: moving the
  // cover to another keymode needs no re-render, and the archive runs to 50MB.
  const [needsSkinFile, setNeedsSkinFile] = useState(false);
  const [scope, setScope] = useState<BackdropScope>("all");
  const renderedBackdropsRef = useRef<Map<number, PreviewBackdrop>>(new Map());
  const renderUrlsRef = useRef<string[]>([]);
  const pool = useSkinBackdropPool(open);

  const [bodyLockActive, setBodyLockActive] = useState(false);

  const keymodes = useMemo(() => {
    const fromSkin = skin.keymodes.length > 0 ? skin.keymodes : imported?.summary.keymodes ?? [];
    return [...fromSkin].sort((a, b) => a - b);
  }, [skin.keymodes, imported]);

  const publishedPreviewUrl = useCallback(
    (keys: number) => skin.previews.find((preview) => preview.keys === keys)?.url ?? null,
    [skin.previews],
  );

  const releaseRenders = useCallback(() => {
    renderUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    renderUrlsRef.current = [];
  }, []);

  useEffect(() => releaseRenders, [releaseRenders]);

  // Pulls the published .osk back down and parses it, which is what the
  // re-renders draw from. Runs once per opening, on the first pick.
  useEffect(() => {
    if (!open || !needsSkinFile || imported) return;
    const oskUrl = skinOskFileUrl(skin);
    if (!oskUrl) {
      setError("This skin's file is not available, so its previews cannot be re-rendered.");
      return;
    }
    let cancelled = false;
    setError(null);
    setLoading({ label: "Downloading the skin file", percent: null });
    (async () => {
      const response = await fetch(oskUrl, { credentials: "omit" });
      if (!response.ok) throw new Error(`Server ${response.status}`);
      const total = Number(response.headers.get("content-length")) || skin.oskSizeBytes || 0;
      const reader = response.body?.getReader();
      let blob: Blob;
      if (reader && total > 0) {
        const chunks: Uint8Array[] = [];
        let received = 0;
        let lastPercent = -1;
        for (;;) {
          const { done, value } = await reader.read();
          if (cancelled) {
            await reader.cancel().catch(() => {});
            return;
          }
          if (done) break;
          if (value) {
            chunks.push(value);
            received += value.byteLength;
            const percent = Math.min(100, Math.round((received / total) * 100));
            if (percent !== lastPercent) {
              lastPercent = percent;
              setLoading({ label: "Downloading the skin file", percent });
            }
          }
        }
        blob = new Blob(chunks as BlobPart[]);
      } else {
        blob = await response.blob();
      }
      if (cancelled) return;
      const file = new File([blob], `${skin.name || "skin"}.osk`);
      let lastPercent = -1;
      const result = await importReplaySkinFromOsk(file, {
        targetKeyCount: 4,
        onProgress: (done, steps) => {
          const percent = steps > 0 ? Math.min(100, Math.round((done / steps) * 100)) : 0;
          if (percent !== lastPercent && !cancelled) {
            lastPercent = percent;
            setLoading({ label: "Reading the skin", percent });
          }
        },
      });
      if (cancelled) return;
      setImported(result);
    })()
      .catch(() => {
        if (!cancelled) setError("The skin file could not be read, so its previews cannot be re-rendered.");
      })
      .finally(() => {
        if (!cancelled) setLoading(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, needsSkinFile, imported, skin]);

  // Draws every retargeted keymode, skipping the ones already drawn against
  // the backdrop they are pointed at. Depends on the pool's decoder rather
  // than the pool itself, which changes identity as covers are drawn.
  const poolImage = pool.image;
  useEffect(() => {
    if (!imported || pending.size === 0) return;
    const queue = [...pending.entries()]
      .filter(([keys, choice]) => renderedBackdropsRef.current.get(keys) !== choice)
      .sort(([a], [b]) => (a === selectedKeymode ? -1 : b === selectedKeymode ? 1 : a - b));
    if (queue.length === 0) return;
    let cancelled = false;
    setRendering(true);
    (async () => {
      for (const [keys, choice] of queue) {
        if (cancelled) return;
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
        // A skin published before per-keymode previews existed has nothing but
        // a standalone cover image, so the first render here takes the card.
        setCoverKeymode((previous) => previous ?? keys);
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
  }, [imported, pending, selectedKeymode, poolImage]);

  // "All keymodes" retargets everything the skin ships, which is also how a
  // per-keymode pick is undone; "this keymode only" touches the one on screen.
  const pickBackdrop = useCallback((choice: PreviewBackdrop) => {
    setNeedsSkinFile(true);
    setPending((previous) => {
      if (scope === "all") return new Map(keymodes.map((keys) => [keys, choice] as const));
      return new Map(previous).set(selectedKeymode, choice);
    });
  }, [scope, keymodes, selectedKeymode]);

  // One click for "draw this skin again with the renderer as it is now",
  // which is what a fix to the playfield renderer needs. Nothing records which
  // backdrop a published preview used, so this takes the first cover on offer
  // and the card's art changes with it; shuffle first to steer that.
  const rerenderAll = useCallback(() => {
    const choice: PreviewBackdrop = pool.candidates[0]?.setId ?? "flat";
    setScope("all");
    setNeedsSkinFile(true);
    setPending(new Map(keymodes.map((keys) => [keys, choice] as const)));
  }, [pool.candidates, keymodes]);

  const revertPreviews = useCallback(() => {
    setPending(new Map());
    releaseRenders();
    setRenders(new Map());
    renderedBackdropsRef.current.clear();
  }, [releaseRenders]);

  const coverChanged = coverKeymode != null && coverKeymode !== publishedCoverKeymode;
  const dirty = renders.size > 0 || coverChanged;
  // A pick whose render has not landed yet (the archive may still be coming
  // down) holds the save button, so a pick is never silently dropped.
  const awaitingRender = pending.size > 0
    && (rendering || loading != null || [...pending.keys()].some((keys) => !renders.has(keys)));

  const save = useCallback(async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setError(null);
    // Ordered by keymode so the progress bar reads in a predictable order.
    const uploads = [...renders.entries()].sort(([a], [b]) => a - b);
    try {
      let current: SkinSummary | null = null;
      if (uploads.length > 0) {
        setProgress({ done: 0, total: 0, label: "Preparing the update." });
        const started = await startSkinEdit({ data: { id: skin.id, scope: "previews" } });
        if (!started.ok) {
          setError(started.error === "not_logged_in"
            ? "Log in with osu! again to edit this skin."
            : "The previews could not be updated right now. Try again.");
          setSaving(false);
          return;
        }
        const totalBytes = uploads.reduce((sum, [, render]) => sum + render.blob.size, 0);
        let doneBytes = 0;
        for (const [keys, render] of uploads) {
          const label = `Uploading the ${keys}K preview.`;
          setProgress({ done: doneBytes, total: totalBytes, label });
          await uploadSkinPart({
            id: started.id,
            token: started.token,
            part: "preview",
            blob: render.blob,
            width: render.width,
            height: render.height,
            keys,
            // A re-rendered keymode that already fronts the card keeps fronting
            // it on the backend, so the flag is only for a cover that moved.
            cover: keys === coverKeymode,
            accent: keys === coverKeymode ? render.accent : undefined,
            onProgress: (sent) => setProgress({ done: doneBytes + sent, total: totalBytes, label }),
          });
          doneBytes += render.blob.size;
        }
        setProgress({ done: totalBytes, total: totalBytes, label: "Saving." });
        current = await finishSkinEdit(started.id, started.token);
      }
      // A cover that moved to a keymode nobody re-rendered is just a pointer
      // move; no image work involved.
      if (coverChanged && coverKeymode != null && !renders.has(coverKeymode)) {
        const result = await setSkinCoverKeymode({ data: { id: skin.id, keys: coverKeymode } });
        if (!result.ok) {
          setError("The card cover could not be changed. Try again.");
          setSaving(false);
          return;
        }
        current = result.skin ?? current;
      }
      if (!current) {
        setSaving(false);
        return;
      }
      track("skin_previews_edited", {
        ...skinEventProperties(current),
        skin_previews_rerendered: uploads.length,
        skin_cover_changed: coverChanged,
      });
      markSkinsListStale();
      revertPreviews();
      setSaving(false);
      onSaved(current);
      onClose();
    } catch (saveError) {
      setSaving(false);
      setError(saveError instanceof SkinUploadError
        ? saveError.message
        : "The previews could not be updated. Try again.");
    }
  }, [saving, dirty, renders, skin.id, coverKeymode, coverChanged, revertPreviews, onSaved, onClose]);

  const handleDismiss = useCallback(() => {
    if (saving) return;
    onClose();
  }, [saving, onClose]);

  // The cached parse survives openings, but not a .osk that was swapped for a
  // newer build: re-renders would otherwise draw notes nobody can download.
  useEffect(() => {
    setImported(null);
    setNeedsSkinFile(false);
  }, [skin.oskUrl]);

  // Everything but the parsed .osk resets between openings: the parse is the
  // slow part, and it is still valid for the same skin.
  useEffect(() => {
    if (open) return;
    revertPreviews();
    setError(null);
    setScope("all");
    setNeedsSkinFile(false);
    setCoverKeymode(publishedCoverKeymode);
    setSelectedKeymode(publishedCoverKeymode ?? keymodes[0] ?? 4);
  }, [open, revertPreviews, publishedCoverKeymode, keymodes]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, handleDismiss]);

  // Same scrollbar-compensated body lock the upload modal uses, so opening the
  // editor never reflows the page underneath.
  useLayoutEffect(() => {
    if (open) setBodyLockActive(true);
  }, [open]);

  useBodyScrollLock(bodyLockActive);

  const heroUrl = renders.get(selectedKeymode)?.url ?? publishedPreviewUrl(selectedKeymode) ?? skin.previewUrl;
  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const changedKeymodes = [...renders.keys()].sort((a, b) => a - b);
  // The picker stays live while the archive downloads: a pick is what starts
  // that download, and further picks just queue up behind it.
  const busy = saving || rendering;

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence onExitComplete={() => setBodyLockActive(false)}>
      {open && (
        <motion.div
          key="skin-preview-editor"
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
            aria-label="Edit skin previews"
            className="modal-card-mobile-safe relative isolate z-10 flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[720px] flex-col overflow-hidden rounded-2xl bg-osu-b5 ring-1 ring-white/10 shadow-2xl sm:max-h-[calc(100dvh-3rem)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="relative z-10 flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-osu-b3/30 px-4 py-3 sm:px-5">
                <span className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-osu-pink-light">edit previews</span>
                {!saving && (
                  <button
                    type="button"
                    onClick={handleDismiss}
                    aria-label="Close"
                    className="grid h-7 w-7 place-items-center rounded-full text-osu-f1 transition-colors cursor-pointer hover:bg-osu-b3/50 hover:text-white"
                  >
                    <X className="h-4 w-4" strokeWidth={2.4} />
                  </button>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
                <div className="relative overflow-hidden rounded-xl border border-osu-b3/30 bg-osu-b4">
                  <div className="aspect-video w-full">
                    {heroUrl ? (
                      <img src={heroUrl} alt={`${selectedKeymode}K preview`} className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center text-[12px] text-osu-f1">
                        No {selectedKeymode}K preview yet.
                      </div>
                    )}
                  </div>
                  {loading && (
                    <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-osu-b5/85 px-2.5 py-1.5 text-[11px] text-osu-l2">
                      <span className="truncate">{loading.label}</span>
                      {loading.percent != null && <span className="ml-auto shrink-0 tabular-nums">{loading.percent}%</span>}
                      {loading.percent == null && skin.oskSizeBytes ? (
                        <span className="ml-auto shrink-0 tabular-nums">{formatSkinFileSize(skin.oskSizeBytes)}</span>
                      ) : null}
                    </div>
                  )}
                  {!loading && rendering && (
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
                      disabled={saving || (!publishedPreviewUrl(selectedKeymode) && !renders.has(selectedKeymode))}
                      onClick={() => setCoverKeymode(selectedKeymode)}
                      title={!publishedPreviewUrl(selectedKeymode) && !renders.has(selectedKeymode)
                        ? `This skin has no ${selectedKeymode}K preview yet; pick a backdrop for it first.`
                        : undefined}
                      className="flex items-center gap-1 font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l1 disabled:cursor-default disabled:opacity-50"
                    >
                      <Star size={11} aria-hidden="true" />
                      Use {selectedKeymode}K as the card cover
                    </button>
                  )}
                </div>

                <div className="mt-2 flex flex-wrap items-start gap-2">
                  {keymodes.map((keys) => {
                    const url = renders.get(keys)?.url ?? publishedPreviewUrl(keys);
                    const selected = selectedKeymode === keys;
                    return (
                      <button
                        key={keys}
                        type="button"
                        disabled={saving}
                        onClick={() => setSelectedKeymode(keys)}
                        aria-pressed={selected}
                        className={`w-[104px] overflow-hidden rounded-lg border text-left transition-colors duration-100 cursor-pointer disabled:cursor-default ${
                          selected ? "border-osu-pink" : "border-osu-b3/40 hover:border-osu-f1/40"
                        }`}
                      >
                        <div className="aspect-video w-full bg-osu-b4">
                          {url ? (
                            <img src={url} alt={`${keys}K thumbnail`} loading="lazy" className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full items-center justify-center text-[10px] text-osu-f1/60">no preview</div>
                          )}
                        </div>
                        <div className={`flex items-center gap-1 px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums ${
                          selected ? "bg-osu-pink text-white" : "bg-osu-b4 text-osu-l2"
                        }`}>
                          {keys}K
                          {coverKeymode === keys && (
                            <Star size={9} className={selected ? "text-white" : "text-osu-pink"} aria-label="card cover" />
                          )}
                          {renders.has(keys) && (
                            <span className={selected ? "text-white/80" : "text-osu-f1/70"} title="Re-rendered, not saved yet" aria-hidden="true">*</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>

                <SkinBackdropPicker
                  pool={pool}
                  selected={pending.get(selectedKeymode) ?? null}
                  onPick={pickBackdrop}
                  scope={scope}
                  onScopeChange={setScope}
                  keymodeLabel={`${selectedKeymode}K`}
                  disabled={busy}
                  hint={changedKeymodes.length > 0 ? (
                    <span className="text-[10px] text-osu-f1/55">
                      {changedKeymodes.map((keys) => `${keys}K`).join(", ")} re-rendered
                    </span>
                  ) : null}
                />
                <p className="mt-2 text-[11px] leading-relaxed text-osu-f1/70">
                  Picking a backdrop re-renders that playfield from the uploaded .osk. Keymodes left alone keep the
                  previews they were published with.
                </p>

                {error && <p className="mt-3 text-[12px] font-semibold text-osu-red-light">{error}</p>}

                <div className="mt-4 flex flex-col gap-2.5">
                  {saving ? (
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
                        disabled={!dirty || awaitingRender}
                        className="rounded-full bg-osu-pink px-6 py-2 text-[13px] font-bold text-white transition cursor-pointer hover:brightness-110 disabled:cursor-default disabled:opacity-50"
                      >
                        Save changes
                      </button>
                      <button
                        type="button"
                        onClick={rerenderAll}
                        disabled={busy || loading != null}
                        className="text-[12px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l1 disabled:cursor-default disabled:opacity-50"
                      >
                        Re-render every keymode
                      </button>
                      {renders.size > 0 && (
                        <button
                          type="button"
                          onClick={revertPreviews}
                          className="text-[12px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l1"
                        >
                          Undo re-renders
                        </button>
                      )}
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
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
