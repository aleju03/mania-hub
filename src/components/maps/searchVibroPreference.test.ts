// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { readSearchVibroPreference, savedSearchVibroToRestore, writeSearchVibroPreference } from "./searchVibroPreference";

beforeEach(() => {
  localStorage.clear();
});

describe("search vibro preference storage", () => {
  it("round-trips and clears", () => {
    writeSearchVibroPreference("hide");
    expect(readSearchVibroPreference()).toBe("hide");
    writeSearchVibroPreference("");
    expect(readSearchVibroPreference()).toBe("");
  });

  it("ignores unknown stored values", () => {
    localStorage.setItem("mania-hub-maps-search-vibro-v1", "sideways");
    expect(readSearchVibroPreference()).toBe("");
  });

  it("restores only over a URL without a vibro setting", () => {
    expect(savedSearchVibroToRestore("")).toBe(false);
    writeSearchVibroPreference("hide");
    expect(savedSearchVibroToRestore("")).toBe(true);
    expect(savedSearchVibroToRestore("only")).toBe(false);
  });
});
