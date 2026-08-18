import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/* Every page here is server-rendered and then hydrated, so a locale-dependent
   string has to come out identical on both sides. `(12345).toLocaleString()`
   does not: it takes Node's locale on the server and the visitor's in the
   browser, so anyone whose locale groups digits with dots hydrated "12.345"
   over an SSR "12,345" and React threw a recoverable #418 at that node. It cost
   ~10% of /goals views before the current-pp tile was pinned.

   The site formats in en-US everywhere (src/lib/format.ts), so the rule is that
   the locale is always written down rather than inherited from whatever machine
   is running the code. A call that genuinely wants the visitor's locale, and can
   prove it never renders during SSR, can say so with a `locale-ok:` note. */

const SRC = path.resolve(__dirname);
const SELF = path.basename(__filename);

const BANNED = [
  // No locale at all.
  /\.toLocale(?:Date|Time)?String\(\s*\)/,
  /new Intl\.(?:NumberFormat|DateTimeFormat|RelativeTimeFormat|ListFormat|PluralRules|Collator)\(\s*\)/,
  // An explicit undefined is the same thing spelled out.
  /\.toLocale(?:Date|Time)?String\(\s*undefined\b/,
  /new Intl\.(?:NumberFormat|DateTimeFormat|RelativeTimeFormat|ListFormat|PluralRules|Collator)\(\s*undefined\b/,
];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name)) return [];
    // Tests do not hydrate, and this file spells the banned forms out.
    if (/\.test\.tsx?$/.test(entry.name) || entry.name === SELF) return [];
    return [full];
  });
}

/* Comment text is not a call: the fixes themselves explain the bare form in
   prose, and a rule that cannot survive being described is not worth keeping. */
function stripComments(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//")) return "";
  return line.replace(/\/\/.*$/, "");
}

describe("locale-dependent formatting", () => {
  it("never leaves the locale to the machine that happens to run the code", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((raw, index) => {
        // Read the opt-out off the raw line: it lives in the comment that
        // stripComments is about to throw away.
        if (raw.includes("locale-ok:")) return;
        const line = stripComments(raw);
        if (!BANNED.some((pattern) => pattern.test(line))) return;
        offenders.push(`${path.relative(SRC, file)}:${index + 1}  ${raw.trim()}`);
      });
    }

    expect(
      offenders,
      `Pass a locale ("en-US" unless there is a reason not to), or mark the line \`// locale-ok: <why this never renders during SSR>\`:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
