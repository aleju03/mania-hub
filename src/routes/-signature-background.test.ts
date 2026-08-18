// @vitest-environment node
/* The background picker turns a URL into a server-side fetch, and one of the
   three sources is an address the player typed. That is the textbook SSRF
   shape, so what matters here is which transport does the fetching: every
   source has to go through lib/safe-image-fetch.ts, which pins the socket to a
   validated public address, and never through plain fetch().

   The other requirement is that a background can never be why a render fails.
   The picture lands on a stranger's osu! profile, where a thrown error is a
   broken image nobody can report. */
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { backgroundImageDataUrl, clearSignatureBackgroundMemo, probeSignatureImageUrl } from "./api/signature/-backgrounds";
import { normalizeSignatureImageUrl, normalizeSignatureStyle } from "../lib/signature-style";
import { fetchValidatedImage, ProxyError } from "../lib/safe-image-fetch";

/* Only the transport is stubbed. Its own denylist, DNS pinning and redirect
   re-validation have their own tests; what these cases pin down is that this
   module routes through it and handles what it returns. */
vi.mock("../lib/safe-image-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/safe-image-fetch")>()),
  fetchValidatedImage: vi.fn(),
}));

const pinnedFetch = vi.mocked(fetchValidatedImage);

const SURFACE = "#120d15";
const OSU_COVER = "https://assets.ppy.sh/user-profile-covers/1/abc.jpeg";
const ELSEWHERE = "https://images.example.com/wallpaper.png";

let plainFetch: ReturnType<typeof vi.fn>;

/** A real JPEG, so the sharp pipeline under test actually runs. */
async function samplePhoto(): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp({
    create: { width: 400, height: 300, channels: 3, background: { r: 240, g: 240, b: 250 } },
  }).jpeg().toBuffer();
}

function imageResponse(bytes: Buffer, contentType: string | null = "image/jpeg", contentLength: string | null = null) {
  return { status: 200, contentType, contentLength, stream: Readable.from(bytes) };
}

