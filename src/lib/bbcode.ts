// Parser for osu!-flavoured BBCode (the profile "me!" page dialect).
//
// Produces a tree the preview renderer walks directly, so untrusted input
// never reaches dangerouslySetInnerHTML: every text node stays a plain string.
// The parser is lenient like osu's: unknown tags, mismatched closers, and
// malformed params render as literal text instead of erroring.

export type BBInlineStyleTag = "b" | "i" | "u" | "s" | "spoiler";

/**
 * osu!'s three alignment tags ([centre], [left], [right]), which it renders as
 * one div each. They are separate tags to osu!, so a [left] inside a [centre]
 * is what pulls that stretch back to the left.
 */
export type BBAlign = "centre" | "left" | "right";

/**
 * Which boundary newlines the parser trimmed around a block tag. osu! (and
 * this parser) swallow one newline after a block's open tag, before its close
 * tag, and after its close tag so blocks don't render stray blank lines. The
 * flags let a serializer re-emit the exact source instead of guessing.
 */
export interface BBBlockSpacing {
  afterOpen: boolean;
  beforeClose: boolean;
  afterClose: boolean;
}

/** Range in the normalized (\n-only) source a node was parsed from. */
export interface BBSourceSpan {
  start: number;
  end: number;
}

export type BBNode = (
  | { type: "text"; text: string }
  | { type: "style"; tag: BBInlineStyleTag; children: BBNode[] }
  | { type: "color"; color: string; children: BBNode[] }
  | { type: "size"; size: number; children: BBNode[] }
  | { type: "url"; href: string; children: BBNode[]; bare?: boolean }
  | { type: "email"; address: string; children: BBNode[] }
  | { type: "profile"; userId: string | null; children: BBNode[] }
  | { type: "img"; src: string }
  | { type: "youtube"; videoId: string }
  | { type: "audio"; src: string }
  | { type: "heading"; children: BBNode[]; spacing?: BBBlockSpacing }
  | { type: "notice"; children: BBNode[]; spacing?: BBBlockSpacing }
  | { type: "align"; align: BBAlign; children: BBNode[]; spacing?: BBBlockSpacing }
  | { type: "quote"; author: string | null; children: BBNode[]; spacing?: BBBlockSpacing }
  /** title is null for [spoilerbox] ("SPOILER" label) and "" for [box=]. */
  | { type: "box"; title: string | null; children: BBNode[]; spacing?: BBBlockSpacing }
  | { type: "code"; inline: boolean; code: string; spacing?: BBBlockSpacing }
  | { type: "list"; ordered: boolean; items: BBNode[][]; spacing?: BBBlockSpacing }
  | { type: "imagemap"; src: string; links: BBImagemapLink[]; raw: string; spacing?: BBBlockSpacing }
) & { span?: BBSourceSpan };

export interface BBImagemapLink {
  /** Percentages of the image's dimensions, as osu! defines them. */
  x: number;
  y: number;
  width: number;
  height: number;
  href: string;
  title: string;
}

interface ContainerFrame {
  tag: string;
  param: string | null;
  children: BBNode[];
  /** For [list]: items collected so far; children is the current item. */
  items?: BBNode[][];
  /** Raw source of the opening tag, replayed as text if never closed. */
  openSource: string;
  /** Offset of the opening tag in the normalized source. */
  openStart: number;
  /** Block tags: whether a newline right after the open tag was trimmed. */
  afterOpenTrimmed?: boolean;
}

// Tags whose content is taken verbatim until their own closing tag.
const VERBATIM_TAGS = new Set(["code", "c", "img", "youtube", "audio", "imagemap"]);

const CONTAINER_TAGS = new Set([
  "b", "i", "u", "s", "strike", "spoiler", "color", "size", "url", "email",
  "profile", "heading", "notice", "centre", "center", "left", "right",
  "quote", "box", "spoilerbox", "list",
]);

