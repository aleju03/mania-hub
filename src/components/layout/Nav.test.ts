import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { freshMapsSearch } from "./Nav";

describe("mobile navigation translations", () => {
  it("renders the visible settings label through Lingui", () => {
    const source = readFileSync(resolve(__dirname, "Nav.tsx"), "utf8");

    expect(source).toMatch(/<Settings className="h-5 w-5" strokeWidth=\{2\.1\} \/>\s*\{t`Settings`\}/);
  });
});

describe("maps navigation search", () => {
  it("starts with only the selected country instead of inheriting the current route's filters", () => {
    expect(freshMapsSearch("GLOBAL")).toEqual({ country: "GLOBAL" });
  });
});
