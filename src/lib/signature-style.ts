// Dynamic renders: the look of a signature, as opposed to signature-shared.ts,
// which says which layouts exist.
//
// The whole style is stored per player on the backend rather than carried in
// the image URL. That is not decoration - it is what keeps the feature's two
// invariants intact:
//
//  - The URL a player pastes into an osu! profile never changes, so style
//    cannot ride in a query string without breaking the one promise the
//    feature makes.
//  - Cache-key cardinality stays at (opted-in players x types x layouts). A
//    style that came from the request would let one URL mint unbounded stored
//    renders; a style that comes from the player's own row cannot. This is
//    also why colours can be free-form hex rather than an allowlist: a player
//    with 16 million colours still has one stored render per layout.
//
// A style change moves that type's data version instead, which supersedes the
// stored render exactly the way a new score does.

import { SIGNATURE_TYPES, type SignatureType } from "./signature-shared";

export type SignatureBackgroundArt = "triangles" | "notes";

export interface SignatureBackgroundOption {
  id: string;
  label: string;
  /** Needs a picture fetched and processed, rather than a painted fill. */
  image?: boolean;
  /** Takes its address from the player instead of from their osu! data. */
  custom?: boolean;
  /** Painted from `style.color`, so the picker edits the colour in place. */
  painted?: boolean;
  /** Site artwork drawn over the painted base. */
  art?: SignatureBackgroundArt;
  /** The layout's own art, which only the maniacard has. */
  tier?: boolean;
  /** Where this is worth offering. Absent means every type. */
  types?: SignatureType[];
  /** Swatch for the picker. Painted entries have none: they show their colour. */
  swatch?: string;
}

/* Three image sources: the two osu! assets already on the profile payload the
   renderer reads, and any https image the player names.

   That third one is a server-side fetch of an address someone else chose,
   which is the textbook SSRF shape. It is safe here only because it goes
   through lib/safe-image-fetch.ts, which resolves once, refuses every private
   and reserved range on both v4 and v6, pins the socket to the validated
   address so DNS cannot rebind under it, and re-checks each redirect hop. Any
   new caller must use that path rather than fetch(). */
export const SIGNATURE_BACKGROUNDS: SignatureBackgroundOption[] = [
  { id: "none", label: "None", swatch: "#1a1320" },
  /* The maniacard's tier art - the gold wash a Legendary card carries in the
     app. It is an option rather than the thing every card gets whether or not
     a background was chosen, because a look nobody picked and nobody can turn
     off is not a style, it is a constraint. */
  { id: "tier", label: "Card tier", tier: true, types: ["maniacard"], swatch: "linear-gradient(135deg,#4a2f10,#c8952f)" },
  { id: "solid", label: "Solid", painted: true },
  { id: "gradient", label: "Gradient", painted: true },
  /* The site's own two backdrops, in the player's colour. Both are drawn
     rather than fetched, so they cost no network and cannot fail. */
  { id: "triangles", label: "Triangles", painted: true, art: "triangles" },
  { id: "notes", label: "Falling notes", painted: true, art: "notes" },
  { id: "cover", label: "Profile banner", image: true, swatch: "linear-gradient(135deg,#4a3357,#8a6b9e)" },
  { id: "map", label: "Top play", image: true, swatch: "linear-gradient(135deg,#2d4a57,#6b9e8a)" },
  { id: "custom", label: "Image URL", image: true, custom: true, swatch: "linear-gradient(135deg,#57492d,#9e8a6b)" },
];

export type SignatureBackgroundId = string;

export function signatureBackground(id: string): SignatureBackgroundOption | null {
  return SIGNATURE_BACKGROUNDS.find((entry) => entry.id === id) ?? null;
}

/** The picker's options for one type. Only the maniacard has tier art, and an
    option that draws nothing is worse than an option that is not there. */
export function signatureBackgroundsFor(type: SignatureType): SignatureBackgroundOption[] {
  return SIGNATURE_BACKGROUNDS.filter((entry) => !entry.types || entry.types.includes(type));
}

/* The maniacard opens on its tier art, everything else on a flat surface. Per
   type rather than one constant because "the layout's own look" means
   different things: the maniacard has art to fall back to and the goals list
   does not. */
export function defaultSignatureBackground(type?: SignatureType): SignatureBackgroundId {
  return type === "maniacard" ? "tier" : "none";
}

export interface SignatureAccentOption {
  id: string;
  label: string;
  /** null means "let the render decide", which differs per type. */
  hex: string | null;
}

/* Shortcuts, not the range. A colour is stored as its own hex, so the palette
   is whatever the player's colour picker offers; these are the handful worth
   one click. Their ids are still accepted on the way in, so a style stored
   when this WAS the whole allowlist keeps the colour it was set to. */
