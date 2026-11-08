import { describe, expect, it } from "vitest";

import { collectBugReportContext, describeHashiReport, normalizeBugReportSourcePath } from "./bug-report-context";

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

describe("hashi reports", () => {
  it("reads the app's details and leaves site reports alone", () => {
    const context = {
      hashi: "0.1.9", os: "windows", arch: "x64", osuClient: "stable", tosu: "connected",
      connection: "connected", sendPlays: true, waitingReplay: 2,
    };
    expect(describeHashiReport("/hashi", context)).toEqual({
      version: "0.1.9",
      details: ["Windows x64", "osu!stable", "tosu connected", "Mania Tracker connected", "send plays on", "waiting replay 2"],
    });
    expect(describeHashiReport("/hashi", { userAgent: "Mozilla/5.0", locale: "en" })).toBeNull();
    expect(describeHashiReport("/players", context)).toBeNull();
  });
});
