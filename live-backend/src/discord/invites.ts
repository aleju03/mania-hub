import { logWarn } from "../logger.js";

/*
 * Invite lookup for the /communities directory.
 *
 * Deliberately standalone rather than a method on DiscordRest. Discord's invite
 * endpoint takes no authentication at all, and the directory has to keep working
 * with ENABLE_DISCORD_BOT=false - which is how the backend runs locally, and how
 * it would run if the bot were ever turned off. Hanging this off the bot runtime
 * (which is null when the bot is disabled) would tie an unrelated feature to it.
 *
 * This is the only thing that decides what a listing says about itself: name,
 * icon, banner and member counts all come from here, never from the submitted
 * form, so a listing cannot claim to be a server it is not.
 */

const DISCORD_API_BASE = "https://discord.com/api/v10";
const REQUEST_TIMEOUT_MS = 10_000;

// Invite codes are alphanumeric; vanity codes also allow dashes. Length is
// bounded so a pasted essay never reaches Discord as a path segment.
const INVITE_CODE_PATTERN = /^[A-Za-z0-9-]{2,64}$/;

const INVITE_HOSTS = new Set([
  "discord.gg",
  "www.discord.gg",
  "discord.com",
  "www.discord.com",
  "discordapp.com",
  "www.discordapp.com",
  "ptb.discord.com",
  "canary.discord.com",
]);

export type InviteFailure =
  | "invalid_url"
  | "unknown_invite"
  | "guild_mismatch"
  | "lookup_failed";

export interface ResolvedInvite {
  code: string;
  guildId: string;
  name: string;
  iconHash: string | null;
  bannerHash: string | null;
  memberCount: number;
  onlineCount: number;
  // ISO instant when Discord will stop honoring this link, or null for a
  // permanent one. Reported rather than refused: an expiring invite is a worse
  // listing, not an invalid one, and the refresh sweep already takes a listing
  // off the directory once its link stops resolving.
  expiresAt: string | null;
  /*
   * What the server says about itself on Discord, and what Discord says about
   * it. All three are public on any invite link and none of them are editable
   * from the form, which is the point: the listing's page can show what the
   * server actually is rather than only what its poster typed.
   */
  description: string | null;
  boostCount: number;
  features: string[];
}

export type InviteResult =
  | { ok: true; invite: ResolvedInvite }
  | { ok: false; error: InviteFailure };

/**
 * Pulls the code out of anything someone might paste: a full invite URL on any
 * of Discord's hosts, or the bare code on its own. Returns null when the input
 * is not an invite at all, which the caller reports as invalid_url.
 */
export function parseInviteCode(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  // Bare code, the common case when someone copies out of a channel topic.
  if (INVITE_CODE_PATTERN.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (!INVITE_HOSTS.has(url.hostname.toLowerCase())) return null;

  // discord.gg/<code>, and discord.com/invite/<code>. Anything else on those
  // hosts (a channel link, a user profile) is not an invite.
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const code = segments.length === 1 && url.hostname.toLowerCase().endsWith("discord.gg")
    ? segments[0]
    : segments.length === 2 && segments[0] === "invite"
      ? segments[1]
      : null;
  if (code == null || !INVITE_CODE_PATTERN.test(code)) return null;
  return code;
}

interface DiscordInvitePayload {
  code?: string;
  expires_at?: string | null;
  approximate_member_count?: number;
  approximate_presence_count?: number;
  guild?: {
    id?: string;
    name?: string;
    icon?: string | null;
    banner?: string | null;
    description?: string | null;
    premium_subscription_count?: number;
    features?: unknown;
  };
}

/**
 * Resolves an invite against Discord.
 *
 * `expectedGuildId` is the guild the submitter proved they manage through OAuth.
 * An invite for any other server is refused, which is what stops someone from
 * proving they own a server they control and then listing a different one.
 */
export async function resolveDiscordInvite(
  rawInput: string,
  expectedGuildId?: string,
): Promise<InviteResult> {
  const code = parseInviteCode(rawInput);
  if (code == null) return { ok: false, error: "invalid_url" };

  let payload: DiscordInvitePayload | null;
  try {
    payload = await fetchInvite(code);
  } catch (error) {
    logWarn("community_invite_lookup_failed", {
      code,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: "lookup_failed" };
  }
  if (payload == null) return { ok: false, error: "unknown_invite" };

  const guildId = payload.guild?.id;
  const name = payload.guild?.name;
  // Group DM invites carry no guild at all.
  if (typeof guildId !== "string" || guildId === "" || typeof name !== "string" || name === "") {
    return { ok: false, error: "unknown_invite" };
  }
  if (expectedGuildId != null && guildId !== expectedGuildId) {
    return { ok: false, error: "guild_mismatch" };
  }

  return {
    ok: true,
    invite: {
      code,
      guildId,
      name,
      iconHash: typeof payload.guild?.icon === "string" ? payload.guild.icon : null,
      bannerHash: typeof payload.guild?.banner === "string" ? payload.guild.banner : null,
      memberCount: countOf(payload.approximate_member_count),
      onlineCount: countOf(payload.approximate_presence_count),
      expiresAt: typeof payload.expires_at === "string" ? payload.expires_at : null,
      description: cleanDescription(payload.guild?.description),
      boostCount: countOf(payload.guild?.premium_subscription_count),
      features: cleanFeatures(payload.guild?.features),
    },
  };
}

// Discord's own field, so it arrives as whatever someone typed into a settings
// box: bounded, flattened of control characters, and stored as plain text like
// the pitch beside it.
function cleanDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  return text === "" ? null : text;
}

// Flags like PARTNERED or COMMUNITY. Kept to the shape Discord documents rather
// than to a list of known names, so a feature added next year still arrives;
// the page decides which of them are worth a badge.
function cleanFeatures(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && /^[A-Z0-9_]{1,48}$/.test(entry))
    .slice(0, 40);
}

