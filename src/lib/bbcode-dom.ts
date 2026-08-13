// Editable-DOM side of the BBCode editor: renders parsed BBCode into HTML
// meant for a contentEditable surface (stamped with data-bb/data-nl attributes
// so nothing about the original source is guessed later), and serializes that
// DOM back to BBCode. Elements the renderer stamped serialize exactly;
// browser-generated markup from live editing (b/i/font/div lines/inline
// styles) is covered by heuristics.
//
// Client-only: the serializer walks live DOM nodes.

import { clampBBSizePercent, parseBBCode, type BBAlign, type BBBlockSpacing, type BBNode } from "./bbcode";

export function escapeBBHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeBBAttr(value: string): string {
  return escapeBBHtml(value)
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#10;");
}

function nlString(spacing: BBBlockSpacing | undefined): string {
  if (!spacing) return "";
  return `${spacing.afterOpen ? "o" : ""}${spacing.beforeClose ? "c" : ""}${spacing.afterClose ? "a" : ""}`;
}

export type EditableWrapKind =
  | "spoiler" | "color" | "size" | "url"
  | "heading" | "centre" | "left" | "right" | "notice" | "quote" | "codeblock" | "c" | "box";

/**
 * The markup an alignment tag becomes on the editable surface.
 *
 * [centre] keeps the <center> the renderer has always used; the other two get
 * osu!'s own class names, which .bbcode-content already styles. Both carry
 * data-bb so the serializer names the tag from the element rather than from a
 * text-align style a browser command may have left behind.
 */
const ALIGN_ELEMENTS: Record<BBAlign, { open: string; close: string }> = {
  centre: { open: "<center", close: "</center>" },
  left: { open: '<div data-bb="align" data-param="left" class="bbcode__align-left"', close: "</div>" },
  right: { open: '<div data-bb="align" data-param="right" class="bbcode__align-right"', close: "</div>" },
};

/** The alignment an editable element stands for, or null when it is not one. */
export function elementAlign(el: Element): BBAlign | null {
  if (el.tagName === "CENTER") return "centre";
  if (el.getAttribute("data-bb") !== "align") return null;
  const param = el.getAttribute("data-param");
  return param === "left" || param === "right" ? param : null;
}

/** Selector matching every element `elementAlign` recognizes. */
export const ALIGN_SELECTOR = 'center,[data-bb="align"]';

/**
 * Drops the alignment wrappers out of an HTML fragment, keeping their contents.
 *
 * Used when the toolbar moves an alignment from inside a heading to around it:
 * osu! only lets a heading hold inline content, so the one that was inside was
 * never doing anything there but costing the heading its size.
 * Client-only (parses via a live DOM element).
 */
export function unwrapAligns(html: string): string {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  holder.querySelectorAll(ALIGN_SELECTOR).forEach((el) => el.replaceWith(...el.childNodes));
  return holder.innerHTML;
}

function editableSizeValue(param: string | undefined): number {
  const value = Number(param);
  return Number.isFinite(value) ? value : 100;
}

/**
 * Open/close HTML fragments for wrapping a contentEditable selection so the
 * result serializes back to the intended BBCode tag. `param` is the color,
 * size, href, or box title depending on the kind. Callers must validate
 * params (color via isValidBBColor, numeric size, href http(s)).
 */
