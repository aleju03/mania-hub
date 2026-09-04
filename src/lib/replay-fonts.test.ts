// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  document.head.innerHTML = "";
});

afterEach(() => {
  delete (document as unknown as { fonts?: unknown }).fonts;
});

describe("scoped replay fonts", () => {
  it("does not request a stylesheet until a consuming surface asks for it", async () => {
    const { ensureReplayFontStylesheet } = await import("./replay-fonts");
    expect(document.querySelectorAll("link")).toHaveLength(0);
    const first = ensureReplayFontStylesheet();
    expect(ensureReplayFontStylesheet()).toBe(first);
    expect(document.querySelectorAll("link")).toHaveLength(1);
    document.querySelector("link")!.dispatchEvent(new Event("load"));
    await first;
  });

  it("waits for CSS registration before loading the canvas face, then waits for the face", async () => {
    let finish!: (faces: FontFace[]) => void;
    const load = vi.fn(() => new Promise<FontFace[]>((resolve) => { finish = resolve; }));
    Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
    const { ensureReplayFontStyle } = await import("./replay-fonts");
    const font = { family: "Roboto, Arial, sans-serif", weight: "700" as const };
    const request = ensureReplayFontStyle(font);
    expect(ensureReplayFontStyle(font)).toBe(request);
    expect(load).not.toHaveBeenCalled();
    let ready = false;
    void request.then(() => { ready = true; });
    document.querySelector("link")!.dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith("normal 700 32px Roboto, Arial, sans-serif", "0123456789x"));
    expect(ready).toBe(false);
    finish([]);
    await request;
    expect(ready).toBe(true);
  });

  it("loads the local default without fetching Google CSS", async () => {
    const load = vi.fn().mockResolvedValue([]);
    Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
    const { ensureReplayFontStyle } = await import("./replay-fonts");
    await ensureReplayFontStyle({ family: "Torus, sans-serif", weight: "700" });
    expect(load).toHaveBeenCalledOnce();
    expect(document.querySelectorAll("link")).toHaveLength(0);
  });

  it("retries a failed stylesheet and uses just Comic Neue for map placeholders", async () => {
    const { ensureReplayFontStylesheet, ensureMapPlaceholderFont, MAP_PLACEHOLDER_FONT_STYLESHEET } = await import("./replay-fonts");
    const failed = ensureReplayFontStylesheet();
    const rejected = expect(failed).rejects.toThrow();
    document.querySelector("link")!.dispatchEvent(new Event("error"));
    await rejected;
    expect(document.querySelectorAll("link")).toHaveLength(0);
    ensureMapPlaceholderFont();
    expect(document.querySelector("link")!.href).toBe(MAP_PLACEHOLDER_FONT_STYLESHEET);
    document.querySelector("link")!.dispatchEvent(new Event("load"));
    const retried = ensureReplayFontStylesheet();
    expect(retried).not.toBe(failed);
    document.querySelectorAll("link")[1].dispatchEvent(new Event("load"));
    await retried;
  });
});
