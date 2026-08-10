import { AnimatePresence, motion } from "framer-motion";
import { ImageIcon, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../../lib/auth-context";
import {
  deleteMySkin,
  formatSkinFileSize,
  keymodeLabel,
  markSkinsListStale,
  moderateSkin,
  setMySkinVisibility,
  setSkinSpecialKeymodes,
  SKIN_DESCRIPTION_MAX_LENGTH,
  SKIN_NAME_MAX_LENGTH,
  updateSkinDetails,
  type SkinSummary,
  type SkinVisibility,
} from "../../lib/skins";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";

// Every owner-side control on one surface: name and description, keymode labels, visibility,
// the file/preview edit entry points, and delete. The skin page used to line
// these up as six standalone buttons, which read as clutter; the sidebar now
// carries a single "Skin settings" button and this modal does the rest.
// The file and preview flows stay their own modals (they are multi-step
// uploads); their rows here just hand off via onUpdateFile/onEditPreviews.

export function SkinSettingsModal({
  skin,
  open,
  onClose,
  onSaved,
  onDeleted,
  onUpdateFile,
  onEditPreviews,
}: {
  skin: SkinSummary;
  open: boolean;
  onClose: () => void;
  onSaved: (skin: SkinSummary) => void;
  onDeleted: () => void;
  onUpdateFile: () => void;
  onEditPreviews: () => void;
}) {
  const auth = useAuth();
  const isOwner = auth.viewer?.id === skin.ownerUserId;
  // A keymode moderator (neither owner nor admin) reaches this modal only to
  // fix mislabelled keymodes, so every other row stays off their screen. The
  // server fns enforce the same boundary; this is just the honest UI for it.
  const keymodesOnly = !isOwner && !auth.isAdmin;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(skin.name);
  const [descriptionDraft, setDescriptionDraft] = useState(skin.description ?? "");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [bodyLockActive, setBodyLockActive] = useState(false);

  // Each open is a fresh session over the skin as it now stands.
  useEffect(() => {
    if (!open) return;
    setNameDraft(skin.name);
    setDescriptionDraft(skin.description ?? "");
    setError(null);
    setConfirmingDelete(false);
    // skin.name and skin.description are deliberately not deps: an edit saved
    // from this very modal must not clobber a draft the user kept typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleDismiss = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, handleDismiss]);

  // The scrollbar-compensated body lock the other skin modals use, so opening
  // this one never reflows the page underneath. Ref-counted, because this modal
  // hands off to the preview editor and the file updater in one tick.
  useLayoutEffect(() => {
    if (open) setBodyLockActive(true);
  }, [open]);

  useBodyScrollLock(bodyLockActive);

  // One shared runner: every row action disables the whole modal while its
  // server fn is out, surfaces one error line, and hands the updated skin up.
  const run = useCallback(async (action: () => Promise<{ ok: boolean; skin?: SkinSummary }>, failMessage: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await action().catch(() => ({ ok: false as const, skin: undefined }));
    setBusy(false);
    if (!result.ok || !result.skin) {
      setError(failMessage);
      return;
    }
    // The browse grid caches its cards; every field on this modal shows there.
    markSkinsListStale();
    onSaved(result.skin);
  }, [busy, onSaved]);

  const submitDetails = () => {
    const name = nameDraft.trim();
    if (!name || !detailsDirty) return;
    void run(
      () => updateSkinDetails({ data: { id: skin.id, name, description: descriptionDraft } }),
      "Saving the name and description failed. Try again.",
    );
  };

  const toggleSpecialKeymode = (keys: number) => {
    const current = skin.specialKeymodes ?? [];
    const next = current.includes(keys)
      ? current.filter((entry) => entry !== keys)
      : [...current, keys].sort((a, b) => a - b);
    void run(
      () => setSkinSpecialKeymodes({ data: { id: skin.id, specialKeymodes: next } }),
      "Changing the keymode label failed. Try again.",
    );
  };

  const setVisibility = (visibility: SkinVisibility) => {
    if (visibility === skin.visibility) return;
    void run(
      () => setMySkinVisibility({ data: { id: skin.id, visibility } }),
      "Changing who can see this skin failed. Try again.",
    );
  };

  const removeSkin = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = isOwner && !auth.isAdmin
      ? await deleteMySkin({ data: { id: skin.id } })
      : await moderateSkin({ data: { id: skin.id, action: "delete" } }).catch(() => ({ ok: false }));
    setBusy(false);
    if (result.ok) {
      markSkinsListStale();
      onDeleted();
    } else {
      setError("The delete failed. Try again.");
      setConfirmingDelete(false);
    }
  };

  const relabelable = skin.keymodes.filter((keys) => keys >= 2);
  const detailsDirty = nameDraft.trim().length > 0
    && (nameDraft.trim() !== skin.name || descriptionDraft.trim() !== (skin.description ?? ""));

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence onExitComplete={() => setBodyLockActive(false)}>
      {open && (
        <motion.div
          key="skin-settings"
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
            aria-label={`Settings for ${skin.name}`}
            className="modal-card-mobile-safe relative isolate z-10 flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[440px] flex-col overflow-hidden rounded-2xl bg-osu-b5 ring-1 ring-white/10 shadow-2xl sm:max-h-[calc(100dvh-3rem)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-osu-b3/30 px-4 py-3 sm:px-5">
              <span className="min-w-0 truncate text-[10px] font-extrabold uppercase tracking-[0.18em] text-osu-pink-light">
                {keymodesOnly ? "keymode moderation" : auth.isAdmin && !isOwner ? "moderation" : "skin settings"}
              </span>
              <button
                type="button"
                onClick={handleDismiss}
                aria-label="Close"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-osu-f1 transition-colors cursor-pointer hover:bg-osu-b3/50 hover:text-white"
              >
                <X className="h-4 w-4" strokeWidth={2.4} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-5">
              {!keymodesOnly && (
                <SettingsRow label="Name and description">
                  <form
                    className="flex flex-col gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitDetails();
                    }}
                  >
                    <input
                      type="text"
                      value={nameDraft}
                      maxLength={SKIN_NAME_MAX_LENGTH}
                      disabled={busy}
                      onChange={(event) => setNameDraft(event.target.value)}
                      aria-label="Skin name"
                      className="min-w-0 rounded-lg border border-osu-b3/30 bg-osu-b4 px-3 py-2 text-[13px] text-osu-l1 transition-colors focus:border-osu-pink/50 focus:outline-none"
                    />
                    <textarea
                      value={descriptionDraft}
                      maxLength={SKIN_DESCRIPTION_MAX_LENGTH}
                      rows={3}
                      disabled={busy}
                      onChange={(event) => setDescriptionDraft(event.target.value)}
                      aria-label="Skin description"
                      placeholder="A line about the skin"
                      className="min-w-0 resize-y rounded-lg border border-osu-b3/30 bg-osu-b4 px-3 py-2 text-[13px] leading-relaxed text-osu-l1 transition-colors placeholder:text-osu-f1/45 focus:border-osu-pink/50 focus:outline-none"
                    />
                    {detailsDirty && (
                      <button
                        type="submit"
                        disabled={busy}
                        className="self-start rounded-full bg-osu-pink px-4 py-1.5 text-[12px] font-bold text-white transition cursor-pointer hover:brightness-110 disabled:opacity-50"
                      >
                        Save
                      </button>
                    )}
                  </form>
                  <p className="mt-1.5 text-[11px] text-osu-f1/70">The link and the .osk filename stay as published.</p>
                </SettingsRow>
              )}

              {relabelable.length > 0 && (
                <SettingsRow label="Keymodes">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {relabelable.map((keys) => {
                      const special = skin.specialKeymodes?.includes(keys) ?? false;
                      return (
                        <button
                          key={keys}
                          type="button"
                          onClick={() => toggleSpecialKeymode(keys)}
                          disabled={busy}
                          aria-pressed={special}
                          title={special ? `Label as a plain ${keys}K layout` : `Label as ${keys - 1}K+1`}
                          className={`rounded-full px-3 py-1.5 text-[12px] font-bold tabular-nums transition-colors cursor-pointer disabled:opacity-50 ${
                            special
                              ? "bg-osu-pink/25 text-osu-pink-light hover:bg-osu-pink/35"
                              : "border border-osu-b3/50 text-osu-l2 hover:border-osu-pink/45 hover:text-white"
                          }`}
                        >
                          {keymodeLabel(keys, skin.specialKeymodes)}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1.5 text-[11px] text-osu-f1/70">
                    Tap a keymode to toggle its label.
                  </p>
                </SettingsRow>
              )}

              {!keymodesOnly && (
                <>
                  <SettingsRow label="Visibility">
                    <div className="inline-flex items-center gap-1 rounded-lg bg-osu-b4/70 p-1">
                      {(["public", "private"] as const).map((option) => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => setVisibility(option)}
                          disabled={busy}
                          aria-pressed={skin.visibility === option}
                          title={option === "public"
                            ? "On /skins for anyone to download"
                            : "Off /skins; only you see this page. Your replays keep playing in it"}
                          className={`rounded-md px-4 py-1.5 text-[12px] font-bold transition-colors cursor-pointer disabled:opacity-50 ${
                            skin.visibility === option ? "bg-osu-pink/25 text-osu-pink-light" : "text-osu-f1 hover:text-osu-l2"
                          }`}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  </SettingsRow>

                  <SettingsRow label="File and previews">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={onUpdateFile}
                        disabled={busy}
                        title="Replace the .osk with a newer build of this skin"
                        className="inline-flex items-center gap-1.5 rounded-full border border-osu-b3/50 px-3 py-1.5 text-[12px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:border-osu-pink/45 hover:text-white disabled:opacity-50"
                      >
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        Update file
                        {skin.oskSizeBytes ? (
                          <span className="font-medium text-osu-f1 tabular-nums">{formatSkinFileSize(skin.oskSizeBytes)}</span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        onClick={onEditPreviews}
                        disabled={busy}
                        title="Re-render the playfield previews or change the card cover"
                        className="inline-flex items-center gap-1.5 rounded-full border border-osu-b3/50 px-3 py-1.5 text-[12px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:border-osu-pink/45 hover:text-white disabled:opacity-50"
                      >
                        <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
                        Edit previews
                      </button>
                    </div>
                  </SettingsRow>

                  <SettingsRow label="Danger">
                    {confirmingDelete ? (
                      <span className="flex flex-wrap items-center gap-2 text-[12px]">
                        <span className="text-osu-f1">Delete for good?</span>
                        <button
                          type="button"
                          onClick={() => void removeSkin()}
                          disabled={busy}
                          className="inline-flex items-center gap-1.5 rounded-full bg-osu-red/25 px-3 py-1.5 font-bold text-osu-red-light transition-colors cursor-pointer hover:bg-osu-red/40 disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingDelete(false)}
                          disabled={busy}
                          className="font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l1"
                        >
                          Keep it
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmingDelete(true)}
                        disabled={busy}
                        className="inline-flex items-center gap-1.5 rounded-full border border-osu-red/35 px-3 py-1.5 text-[12px] font-semibold text-osu-red-light transition-colors cursor-pointer hover:bg-osu-red/20 disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Delete skin
                      </button>
                    )}
                  </SettingsRow>
                </>
              )}

              {error && <p className="pb-3 text-[12px] font-semibold text-osu-red-light">{error}</p>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function SettingsRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-osu-b3/25 py-3.5 last:border-b-0">
      <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">{label}</div>
      {children}
    </div>
  );
}
