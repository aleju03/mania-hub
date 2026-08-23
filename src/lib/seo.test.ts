import { describe, expect, it } from "vitest";
import { OG_IMAGE_VERSION, pageSeo, uploadedReplayOgImagePath } from "./seo";

function ogImageOf(seo: ReturnType<typeof pageSeo>): string {
  const entry = seo.meta.find((m) => "property" in m && m.property === "og:image");
  return entry && "content" in entry ? entry.content : "";
}

// The page title only enters the OG URL (and so the R2 cache key) on the
// country-scoreboard card: country set, no kind. That is the one path where a
// localized title would fork the cache and bake CJK into a card whose font
// has no CJK glyphs, and the path imageTitle exists for.
describe("pageSeo imageTitle", () => {
  it("keys the country card off the English imageTitle while the page title localizes", () => {
    const en = pageSeo({
      title: "Top mania plays in Germany",
      imageCountry: "DE",
      path: "/top-plays",
      origin: "https://x.test",
    });
    const zh = pageSeo({
      title: "德国的 mania 顶级成绩",
      imageTitle: "Top mania plays in Germany",
      imageCountry: "DE",
      path: "/top-plays",
      origin: "https://x.test",
    });
    expect(ogImageOf(en)).toContain("Top+mania+plays");
    expect(ogImageOf(zh)).toBe(ogImageOf(en));
    expect(zh.meta).toContainEqual({ title: "德国的 mania 顶级成绩 - Mania Tracker" });
  });

  it("falls back to the title when no imageTitle is given", () => {
    const seo = pageSeo({
      title: "Top mania plays in Germany",
      imageCountry: "DE",
      path: "/top-plays",
      origin: "https://x.test",
    });
    expect(ogImageOf(seo)).toContain("Top+mania+plays+in+Germany");
  });
});

describe("uploadedReplayOgImagePath", () => {
  it("keys a replay image by the public upload id", () => {
    expect(uploadedReplayOgImagePath("abc_DEF-1234567890")).toBe(
      `/api/og?kind=uploaded-replay&v=${OG_IMAGE_VERSION}&uploadId=abc_DEF-1234567890`,
    );
  });
});
