import { describe, expect, it } from "vitest";

import { describeOsuCaller, describeOsuPath } from "./osu-api-callers";

describe("describeOsuCaller", () => {
  it("names the callers that dominate the budget", () => {
    const top = describeOsuCaller("job:refresh_user_top_scores");
    expect(top.title).toBe("Top plays refresh");
    expect(top.origin).toBe("job");
    expect(describeOsuCaller("getUserScores:pinned").origin).toBe("page");
    expect(describeOsuCaller("osu_scores_fallback").origin).toBe("ingest");
    expect(describeOsuCaller("dan_classifier_admin").origin).toBe("admin");
  });

  it("reads a paged top-scores window as one caller", () => {
    expect(describeOsuCaller("fetchUserBestScoresWindow:p3").title).toBe("Player's top scores, page 3");
  });

  it("keeps an unlisted suffix attached to its known base caller", () => {
    const label = describeOsuCaller("job:refresh_user_top_scores:something_new");
    expect(label.title).toBe("Top plays refresh (Something new)");
    expect(label.origin).toBe("job");
  });

  it("falls back to a prettified tag with the right origin", () => {
    expect(describeOsuCaller("job:brand_new_sweep")).toMatchObject({ title: "Brand new sweep", origin: "job" });
    expect(describeOsuCaller("api:brand_new").origin).toBe("page");
    expect(describeOsuCaller("getSomethingNew")).toMatchObject({ title: "Get something new", origin: "page" });
    expect(describeOsuCaller("unknown").origin).toBe("other");
  });
});

describe("describeOsuPath", () => {
  it("reads score list paths", () => {
    expect(describeOsuPath("/users/22217613/scores/best?mode=mania&limit=100&offset=0")).toEqual({
      title: "Top 100",
      subject: "player 22217613",
    });
    expect(describeOsuPath("/users/37636310/scores/recent?mode=mania&include_fails=1").title).toBe("Recent plays");
  });

  it("uses resolved names when the backend supplied them", () => {
    const names = { users: { "39867808": "Rii" }, beatmaps: { "4119474": "Camellia - Ghost [Insane]" } };
    expect(describeOsuPath("/users/39867808/mania", names)).toEqual({ title: "Player profile", subject: "Rii" });
    expect(describeOsuPath("/beatmaps/4119474", names).subject).toBe("Camellia - Ghost [Insane]");
  });

  it("separates a replay download from a score lookup", () => {
    expect(describeOsuPath("/scores/2316113892")).toEqual({ title: "Score details", subject: "score 2316113892" });
    expect(describeOsuPath("/scores/mania/2316113892/download").title).toBe("Replay download");
    expect(describeOsuPath("/scores?mode=mania&limit=50").title).toBe("Global recent scores (feed fallback)");
  });

  it("keeps the source marker on mirrored map files", () => {
    expect(describeOsuPath("catboy:/osu/4119474").title).toBe("Map file (.osu) (catboy)");
  });

  it("surfaces what a search was for", () => {
    expect(describeOsuPath("/beatmapsets/search?m=3&q=camellia")).toEqual({ title: "Map search", subject: '"camellia"' });
    expect(describeOsuPath("/rankings/mania/performance?country=CR&page=2").subject).toBe("CR, page 2");
  });
});
