import { useEffect, useRef, useState } from "react";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";

import { forgetLiveSupporterLook } from "../../lib/live-backend";
import {
  CUSTOM_MOTIF_OPACITY_RANGE,
  CUSTOM_MOTIF_SCALE_RANGE,
  SUPPORTER_MOTIFS,
  SUPPORTER_PALETTES,
  type SupporterLook,
  type SupporterMotifId,
  type SupporterPalette,
} from "../../lib/supporter-card-looks";
import { SUPPORTER_MOTIF_SVGS } from "../../lib/supporter-motif-art";
import { fetchSupporterLookState, saveSupporterLookSetting, type SupporterLookState } from "../../lib/supporter-look-settings";

/* Under the viewer's own card on their profile: the motif and colours every
   copy of their card wears while they are a supporter. A preset or their own
   uploaded image; picking previews it on the card above at once and saves it.
   Nothing shows for anyone who is not a supporter right now. */

const MOTIF_LABELS: Record<SupporterMotifId, MessageDescriptor> = {
  stars: msg`Stars`,
  notes: msg`Notes`,
  stellium: msg`Stellium`,
  petals: msg`Petals`,
  feathers: msg`Feathers`,
  hearts: msg`Hearts`,
};

const PALETTE_LABELS: Record<SupporterPalette, MessageDescriptor> = {
  gold: msg`Gold`,
  prismatic: msg`Prismatic`,
  aurora: msg`Aurora`,
  ember: msg`Ember`,
};

const PALETTE_SWATCHES: Record<SupporterPalette, string> = {
  gold: "linear-gradient(135deg, #fff1b8, #e2b34a 55%, #9c6f22)",
  prismatic: "conic-gradient(from 210deg, #f0abfc, #c4b5fd, #67e8f9, #a7f3d0, #fde68a, #f0abfc)",
  aurora: "linear-gradient(135deg, #5eead4, #818cf8 60%, #312e81)",
  ember: "linear-gradient(135deg, #fed7aa, #fb923c 55%, #9a3412)",
};

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const SAVE_DELAY_MS = 450;

