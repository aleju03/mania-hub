import { AnimatePresence, motion } from "framer-motion";
import { Star, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSkinBackdropPool } from "./SkinBackdropPicker";
import { useSkinPatternPool } from "./SkinPatternPicker";
import { SkinPreviewPickers } from "./SkinPreviewPickers";
import { SkinScreenshotFields } from "./SkinScreenshotFields";
import { track } from "../../lib/analytics";
import { skinEventProperties } from "../../lib/analytics-skins";
import { importReplaySkinFromOsk, type ReplaySkinImportResult } from "../../lib/replay-skin-import";
import type { BackdropScope, PreviewBackdrop } from "../../lib/skin-preview-backdrops";
import type { SkinPreviewChartSnippet } from "../../lib/skin-preview-patterns";
import { renderSkinPreview } from "../../lib/skin-preview-render";
import {
  finishSkinEdit,
  formatSkinFileSize,
  markSkinsListStale,
  setSkinCover,
  setSkinScreenshotLabels,
  skinOskFileUrl,
  SkinUploadError,
  startSkinEdit,
  uploadSkinPart,
  uploadSkinPreviewsParallel,
  skinPreviewUploadLabel,
  type SkinSummary,
} from "../../lib/skins";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";

// Post-publish editing of what a skin looks like on the browse card and in its
// gallery: which image fronts it, what map cover sits behind the rendered
// playfields, and what the uploader's own screenshots are called. All of it is
// decided at upload time and was stuck there afterwards.
//
// Moving the cover is a pointer move on the backend (every candidate image is
// already stored), and so is renaming a screenshot. Changing a backdrop is a
// re-render, so the modal pulls the published .osk back down, parses it the way
// the upload modal does, and re-uploads only the keymodes that were actually
// retargeted.

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

// Long enough for a restarting backend to be listening again, short enough
// that the retry still reads as part of the same click.
const AUTO_RETRY_DELAY_MS = 1500;

