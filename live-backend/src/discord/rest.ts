import { logWarn } from "../logger.js";
import { toComponentsV2Body } from "./components.js";

// Pinned API version. v10 is current and stable for interactions.
const DISCORD_API_BASE = "https://discord.com/api/v10";
const REQUEST_TIMEOUT_MS = 10_000;

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  fields?: DiscordEmbedField[];
  author?: { name: string; url?: string; icon_url?: string };
  thumbnail?: { url: string };
  image?: { url: string };
  footer?: { text: string; icon_url?: string };
}

// A subset of message-component types (links + buttons) used by our embeds.
export interface DiscordComponent {
  type: number;
  components?: DiscordComponent[];
  style?: number;
  label?: string;
  url?: string;
  custom_id?: string;
  disabled?: boolean;
  emoji?: { name: string };
  content?: string;
  accent_color?: number;
  media?: { url: string };
  description?: string;
  items?: Array<{ media: { url: string }; description?: string; spoiler?: boolean }>;
  accessory?: DiscordComponent;
  spoiler?: boolean;
  // Separator (type 14): draws an optional divider line with small/large spacing.
  divider?: boolean;
  spacing?: number;
}

export interface DiscordMessageBody {
  content?: string | null;
  embeds?: DiscordEmbed[] | null;
  components?: DiscordComponent[];
  // Bitfield; 1<<6 = EPHEMERAL (only valid on interaction responses).
  flags?: number;
  allowed_mentions?: { parse: string[] };
}

export interface DiscordCommandDefinition {
  name: string;
  description: string;
  type?: number;
  options?: unknown[];
  // Install/context controls for the new app installation model.
  integration_types?: number[];
  contexts?: number[];
  dm_permission?: boolean;
  // Stringified permission bitfield; surfaces the gate in Server Settings.
  default_member_permissions?: string;
}

export class DiscordRestError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message?: string,
  ) {
    super(message ?? `Discord API ${status}: ${body.slice(0, 300)}`);
    this.name = "DiscordRestError";
  }
}

interface RequestOptions {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  // "bot" attaches the bot token; "none" relies on the path's interaction token.
  auth: "bot" | "none";
}

export class DiscordRest {
  constructor(
    private readonly applicationId: string,
    private readonly botToken: string | undefined,
  ) {}

  hasBotToken(): boolean {
    return Boolean(this.botToken);
  }

  private async request<T = unknown>(options: RequestOptions): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.auth === "bot") {
      if (!this.botToken) {
        throw new DiscordRestError(0, "", "DISCORD_BOT_TOKEN is not configured.");
      }
      headers.authorization = `Bot ${this.botToken}`;
    }
    const url = `${DISCORD_API_BASE}${options.path}`;
    const init: RequestInit = {
      method: options.method,
      headers,
      body: options.body == null ? undefined : JSON.stringify(options.body),
    };

    // One retry on 429, honoring Discord's retry_after, so a momentary bucket
    // exhaustion (e.g. a burst of feed posts) does not drop the message.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(url, { ...init, signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (response.status === 429 && attempt === 0) {
        const retryAfterMs = await readRetryAfterMs(response);
        logWarn("discord_rate_limited", { path: options.path, retryAfterMs });
        await delay(retryAfterMs);
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        throw new DiscordRestError(response.status, text);
      }
      return (text ? JSON.parse(text) : undefined) as T;
    }
    // Unreachable in practice (the loop returns or throws), but satisfies types.
    throw new DiscordRestError(429, "", "Discord API rate limit retry exhausted.");
  }

  /** Bulk-overwrites all GLOBAL application commands (idempotent). */
  bulkOverwriteGlobalCommands(commands: DiscordCommandDefinition[]): Promise<unknown[]> {
    return this.request({
      method: "PUT",
      path: `/applications/${this.applicationId}/commands`,
      body: commands,
      auth: "bot",
    });
  }

  listGlobalCommands(): Promise<unknown[]> {
    return this.request({
      method: "GET",
      path: `/applications/${this.applicationId}/commands`,
      auth: "bot",
    });
  }

  /** Bulk-overwrites a single guild's commands (propagates instantly; used for dev). */
  bulkOverwriteGuildCommands(guildId: string, commands: DiscordCommandDefinition[]): Promise<unknown[]> {
    return this.request({
      method: "PUT",
      path: `/applications/${this.applicationId}/guilds/${guildId}/commands`,
      body: commands,
      auth: "bot",
    });
  }

  /** Edits the original (deferred) interaction response via the interaction token. */
  editOriginalInteractionResponse(token: string, body: DiscordMessageBody): Promise<unknown> {
    return this.request({
      method: "PATCH",
      path: `/webhooks/${this.applicationId}/${token}/messages/@original?with_components=true`,
      body: prepareMessageBody(body, true),
      auth: "none",
    });
  }

  /** Sends an additional follow-up message on an interaction. */
  createFollowupMessage(token: string, body: DiscordMessageBody): Promise<unknown> {
    return this.request({
      method: "POST",
      path: `/webhooks/${this.applicationId}/${token}?with_components=true`,
      body: prepareMessageBody(body, false),
      auth: "none",
    });
  }

  /** Posts a message to a channel (used by live feeds); needs the bot token + send perms. */
  createChannelMessage(channelId: string, body: DiscordMessageBody): Promise<unknown> {
    return this.request({
      method: "POST",
      path: `/channels/${channelId}/messages`,
      body: prepareMessageBody(body, false),
      auth: "bot",
    });
  }

  /** Fetches the bot application (used to validate the token from the admin page). */
  getApplication(): Promise<{ id: string; name: string; bot?: { username?: string } }> {
    return this.request({ method: "GET", path: "/applications/@me", auth: "bot" });
  }

  /**
   * Lists the guilds the bot is a member of (i.e. which servers added it).
   * `with_counts` adds approximate member counts; one page of 200 is plenty for
   * a bot this size. Needs the bot token.
   */
  listGuilds(): Promise<Array<{ id: string; name?: string; icon?: string | null; approximate_member_count?: number }>> {
    return this.request({ method: "GET", path: "/users/@me/guilds?with_counts=true&limit=200", auth: "bot" });
  }
}

// Defense-in-depth: every message the bot sends suppresses mention parsing by
// default, so attacker-controlled text echoed into `content` (e.g. a bad
// username in an error reply) can never make the bot ping users or roles.
// A caller can still opt into specific mentions by setting allowed_mentions.
function withSafeMentions(body: DiscordMessageBody): DiscordMessageBody {
  if (body.allowed_mentions) return body;
  return { ...body, allowed_mentions: { parse: [] } };
}

function prepareMessageBody(body: DiscordMessageBody, clearLegacy: boolean): DiscordMessageBody {
  return withSafeMentions(toComponentsV2Body(body, { clearLegacy }));
}

async function readRetryAfterMs(response: Response): Promise<number> {
  const header = response.headers.get("retry-after");
  const headerMs = header ? Number(header) * 1000 : NaN;
  if (Number.isFinite(headerMs) && headerMs > 0) return Math.min(headerMs, 10_000);
  try {
    const body = (await response.clone().json()) as { retry_after?: number };
    if (typeof body.retry_after === "number") return Math.min(body.retry_after * 1000, 10_000);
  } catch {
    // fall through to default
  }
  return 1_000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
