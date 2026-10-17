import { createServerFn } from "@tanstack/react-start";

import { bridgeAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl } from "./live-backend";
import { isSupporterAvatarFrame, type SupporterAvatarFrameId } from "./supporter-avatar-frames";
import { isSupporterNameFont, type SupporterNameFontId } from "./supporter-name-fonts";
import { isSupporterNameStyle, type SupporterNameStyleId } from "./supporter-name-styles";
import { isSupporterProfileTheme, parseProfileThemeOptions, type ProfileThemeOptions, type SupporterProfileThemeId } from "./supporter-profile-themes";
import { parseSupporterLook, type SupporterLook } from "./supporter-card-looks";

// Server functions behind the /supporter page: the viewer's supporter status
// and the look their card wears. The viewer always comes from the osu! login
// cookie, never from client input, so a player can only change their own card.
// The backend routes are bridge-token gated; that token only exists
// server-side. Mirrors the signature bridge.

export interface SupporterLookState {
  signedIn: boolean;
  supporter: boolean;
  /** When the bought time runs out (ms); past for a lapsed supporter, null if they never supported. */
  expiresAt: number | null;
  look: SupporterLook | null;
  /** The last uploaded image, kept while a preset is picked so it can be picked again. */
  custom: { url: string; scale: number; opacity: number } | null;
  /** The frame around their avatar on their profile, null for none. */
  frame: SupporterAvatarFrameId | null;
  /** How their name is drawn on their profile, null for plain. */
  nameStyle: SupporterNameStyleId | null;
  nameFont: SupporterNameFontId | null;
  /** The theme their whole profile wears, null for the site's own colours. */
  profileTheme: SupporterProfileThemeId | null;
  profileThemeOptions: ProfileThemeOptions;
  /** Who gave them their current time, when it is a gift code's trial. */
  giftFrom?: string | null;
}

const SIGNED_OUT: SupporterLookState = { signedIn: false, supporter: false, expiresAt: null, look: null, custom: null, frame: null, nameStyle: null, nameFont: null, profileTheme: null, profileThemeOptions: {} };

async function requireViewer(): Promise<{ userId: number; username: string; base: string } | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = getServerLiveBackendUrl();
  if (!base) return null;
  return { userId: auth.viewer.id, username: auth.viewer.username, base };
}

function readState(body: unknown): SupporterLookState {
  const raw = (body ?? {}) as { supporter?: unknown; expiresAt?: unknown; look?: unknown; custom?: unknown; frame?: unknown; nameStyle?: unknown; nameFont?: unknown; profileTheme?: unknown; profileThemeOptions?: unknown; giftFrom?: unknown };
  const custom = parseSupporterLook(raw.custom ? { ...(raw.custom as object), motif: "custom" } : null);
  return {
    signedIn: true,
    supporter: raw.supporter === true,
    expiresAt: typeof raw.expiresAt === "number" && Number.isFinite(raw.expiresAt) ? raw.expiresAt : null,
    look: parseSupporterLook(raw.look),
    custom: custom?.motif === "custom" && custom.url ? { url: custom.url, scale: custom.scale ?? 1, opacity: custom.opacity ?? 0.85 } : null,
    frame: isSupporterAvatarFrame(raw.frame) ? raw.frame : null,
    nameStyle: isSupporterNameStyle(raw.nameStyle) ? raw.nameStyle : null,
    nameFont: isSupporterNameFont(raw.nameFont) ? raw.nameFont : null,
    profileTheme: isSupporterProfileTheme(raw.profileTheme) ? raw.profileTheme : null,
    profileThemeOptions: parseProfileThemeOptions(raw.profileThemeOptions),
    giftFrom: typeof raw.giftFrom === "string" ? raw.giftFrom : null,
  };
}

export const fetchSupporterLookState = createServerFn({ method: "GET" }).handler(
  async (): Promise<SupporterLookState> => {
    const viewer = await requireViewer();
    if (!viewer) return SIGNED_OUT;
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const response = await fetch(`${viewer.base}/api/supporters/self/look?userId=${viewer.userId}`, { headers: bridgeAuthHeaders() });
    if (!response.ok) throw new Error(`Server ${response.status}`);
    return readState(await response.json().catch(() => null));
  },
);