beforeEach(async () => {
  clearSignatureBackgroundMemo();
  const photo = await samplePhoto();
  pinnedFetch.mockReset();
  pinnedFetch.mockImplementation(async () => imageResponse(photo));
  // Nothing in this module may reach the network any other way.
  plainFetch = vi.fn(async () => { throw new Error("plain fetch must not be used for backgrounds"); });
  vi.stubGlobal("fetch", plainFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSignatureBackgroundMemo();
});

const style = (patch: Record<string, unknown>) => normalizeSignatureStyle({
  background: "cover", accent: "auto", opacity: 55, blur: 6, ...patch,
});

async function renderedLuminance(input: ReturnType<typeof style>): Promise<number> {
  const { default: sharp } = await import("sharp");
  const url = await backgroundImageDataUrl(input, 880, 200, { coverUrl: OSU_COVER }, SURFACE);
  const { channels } = await sharp(Buffer.from(url!.split(",")[1]!, "base64")).stats();
  return (0.2126 * channels[0]!.mean + 0.7152 * channels[1]!.mean + 0.0722 * channels[2]!.mean) / 255;
}

describe("background sources", () => {
  it("draws an osu! cover into a flat jpeg data url", async () => {
    const url = await backgroundImageDataUrl(style({}), 880, 200, { coverUrl: OSU_COVER }, SURFACE);
    expect(url).toMatch(/^data:image\/jpeg;base64,/);
    expect(pinnedFetch).toHaveBeenCalledTimes(1);
    expect(plainFetch).not.toHaveBeenCalled();
  });

  it("fetches a player-supplied url through the pinned transport, not fetch()", async () => {
    const url = await backgroundImageDataUrl(
      style({ background: "custom", imageUrl: ELSEWHERE }), 880, 200, {}, SURFACE,
    );
    expect(url).toMatch(/^data:image\/jpeg;base64,/);
    expect(pinnedFetch).toHaveBeenCalledWith(ELSEWHERE, expect.anything());
    expect(plainFetch).not.toHaveBeenCalled();
  });

  it("needs no profile data for a custom url", async () => {
    const url = await backgroundImageDataUrl(
      style({ background: "custom", imageUrl: ELSEWHERE }), 880, 200, {}, SURFACE,
    );
    expect(url).not.toBeNull();
  });

  /* The osu! sources come from an API payload rather than from the player, so
     they stay pinned to the hosts they are supposed to come from - a drifting
     upstream field must not become an arbitrary fetch. */
  it.each([
    "https://assets.ppy.sh.evil.example/x.jpg",
    "https://notassets.ppy.sh/x.jpg",
    "https://evil.example/?u=assets.ppy.sh",
    "http://assets.ppy.sh/x.jpg",
  ])("refuses osu! source %s without fetching it", async (cover) => {
    expect(await backgroundImageDataUrl(style({}), 880, 200, { coverUrl: cover }, SURFACE)).toBeNull();
    expect(pinnedFetch).not.toHaveBeenCalled();
  });

  it("does not fetch at all for a style that paints rather than downloads", async () => {
    for (const background of ["solid", "gradient", "none"]) {
      expect(await backgroundImageDataUrl(
        style({ background }), 880, 200, { coverUrl: OSU_COVER }, SURFACE,
      )).toBeNull();
    }
    expect(pinnedFetch).not.toHaveBeenCalled();
  });

  it("returns null when the player has no such source", async () => {
    expect(await backgroundImageDataUrl(style({}), 880, 200, { coverUrl: null }, SURFACE)).toBeNull();
    expect(await backgroundImageDataUrl(style({ background: "map" }), 880, 200, {}, SURFACE)).toBeNull();
    expect(await backgroundImageDataUrl(style({ background: "custom" }), 880, 200, {}, SURFACE)).toBeNull();
  });
});

describe("failure handling", () => {
  it("degrades to no background rather than throwing when the fetch fails", async () => {
    pinnedFetch.mockResolvedValue({ status: 404, contentType: null, contentLength: null, stream: Readable.from([]) });
    expect(await backgroundImageDataUrl(style({}), 880, 200, { coverUrl: OSU_COVER }, SURFACE)).toBeNull();
  });

  it("degrades when the transport throws outright", async () => {
    pinnedFetch.mockRejectedValue(new Error("blocked host"));
    expect(await backgroundImageDataUrl(style({}), 880, 200, { coverUrl: OSU_COVER }, SURFACE)).toBeNull();
  });

  it("refuses a response that is not an image before buffering it", async () => {
    pinnedFetch.mockResolvedValue(imageResponse(Buffer.from("<!doctype html>"), "text/html"));
    expect(await backgroundImageDataUrl(style({}), 880, 200, { coverUrl: OSU_COVER }, SURFACE)).toBeNull();
  });

  it("degrades when the bytes are not a decodable image", async () => {
    pinnedFetch.mockResolvedValue(imageResponse(Buffer.from("not a jpeg"), "image/jpeg"));
    expect(await backgroundImageDataUrl(style({}), 880, 200, { coverUrl: OSU_COVER }, SURFACE)).toBeNull();
  });

  it("refuses a source that declares itself larger than the cap", async () => {
    pinnedFetch.mockResolvedValue(imageResponse(Buffer.from("x"), "image/jpeg", String(64 * 1024 * 1024)));
    expect(await backgroundImageDataUrl(style({}), 880, 200, { coverUrl: OSU_COVER }, SURFACE)).toBeNull();
  });
});

describe("rendering", () => {
  /* Dragging a slider re-renders per change; each of those would otherwise
     re-download the same megabyte cover. */
  it("reuses the downloaded source across renders", async () => {
    await backgroundImageDataUrl(style({ blur: 4 }), 880, 200, { coverUrl: OSU_COVER }, SURFACE);
    await backgroundImageDataUrl(style({ blur: 12 }), 880, 200, { coverUrl: OSU_COVER }, SURFACE);
    expect(pinnedFetch).toHaveBeenCalledTimes(1);
  });

  it("renders at the exact size the design declared", async () => {
    const { default: sharp } = await import("sharp");
    const url = await backgroundImageDataUrl(style({}), 600, 140, { coverUrl: OSU_COVER }, SURFACE);
    const meta = await sharp(Buffer.from(url!.split(",")[1]!, "base64")).metadata();
    expect(meta).toMatchObject({ width: 600, height: 140 });
  });

  /* The legibility floor: a near-white picture has to come back dark enough to
     put white text on, whatever the player set opacity to. */
  it("pulls a bright picture down so text stays readable", async () => {
    const luminance = await renderedLuminance(style({ opacity: 100, blur: 0 }));
    expect(luminance).toBeLessThan(0.4); // source is a near-white 240/240/250 plate
  });

  /* The brightness slider scales that automatic level rather than replacing
     it. Replacing it makes the control jump at the default - the cap on a
     bright cover sits near 0.5, so 99 would be brighter than 100 and dragging
     down would brighten the picture. What this pins is monotonicity. */
  it("moves brightness in the direction the slider does", async () => {
    const auto = await renderedLuminance(style({ opacity: 100, blur: 0, brightness: 100 }));
    const raised = await renderedLuminance(style({ opacity: 100, blur: 0, brightness: 140 }));
    const nudgedDown = await renderedLuminance(style({ opacity: 100, blur: 0, brightness: 90 }));
    const lowered = await renderedLuminance(style({ opacity: 100, blur: 0, brightness: 20 }));
    expect(raised).toBeGreaterThan(auto);
    expect(nudgedDown).toBeLessThan(auto);
    expect(lowered).toBeLessThan(nudgedDown);
  });
});

/* The render's answer to a picture it could not fetch is to draw without one,
   which is right on a stranger's profile and unreadable as feedback to the
   player who just pasted the address. This is what the page asks instead, so
   what matters is that each way of failing comes back as itself. */
describe("probeSignatureImageUrl", () => {
  it("passes a real image", async () => {
    expect(await probeSignatureImageUrl(ELSEWHERE)).toBe("ok");
  });

  /* The common one, and the reason this exists at all: a host behind a bot
     challenge answers 403 to everything that is not a browser, so the link is
     fine and simply will not be served to us. Nothing spoofs a browser to get
     around it, so the player has to be told. */
  it.each([401, 403])("reports %i as a refusal by the host", async (status) => {
    pinnedFetch.mockResolvedValue({ status, contentType: "text/html", contentLength: null, stream: Readable.from([]) });
    expect(await probeSignatureImageUrl(ELSEWHERE)).toBe("refused");
  });

  it("separates a dead link from a refusing host", async () => {
    pinnedFetch.mockResolvedValue({ status: 404, contentType: null, contentLength: null, stream: Readable.from([]) });
    expect(await probeSignatureImageUrl(ELSEWHERE)).toBe("unreachable");
  });

  it("reports a page as not an image", async () => {
    pinnedFetch.mockResolvedValue(imageResponse(Buffer.from("<!doctype html>"), "text/html"));
    expect(await probeSignatureImageUrl(ELSEWHERE)).toBe("not-an-image");
  });

  it("reports bytes that claim to be an image but do not decode", async () => {
    pinnedFetch.mockResolvedValue(imageResponse(Buffer.from("not a jpeg"), "image/jpeg"));
    expect(await probeSignatureImageUrl(ELSEWHERE)).toBe("not-an-image");
  });

  it("reports a source past the size cap", async () => {
    pinnedFetch.mockResolvedValue(imageResponse(Buffer.from("x"), "image/jpeg", String(64 * 1024 * 1024)));
    expect(await probeSignatureImageUrl(ELSEWHERE)).toBe("too-large");
  });

  /* The transport's own refusals - a private address, an odd port, a redirect
     chain - are one answer here. They are not the player's link failing, and
     they must not be reported in enough detail to be worth aiming. */
  it("folds every transport refusal into one answer", async () => {
    pinnedFetch.mockRejectedValue(new ProxyError("Blocked host", 400));
    expect(await probeSignatureImageUrl(ELSEWHERE)).toBe("blocked");
    expect(await probeSignatureImageUrl("http://images.example.com/x.png")).toBe("blocked");
    expect(await probeSignatureImageUrl("https://169.254.169.254/latest")).toBe("blocked");
  });

  it("calls a timeout unreachable rather than blocked", async () => {
    pinnedFetch.mockRejectedValue(new ProxyError("Image fetch timed out", 504));
    expect(await probeSignatureImageUrl(ELSEWHERE)).toBe("unreachable");
  });

  /* The render is moments behind a successful check, so the check hands it the
     bytes rather than making the player wait through a second download. */
  it("primes the source the render is about to want", async () => {
    expect(await probeSignatureImageUrl(ELSEWHERE)).toBe("ok");
    await backgroundImageDataUrl(
      style({ background: "custom", imageUrl: ELSEWHERE }), 880, 200, {}, SURFACE,
    );
    expect(pinnedFetch).toHaveBeenCalledTimes(1);
  });
});

/* A custom background is only as safe as the shape check in front of the
   transport, and that check runs on the way into storage as well as on the way
   back out, so a row edited by hand cannot smuggle one past. */
describe("normalizeSignatureImageUrl", () => {
  it("accepts a plain https url", () => {
    expect(normalizeSignatureImageUrl(ELSEWHERE)).toBe(ELSEWHERE);
  });

  it.each([
    "http://images.example.com/x.png",
    "file:///etc/passwd",
    "ftp://images.example.com/x.png",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "https://user:pass@images.example.com/x.png",
    "not a url",
    "",
    "   ",
  ])("refuses %p", (input) => {
    expect(normalizeSignatureImageUrl(input)).toBeNull();
  });

  it("refuses a url longer than the stored cap", () => {
    expect(normalizeSignatureImageUrl(`https://images.example.com/${"a".repeat(500)}.png`)).toBeNull();
  });

  it("strips a refused url off the style, so a render can never see one", () => {
    const style = normalizeSignatureStyle({ background: "custom", imageUrl: "http://169.254.169.254/latest/meta-data" });
    expect(style.imageUrl).toBeNull();
  });
});
