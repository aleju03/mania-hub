import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Layers, Pencil, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { readOskManifest } from "../../lib/replay-skin-import";
import {
  SkinBulkDetailsEditor,
  type BulkEditorResult,
  type BulkItemDetails,
} from "./SkinBulkDetailsEditor";
import {
  BulkUploadCancelled,
  drawBulkBackdrops,
  publishBulkSkin,
  RequestPacer,
  type BulkPhase,
  type BulkUploadUpdate,
} from "../../lib/skin-bulk-upload";
import { PatternDealer } from "../../lib/skin-preview-patterns";
import {
  formatSkinFileSize,
  markSkinsListStale,
  type DuplicateSkinRef,
  type SkinSummary,
} from "../../lib/skins";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";

// Admin-only bulk publish: drop a folder's worth of .osk files, watch them go
// up one by one. Every file takes the same path a single upload does, so the
// results are ordinary skins - the only difference is that the per-user caps
// are lifted for the run and nobody is *made* to fill a form forty times. Any
// row can still opt into the full single-upload form (previews, backdrops,
// cover, description, screenshots) through its pencil button.

interface BulkItem {
  id: string;
  file: File;
  // From skin.ini, editable before the run starts.
  name: string;
  author: string | null;
  keymodes: number[];
  // Everything the per-file editor saved; null rows publish with defaults.
  details: BulkItemDetails | null;
  phase: BulkPhase;
  progress: number;
  message: string | null;
  skin: SkinSummary | null;
  duplicate: DuplicateSkinRef | null;
}

// The saved renders and screenshots hold object URLs; dropping a row (or its
// details) without revoking them would leak the blobs for the session.
function releaseDetails(details: BulkItemDetails | null): void {
  if (!details) return;
  for (const render of details.renders) URL.revokeObjectURL(render.url);
  for (const shot of details.screenshots) URL.revokeObjectURL(shot.url);
}

const PHASE_LABELS: Record<BulkPhase, string> = {
  queued: "queued",
  reading: "reading",
  rendering: "rendering",
  uploading: "uploading",
  published: "published",
  duplicate: "duplicate",
  failed: "failed",
};

const PHASE_STYLES: Record<BulkPhase, string> = {
  queued: "bg-osu-b5 text-osu-f1",
  reading: "bg-osu-b5 text-osu-l2",
  rendering: "bg-osu-b5 text-osu-l2",
  uploading: "bg-osu-b5 text-osu-l2",
  published: "bg-osu-green/20 text-osu-green",
  duplicate: "bg-osu-yellow/15 text-osu-yellow",
  failed: "bg-osu-red-light/15 text-osu-red-light",
};

