// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "./api/signature/$token/$variant";
import { clearSignatureRenderCache } from "../lib/signature-render-cache";
import { resolveSignatureToken } from "../lib/signature-resolve";
import { getCachedSignatureImage, putSignatureImage } from "../lib/r2-cache";
import { renderSignature } from "./api/signature/-renderers";

vi.mock("../lib/signature-resolve", () => ({
  isSignatureTokenShape: () => true,
  resolveSignatureToken: vi.fn(),
}));
vi.mock("../lib/r2-cache", () => ({
  getCachedSignatureImage: vi.fn(), putSignatureImage: vi.fn(),
  signatureImageDigest: (key: string) => key,
  SIGNATURE_IMAGE_CONTENT_TYPE: "image/webp",
}));
vi.mock("./api/signature/-renderers", () => ({ renderSignature: vi.fn() }));
vi.mock("../lib/og-render", async (original) => ({
  ...await original<typeof import("../lib/og-render")>(),
  encodeSignatureWebp: async (buffer: Buffer) => buffer,
  scheduleDetached: () => {},
}));
const resolved = {
  userId: 101, username: "tester", enabledTypes: ["insights"] as const,
  styles: null, skillsKeyCount: null, timeZone: null,
  versions: { insights: "one", maniacard: "one", skills: "one", dan: "one", goals: "one" },
};
const get = (Route.options as unknown as { server: { handlers: { GET: (input: {
  request: Request; params: { token: string; variant: string };
}) => Promise<Response> } } }).server.handlers.GET;
function request() {
  return get({ request: new Request("https://mania-tracker.com/api/signature/test/insights-stats-and-top-play.png"),
    params: { token: "test", variant: "insights-stats-and-top-play.png" } });
}
beforeEach(() => {
  clearSignatureRenderCache();
  vi.mocked(resolveSignatureToken).mockResolvedValue({ ...resolved, enabledTypes: [...resolved.enabledTypes] });
  vi.mocked(getCachedSignatureImage).mockResolvedValue(null);
  vi.mocked(renderSignature).mockResolvedValue(Buffer.from("picture"));
  vi.mocked(putSignatureImage).mockResolvedValue();
});
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

describe("signature serving", () => {
  it("collapses concurrent storage misses and renders into one operation", async () => {
    const responses = await Promise.all([request(), request(), request()]);
    expect(getCachedSignatureImage).toHaveBeenCalledTimes(1);
    expect(renderSignature).toHaveBeenCalledTimes(1);
    expect(putSignatureImage).toHaveBeenCalledTimes(1);
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual(["picture", "picture", "picture"]);
    expect(responses[0].headers.get("server-timing")).toContain("storage;dur=");
  });

  it("revalidates old memory bytes without paying for another storage read", async () => {
    vi.useFakeTimers();
    await request();
    vi.advanceTimersByTime(6 * 60_000);
    const response = await request();
    expect(resolveSignatureToken).toHaveBeenCalledTimes(2);
    expect(getCachedSignatureImage).toHaveBeenCalledTimes(1);
    expect(response.headers.get("server-timing")).toContain('cache;desc="validated-memory"');
  });

  it("refuses revoked or unpublished signatures before using retained bytes", async () => {
    vi.useFakeTimers();
    await request();
    vi.advanceTimersByTime(31_000);
    vi.mocked(resolveSignatureToken).mockResolvedValue(null);
    expect((await request()).status).toBe(404);
    vi.mocked(resolveSignatureToken).mockResolvedValue({ ...resolved, enabledTypes: [] });
    expect((await request()).status).toBe(404);
  });

  it("returns a real error for CDN stale-if-error when rendering fails", async () => {
    vi.mocked(renderSignature).mockRejectedValue(new Error("failed"));
    const response = await request();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("etag")).toBe(false);
    expect(putSignatureImage).not.toHaveBeenCalled();
  });

  it("does not cache a backend outage as a revoked image", async () => {
    vi.mocked(resolveSignatureToken).mockRejectedValue(new Error("offline"));
    expect((await request()).status).toBe(503);
    expect(getCachedSignatureImage).not.toHaveBeenCalled();
  });

  it("does not repopulate memory after invalidation during a storage read", async () => {
    let finish!: (buffer: Buffer) => void;
    vi.mocked(getCachedSignatureImage).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = request();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    clearSignatureRenderCache();
    finish(Buffer.from("old"));
    expect((await pending).status).toBe(503);
    await request();
    expect(getCachedSignatureImage).toHaveBeenCalledTimes(2);
  });
});
