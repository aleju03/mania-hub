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
}

const SIGNED_OUT: SupporterLookState = { signedIn: false, supporter: false, expiresAt: null, look: null, custom: null, frame: null, nameStyle: null, nameFont: null, profileTheme: null, profileThemeOptions: {} };

async function requireViewer(): Promise<{ userId: number; base: string } | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = getServerLiveBackendUrl();
  if (!base) return null;
  return { userId: auth.viewer.id, base };
}

function readState(body: unknown): SupporterLookState {
  const raw = (body ?? {}) as { supporter?: unknown; expiresAt?: unknown; look?: unknown; custom?: unknown; frame?: unknown; nameStyle?: unknown; nameFont?: unknown; profileTheme?: unknown; profileThemeOptions?: unknown };
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
