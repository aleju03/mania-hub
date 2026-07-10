import { describe, expect, it } from "vitest";
import {
  buildGradientBBCode,
  collectPlainText,
  containsBBCode,
  findBBNodePathAtOffset,
  gradientCharColors,
  normalizeHexColor,
  parseBBCode,
  parseYoutubeInput,
  shiftHexHue,
  type BBNode,
} from "./bbcode";

function single(source: string): BBNode {
  const nodes = parseBBCode(source);
  expect(nodes).toHaveLength(1);
  return nodes[0];
}

describe("parseBBCode", () => {
  it("parses plain text as a single text node", () => {
    expect(parseBBCode("hello world")).toEqual([{ type: "text", text: "hello world" }]);
  });

  it("parses inline style tags", () => {
    const node = single("[b]bold[/b]");
    expect(node).toEqual({ type: "style", tag: "b", children: [{ type: "text", text: "bold" }] });
  });

  it("treats [strike] as an alias of [s], including cross-closing", () => {
    expect(single("[strike]gone[/s]")).toEqual({
      type: "style", tag: "s", children: [{ type: "text", text: "gone" }],
    });
  });

  it("parses nested styles", () => {
    const node = single("[b][i]both[/i][/b]");
    expect(node.type).toBe("style");
    if (node.type !== "style") return;
    expect(node.children[0]).toEqual({
      type: "style", tag: "i", children: [{ type: "text", text: "both" }],
    });
  });

  it("parses color with hex and named values, rejects junk params", () => {
    expect(single("[color=#FFcc00]x[/color]")).toMatchObject({ type: "color", color: "#FFcc00" });
    expect(single("[color=red]x[/color]")).toMatchObject({ type: "color", color: "red" });
    expect(parseBBCode("[color=url(evil)]x[/color]")[0]).toEqual({
      type: "text", text: "[color=url(evil)]x[/color]",
    });
  });

  it("parses numeric size params and rejects non-numeric values", () => {
    expect(single("[size=85]small[/size]")).toMatchObject({ type: "size", size: 85 });
    expect(single("[size=500]big[/size]")).toMatchObject({ type: "size", size: 500 });
    expect(parseBBCode("[size=huge]big[/size]")[0]).toEqual({
      type: "text", text: "[size=huge]big[/size]",
    });
  });

  it("parses [url=...] and plain [url] with the href as content", () => {
    expect(single("[url=https://example.com]link[/url]")).toMatchObject({
      type: "url", href: "https://example.com",
    });
    expect(single("[url]https://example.com[/url]")).toMatchObject({
      type: "url", href: "https://example.com",
    });
  });

  it("rejects non-http url targets", () => {
    expect(parseBBCode("[url=javascript:alert(1)]x[/url]")[0]).toEqual({
      type: "text", text: "[url=javascript:alert(1)]x[/url]",
    });
  });

  it("parses email tags in both forms", () => {
    expect(single("[email=a@b.com]mail me[/email]")).toMatchObject({ type: "email", address: "a@b.com" });
    expect(single("[email]a@b.com[/email]")).toMatchObject({ type: "email", address: "a@b.com" });
  });

  it("parses profile links", () => {
    expect(single("[profile=7095193]Aleju03[/profile]")).toMatchObject({
      type: "profile", userId: "7095193",
    });
  });

  it("parses img/youtube/audio verbatim tags", () => {
    expect(single("[img]https://files.catbox.moe/e2oarc.png[/img]")).toEqual({
      type: "img", src: "https://files.catbox.moe/e2oarc.png",
    });
    expect(single("[youtube]dQw4w9WgXcQ[/youtube]")).toEqual({ type: "youtube", videoId: "dQw4w9WgXcQ" });
    expect(single("[audio]https://example.com/a.mp3[/audio]")).toEqual({
      type: "audio", src: "https://example.com/a.mp3",
    });
  });

  it("accepts blob: URLs for [img] (editor's deferred pasted images)", () => {
    expect(single("[img]blob:http://localhost:3000/abc-123[/img]")).toEqual({
      type: "img", src: "blob:http://localhost:3000/abc-123",
    });
    // blob: stays image-only: [url]/[audio] still reject it (falls back to text).
    expect(single("[audio]blob:http://localhost:3000/abc-123[/audio]")).toEqual({
      type: "text", text: "blob:http://localhost:3000/abc-123",
    });
  });

  it("accepts full YouTube URLs inside [youtube]", () => {
    expect(single("[youtube]https://www.youtube.com/watch?v=dQw4w9WgXcQ[/youtube]")).toEqual({
      type: "youtube", videoId: "dQw4w9WgXcQ",
    });
  });

  it("keeps BBCode inside [code] verbatim", () => {
    const node = single("[code]\n[b]not bold[/b]\n[/code]");
    expect(node).toMatchObject({ type: "code", inline: false, code: "[b]not bold[/b]" });
    expect(node).toMatchObject({ spacing: { afterOpen: true, beforeClose: true, afterClose: false } });
  });

  it("parses inline [c] code", () => {
    expect(single("[c]x = 1[/c]")).toEqual({ type: "code", inline: true, code: "x = 1" });
  });

  it("parses heading / notice / centre blocks, with centre-center aliasing", () => {
    expect(single("[heading]Title[/heading]")).toMatchObject({ type: "heading" });
    expect(single("[notice]note[/notice]")).toMatchObject({ type: "notice" });
    expect(single("[centre]mid[/center]")).toMatchObject({ type: "centre" });
  });

  it("parses quotes with and without author", () => {
    expect(single('[quote="peppy"]hi[/quote]')).toMatchObject({ type: "quote", author: "peppy" });
    expect(single("[quote]hi[/quote]")).toMatchObject({ type: "quote", author: null });
  });

  it("parses [box=title] and [spoilerbox]", () => {
    expect(single("[box=my box]content[/box]")).toMatchObject({ type: "box", title: "my box" });
    expect(single("[spoilerbox]content[/spoilerbox]")).toMatchObject({ type: "box", title: null });
  });

  it("keeps [box=] (empty title) distinct from [spoilerbox]", () => {
    expect(single("[box=]content[/box]")).toMatchObject({ type: "box", title: "" });
  });

  it("captures a balanced box title that contains nested bbcode", () => {
    // osu! allows e.g. [box=[color=#fff]Hi[/color]]; the inner ']' must not end
    // the open tag, and the body must not absorb the title's closing tags.
    expect(single("[box=[color=#69FFDC]Set-Up[/color]]content[/box]")).toMatchObject({
      type: "box",
      title: "[color=#69FFDC]Set-Up[/color]",
      children: [{ type: "text", text: "content" }],
    });
  });

  it("records which boundary newlines block tags trimmed", () => {
    expect(parseBBCode("[notice]\ncontent\n[/notice]\nafter")[0]).toMatchObject({
      type: "notice",
      spacing: { afterOpen: true, beforeClose: true, afterClose: true },
    });
    expect(single("[centre]inline[/centre]")).toMatchObject({
      type: "centre",
      spacing: { afterOpen: false, beforeClose: false, afterClose: false },
    });
  });

  it("parses unordered and ordered lists with [*] items", () => {
    const node = single("[list]\n[*]one\n[*]two\n[/list]");
    expect(node.type).toBe("list");
    if (node.type !== "list") return;
    expect(node.ordered).toBe(false);
    expect(node.items.map(collectPlainText)).toEqual(["one\n", "two"]);

    const ordered = single("[list=1][*]a[/list]");
    expect(ordered).toMatchObject({ type: "list", ordered: true });
  });

  it("parses imagemaps with percentage link areas", () => {
    const node = single(
      "[imagemap]\nhttps://example.com/map.png\n10 20 30 40 https://example.com tooltip here\n0 0 50 50 # no link\n[/imagemap]",
    );
    expect(node.type).toBe("imagemap");
    if (node.type !== "imagemap") return;
    expect(node.src).toBe("https://example.com/map.png");
    expect(node.links).toEqual([
      { x: 10, y: 20, width: 30, height: 40, href: "https://example.com", title: "tooltip here" },
      { x: 0, y: 0, width: 50, height: 50, href: "", title: "no link" },
    ]);
  });

  it("renders unknown tags as literal text", () => {
    expect(parseBBCode("[wat]x[/wat]")).toEqual([{ type: "text", text: "[wat]x[/wat]" }]);
  });

  it("renders unclosed tags as literal text plus their content", () => {
    expect(parseBBCode("[b]never closed")).toEqual([
      { type: "text", text: "[b]never closed" },
    ]);
  });

  it("renders stray closing tags as literal text", () => {
    expect(parseBBCode("done[/b]")).toEqual([{ type: "text", text: "done[/b]" }]);
  });

  it("recovers from interleaved tags by unwinding inner frames as literals", () => {
    const nodes = parseBBCode("[b][i]x[/b]");
    expect(nodes).toEqual([
      {
        type: "style",
        tag: "b",
        children: [{ type: "text", text: "[i]x" }],
      },
    ]);
  });

  it("repairs crossed tags when the delayed inner close exists", () => {
    expect(single("[notice][centre]x[/notice][/centre]")).toMatchObject({
      type: "notice",
      children: [{ type: "centre", children: [{ type: "text", text: "x" }] }],
    });
    expect(single("[size=150][color=#FFFFFF]x[/size][/color]")).toMatchObject({
      type: "size",
      size: 150,
      children: [{ type: "color", color: "#FFFFFF", children: [{ type: "text", text: "x" }] }],
    });
  });

  it("is case-insensitive on tag names", () => {
    expect(single("[B]x[/b]")).toMatchObject({ type: "style", tag: "b" });
  });

  it("trims the newline right after a block open and before a block close", () => {
    const node = single("[notice]\nline\n[/notice]");
    expect(node).toMatchObject({ type: "notice", children: [{ type: "text", text: "line" }] });
  });

  it("parses a realistic profile page without losing content", () => {
    const source = [
      "[heading][color=#FFFFFF]7k para mejorar:[/color][/heading]",
      "",
      "[notice]",
      "O2jam-1: https://www.dropbox.com/s/fzk24p3je7dvlxb/o2jam-1.rar?dl=0",
      "[centre]",
      "Y los mapas de:",
      "[url=https://osu.ppy.sh/beatmapsets?m=3&q=creator%3DKawawa%20key%3D7&s=any]Kawawa[/url] 👍",
      "[/centre]",
      "[/notice]",
      "",
      "[centre][size=90][url=https://web.archive.org][b][color=#E6821E]o[/color][color=#E88A26]s[/color][/b][/url][/size][/centre]",
      "",
      "[box=og ranking][centre][img]https://files.catbox.moe/yvdh0p.png[/img][/centre]",
      "[/box]",
      "",
      "ggs",
    ].join("\n");

    const nodes = parseBBCode(source);
    const types = nodes.filter((n) => n.type !== "text").map((n) => n.type);
    expect(types).toEqual(["heading", "notice", "centre", "box"]);
    expect(collectPlainText(nodes)).toContain("ggs");
    expect(collectPlainText(nodes)).toContain("O2jam-1");

    const box = nodes.find((n) => n.type === "box");
    expect(box).toMatchObject({ title: "og ranking" });
  });

  it("omits source spans unless requested", () => {
    const nodes = parseBBCode("a[b]x[/b]");
    expect(nodes.every((n) => n.span === undefined)).toBe(true);
    const node = nodes[1];
    expect(node.type === "style" && node.children[0].span).toBeUndefined();
  });

  it("records source spans covering each node's tags", () => {
    const source = "pre[b]bold[/b][notice]inside[/notice]";
    const nodes = parseBBCode(source, { spans: true });
    expect(nodes.map((n) => n.span)).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 14 },
      { start: 14, end: 37 },
    ]);
    const bold = nodes[1];
    expect(bold.type === "style" && bold.children[0].span).toEqual({ start: 6, end: 10 });
  });

  it("spans verbatim tags and replayed dangling opens", () => {
    const source = "[img]https://a.io/x.png[/img][b]never closed";
    const nodes = parseBBCode(source, { spans: true });
    expect(nodes[0]).toMatchObject({ type: "img", span: { start: 0, end: 29 } });
    // The dangling [b] replays as literal text spanning the rest.
    expect(nodes[1]).toMatchObject({ type: "text", span: { start: 29, end: source.length } });
  });
});

