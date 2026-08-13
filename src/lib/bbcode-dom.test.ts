// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyColorSequence, bbcodeToEditableHtml, captureColorSequence, distributeInlineWrap, editableWrapMarkup, serializeBBCodeDom, unwrapAligns } from "./bbcode-dom";

function serialize(html: string): string {
  const container = document.createElement("div");
  container.innerHTML = html;
  return serializeBBCodeDom(container);
}

function roundTrip(source: string): string {
  const container = document.createElement("div");
  container.innerHTML = bbcodeToEditableHtml(source);
  return serializeBBCodeDom(container);
}

function expectIdentity(source: string) {
  expect(roundTrip(source)).toBe(source);
}

describe("format painter color sequences", () => {
  it("captures per-visible-character colors, skipping whitespace", () => {
    const html = bbcodeToEditableHtml("[color=#FF0000]a[/color] [color=#00FF00]b[/color]");
    expect(captureColorSequence(html)).toEqual(["#FF0000", "#00FF00"]);
  });

  it("reads colors from inline style (foreColor output)", () => {
    expect(captureColorSequence('<span style="color: rgb(255, 0, 0)">a</span>')).toEqual(["#FF0000"]);
  });

  it("paints a captured sequence onto matching-length text", () => {
    expect(serialize(applyColorSequence("xy", ["#FF0000", "#0000FF"])))
      .toBe("[color=#FF0000]x[/color][color=#0000FF]y[/color]");
  });

  it("stretches a short sequence across longer text", () => {
    expect(serialize(applyColorSequence("abcd", ["#FF0000", "#0000FF"])))
      .toBe("[color=#FF0000]a[/color][color=#FF0000]b[/color][color=#0000FF]c[/color][color=#0000FF]d[/color]");
  });

  it("keeps whitespace uncolored between glyphs", () => {
    expect(serialize(applyColorSequence("a b", ["#FF0000", "#0000FF"])))
      .toBe("[color=#FF0000]a[/color] [color=#0000FF]b[/color]");
  });
});

describe("distributeInlineWrap", () => {
  const open = '<span data-bb-size="150">';
  const close = "</span>";

  it("wraps single-line content whole", () => {
    expect(distributeInlineWrap("hello", open, close)).toBe(`${open}hello${close}`);
    expect(distributeInlineWrap("<b>hi</b>", open, close)).toBe(`${open}<b>hi</b>${close}`);
  });

  it("leaves whitespace-only content unwrapped", () => {
    expect(distributeInlineWrap("   ", open, close)).toBe("   ");
  });

  it("pushes the wrapper into each block line instead of around them", () => {
    const out = distributeInlineWrap("<div>5k:</div><div>6k:</div>", open, close);
    expect(out).toBe(`<div>${open}5k:${close}</div><div>${open}6k:${close}</div>`);
  });

  it("wraps each <br>-separated segment and keeps the breaks", () => {
    const out = distributeInlineWrap("a<br>b", open, close);
    expect(out).toBe(`${open}a${close}<br>${open}b${close}`);
  });

  it("re-wrapped block lines round-trip back to per-line bbcode", () => {
    const html = distributeInlineWrap("<div>5k:</div><div>6k:</div>", open, close);
    const container = document.createElement("div");
    container.innerHTML = html;
    expect(serializeBBCodeDom(container)).toBe("[size=150]5k:[/size]\n[size=150]6k:[/size]");
  });
});

