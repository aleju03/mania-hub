import { createServerFn } from "@tanstack/react-start";

import { bridgeAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl } from "./live-backend";
import { isSupporterAvatarFrame, isWorkshopFrameId, parseFrameDan, parseWorkshopFrameArt, type FrameDan, type SupporterAvatarFrameId, type WorkshopFrameArt } from "./supporter-avatar-frames";
import { FRAME_NAME_MAX, parseSubmittedFrames, type SubmittedFrame } from "./workshop-frames";
import { isSupporterNameFont, type SupporterNameFontId } from "./supporter-name-fonts";
import { isSupporterNameOutline, isSupporterNameStyle, type SupporterNameStyleId } from "./supporter-name-styles";
import { isSupporterProfileTheme, parseProfileThemeOptions, type ProfileThemeOptions, type SupporterProfileThemeId } from "./supporter-profile-themes";
import { parseSupporterLook, type SupporterLook } from "./supporter-card-looks";
import { NO_PACK_STYLE, parsePackStyle, SUPPORTER_BINDERS, SUPPORTER_BLADES, SUPPORTER_CARD_SLEEVES, SUPPORTER_WRAPPERS, type SupporterPackStyle } from "./supporter-pack-style";
import { isProfileStatId, parseProfileStats, PROFILE_STAT_SLOTS, type ProfileStatId } from "./profile-stats";
import { COMPANION_NAME_MAX, companionId, parseSubmittedCompanion, parseSupporterCompanion, type CompanionKind, type SubmittedCompanion } from "./supporter-companions";
import { isProfilePlayMetric, parseProfilePlayChoice, parseProfilePlays, parseProfilePlaySnapshot, PROFILE_PLAY_SORTS, type ProfilePlayChoice, type ProfilePlayPick, type ProfilePlays, type ProfilePlaySnapshot, type ProfilePlaySort } from "./profile-plays";

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
  /** When the current unbroken run began, which sets their rank; null unless active. */
  runStartedAt: number | null;
  /** A monthly subscription keeps their time renewing. */
  renewing: boolean;
  /** A renewing supporter whose subscription is $10 or more a payment. */
  patron: boolean;
  /** The highest rank (0 Amber .. 11 Holo) they ever reached: every rank up to it is unlocked. */
  bestRank: number;
  /** The unlocked rank they show instead of the current one; null for the current one. */
  shownRank: number | null;
  /** Whether their renewing rank shows its fire; they can turn it off. */
  rankFire: boolean;
  look: SupporterLook | null;
  /** The last uploaded image, kept while a preset is picked so it can be picked again. */
  custom: { url: string; scale: number; opacity: number } | null;
  /** The frame around their avatar on their profile, null for none. */
  frame: SupporterAvatarFrameId | null;
  /** How their name is drawn on their profile, null for plain. */
  nameStyle: SupporterNameStyleId | null;
  nameFont: SupporterNameFontId | null;
  nameOutline: string | null;
  /** The theme their whole profile wears, null for the site's own colours. */
  profileTheme: SupporterProfileThemeId | null;
  profileThemeOptions: ProfileThemeOptions;
  /** Their sleeve, binder and reveal confetti in packs. */
  packStyle: SupporterPackStyle;
  /** Who gave them their current time, when it is a gift code's trial. */
  giftFrom?: string | null;
  /* The art of a workshop frame among these, which the page registers to draw it. */
  frameArt?: Record<string, WorkshopFrameArt>;
}

const SIGNED_OUT: SupporterLookState = { signedIn: false, supporter: false, expiresAt: null, runStartedAt: null, renewing: false, patron: false, bestRank: 0, shownRank: null, rankFire: true, look: null, custom: null, frame: null, nameStyle: null, nameFont: null, nameOutline: null, profileTheme: null, profileThemeOptions: {}, packStyle: NO_PACK_STYLE };

export async function requireViewer(): Promise<{ userId: number; username: string; base: string } | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = getServerLiveBackendUrl();
  if (!base) return null;
  return { userId: auth.viewer.id, username: auth.viewer.username, base };
}

