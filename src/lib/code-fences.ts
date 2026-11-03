/** A run of message text: plain words, a fenced code block, or inline code. */
export type CodeSegment =
  | { kind: "text"; text: string }
  | { kind: "block"; code: string; lang: string | null }
  | { kind: "inline"; code: string };

const FENCE = /```([\s\S]*?)```/g;
const INLINE = /`([^`\n]+)`/g;
const LANG_LINE = /^[\w+#.-]{1,20}$/;

/**
 * Split a message on Markdown-style code: ```fenced``` blocks (an optional
 * language name on the opening line) and `inline` spans. An unclosed fence
 * stays plain text. The line break on either side of a block is dropped,
 * since the block already sits on its own lines.
 */
export function splitCode(text: string): CodeSegment[] {
  const segments: CodeSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(FENCE)) {
    const start = match.index;
    let inner = match[1]!;
    let lang: string | null = null;
    const firstBreak = inner.indexOf("\n");
    if (firstBreak >= 0) {
      const first = inner.slice(0, firstBreak).trim();
      if (!first || LANG_LINE.test(first)) {
        lang = first || null;
        inner = inner.slice(firstBreak + 1);
      }
    }
    inner = inner.replace(/\n$/, "");
    if (!inner.trim()) continue;
    pushText(segments, text.slice(cursor, start).replace(/\n$/, ""));
    segments.push({ kind: "block", code: inner, lang });
    cursor = start + match[0].length;
    if (text[cursor] === "\n") cursor += 1;
  }
  pushText(segments, text.slice(cursor));
  return segments;
}

function pushText(segments: CodeSegment[], text: string) {
  let cursor = 0;
  for (const match of text.matchAll(INLINE)) {
    if (!match[1]!.trim()) continue;
    if (match.index > cursor) segments.push({ kind: "text", text: text.slice(cursor, match.index) });
    segments.push({ kind: "inline", code: match[1]! });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
}
