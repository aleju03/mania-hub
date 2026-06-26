// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { bbcodeToEditableHtml, editableWrapMarkup, serializeBBCodeDom } from "./bbcode-dom";

function roundTrip(source: string): string {
  const container = document.createElement("div");
  container.innerHTML = bbcodeToEditableHtml(source);
  return serializeBBCodeDom(container);
}

function expectIdentity(source: string) {
  expect(roundTrip(source)).toBe(source);
}

describe("bbcode editable DOM round-trip", () => {
  it("keeps plain text and newlines", () => {
    expectIdentity("hello\nworld\n\nagain");
  });

  it("keeps inline styles", () => {
    expectIdentity("[b]bold[/b] [i]it[/i] [u]un[/u] [s]gone[/s] [spoiler]shh[/spoiler]");
  });

  it("keeps color, size and nesting", () => {
    expectIdentity("[color=#B14DE8][b]purple[/b][/color] and [size=85]small[/size]");
  });

  it("keeps oversized osu! size params while clamping visual output", () => {
    const source = "[centre][heading][size=500]Title[/size][/heading][/centre]";
    const html = bbcodeToEditableHtml(source);
    expect(html).toContain("<h2");
    expect(html).toContain("font-size:200%");
    expect(html).toContain('data-bb-size="500"');
    expect(html).not.toContain("[size=500]");
    expectIdentity(source);
  });

  it("renders osu!-tolerated crossed tags without visible BBCode", () => {
    const html = bbcodeToEditableHtml("[notice][centre][size=150]About[/size]\n\ntext[/notice][/centre]");
    const container = document.createElement("div");
    container.innerHTML = html;
    expect(html).toContain('class="well"');
    expect(html).toContain("<center");
    expect(container.textContent).toContain("About");
    expect(container.textContent).toContain("text");
    expect(container.textContent).not.toContain("[centre]");
    expect(container.textContent).not.toContain("[/notice]");
  });

  it("keeps links in both forms, emails and profiles", () => {
    expectIdentity("[url=https://example.com]text[/url]");
    expectIdentity("[url]https://example.com[/url]");
    expectIdentity("[email]a@b.com[/email]");
    expectIdentity("[email=a@b.com]mail[/email]");
    expectIdentity("[profile=7095193]Aleju03[/profile]");
    expectIdentity("[profile]Aleju03[/profile]");
  });

  it("keeps media tags", () => {
    expectIdentity("[img]https://files.catbox.moe/e2oarc.png[/img]");
    expectIdentity("[youtube]dQw4w9WgXcQ[/youtube]");
    expectIdentity("[audio]https://example.com/a.mp3[/audio]");
  });

  it("keeps blocks with their exact boundary newlines", () => {
    expectIdentity("[heading]Title[/heading]\n\ntext");
    expectIdentity("[notice]\nimportant\n[/notice]\nafter");
    expectIdentity("[centre]mid[/centre] same line");
    expectIdentity("[centre]\nblock form\n[/centre]");
    expectIdentity('[quote="peppy"]\nhi\n[/quote]');
    expectIdentity("[quote]plain[/quote]");
  });

  it("keeps boxes, spoilerboxes and empty-title boxes", () => {
    expectIdentity("[box=my title]\ncontent\n[/box]");
    expectIdentity("[spoilerbox]\nsecret\n[/spoilerbox]");
    expectIdentity("[box=]\nempty label\n[/box]");
  });

  it("keeps code blocks and inline code verbatim", () => {
    expectIdentity("[code]\n[b]not parsed[/b]\nline 2\n[/code]");
    expectIdentity("inline [c]x = 1[/c] code");
  });

  it("keeps lists", () => {
    expectIdentity("[list]\n[*]one\n[*]two\n[/list]");
    expectIdentity("[list=1]\n[*]first\n[*]second\n[/list]\nafter");
  });

  it("keeps imagemaps byte-for-byte", () => {
    expectIdentity("[imagemap]\nhttps://example.com/map.png\n10 20 30 40 https://example.com tooltip here\n0 0 50 50 # none\n[/imagemap]");
  });

  it("stamps imagemap areas with editable metadata", () => {
    const html = bbcodeToEditableHtml("[imagemap]\nhttps://example.com/map.png\n10 20 30 40 https://example.com tooltip here\n[/imagemap]");
    const container = document.createElement("div");
    container.innerHTML = html;
    const map = container.querySelector<HTMLElement>('[data-bb="imagemap"]')!;
    const area = container.querySelector<HTMLElement>('[data-bb-imagemap-area="1"]')!;
    expect(map.dataset.src).toBe("https://example.com/map.png");
    expect(area.dataset.x).toBe("10");
    expect(area.dataset.y).toBe("20");
    expect(area.dataset.width).toBe("30");
    expect(area.dataset.height).toBe("40");
    expect(area.dataset.href).toBe("https://example.com");
    expect(area.dataset.title).toBe("tooltip here");
  });

  it("serializes updated imagemap raw metadata", () => {
    const container = document.createElement("div");
    container.innerHTML = bbcodeToEditableHtml("[imagemap]\nhttps://example.com/map.png\n10 20 30 40 https://example.com old\n[/imagemap]");
    const map = container.querySelector<HTMLElement>('[data-bb="imagemap"]')!;
    map.dataset.raw = "https://example.com/map.png\n5 6 7 8 https://osu.ppy.sh edited";
    expect(serializeBBCodeDom(container)).toBe("[imagemap]https://example.com/map.png\n5 6 7 8 https://osu.ppy.sh edited[/imagemap]");
  });

  it("keeps a realistic profile page byte-for-byte", () => {
    const page = [
      "[heading][color=#FFFFFF]7k para mejorar:[/color][/heading]",
      "",
      "[notice]",
      "",
      "O2jam-1: https://www.dropbox.com/s/fzk24p3je7dvlxb/o2jam-1.rar?dl=0",
      "O2jam-2: https://www.dropbox.com/s/i3cbwsfgddh35y8/o2jam-2.rar?dl=0",
      "[centre]",
      "Y los mapas de:",
      "[url=https://osu.ppy.sh/beatmapsets?m=3&q=creator%3DKawawa%20key%3D7&s=any]Kawawa[/url] 👍 [url=https://osu.ppy.sh/beatmapsets?m=3&q=creator%3DFlexo123%20key%3D7&s=any]Flexo123[/url] 👍",
      "[url=https://osu.ppy.sh/beatmapsets?m=3&q=key%3D7%20creator%3DRemuring&s=any]Remuring[/url] 👍",
      "[/centre]",
      "[/notice]",
      "",
      "[centre][size=90][url=https://web.archive.org/web/20201125051458/https://osu.ppy.sh/rankings/mania/performance?country=CR][b][color=#E6821E]o[/color][color=#E88A26]s[/color][color=#EA932D]u[/color][/b][/url][/size][/centre]",
      "",
      "[centre][url=https://mania-tracker.com][img]https://files.catbox.moe/e2oarc.png[/img][/url]",
      "",
      "[color=#B14DE8][b]>[/b][/color] [url=https://mania-tracker.com][b][color=#B14DE8]m[/color][color=#BB57E5]a[/color][/b][/url] [color=#B14DE8][b]<[/b][/color]",
      "[size=85]Página con varias cosas de osu!mania que hice :)[/size]",
      "",
      "[url=https://mania-tracker.com][img]https://files.catbox.moe/4e28xv.png[/img][/url][/centre]",
      "",
      "[box=og ranking][centre][img]https://files.catbox.moe/yvdh0p.png[/img][/centre]",
      "[img]https://pub-256a1a925fbe4e24a6202c575a6aedf0.r2.dev/random-bs/CnP_16042026_230839.png[/img]",
      "[/box]",
      "",
      "ggs",
      "",
      "[box=]",
      "derusteando en el big 2026 a ver si es posible seguir progresando que dejé de practicar desde mediados 2024",
      "[/box]",
      "",
      "jueguen 7k",
    ].join("\n");
    expectIdentity(page);
  });

  it("round-trips twice without drift (idempotent)", () => {
    const source = "[notice]\n[b]x[/b]\n[/notice]\n[centre]y[/centre]";
    const once = roundTrip(source);
    expect(roundTrip(once)).toBe(once);
    expect(once).toBe(source);
  });
});

