import { describe, expect, it } from "vitest";

import { collectBugReportContext, normalizeBugReportSourcePath } from "./bug-report-context";

describe("bug report context", () => {
  it("keeps a local source path while stripping private search and hash state", () => {
    expect(normalizeBugReportSourcePath("/tracker?country=CR#row-1")).toBe("/tracker");
    expect(normalizeBugReportSourcePath("/report")).toBeUndefined();
    expect(normalizeBugReportSourcePath("//evil.example/path")).toBeUndefined();
    expect(normalizeBugReportSourcePath("https://evil.example/path")).toBeUndefined();
  });

  it("is SSR-stable when browser globals do not exist", () => {
    const context = collectBugReportContext({ locale: "es", country: "CR" });
    expect(context.locale).toBe("es");
    expect(context.country).toBe("CR");
    expect(context).not.toHaveProperty("viewport");
    expect(context).not.toHaveProperty("userAgent");
  });
});
