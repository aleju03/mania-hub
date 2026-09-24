// @vitest-environment jsdom
//
// sessionStorage backs the name a link hands to the team pageview.
import { describe, expect, it } from "vitest";

import { getTeamDetailPageviewProperties, rememberTeamName, teamIdFromPath } from "./analytics-teams";

describe("team detail pageviews", () => {
  it("pulls the numeric id out of the path", () => {
    expect(teamIdFromPath("/team/12345")).toBe("12345");
    expect(teamIdFromPath("/team/abc")).toBe("");
    expect(teamIdFromPath("/teams")).toBe("");
  });

  it("carries the name a link stashed, and copes without one", () => {
    expect(getTeamDetailPageviewProperties("/team/77")).toEqual({ team_id: "77" });

    rememberTeamName(77, "Seven Keys");
    expect(getTeamDetailPageviewProperties("/team/77")).toEqual({ team_id: "77", team_name: "Seven Keys" });
  });
});