export function SkinBulkUploadModal({
  open,
  onClose,
  onPublished,
}: {
  open: boolean;
  onClose: () => void;
  onPublished: (skin: SkinSummary) => void;
}) {
  const [items, setItems] = useState<BulkItem[]>([]);
  const [reading, setReading] = useState(0);
  const [running, setRunning] = useState(false);
  // The row whose details editor is open, if any.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bodyLockActive, setBodyLockActive] = useState(false);
  const cancelRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const counts = useMemo(() => ({
    queued: items.filter((item) => item.phase === "queued").length,
    published: items.filter((item) => item.phase === "published").length,
    duplicate: items.filter((item) => item.phase === "duplicate").length,
    failed: items.filter((item) => item.phase === "failed").length,
  }), [items]);

  const patch = useCallback((id: string, update: BulkUploadUpdate) => {
    setItems((previous) => previous.map((item) => (item.id === id
      ? {
        ...item,
        phase: update.phase,
        progress: update.progress ?? item.progress,
        message: update.message !== undefined ? update.message : item.message,
        skin: update.skin ?? item.skin,
        duplicate: update.duplicate ?? item.duplicate,
      }
      : item)));
  }, []);

  const addFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    const picked = [...files].filter((file) => /\.(osk|zip)$/i.test(file.name));
    if (picked.length === 0) {
      setError("Those files are not .osk archives.");
      return;
    }
    setReading((previous) => previous + picked.length);
    for (const file of picked) {
      // skin.ini only: reading forty archives in full would take minutes and
      // hold every decoded image in memory at once.
      try {
        const manifest = await readOskManifest(file);
        setItems((previous) => previous.some((item) => item.file.name === file.name && item.file.size === file.size)
          ? previous
          : [...previous, {
            id: `${file.name}:${file.size}:${previous.length}`,
            file,
            name: manifest.name.slice(0, 80),
            author: manifest.author,
            keymodes: manifest.keymodes,
            details: null,
            phase: "queued",
            progress: 0,
            message: null,
            skin: null,
            duplicate: null,
          }]);
      } catch (readError) {
        setItems((previous) => [...previous, {
          id: `${file.name}:${file.size}:${previous.length}`,
          file,
          name: file.name.replace(/\.[^.]+$/, "").slice(0, 80),
          author: null,
          keymodes: [],
          details: null,
          phase: "failed",
          progress: 0,
          message: readError instanceof Error ? readError.message : "This .osk could not be read.",
          skin: null,
          duplicate: null,
        }]);
      } finally {
        setReading((previous) => Math.max(0, previous - 1));
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const run = useCallback(async () => {
    const pending = items.filter((item) => item.phase === "queued" || item.phase === "failed");
    if (pending.length === 0) return;
    cancelRef.current = false;
    setRunning(true);
    setError(null);
    const context = {
      // Sized to the queue, so seventeen files get seventeen different covers.
      dealer: await drawBulkBackdrops(pending.length),
      backdrops: new Map<number, HTMLImageElement | null>(),
      // Chart snippets are dealt per keymode as the run reaches them, so the
      // notes differ from card to card the way the covers do.
      patterns: new PatternDealer(),
      cancelled: () => cancelRef.current,
      // One window for the whole run: the backend counts per address.
      pacer: new RequestPacer(),
    };
    try {
      for (const item of pending) {
        if (cancelRef.current) break;
        patch(item.id, { phase: "queued", progress: 0, message: null });
        const skin = await publishBulkSkin(
          { file: item.file, name: item.name, author: item.author, details: item.details },
          context,
          (update) => patch(item.id, update),
        );
        if (skin) {
          markSkinsListStale();
          onPublished(skin);
          // A published row cannot be edited again, so its prepared renders
          // and screenshots have nothing left to do.
          if (item.details) {
            releaseDetails(item.details);
            setItems((previous) => previous.map((current) => (
              current.id === item.id ? { ...current, details: null } : current
            )));
          }
        }
      }
    } catch (runError) {
      if (!(runError instanceof BulkUploadCancelled)) {
        setError(runError instanceof Error ? runError.message : "The run stopped unexpectedly.");
      }
    } finally {
      setRunning(false);
      // A cancelled row is left mid-phase; put it back in the queue so the
      // next run picks it up instead of showing it as forever uploading.
      setItems((previous) => previous.map((current) => (
        current.phase === "reading" || current.phase === "rendering" || current.phase === "uploading"
          ? { ...current, phase: "queued", progress: 0, message: "Stopped." }
          : current
      )));
    }
  }, [items, onPublished, patch]);

  const removeItem = useCallback((id: string) => {
    setItems((previous) => {
      releaseDetails(previous.find((item) => item.id === id)?.details ?? null);
      return previous.filter((item) => item.id !== id);
    });
  }, []);

  const clearDone = useCallback(() => {
    setItems((previous) => {
      for (const item of previous) {
        if (item.phase === "published" || item.phase === "duplicate") releaseDetails(item.details);
      }
      return previous.filter((item) => item.phase !== "published" && item.phase !== "duplicate");
    });
  }, []);

  // A saved edit lands on the row: name and author go where the inline rename
  // already lives, everything else rides along as the prepared details. URLs
  // the new save no longer uses are revoked here (the editor reuses the old
  // ones it kept, so a blanket release would break them).
  const saveDetails = useCallback((id: string, result: BulkEditorResult) => {
    setEditingId(null);
    setItems((previous) => previous.map((item) => {
      if (item.id !== id) return item;
      if (item.details) {
        const kept = new Set([
          ...result.details.renders.map((render) => render.url),
          ...result.details.screenshots.map((shot) => shot.url),
        ]);
        for (const render of item.details.renders) {
          if (!kept.has(render.url)) URL.revokeObjectURL(render.url);
        }
        for (const shot of item.details.screenshots) {
          if (!kept.has(shot.url)) URL.revokeObjectURL(shot.url);
        }
      }
      return { ...item, name: result.name, author: result.author, details: result.details };
    }));
  }, []);

  const dismiss = useCallback(() => {
    if (running) return;
    setError(null);
    onClose();
  }, [running, onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      // With the details editor on top, Escape is its to handle.
      if (event.key === "Escape" && !editingId) dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, dismiss, editingId]);

  // A run lives in this tab; closing it mid-upload leaves half-published rows
  // behind (they expire as pending), so the browser asks first.
  useEffect(() => {
    if (!running) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [running]);

  useLayoutEffect(() => {
    if (open) setBodyLockActive(true);
  }, [open]);

  useBodyScrollLock(bodyLockActive);

  if (typeof document === "undefined") return null;

  const busy = running || reading > 0;
  const pendingCount = items.filter((item) => item.phase === "queued" || item.phase === "failed").length;
  const editingItem = editingId ? items.find((item) => item.id === editingId) ?? null : null;

  return createPortal(
    <AnimatePresence onExitComplete={() => setBodyLockActive(false)}>
      {open && (
        <motion.div
          key="skin-bulk-upload"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[120] flex items-center justify-center p-3 sm:p-6"
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={dismiss} aria-hidden="true" />
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
            role="dialog"
            aria-modal="true"
            aria-label="Bulk upload skins"
            className="relative flex max-h-full w-full max-w-[840px] flex-col overflow-hidden rounded-2xl border border-osu-b3/30 bg-osu-b3 shadow-2xl"
          >
            <div className="flex items-center gap-3 border-b border-osu-b3/40 px-5 py-3">
              <Layers className="h-4 w-4 text-osu-pink" aria-hidden="true" />
              <h2 className="text-[12px] font-bold uppercase tracking-[0.1em] text-osu-pink">Bulk upload</h2>
              <span className="text-[11px] text-osu-f1">admin only</span>
              <button
                type="button"
                onClick={dismiss}
                disabled={running}
                aria-label="Close"
                className="ml-auto rounded p-1 text-osu-f1 transition-colors cursor-pointer hover:text-white disabled:cursor-default disabled:opacity-40"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={running}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (!running) void addFiles(event.dataTransfer.files);
                }}
                className="flex w-full flex-col items-center gap-1.5 rounded-xl border border-dashed border-osu-b3/60 bg-osu-b4/40 py-6 transition-colors cursor-pointer hover:border-osu-pink/50 disabled:cursor-default"
              >
                <Upload className="h-6 w-6 text-osu-f1" aria-hidden="true" />
                <span className="text-[13px] font-semibold text-white">Drop .osk files here, or click to pick them</span>
                <span className="text-[11px] text-osu-f1">
                  {reading > 0 ? `Reading ${reading} file${reading === 1 ? "" : "s"}...` : "Names and keymodes come from each skin.ini. Up to 50 MB each."}
                </span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".osk,.zip,application/zip"
                multiple
                className="sr-only"
                onChange={(event) => void addFiles(event.target.files)}
              />

              {items.length > 0 && (
                <div className="mt-3 flex flex-col gap-1">
                  {items.map((item) => (
                    <BulkRow
                      key={item.id}
                      item={item}
                      running={running}
                      onRename={(name) => setItems((previous) => previous.map((current) => (
                        current.id === item.id ? { ...current, name } : current
                      )))}
                      onEdit={() => setEditingId(item.id)}
                      onRemove={() => removeItem(item.id)}
                      onNavigate={dismiss}
                    />
                  ))}
                </div>
              )}

              {error && <p className="mt-3 text-[12px] font-semibold text-osu-red-light">{error}</p>}
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t border-osu-b3/40 px-5 py-3">
              <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-osu-f1">
                <span className="tabular-nums">{items.length} file{items.length === 1 ? "" : "s"}</span>
                {counts.published > 0 && (
                  <span className="flex items-center gap-1 font-semibold text-osu-green tabular-nums">
                    <Check size={11} aria-hidden="true" />
                    {counts.published} published
                  </span>
                )}
                {counts.duplicate > 0 && <span className="font-semibold text-osu-yellow tabular-nums">{counts.duplicate} already here</span>}
                {counts.failed > 0 && <span className="font-semibold text-osu-red-light tabular-nums">{counts.failed} failed</span>}
              </div>
              <div className="ml-auto flex items-center gap-2.5">
                {(counts.published > 0 || counts.duplicate > 0) && !running && (
                  <button
                    type="button"
                    onClick={clearDone}
                    className="text-[12px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l1"
                  >
                    Clear finished
                  </button>
                )}
                {running ? (
                  <button
                    type="button"
                    onClick={() => { cancelRef.current = true; }}
                    className="rounded-full border border-osu-b3/60 px-4 py-2 text-[13px] font-bold text-osu-l2 transition-colors cursor-pointer hover:text-white"
                  >
                    Stop after this file
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void run()}
                    disabled={busy || pendingCount === 0}
                    className="rounded-full bg-osu-pink px-5 py-2 text-[13px] font-bold text-white transition cursor-pointer hover:brightness-110 disabled:cursor-default disabled:opacity-50"
                  >
                    Publish {pendingCount || ""} skin{pendingCount === 1 ? "" : "s"}
                  </button>
                )}
              </div>
            </div>
          </motion.div>
          {editingItem && (
            <SkinBulkDetailsEditor
              // A different row gets a fresh editor rather than inherited state.
              key={editingItem.id}
              file={editingItem.file}
              initialName={editingItem.name}
              initialAuthor={editingItem.author ?? ""}
              initialDetails={editingItem.details}
              onSave={(result) => saveDetails(editingItem.id, result)}
              onCancel={() => setEditingId(null)}
            />
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function BulkRow({
  item,
  running,
  onRename,
  onEdit,
  onRemove,
  onNavigate,
}: {
  item: BulkItem;
  running: boolean;
  onRename: (name: string) => void;
  onEdit: () => void;
  onRemove: () => void;
  onNavigate: () => void;
}) {
  const active = item.phase === "reading" || item.phase === "rendering" || item.phase === "uploading";
  const target = item.skin ?? item.duplicate;

  return (
    <div className="relative overflow-hidden rounded-lg border border-osu-b3/30 bg-osu-b4/60 px-2.5 py-2">
      {active && (
        <div
          className="absolute inset-y-0 left-0 bg-osu-pink/10 transition-[width] duration-200"
          style={{ width: `${Math.round(item.progress * 100)}%` }}
          aria-hidden="true"
        />
      )}
      <div className="relative flex items-center gap-2.5">
        <input
          type="text"
          value={item.name}
          maxLength={80}
          disabled={running || item.phase === "published"}
          onChange={(event) => onRename(event.target.value)}
          aria-label={`Name for ${item.file.name}`}
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-1 text-[12.5px] font-semibold text-osu-l1 transition-colors focus:border-osu-pink/50 focus:outline-none disabled:text-osu-f1"
        />
        {item.keymodes.length > 0 && (
          <span className="hidden shrink-0 text-[10.5px] tabular-nums text-osu-f1 sm:block">
            {item.keymodes.map((keys) => `${keys}K`).join(" ")}
          </span>
        )}
        <span className="hidden shrink-0 text-[10.5px] tabular-nums text-osu-f1 md:block">{formatSkinFileSize(item.file.size)}</span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${PHASE_STYLES[item.phase]}`}>
          {PHASE_LABELS[item.phase]}
        </span>
        {target ? (
          <Link
            to="/skins/$id"
            params={{ id: target.slug ?? target.id }}
            onClick={onNavigate}
            className="shrink-0 text-[11px] font-semibold text-osu-pink underline-offset-2 transition-colors hover:underline"
          >
            view
          </Link>
        ) : (
          <>
            <button
              type="button"
              onClick={onEdit}
              disabled={running}
              aria-label={`Edit details for ${item.file.name}`}
              title={item.details
                ? "Has custom details; click to change them"
                : "Edit this skin's details like a single upload"}
              className={`shrink-0 rounded p-1 transition-colors cursor-pointer hover:text-osu-l1 disabled:cursor-default disabled:opacity-30 ${
                item.details ? "text-osu-pink" : "text-osu-f1"
              }`}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onRemove}
              disabled={running}
              aria-label={`Remove ${item.file.name}`}
              className="shrink-0 rounded p-1 text-osu-f1 transition-colors cursor-pointer hover:text-osu-red-light disabled:cursor-default disabled:opacity-30"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </>
        )}
      </div>
      {item.message && (
        <p className={`relative mt-0.5 px-1.5 text-[11px] ${item.phase === "failed" ? "text-osu-red-light" : "text-osu-f1"}`}>
          {item.message}
        </p>
      )}
    </div>
  );
}
