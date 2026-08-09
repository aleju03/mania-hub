/** A run of plain text, or a URL that should render as an anchor. */
export type LinkifySegment =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string };

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

/** Punctuation that ends a sentence rather than the URL it trails. */
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * User text writes "(see https://osu.ppy.sh/s/123)" and "…topics/2097901." as
 * often as it writes a bare URL, so walk the tail back off anything that is
 * punctuation of the sentence rather than of the link. A closing bracket only
 * belongs to the URL when the URL opened it too.
 */
function trimUrlTail(url: string): string {
  let out = url;
  for (;;) {
    const stripped = out.replace(TRAILING_PUNCTUATION, "");
    if (stripped !== out && stripped.length > 0) {
      out = stripped;
      continue;
    }
    const last = out.at(-1);
    const opener = last ? CLOSERS[last] : undefined;
    if (!opener) return out;
    const opened = out.split(opener).length - 1;
    const closed = out.split(last!).length - 1;
    if (opened >= closed) return out;
    out = out.slice(0, -1);
  }
}

/**
 * Split free text into plain runs and http(s) links. Bare `www.` hosts get an
 * `https://` href so the anchor does not resolve relative to the site.
 */
export function linkify(text: string): LinkifySegment[] {
  const segments: LinkifySegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const start = match.index;
    const url = trimUrlTail(raw);
    if (!url) continue;
    if (start > cursor) segments.push({ kind: "text", text: text.slice(cursor, start) });
    segments.push({
      kind: "link",
      text: url,
      href: /^www\./i.test(url) ? `https://${url}` : url,
    });
    cursor = start + url.length;
  }

  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}
