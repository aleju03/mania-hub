import { describe, expect, it } from "vitest";
import { packCollectorParam } from "./live-backend";

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
});
