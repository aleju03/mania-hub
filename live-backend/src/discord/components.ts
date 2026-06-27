import type { DiscordComponent, DiscordMessageBody } from "./rest.js";
import type { DiscordInteraction, InteractionOption } from "./commands.js";

// Stateless message-component support. This bot keeps no per-message state, so a
// button's entire meaning lives in its custom_id: the command to re-run, the
// action, the target page, and the command's parameters. When a button is
// clicked we decode that, rebuild a synthetic command interaction, and run the
// exact same handler that produced the original message. Buttons therefore never
// diverge from the slash command, and nothing expires on a restart.

export const COMPONENT_PREFIX = "mh";
// Discord caps a custom_id at 100 characters.
const MAX_CUSTOM_ID = 100;

const OPT_STRING = 3;
const OPT_INTEGER = 4;
const ACTION_ROW = 1;
const BUTTON_SECONDARY = 2;
const SECTION = 9;
const TEXT_DISPLAY = 10;
const THUMBNAIL = 11;
const MEDIA_GALLERY = 12;
const CONTAINER = 17;

export const FLAG_IS_COMPONENTS_V2 = 1 << 15;

const MAX_V2_TEXT_CHARS = 3900;
const MAX_V2_COMPONENTS = 40;

export type ComponentAction = "p" | "r"; // page / refresh

export interface DecodedComponentId {
  cmd: string;
  action: ComponentAction;
  page: number;
  params: Record<string, string>;
}

// Commands whose handlers are safe to re-run from a component click. Anything
// else decodes to null and gets an "expired" notice instead of executing.
export const COMPONENT_COMMANDS = new Set(["rankings", "top", "tracker", "maps", "recent", "player"]);

export function encodeComponentId(cmd: string, action: ComponentAction, page: number, params: Record<string, string>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") qs.set(key, String(value));
  }
  const id = `${COMPONENT_PREFIX}|${cmd}|${action}|${Math.max(1, Math.floor(page) || 1)}|${qs.toString()}`;
  // In practice ids stay well under the cap (short codes + a <=15 char username);
  // the guard only exists so a pathological value degrades instead of 400-ing.
  return id.length <= MAX_CUSTOM_ID ? id : id.slice(0, MAX_CUSTOM_ID);
}

export function decodeComponentId(customId: string | undefined): DecodedComponentId | null {
  if (!customId || !customId.startsWith(`${COMPONENT_PREFIX}|`)) return null;
  const parts = customId.split("|");
  if (parts.length < 5) return null;
  const cmd = parts[1];
  const action: ComponentAction = parts[2] === "r" ? "r" : "p";
  const page = Math.max(1, Math.floor(Number(parts[3])) || 1);
  if (!cmd || !COMPONENT_COMMANDS.has(cmd)) return null;
  const params: Record<string, string> = {};
  try {
    // The querystring never contains "|", but rejoin defensively in case a value
    // ever did slip one in.
    const qs = new URLSearchParams(parts.slice(4).join("|"));
    for (const [key, value] of qs.entries()) params[key] = value;
  } catch {
    return null;
  }
  return { cmd, action, page, params };
}

function button(label: string, customId: string, disabled: boolean): DiscordComponent {
  return { type: BUTTON_SECONDARY, style: BUTTON_SECONDARY, label, custom_id: customId, disabled };
}

// Prev / Next / Refresh. Disabled buttons still need a unique custom_id, so the
// page clamp is fine only because the action segment ("p" vs "r") keeps the
// refresh id distinct from a clamped prev id at page 1.
export function paginationRow(
  cmd: string,
  page: number,
  hasNext: boolean,
  params: Record<string, string>,
): DiscordComponent {
  return {
    type: ACTION_ROW,
    components: [
      button("Prev", encodeComponentId(cmd, "p", page - 1, params), page <= 1),
      button("Next", encodeComponentId(cmd, "p", page + 1, params), !hasNext),
      button("Refresh", encodeComponentId(cmd, "r", page, params), false),
    ],
  };
}

export function refreshRow(cmd: string, params: Record<string, string>): DiscordComponent {
  return { type: ACTION_ROW, components: [button("Refresh", encodeComponentId(cmd, "r", 1, params), false)] };
}

// Puts the nav row above the body's existing link-button row, keeping within
// Discord's 5-action-row ceiling.
export function withNavRow(body: DiscordMessageBody, navRow: DiscordComponent): DiscordMessageBody {
  const rows = body.components ?? [];
  return { ...body, components: [navRow, ...rows].slice(0, 5) };
}

// Rebuilds an application-command interaction from a decoded button so the
// normal command handlers can run unchanged. The clicker's identity, guild and
// channel context carry over from the component interaction.
export function componentToCommandInteraction(
  interaction: DiscordInteraction,
  decoded: DecodedComponentId,
): DiscordInteraction {
  const options: InteractionOption[] = Object.entries(decoded.params).map(([name, value]) => ({
    name,
    type: OPT_STRING,
    value,
  }));
  options.push({ name: "page", type: OPT_INTEGER, value: decoded.page });
  return { ...interaction, type: 2, data: { name: decoded.cmd, options } };
}

