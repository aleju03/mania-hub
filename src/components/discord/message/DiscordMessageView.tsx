import type { CSSProperties, ReactNode } from "react";
import { DISCORD, DiscordMarkdown, emojiUrl } from "./discord-markdown";

// Renders a bot message body the way the Discord client lays it out. Covers the
// Components V2 set the bot sends (container, section, text display,
// thumbnail, media gallery, separator, action rows and buttons) plus classic
// content/embeds in case a body skips the V2 conversion.

export interface DiscordComponentJson {
  type: number;
  components?: DiscordComponentJson[];
  style?: number;
  label?: string;
  url?: string;
  custom_id?: string;
  disabled?: boolean;
  emoji?: { name?: string; id?: string; animated?: boolean };
  content?: string;
  accent_color?: number | null;
  media?: { url: string };
  description?: string;
  items?: Array<{ media: { url: string }; description?: string; spoiler?: boolean }>;
  accessory?: DiscordComponentJson;
  spoiler?: boolean;
  divider?: boolean;
  spacing?: number;
  placeholder?: string;
  options?: Array<{ label: string; value: string; description?: string; default?: boolean }>;
}

export interface DiscordEmbedJson {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  author?: { name: string; url?: string; icon_url?: string };
  thumbnail?: { url: string };
  image?: { url: string };
  footer?: { text: string };
}

export interface DiscordMessageJson {
  content?: string | null;
  embeds?: DiscordEmbedJson[] | null;
  components?: DiscordComponentJson[];
  flags?: number;
}

export const FLAG_EPHEMERAL = 1 << 6;
export const FLAG_COMPONENTS_V2 = 1 << 15;

export const COMPONENT_NAMES: Record<number, string> = {
  1: "Action row", 2: "Button", 3: "String select", 4: "Text input", 5: "User select", 6: "Role select",
  7: "Mentionable select", 8: "Channel select", 9: "Section", 10: "Text display", 11: "Thumbnail",
  12: "Media gallery", 13: "File", 14: "Separator", 17: "Container",
};

function hexColor(value: number | null | undefined): string | null {
  if (value == null) return null;
  return `#${value.toString(16).padStart(6, "0")}`;
}

const BUTTON_STYLES: Record<number, CSSProperties> = {
  1: { backgroundColor: DISCORD.blurple, color: "#fff" },
  2: { backgroundColor: "#4e5058", color: "#fff" },
  3: { backgroundColor: "#248046", color: "#fff" },
  4: { backgroundColor: "#da373c", color: "#fff" },
  5: { backgroundColor: "#4e5058", color: "#fff" },
};

function ExternalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden className="ml-1 shrink-0">
      <path fill="currentColor" d="M15 2a1 1 0 0 0 0 2h3.59l-7.3 7.3a1 1 0 0 0 1.42 1.4L20 5.42V9a1 1 0 1 0 2 0V3a1 1 0 0 0-1-1h-6Z" />
      <path fill="currentColor" d="M5 4a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3v-6a1 1 0 1 0-2 0v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6a1 1 0 1 0 0-2H5Z" />
    </svg>
  );
}

function ButtonEmoji({ emoji }: { emoji: NonNullable<DiscordComponentJson["emoji"]> }) {
  if (emoji.id) {
    return <img src={emojiUrl(emoji.id, Boolean(emoji.animated))} alt="" className="mr-1 h-[22px] w-[22px] object-contain" />;
  }
  return <span className="mr-1 text-[18px] leading-none">{emoji.name}</span>;
}

export interface MessageViewHandlers {
  onButton?: (component: DiscordComponentJson) => void;
  busyCustomId?: string | null;
}

