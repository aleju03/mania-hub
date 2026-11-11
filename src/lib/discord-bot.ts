import { createServerFn } from "@tanstack/react-start";
import { getServerLiveBackendUrl } from "./live-backend";
import { liveBridgeToken } from "./live-backend-tokens";
import type { DiscordMessageJson } from "../components/discord/message/DiscordMessageView";

/*
 * The /discord page's bot settings: linking a Discord account through Discord
 * OAuth (the proof /communities already uses), the person's own preferences,
 * and the feeds and automatic replies of servers they run. Every call acts for
 * the osu!-verified viewer; server changes also re-check, through Discord,
 * that the viewer may manage that server.
 */

export interface BotPreferences {
  defaultKeys: "4k" | "7k" | null;
  privateReplies: boolean;
}

export interface BotAccount {
  signedIn: boolean;
  oauthConfigured: boolean;
  // The Discord account connected in this browser in the last 30 minutes, if any.
  connection: { discordUserId: string; discordUsername: string; discordAvatarUrl: string | null } | null;
  links: Array<{ discordUserId: string; osuUsername: string; verified: boolean }>;
  settings: BotPreferences | null;
  alerts: BotAlerts | null;
}

// Supporter DMs: what the bot messages the viewer's verified Discord link about.
export interface BotAlerts {
  supporter: boolean;
  snipes: boolean;
  goals: boolean;
  newMaps: boolean;
  cardPulls: boolean;
  weeklyRecap: boolean;
  follows: BotFeedPlayer[];
  // When Discord last refused a DM to the viewer.
  failedAt: string | null;
  // The DM language; until picked (localeChosen) it follows the site's.
  locale: string;
  localeChosen: boolean;
}

export type BotAlertsPatch = Partial<Pick<BotAlerts, "snipes" | "goals" | "newMaps" | "cardPulls" | "weeklyRecap">> & { follows?: number[]; dmLocale?: string };

export interface BotChannel {
  id: string;
  name: string;
  category: string | null;
}

export interface BotServer {
  id: string;
  name: string;
  iconUrl: string | null;
  botPresent: boolean;
  channels: BotChannel[];
  subscriptions: Array<{ channelId: string; feedType: string; country: string; minPp: number; keys?: number[]; keymodeTop?: number; players?: BotFeedPlayer[] }>;
  settings: { defaultCountry: string | null; autoDanChannels: string[] };
}

export interface BotFeedPlayer {
  id: number;
  username: string;
  avatarUrl: string | null;
}

export interface BotServers {
  ok: boolean;
  error?: "signin" | "no_discord" | "unavailable";
  available: boolean;
  feedTypes: string[];
  autoDanAvailable: boolean;
  defaultCountry: string;
  servers: BotServer[];
}

export interface BotServerChange {
  defaultCountry?: string | null;
  feed?: { channelId: string; feedType: string; on: boolean; country?: string };
  feedFilters?: { channelId: string; feedType: string; minPp: number; keys: number[]; keymodeTop: number; players: number[] };
  autoDan?: { channelId: string; on: boolean };
}

const EMPTY_SERVERS: Omit<BotServers, "ok"> = { available: false, feedTypes: [], autoDanAvailable: false, defaultCountry: "CR", servers: [] };

function headers(): Record<string, string> {
  const result: Record<string, string> = { "content-type": "application/json" };
  const token = liveBridgeToken();
  if (token) result.authorization = `Bearer ${token}`;
  return result;
}

async function noStore(): Promise<void> {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
}

async function viewer() {
  const { readCurrentAuth } = await import("./auth-server");
  return (await readCurrentAuth()).viewer ?? null;
}

// The site language, which the backend keeps so supporter DMs are written in it.
async function siteLocale(): Promise<string> {
  const { getCookie } = await import("@tanstack/react-start/server");
  const { LOCALE_COOKIE_NAME } = await import("./locale-cookie");
  const { normalizeLocale } = await import("./locale");
  const raw = getCookie(LOCALE_COOKIE_NAME);
  return (raw && normalizeLocale(decodeURIComponent(raw))) || "en";
}

async function connection(osuUserId: number) {
  const { getCookie } = await import("@tanstack/react-start/server");
  const { DISCORD_LINK_COOKIE_NAME, readDiscordLink } = await import("./discord-auth-server");
  return readDiscordLink(getCookie(DISCORD_LINK_COOKIE_NAME), osuUserId);
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
  const base = getServerLiveBackendUrl();
  if (!base) return null;
  try {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    const parsed = await response.json().catch(() => null) as T | null;
    return response.ok ? parsed : null;
  } catch {
    return null;
  }
}