function readState(body: unknown): SupporterLookState {
  const raw = (body ?? {}) as { supporter?: unknown; expiresAt?: unknown; runStartedAt?: unknown; renewing?: unknown; patron?: unknown; bestRank?: unknown; shownRank?: unknown; rankFire?: unknown; look?: unknown; custom?: unknown; frame?: unknown; nameStyle?: unknown; nameFont?: unknown; nameOutline?: unknown; profileTheme?: unknown; profileThemeOptions?: unknown; packStyle?: unknown; giftFrom?: unknown; frameArt?: unknown };
  const custom = parseSupporterLook(raw.custom ? { ...(raw.custom as object), motif: "custom" } : null);
  return {
    signedIn: true,
    supporter: raw.supporter === true,
    expiresAt: typeof raw.expiresAt === "number" && Number.isFinite(raw.expiresAt) ? raw.expiresAt : null,
    runStartedAt: raw.supporter === true && typeof raw.runStartedAt === "number" && Number.isFinite(raw.runStartedAt) ? raw.runStartedAt : null,
    renewing: raw.supporter === true && raw.renewing === true,
    patron: raw.supporter === true && raw.renewing === true && raw.patron === true,
    bestRank: raw.supporter === true && Number.isInteger(raw.bestRank) ? Number(raw.bestRank) : 0,
    shownRank: raw.supporter === true && Number.isInteger(raw.shownRank) ? Number(raw.shownRank) : null,
    rankFire: raw.rankFire !== false,
    look: parseSupporterLook(raw.look),
    custom: custom?.motif === "custom" && custom.url ? { url: custom.url, scale: custom.scale ?? 1, opacity: custom.opacity ?? 0.85 } : null,
    frame: isSupporterAvatarFrame(raw.frame) ? raw.frame : null,
    nameStyle: isSupporterNameStyle(raw.nameStyle) ? raw.nameStyle : null,
    nameFont: isSupporterNameFont(raw.nameFont) ? raw.nameFont : null,
    nameOutline: isSupporterNameOutline(raw.nameOutline) ? raw.nameOutline : null,
    profileTheme: isSupporterProfileTheme(raw.profileTheme) ? raw.profileTheme : null,
    profileThemeOptions: parseProfileThemeOptions(raw.profileThemeOptions),
    packStyle: parsePackStyle(raw.packStyle),
    giftFrom: typeof raw.giftFrom === "string" ? raw.giftFrom : null,
    frameArt: parseWorkshopFrameArt(raw.frameArt),
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

/* Every dan the viewer holds and the one their Dan license shows. */
export interface FrameDanChoices {
  options: FrameDan[];
  shown: string | null;
}

function readFrameDanChoices(raw: unknown): FrameDanChoices {
  const body = (raw && typeof raw === "object" ? raw : {}) as { options?: unknown; shown?: unknown };
  const options = Array.isArray(body.options) ? body.options.map(parseFrameDan).filter((dan): dan is FrameDan => dan !== null) : [];
  return { options, shown: typeof body.shown === "string" ? body.shown : null };
}

export const fetchFrameDanChoices = createServerFn({ method: "GET" }).handler(async (): Promise<FrameDanChoices> => {
  const viewer = await requireViewer();
  if (!viewer) return { options: [], shown: null };
  const response = await fetch(`${viewer.base}/api/supporters/self/frame-dan?userId=${viewer.userId}`, { headers: bridgeAuthHeaders() });
  if (!response.ok) throw new Error(`Server ${response.status}`);
  return readFrameDanChoices(await response.json().catch(() => null));
});

export const saveFrameDanChoice = createServerFn({ method: "POST" })
  .validator((data: { dan?: unknown }) => {
    const dan = data?.dan ?? null;
    if (dan !== null && (typeof dan !== "string" || !/^\d{1,2}:(rc|ln):[a-z]{1,16}$/.test(dan))) throw new Error("Pick a dan.");
    return { dan: dan as string | null };
  })
  .handler(async ({ data }): Promise<FrameDanChoices> => {
    const viewer = await requireViewer();
    if (!viewer) throw new Error("Log in first.");
    const response = await fetch(`${viewer.base}/api/supporters/self/frame-dan`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, dan: data.dan }),
    });
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    if (response.status === 403) throw new Error("Your supporter time has run out.");
    if (!response.ok) throw new Error(String(body?.error ?? `Server ${response.status}`));
    return readFrameDanChoices(body);
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

export const saveSupporterNameOutlineSetting = createServerFn({ method: "POST" })
  .validator((data: { nameOutline?: unknown }) => {
    const nameOutline = data?.nameOutline ?? null;
    if (nameOutline !== null && !isSupporterNameOutline(nameOutline)) throw new Error("Pick an outline colour.");
    return { nameOutline };
  })
  .handler(async ({ data }): Promise<SupporterLookState> => {
    const viewer = await requireViewer();
    if (!viewer) return SIGNED_OUT;
    const response = await fetch(`${viewer.base}/api/supporters/self/name-outline`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, nameOutline: data.nameOutline }),
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

/* Sets the supporter's packs cosmetics, all three at once. */
export const saveSupporterPackStyleSetting = createServerFn({ method: "POST" })
  .validator((data: { packStyle?: unknown }) => {
    const style = parsePackStyle(data?.packStyle);
    const raw = (data?.packStyle ?? {}) as Record<string, unknown>;
    const lists = { sleeve: SUPPORTER_CARD_SLEEVES, binder: SUPPORTER_BINDERS, wrapper: SUPPORTER_WRAPPERS, blade: SUPPORTER_BLADES } as const;
    for (const key of Object.keys(lists) as (keyof typeof lists)[]) {
      if (raw[key] != null && style[key] === null) throw new Error("Pick from the list.");
    }
    return { packStyle: style };
  })
  .handler(async ({ data }): Promise<SupporterLookState> => {
    const viewer = await requireViewer();
    if (!viewer) return SIGNED_OUT;
    const response = await fetch(`${viewer.base}/api/supporters/self/pack-style`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, packStyle: data.packStyle }),
    });
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    if (response.status === 403) throw new Error("Your supporter time has run out.");
    if (!response.ok) throw new Error(String(body?.error ?? `Server ${response.status}`));
    return readState(body);
  });

