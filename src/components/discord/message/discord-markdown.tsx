import { Fragment, type ReactNode } from "react";

// A close copy of the Discord client's message markdown, enough to preview
// what the bot posts: headings, subtext, quotes, lists, code, bold/italic/
// underline/strike/spoiler, masked links, custom emoji, timestamps and
// mentions. Rules and their order follow Discord's simple-markdown setup.

export const DISCORD = {
  msg: "#313338",
  hover: "#2e3035",
  embed: "#2b2d31",
  deep: "#1e1f22",
  text: "#dbdee1",
  muted: "#949ba4",
  link: "#00a8fc",
  white: "#f2f3f5",
  divider: "#3f4147",
  blurple: "#5865f2",
  font: '"gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif',
  mono: 'Consolas, "Andale Mono WT", "Andale Mono", "Lucida Console", Monaco, "Courier New", monospace',
};

type Inline = ReactNode;

interface InlineRule {
  re: RegExp;
  render: (m: RegExpExecArray, key: number) => Inline;
}

const DATE_LOCALE = "en-US";

function formatDiscordTimestamp(unix: number, style: string): string {
  const date = new Date(unix * 1000);
  if (!Number.isFinite(date.getTime())) return String(unix);
  switch (style) {
    case "t": return date.toLocaleTimeString(DATE_LOCALE, { hour: "numeric", minute: "2-digit" });
    case "T": return date.toLocaleTimeString(DATE_LOCALE, { hour: "numeric", minute: "2-digit", second: "2-digit" });
    case "d": return date.toLocaleDateString(DATE_LOCALE, { month: "2-digit", day: "2-digit", year: "numeric" });
    case "D": return date.toLocaleDateString(DATE_LOCALE, { month: "long", day: "numeric", year: "numeric" });
    case "F": return date.toLocaleString(DATE_LOCALE, { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    case "R": return relativeTime(date.getTime());
    default: return date.toLocaleString(DATE_LOCALE, { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }
}

const RELATIVE = new Intl.RelativeTimeFormat(DATE_LOCALE, { numeric: "always" });
const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

function relativeTime(ms: number): string {
  const diffSeconds = Math.round((ms - Date.now()) / 1000);
  for (const [unit, seconds] of RELATIVE_STEPS) {
    if (Math.abs(diffSeconds) >= seconds || unit === "second") {
      return RELATIVE.format(Math.round(diffSeconds / seconds), unit);
    }
  }
  return "now";
}

export function emojiUrl(id: string, animated: boolean): string {
  return `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "webp"}?size=48&quality=lossless`;
}

function Emoji({ name, id, animated, jumbo }: { name: string; id: string; animated: boolean; jumbo?: boolean }) {
  const size = jumbo ? "3rem" : "1.375em";
  // The bot sends a wide pill as a left and a right half (`_l`, `_r`); they touch
  // in Discord, so the margin between them is dropped here too.
  const margin = name.endsWith("_l") ? "0 0 0 0.1em" : name.endsWith("_r") ? "0 0.05em 0 0" : "0 0.05em 0 0.1em";
  return (
    <img
      src={emojiUrl(id, animated)}
      alt={`:${name}:`}
      title={`:${name}:`}
      draggable={false}
      onError={(event) => {
        // Unregistered or foreign id: fall back to the PNG the emoji was built from.
        const img = event.currentTarget;
        const local = `/images/discord/emojis/${name}.png`;
        if (!img.src.endsWith(local)) img.src = local;
      }}
      style={{ width: size, height: size, objectFit: "contain", verticalAlign: "bottom", margin, display: "inline-block" }}
    />
  );
}

function Spoiler({ children }: { children: ReactNode }) {
  return (
    <span
      className="cursor-pointer rounded-[3px] px-0.5 [&:not(.open)]:text-transparent [&:not(.open)_*]:invisible"
      style={{ backgroundColor: "rgba(255,255,255,0.1)" }}
      onClick={(event) => event.currentTarget.classList.add("open")}
    >
      {children}
    </span>
  );
}

const LINK_LABEL = String.raw`((?:\[[^\]]*\]|[^\[\]]|\](?=[^\[]*\]))*)`;
const LINK_TARGET = String.raw`<?((?:\([^)]*\)|[^\s\\]|\\.)*?)>?`;

let inlineRules: InlineRule[] | null = null;

function rules(jumbo: boolean): InlineRule[] {
  if (!jumbo && inlineRules) return inlineRules;
  const list: InlineRule[] = [
    { re: /^\\([^0-9A-Za-z\s])/, render: (m) => m[1] },
    {
      re: /^<(a?):(\w{2,32}):(\d{15,25})>/,
      render: (m, key) => <Emoji key={key} animated={m[1] === "a"} name={m[2]} id={m[3]} jumbo={jumbo} />,
    },
    {
      re: /^<t:(-?\d{1,17})(?::([tTdDfFR]))?>/,
      render: (m, key) => (
        <span key={key} className="rounded-[3px] px-0.5" style={{ backgroundColor: "rgba(255,255,255,0.06)" }}>
          {formatDiscordTimestamp(Number(m[1]), m[2] ?? "f")}
        </span>
      ),
    },
    {
      re: /^<(@!?|@&|#)(\d{15,25})>/,
      render: (m, key) => (
        <span key={key} className="rounded-[3px] px-0.5 font-medium" style={{ color: "#c9cdfb", backgroundColor: "rgba(88,101,242,0.3)" }}>
          {m[1] === "#" ? "#channel" : m[1] === "@&" ? "@role" : "@user"}
        </span>
      ),
    },
    {
      re: /^(`+)([\s\S]*?[^`])\1(?!`)/,
      render: (m, key) => (
        <code key={key} className="rounded-[4px] px-[0.2em] py-[0.1em] text-[0.85em]" style={{ backgroundColor: DISCORD.deep, fontFamily: DISCORD.mono, border: `1px solid ${DISCORD.divider}` }}>
          {m[2].trim()}
        </code>
      ),
    },
    {
      re: new RegExp(String.raw`^\[${LINK_LABEL}\]\(\s*${LINK_TARGET}\s*\)`),
      render: (m, key) => {
        const url = m[2].replace(/\\(.)/g, "$1");
        if (!/^https?:\/\//i.test(url)) return m[0];
        return (
          <a key={key} href={url} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: DISCORD.link }} title={url}>
            {parseInline(m[1], false)}
          </a>
        );
      },
    },
    {
      re: /^<(https?:\/\/[^\s>]+)>/,
      render: (m, key) => <a key={key} href={m[1]} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: DISCORD.link }}>{m[1]}</a>,
    },
    {
      re: /^https?:\/\/[^\s<]+[^<.,:;"')\]\s]/,
      render: (m, key) => <a key={key} href={m[0]} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: DISCORD.link }}>{m[0]}</a>,
    },
    { re: /^\*\*([\s\S]+?)\*\*(?!\*)/, render: (m, key) => <strong key={key} className="font-bold">{parseInline(m[1], false)}</strong> },
    { re: /^__([\s\S]+?)__(?!_)/, render: (m, key) => <u key={key}>{parseInline(m[1], false)}</u> },
    { re: /^\*(?=\S)((?:\*\*|\\[\s\S]|\s+(?:\\[\s\S]|[^\s*\\]|\*\*)|[^\s*\\])+?)\*(?!\*)/, render: (m, key) => <em key={key}>{parseInline(m[1], false)}</em> },
    { re: /^\b_((?:__|\\[\s\S]|[^\\_])+?)_\b/, render: (m, key) => <em key={key}>{parseInline(m[1], false)}</em> },
    { re: /^~~([\s\S]+?)~~(?!_)/, render: (m, key) => <s key={key}>{parseInline(m[1], false)}</s> },
    { re: /^\|\|([\s\S]+?)\|\|/, render: (m, key) => <Spoiler key={key}>{parseInline(m[1], false)}</Spoiler> },
  ];
  if (!jumbo) inlineRules = list;
  return list;
}

export function parseInline(text: string, jumbo: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  let buffer = "";
  let key = 0;
  let i = 0;
  const active = rules(jumbo);
  while (i < text.length) {
    const rest = text.slice(i);
    let matched = false;
    // A bare URL only starts at a word boundary, like Discord's autolinker.
    for (const rule of active) {
      if (rule.re.source.startsWith("^https?") && i > 0 && /\w/.test(text[i - 1])) continue;
      const m = rule.re.exec(rest);
      if (!m) continue;
      if (buffer) {
        out.push(buffer);
        buffer = "";
      }
      out.push(<Fragment key={`r${key++}`}>{rule.render(m, key++)}</Fragment>);
      i += m[0].length;
      matched = true;
      break;
    }
    if (!matched) {
      buffer += text[i];
      i += 1;
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

const EMOJI_ONLY = /^(?:\s*<a?:\w{2,32}:\d{15,25}>\s*){1,30}$/;

type Block =
  | { kind: "text"; text: string }
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "subtext"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[]; start: number }
  | { kind: "code"; lang: string; text: string };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const pushText = (line: string) => {
    const last = blocks[blocks.length - 1];
    if (last?.kind === "text") last.text += `\n${line}`;
    else blocks.push({ kind: "text", text: line });
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = /^```(\w*)\s*(.*)$/.exec(line);
    if (fence) {
      const body: string[] = [];
      const rest = fence[2];
      // Single-line fence: ```text```
      if (rest.endsWith("```") && rest.length >= 3) {
        blocks.push({ kind: "code", lang: fence[1], text: rest.slice(0, -3) });
        continue;
      }
      if (rest) body.push(rest);
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const end = lines[j].indexOf("```");
        if (end >= 0) {
          if (end > 0) body.push(lines[j].slice(0, end));
          break;
        }
        body.push(lines[j]);
      }
      if (j < lines.length) {
        blocks.push({ kind: "code", lang: fence[1], text: body.join("\n") });
        i = j;
        continue;
      }
    }
    const heading = /^(#{1,3}) +(\S.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length as 1 | 2 | 3, text: heading[2] });
      continue;
    }
    const sub = /^-# +(\S.*)$/.exec(line);
    if (sub) {
      blocks.push({ kind: "subtext", text: sub[1] });
      continue;
    }
    const multiQuote = /^>>> ?([\s\S]*)$/.exec(line);
    if (multiQuote) {
      blocks.push({ kind: "quote", text: [multiQuote[1], ...lines.slice(i + 1)].join("\n") });
      break;
    }
    const quote = /^> ?(.*)$/.exec(line);
    if (quote && line.startsWith("> ")) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "quote") last.text += `\n${quote[1]}`;
      else blocks.push({ kind: "quote", text: quote[1] });
      continue;
    }
    const bullet = /^\s*[-*] +(\S.*)$/.exec(line);
    const numbered = /^\s*(\d{1,9})\. +(\S.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const item = (bullet ? bullet[1] : numbered![2]);
      const last = blocks[blocks.length - 1];
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(item);
      else blocks.push({ kind: "list", ordered, items: [item], start: numbered ? Number(numbered[1]) : 1 });
      continue;
    }
    pushText(line);
  }
  return blocks;
}

const HEADING_STYLE: Record<1 | 2 | 3, string> = {
  1: "text-[24px] leading-[1.375em]",
  2: "text-[20px] leading-[1.375em]",
  3: "text-[16px] leading-[1.375em]",
};

export function DiscordMarkdown({ content }: { content: string }) {
  const jumbo = EMOJI_ONLY.test(content);
  const blocks = parseBlocks(content);
  return (
    <div className="whitespace-pre-wrap break-words text-[16px] leading-[1.375rem]" style={{ color: DISCORD.text }}>
      {blocks.map((block, index) => {
        const first = index === 0;
        switch (block.kind) {
          case "heading":
            return (
              <div key={index} className={`${HEADING_STYLE[block.level]} font-bold ${first ? "mt-1" : "mt-4"} mb-2`} style={{ color: DISCORD.white }}>
                {parseInline(block.text, false)}
              </div>
            );
          case "subtext":
            return (
              <div key={index} className="text-[13px] leading-[1.11rem]" style={{ color: DISCORD.muted }}>
                {parseInline(block.text, false)}
              </div>
            );
          case "quote":
            return (
              <div key={index} className="flex">
                <div className="w-1 shrink-0 rounded" style={{ backgroundColor: "#4e5058" }} />
                <div className="min-w-0 pl-3 pr-2">{parseInline(block.text, false)}</div>
              </div>
            );
          case "list": {
            const items = block.items.map((item, itemIndex) => <li key={itemIndex} className="pl-0">{parseInline(item, false)}</li>);
            return block.ordered
              ? <ol key={index} start={block.start} className="my-0 list-decimal pl-6 whitespace-normal">{items}</ol>
              : <ul key={index} className="my-0 list-disc pl-6 whitespace-normal">{items}</ul>;
          }
          case "code":
            return (
              <pre key={index} className="my-1 overflow-x-auto rounded-[4px] p-2 text-[14px] leading-[1.125rem]" style={{ backgroundColor: DISCORD.embed, border: `1px solid ${DISCORD.deep}`, fontFamily: DISCORD.mono, color: "#b5bac1" }}>
                {block.text}
              </pre>
            );
          default:
            // One row per line so blank lines keep their height, as in Discord.
            return block.text.split("\n").map((line, lineIndex) => (
              <span key={`${index}-${lineIndex}`} className="block min-h-[1.375rem]">{parseInline(line, jumbo)}</span>
            ));
        }
      })}
    </div>
  );
}