interface TextBudget {
  remaining: number;
}

function takeText(raw: string | null | undefined, budget: TextBudget): string | null {
  const text = (raw ?? "").trim();
  if (!text || budget.remaining <= 0) return null;
  if (text.length <= budget.remaining) {
    budget.remaining -= text.length;
    return text;
  }
  const room = Math.max(0, budget.remaining - 3);
  budget.remaining = 0;
  return `${text.slice(0, room).trimEnd()}...`;
}

function escapeLinkLabel(text: string): string {
  return text.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function linkedText(text: string, url: string | undefined): string {
  return url ? `[${escapeLinkLabel(text)}](${url})` : text;
}

function textDisplay(content: string): DiscordComponent {
  return { type: TEXT_DISPLAY, content };
}

function thumbnail(url: string): DiscordComponent {
  return { type: THUMBNAIL, media: { url } };
}

function mediaGallery(url: string, description: string | undefined): DiscordComponent {
  return {
    type: MEDIA_GALLERY,
    items: [{ media: { url }, description: description ? description.slice(0, 1024) : undefined }],
  };
}

function textSection(content: string, accessoryUrl: string | undefined): DiscordComponent {
  if (!accessoryUrl) return textDisplay(content);
  return {
    type: SECTION,
    components: [textDisplay(content)],
    accessory: thumbnail(accessoryUrl),
  };
}

function formatTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().replace("T", " ").slice(0, 16);
}

function embedText(embed: NonNullable<DiscordMessageBody["embeds"]>[number]): string {
  const blocks: string[] = [];
  if (embed.author?.name) {
    blocks.push(`### ${linkedText(embed.author.name, embed.author.url)}`);
  }
  if (embed.title) {
    blocks.push(`## ${linkedText(embed.title, embed.url)}`);
  } else if (embed.url) {
    blocks.push(embed.url);
  }
  if (embed.description) blocks.push(embed.description);
  if (embed.fields?.length) {
    blocks.push(embed.fields.map((field) => {
      const name = `**${field.name}**`;
      return field.inline ? `${name}: ${field.value}` : `${name}\n${field.value}`;
    }).join("\n"));
  }
  const footer = [embed.footer?.text, formatTimestamp(embed.timestamp)].filter(Boolean).join(" • ");
  if (footer) blocks.push(`-# ${footer}`);
  return blocks.join("\n\n");
}

function embedContainer(embed: NonNullable<DiscordMessageBody["embeds"]>[number], budget: TextBudget): DiscordComponent | null {
  const components: DiscordComponent[] = [];
  const text = takeText(embedText(embed), budget);
  if (text) components.push(textSection(text, embed.thumbnail?.url));
  if (embed.image?.url) components.push(mediaGallery(embed.image.url, embed.title));
  if (components.length === 0) return null;
  return {
    type: CONTAINER,
    accent_color: embed.color,
    components,
  };
}

function componentCount(component: DiscordComponent): number {
  let count = 1;
  for (const child of component.components ?? []) count += componentCount(child);
  if (component.accessory) count += componentCount(component.accessory);
  for (const item of component.items ?? []) {
    if (item.media.url) count += 1;
  }
  return count;
}

function appendComponent(
  target: DiscordComponent[],
  component: DiscordComponent | null,
  used: { count: number },
): void {
  if (!component) return;
  const next = componentCount(component);
  if (used.count + next > MAX_V2_COMPONENTS) return;
  target.push(component);
  used.count += next;
}

export function toComponentsV2Body(
  body: DiscordMessageBody,
  options: { clearLegacy?: boolean } = {},
): DiscordMessageBody {
  if ((body.flags ?? 0) & FLAG_IS_COMPONENTS_V2) {
    return options.clearLegacy
      ? { ...body, content: null, embeds: null, flags: (body.flags ?? 0) | FLAG_IS_COMPONENTS_V2 }
      : body;
  }

  const budget = { remaining: MAX_V2_TEXT_CHARS };
  const used = { count: 0 };
  const components: DiscordComponent[] = [];
  const content = takeText(body.content, budget);
  appendComponent(components, content ? textDisplay(content) : null, used);
  for (const embed of body.embeds ?? []) appendComponent(components, embedContainer(embed, budget), used);
  for (const row of body.components ?? []) appendComponent(components, row, used);
  if (components.length === 0) appendComponent(components, textDisplay("."), used);

  const next: DiscordMessageBody = {
    flags: (body.flags ?? 0) | FLAG_IS_COMPONENTS_V2,
    components,
    allowed_mentions: body.allowed_mentions,
  };
  if (options.clearLegacy) {
    next.content = null;
    next.embeds = null;
  }
  return next;
}
