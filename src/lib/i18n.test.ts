import { describe, expect, it } from "vitest";
import { msg } from "@lingui/core/macro";
import { getI18n } from "./i18n";

// This file doubles as the macro canary for plain .ts (no JSX): the `msg`
// macro below only works if the babel pass in vitest.config.ts (and by the
// same plugin-react include filter, vite.config.ts) transforms .ts files.
// If this file fails to parse or `descriptor.id` is undefined, the macro
// wiring broke.
const descriptor = msg`i18n canary message`;

describe("lingui macro on plain .ts", () => {
  it("compiles msg descriptors outside JSX", () => {
    expect(descriptor.id).toBeTruthy();
    expect(descriptor.message).toBe("i18n canary message");
  });

  it("resolves through per-locale instances with source-string fallback", () => {
    const en = getI18n("en");
    expect(en._(descriptor)).toBe("i18n canary message");
    // zh-CN has no translation for the canary; the source string must come
    // back rather than an id or an empty string.
    const zh = getI18n("zh-CN");
    expect(zh._(descriptor)).toBe("i18n canary message");
  });

  it("returns the same shared instance per locale", () => {
    expect(getI18n("en")).toBe(getI18n("en"));
    expect(getI18n("zh-CN")).not.toBe(getI18n("en"));
  });
});