async function readAccount(viewerId: number, signedIn: boolean, viewerUsername?: string, countryCode?: string | null): Promise<BotAccount> {
  const { isDiscordOAuthConfigured } = await import("./discord-auth-server");
  const link = signedIn ? await connection(viewerId) : null;
  let account = signedIn
    ? await post<AccountBody>("/api/discord/account", { viewerId, locale: await siteLocale() })
    : null;
  // A link typed in /link for the Discord account just connected here is now
  // proven, so it is confirmed without another click.
  if (link && viewerUsername && account?.links?.some((entry) => entry.discordUserId === link.discordUserId && !entry.verified)) {
    account = await post<AccountBody>("/api/discord/account/link", {
      viewerId,
      viewerUsername,
      countryCode: countryCode ?? null,
      discordUserId: link.discordUserId,
    }) ?? account;
  }
  return {
    signedIn,
    oauthConfigured: isDiscordOAuthConfigured(),
    connection: link ? { discordUserId: link.discordUserId, discordUsername: link.discordUsername, discordAvatarUrl: link.discordAvatarUrl } : null,
    links: account?.links ?? [],
    settings: account?.settings ?? null,
    alerts: account?.alerts ?? null,
  };
}

type AccountBody = { links?: BotAccount["links"]; settings?: BotPreferences | null; alerts?: BotAlerts | null };

export const saveBotAlerts = createServerFn({ method: "POST" })
  .validator((data: BotAlertsPatch) => {
    const patch: BotAlertsPatch = {};
    if (typeof data?.snipes === "boolean") patch.snipes = data.snipes;
    if (typeof data?.goals === "boolean") patch.goals = data.goals;
    if (typeof data?.newMaps === "boolean") patch.newMaps = data.newMaps;
    if (typeof data?.cardPulls === "boolean") patch.cardPulls = data.cardPulls;
    if (typeof data?.weeklyRecap === "boolean") patch.weeklyRecap = data.weeklyRecap;
    if (data?.dmLocale === "en" || data?.dmLocale === "es" || data?.dmLocale === "zh-CN") patch.dmLocale = data.dmLocale;
    if (Array.isArray(data?.follows)) patch.follows = data.follows.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 50);
    return patch;
  })
  .handler(async ({ data }): Promise<BotAccount> => {
    await noStore();
    const me = await viewer();
    if (!me) return readAccount(0, false);
    // Refused (no longer a supporter) or unreachable: the page says it didn't save.
    if (!await post("/api/discord/account/alerts", { viewerId: me.id, locale: await siteLocale(), ...data })) throw new Error("save_failed");
    return readAccount(me.id, true);
  });

/** Sends the viewer a test DM; `result` says whether Discord let it through. */
export const testBotAlerts = createServerFn({ method: "POST" }).handler(async (): Promise<{ result: string; account: BotAccount }> => {
  await noStore();
  const me = await viewer();
  if (!me) return { result: "failed", account: await readAccount(0, false) };
  const body = await post<{ result?: string }>("/api/discord/account/alerts/test", { viewerId: me.id, locale: await siteLocale() });
  return { result: body?.result ?? "failed", account: await readAccount(me.id, true) };
});

export const fetchBotAccount = createServerFn({ method: "GET" }).handler(async (): Promise<BotAccount> => {
  await noStore();
  const me = await viewer();
  return readAccount(me?.id ?? 0, Boolean(me), me?.username, me?.countryCode);
});

/** Links the Discord account connected in this browser to the signed-in osu! account. */
export const linkBotAccount = createServerFn({ method: "POST" }).handler(async (): Promise<BotAccount> => {
  await noStore();
  const me = await viewer();
  if (!me) return readAccount(0, false);
  const link = await connection(me.id);
  if (link) {
    await post("/api/discord/account/link", {
      viewerId: me.id,
      viewerUsername: me.username,
      countryCode: me.countryCode,
      discordUserId: link.discordUserId,
    });
  }
  return readAccount(me.id, true);
});

export const unlinkBotAccount = createServerFn({ method: "POST" })
  .validator((data: { discordUserId?: unknown }) => ({ discordUserId: typeof data?.discordUserId === "string" ? data.discordUserId : "" }))
  .handler(async ({ data }): Promise<BotAccount> => {
    await noStore();
    const me = await viewer();
    if (!me) return readAccount(0, false);
    await post("/api/discord/account/unlink", { viewerId: me.id, discordUserId: data.discordUserId });
    return readAccount(me.id, true);
  });