/* Picks which of the viewer's unlocked ranks they show; null shows the
   current one. Answers with what was stored. */
export const saveSupporterRankShownSetting = createServerFn({ method: "POST" })
  .validator((data: { rank?: unknown }) => {
    const rank = data?.rank ?? null;
    if (rank !== null && !(Number.isInteger(rank) && (rank as number) >= 0 && (rank as number) < 12)) throw new Error("Pick a rank.");
    return { rank: rank as number | null };
  })
  .handler(async ({ data }): Promise<{ shownRank: number | null }> => {
    const viewer = await requireViewer();
    if (!viewer) throw new Error("Log in first.");
    const response = await fetch(`${viewer.base}/api/supporters/self/rank-shown`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, rank: data.rank }),
    });
    const body = await response.json().catch(() => null) as { error?: unknown; shownRank?: unknown } | null;
    if (response.status === 403) throw new Error("Your supporter time has run out.");
    if (!response.ok) throw new Error(String(body?.error ?? `Server ${response.status}`));
    return { shownRank: Number.isInteger(body?.shownRank) ? Number(body!.shownRank) : null };
  });

/* Turns the fire on the viewer's renewing rank off or back on. Answers with
   what was stored. */
export const saveSupporterRankFireSetting = createServerFn({ method: "POST" })
  .validator((data: { rankFire?: unknown }) => {
    if (typeof data?.rankFire !== "boolean") throw new Error("Pick on or off.");
    return { rankFire: data.rankFire };
  })
  .handler(async ({ data }): Promise<{ rankFire: boolean }> => {
    const viewer = await requireViewer();
    if (!viewer) throw new Error("Log in first.");
    const response = await fetch(`${viewer.base}/api/supporters/self/rank-fire`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, rankFire: data.rankFire }),
    });
    const body = await response.json().catch(() => null) as { error?: unknown; rankFire?: unknown } | null;
    if (response.status === 403) throw new Error("Your supporter time has run out.");
    if (!response.ok) throw new Error(String(body?.error ?? `Server ${response.status}`));
    return { rankFire: body?.rankFire !== false };
  });

