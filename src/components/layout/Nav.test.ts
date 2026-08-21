import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("mobile navigation translations", () => {
  it("renders the visible settings label through Lingui", () => {
    const source = readFileSync(resolve(__dirname, "Nav.tsx"), "utf8");

    expect(source).toMatch(/<Settings className="h-5 w-5" strokeWidth=\{2\.1\} \/>\s*\{t`Settings`\}/);
  });
});