function motifSrc(id: SupporterMotifId): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SUPPORTER_MOTIF_SVGS[id])}`;
}

const chip = (active: boolean) =>
  `flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold transition-colors disabled:cursor-default ${active ? "bg-osu-b3 text-white ring-1 ring-osu-pink" : "bg-osu-b4 text-osu-l2 hover:bg-osu-b3"}`;

export function SupporterLookPicker({ userId, onPreview }: {
  userId: number;
  /** The look the card above should draw; undefined hands it back to the saved one. */
  onPreview: (look: SupporterLook | undefined) => void;
}) {
  const { t, i18n } = useLingui();
  const [state, setState] = useState<SupporterLookState | null>(null);
  const [look, setLook] = useState<SupporterLook | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedLook = useRef<SupporterLook | null>(null);

  useEffect(() => {
    let alive = true;
    fetchSupporterLookState()
      .then((next) => {
        if (!alive) return;
        setState(next);
        setLook(next.look);
        savedLook.current = next.look;
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      onPreview(undefined);
    };
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!state?.supporter || !look) return null;

  const save = async (next: SupporterLook) => {
    setError(null);
    setBusy(true);
    try {
      const saved = await saveSupporterLookSetting({ data: next });
      setState(saved);
      savedLook.current = saved.look;
      forgetLiveSupporterLook(userId);
    } catch (cause) {
      setLook(savedLook.current);
      onPreview(savedLook.current ?? undefined);
      setError(cause instanceof Error ? cause.message : t`Could not save that.`);
    } finally {
      setBusy(false);
    }
  };

  const pick = (next: SupporterLook) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setLook(next);
    onPreview(next);
    void save(next);
  };

  // Sliders preview every step and save once they stop moving.
  const adjust = (next: SupporterLook) => {
    setLook(next);
    onPreview(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(next), SAVE_DELAY_MS);
  };

  const upload = async (file: File) => {
    setError(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(t`That image is over 5 MB.`);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/supporter-motif", { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
      const body = await response.json().catch(() => null) as { url?: unknown; error?: unknown } | null;
      if (!response.ok || typeof body?.url !== "string") throw new Error(typeof body?.error === "string" ? body.error : t`Could not upload that image.`);
      const scale = look.motif === "custom" ? look.scale ?? 1 : state.custom?.scale ?? 1;
      const opacity = look.motif === "custom" ? look.opacity ?? 0.85 : state.custom?.opacity ?? 0.85;
      setBusy(false);
      pick({ motif: "custom", palette: look.palette, url: body.url, scale, opacity });
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : t`Could not upload that image.`);
    }
  };

  const until = state.expiresAt ? new Date(state.expiresAt).toLocaleDateString(i18n.locale, { month: "short", day: "numeric", year: "numeric" }) : null;
  const customUrl = look.motif === "custom" ? look.url : state.custom?.url;

  return (
    <div className="mx-auto mt-5 max-w-[560px] border-t border-white/[0.07] pt-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-semibold text-osu-c2">{t`Card look`}</span>
        {until && <span className="text-[11px] text-osu-f1">{t`Supporter until ${until}`}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        {SUPPORTER_MOTIFS.map((motif) => {
          const active = look.motif === motif.id;
          return (
            <button
              key={motif.id}
              type="button"
              disabled={busy}
              onClick={() => !active && pick({ motif: motif.id, palette: look.palette })}
              aria-pressed={active}
              className={chip(active)}
            >
              <img src={motifSrc(motif.id)} alt="" className="h-5 w-5" />
              {i18n._(MOTIF_LABELS[motif.id])}
            </button>
          );
        })}
        {customUrl && (
          <button
            type="button"
            disabled={busy}
            onClick={() => look.motif !== "custom" && state.custom && pick({ motif: "custom", palette: look.palette, ...state.custom })}
            aria-pressed={look.motif === "custom"}
            className={chip(look.motif === "custom")}
          >
            <img src={customUrl} alt="" className="h-5 w-5 rounded-sm object-contain" />
            {t`Your image`}
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} className={chip(false)}>
          {customUrl ? t`Upload another` : t`Upload image`}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void upload(file);
          }}
        />
      </div>
      {look.motif === "custom" && (
        <div className="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-[11px] text-osu-f1">
          <label htmlFor="supporter-motif-size">{t`Size`}</label>
          <input
            id="supporter-motif-size"
            type="range"
            min={CUSTOM_MOTIF_SCALE_RANGE[0]}
            max={CUSTOM_MOTIF_SCALE_RANGE[1]}
            step={0.05}
            value={look.scale ?? 1}
            onChange={(event) => adjust({ ...look, scale: Number(event.target.value) })}
            className="accent-osu-pink"
          />
          <label htmlFor="supporter-motif-strength">{t`Strength`}</label>
          <input
            id="supporter-motif-strength"
            type="range"
            min={CUSTOM_MOTIF_OPACITY_RANGE[0]}
            max={CUSTOM_MOTIF_OPACITY_RANGE[1]}
            step={0.05}
            value={look.opacity ?? 0.85}
            onChange={(event) => adjust({ ...look, opacity: Number(event.target.value) })}
            className="accent-osu-pink"
          />
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => look.palette !== null && pick({ ...look, palette: null })}
          aria-pressed={look.palette === null}
          className={chip(look.palette === null)}
        >
          {t`Tier colours`}
        </button>
        {SUPPORTER_PALETTES.map((palette) => {
          const active = look.palette === palette;
          return (
            <button
              key={palette}
              type="button"
              disabled={busy}
              onClick={() => !active && pick({ ...look, palette })}
              aria-pressed={active}
              aria-label={i18n._(PALETTE_LABELS[palette])}
              title={i18n._(PALETTE_LABELS[palette])}
              className={`h-7 w-7 cursor-pointer rounded-full transition hover:brightness-110 ${active ? "ring-2 ring-osu-pink ring-offset-2 ring-offset-osu-b5" : ""}`}
              style={{ background: PALETTE_SWATCHES[palette] }}
            />
          );
        })}
      </div>
      {error && <div className="mt-2 text-[12px] text-osu-red-light">{error}</div>}
    </div>
  );
}
