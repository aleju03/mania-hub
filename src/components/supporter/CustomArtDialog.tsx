import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import { Loader2 } from "lucide-react";

import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";
import { CUSTOM_MOTIF_OPACITY_RANGE, CUSTOM_MOTIF_SCALE_RANGE, type SupporterLook } from "../../lib/supporter-card-looks";
import type { SupporterFoilId } from "../../lib/supporter-foils";
import type { SupporterCardSleeveId } from "../../lib/supporter-pack-style";
import { ManiaCard3DPanel as ManiaCardPanel } from "../player/maniacard3d/LazyManiaCard3DPanel";
import type { ManiaCardPanelProps } from "../player/maniacard3d/types";

/* The supporter's own picture, before it goes on the card: their real card
   with the image behind it, and its size and strength, shown as they move.
   Opens straight after an upload (with the upload still running) and from
   the image's tile to adjust it later. Saving is the only thing that puts it
   on the card. */

export interface CustomArtDraft {
  url: string | null;
  scale: number;
  opacity: number;
}

/* How long the sliders must rest before the card repaints: every change
   rebuilds the card's textures. */
const PREVIEW_SETTLE_MS = 140;

export function CustomArtDialog({ draft, uploading, error, foil, card, sleeve, onChange, onSave, onClose }: {
  draft: CustomArtDraft;
  uploading: boolean;
  error: string | null;
  foil: SupporterFoilId | "none";
  card: Pick<ManiaCardPanelProps, "user" | "scores" | "loading"> | null;
  sleeve: SupporterCardSleeveId | null;
  onChange: (draft: CustomArtDraft) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  useBodyScrollLock(true);
  const [preview, setPreview] = useState(draft);
  useEffect(() => {
    const timer = window.setTimeout(() => setPreview(draft), PREVIEW_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [draft]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const look: SupporterLook | null = preview.url ? { motif: "custom", foil, url: preview.url, scale: preview.scale, opacity: preview.opacity } : null;
  const slider = "w-full cursor-pointer accent-osu-pink disabled:cursor-default";

  return createPortal(
    <div
      className="fixed inset-0 z-[140] flex justify-center overflow-y-auto bg-black/75 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t`Your image`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="my-auto grid w-full max-w-[640px] gap-5 rounded-2xl border border-osu-b3/30 bg-osu-b5 p-4 sm:grid-cols-[260px_minmax(0,1fr)] sm:p-5">
        <div className="relative mx-auto w-full max-w-[260px]">
          {card && look ? (
            <ManiaCardPanel user={card.user} scores={card.scores} loading={card.loading} isOwnProfile supporterLookOverride={look} showTierProgress={false} sleeve={sleeve} />
          ) : (
            <div className="grid aspect-[5/7] w-full place-items-center rounded-[14px] bg-osu-b6 text-osu-f1">
              {uploading ? <Loader2 className="h-6 w-6 animate-spin text-osu-pink" /> : null}
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-col">
          <h2 className="text-[15px] font-bold text-white">{t`Your image`}</h2>
          <p className="mt-1 text-[12px] leading-5 text-osu-f1">
            {uploading ? t`Uploading...` : t`It sits behind everything printed on your card, on every copy of it.`}
          </p>
          <div className="mt-5 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-4 text-[12px] text-osu-l2">
            <label htmlFor="custom-art-size">{t`Size`}</label>
            <input
              id="custom-art-size"
              type="range"
              min={CUSTOM_MOTIF_SCALE_RANGE[0]}
              max={CUSTOM_MOTIF_SCALE_RANGE[1]}
              step={0.05}
              value={draft.scale}
              disabled={!draft.url}
              onChange={(event) => onChange({ ...draft, scale: Number(event.target.value) })}
              className={slider}
            />
            <label htmlFor="custom-art-strength">{t`Strength`}</label>
            <input
              id="custom-art-strength"
              type="range"
              min={CUSTOM_MOTIF_OPACITY_RANGE[0]}
              max={CUSTOM_MOTIF_OPACITY_RANGE[1]}
              step={0.05}
              value={draft.opacity}
              disabled={!draft.url}
              onChange={(event) => onChange({ ...draft, opacity: Number(event.target.value) })}
              className={slider}
            />
          </div>
          {error && <p className="mt-4 text-[12px] text-osu-red-light">{error}</p>}
          <div className="mt-auto flex justify-end gap-2 pt-6">
            <button type="button" onClick={onClose} className="cursor-pointer rounded-lg px-3.5 py-2 text-[12.5px] font-bold text-osu-l2 transition-colors hover:bg-osu-b3/40 hover:text-white">
              {t`Cancel`}
            </button>
            <button
              type="button"
              disabled={!draft.url}
              onClick={onSave}
              className="cursor-pointer rounded-lg bg-osu-pink px-4 py-2 text-[12.5px] font-bold text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-40"
            >
              {t`Put it on my card`}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
