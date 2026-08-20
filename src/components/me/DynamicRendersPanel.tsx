import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { useLocation } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";

import { ConfirmModal } from "../ui/ConfirmModal";
import { PageHeader } from "../layout/PageHeader";
import { OsuLogo } from "../ui/OsuLogo";
import { Switch } from "../ui/Switch";
import { useAuth } from "../../lib/auth-context";
import {
  checkSignatureImageUrl,
  disableSignature,
  enableSignature,
  fetchSignatureKeyModes,
  fetchSignatureSettings,
  rotateSignatureToken,
  type SignatureSettings,
} from "../../lib/signature";
import type { SignatureImageProbe } from "../../routes/api/signature/-backgrounds";
import {
  signatureBBCode,
  signatureDesigns,
  signatureImagePath,
  SIGNATURE_TYPES,
  SIGNATURE_TYPE_LABELS,
  type SignatureType,
} from "../../lib/signature-shared";
import {
  normalizeSignatureImageUrl,
  normalizeSignatureStyleMap,
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
  type SignatureStyle,
  type SignatureStyleMap,
} from "../../lib/signature-style";

/* Dynamic renders: auto-updating images a player embeds on their osu! profile.
   Admin-gated for now, so this page is the whole surface - the image route
   itself stays public, since the point is that anyone viewing a profile can
   load the picture.

   Every control sits on a labelled row. It was unlabelled first, on the theory
   that the preview says what each option does better than a caption could -
   which holds for a chip that names itself ("Falling notes") and fails for a
   bare colour circle, where the picture tells you something changed but not
   which of the two colours you were reaching for. The label is the part the
   preview cannot supply.

   The preview is drawn by /api/signature-preview, which renders straight from
   the style in the request and stores nothing. The signature URL itself cannot
   do that - its whole design is a fixed URL whose look lives on the player's
   row - so driving the preview from it meant a save, a version bump and a
   cache round trip between moving a slider and seeing it, with a blank frame
   in the middle. Saving still happens, debounced, behind the picture. */

/* Short enough to feel like the slider, long enough that a drag is a handful
   of renders rather than one per pixel. Each in-flight preview is aborted when
   the next one starts, so this bounds concurrency as well as count. */
const PREVIEW_DEBOUNCE_MS = 110;
/* The write is no longer in the way of anything being drawn, so it can wait
   for the gesture to end. Copy flushes it, so nobody can paste a link for a
   style that never landed. */
const STYLE_SAVE_DEBOUNCE_MS = 600;

/* `center` is for the states that are one sentence and a button. Left-aligned
   at the top of a 940px column, a single line of text reads as the corner of a
   page that failed to load the rest of itself. */
/* No skeleton while the settings load. The two things this page can resolve
   into look nothing alike - a one-line pitch or the whole editor - so any
   placeholder would be a guess at the wrong one, and for a player who has not
   set this up yet it would flash a mock editor they never get. An empty shell
   holds the header, and whatever arrives fades in. */