describe("serializeBBCodeDom heuristics for browser-generated markup", () => {
  function serializeHtml(html: string): string {
    const container = document.createElement("div");
    container.innerHTML = html;
    return serializeBBCodeDom(container);
  }

  it("maps b/strong/i/em/u/s/del/strike", () => {
    expect(serializeHtml("<b>x</b><strong>y</strong>")).toBe("[b]x[/b][b]y[/b]");
    expect(serializeHtml("<i>x</i><em>y</em>")).toBe("[i]x[/i][i]y[/i]");
    expect(serializeHtml("<s>x</s><del>y</del><strike>z</strike>")).toBe("[s]x[/s][s]y[/s][s]z[/s]");
  });

  it("maps font color and inline span styles", () => {
    expect(serializeHtml('<font color="#ff0000">x</font>')).toBe("[color=#FF0000]x[/color]");
    expect(serializeHtml('<span style="color: rgb(177, 77, 232)">x</span>')).toBe("[color=#B14DE8]x[/color]");
    expect(serializeHtml('<span style="font-weight: bold">x</span>')).toBe("[b]x[/b]");
    expect(serializeHtml('<span style="font-size: 85%">x</span>')).toBe("[size=85]x[/size]");
    expect(serializeHtml('<span style="text-decoration: underline">x</span>')).toBe("[u]x[/u]");
  });

  it("treats contentEditable div lines as newlines", () => {
    expect(serializeHtml("first<div>second</div><div>third</div>")).toBe("first\nsecond\nthird");
    expect(serializeHtml("first<div><br></div><div>third</div>")).toBe("first\n\nthird");
  });

  it("converts non-breaking spaces to plain spaces", () => {
    expect(serializeHtml("a&nbsp;b")).toBe("a b");
  });

  it("maps plain anchors and lists from execCommand", () => {
    expect(serializeHtml('<a href="https://example.com">x</a>')).toBe("[url=https://example.com]x[/url]");
    expect(serializeHtml("<ul><li>one</li><li>two</li></ul>")).toBe("[list]\n[*]one\n[*]two\n[/list]\n");
  });

  it("serializes an edited box title", () => {
    const container = document.createElement("div");
    container.innerHTML = bbcodeToEditableHtml("[spoilerbox]\nsecret\n[/spoilerbox]");
    const title = container.querySelector('[data-bb-role="box-title"]')!;
    title.textContent = "renamed";
    expect(serializeBBCodeDom(container)).toBe("[box=renamed]\nsecret\n[/box]");
  });

  it("ignores the box toggle chrome but keeps the body", () => {
    const container = document.createElement("div");
    container.innerHTML = bbcodeToEditableHtml("[box=keep]\nbody text\n[/box]");
    expect(serializeBBCodeDom(container)).toBe("[box=keep]\nbody text\n[/box]");
  });

  it("wrap markup helpers serialize to their tags", () => {
    const { open, close } = editableWrapMarkup("notice");
    expect(serializeHtml(`${open}content${close}`)).toBe("[notice]\ncontent\n[/notice]\n");
    const color = editableWrapMarkup("color", "#FF66AA");
    expect(serializeHtml(`${color.open}x${color.close}`)).toBe("[color=#FF66AA]x[/color]");
    const box = editableWrapMarkup("box", "my box");
    expect(serializeHtml(`${box.open}x${box.close}`)).toBe("[box=my box]\nx\n[/box]\n");
  });
});
