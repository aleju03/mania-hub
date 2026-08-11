import { getCanonicalOrigin } from "./origin";
import {
  authCookieOptions,
  serializeCookie,
  signJson,
  verifySignedJson,
} from "./auth-server";
import type { ManageableGuild } from "./communities-shared";

/*
 * Discord OAuth, used by /communities to prove someone actually runs the server
 * they are listing.
 *
 * Separate from auth-server.ts, which stays the osu! identity. This is not a
 * login: nobody signs in to the site with Discord, and nothing about a Discord
 * account is stored. It is a short-lived proof that gets thrown away as soon as
 * a listing is submitted.
 *
 * Two things are load-bearing:
 *
 *  - The cookie holds the access token, not the guild list. Someone in a hundred
 *    servers would blow past the 4 KB cookie limit if the list were in there, so
 *    the list is fetched fresh from Discord whenever it is needed.
 *  - The cookie records which osu! account connected it, and is only honoured
 *    for that same viewer. A cookie lifted from one browser is worthless in a
 *    session signed in as anyone else.
 */

export const DISCORD_LINK_COOKIE_NAME = "mania-hub-discord-link-v1";
export const DISCORD_STATE_COOKIE_NAME = "mania-hub-discord-state-v1";
// Long enough to pick a server and write a pitch, short enough that a shared
// machine does not leave a usable proof lying around.
const DISCORD_LINK_MAX_AGE_SECONDS = 30 * 60;
const DISCORD_STATE_MAX_AGE_SECONDS = 10 * 60;
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_TIMEOUT_MS = 10_000;

// Manage Server (1 << 5). Discord returns the permission bitfield as a decimal
// string, and the high bits are past Number.MAX_SAFE_INTEGER, so it is read as
// a BigInt rather than a number.
const MANAGE_GUILD = 1n << 5n;

export interface DiscordLinkPayload {
  discordUserId: string;
  discordUsername: string;
  // Shown back to the person mid-flow so "connected as" is something they can
  // recognise at a glance rather than a name they have to read.
  discordAvatarUrl: string | null;
  // The osu! account that connected this. The gate, not decoration.
  osuUserId: number;
  accessToken: string;
  issuedAt: number;
}

interface DiscordStatePayload {
  state: string;
  next: string;
  redirectUri: string;
  osuUserId: number;
  issuedAt: number;
}

export function isDiscordOAuthConfigured(): boolean {
  return Boolean(discordClientId() && process.env.DISCORD_CLIENT_SECRET);
}

function discordClientId(): string | undefined {
  // The application id is the OAuth client id; DISCORD_CLIENT_ID exists so a
  // deploy can point the directory at a different app than the bot if it ever
  // needs to.
  return process.env.DISCORD_CLIENT_ID || process.env.DISCORD_APPLICATION_ID;
}

export function getDiscordRedirectUri(request: Request): string {
  // Not request.url: behind a TLS-terminating proxy that origin is the internal
  // http:// one, and Discord rejects a redirect_uri that is not an exact match
  // for a registered value.
  return `${getCanonicalOrigin(request)}/api/auth/discord/callback`;
}

export function buildDiscordAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  // identify names the account, guilds lists the servers it is in along with
  // the permissions it holds in each. Nothing else is asked for: no email, no
  // ability to read messages, no ability to join anything.
  url.searchParams.set("scope", "identify guilds");
  url.searchParams.set("state", state);
  // Always re-ask rather than silently reusing a previous grant, so connecting
  // is a visible act every time.
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export async function createDiscordStateCookieHeader(payload: DiscordStatePayload, request: Request): Promise<string> {
  return serializeCookie(
    DISCORD_STATE_COOKIE_NAME,
    await signJson(payload),
    authCookieOptions(request, DISCORD_STATE_MAX_AGE_SECONDS),
  );
}

export async function readDiscordStateCookie(raw: string | undefined): Promise<DiscordStatePayload | null> {
  const payload = await verifySignedJson<Partial<DiscordStatePayload>>(raw);
  if (
    !payload ||
    typeof payload.state !== "string" ||
    typeof payload.next !== "string" ||
    typeof payload.redirectUri !== "string" ||
    typeof payload.osuUserId !== "number" ||
    typeof payload.issuedAt !== "number"
  ) {
    return null;
  }
  if (Date.now() - payload.issuedAt > DISCORD_STATE_MAX_AGE_SECONDS * 1000) return null;
  return payload as DiscordStatePayload;
}

export function clearDiscordStateCookieHeader(request: Request): string {
  return serializeCookie(DISCORD_STATE_COOKIE_NAME, "", {
    ...authCookieOptions(request, 0),
    expires: new Date(0),
  });
}

export async function createDiscordLinkCookieHeader(payload: DiscordLinkPayload, request: Request): Promise<string> {
  return serializeCookie(
    DISCORD_LINK_COOKIE_NAME,
    await signJson(payload),
    authCookieOptions(request, DISCORD_LINK_MAX_AGE_SECONDS),
  );
}