export const saveBotPreferences = createServerFn({ method: "POST" })
  .validator((data: Partial<BotPreferences>) => {
    const patch: Partial<BotPreferences> = {};
    if (data && "defaultKeys" in data) patch.defaultKeys = data.defaultKeys === "4k" || data.defaultKeys === "7k" ? data.defaultKeys : null;
    if (data && "privateReplies" in data) patch.privateReplies = data.privateReplies === true;
    return patch;
  })
  .handler(async ({ data }): Promise<BotAccount> => {
    await noStore();
    const me = await viewer();
    if (!me) return readAccount(0, false);
    await post("/api/discord/account/settings", { viewerId: me.id, ...data });
    return readAccount(me.id, true);
  });

async function manageableGuilds(osuUserId: number) {
  const link = await connection(osuUserId);
  if (!link) return null;
  const { fetchManageableGuilds } = await import("./discord-auth-server");
  try {
    return await fetchManageableGuilds(link.accessToken);
  } catch {
    // An expired or revoked grant; connecting again fixes it.
    return null;
  }
}

export const fetchBotServers = createServerFn({ method: "GET" }).handler(async (): Promise<BotServers> => {
  await noStore();
  const me = await viewer();
  if (!me) return { ok: false, error: "signin", ...EMPTY_SERVERS };
  const guilds = await manageableGuilds(me.id);
  if (!guilds) {
    // No Discord connection in this browser: a verified link still shows the
    // servers with the bot where that Discord account can manage the server.
    const linked = await post<Omit<BotServers, "ok"> & { ok?: boolean; error?: string }>("/api/discord/servers", { viewerId: me.id, fromLinks: true });
    if (!linked) return { ok: false, error: "unavailable", ...EMPTY_SERVERS };
    if (linked.ok === false) return { ok: false, error: "no_discord", ...EMPTY_SERVERS };
    return { ...EMPTY_SERVERS, ...linked, ok: true, error: undefined };
  }
  const result = await post<Omit<BotServers, "ok">>("/api/discord/servers", {
    viewerId: me.id,
    guilds: guilds.map((guild) => ({ id: guild.id, name: guild.name, iconUrl: guild.iconUrl })),
  });
  if (!result) return { ok: false, error: "unavailable", ...EMPTY_SERVERS };
  return { ok: true, ...EMPTY_SERVERS, ...result };
});

export const updateBotServer = createServerFn({ method: "POST" })
  .validator((data: { guildId?: unknown; change?: unknown }) => ({
    guildId: typeof data?.guildId === "string" ? data.guildId : "",
    change: (data?.change && typeof data.change === "object" ? data.change : {}) as BotServerChange,
  }))
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string; server?: BotServer }> => {
    await noStore();
    const me = await viewer();
    if (!me) return { ok: false, error: "signin" };
    // Re-checked on every change rather than trusted from the page: through the
    // Discord connection in this browser if there is one, otherwise the
    // backend checks the viewer's verified link with the bot's own token.
    const oauthGuilds = await manageableGuilds(me.id);
    const guild = oauthGuilds?.find((candidate) => candidate.id === data.guildId);
    if (oauthGuilds && !guild) return { ok: false, error: "no_access" };
    const base = getServerLiveBackendUrl();
    if (!base) return { ok: false, error: "unavailable" };
    const response = await fetch(`${base}/api/discord/servers/update`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(guild
        ? { viewerId: me.id, guildId: guild.id, guildName: guild.name, change: data.change }
        : { viewerId: me.id, guildId: data.guildId, fromLinks: true, change: data.change }),
    }).catch(() => null);
    const body = await response?.json().catch(() => null) as { error?: string; servers?: BotServer[] } | null;
    if (!response?.ok) return { ok: false, error: body?.error ?? "failed" };
    const server = body?.servers?.[0];
    return { ok: true, server: server ? { ...server, name: guild?.name ?? server.name, iconUrl: guild?.iconUrl ?? server.iconUrl } : undefined };
  });

export const fetchBotPreview = createServerFn({ method: "GET" })
  .validator((data: { view?: unknown }) => ({ view: typeof data?.view === "string" ? data.view.slice(0, 20) : "profile" }))
  .handler(async ({ data }): Promise<{ message: DiscordMessageJson | null }> => {
    const base = getServerLiveBackendUrl();
    if (!base) return { message: null };
    const me = await viewer();
    const query = new URLSearchParams({ view: data.view });
    if (me) query.set("player", String(me.id));
    try {
      const response = await fetch(`${base}/api/discord/preview?${query.toString()}`, { headers: me ? headers() : {} });
      const body = await response.json() as { message?: DiscordMessageJson | null };
      return { message: response.ok ? body.message ?? null : null };
    } catch {
      return { message: null };
    }
  });