/** Tags rendered as blocks; surrounding newlines get trimmed like osu does. */
const BLOCK_TAGS = new Set([
  "heading", "notice", "centre", "center", "left", "right", "quote", "box",
  "spoilerbox", "list", "code", "imagemap",
]);

/**
 * The only tags osu! lets hold one of their own.
 *
 * osu! pairs most tags with a single non-greedy regex per tag name (one pass
 * for [centre], one for [b], one for [color]...), so an opener takes the very
 * next closer whatever sits between them. A second [centre] inside an open one
 * is not a tag there at all - it prints as its literal text, and the [/centre]
 * written for it closes the outer block instead. Only these four are paired by
 * counting openers against closers, which is what lets them nest.
 */
const NESTABLE_TAGS = new Set(["box", "spoilerbox", "quote", "list"]);

export function isBlockBBTag(tag: string): boolean {
  return BLOCK_TAGS.has(tag);
}

const TAG_PATTERN = /\[(\/?)([a-zA-Z]+|\*)(?:=([^\]\n]*))?\]/g;

const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const NAMED_COLOR_PATTERN = /^[a-zA-Z]{2,30}$/;
const SIZE_PARAM_PATTERN = /^\d+$/;
const SIZE_RENDER_MIN = 30;
const SIZE_RENDER_MAX = 200;

export function isValidBBColor(value: string): boolean {
  return HEX_COLOR_PATTERN.test(value) || NAMED_COLOR_PATTERN.test(value);
}

function normalizeSize(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!SIZE_PARAM_PATTERN.test(trimmed)) return null;
  const size = Number(trimmed);
  if (!Number.isSafeInteger(size)) return null;
  return size;
}

export function clampBBSizePercent(size: number): number {
  if (!Number.isFinite(size)) return 100;
  return Math.min(SIZE_RENDER_MAX, Math.max(SIZE_RENDER_MIN, size));
}

function extractYoutubeId(value: string): string | null {
  const trimmed = value.trim();
  if (/^[\w-]{6,20}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname === "youtu.be") {
      const id = url.pathname.slice(1);
      return /^[\w-]{6,20}$/.test(id) ? id : null;
    }
    if (/(^|\.)youtube\.com$/.test(url.hostname)) {
      const id = url.searchParams.get("v") ?? url.pathname.split("/").pop() ?? "";
      return /^[\w-]{6,20}$/.test(id) ? id : null;
    }
  } catch {
    // Not a URL; fall through.
  }
  return null;
}

/** Normalizes a [youtube] payload (bare id or any YouTube URL) to a video id. */
export function parseYoutubeInput(value: string): string | null {
  return extractYoutubeId(value);
}

function isSafeHref(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

// [img] also accepts blob: URLs so the BBCode editor's not-yet-uploaded pasted
// images round-trip through the parser. Those blob URLs are swapped for real
// hosted URLs before anything is copied or saved, so they never reach output.
// Rendering a stray blob URL is harmless (dead cross-origin -> broken image).
function isImageSrc(value: string): boolean {
  const trimmed = value.trim();
  return isSafeHref(trimmed) || /^blob:https?:\/\/\S+$/i.test(trimmed);
}

function parseImagemap(content: string): BBNode {
  const lines = content.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const src = lines[0] ?? "";
  const links: BBImagemapLink[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/);
    if (parts.length < 5) continue;
    const [x, y, width, height] = parts.slice(0, 4).map(Number);
    const href = parts[4];
    if ([x, y, width, height].some((n) => !Number.isFinite(n))) continue;
    links.push({
      x, y, width, height,
      href: href === "#" ? "" : href,
      title: parts.slice(5).join(" "),
    });
  }
  return { type: "imagemap", src, links, raw: content };
}

/** Attaches recorded boundary-newline flags to nodes that can carry them. */
function attachSpacing(node: BBNode, spacing: BBBlockSpacing) {
  if (
    node.type === "heading" || node.type === "notice" || node.type === "align" ||
    node.type === "quote" || node.type === "box" || node.type === "list" ||
    node.type === "imagemap" || (node.type === "code" && !node.inline)
  ) {
    node.spacing = spacing;
  }
}