export function editableWrapMarkup(kind: EditableWrapKind, param?: string): { open: string; close: string } {
  switch (kind) {
    case "spoiler":
      return { open: '<span class="spoiler">', close: "</span>" };
    case "color":
      return { open: `<span style="color:${escapeBBAttr(param ?? "#ffffff")}" data-bb-color="${escapeBBAttr(param ?? "#ffffff")}">`, close: "</span>" };
    case "size": {
      const size = editableSizeValue(param);
      return { open: `<span style="font-size:${clampBBSizePercent(size)}%" data-bb-size="${size}">`, close: "</span>" };
    }
    case "url":
      return { open: `<a href="${escapeBBAttr(param ?? "")}" data-bb="url">`, close: "</a>" };
    case "heading":
      return { open: '<h2 data-nl="a">', close: "</h2>" };
    case "centre": case "left": case "right": {
      const { open, close } = ALIGN_ELEMENTS[kind];
      return { open: `${open} data-nl="a">`, close };
    }
    case "notice":
      return { open: '<div class="well" data-nl="oca">', close: "</div>" };
    case "quote":
      return { open: '<blockquote data-bb="quote" data-nl="oca">', close: "</blockquote>" };
    case "codeblock":
      return { open: '<pre data-nl="oca">', close: "</pre>" };
    case "c":
      return { open: "<code>", close: "</code>" };
    case "box": {
      const title = param ?? null;
      const isSpoiler = title === null;
      return {
        open: `<div class="js-spoilerbox bbcode-spoilerbox is-open" data-bb="${isSpoiler ? "spoilerbox" : "box"}" data-nl="oca">`
          + boxButtonHtml(isSpoiler ? "SPOILER" : title)
          + '<div class="js-spoilerbox__body bbcode-spoilerbox__body">',
        close: "</div></div>",
      };
    }
  }
}

function boxButtonHtml(title: string): string {
  // Titles may carry nested bbcode (osu allows e.g. [box=[color=#fff]Hi[/color]]),
  // so render them rather than escaping to text; serializeBox walks them back.
  return '<button type="button" class="js-spoilerbox__link bbcode-spoilerbox__link" contenteditable="false" data-bb-skip="1" tabindex="-1">'
    + '<span class="bbcode-spoilerbox__link-icon"></span>'
    + `<span class="bbcode-spoilerbox__link-text" data-bb-role="box-title" contenteditable="true">${bbcodeToEditableHtml(title)}</span>`
    + "</button>";
}

function renderChildren(nodes: BBNode[]): string {
  return nodes.map(renderNode).join("");
}