describe("findBBNodePathAtOffset", () => {
  it("returns the containing chain, outermost first", () => {
    const source = "[centre][color=#FF0000]hi[/color][/centre]after";
    const nodes = parseBBCode(source, { spans: true });
    const path = findBBNodePathAtOffset(nodes, source.indexOf("hi") + 1);
    expect(path.map((n) => n.type)).toEqual(["centre", "color", "text"]);
    expect(findBBNodePathAtOffset(nodes, source.indexOf("after") + 1).map((n) => n.type)).toEqual(["text"]);
  });

  it("descends into list items and returns [] past the end", () => {
    const source = "[list][*]one[*]two[/list]";
    const nodes = parseBBCode(source, { spans: true });
    const path = findBBNodePathAtOffset(nodes, source.indexOf("two"));
    expect(path.map((n) => n.type)).toEqual(["list", "text"]);
    expect(path[1]).toMatchObject({ text: "two" });
    expect(findBBNodePathAtOffset(nodes, source.length + 5)).toEqual([]);
  });
});

describe("shiftHexHue", () => {
  it("rotates hue while keeping saturation and lightness", () => {
    expect(shiftHexHue("#FF0000", 120)).toBe("#00FF00");
    expect(shiftHexHue("#FF0000", 240)).toBe("#0000FF");
    expect(shiftHexHue("#FF0000", 360)).toBe("#FF0000");
    expect(shiftHexHue("#FF0000", -120)).toBe("#0000FF");
  });

  it("leaves greys unchanged and rejects invalid hex", () => {
    expect(shiftHexHue("#808080", 90)).toBe("#808080");
    expect(shiftHexHue("not-a-color", 90)).toBeNull();
  });
});