function pushText(children: BBNode[], text: string, start?: number) {
  if (!text) return;
  const last = children[children.length - 1];
  if (last && last.type === "text") {
    last.text += text;
    if (last.span && start != null) last.span.end = start + text.length;
  } else {
    const node: BBNode = { type: "text", text };
    if (start != null) node.span = { start, end: start + text.length };
    children.push(node);
  }
}

/** Appends nodes, merging adjacent text nodes so replayed literals stay one run. */
function pushNodes(target: BBNode[], nodes: BBNode[]) {
  for (const node of nodes) {
    if (node.type === "text") pushText(target, node.text, node.span?.start);
    else target.push(node);
  }
}

function buildVerbatimNode(tag: string, content: string, param: string | null): BBNode | null {
  switch (tag) {
    case "code":
      return { type: "code", inline: false, code: content.replace(/^\n/, "").replace(/\n$/, "") };
    case "c":
      return { type: "code", inline: true, code: content };
    case "img": {
      const src = content.trim();
      return isImageSrc(src) ? { type: "img", src } : { type: "text", text: src };
    }
    case "youtube": {
      const videoId = extractYoutubeId(content);
      return videoId ? { type: "youtube", videoId } : { type: "text", text: content };
    }
    case "audio": {
      const src = content.trim();
      return isSafeHref(src) ? { type: "audio", src } : { type: "text", text: src };
    }
    case "imagemap":
      return parseImagemap(content);
    default:
      void param;
      return null;
  }
}

function openContainer(tag: string, param: string | null, openSource: string, openStart: number): ContainerFrame | null {
  switch (tag) {
    case "b": case "i": case "u": case "s": case "strike": case "spoiler":
    case "heading": case "notice": case "centre": case "center":
    case "left": case "right": case "spoilerbox":
      return { tag, param: null, children: [], openSource, openStart };
    case "color":
      if (!param || !isValidBBColor(param.trim())) return null;
      return { tag, param: param.trim(), children: [], openSource, openStart };
    case "size":
      if (normalizeSize(param) == null) return null;
      return { tag, param, children: [], openSource, openStart };
    case "url":
      if (param != null && !isSafeHref(param)) return null;
      return { tag, param, children: [], openSource, openStart };
    case "email":
    case "profile":
    case "quote":
    case "box":
      return { tag, param, children: [], openSource, openStart };
    case "list":
      return { tag, param, children: [], items: [], openSource, openStart };
    default:
      return null;
  }
}

function closeContainer(frame: ContainerFrame): BBNode | null {
  switch (frame.tag) {
    case "b": case "i": case "u": case "spoiler":
      return { type: "style", tag: frame.tag, children: frame.children };
    case "s": case "strike":
      return { type: "style", tag: "s", children: frame.children };
    case "color":
      return { type: "color", color: frame.param ?? "#ffffff", children: frame.children };
    case "size":
      return { type: "size", size: normalizeSize(frame.param) ?? 100, children: frame.children };
    case "url": {
      if (frame.param != null) return { type: "url", href: frame.param, children: frame.children };
      const text = collectPlainText(frame.children).trim();
      if (!isSafeHref(text)) return null;
      return { type: "url", href: text, children: frame.children, bare: true };
    }
    case "email": {
      const address = frame.param ?? collectPlainText(frame.children).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return null;
      return { type: "email", address, children: frame.children };
    }
    case "profile":
      return { type: "profile", userId: frame.param?.trim() || null, children: frame.children };
    case "heading":
      return { type: "heading", children: frame.children };
    case "notice":
      return { type: "notice", children: frame.children };
    case "centre": case "center":
      return { type: "align", align: "centre", children: frame.children };
    case "left": case "right":
      return { type: "align", align: frame.tag, children: frame.children };
    case "quote":
      return { type: "quote", author: frame.param?.replace(/^"|"$/g, "") || null, children: frame.children };
    case "box":
      // osu! renders [box=] with an empty (not "SPOILER") label, so keep "".
      return { type: "box", title: frame.param ?? "", children: frame.children };
    case "spoilerbox":
      return { type: "box", title: null, children: frame.children };
    case "list": {
      const items = frame.items ?? [];
      if (frame.children.length > 0) items.push(frame.children);
      return { type: "list", ordered: frame.param?.trim() === "1", items };
    }
    default:
      return null;
  }
}