/* Sets the supporter's four profile insight cards, or (null) puts the usual
   four back. Answers with what was stored: null for the usual four. */
export const saveSupporterProfileStatsSetting = createServerFn({ method: "POST" })
  .validator((data: { profileStats?: unknown }) => {
    const stats = data?.profileStats ?? null;
    if (stats !== null && !(Array.isArray(stats) && stats.length === PROFILE_STAT_SLOTS && stats.every(isProfileStatId))) {
      throw new Error("Pick four stats.");
    }
    return { profileStats: stats as ProfileStatId[] | null };
  })
  .handler(async ({ data }): Promise<{ profileStats: ProfileStatId[] | null }> => {
    const viewer = await requireViewer();
    if (!viewer) throw new Error("Log in first.");
    const response = await fetch(`${viewer.base}/api/supporters/self/profile-stats`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, profileStats: data.profileStats }),
    });
    const body = await response.json().catch(() => null) as { error?: unknown; profileStats?: unknown } | null;
    if (response.status === 403) throw new Error("Your supporter time has run out.");
    if (!response.ok) throw new Error(String(body?.error ?? `Server ${response.status}`));
    return { profileStats: parseProfileStats(body?.profileStats) };
  });

/* Sets the keymode the viewer's strongest-skill card shows (null: their main keymode). */
export const saveSupporterProfileSkillKeysSetting = createServerFn({ method: "POST" })
  .validator((data: { skillKeyCount?: unknown }) => {
    const keys = data?.skillKeyCount ?? null;
    if (keys !== null && !(Number.isInteger(keys) && (keys as number) >= 1 && (keys as number) <= 18)) throw new Error("Pick a keymode.");
    return { skillKeyCount: keys as number | null };
  })
  .handler(async ({ data }): Promise<void> => {
    const viewer = await requireViewer();
    if (!viewer) throw new Error("Log in first.");
    const response = await fetch(`${viewer.base}/api/supporters/self/profile-stats`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, skillKeyCount: data.skillKeyCount }),
    });
    if (response.status === 403) throw new Error("Your supporter time has run out.");
    if (!response.ok) throw new Error(`Server ${response.status}`);
  });

/* Sets the two plays under the viewer's profile stats, each a play the site
   tracked of them under their own title, or null for the usual top play.
   Answers with what was stored. */
export const saveSupporterProfilePlaysSetting = createServerFn({ method: "POST" })
  .validator((data: { profilePlays?: unknown }) => {
    const slots = data?.profilePlays ?? null;
    if (slots !== null && !(Array.isArray(slots) && slots.length === 2)) throw new Error("Two slots.");
    const picks = slots === null ? null : (slots as unknown[]).map((slot): ProfilePlayPick | null => {
      if (slot == null) return null;
      const raw = slot as Record<string, unknown>;
      if (typeof raw.title !== "string" || typeof raw.day !== "string" || !isProfilePlayMetric(raw.show)) throw new Error("Pick a play.");
      return { title: raw.title, beatmapId: Number(raw.beatmapId), day: raw.day, show: raw.show };
    });
    return { profilePlays: picks };
  })
  .handler(async ({ data }): Promise<{ profilePlays: ProfilePlays | null }> => {
    const viewer = await requireViewer();
    if (!viewer) throw new Error("Log in first.");
    const response = await fetch(`${viewer.base}/api/supporters/self/profile-plays`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, profilePlays: data.profilePlays }),
    });
    const body = await response.json().catch(() => null) as { error?: unknown; profilePlays?: unknown } | null;
    if (response.status === 403) throw new Error("Your supporter time has run out.");
    if (!response.ok) throw new Error(String(body?.error ?? `Server ${response.status}`));
    return { profilePlays: parseProfilePlays(body?.profilePlays) };
  });