export const SIGNATURE_ACCENTS: SignatureAccentOption[] = [
  { id: "auto", label: "Auto", hex: null },
  { id: "pink", label: "Pink", hex: "#ff66aa" },
  { id: "violet", label: "Violet", hex: "#a97bff" },
  { id: "blue", label: "Blue", hex: "#4da3ff" },
  { id: "cyan", label: "Cyan", hex: "#3fd4d0" },
  { id: "green", label: "Green", hex: "#5fd66a" },
  { id: "gold", label: "Gold", hex: "#ffc24d" },
  { id: "red", label: "Red", hex: "#ff5f5f" },
];

export const SIGNATURE_ACCENT_AUTO = "auto";

/** Lower-cased `#rrggbb`, expanding the short form, or null. Free-form colour
    is safe to store precisely because the style never rides in the URL: the
    render key is the player's row, so a million colours are still one stored
    image per layout. */
export function normalizeHexColor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/.exec(value);
  if (short) return `#${[...short[1]!].map((char) => char + char).join("")}`;
  return /^#[0-9a-f]{6}$/.test(value) ? value : null;
}

/** `auto`, a preset id from when accents were an allowlist, or any hex. */
export function normalizeSignatureAccent(raw: unknown): string {
  if (typeof raw !== "string") return SIGNATURE_ACCENT_AUTO;
  const value = raw.trim().toLowerCase();
  if (value === SIGNATURE_ACCENT_AUTO) return SIGNATURE_ACCENT_AUTO;
  const preset = SIGNATURE_ACCENTS.find((entry) => entry.id === value);
  if (preset?.hex) return preset.hex;
  return normalizeHexColor(value) ?? SIGNATURE_ACCENT_AUTO;
}

/** Resolves the accent for a render, falling back to whatever that layout
    considers its natural colour when the player left it on Auto. */
export function accentHex(style: SignatureStyle, fallback: string): string {
  return style.accent === SIGNATURE_ACCENT_AUTO ? fallback : style.accent;
}

function hexChannels(hex: string): [number, number, number] {
  const value = normalizeHexColor(hex) ?? "#000000";
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
}

/** Multiplies a colour's channels, clamped. What the brightness slider does to
    a painted background, and what builds a gradient's stops out of one pick. */