function renderNode(node: BBNode): string {
  switch (node.type) {
    case "text":
      return escapeBBHtml(node.text).replace(/\n/g, "<br>");
    case "style": {
      const inner = renderChildren(node.children);
      switch (node.tag) {
        case "b": return `<strong>${inner}</strong>`;
        case "i": return `<em>${inner}</em>`;
        case "u": return `<u>${inner}</u>`;
        case "s": return `<del>${inner}</del>`;
        case "spoiler": return `<span class="spoiler">${inner}</span>`;
      }
      return inner;
    }
    case "color":
      return `<span style="color:${escapeBBAttr(node.color)}" data-bb-color="${escapeBBAttr(node.color)}">${renderChildren(node.children)}</span>`;
    case "size":
      return `<span style="font-size:${clampBBSizePercent(node.size)}%" data-bb-size="${node.size}">${renderChildren(node.children)}</span>`;
    case "url":
      return `<a href="${escapeBBAttr(node.href)}" data-bb="url"${node.bare ? ' data-bare="1"' : ""}>${renderChildren(node.children)}</a>`;
    case "email":
      return `<a href="mailto:${escapeBBAttr(node.address)}" data-bb="email" data-param="${escapeBBAttr(node.address)}">${renderChildren(node.children)}</a>`;
    case "profile": {
      const target = node.userId ?? "";
      return `<a href="https://osu.ppy.sh/users/${escapeBBAttr(encodeURIComponent(target))}" data-bb="profile"${node.userId ? ` data-param="${escapeBBAttr(node.userId)}"` : ""}>${renderChildren(node.children)}</a>`;
    }
    case "img":
      return `<img src="${escapeBBAttr(node.src)}" alt="" loading="lazy">`;
    case "youtube":
      return `<span class="bbcode-editor-embed" data-bb="youtube" data-param="${escapeBBAttr(node.videoId)}" contenteditable="false">`
        + `<img src="https://i.ytimg.com/vi/${escapeBBAttr(node.videoId)}/mqdefault.jpg" alt="" loading="lazy">`
        + '<span class="bbcode-editor-embed__label">YouTube</span></span>';
    case "audio":
      return `<span class="bbcode-editor-embed bbcode-editor-embed--audio" data-bb="audio" data-param="${escapeBBAttr(node.src)}" contenteditable="false">`
        + `<audio controls preload="none" src="${escapeBBAttr(node.src)}"></audio></span>`;
    case "heading":
      return `<h2 data-nl="${nlString(node.spacing)}">${renderChildren(node.children)}</h2>`;
    case "notice":
      return `<div class="well" data-nl="${nlString(node.spacing)}">${renderChildren(node.children)}</div>`;
    case "align": {
      const { open, close } = ALIGN_ELEMENTS[node.align];
      return `${open} data-nl="${nlString(node.spacing)}">${renderChildren(node.children)}${close}`;
    }
    case "quote":
      return `<blockquote data-bb="quote"${node.author ? ` data-param="${escapeBBAttr(node.author)}"` : ""} data-nl="${nlString(node.spacing)}">`
        + (node.author ? `<h4 contenteditable="false" data-bb-skip="1">${escapeBBHtml(node.author)} wrote:</h4>` : "")
        + `${renderChildren(node.children)}</blockquote>`;
    case "box":
      return `<div class="js-spoilerbox bbcode-spoilerbox is-open" data-bb="${node.title === null ? "spoilerbox" : "box"}" data-nl="${nlString(node.spacing)}">`
        + boxButtonHtml(node.title ?? "SPOILER")
        + `<div class="js-spoilerbox__body bbcode-spoilerbox__body">${renderChildren(node.children)}</div></div>`;
    case "code":
      return node.inline
        ? `<code>${escapeBBHtml(node.code)}</code>`
        : `<pre data-nl="${nlString(node.spacing)}">${escapeBBHtml(node.code)}</pre>`;
    case "list": {
      const items = node.items
        .map((item) => `<li>${renderChildren(item)}</li>`)
        .join("");
      const tag = node.ordered ? "ol" : "ul";
      return `<${tag} data-nl="${nlString(node.spacing)}">${items}</${tag}>`;
    }
    case "imagemap": {
      const areas = node.links.map((link, index) =>
        `<span class="imagemap__link" data-bb-imagemap-area="1" data-index="${index}" data-x="${link.x}" data-y="${link.y}" data-width="${link.width}" data-height="${link.height}" data-href="${escapeBBAttr(link.href)}" data-title="${escapeBBAttr(link.title)}" style="left:${link.x}%;top:${link.y}%;width:${link.width}%;height:${link.height}%"${link.title ? ` title="${escapeBBAttr(link.title)}"` : ""}></span>`,
      ).join("");
      return `<span class="imagemap" data-bb="imagemap" data-src="${escapeBBAttr(node.src)}" data-raw="${escapeBBAttr(node.raw)}" contenteditable="false">`
        + `<img class="imagemap__image" src="${escapeBBAttr(node.src)}" alt="" loading="lazy">${areas}</span>`;
    }
    default:
      return "";
  }
}

/** BBCode source -> HTML for the contentEditable editing surface. */
export function bbcodeToEditableHtml(source: string): string {
  return renderChildren(parseBBCode(source));
}

/**
 * Reads the per-visible-character color of an editable-HTML fragment - a
 * gradient's colors captured left to right, one entry per glyph (whitespace has
 * none, so it's skipped). Powers the "copy formatting" format painter.
 */
