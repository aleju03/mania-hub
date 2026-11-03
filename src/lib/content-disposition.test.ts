import { describe, expect, it } from "vitest";

import { buildAttachmentContentDisposition } from "./content-disposition";

describe("buildAttachmentContentDisposition", () => {
  it.each([
    ["replay.osr", "replay.osr", "replay.osr"],
    ["你好.osr", "__.osr", "%E4%BD%A0%E5%A5%BD.osr"],
    ["emoji 💀.osr", "emoji __.osr", "emoji%20%F0%9F%92%80.osr"],
    ["good replay.osr", "good replay.osr", "good%20replay.osr"],
    ["你好's (replay)*.osr", "__'s (replay)*.osr", "%E4%BD%A0%E5%A5%BD%27s%20%28replay%29%2A.osr"],
  ])("builds a valid header for %s", (filename, fallback, encoded) => {
    const value = buildAttachmentContentDisposition(filename);
    expect(value).toBe(`attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
    expect(new Response(null, { headers: { "Content-Disposition": value } })
      .headers.get("content-disposition")).toBe(value);
  });

  it("escapes quotes and backslashes in the quoted fallback", () => {
    expect(buildAttachmentContentDisposition('my "replay"\\file.osr')).toBe(
      "attachment; filename=\"my _replay__file.osr\"; filename*=UTF-8''my%20%22replay%22%5Cfile.osr",
    );
  });

  it("keeps control characters out of the header", () => {
    const value = buildAttachmentContentDisposition("replay\r\n\t.osr");
    expect(value).toBe("attachment; filename=\"replay___.osr\"; filename*=UTF-8''replay%0D%0A%09.osr");
    expect(new Response(null, { headers: { "Content-Disposition": value } })
      .headers.get("content-disposition")).toBe(value);
  });
});