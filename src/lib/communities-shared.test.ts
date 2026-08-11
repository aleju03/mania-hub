import { describe, expect, it } from "vitest";
import {
  accessScopeLabel,
  communityFeatureLabels,
  countryMatchesAccessScopes,
  describeAccessScopes,
  discordSnowflakeDate,
} from "./communities-shared";

describe("when a Discord server was made", () => {
  it("reads the date out of the guild id", () => {
    // Discord's own documented example snowflake, 2016-04-30T11:18:25.796Z.
    expect(discordSnowflakeDate("175928847299117063")?.toISOString()).toBe("2016-04-30T11:18:25.796Z");
  });

  it("puts the epoch itself at Discord's start rather than 1970", () => {
    expect(discordSnowflakeDate("0")?.toISOString()).toBe("2015-01-01T00:00:00.000Z");
  });

  it("says nothing for an id that is not a snowflake", () => {
    expect(discordSnowflakeDate("guild-1")).toBeNull();
    expect(discordSnowflakeDate("")).toBeNull();
    expect(discordSnowflakeDate(null)).toBeNull();
    // Far enough in the future to be a malformed id rather than a date.
    expect(discordSnowflakeDate("99999999999999999999")).toBeNull();
  });
});

describe("the places a server is for", () => {
  it("names a country and a region the same way", () => {
    expect(accessScopeLabel("FR")).toBe("France");
    expect(accessScopeLabel("R-CAMERICA")).toBe("Central America");
  });

  it("says who it is for in the room a pill has", () => {
    expect(describeAccessScopes(["FR"])).toBe("France only");
    expect(describeAccessScopes(["FR", "BE"])).toBe("France and Belgium");
    // Past two it counts: a pill is not the place for a list of seven.
    expect(describeAccessScopes(["FR", "BE", "CH", "LU"])).toBe("France and 3 more");
    expect(describeAccessScopes([])).toBeNull();
    expect(describeAccessScopes(undefined)).toBeNull();
  });

  it("counts a region as every country in it", () => {
    expect(countryMatchesAccessScopes(["R-CAMERICA"], "CR")).toBe(true);
    expect(countryMatchesAccessScopes(["R-CAMERICA"], "FR")).toBe(false);
    expect(countryMatchesAccessScopes(["FR"], "fr")).toBe(true);
  });

  it("lets everyone through an empty list and nobody through without a country", () => {
    expect(countryMatchesAccessScopes([], "CR")).toBe(true);
    expect(countryMatchesAccessScopes(undefined, null)).toBe(true);
    expect(countryMatchesAccessScopes(["FR"], null)).toBe(false);
    expect(countryMatchesAccessScopes(["FR"], "")).toBe(false);
  });
});

describe("the badges a listing page shows", () => {
  it("keeps the few that mean something and drops the rest", () => {
    expect(communityFeatureLabels(["COMMUNITY", "ROLE_SUBSCRIPTIONS_ENABLED", "PARTNERED"])).toEqual([
      "Community server",
      "Discord partner",
    ]);
    expect(communityFeatureLabels(undefined)).toEqual([]);
  });
});
