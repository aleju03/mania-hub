import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The global `i18n` singleton from @lingui/core is mutable: activate() during
// one SSR render would leak that request's locale into every concurrent
// render. All message resolution must flow through getI18n(locale) in
// src/lib/i18n.ts (per-locale immutable instances) or the React context via
// useLingui()/<Trans>. This test walks src and fails on any other import of
// the singleton. Macro imports (@lingui/core/macro, @lingui/react/macro) are
// fine - they compile away to context- or instance-bound calls.
const SRC_ROOT = join(__dirname, "..");
const ALLOWED = new Set([join(SRC_ROOT, "lib", "i18n.ts")]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// Matches `from "@lingui/core"` exactly - not "@lingui/core/macro".
const SINGLETON_IMPORT = /from\s+["']@lingui\/core["']/;
// The singleton itself is only reachable as a named import called i18n.
const SINGLETON_NAME = /\bi18n\b/;

describe("lingui global singleton", () => {
  it("is only imported by src/lib/i18n.ts", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (ALLOWED.has(file)) continue;
      const text = readFileSync(file, "utf8");
      if (!SINGLETON_IMPORT.test(text)) continue;
      for (const line of text.split("\n")) {
        if (SINGLETON_IMPORT.test(line) && SINGLETON_NAME.test(line)) {
          offenders.push(file);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