/* One page of the viewer's tracked plays for the picker. */
export const fetchProfilePlayChoices = createServerFn({ method: "GET" })
  .validator((data: { query?: unknown; sort?: unknown; offset?: unknown }) => ({
    query: typeof data?.query === "string" ? data.query.slice(0, 80) : "",
    sort: (PROFILE_PLAY_SORTS as readonly unknown[]).includes(data?.sort) ? data.sort as ProfilePlaySort : "pp",
    offset: Math.max(0, Math.floor(Number(data?.offset) || 0)),
  }))
  .handler(async ({ data }): Promise<{ plays: ProfilePlayChoice[]; more: boolean }> => {
    const viewer = await requireViewer();
    if (!viewer) return { plays: [], more: false };
    const params = new URLSearchParams({ userId: String(viewer.userId), q: data.query, sort: data.sort, offset: String(data.offset) });
    const response = await fetch(`${viewer.base}/api/supporters/self/profile-plays/choices?${params}`, { headers: bridgeAuthHeaders() });
    if (!response.ok) throw new Error(`Server ${response.status}`);
    const body = await response.json().catch(() => null) as { plays?: unknown; more?: unknown } | null;
    const plays = Array.isArray(body?.plays) ? body.plays.map(parseProfilePlayChoice).filter((play): play is ProfilePlayChoice => play !== null) : [];
    return { plays, more: body?.more === true };
  });

/* One play as it would be saved: its MSD and dan at the rate it was set at. */
export const fetchProfilePlayPreview = createServerFn({ method: "GET" })
  .validator((data: { beatmapId?: unknown; day?: unknown }) => ({
    beatmapId: Math.floor(Number(data?.beatmapId) || 0),
    day: typeof data?.day === "string" ? data.day : "",
  }))
  .handler(async ({ data }): Promise<ProfilePlaySnapshot | null> => {
    const viewer = await requireViewer();
    if (!viewer) return null;
    const params = new URLSearchParams({ userId: String(viewer.userId), beatmapId: String(data.beatmapId), day: data.day });
    const response = await fetch(`${viewer.base}/api/supporters/self/profile-plays/preview?${params}`, { headers: bridgeAuthHeaders() });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null) as { play?: unknown } | null;
    return parseProfilePlaySnapshot(body?.play);
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

const COMPANION_ERRORS: Record<string, string> = {
  not_supporter: "Your supporter time has run out.",
  too_many_submissions: "That's five companions today; try again tomorrow.",
  invalid_companion: "That companion isn't available.",
};

/* Sets or clears (null) the viewer's companion; answers the id it saved. */
export const saveSupporterCompanionSetting = createServerFn({ method: "POST" })
  .validator((data: { companion?: unknown }) => {
    const companion = data?.companion ?? null;
    if (companion !== null && (typeof companion !== "string" || companion.length > 40)) throw new Error("Pick a companion.");
    return { companion: companion as string | null };
  })
  .handler(async ({ data }): Promise<{ companion: string | null }> => {
    const viewer = await requireViewer();
    if (!viewer) throw new Error("Log in first.");
    const response = await fetch(`${viewer.base}/api/supporters/self/companion`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, companion: data.companion }),
    });
    const body = await response.json().catch(() => null) as { error?: unknown; companion?: unknown } | null;
    if (!response.ok) throw new Error(COMPANION_ERRORS[String(body?.error)] ?? `Server ${response.status}`);
    const saved = parseSupporterCompanion(body?.companion);
    return { companion: saved ? companionId(saved) : null };
  });

/* The viewer's own submissions that an admin has not put on the shared list yet. */
export const fetchOwnSupporterCompanions = createServerFn({ method: "GET" }).handler(
  async (): Promise<SubmittedCompanion[]> => {
    const viewer = await requireViewer();
    if (!viewer) return [];
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const response = await fetch(`${viewer.base}/api/supporters/self/companions?userId=${viewer.userId}`, { headers: bridgeAuthHeaders() });
    if (!response.ok) throw new Error(`Server ${response.status}`);
    const body = await response.json().catch(() => null) as { companions?: unknown } | null;
    return Array.isArray(body?.companions) ? body.companions.map(parseSubmittedCompanion).filter((entry): entry is SubmittedCompanion => entry !== null) : [];
  },
);

