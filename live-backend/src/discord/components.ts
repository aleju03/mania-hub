import type { DiscordComponent, DiscordEmbedField, DiscordMessageBody } from "./rest.js";
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
const BUTTON_PRIMARY = 1;
const BUTTON_SECONDARY = 2;
const BUTTON_LINK = 5;
const TEXT_INPUT = 4;
const TEXT_INPUT_SHORT = 1;
const SECTION = 9;
const TEXT_DISPLAY = 10;
const THUMBNAIL = 11;
const MEDIA_GALLERY = 12;
const SEPARATOR = 14;
const CONTAINER = 17;

// Separator spacing: 1 = small, 2 = large.
const SEPARATOR_SPACING_SMALL = 1;

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
export const COMPONENT_COMMANDS = new Set(["rankings", "top", "tracker", "maps", "recent", "player", "randomfarm", "randomfav"]);

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

// Like refreshRow, but worded for a random picker: re-running the handler draws
// a fresh map, so "refresh" reads as "reroll". The encoded filters carry over so
// a reroll stays within the same scope and constraints.
export function rerollRow(cmd: string, params: Record<string, string>): DiscordComponent {
  return { type: ACTION_ROW, components: [button("Reroll", encodeComponentId(cmd, "r", 1, params), false)] };
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

// --- Stateless button actions (open a modal / swap the help view) ----------
// Some buttons do something other than re-run a slash command. They share the
// "mh|" prefix but put an "x" (action) marker in the command slot, which
// decodeComponentId rejects (x is not a COMPONENT_COMMAND), so the rerun and
// action schemes never collide.
const COMPONENT_BUTTON = 2;
const ACTION_MARKER = "x";
export const LINK_MODAL_ID = `${COMPONENT_PREFIX}|${ACTION_MARKER}|linksubmit`;
export const LINK_MODAL_FIELD = "username";

export type DecodedAction = { kind: "link" } | { kind: "help"; category: string };

export interface DiscordModalData {
  custom_id: string;
  title: string;
  components: Array<{ type: number; components: Array<Record<string, unknown>> }>;
}

export function decodeActionId(customId: string | undefined): DecodedAction | null {
  if (!customId || !customId.startsWith(`${COMPONENT_PREFIX}|${ACTION_MARKER}|`)) return null;
  const parts = customId.split("|");
  if (parts[2] === "link") return { kind: "link" };
  if (parts[2] === "help") return { kind: "help", category: parts[3] || "start" };
  return null;
}

// A primary button that opens the "link your account" modal. Used on the help
// hub and on "no account linked" notices so setup is one click, not a typed
// command with an argument.
export function linkButton(label = "Link your osu! account"): DiscordComponent {
  return { type: COMPONENT_BUTTON, style: BUTTON_PRIMARY, label, custom_id: `${COMPONENT_PREFIX}|${ACTION_MARKER}|link` };
}

export function linkAccountRow(label?: string): DiscordComponent {
  return { type: ACTION_ROW, components: [linkButton(label)] };
}

// Row of help-category buttons; the active category renders disabled so it reads
// as "you are here".
export function helpNavRow(active: string, categories: Array<{ id: string; label: string }>): DiscordComponent {
  return {
    type: ACTION_ROW,
    components: categories.slice(0, 5).map((cat) => ({
      type: COMPONENT_BUTTON,
      style: BUTTON_SECONDARY,
      label: cat.label,
      custom_id: `${COMPONENT_PREFIX}|${ACTION_MARKER}|help|${cat.id}`,
      disabled: cat.id === active,
    })),
  };
}

// A link-style button that opens a URL (e.g. "Add to Discord" / site links).
export function urlButton(label: string, url: string): DiscordComponent {
  return { type: COMPONENT_BUTTON, style: BUTTON_LINK, label, url };
}

// The modal Discord pops when the link button is clicked.
export function linkModal(): DiscordModalData {
  return {
    custom_id: LINK_MODAL_ID,
    title: "Link your osu! account",
    components: [
      {
        type: ACTION_ROW,
        components: [
          {
            type: TEXT_INPUT,
            custom_id: LINK_MODAL_FIELD,
            style: TEXT_INPUT_SHORT,
            label: "osu! username or id",
            min_length: 1,
            max_length: 64,
            required: true,
            placeholder: "e.g. mrekk",
          },
        ],
      },
    ],
  };
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

// Discord renders <t:unix:R> as a live, locale-aware relative time ("2 minutes
// ago"), which beats a frozen UTC string and updates client-side as time passes.
function formatTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return `<t:${Math.floor(time / 1000)}:R>`;
}

// Collapses a field cell to one clean line: no newlines (which would break the
// paired layout) and no backticks (they'd start a code span mid-line).
function cellText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replaceAll("`", "'").trim();
}

// Renders embed fields for V2. Components V2 has no inline-field column grid, so
// a run of consecutive inline fields becomes owo-style markdown stat lines, two
// `**Label:** value` pairs per line. A non-inline field flushes the run and
// renders as its own labelled markdown block so longer prose values keep their
// formatting.
function renderFields(fields: DiscordEmbedField[]): string {
  const blocks: string[] = [];
  let run: DiscordEmbedField[] = [];
  const flush = (): void => {
    if (!run.length) return;
    const pairs = run.map((field) => `**${cellText(field.name)}:** ${cellText(field.value)}`);
    const lines: string[] = [];
    for (let i = 0; i < pairs.length; i += 2) lines.push(pairs.slice(i, i + 2).join(" • "));
    blocks.push(lines.join("\n"));
    run = [];
  };
  for (const field of fields) {
    if (field.inline) {
      run.push(field);
    } else {
      flush();
      blocks.push(`**${field.name}**\n${field.value}`);
    }
  }
  flush();
  return blocks.join("\n");
}

function separator(): DiscordComponent {
  return { type: SEPARATOR, divider: true, spacing: SEPARATOR_SPACING_SMALL };
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
  if (embed.fields?.length) blocks.push(renderFields(embed.fields));
  const footer = [embed.footer?.text, formatTimestamp(embed.timestamp)].filter(Boolean).join(" • ");
  if (footer) blocks.push(`-# ${footer}`);
  return blocks.join("\n\n");
}

function embedContainer(embed: NonNullable<DiscordMessageBody["embeds"]>[number], budget: TextBudget): DiscordComponent | null {
  const components: DiscordComponent[] = [];
  const text = takeText(embedText(embed), budget);
  // Prefer an explicit thumbnail; fall back to the author avatar so player-keyed
  // cards (top play, snipe) still show a face on the right, which the classic
  // embed showed via author.icon_url.
  const accessoryUrl = embed.thumbnail?.url ?? embed.author?.icon_url;
  if (text) components.push(textSection(text, accessoryUrl));
  if (embed.image?.url) {
    // A divider between the text block and the banner image gives the card the
    // breathing room embeds got for free; skip it when there is no text above.
    if (components.length) components.push(separator());
    components.push(mediaGallery(embed.image.url, embed.title));
  }
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