function DiscordButton({ component, handlers }: { component: DiscordComponentJson; handlers: MessageViewHandlers }) {
  const style = BUTTON_STYLES[component.style ?? 2] ?? BUTTON_STYLES[2];
  const busy = Boolean(component.custom_id && handlers.busyCustomId === component.custom_id);
  const className = "inline-flex h-8 min-w-[60px] items-center justify-center rounded-lg px-4 text-[14px] font-medium transition-[filter] select-none";
  const inner = (
    <>
      {component.emoji ? <ButtonEmoji emoji={component.emoji} /> : null}
      {component.label ? <span className="truncate">{component.label}</span> : null}
      {component.style === 5 ? <ExternalIcon /> : null}
    </>
  );
  if (component.style === 5 && component.url) {
    return (
      <a href={component.url} target="_blank" rel="noreferrer" title={component.url}
        className={`${className} hover:brightness-110 ${component.disabled ? "pointer-events-none opacity-50" : ""}`} style={style}>
        {inner}
      </a>
    );
  }
  // Without a click handler (a static preview) the button is only a picture.
  if (!handlers.onButton) {
    return (
      <span className={`${className} cursor-default ${component.disabled ? "opacity-50" : ""}`} style={style}>
        {inner}
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={component.disabled || busy}
      title={component.custom_id}
      onClick={() => handlers.onButton?.(component)}
      className={`${className} enabled:hover:brightness-110 disabled:cursor-not-allowed ${component.disabled ? "opacity-50" : ""} ${busy ? "animate-pulse" : ""}`}
      style={style}
    >
      {inner}
    </button>
  );
}

function Thumbnail({ url, description }: { url: string; description?: string }) {
  return <img src={url} alt={description ?? ""} className="h-[85px] w-[85px] shrink-0 rounded-lg object-cover" loading="lazy" />;
}

function MediaGallery({ items }: { items: NonNullable<DiscordComponentJson["items"]> }) {
  if (items.length === 1) {
    return <img src={items[0].media.url} alt={items[0].description ?? ""} title={items[0].description} className="block h-auto max-h-[350px] w-auto max-w-full rounded-lg object-contain" loading="lazy" />;
  }
  return (
    <div className="grid grid-cols-2 gap-1">
      {items.map((item, index) => (
        <img key={index} src={item.media.url} alt={item.description ?? ""} className="aspect-square w-full rounded-lg object-cover" loading="lazy" />
      ))}
    </div>
  );
}

// A closed menu showing its current pick. Only a picture: a preview opens no menu.
function StringSelect({ component }: { component: DiscordComponentJson }) {
  const picked = component.options?.find((option) => option.default);
  return (
    <div
      className="flex h-10 w-full max-w-[400px] items-center justify-between rounded-lg px-3 text-[14px] select-none"
      style={{ backgroundColor: DISCORD.deep, border: `1px solid ${DISCORD.divider}`, color: picked ? DISCORD.text : DISCORD.muted }}
    >
      <span className="truncate">{picked?.label ?? component.placeholder ?? "Make a selection"}</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  );
}

function UnknownComponent({ component }: { component: DiscordComponentJson }) {
  return (
    <div className="rounded-lg px-3 py-2 text-[13px]" style={{ backgroundColor: DISCORD.deep, color: DISCORD.muted }}>
      {COMPONENT_NAMES[component.type] ?? `Component type ${component.type}`}{component.placeholder ? `: ${component.placeholder}` : ""}
    </div>
  );
}

function Component({ component, handlers }: { component: DiscordComponentJson; handlers: MessageViewHandlers }): ReactNode {
  switch (component.type) {
    case 1:
      return (
        <div className="flex flex-wrap gap-2">
          {(component.components ?? []).map((child, index) => <Component key={index} component={child} handlers={handlers} />)}
        </div>
      );
    case 2:
      return <DiscordButton component={component} handlers={handlers} />;
    case 3:
      return <StringSelect component={component} />;
    case 9:
      return (
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {(component.components ?? []).map((child, index) => <Component key={index} component={child} handlers={handlers} />)}
          </div>
          {component.accessory ? <Component component={component.accessory} handlers={handlers} /> : null}
        </div>
      );
    case 10:
      return <DiscordMarkdown content={component.content ?? ""} />;
    case 11:
      return component.media?.url ? <Thumbnail url={component.media.url} description={component.description} /> : null;
    case 12:
      return <MediaGallery items={component.items ?? []} />;
    case 14:
      return (
        <div className={component.spacing === 2 ? "py-2" : "py-0.5"}>
          {component.divider !== false ? <div className="h-px w-full" style={{ backgroundColor: "rgba(255,255,255,0.08)" }} /> : null}
        </div>
      );
    case 17: {
      const accent = hexColor(component.accent_color);
      return (
        <div className="flex max-w-[600px] overflow-hidden rounded-lg" style={{ backgroundColor: DISCORD.embed, border: "1px solid rgba(255,255,255,0.06)" }}>
          {accent ? <div className="w-1 shrink-0" style={{ backgroundColor: accent }} /> : null}
          <div className="flex min-w-0 flex-1 flex-col gap-2 p-4">
            {(component.components ?? []).map((child, index) => <Component key={index} component={child} handlers={handlers} />)}
          </div>
        </div>
      );
    }
    default:
      return <UnknownComponent component={component} />;
  }
}

function ClassicEmbed({ embed }: { embed: DiscordEmbedJson }) {
  const accent = hexColor(embed.color) ?? "#1e1f22";
  return (
    <div className="grid max-w-[516px] rounded" style={{ backgroundColor: DISCORD.embed, borderLeft: `4px solid ${accent}` }}>
      <div className="flex gap-4 px-4 pb-4 pt-2">
        <div className="min-w-0 flex-1 space-y-2">
          {embed.author ? (
            <div className="flex items-center gap-2 text-[14px] font-semibold" style={{ color: DISCORD.white }}>
              {embed.author.icon_url ? <img src={embed.author.icon_url} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" /> : null}
              <span>{embed.author.name}</span>
            </div>
          ) : null}
          {embed.title ? <div className="font-semibold" style={{ color: embed.url ? DISCORD.link : DISCORD.white }}>{embed.title}</div> : null}
          {embed.description ? <DiscordMarkdown content={embed.description} /> : null}
          {embed.fields?.map((field, index) => (
            <div key={index}>
              <div className="text-[14px] font-semibold" style={{ color: DISCORD.white }}>{field.name}</div>
              <DiscordMarkdown content={field.value} />
            </div>
          ))}
          {embed.image ? <img src={embed.image.url} alt="" className="max-h-[300px] rounded" /> : null}
          {embed.footer ? <div className="text-[12px]" style={{ color: DISCORD.muted }}>{embed.footer.text}</div> : null}
        </div>
        {embed.thumbnail ? <img src={embed.thumbnail.url} alt="" className="h-20 w-20 rounded object-cover" /> : null}
      </div>
    </div>
  );
}

export function DiscordMessageBodyView({ body, handlers = {} }: { body: DiscordMessageJson; handlers?: MessageViewHandlers }) {
  const v2 = ((body.flags ?? 0) & FLAG_COMPONENTS_V2) !== 0;
  return (
    <div className="flex flex-col gap-2" style={{ fontFamily: DISCORD.font }}>
      {!v2 && body.content ? <DiscordMarkdown content={body.content} /> : null}
      {!v2 ? body.embeds?.map((embed, index) => <ClassicEmbed key={index} embed={embed} />) : null}
      {(body.components ?? []).map((component, index) => <Component key={index} component={component} handlers={handlers} />)}
    </div>
  );
}

// --- Limits Discord enforces on send --------------------------------------
// The checks that turn into a 400 from Discord (and so a reply that never
// shows up), caught here before shipping.

export function lintDiscordMessage(body: DiscordMessageJson): string[] {
  const problems: string[] = [];
  if (((body.flags ?? 0) & FLAG_COMPONENTS_V2) === 0) return problems;
  if (body.content || body.embeds?.length) problems.push("Components V2 messages cannot carry content or embeds.");
  let count = 0;
  let textChars = 0;
  const customIds = new Map<string, number>();
  const walk = (component: DiscordComponentJson, parent: number | null) => {
    count += 1;
    if (component.type === 10) textChars += (component.content ?? "").length;
    if (component.type === 2) {
      if ((component.label ?? "").length > 80) problems.push(`Button label over 80 characters: "${component.label?.slice(0, 30)}..."`);
      if (component.style === 5) {
        if (!component.url) problems.push(`Link button "${component.label}" has no url.`);
        if (component.custom_id) problems.push(`Link button "${component.label}" cannot have a custom_id.`);
      } else if (!component.custom_id) {
        problems.push(`Button "${component.label}" has no custom_id.`);
      }
      if (!component.label && !component.emoji) problems.push("A button needs a label or an emoji.");
      if (parent !== 1 && parent !== 9) problems.push("A button must sit in an action row or a section accessory.");
    }
    if (component.custom_id) {
      if (component.custom_id.length > 100) problems.push(`custom_id over 100 characters: ${component.custom_id.slice(0, 40)}...`);
      customIds.set(component.custom_id, (customIds.get(component.custom_id) ?? 0) + 1);
    }
    if (component.type === 1) {
      const buttons = (component.components ?? []).filter((child) => child.type === 2).length;
      if (buttons > 5) problems.push(`An action row has ${buttons} buttons (max 5).`);
      if (!(component.components ?? []).length) problems.push("An action row is empty.");
    }
    if (component.type === 9) {
      const texts = component.components ?? [];
      if (texts.length < 1 || texts.length > 3) problems.push(`A section has ${texts.length} text displays (1 to 3).`);
      if (!component.accessory) problems.push("A section needs an accessory (thumbnail or button).");
    }
    if (component.type === 12) {
      const items = component.items ?? [];
      if (items.length < 1 || items.length > 10) problems.push(`A media gallery has ${items.length} items (1 to 10).`);
      for (const item of items) {
        if (!/^(https?|attachment):\/\//.test(item.media.url)) problems.push(`Gallery url is not http(s): ${item.media.url}`);
        if ((item.description ?? "").length > 1024) problems.push("A gallery description is over 1024 characters.");
      }
      count += items.length;
    }
    if (component.type === 11 && component.media && !/^(https?|attachment):\/\//.test(component.media.url)) {
      problems.push(`Thumbnail url is not http(s): ${component.media.url}`);
    }
    for (const child of component.components ?? []) walk(child, component.type);
    if (component.accessory) walk(component.accessory, component.type);
  };
  for (const component of body.components ?? []) walk(component, null);
  if (count > 40) problems.push(`${count} components in total (max 40).`);
  if (textChars > 4000) problems.push(`${textChars.toLocaleString("en-US")} characters of text (max 4,000).`);
  for (const [id, uses] of customIds) {
    if (uses > 1) problems.push(`custom_id used ${uses} times: ${id}`);
  }
  return problems;
}

export function messageStats(body: DiscordMessageJson): { components: number; textChars: number } {
  let components = 0;
  let textChars = 0;
  const walk = (component: DiscordComponentJson) => {
    components += 1 + (component.type === 12 ? (component.items ?? []).length : 0);
    if (component.type === 10) textChars += (component.content ?? "").length;
    for (const child of component.components ?? []) walk(child);
    if (component.accessory) walk(component.accessory);
  };
  for (const component of body.components ?? []) walk(component);
  return { components, textChars };
}