/**
 * The invite a server publishes through its own widget, if it has one.
 *
 * There is no way for an OAuth app to make an invite: creating one is a bot
 * action inside the server, and `identify` + `guilds` grants nothing of the
 * kind. The widget is the one exception, because a server that turns it on is
 * publishing a permanent invite to the whole internet at an unauthenticated
 * URL - which is exactly the invite someone posting here would paste anyway.
 *
 * Returns null whenever that is not the case (widget off, no invite channel
 * set, Discord unhappy), and the form falls back to asking for one. Nothing
 * here is trusted: the code it finds goes through resolveDiscordInvite like any
 * other, so one for a different guild is still refused.
 */
export async function fetchWidgetInviteCode(guildId: string): Promise<string | null> {
  // Bounded and encoded rather than matched against Discord's snowflake format:
  // the point is that nothing pasted can reshape the URL, not that this module
  // has an opinion about how Discord numbers its servers.
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(guildId)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${DISCORD_API_BASE}/guilds/${encodeURIComponent(guildId)}/widget.json`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    // 403 is the ordinary answer for a server with the widget switched off.
    if (!response.ok) return null;
    const payload = (await response.json()) as { instant_invite?: string | null };
    if (typeof payload.instant_invite !== "string" || payload.instant_invite === "") return null;
    return parseInviteCode(payload.instant_invite);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function countOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Returns null for a 404 (the invite is gone); throws for anything else. */
async function fetchInvite(code: string): Promise<DiscordInvitePayload | null> {
  const path = `/invites/${encodeURIComponent(code)}?with_counts=true&with_expiration=true`;
  // One retry on 429 honoring Discord's retry_after, matching rest.ts. The
  // endpoint is unauthenticated, so the bucket is per-IP and shared with the
  // refresh sweep; a burst there must not be reported to a user as a dead server.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${DISCORD_API_BASE}${path}`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 429 && attempt === 0) {
      const retryAfterMs = await readRetryAfterMs(response);
      logWarn("community_invite_rate_limited", { retryAfterMs });
      await delay(retryAfterMs);
      continue;
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Discord invite lookup returned ${response.status}`);
    }
    return (await response.json()) as DiscordInvitePayload;
  }
  throw new Error("Discord invite lookup rate limit retry exhausted.");
}

async function readRetryAfterMs(response: Response): Promise<number> {
  const header = response.headers.get("retry-after");
  const headerMs = header ? Number(header) * 1000 : NaN;
  if (Number.isFinite(headerMs) && headerMs > 0) return Math.min(headerMs, 10_000);
  try {
    const body = (await response.clone().json()) as { retry_after?: number };
    if (typeof body.retry_after === "number") return Math.min(body.retry_after * 1000, 10_000);
  } catch {
    // fall through to the default
  }
  return 1_000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