export function collectPlainText(nodes: BBNode[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text": out += node.text; break;
      case "code": out += node.code; break;
      case "img": out += node.src; break;
      case "youtube": out += node.videoId; break;
      case "audio": out += node.src; break;
      case "list": for (const item of node.items) out += collectPlainText(item); break;
      case "imagemap": out += node.src; break;
      default: out += collectPlainText(node.children); break;
    }
  }
  return out;
}

function trimLeadingNewline(source: string, index: number): number {
  return source[index] === "\n" ? index + 1 : index;
}

function closeAliases(name: string): string[] {
  if (name === "centre" || name === "center") return ["centre", "center"];
  if (name === "s" || name === "strike") return ["s", "strike"];
  return [name];
}

/** Innermost open frame carrying any of `aliases`, or -1 when none is open. */
function findOpenFrame(stack: ContainerFrame[], aliases: string[]): number {
  for (let i = stack.length - 1; i >= 1; i--) {
    if (aliases.includes(stack[i].tag)) return i;
  }
  return -1;
}

function canonicalCloseKey(name: string): string {
  if (name === "center") return "centre";
  if (name === "strike") return "s";
  return name;
}

function hasFutureClose(source: string, tag: string, fromIndex: number): boolean {
  const lower = source.toLowerCase();
  return closeAliases(tag).some((alias) => lower.indexOf(`[/${alias}]`, fromIndex) !== -1);
}

function trimTrailingBlockNewline(frame: ContainerFrame): boolean {
  if (!BLOCK_TAGS.has(frame.tag)) return false;
  const last = frame.children[frame.children.length - 1];
  if (last && last.type === "text" && last.text.endsWith("\n")) {
    last.text = last.text.slice(0, -1);
    if (!last.text) frame.children.pop();
    return true;
  }
  return false;
}

/**
 * osu! allows nested bbcode inside a [box=...] title (e.g.
 * [box=[color=#fff]Hi[/color]]), so the title's own ']' must not end the tag.
 * Scans from just after `[box=` for the ']' that closes the box-open tag,
 * balancing inner brackets. Returns null if it never balances on this line.
 */
function scanBalancedBoxTitle(source: string, start: number): { title: string; end: number } | null {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\n") return null;
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      if (depth === 0) return { title: source.slice(start, i), end: i + 1 };
      depth -= 1;
    }
  }
  return null;
}