describe("containsBBCode", () => {
  it("detects recognized tags anywhere in the text", () => {
    expect(containsBBCode("[b]hi[/b]")).toBe(true);
    expect(containsBBCode("hello [color=red]world[/color]!")).toBe(true);
    expect(containsBBCode("[centre][img]https://x.com/a.png[/img][/centre]")).toBe(true);
    expect(containsBBCode("[list][*]one[*]two[/list]")).toBe(true);
  });

  it("treats plain text, stray brackets, and bare URLs as non-BBCode", () => {
    expect(containsBBCode("just some plain text")).toBe(false);
    expect(containsBBCode("")).toBe(false);
    expect(containsBBCode("[insert joke here] and [unknown]x[/unknown]")).toBe(false);
    expect(containsBBCode("see https://example.com for more")).toBe(false);
  });
});

describe("normalizeHexColor", () => {
  it("expands shorthand and uppercases", () => {
    expect(normalizeHexColor("#abc")).toBe("#AABBCC");
    expect(normalizeHexColor("ff0000")).toBe("#FF0000");
    expect(normalizeHexColor("nope")).toBeNull();
  });
});

describe("parseYoutubeInput", () => {
  it("accepts ids, youtu.be and watch URLs", () => {
    expect(parseYoutubeInput("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYoutubeInput("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYoutubeInput("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYoutubeInput("https://example.com/x")).toBeNull();
  });
});

describe("buildGradientBBCode", () => {
  it("colors each visible character and skips whitespace", () => {
    const out = buildGradientBBCode("ab c", ["#000000", "#FFFFFF"]);
    expect(out).toBe("[color=#000000]a[/color][color=#808080]b[/color] [color=#FFFFFF]c[/color]");
  });

  it("round-trips through the parser", () => {
    const out = buildGradientBBCode("mania", ["#B14DE8", "#FF9ECF"]);
    const nodes = parseBBCode(out);
    expect(nodes.every((n) => n.type === "color")).toBe(true);
    expect(collectPlainText(nodes)).toBe("mania");
  });

  it("returns the input unchanged when a color is invalid", () => {
    expect(buildGradientBBCode("x", ["nope", "#fff"])).toBe("x");
  });

  it("handles a single character", () => {
    expect(buildGradientBBCode("x", ["#112233", "#445566"])).toBe("[color=#112233]x[/color]");
  });

  it("mirrors the ramp out and back (A->B->A)", () => {
    const colors = gradientCharColors("abcde", ["#000000", "#FFFFFF"], true)!;
    expect(colors[0]).toBe("#000000");
    expect(colors[2]).toBe("#FFFFFF");
    expect(colors[4]).toBe("#000000");
    expect(colors[1]).toBe(colors[3]);
  });

  it("interpolates through middle stops", () => {
    const colors = gradientCharColors("abc", ["#FF0000", "#00FF00", "#0000FF"])!;
    expect(colors).toEqual(["#FF0000", "#00FF00", "#0000FF"]);
  });

  it("reproduces the mirrored profile-title ramp shape", () => {
    // "osu!mania CR time machine" style: orange -> gold -> orange.
    const text = "osu!mania CR time machine";
    const colors = gradientCharColors(text, ["#E6821E", "#FDE071"], true)!;
    const visible = colors.filter((color): color is string => color !== null);
    expect(visible[0]).toBe("#E6821E");
    expect(visible[visible.length - 1]).toBe("#E6821E");
    // The ramp is symmetric and brightest mid-string (green channel peaks).
    expect(visible[1]).toBe(visible[visible.length - 2]);
    const green = (hex: string) => parseInt(hex.slice(3, 5), 16);
    const mid = visible[Math.floor(visible.length / 2)];
    expect(green(mid)).toBeGreaterThan(0xd0);
    expect(green(mid)).toBeGreaterThan(green(visible[0]));
  });
});
