import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

import { ConfirmModal } from "../../ui/ConfirmModal";
import { Switch } from "../../ui/Switch";
import { checkSignatureImageUrl } from "../../../lib/signature";
import type { SignatureImageProbe } from "../../../routes/api/signature/-backgrounds";
import type { SignatureDesign, SignatureType } from "../../../lib/signature-shared";
import {
  normalizeSignatureImageUrl,
  signatureBackground,
  signatureBackgroundsFor,
  styleIsCustomImage,
  styleUsesBrightness,
  styleUsesImage,
  SIGNATURE_ACCENTS,
  SIGNATURE_ACCENT_AUTO,
  SIGNATURE_BLUR_RANGE,
  SIGNATURE_BRIGHTNESS_RANGE,
  SIGNATURE_IMAGE_URL_MAX,
  SIGNATURE_OPACITY_RANGE,
} from "../../../lib/signature-style";
import type { SignaturePreviewState } from "./use-signature-preview";
import type { DynamicRenders } from "./use-dynamic-renders";

const URL_CHECK_DEBOUNCE_MS = 600;

export function Chip({
  active,
  onClick,
  small = false,
  children,
}: { active: boolean; onClick: () => void; small?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-lg border font-bold transition-colors cursor-pointer ${
        small ? "h-8 px-3 text-[12px]" : "h-9 px-3.5 text-[12.5px]"
      } ${
        active
          ? "border-osu-pink/50 bg-osu-pink/15 text-osu-pink-light"
          : "border-osu-b3/40 bg-osu-b4/70 text-osu-l2 hover:bg-osu-b3/40 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

/* One labelled row of controls. The gutter is fixed so every label starts at
   the same place; `stacked` puts the label above, for a narrow column. */
export function Field({ label, stacked = false, children }: { label: string; stacked?: boolean; children: ReactNode }) {
  return (
    <div className={`flex flex-col gap-1.5 ${stacked ? "" : "sm:flex-row sm:items-center sm:gap-3"}`}>
      <span className={`shrink-0 text-[11px] font-bold uppercase tracking-[0.12em] text-osu-f1 ${stacked ? "" : "w-[92px] pt-0.5 sm:pt-0"}`}>
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/* One ladder's keymode, as a short run of chips with an optional name in
   front. Named only where there are two of them. */
export function KeyModePicker({
  keyModes,
  value,
  onChange,
  label,
}: {
  keyModes: number[];
  value: number;
  onChange: (keyCount: number) => void;
  label?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {label ? <span className="text-[11px] font-semibold text-osu-f1">{label}</span> : null}
      {keyModes.map((keys) => (
        <button
          key={keys}
          type="button"
          onClick={() => onChange(keys)}
          className={`cursor-pointer rounded-md px-1.5 py-0.5 text-[11.5px] font-bold transition-colors ${
            value === keys ? "bg-osu-pink/15 text-osu-pink-light" : "text-osu-f1 hover:text-white"
          }`}
        >
          {keys}K
        </button>
      ))}
    </div>
  );
}

/* Skills and dan are drawn per keymode. Dan carries two, because a player's
   rice and LN ladders are routinely in different keymodes. */
export function KeyModeControls({ renders, type }: { renders: DynamicRenders; type: SignatureType }) {
  const { t } = useLingui();
  const { keyModes, styles, patchStyle } = renders;
  const style = styles[type];
  if (keyModes.length < 2) return null;
  if (type === "skills") {
    return (
      <KeyModePicker
        keyModes={keyModes}
        value={style.keyCount ?? keyModes[0]!}
        onChange={(keys) => patchStyle(type, { keyCount: keys })}
      />
    );
  }
  if (type === "dan") {
    return (
      <>
        <KeyModePicker
          label={t`Regular`}
          keyModes={keyModes}
          value={style.keyCount ?? keyModes[0]!}
          onChange={(keys) => patchStyle(type, { keyCount: keys })}
        />
        <KeyModePicker
          label={t`LN`}
          keyModes={keyModes}
          value={style.lnKeyCount ?? style.keyCount ?? keyModes[0]!}
          onChange={(keys) => patchStyle(type, { lnKeyCount: keys })}
        />
      </>
    );
  }
  return null;
}

export function TextAction({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-[12px] font-semibold text-osu-f1 transition-colors hover:text-white cursor-pointer disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: { label: string; value: number; min: number; max: number; suffix: string; onChange: (value: number) => void }) {
  return (
    <label className="flex min-w-[188px] flex-1 items-center gap-3">
      <span className="w-[72px] shrink-0 text-[11.5px] font-semibold text-osu-f1">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-osu-b3/50 accent-osu-pink"
      />
      <span className="w-[38px] shrink-0 text-right text-[11.5px] tabular-nums text-osu-f1">{value}{suffix}</span>
    </label>
  );
}

/* A real colour input rather than a palette of ours: the colour is the
   player's. The presets beside it stay as shortcuts, not as the range. */
export function ColorSwatch({
  value,
  active,
  title,
  onChange,
}: { value: string; active: boolean; title: string; onChange: (value: string) => void }) {
  return (
    <input
      type="color"
      title={title}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      className={`h-6 w-6 shrink-0 cursor-pointer appearance-none rounded-full border-2 bg-transparent p-0 transition-colors [&::-moz-color-swatch]:rounded-full [&::-moz-color-swatch]:border-none [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0 ${
        active ? "border-white" : "border-transparent hover:border-white/35"
      }`}
    />
  );
}

/* Said out loud rather than left as a picture that never appears. Every one of
   these makes the render silently skip the background. */
const PROBE_MESSAGE: Record<SignatureImageProbe, MessageDescriptor | null> = {
  ok: null,
  blocked: msg`That address cannot be loaded.`,
  refused: msg`That site blocks our request. Hosts like imgur or catbox work.`,
  unreachable: msg`That link did not load.`,
  "not-an-image": msg`That link is a page, not an image file.`,
  "too-large": msg`That image is too large to draw.`,
};

/* The picture in a box whose ratio is reserved up front, so nothing shifts
   when the frame lands. The previous frame stays up while the next renders. */
export function PreviewImage({
  spec,
  imageUrl,
  state,
  className = "",
}: { spec: SignatureDesign; imageUrl: string | null; state: SignaturePreviewState; className?: string }) {
  const { t } = useLingui();
  return (
    <div
      className={`relative w-full ${className}`}
      style={{ maxWidth: `${spec.width}px`, aspectRatio: `${spec.width} / ${spec.height}` }}
    >
      {!imageUrl ? (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-white/[0.03]">
          <span className="text-[12px] font-semibold text-osu-f1">
            {state === "error" ? t`Could not draw this one.` : t`Drawing...`}
          </span>
        </div>
      ) : (
        <img src={imageUrl} alt="" className="block h-full w-full rounded-lg object-contain" />
      )}
    </div>
  );
}

/* Everything that changes how a render looks. A layout that draws a finished
   piece of art edge to edge has nothing for these to act on, so callers skip
   it for `ownArt` designs. Each slider is absent rather than greyed out where
   it would do nothing. */
export function StyleControls({
  renders,
  type,
  stacked = false,
}: { renders: DynamicRenders; type: SignatureType; stacked?: boolean }) {
  const { t, i18n } = useLingui();
  const { styles, patchStyle } = renders;
  const style = styles[type];
  const patch = (value: Parameters<typeof patchStyle>[1]) => patchStyle(type, value);

  // Kept apart from the saved style so a half-typed url is not repeatedly
  // normalized away under the cursor. Follows the stored url per type only.
  const [urlDraft, setUrlDraft] = useState(style.imageUrl ?? "");
  const [urlCheck, setUrlCheck] = useState<SignatureImageProbe | "checking" | null>(null);
  useEffect(() => {
    setUrlDraft(styles[type].imageUrl ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  /* Asked separately from the render, because the render's answer to a picture
     it could not fetch is to draw without one - indistinguishable from a
     broken setting here. */
  const checkedUrl = styleIsCustomImage(style) ? style.imageUrl : null;
  useEffect(() => {
    if (!checkedUrl) {
      setUrlCheck(null);
      return;
    }
    let cancelled = false;
    setUrlCheck("checking");
    const timer = setTimeout(() => {
      void checkSignatureImageUrl({ data: { url: checkedUrl } })
        .then((result) => { if (!cancelled) setUrlCheck(result.status); })
        .catch(() => { if (!cancelled) setUrlCheck(null); });
    }, URL_CHECK_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [checkedUrl]);

  return (
    <div className="space-y-3.5">
      <Field label={t`Background`} stacked={stacked}>
        {signatureBackgroundsFor(type).map((entry) => (
          <Chip
            key={entry.id}
            small
            active={style.background === entry.id}
            onClick={() => patch({ background: entry.id })}
          >
            <span
              className="h-3 w-3 shrink-0 rounded-full border border-white/15"
              style={{ background: entry.painted ? style.color : entry.swatch }}
            />
            {i18n._(entry.label)}
          </Chip>
        ))}
      </Field>

      {signatureBackground(style.background)?.painted ? (
        <Field label={t`Background colour`} stacked={stacked}>
          <ColorSwatch value={style.color} active title={t`Background colour`} onChange={(value) => patch({ color: value })} />
          <span className="mr-1 text-[11.5px] tabular-nums text-osu-f1">{style.color}</span>
          {styleUsesBrightness(style) ? (
            <Slider
              label={t`Brightness`}
              value={style.brightness}
              min={SIGNATURE_BRIGHTNESS_RANGE.min}
              max={SIGNATURE_BRIGHTNESS_RANGE.max}
              suffix="%"
              onChange={(value) => patch({ brightness: value })}
            />
          ) : null}
        </Field>
      ) : null}

      {styleIsCustomImage(style) ? (
        <Field label={t`Image URL`} stacked={stacked}>
          <div className="w-full">
            <input
              type="url"
              inputMode="url"
              spellCheck={false}
              maxLength={SIGNATURE_IMAGE_URL_MAX}
              placeholder="https://..."
              value={urlDraft}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setUrlDraft(next);
                // Only commit something that parses, or a deliberate clear.
                const normalized = normalizeSignatureImageUrl(next);
                if (normalized || next.trim() === "") patch({ imageUrl: normalized });
              }}
              className="h-10 w-full rounded-lg border border-osu-b3/40 bg-osu-b4/70 px-3 text-[12px] text-osu-l2 outline-none focus:border-osu-pink/40"
            />
            {urlCheck && urlCheck !== "checking" && PROBE_MESSAGE[urlCheck] ? (
              <div className="mt-1.5 text-[12px] font-semibold text-osu-red-light">{i18n._(PROBE_MESSAGE[urlCheck]!)}</div>
            ) : null}
          </div>
        </Field>
      ) : null}

      {styleUsesImage(style) ? (
        <Field label={t`Image`} stacked={stacked}>
          <div className={`flex w-full flex-wrap gap-x-5 gap-y-2.5 ${stacked ? "flex-col" : ""}`}>
            <Slider
              label={t`Brightness`}
              value={style.brightness}
              min={SIGNATURE_BRIGHTNESS_RANGE.min}
              max={SIGNATURE_BRIGHTNESS_RANGE.max}
              suffix="%"
              onChange={(value) => patch({ brightness: value })}
            />
            <Slider
              label={t`Opacity`}
              value={style.opacity}
              min={SIGNATURE_OPACITY_RANGE.min}
              max={SIGNATURE_OPACITY_RANGE.max}
              suffix="%"
              onChange={(value) => patch({ opacity: value })}
            />
            <Slider
              label={t`Blur`}
              value={style.blur}
              min={SIGNATURE_BLUR_RANGE.min}
              max={SIGNATURE_BLUR_RANGE.max}
              suffix="px"
              onChange={(value) => patch({ blur: value })}
            />
          </div>
        </Field>
      ) : null}

      <Field label={t`Accent colour`} stacked={stacked}>
        <button
          type="button"
          title={t`Auto`}
          onClick={() => patch({ accent: SIGNATURE_ACCENT_AUTO })}
          className={`h-6 w-6 shrink-0 rounded-full border-2 transition-colors cursor-pointer ${
            style.accent === SIGNATURE_ACCENT_AUTO ? "border-white" : "border-transparent hover:border-white/35"
          }`}
          style={{ background: "conic-gradient(#ff66aa,#ffc24d,#5fd66a,#3fd4d0,#4da3ff,#a97bff,#ff66aa)" }}
        />
        {SIGNATURE_ACCENTS.map((entry) => entry.hex ? (
          <button
            key={entry.id}
            type="button"
            title={i18n._(entry.label)}
            onClick={() => patch({ accent: entry.hex! })}
            className={`h-6 w-6 shrink-0 rounded-full border-2 transition-colors cursor-pointer ${
              style.accent === entry.hex ? "border-white" : "border-transparent hover:border-white/35"
            }`}
            style={{ background: entry.hex }}
          />
        ) : null)}
        <ColorSwatch
          value={style.accent === SIGNATURE_ACCENT_AUTO ? "#ff66aa" : style.accent}
          active={style.accent !== SIGNATURE_ACCENT_AUTO && !SIGNATURE_ACCENTS.some((entry) => entry.hex === style.accent)}
          title={t`Pick a colour`}
          onChange={(value) => patch({ accent: value })}
        />
        <span className="ml-1 text-[11.5px] text-osu-f1">
          {style.accent === SIGNATURE_ACCENT_AUTO ? t`Auto` : style.accent}
        </span>
      </Field>

      <Field label={t`Watermark`} stacked={stacked}>
        <Switch
          checked={style.watermark}
          onChange={(watermark) => patch({ watermark })}
          label={t`Show the site name on the render`}
        />
      </Field>
    </div>
  );
}

/** The one primary action. Flat fill, brightens on hover. */
export function CopyButton({
  renders,
  text,
  types,
  label,
  className = "",
}: { renders: DynamicRenders; text: string; types: SignatureType[]; label?: string; className?: string }) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      disabled={!text}
      onClick={() => void renders.copy(text, types).then((ok) => { if (ok) setCopied(true); })}
      className={`inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-osu-pink px-5 text-[13px] font-bold text-white transition-[filter] hover:brightness-110 cursor-pointer disabled:opacity-50 ${className}`}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {copied ? t`Copied` : (label ?? t`Copy URL`)}
    </button>
  );
}

/* The link's housekeeping, quiet under the main action. "Stop sharing" is the
   only thing on the page that breaks an image already pasted for one type, so
   it is never a side effect of anything else. */
export function LinkActions({ renders, type }: { renders: DynamicRenders; type?: SignatureType }) {
  const { t } = useLingui();
  const [rotateAsk, setRotateAsk] = useState(false);
  const { busy, enabledTypes } = renders;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="text-[12px] text-osu-f1">{t`Anyone with the link can see it.`}</span>
        {type && enabledTypes.includes(type) && enabledTypes.length > 1 ? (
          <TextAction disabled={busy} onClick={() => renders.unpublish(type)}>{t`Stop sharing this one`}</TextAction>
        ) : null}
        <TextAction disabled={busy} onClick={() => setRotateAsk(true)}>{t`New link`}</TextAction>
        <TextAction disabled={busy} onClick={() => void renders.disable()}>{t`Turn off`}</TextAction>
      </div>
      {rotateAsk ? (
        <ConfirmModal
          title={t`Make a new link?`}
          body={t`Every image you have already pasted will stop working.`}
          confirmLabel={t`Make a new link`}
          danger
          onConfirm={() => void renders.rotate()}
          onClose={() => setRotateAsk(false)}
        />
      ) : null}
    </>
  );
}