export function parseBBCode(source: string, options?: { spans?: boolean }): BBNode[] {
  const normalized = source.replace(/\r\n?/g, "\n");
  const root: ContainerFrame = { tag: "", param: null, children: [], openSource: "", openStart: 0 };
  const stack: ContainerFrame[] = [root];
  const top = () => stack[stack.length - 1];
  // Delayed closers left over from crossed tags (see the unwind loop below),
  // queued per canonical tag name. The value is the node whose own closer the
  // serializer emits last at that spot, so a newline trimmed after the delayed
  // closer gets recorded there instead of being dropped. Null when the crossing
  // fell back to literal recovery and there is no node to record on.
  const skippedCloses = new Map<string, (BBNode | null)[]>();

  let cursor = 0;
  TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TAG_PATTERN.exec(normalized)) !== null) {
    const [tagSource, slash, rawName, rawParam] = match;
    const name = rawName.toLowerCase();
    const isClose = slash === "/";

    const emitLiteral = () => {
      pushText(top().children, normalized.slice(cursor, match!.index + tagSource.length), cursor);
      cursor = TAG_PATTERN.lastIndex;
    };

    // [*] - list item separator, only meaningful directly inside [list].
    if (name === "*") {
      const frame = top();
      if (!isClose && frame.tag === "list" && frame.items) {
        pushText(frame.children, normalized.slice(cursor, match.index), cursor);
        if (frame.children.length > 0) frame.items.push(frame.children);
        frame.children = [];
        cursor = trimLeadingNewline(normalized, TAG_PATTERN.lastIndex);
        TAG_PATTERN.lastIndex = cursor;
      } else {
        emitLiteral();
      }
      continue;
    }

    if (VERBATIM_TAGS.has(name)) {
      if (isClose) { emitLiteral(); continue; }
      const closeToken = `[/${name}]`;
      const closeAt = normalized.toLowerCase().indexOf(closeToken, TAG_PATTERN.lastIndex);
      if (closeAt === -1) { emitLiteral(); continue; }
      const content = normalized.slice(TAG_PATTERN.lastIndex, closeAt);
      const node = buildVerbatimNode(name, content, rawParam ?? null);
      if (!node) { emitLiteral(); continue; }
      pushText(top().children, normalized.slice(cursor, match.index), cursor);
      node.span = { start: match.index, end: closeAt + closeToken.length };
      top().children.push(node);
      cursor = closeAt + closeToken.length;
      if (BLOCK_TAGS.has(name)) {
        const trimmed = trimLeadingNewline(normalized, cursor);
        const afterOpen = content.startsWith("\n");
        attachSpacing(node, {
          afterOpen,
          beforeClose: (afterOpen ? content.slice(1) : content).endsWith("\n"),
          afterClose: trimmed !== cursor,
        });
        cursor = trimmed;
      }
      TAG_PATTERN.lastIndex = cursor;
      continue;
    }

    if (!CONTAINER_TAGS.has(name)) { emitLiteral(); continue; }

    if (!isClose) {
      // A tag that cannot nest is only a tag while none of its own is open.
      if (!NESTABLE_TAGS.has(name) && findOpenFrame(stack, closeAliases(name)) !== -1) {
        emitLiteral();
        continue;
      }
      const frame = openContainer(name, rawParam ?? null, tagSource, match.index);
      if (!frame) { emitLiteral(); continue; }
      let openEnd = TAG_PATTERN.lastIndex;
      // A box title can hold nested bbcode whose ']' must not end the open tag.
      if (name === "box" && rawParam != null && rawParam.includes("[")) {
        const titleStart = match.index + 1 + rawName.length + 1;
        const scan = scanBalancedBoxTitle(normalized, titleStart);
        if (scan && scan.end > openEnd) {
          frame.param = scan.title;
          frame.openSource = normalized.slice(match.index, scan.end);
          openEnd = scan.end;
        }
      }
      pushText(top().children, normalized.slice(cursor, match.index), cursor);
      stack.push(frame);
      cursor = openEnd;
      if (BLOCK_TAGS.has(name)) {
        const trimmed = trimLeadingNewline(normalized, cursor);
        frame.afterOpenTrimmed = trimmed !== cursor;
        cursor = trimmed;
      }
      TAG_PATTERN.lastIndex = cursor;
      continue;
    }

    // Closing tag: find the matching open frame (centre/center and s/strike
    // alias each other).
    const openIndex = findOpenFrame(stack, closeAliases(name));
    if (openIndex === -1) {
      const skipKey = canonicalCloseKey(name);
      const pending = skippedCloses.get(skipKey);
      if (pending && pending.length > 0) {
        const owner = pending.shift()!;
        if (pending.length === 0) skippedCloses.delete(skipKey);
        pushText(top().children, normalized.slice(cursor, match.index), cursor);
        cursor = TAG_PATTERN.lastIndex;
        if (BLOCK_TAGS.has(name)) {
          const trimmed = trimLeadingNewline(normalized, cursor);
          if (trimmed !== cursor && owner && "spacing" in owner && owner.spacing) {
            owner.spacing.afterClose = true;
          }
          cursor = trimmed;
        }
        TAG_PATTERN.lastIndex = cursor;
      } else {
        emitLiteral();
      }
      continue;
    }

    const closeEnd = match.index + tagSource.length;
    pushText(top().children, normalized.slice(cursor, match.index), cursor);
    cursor = TAG_PATTERN.lastIndex;
    let afterCloseTrimmed = false;
    if (BLOCK_TAGS.has(name)) {
      const trimmed = trimLeadingNewline(normalized, cursor);
      afterCloseTrimmed = trimmed !== cursor;
      cursor = trimmed;
    }
    TAG_PATTERN.lastIndex = cursor;

    // Unwind frames above the match. osu!'s renderer tolerates crossed tags
    // when the delayed inner closer still appears later, so close those frames
    // here and skip their future closer. If no delayed closer exists, keep the
    // old literal-preserving recovery for truly dangling tags.
    const delayedKeys: string[] = [];
    while (stack.length - 1 > openIndex) {
      const dangling = stack.pop()!;
      const parent = top();
      const node = hasFutureClose(normalized, dangling.tag, cursor) ? closeContainer(dangling) : null;
      if (node) {
        attachSpacing(node, {
          afterOpen: dangling.afterOpenTrimmed ?? false,
          beforeClose: trimTrailingBlockNewline(dangling),
          afterClose: false,
        });
        node.span = { start: dangling.openStart, end: match.index };
        parent.children.push(node);
        delayedKeys.push(canonicalCloseKey(dangling.tag));
      } else {
        pushText(parent.children, dangling.openSource, dangling.openStart);
        pushNodes(parent.children, dangling.children);
      }
    }
    const frame = stack.pop()!;
    // Trim one trailing newline inside a closing block for tighter output
    // (frame.children is the pending last item when the frame is a [list]).
    const beforeCloseTrimmed = trimTrailingBlockNewline(frame);
    const node = closeContainer(frame);
    const parent = top();
    if (node) {
      attachSpacing(node, {
        afterOpen: frame.afterOpenTrimmed ?? false,
        beforeClose: beforeCloseTrimmed,
        afterClose: afterCloseTrimmed,
      });
      node.span = { start: frame.openStart, end: closeEnd };
      parent.children.push(node);
    } else {
      pushText(parent.children, frame.openSource, frame.openStart);
      pushNodes(parent.children, frame.children);
      pushText(parent.children, tagSource, match.index);
    }
    // This frame's closer is the last one the serializer writes for the crossed
    // group, so it owns whatever the delayed closers trim after themselves.
    for (const key of delayedKeys) {
      const queue = skippedCloses.get(key);
      if (queue) queue.push(node);
      else skippedCloses.set(key, [node]);
    }
  }

  pushText(top().children, normalized.slice(cursor), cursor);

  // Unwind unclosed frames at EOF the same way.
  while (stack.length > 1) {
    const dangling = stack.pop()!;
    const parent = top();
    pushText(parent.children, dangling.openSource, dangling.openStart);
    pushNodes(parent.children, dangling.children);
  }

  if (!options?.spans) stripSpans(root.children);
  return root.children;
}