export function shadeHex(hex: string, factor: number): string {
  const scaled = hexChannels(hex).map((channel) => (
    Math.round(Math.min(255, Math.max(0, channel * Math.max(0, factor))))
  ));
  return `#${scaled.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export interface SignatureStyle {
  background: SignatureBackgroundId;
  /** `auto` or a hex. Colours the bars, the radar, the headline number. */
  accent: string;
  /** The hex a solid or gradient background is painted from. */
  color: string;
  /** How strongly an image background shows, 10-100. Images only. */
  opacity: number;
  /** Gaussian blur radius in px, 0-24. Images only. */
  blur: number;
  /** Background brightness as a percentage. See SIGNATURE_BRIGHTNESS_RANGE. */
  brightness: number;
  /** The picture to fetch. Only read when background is "custom". */
  imageUrl: string | null;
  /** Which keymode a skills or dan render shows. null means their best. */
  keyCount: number | null;
  /* The dan card draws two ladders side by side, and a player's rice and LN
     dans are routinely from different keymodes - 7K rice next to a 4K LN is an
     ordinary thing to want to show. One keymode for the card forced a choice
     between two true things. null means "same as keyCount". */
  lnKeyCount: number | null;
}

export const SIGNATURE_OPACITY_RANGE = { min: 10, max: 100 } as const;
export const SIGNATURE_BLUR_RANGE = { min: 0, max: 24 } as const;
/* For a painted background this is literal. For a photograph it scales the
   automatic legibility level - the one that pulls a near-white cover down far
   enough to sit white text on - rather than replacing it, so 100 means
   "whatever this picture needed" and every step from there moves the way it
   looks like it should. Taking the number literally there would make the
   control jump at the default and run backwards below it. */
export const SIGNATURE_BRIGHTNESS_RANGE = { min: 20, max: 140 } as const;
/** Must stay in step with ALLOWED_KEY_COUNTS in the backend's signature route. */
export const SIGNATURE_KEY_COUNTS = [4, 6, 7] as const;
/** Long enough for a real CDN url with a cache-busting query, short enough that
    four of them cannot crowd out the stored style. */
export const SIGNATURE_IMAGE_URL_MAX = 400;

export const DEFAULT_SIGNATURE_STYLE: SignatureStyle = {
  background: "none",
  accent: SIGNATURE_ACCENT_AUTO,
  color: "#2d1b4e",
  opacity: 55,
  blur: 6,
  brightness: 100,
  imageUrl: null,
  keyCount: null,
  lnKeyCount: null,
};

/* https only, and no embedded credentials. The transport in
   lib/safe-image-fetch.ts is what actually keeps this from being an SSRF - this
   is the cheap shape check in front of it, and it runs on the way into storage
   as well as on the way out to a render. */
export function normalizeSignatureImageUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > SIGNATURE_IMAGE_URL_MAX) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/* The single gate every style passes through, on the way in from the page and
   again on the way out to a render. Unknown ids collapse to the default rather
   than throwing: a style is cosmetic, and a render that refuses to draw because
   a stored id went stale would be a blank image on someone's profile. */
export function normalizeSignatureStyle(raw: unknown, type?: SignatureType): SignatureStyle {
  const input = (raw ?? {}) as Partial<Record<keyof SignatureStyle, unknown>>;
  const option = typeof input.background === "string" ? signatureBackground(input.background) : null;
  // A background a type cannot draw is as stale as one that no longer exists,
  // so both land on that type's default rather than on nothing at all.
  const usable = option && (!option.types || !type || option.types.includes(type));
  const background = usable ? option.id : defaultSignatureBackground(type);
  return {
    background,
    accent: normalizeSignatureAccent(input.accent),
    color: normalizeHexColor(input.color) ?? DEFAULT_SIGNATURE_STYLE.color,
    opacity: clampInt(input.opacity, SIGNATURE_OPACITY_RANGE.min, SIGNATURE_OPACITY_RANGE.max, DEFAULT_SIGNATURE_STYLE.opacity),
    blur: clampInt(input.blur, SIGNATURE_BLUR_RANGE.min, SIGNATURE_BLUR_RANGE.max, DEFAULT_SIGNATURE_STYLE.blur),
    brightness: clampInt(input.brightness, SIGNATURE_BRIGHTNESS_RANGE.min, SIGNATURE_BRIGHTNESS_RANGE.max, DEFAULT_SIGNATURE_STYLE.brightness),
    imageUrl: normalizeSignatureImageUrl(input.imageUrl),
    keyCount: normalizeSignatureKeyCount(input.keyCount),
    lnKeyCount: normalizeSignatureKeyCount(input.lnKeyCount),
  };
}

function normalizeSignatureKeyCount(raw: unknown): number | null {
  const value = Number(raw);
  return (SIGNATURE_KEY_COUNTS as readonly number[]).includes(value) ? value : null;
}

export type SignatureStyleMap = Record<SignatureType, SignatureStyle>;

/** Every type always gets an entry, so neither the page nor a renderer has to
    reason about a missing one. */
export function normalizeSignatureStyleMap(raw: unknown): SignatureStyleMap {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  const source = (parsed ?? {}) as Record<string, unknown>;
  const map = {} as SignatureStyleMap;
  for (const type of SIGNATURE_TYPES) {
    map[type] = normalizeSignatureStyle(source[type], type);
  }
  return map;
}

/* Keys are written in a fixed order because the backend hashes this string
   into the type's data version. Two identical styles that stringified
   differently would look like a change and re-render for nothing. */
export function serializeSignatureStyleMap(map: SignatureStyleMap): string {
  const ordered: Record<string, SignatureStyle> = {};
  for (const type of SIGNATURE_TYPES) {
    const style = map[type];
    ordered[type] = {
      background: style.background,
      accent: style.accent,
      color: style.color,
      opacity: style.opacity,
      blur: style.blur,
      brightness: style.brightness,
      imageUrl: style.imageUrl,
      keyCount: style.keyCount,
      lnKeyCount: style.lnKeyCount,
    };
  }
  return JSON.stringify(ordered);
}

/** Bounds what the backend will store. Comfortably past four types each
    carrying a full-length image url, and far short of anything worth putting
    in a column. */
export const SIGNATURE_STYLE_MAX_JSON = 4000;

export function styleUsesImage(style: SignatureStyle): boolean {
  return signatureBackground(style.background)?.image === true;
}

/** True when the picture has to come off the player's osu! profile, which is
    the only case worth spending a profile fetch on. */
export function styleNeedsProfileImage(style: SignatureStyle): boolean {
  const option = signatureBackground(style.background);
  return option?.image === true && option.custom !== true;
}

export function styleIsCustomImage(style: SignatureStyle): boolean {
  return signatureBackground(style.background)?.custom === true;
}

/** True when the layout should draw its own art - today only the maniacard's
    tier wash, which used to be unconditional. */
export function styleUsesTier(style: SignatureStyle): boolean {
  return signatureBackground(style.background)?.tier === true;
}

/** True when the brightness slider has something to act on. */
export function styleUsesBrightness(style: SignatureStyle): boolean {
  const option = signatureBackground(style.background);
  return option?.painted === true || option?.image === true;
}

/* A flat colour or a gradient built from it, as CSS satori can paint directly:
   no fetch, no sharp pass. Gradient runs dark-to-bright along the diagonal so
   the text, which sits top left in every wide layout, keeps the darker end. */
export function styleArt(style: SignatureStyle): SignatureBackgroundArt | null {
  return signatureBackground(style.background)?.art ?? null;
}

export function stylePaintedBackground(style: SignatureStyle): string | null {
  const option = signatureBackground(style.background);
  if (!option?.painted) return null;
  const factor = style.brightness / 100;
  if (option.id === "solid") return shadeHex(style.color, factor);
  return "linear-gradient(135deg, "
    + `${shadeHex(style.color, factor * 0.32)} 0%, `
    + `${shadeHex(style.color, factor * 0.80)} 56%, `
    + `${shadeHex(style.color, factor * 1.22)} 100%)`;
}
