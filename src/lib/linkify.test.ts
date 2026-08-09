import { describe, expect, it } from "vitest";
import { linkify } from "./linkify";

describe("linkify", () => {
  it("leaves text without links as a single run", () => {
    expect(linkify("note taken from bojii's circle")).toEqual([
      { kind: "text", text: "note taken from bojii's circle" },
    ]);
    expect(linkify("")).toEqual([]);
  });

  it("splits a url out of the surrounding text", () => {
    expect(linkify("UI taken from https://osu.ppy.sh/community/forums/topics/2097901?n=1 made by X")).toEqual([
      { kind: "text", text: "UI taken from " },
      {
        kind: "link",
        text: "https://osu.ppy.sh/community/forums/topics/2097901?n=1",
        href: "https://osu.ppy.sh/community/forums/topics/2097901?n=1",
      },
      { kind: "text", text: " made by X" },
    ]);
  });

  it("gives bare www hosts an absolute href", () => {
    expect(linkify("www.osu.ppy.sh")).toEqual([
      { kind: "link", text: "www.osu.ppy.sh", href: "https://www.osu.ppy.sh" },
    ]);
  });

  it("keeps sentence punctuation out of the link", () => {
    expect(linkify("from https://osu.ppy.sh/s/123.")).toEqual([
      { kind: "text", text: "from " },
      { kind: "link", text: "https://osu.ppy.sh/s/123", href: "https://osu.ppy.sh/s/123" },
      { kind: "text", text: "." },
    ]);
    expect(linkify("(see https://osu.ppy.sh/s/123)")).toEqual([
      { kind: "text", text: "(see " },
      { kind: "link", text: "https://osu.ppy.sh/s/123", href: "https://osu.ppy.sh/s/123" },
      { kind: "text", text: ")" },
    ]);
  });

  it("keeps brackets the url opened itself", () => {
    const url = "https://en.wikipedia.org/wiki/Osu!(video_game)";
    expect(linkify(url)).toEqual([{ kind: "link", text: url, href: url }]);
  });

  it("finds several links across lines", () => {
    const segments = linkify("a https://one.example\nb http://two.example c");
    expect(segments.filter((s) => s.kind === "link").map((s) => s.text)).toEqual([
      "https://one.example",
      "http://two.example",
    ]);
    expect(segments.map((s) => s.text).join("")).toBe("a https://one.example\nb http://two.example c");
  });

  it("does not treat a scheme-less word as a link", () => {
    expect(linkify("mixed by Mon3trMiku")).toEqual([{ kind: "text", text: "mixed by Mon3trMiku" }]);
  });
});