function skinFileFailureMessage(phase: "download" | "parse", status: number | null): string {
  if (phase === "parse") return "The skin file could not be read, so its previews cannot be re-rendered.";
  if (status === 429) return "Too many requests right now, so the skin file did not come down.";
  // The gallery images on this page come straight off the skin row and can be
  // served by a different host than the .osk, so "the previews are right
  // there" is no evidence the archive is reachable.
  if (status === 404) return "The skin file is not in storage, so its previews cannot be re-rendered.";
  return "The skin file could not be downloaded, so its previews cannot be re-rendered.";
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

  // What fronts the card as published: one of the keymode renders, or one of
  // the uploader's screenshots. Both can be null on a skin published before
  // per-keymode previews existed, which carries a standalone cover image.
  const publishedCoverShot = useMemo(() => {
    const index = skin.screenshots.findIndex((shot) => shot.url === skin.previewUrl);
    return index >= 0 ? index : null;
  }, [skin.screenshots, skin.previewUrl]);
  const publishedCoverKeymode = useMemo(() => {
    const match = skin.previews.find((preview) => preview.url === skin.previewUrl);
    return match?.keys ?? (publishedCoverShot != null ? null : skin.previews[0]?.keys ?? null);
  }, [skin.previews, skin.previewUrl, publishedCoverShot]);
  const [selectedKeymode, setSelectedKeymode] = useState(() => publishedCoverKeymode ?? skin.keymodes[0] ?? 4);
  // The keymode that would front the card, and the screenshot that outranks it
  // when the uploader starred one.
  const [coverKeymode, setCoverKeymode] = useState<number | null>(
    publishedCoverKeymode ?? skin.previews[0]?.keys ?? null,
  );
  const [coverShot, setCoverShot] = useState<number | null>(publishedCoverShot);
  // Renaming is per screenshot and saves with everything else, so the drafts
  // sit here until the save.
  const [labelDrafts, setLabelDrafts] = useState<string[]>(
    () => skin.screenshots.map((shot) => shot.label ?? ""),
  );

  // Retargeted keymodes only: a keymode with no entry here keeps the render it
  // was published with, so opening the editor and saving nothing changes
  // nothing. Renders land in `renders` once they are drawn.
  const [pending, setPending] = useState<Map<number, PreviewBackdrop>>(new Map());
  // The notes on the field, per keymode. Undefined is "not retargeted", null is
  // "the built-in layout"; a snippet is a chart the uploader picked.
  const [pendingPatterns, setPendingPatterns] = useState<Map<number, SkinPreviewChartSnippet | null>>(new Map());
  const [renders, setRenders] = useState<Map<number, RenderedPreview>>(new Map());
  const [rendering, setRendering] = useState(false);
  // The .osk only comes down once a backdrop or pattern is actually picked:
  // moving the cover to another keymode needs no re-render, and the archive
  // runs to 50MB.
  const [needsSkinFile, setNeedsSkinFile] = useState(false);
  // A download this size fails on things that have nothing to do with the file
  // - a backend restart mid-stream, a phone changing networks - and used to
  // dead-end the editor: none of the download effect's deps changed after the
  // catch, so no later pick tried again and only closing the modal did.
  // Bumping the attempt is what re-runs it.
  const [downloadAttempt, setDownloadAttempt] = useState(0);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const autoRetriedRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scope, setScope] = useState<BackdropScope>("all");
  // What each keymode's image was last drawn from, backdrop and notes both, so
  // a second pick only redraws what actually changed.
  const renderedRef = useRef<Map<number, string>>(new Map());
  const renderUrlsRef = useRef<string[]>([]);
  const pool = useSkinBackdropPool(open);
  const patternPool = useSkinPatternPool(open, selectedKeymode);

  const [bodyLockActive, setBodyLockActive] = useState(false);

  const keymodes = useMemo(() => {
    const fromSkin = skin.keymodes.length > 0 ? skin.keymodes : imported?.summary.keymodes ?? [];
    return [...fromSkin].sort((a, b) => a - b);
  }, [skin.keymodes, imported]);

  const publishedRecipes = useMemo(() => new Map(
    skin.previews.flatMap((preview) => preview.recipe ? [[preview.keys, preview.recipe] as const] : []),
  ), [skin.previews]);

  // Pending picks override one axis only. The other axis continues to come
  // from the stored recipe, which is what lets a backdrop move without the
  // chart changing (and vice versa).
  const backdropFor = useCallback((keys: number): PreviewBackdrop | undefined => (
    pending.has(keys) ? pending.get(keys) : publishedRecipes.get(keys)?.backdrop
  ), [pending, publishedRecipes]);
  const patternFor = useCallback((keys: number): SkinPreviewChartSnippet | null | undefined => (
    pendingPatterns.has(keys) ? pendingPatterns.get(keys) : publishedRecipes.get(keys)?.pattern
  ), [pendingPatterns, publishedRecipes]);

  // A persisted choice may not happen to be in this opening's random picker
  // pool. Keep it visible at the front instead of showing a preview whose
  // selected backdrop/chart appears to be nothing in the row.
  const editorBackdropPool = useMemo(() => {
    const selected = backdropFor(selectedKeymode);
    if (typeof selected !== "number" || pool.candidates.some((entry) => entry.setId === selected)) return pool;
    return { ...pool, candidates: [{ setId: selected, label: "Current backdrop" }, ...pool.candidates] };
  }, [pool, selectedKeymode, backdropFor]);
  const editorPatternPool = useMemo(() => {
    const selected = patternFor(selectedKeymode);
    if (!selected || patternPool.candidates.some((entry) => entry.beatmapId === selected.beatmapId)) return patternPool;
    return { ...patternPool, candidates: [selected, ...patternPool.candidates] };
  }, [patternPool, selectedKeymode, patternFor]);

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
    // Which half failed. A download that never arrived says nothing about the
    // archive, and telling an uploader their file is unreadable when the
    // connection dropped sends them off to re-upload a skin that was fine.
    let phase: "download" | "parse" = "download";
    let status: number | null = null;
    let retrying = false;
    setError(null);
    setDownloadFailed(false);
    setLoading({ label: "Downloading the skin file", percent: null });
    (async () => {
      // A retry goes past the HTTP cache. The stored copy is often the reason
      // the first attempt failed: the same .osk is reachable by the download
      // button, an <a href> that sends no Origin and so is answered without an
      // allow-origin header, and browsers that cached that answer before the
      // backend started varying on Origin hand it back to this fetch, which
      // then fails the CORS check for the day the object stays fresh.
      const response = await fetch(oskUrl, {
        credentials: "omit",
        cache: downloadAttempt > 0 ? "reload" : "default",
      });
      if (!response.ok) {
        status = response.status;
        throw new Error(`Server ${response.status}`);
      }
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
      phase = "parse";
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
        if (cancelled) return;
        // The first failure is usually a connection that dropped and comes
        // back, so it goes again under the same progress strip instead of
        // flashing a message the retry would erase a second later. A 404 is
        // the exception: the object is not there, and a second ask says so
        // just as fast.
        if (!autoRetriedRef.current && status !== 404) {
          autoRetriedRef.current = true;
          retrying = true;
          setLoading({ label: "Downloading the skin file", percent: null });
          retryTimerRef.current = setTimeout(() => setDownloadAttempt((attempt) => attempt + 1), AUTO_RETRY_DELAY_MS);
          return;
        }
        setError(skinFileFailureMessage(phase, status));
        setDownloadFailed(true);
      })
      .finally(() => {
        if (!cancelled && !retrying) setLoading(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, needsSkinFile, imported, skin, downloadAttempt]);

  const retryDownload = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    setDownloadAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => () => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
  }, []);

  // Draws every retargeted keymode, skipping the ones already drawn against
  // the backdrop they are pointed at. Depends on the pool's decoder rather
  // than the pool itself, which changes identity as covers are drawn.
  const poolImage = pool.image;
  useEffect(() => {
    if (!imported) return;
    const queue = [...new Set([...pending.keys(), ...pendingPatterns.keys()])]
      .map((keys) => {
        const backdrop = backdropFor(keys) ?? "flat";
        const pattern = patternFor(keys) ?? null;
        return { keys, backdrop, pattern, signature: `${backdrop}|${pattern?.beatmapId ?? "builtin"}` };
      })
      .filter((entry) => renderedRef.current.get(entry.keys) !== entry.signature)
      .sort((a, b) => (a.keys === selectedKeymode ? -1 : b.keys === selectedKeymode ? 1 : a.keys - b.keys));
    if (queue.length === 0) return;
    let cancelled = false;
    setRendering(true);
    (async () => {
      for (const { keys, backdrop, pattern, signature } of queue) {
        if (cancelled) return;
        const background = backdrop === "flat" ? null : await poolImage(backdrop);
        if (cancelled) return;
        const render = await renderSkinPreview(imported.settings, keys, { background, pattern });
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
        renderedRef.current.set(keys, signature);
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
  }, [imported, pending, pendingPatterns, selectedKeymode, poolImage, backdropFor, patternFor]);

  // "All keymodes" retargets everything the skin ships, which is also how a
  // per-keymode pick is undone; "this keymode only" touches the one on screen.
  const pickBackdrop = useCallback((choice: PreviewBackdrop) => {
    setNeedsSkinFile(true);
    setPending((previous) => {
      if (scope === "all") return new Map(keymodes.map((keys) => [keys, choice] as const));
      return new Map(previous).set(selectedKeymode, choice);
    });
  }, [scope, keymodes, selectedKeymode]);

  // A snippet is cut from a chart of one keymode, so a pattern pick only ever
  // touches the keymode on screen. Historical previews have no recipe; only
  // those need a newly selected fallback backdrop as well.
  const pickPattern = useCallback((choice: SkinPreviewChartSnippet | null) => {
    setNeedsSkinFile(true);
    setPending((previous) => {
      if (previous.has(selectedKeymode) || publishedRecipes.has(selectedKeymode)) return previous;
      return new Map(previous).set(selectedKeymode, pool.candidates[0]?.setId ?? "flat");
    });
    setPendingPatterns((previous) => new Map(previous).set(selectedKeymode, choice));
  }, [pool.candidates, selectedKeymode, publishedRecipes]);

  // One click for "draw this skin again with the renderer as it is now",
  // which is what a fix to the playfield renderer needs. Stored recipes are
  // copied into the pending maps so neither visual choice changes. Historical
  // previews fall back once because their flattened images have no recipe.
  const rerenderAll = useCallback(() => {
    const fallback: PreviewBackdrop = pool.candidates[0]?.setId ?? "flat";
    const backdrops = new Map(keymodes.map((keys) => [keys, backdropFor(keys) ?? fallback] as const));
    const patterns = new Map(keymodes.map((keys) => [keys, patternFor(keys) ?? null] as const));
    setScope("all");
    setNeedsSkinFile(true);
    setPending(backdrops);
    setPendingPatterns(patterns);
  }, [pool.candidates, keymodes, backdropFor, patternFor]);

  const revertPreviews = useCallback(() => {
    setPending(new Map());
    setPendingPatterns(new Map());
    releaseRenders();
    setRenders(new Map());
    renderedRef.current.clear();
  }, [releaseRenders]);

  // A starred screenshot outranks the keymode star, so the two are compared
  // against what was published in that order.
  const coverChanged = coverShot !== publishedCoverShot
    || (coverShot == null && coverKeymode != null && coverKeymode !== publishedCoverKeymode);
  const labelsChanged = labelDrafts.some(
    (label, index) => index < skin.screenshots.length && label.trim() !== (skin.screenshots[index]?.label ?? ""),
  );
  const dirty = renders.size > 0 || coverChanged || labelsChanged;
  // A pick whose render has not landed yet (the archive may still be coming
  // down) holds the save button, so a pick is never silently dropped.
  const retargeted = useMemo(
    () => [...new Set([...pending.keys(), ...pendingPatterns.keys()])],
    [pending, pendingPatterns],
  );
  const awaitingRender = retargeted.length > 0
    && (rendering || loading != null || retargeted.some((keys) => !renders.has(keys)));

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
        await uploadSkinPreviewsParallel(
          uploads.map(([keys, render]) => ({ keys, sizeBytes: render.blob.size, render })),
          ({ keys, render }, onProgress) => uploadSkinPart({
            id: started.id,
            token: started.token,
            part: "preview",
            blob: render.blob,
            width: render.width,
            height: render.height,
            keys,
            // A re-rendered keymode that already fronts the card keeps fronting
            // it on the backend, so the flag is only for a cover that moved -
            // and not at all while a screenshot holds the card.
            cover: coverShot == null && keys === coverKeymode,
            accent: keys === coverKeymode ? render.accent : undefined,
            onProgress,
          }),
          ({ sentBytes, activeKeys, completed, total }) => setProgress({
            done: sentBytes,
            total: totalBytes,
            label: skinPreviewUploadLabel(activeKeys, completed, total),
          }),
        );
        setProgress({ done: totalBytes, total: totalBytes, label: "Saving." });
        current = await finishSkinEdit(
          started.id,
          started.token,
          uploads.map(([keys]) => ({
            keys,
            recipe: {
              backdrop: backdropFor(keys) ?? "flat",
              pattern: patternFor(keys) ?? null,
            },
          })),
        );
      }
      // A cover the uploads did not already carry is just a pointer move; no
      // image work involved. A starred screenshot is always one of those, and
      // it has to be re-asserted after any upload: re-rendering the keymode
      // that fronted the card drags the cover onto the new render server-side.
      const coverCarriedByUpload = coverShot == null && coverKeymode != null && renders.has(coverKeymode);
      if (!coverCarriedByUpload && (coverChanged || (coverShot != null && uploads.length > 0))) {
        const target = coverShot != null ? { screenshot: coverShot } : coverKeymode != null ? { keys: coverKeymode } : null;
        if (target) {
          const result = await setSkinCover({ data: { id: skin.id, ...target } });
          if (!result.ok) {
            setError("The card cover could not be changed. Try again.");
            setSaving(false);
            return;
          }
          current = result.skin ?? current;
        }
      }
      if (labelsChanged) {
        const result = await setSkinScreenshotLabels({
          data: { id: skin.id, labels: labelDrafts.slice(0, skin.screenshots.length).map((label) => label.trim()) },
        });
        if (!result.ok) {
          setError("The screenshot names could not be saved. Try again.");
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
        skin_screenshots_renamed: labelsChanged,
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
  }, [saving, dirty, renders, skin.id, skin.screenshots.length, coverKeymode, coverShot, coverChanged,
    labelsChanged, labelDrafts, revertPreviews, onSaved, onClose, backdropFor, patternFor]);

  const handleDismiss = useCallback(() => {
    if (saving) return;
    onClose();
  }, [saving, onClose]);

  // The cached parse survives openings, but not a .osk that was swapped for a
  // newer build: re-renders would otherwise draw notes nobody can download.
  useEffect(() => {
    setImported(null);
    setNeedsSkinFile(false);
    setDownloadFailed(false);
    autoRetriedRef.current = false;
  }, [skin.oskUrl]);

  // Everything but the parsed .osk resets between openings: the parse is the
  // slow part, and it is still valid for the same skin.
  useEffect(() => {
    if (open) return;
    revertPreviews();
    setError(null);
    setScope("all");
    setNeedsSkinFile(false);
    setDownloadFailed(false);
    autoRetriedRef.current = false;
    setCoverKeymode(publishedCoverKeymode ?? skin.previews[0]?.keys ?? null);
    setCoverShot(publishedCoverShot);
    setLabelDrafts(skin.screenshots.map((shot) => shot.label ?? ""));
    setSelectedKeymode(publishedCoverKeymode ?? keymodes[0] ?? 4);
  }, [open, revertPreviews, publishedCoverKeymode, publishedCoverShot, skin.previews, skin.screenshots, keymodes]);

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
                  {coverKeymode === selectedKeymode && coverShot == null ? (
                    <span className="flex items-center gap-1 font-bold text-osu-pink">
                      <Star size={11} aria-hidden="true" />
                      card cover
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={saving || (!publishedPreviewUrl(selectedKeymode) && !renders.has(selectedKeymode))}
                      onClick={() => {
                        setCoverKeymode(selectedKeymode);
                        // Starring a keymode takes the card back off a
                        // screenshot that was holding it.
                        setCoverShot(null);
                      }}
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
                          {coverKeymode === keys && coverShot == null && (
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

                <SkinPreviewPickers
                  disabled={busy}
                  backdrop={{
                    pool: editorBackdropPool,
                    selected: backdropFor(selectedKeymode) ?? null,
                    onPick: pickBackdrop,
                    scope,
                    onScopeChange: setScope,
                    keymodeLabel: `${selectedKeymode}K`,
                    hint: changedKeymodes.length > 0 ? (
                      <span className="text-[10px] text-osu-f1/55">
                        {changedKeymodes.map((keys) => `${keys}K`).join(", ")} re-rendered
                      </span>
                    ) : null,
                  }}
                  pattern={{
                    pool: editorPatternPool,
                    selected: patternFor(selectedKeymode),
                    onPick: pickPattern,
                  }}
                />
                <p className="mt-2 text-[11px] leading-relaxed text-osu-f1/70">
                  Picking a backdrop or a pattern re-renders that playfield from the uploaded .osk while preserving
                  its other saved choice. Patterns are cut from real charts, one keymode at a time. Keymodes left
                  alone keep the previews they were published with.
                </p>
                {!publishedRecipes.has(selectedKeymode) && publishedPreviewUrl(selectedKeymode) ? (
                  <p className="mt-1 text-[10.5px] leading-relaxed text-osu-f1/55">
                    This older {selectedKeymode}K preview predates saved render choices. Its first re-render needs a
                    new backdrop and pattern; later edits will preserve both.
                  </p>
                ) : null}

                {/* The screenshots this skin was published with: renaming one
                    retitles it in the gallery, starring one puts it on the
                    browse card in place of a rendered playfield. New ones are
                    not accepted here - the .osk flow is where images arrive,
                    which is why neither add nor remove is wired up. */}
                {skin.screenshots.length > 0 && (
                  <div className="mt-4">
                    <SkinScreenshotFields
                      screenshots={skin.screenshots.map((shot, index) => ({
                        url: shot.url,
                        label: labelDrafts[index] ?? "",
                      }))}
                      onRename={(index, label) => setLabelDrafts((previous) => {
                        const next = skin.screenshots.map((_, i) => previous[i] ?? "");
                        next[index] = label;
                        return next;
                      })}
                      cover={coverShot}
                      onCover={setCoverShot}
                      disabled={saving}
                    />
                  </div>
                )}

                {error && (
                  <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] font-semibold text-osu-red-light">
                    {error}
                    {downloadFailed && loading == null && (
                      <button
                        type="button"
                        onClick={retryDownload}
                        className="font-semibold text-osu-l2 underline underline-offset-2 transition-colors cursor-pointer hover:text-white"
                      >
                        Try again
                      </button>
                    )}
                  </p>
                )}

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
