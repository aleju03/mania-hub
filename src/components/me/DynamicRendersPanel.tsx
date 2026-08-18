import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";

import { PageHeader } from "../layout/PageHeader";
import { OsuLogo } from "../ui/OsuLogo";
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

   Deliberately unlabelled: chips, the picture, the controls that change it,
   the line you paste. The preview says what each option does better than any
   caption could.

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
function PageShell({ children, center = false }: { children: ReactNode; center?: boolean }) {
  return (
    <div className="min-h-screen">
      <PageHeader iconSrc="/images/icons/contests.svg" title="dynamic renders" />
      <div className="min-h-[80vh] bg-osu-b5">
        <div
          className={center
            ? "mx-auto flex min-h-[68vh] w-full max-w-[560px] flex-col items-center justify-center px-4 text-center"
            : "mx-auto w-full max-w-[940px] px-3 py-5 sm:px-5 sm:py-7"}
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
    <label className="flex min-w-[190px] flex-1 items-center gap-3">
      <span className="w-[52px] shrink-0 text-[11.5px] font-semibold text-osu-l3">{label}</span>
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

function Skeleton() {
  return (
    <PageShell>
      <div className="flex gap-2">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-9 w-28 animate-pulse rounded-lg bg-osu-b3/35" />)}
      </div>
      <div className="mt-3 flex gap-2">
        {[0, 1, 2].map((i) => <div key={i} className="h-8 w-20 animate-pulse rounded-lg bg-osu-b3/25" />)}
      </div>
      <div className="mt-5 h-[200px] w-full animate-pulse rounded-xl bg-osu-b3/25" />
      <div className="mt-5 h-11 w-full animate-pulse rounded-lg bg-osu-b3/25" />
    </PageShell>
  );
}

export function DynamicRendersPanel() {
  const auth = useAuth();
  const location = useLocation();
  const viewer = auth.viewer;
  const isAdmin = auth.canUseAdminFeatures;

  const [settings, setSettings] = useState<SignatureSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState<SignatureType>("maniacard");
  const [design, setDesign] = useState(1);
  const [copied, setCopied] = useState(false);
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
      if (first) setType(first);
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
     on screen twice meaning different things. */
  const selectType = useCallback((target: SignatureType) => {
    setType(target);
    setDesign(1);
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
    setDesign(1);
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

  if (loading) return <Skeleton />;

  /* Blocked. Said plainly rather than shown as a broken picture, and with no
     controls: nothing the player does here would bring the images back, so
     offering them buttons would only mislead.

     No actor named. One person runs this site, so "by a moderator" invents a
     review team that does not exist and makes an ordinary switch sound like a
     tribunal. What the player needs is that it is off and how to ask. */
  if (settings?.blockedAt) {
    return (
      <PageShell center>
        <div className="text-[17px] font-bold text-white">Your dynamic renders were turned off.</div>
        <div className="mt-2.5 text-[13.5px] leading-5 text-osu-f1">
          Any image you pasted has stopped loading. Get in touch if you think that is a mistake.
        </div>
      </PageShell>
    );
  }

  if (!isLive) {
    return (
      <PageShell center>
        <div className="text-[22px] font-bold leading-snug text-white">
          A picture for your osu! profile that keeps itself current.
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
    <PageShell>
      <div className="flex flex-wrap gap-2">
        {SIGNATURE_TYPES.map((entry) => (
          <Chip key={entry} active={type === entry} onClick={() => selectType(entry)}>
            {SIGNATURE_TYPE_LABELS[entry]}
          </Chip>
        ))}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {designs.map((entry) => (
          <Chip
            key={entry.design}
            small
            active={spec.design === entry.design}
            onClick={() => setDesign(entry.design)}
          >
            {entry.label}
          </Chip>
        ))}
        <span className="ml-1 text-[11.5px] tabular-nums text-osu-l3">{spec.width} x {spec.height}</span>
      </div>

      {/* Skills and dan are drawn per keymode. Without this the render just
          took the player's strongest, which is why a 4K main only ever saw 7K. */}
      {type === "skills" && keyModes.length > 1 ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {keyModes.map((keys) => (
            <Chip
              key={keys}
              small
              active={(style.keyCount ?? keyModes[0]) === keys}
              onClick={() => patchStyle({ keyCount: keys })}
            >
              {keys}K
            </Chip>
          ))}
        </div>
      ) : null}

      {/* The dan card carries two ladders, and they are routinely from
          different keymodes. One picker made showing 7K rice beside a 4K LN
          impossible, which is a normal thing to have and to want to show. */}
      {type === "dan" && keyModes.length > 1 ? (
        <div className="mt-2.5 flex flex-col gap-2">
          {([["Rice", "keyCount"], ["LN", "lnKeyCount"]] as const).map(([label, field]) => (
            <div key={field} className="flex flex-wrap items-center gap-2">
              <span className="w-[30px] shrink-0 text-[11.5px] font-semibold text-osu-l3">{label}</span>
              {keyModes.map((keys) => (
                <Chip
                  key={keys}
                  small
                  active={(style[field] ?? style.keyCount ?? keyModes[0]) === keys}
                  onClick={() => patchStyle(field === "keyCount" ? { keyCount: keys } : { lnKeyCount: keys })}
                >
                  {keys}K
                </Chip>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {/* The image is the point of the page, so it sits on the background at
          its own size rather than inside a box inside a box. The ratio is
          reserved up front so nothing shifts when it lands. */}
      <div className="mt-5 flex justify-center">
        <div
          className="relative w-full"
          style={{ maxWidth: `${spec.width}px`, aspectRatio: `${spec.width} / ${spec.height}` }}
        >
          {/* Only ever shown when there is nothing to show. The previous frame
              stays up while the next one renders: swapping it for a spinner is
              what made changing a setting feel like a page reload, and the old
              picture is a better answer for those 200ms than a grey box. */}
          {!imageUrl ? (
            <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-osu-b4/60">
              <span className="text-[12px] font-semibold text-osu-l3">
                {imageState === "error" ? "Could not draw this one." : "Drawing..."}
              </span>
            </div>
          ) : (
            <img src={imageUrl} alt="" className="block h-full w-full rounded-xl" />
          )}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
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
        {/* The colour a solid or gradient is built from, next to the chip it
            belongs to rather than in with the accent swatches - they are two
            different colours and putting them in one row implied one. */}
        {signatureBackground(style.background)?.painted ? (
          <ColorSwatch
            value={style.color}
            active
            title="Background colour"
            onChange={(value) => patchStyle({ color: value })}
          />
        ) : null}
      </div>

      {styleIsCustomImage(style) ? (
        <>
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
            className="mt-2.5 h-10 w-full rounded-lg border border-osu-b3/40 bg-osu-b4/70 px-3 text-[12px] text-osu-l2 outline-none focus:border-osu-pink/40"
          />
          {urlCheck && urlCheck !== "checking" && PROBE_MESSAGE[urlCheck] ? (
            <div className="mt-1.5 text-[12px] font-semibold text-osu-red-light">{PROBE_MESSAGE[urlCheck]}</div>
          ) : null}
        </>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex items-center gap-1.5">
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
        </div>

        {/* Each slider is absent rather than greyed out where it would do
            nothing: opacity and blur only describe a photo, and brightness has
            nothing to act on when the background is the layout's own. */}
        {styleUsesBrightness(style) ? (
          <Slider
            label="Bright"
            value={style.brightness}
            min={SIGNATURE_BRIGHTNESS_RANGE.min}
            max={SIGNATURE_BRIGHTNESS_RANGE.max}
            suffix="%"
            onChange={(value) => patchStyle({ brightness: value })}
          />
        ) : null}
        {styleUsesImage(style) ? (
          <>
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
          </>
        ) : null}
      </div>

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
        <TextAction
          disabled={busy}
          onClick={() => {
            if (!confirm("Make a new link? Every image you have already pasted will stop working.")) return;
            void act(() => rotateSignatureToken());
          }}
        >
          New link
        </TextAction>
        <TextAction disabled={busy} onClick={() => void act(() => disableSignature())}>Turn off</TextAction>
      </div>
    </PageShell>
  );
}