export const saveSupporterLookSetting = createServerFn({ method: "POST" })
  .validator((data: { motif?: unknown; palette?: unknown; url?: unknown; scale?: unknown; opacity?: unknown }) => {
    const look = parseSupporterLook({ ...data, palette: data?.palette ?? null });
    if (!look || (data?.motif === "custom" && look.motif !== "custom")) throw new Error("Pick a motif.");
    return look;
  })
  .handler(async ({ data }): Promise<SupporterLookState> => {
    const viewer = await requireViewer();
    if (!viewer) return SIGNED_OUT;
    const response = await fetch(`${viewer.base}/api/supporters/self/look`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, ...data }),
    });
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    if (response.status === 403) throw new Error("Your supporter time has run out.");
    if (!response.ok) throw new Error(String(body?.error ?? `Server ${response.status}`));
    return readState(body);
  });

export const saveSupporterFrameSetting = createServerFn({ method: "POST" })
  .validator((data: { frame?: unknown }) => {
    const frame = data?.frame ?? null;
    if (frame !== null && !isSupporterAvatarFrame(frame)) throw new Error("Pick a frame.");
    return { frame };
  })
  .handler(async ({ data }): Promise<SupporterLookState> => {
    const viewer = await requireViewer();
    if (!viewer) return SIGNED_OUT;
    const response = await fetch(`${viewer.base}/api/supporters/self/frame`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, frame: data.frame }),
    });
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    if (response.status === 403) throw new Error("Your supporter time has run out.");
    if (!response.ok) throw new Error(String(body?.error ?? `Server ${response.status}`));
    return readState(body);
  });

export const saveSupporterNameStyleSetting = createServerFn({ method: "POST" })
  .validator((data: { nameStyle?: unknown }) => {
    const nameStyle = data?.nameStyle ?? null;
    if (nameStyle !== null && !isSupporterNameStyle(nameStyle)) throw new Error("Pick a name style.");
    return { nameStyle };
  })
  .handler(async ({ data }): Promise<SupporterLookState> => {
    const viewer = await requireViewer();
    if (!viewer) return SIGNED_OUT;
    const response = await fetch(`${viewer.base}/api/supporters/self/name-style`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, nameStyle: data.nameStyle }),
    });
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    if (response.status === 403) throw new Error("Your supporter time has run out.");
    if (!response.ok) throw new Error(String(body?.error ?? `Server ${response.status}`));
    return readState(body);
  });

export const saveSupporterNameFontSetting = createServerFn({ method: "POST" })
  .validator((data: { nameFont?: unknown }) => {
    const nameFont = data?.nameFont ?? null;
    if (nameFont !== null && !isSupporterNameFont(nameFont)) throw new Error("Pick a name font.");
    return { nameFont };
  })
  .handler(async ({ data }): Promise<SupporterLookState> => {
    const viewer = await requireViewer();
    if (!viewer) return SIGNED_OUT;
    const response = await fetch(`${viewer.base}/api/supporters/self/name-font`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, nameFont: data.nameFont }),
    });
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    if (response.status === 403) throw new Error("Your supporter time has run out.");
    if (!response.ok) throw new Error(String(body?.error ?? `Server ${response.status}`));
    return readState(body);
  });

export const saveSupporterProfileThemeSetting = createServerFn({ method: "POST" })
  .validator((data: { profileTheme?: unknown; profileThemeOptions?: unknown }) => {
    const profileTheme = data?.profileTheme ?? null;
    if (profileTheme !== null && !isSupporterProfileTheme(profileTheme)) throw new Error("Pick a profile theme.");
    return { profileTheme, profileThemeOptions: parseProfileThemeOptions(data?.profileThemeOptions) };
  })
  .handler(async ({ data }): Promise<SupporterLookState> => {
    const viewer = await requireViewer();
    if (!viewer) return SIGNED_OUT;
    const response = await fetch(`${viewer.base}/api/supporters/self/profile-theme`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, profileTheme: data.profileTheme, profileThemeOptions: data.profileThemeOptions }),
    });
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    if (response.status === 403) throw new Error("Your supporter time has run out.");
    if (!response.ok) throw new Error(String(body?.error ?? `Server ${response.status}`));
    return readState(body);
  });

export interface SupporterWelcomeState {
  due: boolean;
  expiresAt: number | null;
  /** Who gave them their time, when it came from a gift code. */
  giftFrom: string | null;
}

