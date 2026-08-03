import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";

import { ReplaySkinSettingsModal } from "../replay/ReplaySkinSettingsModal";
import {
  dehydrateReplaySkinSettings,
  loadOwnerReplaySkin,
  setMyReplaySkin,
} from "../../lib/replay-owner-skin";
import type { LoadedOwnerReplaySkin, OwnerReplaySkinRecord } from "../../lib/replay-owner-skin";
import {
  normalizeReplayOverlaySettings,
  readReplayOverlaySettings,
  writeReplayOverlaySettings,
} from "../../lib/replay-overlays";
import type { ReplayOverlaySettings } from "../../lib/replay-overlays";
import type { ReplaySkinSettings } from "../../lib/replay-skin";

type SaveState = "idle" | "saving" | "error";

// Customizing "my replay skin" from settings: downloads the skin's .osk,
// rehydrates the stored settings against it and hands both to the full
// ReplaySkinSettingsModal, with the archive attached so its Assets tab can
// swap individual images. Applying pushes the dehydrated settings back to the
// backend; overlays stay viewer-local exactly like everywhere else.
export function OwnerReplaySkinCustomizeModal({
  record,
  onSaved,
  onClose,
}: {
  record: OwnerReplaySkinRecord;
  onSaved: (record: OwnerReplaySkinRecord) => void;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<LoadedOwnerReplaySkin | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  // The settings modal closes itself synchronously right after onSave fires,
  // so its onClose has to ask "is a save in flight?" through a ref rather
  // than the state that has not committed yet.
  const saveStateRef = useRef<SaveState>("idle");
  const [editorOpen, setEditorOpen] = useState(true);
  // Only mounts client-side (behind a click), so reading localStorage in the
  // initializer is safe here.
  const [overlaySettings] = useState<ReplayOverlaySettings>(readReplayOverlaySettings);

  useEffect(() => {
    let cancelled = false;
    void loadOwnerReplaySkin(record).then((result) => {
      if (cancelled) return;
      if (result) setLoaded(result);
      else setLoadFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [record]);

  const updateSaveState = (state: SaveState) => {
    saveStateRef.current = state;
    setSaveState(state);
  };

  const handleSave = (next: ReplaySkinSettings) => {
    updateSaveState("saving");
    void (async () => {
      try {
        const payload = dehydrateReplaySkinSettings(next);
        const result = await setMyReplaySkin({
          data: { skinId: record.skin.id, settingsJson: JSON.stringify(payload) },
        });
        if (!result.ok) {
          updateSaveState("error");
          return;
        }
        onSaved({ skin: record.skin, settings: payload, updatedAt: new Date().toISOString() });
        onClose();
      } catch {
        updateSaveState("error");
      }
    })();
  };

  const handleSaveOverlays = (next: ReplayOverlaySettings) => {
    writeReplayOverlaySettings(normalizeReplayOverlaySettings(next));
  };

  // Apply: the editor goes away but this wrapper stays up until the server
  // write resolves, so the status dialog below can report how it went.
  // Cancel/Escape with no save pending closes everything.
  const handleEditorClose = () => {
    if (saveStateRef.current !== "idle") {
      setEditorOpen(false);
      return;
    }
    onClose();
  };

  if (loaded && editorOpen && saveState === "idle") {
    return (
      <ReplaySkinSettingsModal
        settings={loaded.settings}
        overlaySettings={overlaySettings}
        keyCount={record.skin.keymodes[0] ?? 4}
        onSave={handleSave}
        onSaveOverlays={handleSaveOverlays}
        onClose={handleEditorClose}
        assetArchive={loaded.archive}
        assetSourceName={record.skin.name}
        saveScope="owner"
      />
    );
  }

  if (typeof document === "undefined") return null;

  const status = loadFailed
    ? { message: "The skin could not be loaded. Try again in a moment.", error: true, closable: true }
    : saveState === "error"
      ? { message: "Saving your replay skin failed. Open the editor and apply again.", error: true, closable: true }
      : saveState === "saving"
        ? { message: "Saving your replay skin…", error: false, closable: false }
        : { message: "Loading the skin…", error: false, closable: true };

  return createPortal(
    <>
      <motion.div
        className="fixed inset-0 z-[130] bg-black/55 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.1 }}
        onClick={status.closable ? onClose : undefined}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        initial={{ opacity: 0, y: -12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.98 }}
        transition={{ duration: 0.14 }}
        className="fixed left-1/2 top-1/2 z-[131] w-[min(380px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-osu-b2/70 bg-osu-b4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-osu-b3/50 px-5 py-3 text-sm font-bold text-white">Customize replay skin</div>
        <div className="flex items-center gap-2.5 px-5 py-4">
          {!status.error ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-osu-pink-light" /> : null}
          <p className={`text-[12px] leading-relaxed ${status.error ? "text-osu-red-light" : "text-osu-f1"}`}>
            {status.message}
          </p>
        </div>
        {status.closable ? (
          <div className="flex items-center justify-end gap-2 border-t border-osu-b3/50 px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-lg bg-osu-b3/50 px-4 py-2 text-xs font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
            >
              Close
            </button>
          </div>
        ) : null}
      </motion.div>
    </>,
    document.body,
  );
}