describe("unwrapAligns", () => {
  it("keeps the contents of an alignment it drops", () => {
    expect(unwrapAligns('<div data-bb="align" data-param="left" class="bbcode__align-left"><b>hi</b></div>'))
      .toBe("<b>hi</b>");
    expect(unwrapAligns("<center>hi</center>")).toBe("hi");
  });

  it("reaches an alignment nested inside a heading", () => {
    expect(unwrapAligns('<h2><center>7k practice:</center></h2>')).toBe("<h2>7k practice:</h2>");
  });

  it("leaves content with no alignment alone", () => {
    expect(unwrapAligns("<h2>plain</h2>")).toBe("<h2>plain</h2>");
  });
});

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

  it("keeps the blank line after a crossed group's delayed closer", () => {
    // Only the close order is rewritten (to the well-nested form osu! renders);
    // the newline trimmed after the delayed [/notice] has to survive the trip.
    expect(roundTrip("[centre]a\n[notice]b\n[/centre][/notice]\n\nc"))
      .toBe("[centre]a\n[notice]b\n[/notice][/centre]\n\nc");
    expect(roundTrip("[centre]a\n[notice]b\n[/centre][/notice]\nc"))
      .toBe("[centre]a\n[notice]b\n[/notice][/centre]\nc");
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

  it("keeps all three alignments, including one inside another", () => {
    expectIdentity("[left]back left[/left]");
    expectIdentity("[right]\nover here\n[/right]");
    // The case the toolbar's align buttons produce: pulling one stretch of a
    // centred block back to the left. osu! reads these as separate tags, so
    // unlike [centre] in [centre] this nests and renders on the profile.
    expectIdentity("[centre]top\n[left]aside[/left]\nbottom[/centre]");
  });

  it("never writes a newline into a [heading] or a [c]", () => {
    // osu! matches these two without DOTALL: one newline inside and the tags
    // print as text on the profile instead of making a heading.
    expectIdentity("[heading][left]Title[/left][/heading]");
    expect(roundTrip("[heading][left]Title[/left]\n[/heading]")).toBe("[heading][left]Title[/left][/heading]");
    expect(serialize("<h2>two<br>lines</h2>")).toBe("[heading]two lines[/heading]\n");
    expect(roundTrip("[heading]\nTitle\n[/heading]")).toBe("[heading]Title[/heading]");
    expect(serialize("<code>x = 1\ny = 2</code>")).toBe("[c]x = 1 y = 2[/c]");
  });

  it("reads alignment off pasted markup that carries it as a style", () => {
    // The trailing newline is the line the pasted div was: block, then break.
    expect(serialize('<div style="text-align: right">x</div>')).toBe("[right]x[/right]\n");
    expect(serialize('<div style="text-align: center">x</div>')).toBe("[centre]x[/centre]\n");
    // Left is what the page does anyway, so it stays an untagged line.
    expect(serialize('<div style="text-align: left">x</div>')).toBe("x");
  });

  it("keeps boxes, spoilerboxes and empty-title boxes", () => {
    expectIdentity("[box=my title]\ncontent\n[/box]");
    expectIdentity("[spoilerbox]\nsecret\n[/spoilerbox]");
    expectIdentity("[box=]\nempty label\n[/box]");
    // Titles carrying nested bbcode must render coloured and round-trip intact.
    expectIdentity("[box=[color=#69FFDC]Set-Up[/color]]\ncontent\n[/box]");
    expectIdentity("[box=[b]Bold[/b] title]\nbody\n[/box]");
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

  // What the editor's "Make imagemap" writes: the picture the image already
  // pointed at, plus one area in the middle to drag. It has to survive the
  // trip both ways or converting an image loses it.
  it("round-trips the seed an image conversion produces", () => {
    const seed = "[imagemap]\nblob:http://localhost:3000/staged\n25 25 50 50 #\n[/imagemap]";
    expectIdentity(seed);
    const container = document.createElement("div");
    container.innerHTML = bbcodeToEditableHtml(seed);
    const areas = container.querySelectorAll<HTMLElement>('[data-bb-imagemap-area="1"]');
    expect(areas).toHaveLength(1);
    expect(areas[0].dataset.href).toBe("");
    expect(container.querySelector<HTMLElement>('[data-bb="imagemap"]')?.dataset.src)
      .toBe("blob:http://localhost:3000/staged");
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
