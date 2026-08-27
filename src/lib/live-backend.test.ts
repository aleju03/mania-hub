import { describe, expect, it } from "vitest";
import {
  packCollectorLabel,
  packCollectorLookupSpecs,
  packCollectorParam,
  parsePackCollectorParam,
} from "./live-backend";

describe("packCollectorParam", () => {
  it("links by name, which is what people paste", () => {
    expect(packCollectorParam({ userId: 2531335, username: "Aleju03" })).toBe("Aleju03");
  });

  it("links by id when the collector is only labelled `user <id>`", () => {
    // The placeholder the backend prints for a collector it cannot name. It
    // resolves to nobody, so the shelf 404s as "has not opened a pack".
    expect(packCollectorParam({ userId: 16308062, username: "user 16308062" })).toBe("16308062");
  });

  it("keeps a real name that only looks like the placeholder", () => {
    expect(packCollectorParam({ userId: 99, username: "user 16308062" })).toBe("user 16308062");
  });

  it("falls back to the id on an empty name", () => {
    expect(packCollectorParam({ userId: 7, username: "" })).toBe("7");
  });

  it("marks numeric-only usernames so they are not mistaken for ids", () => {
    expect(packCollectorParam({ userId: 12345678, username: "080106" })).toBe("name:080106");
  });
});

describe("parsePackCollectorParam", () => {
  it("keeps legacy numeric links as ids", () => {
    expect(parsePackCollectorParam("2531335")).toEqual({ userId: 2531335 });
    expect(packCollectorLookupSpecs("2531335")).toEqual([
      { userId: 2531335 },
      { username: "2531335" },
    ]);
  });

  it("resolves explicitly marked numeric usernames by name", () => {
    expect(parsePackCollectorParam("name:080106")).toEqual({ username: "080106" });
    expect(packCollectorLookupSpecs("name:080106")).toEqual([{ username: "080106" }]);
    expect(packCollectorLabel("name:080106")).toBe("080106");
  });

  it("continues resolving ordinary usernames by name", () => {
    expect(parsePackCollectorParam("Aleju03")).toEqual({ username: "Aleju03" });
  });
});