function PageShell({ children, center = false, enter = false }: { children?: ReactNode; center?: boolean; enter?: boolean }) {
  return (
    <div className="min-h-screen">
      <PageHeader iconSrc="/images/icons/contests.svg" title="dynamic renders" />
      <div className="min-h-[80vh] bg-osu-b5">
        <div
          className={`${center
            ? "mx-auto flex min-h-[68vh] w-full max-w-[560px] flex-col items-center justify-center px-4 text-center"
            : "mx-auto w-full max-w-[940px] px-3 py-5 sm:px-5 sm:py-7"}${enter ? " signature-enter" : ""}`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function Chip({
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
   the same place and the rows read as a list of properties rather than as a
   drift of chips; on a narrow screen the label sits above its controls
   instead of stealing a third of the width. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
      <span className="w-[92px] shrink-0 pt-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-osu-l3 sm:pt-0">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/* One ladder's keymode, as a short run of chips with an optional name in
   front. Named only where there are two of them - a lone "4K 7K" beside the
   layout tabs needs no label to be understood. */
function KeyModePicker({
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
      {label ? <span className="text-[11px] font-semibold text-osu-l3">{label}</span> : null}
      {keyModes.map((keys) => (
        <button
          key={keys}
          type="button"
          onClick={() => onChange(keys)}
          className={`cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] font-bold transition-colors ${
            value === keys ? "bg-osu-pink/15 text-osu-pink-light" : "text-osu-f1 hover:text-white"
          }`}
        >
          {keys}K
        </button>
      ))}
    </div>
  );
}

function TextAction({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-[12px] font-semibold text-osu-l3 transition-colors hover:text-white cursor-pointer disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: { label: string; value: number; min: number; max: number; suffix: string; onChange: (value: number) => void }) {
  return (
    <label className="flex min-w-[188px] flex-1 items-center gap-3">
      <span className="w-[72px] shrink-0 text-[11.5px] font-semibold text-osu-l3">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-osu-b3/50 accent-osu-pink"
      />
      <span className="w-[38px] shrink-0 text-right text-[11.5px] tabular-nums text-osu-l3">{value}{suffix}</span>
    </label>
  );
}

/* A real colour input rather than a palette of ours. The point of the control
   is that the colour is the player's, and any list we ship is a shorter list
   than the one their operating system already has. The presets beside it stay
   as shortcuts, not as the range. */
function ColorSwatch({
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
   these makes the render silently skip the background, which from the page
   looks the same as the setting doing nothing. */
const PROBE_MESSAGE: Record<SignatureImageProbe, string | null> = {
  ok: null,
  blocked: "That address cannot be loaded.",
  refused: "That site blocks our request. Hosts like imgur or catbox work.",
  unreachable: "That link did not load.",
  "not-an-image": "That link is a page, not an image file.",
  "too-large": "That image is too large to draw.",
};

export function DynamicRendersPanel() {
  const auth = useAuth();
  const location = useLocation();
  const viewer = auth.viewer;
  const isAdmin = auth.canUseAdminFeatures;

  const [settings, setSettings] = useState<SignatureSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState<SignatureType>("maniacard");
  const [design, setDesign] = useState(() => signatureDesigns(SIGNATURE_TYPES[0])[0]!.design);
  const [copied, setCopied] = useState(false);
  const [rotateAsk, setRotateAsk] = useState(false);
  // Local styles lead the stored ones so a drag stays responsive; the debounced
  // save is what makes them real and moves the render's version.
  const [styles, setStyles] = useState<SignatureStyleMap>(() => normalizeSignatureStyleMap(null));
  const [imageState, setImageState] = useState<"loading" | "ready" | "error">("loading");
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  // Which keymodes this player actually has ratings for, so the picker cannot
  // offer one that would silently fall back to another.
  const [keyModes, setKeyModes] = useState<number[]>([]);
  // Kept apart from the saved style so a half-typed url is not repeatedly
  // normalized away under the cursor.
  const [urlDraft, setUrlDraft] = useState("");
  const [urlCheck, setUrlCheck] = useState<SignatureImageProbe | "checking" | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const objectUrl = useRef<string | null>(null);
  /* The style a debounced save is holding. Kept in a ref so Copy can force it
     out ahead of schedule without re-deriving what was pending. */
  const pendingStyles = useRef<SignatureStyleMap | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchSignatureSettings();
      setSettings(result.signature);
      if (result.signature) setStyles(result.signature.styles);
      const first = result.signature?.enabledTypes?.[0];
      if (first) {
        setType(first);
        setDesign(signatureDesigns(first)[0]!.design);
      }
    } catch {
      setSettings(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    void load();
    void fetchSignatureKeyModes().then((result) => setKeyModes(result.keyCounts)).catch(() => setKeyModes([]));
  }, [isAdmin, load]);

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
  }, []);

  const enabledTypes = useMemo(() => settings?.enabledTypes ?? [], [settings]);
  const isLive = Boolean(settings?.enabled && settings.token);

  /* The write, on its own schedule. It no longer gates the picture, so nothing
     visible waits on it - what it protects is the link: a style that is only
     in this component is not what the pasted URL will draw. */
  const saveStyles = useCallback(async () => {
    const next = pendingStyles.current;
    if (!next) return;
    pendingStyles.current = null;
    const result = await enableSignature({
      data: {
        types: enabledTypes.length > 0 ? enabledTypes : [type],
        skillsKeyCount: settings?.skillsKeyCount ?? null,
        styles: next,
      },
    }).catch(() => null);
    if (result?.signature) setSettings(result.signature);
  }, [enabledTypes, settings?.skillsKeyCount, type]);

  const flushStyles = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    await saveStyles();
  }, [saveStyles]);

  const act = useCallback(async (run: () => Promise<{ signature: SignatureSettings | null }>) => {
    setBusy(true);
    try {
      /* Any of these replaces the local styles with the server's copy, so a
         debounced edit still in flight has to land first or switching type
         moments after moving a slider would quietly undo it. */
      await flushStyles();
      const result = await run();
      if (result.signature) {
        setSettings(result.signature);
        setStyles(result.signature.styles);
      } else {
        await load();
      }
    } finally {
      setBusy(false);
    }
  }, [flushStyles, load]);

  /* Selecting a type is what publishes it. One action, not two: splitting
     "which types are on" from "which am I looking at" put the same four chips
     on screen twice meaning different things.

     It lands on the type's FIRST declared layout rather than on design 1: the
     ids are frozen because they are in URLs people already pasted, so the
     first tab and the lowest id are not the same thing. */
  const selectType = useCallback((target: SignatureType) => {
    setType(target);
    setDesign(signatureDesigns(target)[0]!.design);
    if (!enabledTypes.includes(target)) {
      void act(() => enableSignature({
        data: { types: [...enabledTypes, target], skillsKeyCount: settings?.skillsKeyCount ?? null },
      }));
    }
  }, [act, enabledTypes, settings?.skillsKeyCount]);

  const unpublish = useCallback((target: SignatureType) => {
    const next = enabledTypes.filter((entry) => entry !== target);
    if (next.length === 0) return;
    void act(() => enableSignature({ data: { types: next, skillsKeyCount: settings?.skillsKeyCount ?? null } }));
    setType(next[0]!);
    setDesign(signatureDesigns(next[0]!)[0]!.design);
  }, [act, enabledTypes, settings?.skillsKeyCount]);

  const patchStyle = useCallback((patch: Partial<SignatureStyle>) => {
    // Computed out here rather than inside the setStyles updater: an updater
    // has to stay pure, and scheduling the save from within one would queue it
    // twice under StrictMode's double invocation.
    const next: SignatureStyleMap = { ...styles, [type]: { ...styles[type], ...patch } };
    setStyles(next);
    pendingStyles.current = next;

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void saveStyles(); }, STYLE_SAVE_DEBOUNCE_MS);
  }, [saveStyles, styles, type]);

  const designs = useMemo(() => signatureDesigns(type), [type]);
  const spec = designs.find((entry) => entry.design === design) ?? designs[0]!;
  const style = styles[type];
  const path = settings?.token ? signatureImagePath(settings.token, type, spec.design) : "";

  // Follow the stored url when the selected type changes, not on every render:
  // rebinding this while someone is mid-word would fight the cursor.
  useEffect(() => {
    setUrlDraft(styles[type].imageUrl ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, settings?.token]);

  /* Asked separately from the render, because the render's answer to a picture
     it could not fetch is to draw without one - which is correct on someone
     else's profile and indistinguishable from a broken setting here. */
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
    }, STYLE_SAVE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [checkedUrl]);

  /* Holding the last frame is right while a style is being tuned - it is the
     same picture, one setting older. It is wrong the moment the layout
     changes: that frame is a different picture at a different shape, and the
     box it is now sitting in has the new layout's ratio, so it gets stretched
     into a smear of the render you just left. Dropping it here costs the few
     hundred milliseconds of "Drawing..." that a tab switch was always going
     to cost, in a box that is already the right size, so nothing jumps. */
  useEffect(() => {
    setImageUrl(null);
    setImageState("loading");
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
  }, [type, spec.design]);

  /* Exactly what the render depends on. Serialized rather than passed as
     objects so a re-render with an equal style is not a new request, and
     reused verbatim as the request body - one description, no chance of the
     picture being drawn from something other than what this keyed on. */
  const previewBody = useMemo(() => JSON.stringify({
    type,
    design: spec.design,
    style,
    skillsKeyCount: settings?.skillsKeyCount ?? null,
  }), [design, settings?.skillsKeyCount, spec.design, style, type]);

  useEffect(() => {
    if (!isLive) return;
    const controller = new AbortController();

    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/signature-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: previewBody,
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(String(response.status));
        const next = URL.createObjectURL(await response.blob());

        /* Decoded before it is shown. Handing an <img> a fresh src swaps the
           element to the new picture and paints whatever is decoded so far,
           which at this size is one blank frame - the flash. Decoding first
           makes the swap a single frame with a whole image in it. */
        const image = new Image();
        image.src = next;
        await image.decode().catch(() => undefined);
        if (controller.signal.aborted) {
          URL.revokeObjectURL(next);
          return;
        }

        const previous = objectUrl.current;
        objectUrl.current = next;
        setImageUrl(next);
        setImageState("ready");
        if (previous) URL.revokeObjectURL(previous);
      } catch {
        // A failed render leaves the last good frame up. Only the very first
        // one has nothing to fall back to.
        if (!controller.signal.aborted) {
          setImageState((state) => (state === "ready" ? "ready" : "error"));
        }
      }
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [isLive, previewBody]);

  const absoluteUrl = useMemo(() => {
    if (!path) return "";
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    return `${origin}${path}`;
  }, [path]);
  const bbcode = absoluteUrl ? signatureBBCode(absoluteUrl) : "";

  /* Copy is the moment the link stops being a preview and starts being
     something pasted somewhere permanent, so it is the one place worth waiting
     on: the debounced save is forced out first. Without it, copying inside the
     debounce window hands over a URL that draws the previous style, and the
     player has no way to know. Clipboard first, since browsers only allow the
     write inside the gesture it came from. */
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(bbcode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard unavailable (insecure context): the field is selectable.
    }
    await flushStyles();
  }, [bbcode, flushStyles]);

  if (!viewer) {
    const loginHref = `/api/auth/osu?next=${encodeURIComponent(`${location.pathname}${location.searchStr}`)}`;
    return (
      <PageShell center>
        <div className="text-[17px] font-bold text-white">Log in with osu! to set one up.</div>
        <a
          href={loginHref}
          className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl border border-osu-pink/45 bg-osu-pink/15 px-5 text-[13px] font-bold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white"
        >
          <OsuLogo className="h-4 w-4" />
          Log in with osu!
        </a>
      </PageShell>
    );
  }

  if (!isAdmin) {
    return (
      <PageShell center>
        <div className="text-[17px] font-bold text-white">Not open yet.</div>
      </PageShell>
    );
  }

  if (loading) return <PageShell />;

  /* Blocked. Said plainly rather than shown as a broken picture, and with no
     controls: nothing the player does here would bring the images back, so
     offering them buttons would only mislead.

     No actor named. One person runs this site, so "by a moderator" invents a
     review team that does not exist and makes an ordinary switch sound like a
     tribunal. What the player needs is that it is off and how to ask. */
  if (settings?.blockedAt) {
    return (
      <PageShell center enter>
        <div className="text-[17px] font-bold text-white">Your dynamic renders were turned off.</div>
        <div className="mt-2.5 text-[13.5px] leading-5 text-osu-f1">
          Any image you pasted has stopped loading. Get in touch if you think that is a mistake.
        </div>
      </PageShell>
    );
  }

  if (!isLive) {
    return (
      <PageShell center enter>
        <div className="text-[22px] font-bold leading-snug text-white">
          A customizable picture for your osu! profile that keeps itself updated.
        </div>
        <div className="mt-2.5 text-[13.5px] leading-5 text-osu-f1">
          Paste it once. It redraws when your stats change.
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(() => enableSignature({ data: { types: ["maniacard"], skillsKeyCount: null } }))}
          className="mt-5 inline-flex h-11 items-center rounded-xl border border-osu-pink/45 bg-osu-pink/15 px-5 text-[13px] font-bold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white cursor-pointer disabled:opacity-50"
        >
          {busy ? "Setting up..." : "Get my link"}
        </button>
      </PageShell>
    );
  }

  return (
    <PageShell enter>
      {/* Which render, as tabs. Five names on one rule, with the indicator
          sliding between them - a row of pills reads as five buttons you could
          press at once, and this is one choice. */}
      <div className="-mx-1 overflow-x-auto border-b border-osu-b3/25 scrollbar-hide">
        <div className="flex min-w-max px-1">
          {SIGNATURE_TYPES.map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => selectType(entry)}
              className={`relative shrink-0 cursor-pointer whitespace-nowrap px-3.5 py-2.5 text-[12.5px] font-semibold transition-colors duration-[120ms] ${
                type === entry ? "text-white" : "text-osu-f1 hover:text-osu-l2"
              }`}
            >
              {SIGNATURE_TYPE_LABELS[entry]}
              {type === entry ? (
                <motion.span
                  layoutId="signature-type-indicator"
                  className="absolute inset-x-2.5 bottom-0 h-[2px] rounded-full bg-osu-h1"
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                />
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {/* The layout is a property of the picture, not a setting beside it, so
          its tabs sit on the frame the picture is in and the active one is the
          same surface continued upward. Everything that describes the picture
          rather than changes it - the keymode it is drawn for, the size it
          comes out at - rides the other end of that same line, which is what
          the Layout and Keymode rows used to cost. */}
      <div className="mt-4">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div className="flex items-end">
            {designs.map((entry) => (
              <button
                key={entry.design}
                type="button"
                onClick={() => setDesign(entry.design)}
                className={`cursor-pointer rounded-t-lg px-3 py-1.5 text-[12px] transition-colors duration-[120ms] ${
                  spec.design === entry.design
                    ? "bg-osu-b4/45 font-bold text-white"
                    : "font-semibold text-osu-f1 hover:text-osu-l2"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pb-1.5">
            {/* Skills and dan are drawn per keymode. Without this the render
                just took the player's strongest, which is why a 4K main only
                ever saw 7K. Dan carries two, because a player's rice and LN
                ladders are routinely in different keymodes. */}
            {type === "skills" && keyModes.length > 1 ? (
              <KeyModePicker
                keyModes={keyModes}
                value={style.keyCount ?? keyModes[0]!}
                onChange={(keys) => patchStyle({ keyCount: keys })}
              />
            ) : null}
            {type === "dan" && keyModes.length > 1 ? (
              <>
                <KeyModePicker
                  label="Rice"
                  keyModes={keyModes}
                  value={style.keyCount ?? keyModes[0]!}
                  onChange={(keys) => patchStyle({ keyCount: keys })}
                />
                <KeyModePicker
                  label="LN"
                  keyModes={keyModes}
                  value={style.lnKeyCount ?? style.keyCount ?? keyModes[0]!}
                  onChange={(keys) => patchStyle({ lnKeyCount: keys })}
                />
              </>
            ) : null}
            <span className="text-[11.5px] tabular-nums text-osu-l3">{spec.width} x {spec.height}</span>
          </div>
        </div>

        {/* A surface under the picture, not a box around it: an osu! profile
            puts these on a dark panel, and the render draws no background of
            its own unless one was picked, so previewing it on bare page is
            previewing it somewhere it will never be. The ratio is reserved up
            front so nothing shifts when the frame lands. */}
        <div
          className={`flex justify-center rounded-xl bg-osu-b4/45 p-3 ${
            spec.design === designs[0]!.design ? "rounded-tl-none" : ""
          }`}
        >
          <div
            className="relative w-full"
            style={{ maxWidth: `${spec.width}px`, aspectRatio: `${spec.width} / ${spec.height}` }}
          >
            {/* Only ever shown when there is nothing to show. The previous frame
                stays up while the next one renders: swapping it for a spinner is
                what made changing a setting feel like a page reload, and the old
                picture is a better answer for those 200ms than a grey box. */}
            {!imageUrl ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-[12px] font-semibold text-osu-l3">
                  {imageState === "error" ? "Could not draw this one." : "Drawing..."}
                </span>
              </div>
            ) : (
              <img src={imageUrl} alt="" className="block h-full w-full rounded-lg object-contain" />
            )}
          </div>
        </div>
      </div>

      {/* A layout that draws a finished piece of art edge to edge has nothing
          for these to act on, so it gets none of them. Greying them out would
          say the same thing at more length. */}
      {spec.ownArt ? null : (
      <div className="mt-5 space-y-3">
        <Field label="Background">
          {signatureBackgroundsFor(type).map((entry) => (
            <Chip
              key={entry.id}
              small
              active={style.background === entry.id}
              onClick={() => patchStyle({ background: entry.id })}
            >
              <span
                className="h-3 w-3 shrink-0 rounded-full border border-white/15"
                style={{ background: entry.painted ? style.color : entry.swatch }}
              />
              {entry.label}
            </Chip>
          ))}
        </Field>

        {/* Everything that describes the background lives under it, in the
            order you reach for it: what colour, then how bright. The colour
            used to be a bare circle at the end of the chip row, which is the
            control nobody could name - a swatch says a colour changed, not
            which of the two the render has. */}
        {signatureBackground(style.background)?.painted ? (
          <Field label="Background colour">
            <ColorSwatch
              value={style.color}
              active
              title="Background colour"
              onChange={(value) => patchStyle({ color: value })}
            />
            <span className="mr-1 text-[11.5px] tabular-nums text-osu-l3">{style.color}</span>
            {styleUsesBrightness(style) ? (
              <Slider
                label="Brightness"
                value={style.brightness}
                min={SIGNATURE_BRIGHTNESS_RANGE.min}
                max={SIGNATURE_BRIGHTNESS_RANGE.max}
                suffix="%"
                onChange={(value) => patchStyle({ brightness: value })}
              />
            ) : null}
          </Field>
        ) : null}

        {styleIsCustomImage(style) ? (
          <Field label="Image URL">
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
                  // Only commit something that parses, or a deliberate clear, so a
                  // half-typed address does not save over the working one.
                  const normalized = normalizeSignatureImageUrl(next);
                  if (normalized || next.trim() === "") patchStyle({ imageUrl: normalized });
                }}
                className="h-10 w-full rounded-lg border border-osu-b3/40 bg-osu-b4/70 px-3 text-[12px] text-osu-l2 outline-none focus:border-osu-pink/40"
              />
              {urlCheck && urlCheck !== "checking" && PROBE_MESSAGE[urlCheck] ? (
                <div className="mt-1.5 text-[12px] font-semibold text-osu-red-light">{PROBE_MESSAGE[urlCheck]}</div>
              ) : null}
            </div>
          </Field>
        ) : null}

        {/* Each slider is absent rather than greyed out where it would do
            nothing: opacity and blur only describe a photo, and brightness has
            nothing to act on when the background is the layout's own. */}
        {styleUsesImage(style) ? (
          <Field label="Image">
            <Slider
              label="Brightness"
              value={style.brightness}
              min={SIGNATURE_BRIGHTNESS_RANGE.min}
              max={SIGNATURE_BRIGHTNESS_RANGE.max}
              suffix="%"
              onChange={(value) => patchStyle({ brightness: value })}
            />
            <Slider
              label="Opacity"
              value={style.opacity}
              min={SIGNATURE_OPACITY_RANGE.min}
              max={SIGNATURE_OPACITY_RANGE.max}
              suffix="%"
              onChange={(value) => patchStyle({ opacity: value })}
            />
            <Slider
              label="Blur"
              value={style.blur}
              min={SIGNATURE_BLUR_RANGE.min}
              max={SIGNATURE_BLUR_RANGE.max}
              suffix="px"
              onChange={(value) => patchStyle({ blur: value })}
            />
          </Field>
        ) : null}

        {/* Its own row, and named for what it colours rather than left as a
            second unlabelled strip of circles beside the background's one. */}
        <Field label="Accent colour">
          <button
            type="button"
            title="Auto"
            onClick={() => patchStyle({ accent: SIGNATURE_ACCENT_AUTO })}
            className={`h-6 w-6 shrink-0 rounded-full border-2 transition-colors cursor-pointer ${
              style.accent === SIGNATURE_ACCENT_AUTO ? "border-white" : "border-transparent hover:border-white/35"
            }`}
            style={{ background: "conic-gradient(#ff66aa,#ffc24d,#5fd66a,#3fd4d0,#4da3ff,#a97bff,#ff66aa)" }}
          />
          {SIGNATURE_ACCENTS.map((entry) => entry.hex ? (
            <button
              key={entry.id}
              type="button"
              title={entry.label}
              onClick={() => patchStyle({ accent: entry.hex! })}
              className={`h-6 w-6 shrink-0 rounded-full border-2 transition-colors cursor-pointer ${
                style.accent === entry.hex ? "border-white" : "border-transparent hover:border-white/35"
              }`}
              style={{ background: entry.hex }}
            />
          ) : null)}
          <ColorSwatch
            value={style.accent === SIGNATURE_ACCENT_AUTO ? "#ff66aa" : style.accent}
            active={style.accent !== SIGNATURE_ACCENT_AUTO && !SIGNATURE_ACCENTS.some((entry) => entry.hex === style.accent)}
            title="Pick a colour"
            onChange={(value) => patchStyle({ accent: value })}
          />
          {/* The first swatch is a rainbow, which looks like a colour rather
              than like "let the render choose". One word settles it. */}
          <span className="ml-1 text-[11.5px] text-osu-l3">
            {style.accent === SIGNATURE_ACCENT_AUTO ? "Auto" : style.accent}
          </span>
        </Field>

        {/* On by default, and a switch: it is one boolean, so a pair of chips
            was a picker doing a switch's job. Same control the settings page
            uses for every other on/off on the site. */}
        <Field label="Watermark">
          <Switch
            checked={style.watermark}
            onChange={(watermark) => patchStyle({ watermark })}
            label="Show the site name on the render"
          />
        </Field>
      </div>
      )}

      <div className="mt-6 flex gap-2">
        <input
          readOnly
          value={bbcode}
          onFocus={(event) => event.currentTarget.select()}
          className="h-11 min-w-0 flex-1 rounded-lg border border-osu-b3/40 bg-osu-b4/70 px-3 text-[12px] text-osu-l2 outline-none focus:border-osu-pink/40"
        />
        <button
          type="button"
          onClick={copy}
          className="inline-flex h-11 shrink-0 items-center gap-2 rounded-lg border border-osu-pink/50 bg-osu-pink/15 px-4 text-[12.5px] font-bold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white cursor-pointer"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="text-[12px] text-osu-l3">Anyone with the link can see it.</span>
        {enabledTypes.length > 1 ? (
          <TextAction disabled={busy} onClick={() => unpublish(type)}>Stop sharing this one</TextAction>
        ) : null}
        <TextAction disabled={busy} onClick={() => setRotateAsk(true)}>New link</TextAction>
        <TextAction disabled={busy} onClick={() => void act(() => disableSignature())}>Turn off</TextAction>
      </div>

      {rotateAsk ? (
        <ConfirmModal
          title="Make a new link?"
          body="Every image you have already pasted will stop working."
          confirmLabel="Make a new link"
          danger
          onConfirm={() => void act(() => rotateSignatureToken())}
          onClose={() => setRotateAsk(false)}
        />
      ) : null}
    </PageShell>
  );
}