export function captureColorSequence(html: string): (string | null)[] {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  const seq: (string | null)[] = [];
  const walk = (node: Node, inherited: string | null) => {
    if (node.nodeType === 3) {
      for (const ch of node.nodeValue ?? "") if (!/\s/.test(ch)) seq.push(inherited);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    const own = el.getAttribute("data-bb-color") ?? cssColorToBB(el.style?.color ?? "") ?? inherited;
    el.childNodes.forEach((child) => walk(child, own));
  };
  holder.childNodes.forEach((child) => walk(child, null));
  return seq;
}

/**
 * Paints `text` with a captured color sequence, stretched to fit its length, and
 * returns editable HTML (one [color] span per glyph; whitespace and newlines
 * preserved). The other half of the format painter.
 */
export function applyColorSequence(text: string, seq: (string | null)[]): string {
  const chars = Array.from(text);
  const visible = chars.filter((ch) => !/\s/.test(ch)).length;
  if (visible === 0 || seq.length === 0) return escapeBBHtml(text).replace(/\n/g, "<br>");
  let seen = 0;
  let out = "";
  for (const ch of chars) {
    if (/\s/.test(ch)) { out += ch === "\n" ? "<br>" : escapeBBHtml(ch); continue; }
    const color = seq[Math.min(seq.length - 1, Math.floor((seen * seq.length) / visible))];
    seen += 1;
    const escaped = escapeBBHtml(ch);
    out += color ? `<span style="color:${color}" data-bb-color="${color}">${escaped}</span>` : escaped;
  }
  return out;
}

const WRAP_BLOCK_TAGS = /^(DIV|P|H[1-6]|CENTER|BLOCKQUOTE|UL|OL|LI|PRE)$/;

/**
 * Wraps `innerHtml` in an inline open/close pair (e.g. [color]/[size]/[spoiler]
 * spans). When the content spans block lines, the wrapper is pushed *into* each
 * line rather than around them: wrapping block elements in one inline span makes
 * execCommand("insertHTML") drop the blocks and wipe the text. Single-line
 * content is wrapped whole. Client-only (parses via a live DOM element).
 */
export function distributeInlineWrap(innerHtml: string, open: string, close: string): string {
  const holder = document.createElement("div");
  holder.innerHTML = innerHtml;
  const spansBlocks = Array.from(holder.childNodes).some(
    (node) => node.nodeType === 1
      && (WRAP_BLOCK_TAGS.test((node as Element).tagName) || (node as Element).tagName === "BR"),
  );
  if (!spansBlocks) return innerHtml.trim() ? open + innerHtml + close : innerHtml;

  const wrapSegment = (segment: string) =>
    /^<br/i.test(segment) || !segment.replace(/&nbsp;|\u200b|\s/gi, "").trim()
      ? segment
      : open + segment + close;

  let out = "";
  let run = "";
  const flushRun = () => {
    if (run) out += run.split(/(<br\s*\/?>)/i).map(wrapSegment).join("");
    run = "";
  };
  holder.childNodes.forEach((node) => {
    if (node.nodeType === 1 && WRAP_BLOCK_TAGS.test((node as Element).tagName)) {
      flushRun();
      const el = node as HTMLElement;
      el.innerHTML = distributeInlineWrap(el.innerHTML, open, close); // recurse into nested lines
      out += el.outerHTML;
    } else if (node.nodeType === 1 && (node as Element).tagName === "BR") {
      run += "<br>";
    } else if (node.nodeType === 1) {
      run += (node as HTMLElement).outerHTML;
    } else if (node.nodeType === 3) {
      run += escapeBBHtml(node.nodeValue ?? "");
    }
  });
  flushRun();
  return out;
}

// ---------------------------------------------------------------------------
// DOM -> BBCode
// ---------------------------------------------------------------------------

export function cssColorToBB(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(trimmed);
  if (rgb) {
    const hex = rgb.slice(1, 4)
      .map((channel) => Number(channel).toString(16).padStart(2, "0").toUpperCase())
      .join("");
    return `#${hex}`;
  }
  if (/^#[0-9a-fA-F]{3,6}$/.test(trimmed)) return trimmed.toUpperCase();
  return trimmed;
}

interface NlFlags { afterOpen: boolean; beforeClose: boolean; afterClose: boolean }

function readNlFlags(el: Element, fallback: string): NlFlags {
  const nl = el.getAttribute("data-nl") ?? fallback;
  return {
    afterOpen: nl.includes("o"),
    beforeClose: nl.includes("c"),
    afterClose: nl.includes("a"),
  };
}

/**
 * Flattens a line break out of content that has to stay on one line.
 *
 * osu! matches [heading] and [c] without DOTALL, so a newline anywhere inside
 * one stops the match and prints the tags themselves on the page. Nothing can
 * be done to carry the break over, and dropping the tag would be worse, so the
 * lines are joined.
 */
function oneLine(value: string): string {
  return value.replace(/\n+/g, " ").trim();
}

function wrapBlock(el: Element, open: string, close: string, fallback: string, inner?: string): string {
  const flags = readNlFlags(el, fallback);
  const content = inner ?? serializeChildren(el);
  return open
    + (flags.afterOpen ? "\n" : "")
    + content
    + (flags.beforeClose ? "\n" : "")
    + close
    + (flags.afterClose ? "\n" : "");
}

function serializeChildren(el: Node): string {
  let out = "";
  el.childNodes.forEach((child) => {
    out += serializeNode(child, out);
  });
  return out;
}

function serializeList(el: Element): string {
  const items = Array.from(el.children).filter((child) => child.tagName === "LI");
  let inner = "";
  items.forEach((li, index) => {
    let item = `[*]${serializeChildren(li)}`;
    if (index < items.length - 1 && !item.endsWith("\n")) item += "\n";
    inner += item;
  });
  return wrapBlock(el, `[list${el.tagName === "OL" ? "=1" : ""}]`, "[/list]", "oca", inner);
}

function serializeBox(el: Element): string {
  const titleEl = el.querySelector('[data-bb-role="box-title"]');
  // Serialize the title's children so nested bbcode (e.g. [color]) round-trips.
  const title = (titleEl ? serializeChildren(titleEl) : "").replace(/\u00a0/g, " ").trim();
  const body = el.querySelector(":scope > .js-spoilerbox__body");
  const inner = body ? serializeChildren(body) : serializeChildren(el);
  const isSpoilerbox = el.getAttribute("data-bb") === "spoilerbox" && title === "SPOILER";
  return wrapBlock(
    el,
    isSpoilerbox ? "[spoilerbox]" : `[box=${title}]`,
    isSpoilerbox ? "[/spoilerbox]" : "[/box]",
    "oca",
    inner,
  );
}

function serializeSpanStyles(el: HTMLElement): string {
  const wrappers: Array<[string, string]> = [];
  if (el.classList.contains("spoiler")) wrappers.push(["[spoiler]", "[/spoiler]"]);

  const color = el.getAttribute("data-bb-color") ?? cssColorToBB(el.style.color);
  if (color) wrappers.push([`[color=${color}]`, "[/color]"]);

  const sizeAttr = el.getAttribute("data-bb-size");
  const sizeMatch = sizeAttr ?? (/^(\d+)%$/.exec(el.style.fontSize)?.[1] ?? null);
  if (sizeMatch) wrappers.push([`[size=${sizeMatch}]`, "[/size]"]);

  const weight = el.style.fontWeight;
  if (weight === "bold" || weight === "bolder" || Number(weight) >= 600) wrappers.push(["[b]", "[/b]"]);
  if (el.style.fontStyle === "italic") wrappers.push(["[i]", "[/i]"]);
  const decoration = el.style.textDecoration || el.style.textDecorationLine || "";
  if (decoration.includes("underline")) wrappers.push(["[u]", "[/u]"]);
  if (decoration.includes("line-through")) wrappers.push(["[s]", "[/s]"]);

  let out = serializeChildren(el);
  for (let i = wrappers.length - 1; i >= 0; i--) {
    out = wrappers[i][0] + out + wrappers[i][1];
  }
  return out;
}

function serializeNode(node: Node, prior: string): string {
  if (node.nodeType === 3) {
    return (node.nodeValue ?? "").replace(/\u200b/g, "");
  }
  if (node.nodeType !== 1) return "";
  const el = node as HTMLElement;
  if (el.hasAttribute("data-bb-skip")) return "";

  const tag = el.tagName;
  if (tag === "BR") return "\n";

  switch (el.getAttribute("data-bb")) {
    case "align": {
      const align = elementAlign(el);
      if (align) return wrapBlock(el, `[${align}]`, `[/${align}]`, "a");
      break;
    }
    case "youtube":
      return `[youtube]${el.getAttribute("data-param") ?? ""}[/youtube]`;
    case "audio":
      return `[audio]${el.getAttribute("data-param") ?? ""}[/audio]`;
    case "imagemap":
      return wrapBlock(el, "[imagemap]", "[/imagemap]", "", el.getAttribute("data-raw") ?? "");
    case "url": {
      const href = el.getAttribute("href") ?? "";
      if (el.getAttribute("data-bare") === "1") return `[url]${href}[/url]`;
      return `[url=${href}]${serializeChildren(el)}[/url]`;
    }
    case "email": {
      const address = el.getAttribute("data-param") ?? "";
      const inner = serializeChildren(el);
      return inner.trim() === address ? `[email]${inner}[/email]` : `[email=${address}]${inner}[/email]`;
    }
    case "profile": {
      const id = el.getAttribute("data-param");
      return id ? `[profile=${id}]${serializeChildren(el)}[/profile]` : `[profile]${serializeChildren(el)}[/profile]`;
    }
    case "quote": {
      const author = el.getAttribute("data-param");
      return wrapBlock(el, author ? `[quote="${author}"]` : "[quote]", "[/quote]", "oca");
    }
    case "box":
    case "spoilerbox":
      return serializeBox(el);
  }

  switch (tag) {
    case "B": case "STRONG":
      return `[b]${serializeChildren(el)}[/b]`;
    case "I": case "EM":
      return `[i]${serializeChildren(el)}[/i]`;
    case "U": case "INS":
      return `[u]${serializeChildren(el)}[/u]`;
    case "S": case "DEL": case "STRIKE":
      return `[s]${serializeChildren(el)}[/s]`;
    case "FONT": {
      const color = el.getAttribute("color");
      const inner = serializeChildren(el);
      return color ? `[color=${cssColorToBB(color) ?? color}]${inner}[/color]` : inner;
    }
    case "A": {
      const href = el.getAttribute("href") ?? "";
      if (href.startsWith("mailto:")) return `[email=${href.slice(7)}]${serializeChildren(el)}[/email]`;
      return `[url=${href}]${serializeChildren(el)}[/url]`;
    }
    case "IMG":
      return `[img]${el.getAttribute("src") ?? ""}[/img]`;
    case "AUDIO":
      return `[audio]${el.getAttribute("src") ?? ""}[/audio]`;
    case "IFRAME":
      return "";
    case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": {
      // Not wrapBlock: a heading is the one block whose own boundary newlines
      // cannot be written back, since osu! would then print its tags as text.
      const trailing = readNlFlags(el, "a").afterClose ? "\n" : "";
      return `[heading]${oneLine(serializeChildren(el))}[/heading]${trailing}`;
    }
    case "CENTER":
      return wrapBlock(el, "[centre]", "[/centre]", "a");
    case "BLOCKQUOTE":
      return wrapBlock(el, "[quote]", "[/quote]", "oca");
    case "PRE":
      return wrapBlock(el, "[code]", "[/code]", "oca");
    case "CODE":
      return `[c]${oneLine(el.textContent ?? "")}[/c]`;
    case "UL": case "OL":
      return serializeList(el);
    case "LI":
      // Reached only for orphaned items outside a list; keep the marker.
      return `[*]${serializeChildren(el)}`;
    case "SPAN":
      return serializeSpanStyles(el);
    case "DIV": case "P": {
      if (el.classList.contains("well")) return wrapBlock(el, "[notice]", "[/notice]", "oca");
      if (el.classList.contains("js-spoilerbox")) return serializeBox(el);
      // Pasted markup can carry its alignment as a style instead of one of our
      // elements. Left is the default, so only these two are worth a tag.
      if (el.style.textAlign === "center") return wrapBlock(el, "[centre]", "[/centre]", "a");
      if (el.style.textAlign === "right") return wrapBlock(el, "[right]", "[/right]", "a");
      // contentEditable line container: each div is one visual line.
      const lineBreak = prior && !prior.endsWith("\n") ? "\n" : "";
      return lineBreak + serializeChildren(el);
    }
    default:
      return serializeChildren(el);
  }
}

/** contentEditable surface -> BBCode source. */
export function serializeBBCodeDom(root: Element): string {
  return serializeChildren(root).replace(/\u00a0/g, " ");
}