export function clearDiscordLinkCookieHeader(request: Request): string {
  return serializeCookie(DISCORD_LINK_COOKIE_NAME, "", {
    ...authCookieOptions(request, 0),
    expires: new Date(0),
  });
}

/**
 * Reads back the connection, but only for the osu! account that made it.
 * `osuUserId` is the currently signed-in viewer, so a mismatch means the cookie
 * outlived its session or came from somewhere else, and it counts as absent.
 */
export async function readDiscordLink(raw: string | undefined, osuUserId: number): Promise<DiscordLinkPayload | null> {
  const payload = await verifySignedJson<Partial<DiscordLinkPayload>>(raw);
  if (
    !payload ||
    typeof payload.discordUserId !== "string" ||
    typeof payload.discordUsername !== "string" ||
    typeof payload.osuUserId !== "number" ||
    typeof payload.accessToken !== "string" ||
    typeof payload.issuedAt !== "number"
  ) {
    return null;
  }
  if (payload.osuUserId !== osuUserId) return null;
  if (Date.now() - payload.issuedAt > DISCORD_LINK_MAX_AGE_SECONDS * 1000) return null;
  return {
    ...(payload as DiscordLinkPayload),
    // Added after the first cookies were minted, so an in-flight one without it
    // still reads back rather than dropping someone mid-flow.
    discordAvatarUrl: typeof payload.discordAvatarUrl === "string" ? payload.discordAvatarUrl : null,
  };
}

export interface DiscordIdentity {
  discordUserId: string;
  discordUsername: string;
  discordAvatarUrl: string | null;
  accessToken: string;
}

export async function exchangeDiscordCode(code: string, redirectUri: string): Promise<DiscordIdentity> {
  const clientId = discordClientId();
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Discord OAuth is not configured.");

  const tokenResponse = await fetchWithTimeout(`${DISCORD_API_BASE}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!tokenResponse.ok) throw new Error(`Discord token exchange failed (${tokenResponse.status}).`);
  const token = (await tokenResponse.json()) as { access_token?: string };
  if (typeof token.access_token !== "string") throw new Error("Discord token exchange returned no token.");

  const meResponse = await fetchWithTimeout(`${DISCORD_API_BASE}/users/@me`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!meResponse.ok) throw new Error(`Discord identity lookup failed (${meResponse.status}).`);
  const me = (await meResponse.json()) as {
    id?: string;
    username?: string;
    global_name?: string | null;
    avatar?: string | null;
  };
  if (typeof me.id !== "string") throw new Error("Discord identity lookup returned no user.");

  return {
    discordUserId: me.id,
    discordUsername: me.global_name || me.username || me.id,
    discordAvatarUrl: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null,
    accessToken: token.access_token,
  };
}

/**
 * The servers this Discord account may speak for: ones it owns outright, and
 * ones where it holds Manage Server. Anything else it is merely a member of is
 * dropped here, which is the whole ownership check.
 */
export async function fetchManageableGuilds(accessToken: string): Promise<ManageableGuild[]> {
  const response = await fetchWithTimeout(`${DISCORD_API_BASE}/users/@me/guilds?with_counts=true`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Discord guild lookup failed (${response.status}).`);
  const guilds = (await response.json()) as Array<{
    id?: string;
    name?: string;
    icon?: string | null;
    owner?: boolean;
    permissions?: string;
    approximate_member_count?: number;
  }>;
  if (!Array.isArray(guilds)) return [];

  return guilds
    .filter((guild) => typeof guild.id === "string" && typeof guild.name === "string")
    .filter((guild) => guild.owner === true || hasManageGuild(guild.permissions))
    .map((guild) => ({
      id: guild.id as string,
      name: guild.name as string,
      iconUrl: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64` : null,
      memberCount: typeof guild.approximate_member_count === "number" ? guild.approximate_member_count : null,
      owner: guild.owner === true,
    }))
    .sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0));
}

function hasManageGuild(permissions: string | undefined): boolean {
  if (typeof permissions !== "string" || permissions === "") return false;
  try {
    return (BigInt(permissions) & MANAGE_GUILD) === MANAGE_GUILD;
  } catch {
    return false;
  }
}

/**
 * Hands the token back to Discord once the listing is in. Best effort: the
 * cookie is cleared either way, and the token expires on its own.
 */
export async function revokeDiscordToken(accessToken: string): Promise<void> {
  const clientId = discordClientId();
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) return;
  try {
    await fetchWithTimeout(`${DISCORD_API_BASE}/oauth2/token/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        token: accessToken,
      }).toString(),
    });
  } catch {
    // Nothing to do about it, and nothing depends on it having worked.
  }
}

function fetchWithTimeout(input: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timeout);
  });
}