/* Adds an uploaded companion (/api/supporter-companion), the submitter's alone until an admin lists it. */
export const submitSupporterCompanion = createServerFn({ method: "POST" })
  .validator((data: { name?: unknown; kind?: unknown; url?: unknown }) => {
    const name = typeof data?.name === "string" ? data.name.trim().slice(0, COMPANION_NAME_MAX) : "";
    if (!name) throw new Error("Give it a name.");
    if (data?.kind !== "model" && data?.kind !== "image") throw new Error("Upload a file first.");
    if (typeof data?.url !== "string") throw new Error("Upload a file first.");
    return { name, kind: data.kind as CompanionKind, url: data.url };
  })
  .handler(async ({ data }): Promise<{ companion: SubmittedCompanion }> => {
    const viewer = await requireViewer();
    if (!viewer) throw new Error("Log in first.");
    const response = await fetch(`${viewer.base}/api/supporters/self/companions`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, ...data }),
    });
    const body = await response.json().catch(() => null) as { error?: unknown; companion?: unknown } | null;
    const companion = parseSubmittedCompanion(body?.companion);
    if (!response.ok || !companion) throw new Error(COMPANION_ERRORS[String(body?.error)] ?? `Server ${response.status}`);
    return { companion };
  });

const GOOGLE_CLAIM_ERRORS: Record<string, string> = {
  invalid_order: "That doesn't look like a Google order number.",
  claimed_by_someone_else: "Someone else already claimed that order.",
  revoked: "Google has no order with that number.",
  too_many_pending: "You have a few Google payments waiting to be checked already; try again once they are.",
};

/* A Google contribution the viewer says is theirs: its order number, from the
   checkout or Google's receipt email, and what the checkout said was paid.
   It counts at once and is checked against Google's export later. */
export const claimGoogleContribution = createServerFn({ method: "POST" })
  .validator((data: { orderId?: unknown; amountUsd?: unknown }) => {
    const orderId = typeof data?.orderId === "string" ? data.orderId.trim() : "";
    if (!orderId || orderId.length > 64) throw new Error(GOOGLE_CLAIM_ERRORS.invalid_order);
    const amountUsd = Number(data?.amountUsd);
    return { orderId, amountUsd: Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : null };
  })
  .handler(async ({ data }): Promise<{ expiresAt: number | null }> => {
    const viewer = await requireViewer();
    if (!viewer) throw new Error("Log in first.");
    // admins only, as the checkout is (SupportCheckout.tsx), until a real payment has gone through it
    const { requireTrueAdminAccess } = await import("./auth-server");
    await requireTrueAdminAccess("Google contributions");
    const response = await fetch(`${viewer.base}/api/supporters/self/google-claim`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, username: viewer.username, orderId: data.orderId, amountUsd: data.amountUsd }),
    });
    const body = await response.json().catch(() => null) as { ok?: unknown; error?: unknown; expiresAt?: unknown } | null;
    if (!response.ok || body?.ok !== true) throw new Error(GOOGLE_CLAIM_ERRORS[String(body?.error)] ?? `Server ${response.status}`);
    return { expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : null };
  });

const LAVA_CLAIM_ERRORS: Record<string, string> = {
  invalid_email: "That doesn't look like an email.",
  not_found: "No unclaimed lava.top payment from that email. Payments can take a minute to arrive.",
  too_many_tries: "That's five tries today; try again tomorrow.",
};

/* lava.top payments the viewer made outside the Support page's link, named by
   the email they paid with: each unclaimed one from it becomes theirs. */
export const claimLavaPayments = createServerFn({ method: "POST" })
  .validator((data: { email?: unknown }) => {
    const email = typeof data?.email === "string" ? data.email.trim() : "";
    if (!email || email.length > 254 || !email.includes("@")) throw new Error(LAVA_CLAIM_ERRORS.invalid_email);
    return { email };
  })
  .handler(async ({ data }): Promise<{ expiresAt: number | null }> => {
    const viewer = await requireViewer();
    if (!viewer) throw new Error("Log in first.");
    const response = await fetch(`${viewer.base}/api/supporters/self/lava-claim`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, username: viewer.username, email: data.email }),
    });
    const body = await response.json().catch(() => null) as { ok?: unknown; error?: unknown; expiresAt?: unknown } | null;
    if (!response.ok || body?.ok !== true) throw new Error(LAVA_CLAIM_ERRORS[String(body?.error)] ?? `Server ${response.status}`);
    return { expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : null };
  });