/** Whether the viewer is due the site's one-time supporter thank-you, and when their time runs out. */
export const fetchSupporterWelcome = createServerFn({ method: "GET" }).handler(
  async (): Promise<SupporterWelcomeState> => {
    const viewer = await requireViewer();
    if (!viewer) return { due: false, expiresAt: null, giftFrom: null };
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const response = await fetch(`${viewer.base}/api/supporters/self/welcome?userId=${viewer.userId}`, { headers: bridgeAuthHeaders() });
    if (!response.ok) return { due: false, expiresAt: null, giftFrom: null };
    const body = await response.json().catch(() => null) as { due?: unknown; expiresAt?: unknown; giftFrom?: unknown } | null;
    const expiresAt = typeof body?.expiresAt === "number" && Number.isFinite(body.expiresAt) ? body.expiresAt : null;
    return { due: body?.due === true && expiresAt !== null, expiresAt, giftFrom: typeof body?.giftFrom === "string" ? body.giftFrom : null };
  },
);

export const markSupporterWelcomeSeen = createServerFn({ method: "POST" }).handler(async (): Promise<void> => {
  const viewer = await requireViewer();
  if (!viewer) return;
  await fetch(`${viewer.base}/api/supporters/self/welcome`, {
    method: "POST",
    headers: bridgeAuthHeaders(true),
    body: JSON.stringify({ userId: viewer.userId }),
  });
});

/* Gift codes: a paying supporter's one-time code that gives a friend a short
   trial (backend features/supporter-gifts.ts). */

export interface SupporterGiftState {
  /** Their unused code, null when they have none right now. */
  code: string | null;
  /** The last code of theirs a friend claimed. */
  lastClaim: { username: string | null; claimedAt: number } | null;
  trialDays: number;
}

export type GiftClaimError = "invalid_code" | "already_claimed" | "own_code" | "already_supporter" | "trial_used" | "signed_out" | "failed";

const GIFT_CODE_PATTERN = /^[A-Za-z0-9-]{1,16}$/;

export const fetchSupporterGiftCode = createServerFn({ method: "GET" }).handler(async (): Promise<SupporterGiftState | null> => {
  const viewer = await requireViewer();
  if (!viewer) return null;
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
  const response = await fetch(`${viewer.base}/api/supporters/self/gift-code?userId=${viewer.userId}`, { headers: bridgeAuthHeaders() });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null) as { code?: unknown; lastClaim?: { username?: unknown; claimedAt?: unknown } | null; trialDays?: unknown } | null;
  return {
    code: typeof body?.code === "string" ? body.code : null,
    lastClaim: body?.lastClaim && typeof body.lastClaim.claimedAt === "number"
      ? { username: typeof body.lastClaim.username === "string" ? body.lastClaim.username : null, claimedAt: body.lastClaim.claimedAt }
      : null,
    trialDays: typeof body?.trialDays === "number" ? body.trialDays : 7,
  };
});

/** Who a live code is from; null for a code that does not exist or is used. */
export const peekSupporterGiftCode = createServerFn({ method: "GET" })
  .validator((data: { code?: unknown }) => ({ code: typeof data?.code === "string" && GIFT_CODE_PATTERN.test(data.code) ? data.code : "" }))
  .handler(async ({ data }): Promise<{ from: string | null; trialDays: number } | null> => {
    const base = getServerLiveBackendUrl();
    if (!base || !data.code) return null;
    const response = await fetch(`${base}/api/supporters/gift-code/${encodeURIComponent(data.code)}`);
    if (!response.ok) return null;
    const body = await response.json().catch(() => null) as { from?: unknown; trialDays?: unknown } | null;
    return { from: typeof body?.from === "string" ? body.from : null, trialDays: typeof body?.trialDays === "number" ? body.trialDays : 7 };
  });

export const claimSupporterGiftCode = createServerFn({ method: "POST" })
  .validator((data: { code?: unknown }) => ({ code: typeof data?.code === "string" && GIFT_CODE_PATTERN.test(data.code) ? data.code : "" }))
  .handler(async ({ data }): Promise<{ ok: true; expiresAt: number | null; from: string | null } | { ok: false; error: GiftClaimError }> => {
    const viewer = await requireViewer();
    if (!viewer) return { ok: false, error: "signed_out" };
    if (!data.code) return { ok: false, error: "invalid_code" };
    const response = await fetch(`${viewer.base}/api/supporters/self/gift-code/claim`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, username: viewer.username, code: data.code }),
    });
    const body = await response.json().catch(() => null) as { ok?: unknown; error?: unknown; expiresAt?: unknown; from?: unknown } | null;
    if (response.ok && body?.ok === true) {
      return { ok: true, expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : null, from: typeof body.from === "string" ? body.from : null };
    }
    const known: GiftClaimError[] = ["invalid_code", "already_claimed", "own_code", "already_supporter", "trial_used"];
    return { ok: false, error: known.includes(body?.error as GiftClaimError) ? body!.error as GiftClaimError : "failed" };
  });