/**
 * True when `source` holds at least one recognized BBCode tag (anything the
 * parser turns into a non-text node). Plain prose - even with stray brackets or
 * a bare URL, which the parser leaves as text - returns false, so a paste
 * handler can tell "raw BBCode to render" apart from "ordinary text". The
 * outermost recognized construct always lands at the top level, so checking the
 * top-level nodes is enough.
 */
export function containsBBCode(source: string): boolean {
  return parseBBCode(source).some((node) => node.type !== "text");
}

function stripSpans(nodes: BBNode[]) {
  for (const node of nodes) {
    delete node.span;
    if (node.type === "list") node.items.forEach(stripSpans);
    else if ("children" in node) stripSpans(node.children);
  }
}

/**
 * Innermost-first is the caller's job: returns the chain of nodes whose source
 * spans contain `offset` (outermost first), so the editor can map a caret
 * position in the raw source to the rendered preview. Requires a tree parsed
 * with `{ spans: true }`.
 */
export function findBBNodePathAtOffset(nodes: BBNode[], offset: number): BBNode[] {
  for (const node of nodes) {
    const span = node.span;
    if (!span || offset < span.start || offset > span.end) continue;
    const childLists = node.type === "list" ? node.items : "children" in node ? [node.children] : [];
    for (const children of childLists) {
      const childPath = findBBNodePathAtOffset(children, offset);
      if (childPath.length > 0) return [node, ...childPath];
    }
    return [node];
  }
  return [];
}