/* The email the viewer is about to pay lava.top with: lava.top names the
   buyer by email only, so the payment it brings links to them on arrival. */
export const rememberLavaEmail = createServerFn({ method: "POST" })
  .validator((data: { email?: unknown }) => {
    const email = typeof data?.email === "string" ? data.email.trim() : "";
    if (!email || email.length > 254 || !email.includes("@")) throw new Error(LAVA_CLAIM_ERRORS.invalid_email);
    return { email };
  })
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const viewer = await requireViewer();
    if (!viewer) throw new Error("Log in first.");
    const response = await fetch(`${viewer.base}/api/supporters/self/lava-intent`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, username: viewer.username, email: data.email }),
    });
    const body = await response.json().catch(() => null) as { ok?: unknown; error?: unknown } | null;
    if (!response.ok || body?.ok !== true) throw new Error(LAVA_CLAIM_ERRORS[String(body?.error)] ?? `Server ${response.status}`);
    return { ok: true };
  });

const FRAME_ERRORS: Record<string, string> = {
  not_supporter: "Your supporter time has run out.",
  too_many_submissions: "That's five frames today; try again tomorrow.",
  invalid_frame: "That frame isn't complete; upload its picture again.",
  taken_down: "That frame was taken down and can't be submitted again.",
};

/* The viewer's own workshop frames, listed or waiting for review. */
export const fetchOwnWorkshopFrames = createServerFn({ method: "GET" }).handler(
  async (): Promise<SubmittedFrame[]> => {
    const viewer = await requireViewer();
    if (!viewer) return [];
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const response = await fetch(`${viewer.base}/api/supporters/self/frames?userId=${viewer.userId}`, { headers: bridgeAuthHeaders() });
    if (!response.ok) return [];
    const body = await response.json().catch(() => null) as { frames?: unknown } | null;
    return parseSubmittedFrames(body?.frames);
  },
);

/* Adds a frame made from uploads (/api/supporter-frame), straight into everyone's picker. */
export const submitWorkshopFrame = createServerFn({ method: "POST" })
  .validator((data: { name?: unknown; still?: unknown; video?: unknown; round?: unknown; overhang?: unknown }) => {
    const name = typeof data?.name === "string" ? data.name.replace(/\s+/g, " ").trim().slice(0, FRAME_NAME_MAX) : "";
    if (!name) throw new Error("Give it a name.");
    if (typeof data?.still !== "string") throw new Error("Upload its picture first.");
    const overhang = Array.isArray(data?.overhang) && data.overhang.length === 4 ? data.overhang.map(Number) : null;
    if (!overhang || overhang.some((n) => !Number.isFinite(n))) throw new Error("Upload its picture first.");
    return { name, still: data.still, video: typeof data?.video === "string" ? data.video : null, round: typeof data?.round === "string" ? data.round : null, overhang };
  })
  .handler(async ({ data }): Promise<{ frame: SubmittedFrame }> => {
    const viewer = await requireViewer();
    if (!viewer) throw new Error("Log in first.");
    const response = await fetch(`${viewer.base}/api/supporters/self/frames`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, ...data }),
    });
    const body = await response.json().catch(() => null) as { error?: unknown; frame?: unknown } | null;
    const frame = parseSubmittedFrames(body?.frame ? [body.frame] : [])[0];
    if (!response.ok || !frame) throw new Error(FRAME_ERRORS[String(body?.error)] ?? `Server ${response.status}`);
    return { frame };
  });

/* Takes down one of the viewer's own frames, off everyone wearing it. */
export const deleteOwnWorkshopFrame = createServerFn({ method: "POST" })
  .validator((data: { id?: unknown }) => {
    if (!isWorkshopFrameId(data?.id)) throw new Error("Pick a frame.");
    return { id: data.id };
  })
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const viewer = await requireViewer();
    if (!viewer) throw new Error("Log in first.");
    const response = await fetch(`${viewer.base}/api/supporters/self/frames/delete`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, id: data.id }),
    });
    if (!response.ok) throw new Error(`Server ${response.status}`);
    return { ok: true };
  });
