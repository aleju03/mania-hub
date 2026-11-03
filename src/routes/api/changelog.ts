import { createFileRoute } from "@tanstack/react-router";
import { UPDATES, type ChangelogUpdate } from "../../data/changelog";
import { changelogKind } from "../../lib/changelog";
import { getCanonicalOrigin } from "../../lib/origin";

// The newest changelog lines as JSON, for the Discord bot's Site updates feed.
// Each line gets a key that survives edits to its text: its date plus its place
// among that day's lines counted from the oldest, so fixing a typo or folding a
// fix into an existing line never reposts it, and a new line on the same day
// gets the next number.

const LIMIT = 30;

function absolute(origin: string, path: string | undefined): string | null {
  if (!path) return null;
  return /^https?:\/\//.test(path) ? path : `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
}

// The line as Discord markdown: its bold word bolded and its reference linked.
function markdown(update: Pick<ChangelogUpdate, "text" | "bold" | "emphasis" | "reference">): string {
  let text = update.text.replace(/([\\*_~`|])/g, "\\$1");
  for (const word of [update.bold, update.emphasis]) {
    if (word && text.includes(word)) text = text.replace(word, `**${word}**`);
  }
  if (update.reference && text.includes(update.reference.text)) {
    text = text.replace(update.reference.text, `[${update.reference.text}](${update.reference.href})`);
  }
  return text;
}

export const Route = createFileRoute("/api/changelog")({
  server: {
    handlers: {
      GET: ({ request }) => {
        // Not request.url: behind the proxy that origin is the internal http one.
        const origin = getCanonicalOrigin(request);
        const perDay = new Map<string, number>();
        for (const update of UPDATES) perDay.set(update.date, (perDay.get(update.date) ?? 0) + 1);
        const seen = new Map<string, number>();
        const entries = UPDATES.slice(0, LIMIT).map((update) => {
          const index = (seen.get(update.date) ?? 0) + 1;
          seen.set(update.date, index);
          const ordinal = (perDay.get(update.date) ?? index) - index + 1;
          const to = update.to ? `${update.to}${update.search ? `?${new URLSearchParams(update.search).toString()}` : ""}` : "/";
          return {
            key: `${update.date}#${ordinal}`,
            date: update.date,
            text: markdown(update),
            kind: changelogKind(update),
            image: absolute(origin, update.image?.src),
            more: (update.more ?? []).map((more) => ({ text: markdown({ text: more.text }), image: absolute(origin, more.image?.src) })),
            url: absolute(origin, to),
          };
        });
        return new Response(JSON.stringify({ entries }), {
          headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
        });
      },
    },
  },
});