const GRADIENT_HEX_PATTERN = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;

export function normalizeHexColor(value: string): string | null {
  const match = GRADIENT_HEX_PATTERN.exec(value.trim());
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return `#${hex.toUpperCase()}`;
}

function parseHexChannels(hex: string): readonly [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ] as const;
}

/**
 * Per-character colors for a gradient over `text`: one entry per character,
 * null for whitespace (it has no glyph to color). The ramp interpolates
 * piecewise-linearly across the given stops over visible characters only, so
 * spacing stays even. `mirror` ping-pongs the ramp (A->B becomes A->B->A) -
 * the shape behind most "glow from the middle" profile titles.
 * Returns null when any stop isn't a valid hex color.
 */
export function gradientCharColors(
  text: string,
  stops: string[],
  mirror = false,
): Array<string | null> | null {
  const normalized = stops.map(normalizeHexColor);
  if (normalized.length === 0 || normalized.some((stop) => stop === null)) return null;
  let ramp = normalized as string[];
  if (mirror && ramp.length > 1) ramp = ramp.concat(ramp.slice(0, -1).reverse());

  const chars = Array.from(text);
  const visibleCount = chars.filter((char) => !/\s/.test(char)).length;
  if (visibleCount === 0) return chars.map(() => null);

  const channels = ramp.map(parseHexChannels);
  const colorAt = (visibleIndex: number): string => {
    if (channels.length === 1 || visibleCount === 1) return ramp[0];
    const t = (visibleIndex / (visibleCount - 1)) * (channels.length - 1);
    const segment = Math.min(channels.length - 2, Math.floor(t));
    const frac = t - segment;
    const mix = (index: 0 | 1 | 2) => Math.round(
      channels[segment][index] + (channels[segment + 1][index] - channels[segment][index]) * frac,
    ).toString(16).padStart(2, "0").toUpperCase();
    return `#${mix(0)}${mix(1)}${mix(2)}`;
  };

  let visibleSeen = 0;
  return chars.map((char) => {
    if (/\s/.test(char)) return null;
    const color = colorAt(visibleSeen);
    visibleSeen += 1;
    return color;
  });
}

/**
 * Per-character [color] gradient, the trick behind rainbow usernames on osu!
 * profiles. Takes 2+ color stops; `mirror` runs the ramp out and back again.
 */
export function buildGradientBBCode(text: string, stops: string[], mirror = false): string {
  const colors = gradientCharColors(text, stops, mirror);
  if (!colors) return text;
  return Array.from(text)
    .map((char, index) => {
      const color = colors[index];
      return color ? `[color=${color}]${char}[/color]` : char;
    })
    .join("");
}

function rgbToHsl(r: number, g: number, b: number): readonly [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0));
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): readonly [number, number, number] {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const hue = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(channel(hue + 1 / 3) * 255), Math.round(channel(hue) * 255), Math.round(channel(hue - 1 / 3) * 255)];
}

/** Rotates a hex color's hue by `degrees`, keeping saturation and lightness. */
export function shiftHexHue(value: string, degrees: number): string | null {
  const hex = normalizeHexColor(value);
  if (!hex) return null;
  const [r, g, b] = parseHexChannels(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const [nr, ng, nb] = hslToRgb(h + degrees, s, l);
  const to = (c: number) => c.toString(16).padStart(2, "0").toUpperCase();
  return `#${to(nr)}${to(ng)}${to(nb)}`;
}
