import { motion } from "framer-motion";
import { Star, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { importReplaySkinFromOsk, type ReplaySkinImportResult } from "../../lib/replay-skin-import";
import type { BulkPreparedRender } from "../../lib/skin-bulk-upload";
import type { SkinBackdropRowPool } from "./SkinBackdropPicker";
import { useSkinPatternPool } from "./SkinPatternPicker";
import { SkinPreviewPickers } from "./SkinPreviewPickers";
import type { SkinPreviewChartSnippet } from "../../lib/skin-preview-patterns";
import {
  applyBackdropPick,
  backdropForKeymode,
  type BackdropScope,
  drawSkinPreviewBackdrops,
  type PreviewBackdrop,
  replaceBackdrop,
  type SkinBackdropCandidate,
} from "../../lib/skin-preview-backdrops";
import { loadSkinPreviewBackgroundForSet, renderSkinPreview } from "../../lib/skin-preview-render";
import { processScreenshot, type DraftScreenshot } from "../../lib/skin-screenshot-process";
import { SkinScreenshotFields } from "./SkinScreenshotFields";
import {
  formatSkinFileSize,
  SKIN_AUTHOR_MAX_LENGTH,
  SKIN_DESCRIPTION_MAX_LENGTH,
  SKIN_MAX_SCREENSHOTS,
} from "../../lib/skins";

// The bulk queue's way into the single-upload form: opening a row parses that
// one .osk in full and offers the same controls a normal upload gets - live
// previews per keymode, the backdrop picker, the card cover star, description
// and screenshots. Saving hands the finished renders back to the queue, so the
// run later streams them as-is instead of parsing and drawing a second time.

export interface BulkEditorRender extends BulkPreparedRender {
  url: string;
}

// What a saved edit pins onto a queue row. The backdrop selection and the
// chart each keymode's notes came from are kept alongside the renders so
// reopening the editor starts from the same picks instead of re-rolling them.
export interface BulkItemDetails {
  description: string;
  coverKeymode: number;
  // A screenshot starred over the rendered playfields; null leaves the card to
  // coverKeymode.
  coverScreenshot: number | null;
  backdrop: PreviewBackdrop;
  backdropOverrides: Array<[number, PreviewBackdrop]>;
  patterns: Array<[number, SkinPreviewChartSnippet | null]>;
  renders: BulkEditorRender[];
  screenshots: DraftScreenshot[];
}

export interface BulkEditorResult {
  name: string;
  author: string;
  details: BulkItemDetails;
}

function randomPoolPick(pool: SkinBackdropCandidate[]): PreviewBackdrop {
  return pool[Math.floor(Math.random() * pool.length)]?.setId ?? "flat";
}

export function SkinBulkDetailsEditor({
  file,
  initialName,
  initialAuthor,
  initialDetails,
  onSave,
  onCancel,
}: {
  file: File;
  initialName: string;
  initialAuthor: string;
  initialDetails: BulkItemDetails | null;
  onSave: (result: BulkEditorResult) => void;
  onCancel: () => void;
}) {
  const [imported, setImported] = useState<ReplaySkinImportResult | null>(null);
  const [readingPercent, setReadingPercent] = useState<number | null>(0);
  const [parseError, setParseError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(initialName);
  const [author, setAuthor] = useState(initialAuthor);
  const [description, setDescription] = useState(initialDetails?.description ?? "");
  const [screenshots, setScreenshots] = useState<DraftScreenshot[]>(initialDetails?.screenshots ?? []);
  const [selectedKeymode, setSelectedKeymode] = useState(initialDetails?.coverKeymode ?? 4);
  const [coverKeymode, setCoverKeymode] = useState(initialDetails?.coverKeymode ?? 4);
  const [coverShot, setCoverShot] = useState<number | null>(initialDetails?.coverScreenshot ?? null);

  // A reopened row starts from its saved renders, so the editor shows the
  // previous session's previews immediately instead of a blank hero.
  const [previews, setPreviews] = useState<Map<number, BulkEditorRender>>(
    () => new Map((initialDetails?.renders ?? []).map((render) => [render.keys, render])),
  );
  const [previewBusy, setPreviewBusy] = useState(false);

  const [backdropPool, setBackdropPool] = useState<SkinBackdropCandidate[]>([]);
  const backdropPoolRef = useRef<SkinBackdropCandidate[]>([]);
  const [backdropDrawing, setBackdropDrawing] = useState(false);
  const [backdrop, setBackdrop] = useState<PreviewBackdrop>(initialDetails?.backdrop ?? "flat");
  const [backdropOverrides, setBackdropOverrides] = useState<Map<number, PreviewBackdrop>>(
    () => new Map(initialDetails?.backdropOverrides ?? []),
  );
  const [backdropScope, setBackdropScope] = useState<BackdropScope>("all");
  // Saved picks stay put; only a fresh edit lets the pool draw pick a default.
  const backdropTouchedRef = useRef(initialDetails != null);
  const drawInFlightRef = useRef(false);
  const backgroundPromisesRef = useRef<Map<number, Promise<HTMLImageElement | null>>>(new Map());
  const backgroundImagesRef = useRef<Map<number, HTMLImageElement | null>>(new Map());

  // One chart per keymode, restored from the saved edit when there is one.
  const [patterns, setPatterns] = useState<Map<number, SkinPreviewChartSnippet | null>>(
    () => new Map(initialDetails?.patterns ?? []),
  );
  const patternPool = useSkinPatternPool(true, selectedKeymode);

  // What each keymode's image on screen was drawn from, backdrop and notes
  // both. Seeded from the saved selection, so an unchanged pick does not redraw
  // a render that already matches it.
  const [renderedSignatures] = useState<Map<number, string>>(() => {
    const seeded = new Map<number, string>();
    if (initialDetails) {
      const selection = { shared: initialDetails.backdrop, overrides: new Map(initialDetails.backdropOverrides) };
      const saved = new Map(initialDetails.patterns ?? []);
      for (const render of initialDetails.renders) {
        const pattern = saved.get(render.keys) ?? null;
        seeded.set(render.keys, `${backdropForKeymode(selection, render.keys)}|${pattern?.beatmapId ?? "builtin"}`);
      }
    }
    return seeded;
  });
  const hasRenderedRef = useRef((initialDetails?.renders.length ?? 0) > 0);

  // Object URLs this editor created, as opposed to ones borrowed from the
  // saved details (those belong to the queue until it replaces them). Saving
  // transfers ownership of whatever went into the payload; unmount revokes
  // the rest.
  const ownedUrlsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const owned = ownedUrlsRef.current;
    return () => {
      owned.forEach((url) => URL.revokeObjectURL(url));
      owned.clear();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Full parse of this one archive, the thing the queue deliberately skips.
  useEffect(() => {
    let cancelled = false;
    let lastPercent = -1;
    setReadingPercent(0);
    importReplaySkinFromOsk(file, {
      targetKeyCount: 4,
      onProgress: (done, total) => {
        if (cancelled) return;
        const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        if (percent !== lastPercent) {
          lastPercent = percent;
          setReadingPercent(percent);
        }
      },
    })
      .then((result) => {
        if (cancelled) return;
        setImported(result);
        setName((previous) => (previous.trim() ? previous : result.summary.name.slice(0, 80)));
        setAuthor((previous) => (previous.trim() ? previous : (result.summary.author ?? "").slice(0, SKIN_AUTHOR_MAX_LENGTH)));
        const keymodes = result.summary.keymodes;
        const fallback = keymodes.includes(4) ? 4 : keymodes[0] ?? 4;
        setSelectedKeymode((previous) => (keymodes.includes(previous) ? previous : fallback));
        setCoverKeymode((previous) => (keymodes.includes(previous) ? previous : fallback));
      })
      .catch((importError) => {
        if (!cancelled) setParseError(importError instanceof Error ? importError.message : "This .osk could not be read.");
      })
      .finally(() => {
        if (!cancelled) setReadingPercent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const ensureBackdropImage = useCallback((setId: number): Promise<HTMLImageElement | null> => {
    let promise = backgroundPromisesRef.current.get(setId);
    if (!promise) {
      promise = loadSkinPreviewBackgroundForSet(setId).catch(() => null);
      backgroundPromisesRef.current.set(setId, promise);
      void promise.then((image) => backgroundImagesRef.current.set(setId, image));
    }
    return promise;
  }, []);

  const drawBackdrops = useCallback(async (exclude: number[]) => {
    setBackdropDrawing(true);
    try {
      const pool = await drawSkinPreviewBackdrops({ exclude });
      backdropPoolRef.current = pool;
      setBackdropPool(pool);
      return pool;
    } finally {
      setBackdropDrawing(false);
    }
  }, []);

  useEffect(() => {
    if (backdropPool.length > 0 || drawInFlightRef.current) return;
    drawInFlightRef.current = true;
    void drawBackdrops([])
      .then((pool) => {
        if (!backdropTouchedRef.current) setBackdrop(randomPoolPick(pool));
      })
      .catch(() => {})
      .finally(() => {
        drawInFlightRef.current = false;
      });
  }, [backdropPool.length, drawBackdrops]);

  const pickBackdrop = useCallback((choice: PreviewBackdrop) => {
    backdropTouchedRef.current = true;
    const next = applyBackdropPick(
      { shared: backdrop, overrides: backdropOverrides },
      { scope: backdropScope, keymode: selectedKeymode, choice },
    );
    setBackdrop(next.shared);
    setBackdropOverrides(next.overrides);
  }, [backdrop, backdropOverrides, backdropScope, selectedKeymode]);

  const shuffleBackdrops = useCallback(() => {
    backdropTouchedRef.current = true;
    drawInFlightRef.current = true;
    void drawBackdrops(backdropPool.map((candidate) => candidate.setId))
      .then((pool) => pickBackdrop(randomPoolPick(pool)))
      .catch(() => {})
      .finally(() => {
        drawInFlightRef.current = false;
      });
  }, [backdropPool, drawBackdrops, pickBackdrop]);

  const prefetchBackdrop = useCallback((setId: number) => {
    void ensureBackdropImage(setId);
  }, [ensureBackdropImage]);

  const dropBackdropCandidate = useCallback((setId: number) => {
    const remaining = backdropPoolRef.current.filter((candidate) => candidate.setId !== setId);
    backdropPoolRef.current = remaining;
    setBackdropPool(remaining);
    const next = replaceBackdrop(
      { shared: backdrop, overrides: backdropOverrides },
      setId,
      randomPoolPick(remaining),
    );
    setBackdrop(next.shared);
    setBackdropOverrides(next.overrides);
  }, [backdrop, backdropOverrides]);

  const backdropFor = useCallback(
    (keys: number): PreviewBackdrop => backdropForKeymode({ shared: backdrop, overrides: backdropOverrides }, keys),
    [backdrop, backdropOverrides],
  );

  // The shape the shared picker row reads, out of the backdrop state this
  // editor keeps itself.
  const backdropRowPool = useMemo<SkinBackdropRowPool>(() => ({
    candidates: backdropPool,
    drawing: backdropDrawing,
    shuffle: shuffleBackdrops,
    drop: dropBackdropCandidate,
    prefetch: prefetchBackdrop,
  }), [backdropPool, backdropDrawing, shuffleBackdrops, dropBackdropCandidate, prefetchBackdrop]);

  useEffect(() => {
    for (const choice of [backdrop, ...backdropOverrides.values()]) {
      if (choice !== "flat") void ensureBackdropImage(choice);
    }
  }, [backdrop, backdropOverrides, ensureBackdropImage]);

  const pickPattern = useCallback((choice: SkinPreviewChartSnippet | null) => {
    setPatterns((previous) => new Map(previous).set(selectedKeymode, choice));
  }, [selectedKeymode]);

  // Deals a chart to every keymode that has none yet, which for a row opened
  // straight from the queue is all of them.
  const patternEnsure = patternPool.ensure;
  useEffect(() => {
    if (!imported) return;
    let cancelled = false;
    for (const keys of imported.summary.keymodes) {
      void patternEnsure(keys).then((available) => {
        if (cancelled || available.length === 0) return;
        setPatterns((previous) => {
          if (previous.has(keys)) return previous;
          return new Map(previous).set(keys, available[Math.floor(Math.random() * available.length)]);
        });
      });
    }
    return () => {
      cancelled = true;
    };
  }, [imported, patternEnsure]);

  // Same render loop as the single-upload form: 4K first, only the keymodes
  // whose backdrop actually moved, previews held on screen while a new cover
  // decodes.
  useEffect(() => {
    if (!imported) return;
    const keymodes = [...imported.summary.keymodes].sort((a, b) => (a === 4 ? -1 : b === 4 ? 1 : a - b));
    const patternFor = (keys: number) => patterns.get(keys) ?? null;
    const signatureFor = (keys: number) => `${backdropFor(keys)}|${patternFor(keys)?.beatmapId ?? "builtin"}`;
    const pending = keymodes.filter((keys) => renderedSignatures.get(keys) !== signatureFor(keys));
    if (pending.length === 0) return;
    let cancelled = false;
    setPreviewBusy(true);
    const renderOne = async (keys: number, background: HTMLImageElement | null) => {
      const render = await renderSkinPreview(imported.settings, keys, { background, pattern: patternFor(keys) });
      if (cancelled) return;
      const url = URL.createObjectURL(render.blob);
      ownedUrlsRef.current.add(url);
      setPreviews((previous) => {
        const replaced = previous.get(keys);
        // Borrowed URLs (a reopened row's saved renders) stay alive for the
        // queue; only this editor's own casualties are revoked.
        if (replaced && ownedUrlsRef.current.has(replaced.url)) {
          URL.revokeObjectURL(replaced.url);
          ownedUrlsRef.current.delete(replaced.url);
        }
        return new Map(previous).set(keys, {
          keys,
          blob: render.blob,
          width: render.width,
          height: render.height,
          accent: render.accent,
          recipe: { backdrop: backdropFor(keys), pattern: patternFor(keys) },
          url,
        });
      });
      hasRenderedRef.current = true;
    };
    const backgroundFor = async (choice: PreviewBackdrop): Promise<HTMLImageElement | null> => {
      if (choice === "flat") return null;
      if (backgroundImagesRef.current.has(choice)) return backgroundImagesRef.current.get(choice) ?? null;
      return ensureBackdropImage(choice);
    };
    (async () => {
      const first = backdropFor(pending[0]);
      if (!hasRenderedRef.current && first !== "flat" && !backgroundImagesRef.current.has(first)) {
        for (const keys of pending) {
          if (cancelled) return;
          await renderOne(keys, null);
        }
      }
      for (const keys of pending) {
        if (cancelled) return;
        const signature = signatureFor(keys);
        const background = await backgroundFor(backdropFor(keys));
        if (cancelled) return;
        await renderOne(keys, background);
        renderedSignatures.set(keys, signature);
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
  }, [imported, backdropFor, patterns, ensureBackdropImage, renderedSignatures]);

  const addScreenshots = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    const room = SKIN_MAX_SCREENSHOTS - screenshots.length;
    const picked = [...files].slice(0, room);
    const processed: DraftScreenshot[] = [];
    for (const shot of picked) {
      const result = await processScreenshot(shot).catch(() => null);
      if (result) {
        processed.push({ ...result, label: "" });
        ownedUrlsRef.current.add(result.url);
      } else {
        setError("A screenshot could not be read as a PNG, JPEG, or WebP under 4 MB.");
      }
    }
    if (processed.length > 0) setScreenshots((previous) => [...previous, ...processed]);
  }, [screenshots.length]);

  const renameScreenshot = useCallback((index: number, label: string) => {
    setScreenshots((previous) => previous.map((shot, i) => (i === index ? { ...shot, label } : shot)));
  }, []);

  const removeScreenshot = useCallback((index: number) => {
    setScreenshots((previous) => {
      const removed = previous[index];
      if (removed && ownedUrlsRef.current.has(removed.url)) {
        URL.revokeObjectURL(removed.url);
        ownedUrlsRef.current.delete(removed.url);
      }
      return previous.filter((_, i) => i !== index);
    });
    // The cover follows the shots it sits among, and removing it hands the card
    // back to a keymode.
    setCoverShot((previous) => (previous == null || previous === index ? null : previous > index ? previous - 1 : previous));
  }, []);

  const keymodes = imported?.summary.keymodes ?? [];
  const complete = imported !== null && keymodes.length > 0 && keymodes.every((keys) => previews.has(keys));
  const canSave = complete && !previewBusy && name.trim().length > 0;

  const keymodesWithoutNoteArt = useMemo(() => {
    if (!imported) return new Set<number>();
    const missing = new Set<number>();
    for (const keys of imported.summary.keymodes) {
      const profile = imported.settings.keymodeProfiles[String(keys)];
      const hasNoteArt = profile?.assets.columns.some((column) => column.tap || column.lnHead || column.lnBody);
      if (!hasNoteArt) missing.add(keys);
    }
    return missing;
  }, [imported]);

  const handleSave = useCallback(() => {
    if (!canSave) return;
    const renders = [...previews.entries()].sort(([a], [b]) => a - b).map(([, render]) => render);
    const details: BulkItemDetails = {
      description: description.trim(),
      coverKeymode: previews.has(coverKeymode) ? coverKeymode : renders[0].keys,
      coverScreenshot: coverShot != null && coverShot < screenshots.length ? coverShot : null,
      backdrop,
      backdropOverrides: [...backdropOverrides.entries()],
      patterns: [...patterns.entries()],
      renders,
      screenshots,
    };
    // These URLs now belong to the queue row; the unmount cleanup must not
    // pull them out from under it.
    for (const render of renders) ownedUrlsRef.current.delete(render.url);
    for (const shot of screenshots) ownedUrlsRef.current.delete(shot.url);
    onSave({
      name: name.trim().slice(0, 80),
      author: author.trim().slice(0, SKIN_AUTHOR_MAX_LENGTH),
      details,
    });
  }, [author, backdrop, backdropOverrides, canSave, coverKeymode, coverShot, description, name, onSave, patterns, previews, screenshots]);

  if (typeof document === "undefined") return null;

  const heroPreview = previews.get(selectedKeymode);

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.12 }}
      className="fixed inset-0 z-[130] flex items-center justify-center p-3 sm:p-6"
    >
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onCancel} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Edit details for ${file.name}`}
        className="relative flex max-h-full w-full max-w-[880px] flex-col overflow-hidden rounded-2xl bg-osu-b5 ring-1 ring-white/10 shadow-2xl"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-osu-b3/30 px-4 py-3 sm:px-5">
          <span className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-osu-pink-light">edit skin details</span>
          <span className="min-w-0 truncate text-[11px] text-osu-f1">
            {file.name} · {formatSkinFileSize(file.size)}
          </span>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close without saving"
            className="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-full text-osu-f1 transition-colors cursor-pointer hover:bg-osu-b3/50 hover:text-white"
          >
            <X className="h-4 w-4" strokeWidth={2.4} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          {parseError ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-[13px] font-semibold text-osu-red-light">{parseError}</p>
              <button
                type="button"
                onClick={onCancel}
                className="rounded-full border border-osu-b3/40 px-4 py-2 text-[12.5px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:text-white"
              >
                Back to the queue
              </button>
            </div>
          ) : !imported ? (
            <div className="flex min-h-[240px] items-center justify-center">
              <div className="w-full max-w-[340px] text-center">
                <div className="truncate text-sm font-semibold text-white">Reading {file.name}</div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-osu-b4">
                  <div
                    className="h-full bg-osu-pink transition-[width] duration-100"
                    style={{ width: `${readingPercent ?? 2}%` }}
                  />
                </div>
                <div className="mt-1.5 text-[11px] tabular-nums text-osu-f1">
                  {readingPercent == null ? "Opening the archive..." : `Decoding the skin's images, ${readingPercent}%`}
                </div>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <div className="min-w-0">
                <div className="relative overflow-hidden rounded-xl border border-osu-b3/30 bg-osu-b4">
                  <div className="aspect-video w-full">
                    {heroPreview ? (
                      <img src={heroPreview.url} alt={`${selectedKeymode}K preview`} className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center text-[12px] text-osu-f1">Rendering the {selectedKeymode}K playfield...</div>
                    )}
                  </div>
                  {heroPreview && previewBusy && (
                    <div className="pointer-events-none absolute right-2 top-2 rounded bg-osu-b5/85 px-1.5 py-0.5 text-[10px] font-bold text-osu-l2">
                      updating
                    </div>
                  )}
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-osu-f1">Viewing <span className="font-bold text-osu-l2 tabular-nums">{selectedKeymode}K</span></span>
                  {selectedKeymode === coverKeymode && coverShot == null ? (
                    <span className="flex items-center gap-1 font-bold text-osu-pink">
                      <Star size={11} aria-hidden="true" />
                      card cover
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setCoverKeymode(selectedKeymode);
                        setCoverShot(null);
                      }}
                      className="flex items-center gap-1 font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l1"
                    >
                      <Star size={11} aria-hidden="true" />
                      Use {selectedKeymode}K as the card cover
                    </button>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-start gap-2">
                  {keymodes.map((keys) => {
                    const preview = previews.get(keys);
                    const selected = selectedKeymode === keys;
                    const isCover = coverKeymode === keys && coverShot == null;
                    const missingNoteArt = keymodesWithoutNoteArt.has(keys);
                    return (
                      <button
                        key={keys}
                        type="button"
                        onClick={() => setSelectedKeymode(keys)}
                        aria-pressed={selected}
                        title={missingNoteArt ? `The ${keys}K block resolves no note images; the preview shows flat colours.` : undefined}
                        className={`w-[104px] overflow-hidden rounded-lg border text-left transition-colors duration-100 cursor-pointer ${
                          selected ? "border-osu-pink" : "border-osu-b3/40 hover:border-osu-f1/40"
                        }`}
                      >
                        <div className="aspect-video w-full bg-osu-b4">
                          {preview ? (
                            <img src={preview.url} alt={`${keys}K thumbnail`} className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full items-center justify-center text-[10px] text-osu-f1/60">rendering</div>
                          )}
                        </div>
                        <div className={`flex items-center gap-1 px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums ${selected ? "bg-osu-pink text-white" : "bg-osu-b4 text-osu-l2"}`}>
                          {keys}K
                          {isCover && <Star size={9} className={selected ? "text-white" : "text-osu-pink"} aria-label="card cover" />}
                          {backdropOverrides.has(keys) && (
                            <span className={selected ? "text-white/80" : "text-osu-f1/70"} title="Has its own backdrop" aria-hidden="true">*</span>
                          )}
                          {missingNoteArt && <span className={selected ? "text-white/80" : "text-osu-yellow"} aria-hidden="true">!</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
                {keymodesWithoutNoteArt.has(selectedKeymode) && (
                  <p className="mt-2 text-[11px] font-semibold text-osu-yellow">
                    The {selectedKeymode}K block resolves no note images, so this preview uses flat colours.
                  </p>
                )}

                <SkinPreviewPickers
                  disabled={previewBusy}
                  backdrop={{
                    pool: backdropRowPool,
                    selected: backdropFor(selectedKeymode),
                    onPick: pickBackdrop,
                    scope: backdropScope,
                    onScopeChange: setBackdropScope,
                    keymodeLabel: `${selectedKeymode}K`,
                    hint: backdropOverrides.size > 0 ? (
                      <span className="text-[10px] text-osu-f1/55">
                        {[...backdropOverrides.keys()].sort((a, b) => a - b).map((keys) => `${keys}K`).join(", ")} on their own
                      </span>
                    ) : null,
                  }}
                  pattern={{
                    pool: patternPool,
                    selected: patterns.get(selectedKeymode) ?? null,
                    onPick: pickPattern,
                  }}
                />
              </div>

              <div className="flex min-w-0 flex-col gap-3.5">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">Name</span>
                  <input
                    type="text"
                    value={name}
                    maxLength={80}
                    onChange={(event) => setName(event.target.value)}
                    className="w-full rounded-lg border border-osu-b3/30 bg-osu-b4 px-3 py-2 text-[13.5px] text-osu-l1 transition-colors focus:border-osu-pink/50 focus:outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
                    Made by <span className="normal-case tracking-normal text-osu-f1/70">(from skin.ini, credited on the card)</span>
                  </span>
                  <input
                    type="text"
                    value={author}
                    maxLength={SKIN_AUTHOR_MAX_LENGTH}
                    onChange={(event) => setAuthor(event.target.value)}
                    placeholder="The skin's original creator"
                    className="w-full rounded-lg border border-osu-b3/30 bg-osu-b4 px-3 py-2 text-[13.5px] text-osu-l1 transition-colors placeholder:text-osu-f1/45 focus:border-osu-pink/50 focus:outline-none"
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
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="A line about the skin"
                    className="w-full resize-y rounded-lg border border-osu-b3/30 bg-osu-b4 px-3 py-2 text-[13px] leading-relaxed text-osu-l1 transition-colors placeholder:text-osu-f1/45 focus:border-osu-pink/50 focus:outline-none"
                  />
                </label>
                <SkinScreenshotFields
                  screenshots={screenshots}
                  onAdd={(files) => void addScreenshots(files)}
                  onRename={renameScreenshot}
                  onRemove={removeScreenshot}
                  cover={coverShot}
                  onCover={setCoverShot}
                />

                <div className="mt-auto flex flex-col gap-2.5 pt-1">
                  {error && <div className="text-[12px] font-semibold text-osu-red-light">{error}</div>}
                  <div className="flex flex-wrap items-center gap-2.5">
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={!canSave}
                      className="rounded-full bg-osu-pink px-6 py-2 text-[13px] font-bold text-white transition cursor-pointer hover:brightness-110 disabled:cursor-default disabled:opacity-50"
                    >
                      Save details
                    </button>
                    <button
                      type="button"
                      onClick={onCancel}
                      className="text-[12px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l1"
                    >
                      Cancel
                    </button>
                    <span className="text-[11px] text-osu-f1">Publishing still happens with the queue's run.</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>,
    document.body,
  );
}
