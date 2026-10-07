import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractBeatmapArchiveFile } from "./beatmap-archive";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractBeatmapArchiveFile", () => {
  it("hits osu.direct's /api/d/ once and reads every range from the presigned redirect target", async () => {
    const zip = new JSZip();
    zip.file("bg.jpg", "background bytes");
    const archive = await zip.generateAsync({ type: "nodebuffer" });
    const storage = "https://storage.osu.direct/osudirect/osz/1.osz?X-Amz-Expires=15";
    const apiCalls: string[] = [];
    const storageRanges: string[] = [];

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const range = new Headers(init?.headers).get("range") ?? "";
      if (url.startsWith("https://osu.direct/api/d/")) {
        apiCalls.push(range);
        return new Response(null, { status: 302, headers: { location: storage } });
      }
      if (url === storage) {
        storageRanges.push(range);
        const suffix = /^bytes=-(\d+)$/.exec(range);
        const span = /^bytes=(\d+)-(\d+)$/.exec(range);
        const start = suffix ? Math.max(0, archive.length - Number(suffix[1])) : Number(span![1]);
        const end = suffix ? archive.length - 1 : Math.min(Number(span![2]), archive.length - 1);
        const body = archive.subarray(start, end + 1);
        return new Response(new Uint8Array(body), {
          status: 206,
          headers: { "content-range": `bytes ${start}-${end}/${archive.length}`, "content-length": String(body.length) },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    const file = await extractBeatmapArchiveFile("1", "bg.jpg");
    expect(file.toString()).toBe("background bytes");
    expect(apiCalls).toHaveLength(1);
    expect(storageRanges.length).toBeGreaterThan(1);
  });
});
