import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("OG preview admin page", () => {
  it("loads any site URL and previews the route's rendered OG metadata", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "admin/og-preview.tsx"), "utf8");

    expect(source).toContain('label: "Page URL"');
    expect(source).toContain("sitePreviewRequestUrl(pageUrl");
    expect(source).toContain("parseOgPagePreview(await response.text()");
    expect(source).toContain('if (kind === "page-url")');
    expect(source).toContain("cacheBustOgPreviewImage(pagePreview.imageUrl");
    expect(source).toContain('placeholder="http://localhost:3000/replay?uploadId=..."');
  });
});
