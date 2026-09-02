import { describe, expect, it } from "vitest";
import { pendingBlobUrls, resolvePendingBlobUrls, stripPendingImages } from "./bbcode-pending-images";

const BLOB = "blob:http://localhost:3000/6f0a1c2e-1111-2222-3333-444455556666";
const OTHER = "blob:http://localhost:3000/aaaabbbb-cccc-dddd-eeee-ffff00001111";
const IPV6 = "blob:http://[::1]:3000/12345678-abcd-4321-abcd-1234567890ab";

describe("finding staged images", () => {
  it("finds one inside [img]", () => {
    expect(pendingBlobUrls(`hello [img]${BLOB}[/img] world`)).toEqual([BLOB]);
  });

  it("finds an image pasted on an IPv6 local-dev origin", () => {
    expect(pendingBlobUrls(`[img]${IPV6}[/img]`)).toEqual([IPV6]);
  });

  it("finds one an imagemap was built on", () => {
    const value = `[imagemap]\n${BLOB}\n25 25 50 50 https://osu.ppy.sh\n[/imagemap]`;
    expect(pendingBlobUrls(value)).toEqual([BLOB]);
  });

  it("counts the same image used twice as one upload", () => {
    expect(pendingBlobUrls(`[img]${BLOB}[/img][img]${BLOB}[/img]`)).toEqual([BLOB]);
  });

  it("finds every staged image in a mixed document", () => {
    const value = [
      `[img]${BLOB}[/img]`,
      "",
      `[imagemap]\n${OTHER}\n0 0 100 100 https://osu.ppy.sh\n[/imagemap]`,
      "[img]https://cdn.mania-tracker.com/bbcode/abc.png[/img]",
    ].join("\n");
    expect(pendingBlobUrls(value).sort()).toEqual([OTHER, BLOB].sort());
  });

  it("leaves already-hosted images alone", () => {
    const value = "[img]https://cdn.mania-tracker.com/bbcode/abc.png[/img]";
    expect(pendingBlobUrls(value)).toEqual([]);
    expect(stripPendingImages(value)).toBe(value);
  });
});

describe("stripping staged images", () => {
  it("removes the whole [img] tag, not just the url", () => {
    expect(stripPendingImages(`before [img]${BLOB}[/img] after`)).toBe("before  after");
  });

  it("removes a staged image from an IPv6 local-dev origin", () => {
    expect(stripPendingImages(`before [img]${IPV6}[/img] after`)).toBe("before  after");
  });

  it("removes the whole imagemap, areas and all", () => {
    const value = `top\n[imagemap]\n${BLOB}\n25 25 50 50 https://osu.ppy.sh label\n0 0 10 10 #\n[/imagemap]\nbottom`;
    expect(stripPendingImages(value)).toBe("top\n\nbottom");
  });

  it("keeps an imagemap that points at a hosted image", () => {
    const value = "[imagemap]\nhttps://cdn.mania-tracker.com/bbcode/abc.png\n0 0 10 10 #\n[/imagemap]";
    expect(stripPendingImages(value)).toBe(value);
  });
});

describe("resolving staged images", () => {
  it("replaces every use of a staged image after resolving it once", async () => {
    const value = `[img]${BLOB}[/img]\n[img]${BLOB}[/img]\n[img]${OTHER}[/img]`;
    const seen: string[] = [];
    const resolved = await resolvePendingBlobUrls(value, async (url) => {
      seen.push(url);
      return url === BLOB ? "https://files.example/one.png" : "https://files.example/two.png";
    });

    expect(seen).toEqual([BLOB, OTHER]);
    expect(resolved).toBe(
      "[img]https://files.example/one.png[/img]\n"
      + "[img]https://files.example/one.png[/img]\n"
      + "[img]https://files.example/two.png[/img]",
    );
  });

  it("rejects instead of dropping an image the resolver cannot recover", async () => {
    await expect(resolvePendingBlobUrls(`[img]${BLOB}[/img]`, async () => {
      throw new Error("missing staged image");
    })).rejects.toThrow("missing staged image");
  });
});
