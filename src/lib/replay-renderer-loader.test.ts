import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../components/replay/ReplayCanvas");
  vi.resetModules();
});

describe("replay renderer loading", () => {
  it("shares an in-flight preload with the viewer and reuses the loaded module", async () => {
    let finish!: (module: { ManiaReplayRenderer: unknown }) => void;
    const pending = new Promise<{ ManiaReplayRenderer: unknown }>((resolve) => { finish = resolve; });
    const imported = vi.fn(() => pending);
    vi.doMock("../components/replay/ReplayCanvas", imported);
    const { loadReplayRenderer, preloadReplayRenderer } = await import("./replay-renderer-loader");
    preloadReplayRenderer();
    const first = loadReplayRenderer();
    expect(loadReplayRenderer()).toBe(first);
    const module = { ManiaReplayRenderer: class {} };
    finish(module);
    expect(await first).toEqual(module);
    expect(loadReplayRenderer()).toBe(first);
    expect(imported).toHaveBeenCalledTimes(1);
  });

  it("allows a viewer retry after a failed speculative download", async () => {
    vi.doMock("../components/replay/ReplayCanvas", () => { throw new Error("offline"); });
    const { loadReplayRenderer, preloadReplayRenderer } = await import("./replay-renderer-loader");
    preloadReplayRenderer();
    const failed = loadReplayRenderer();
    await expect(failed).rejects.toThrow();
    const renderer = class {};
    vi.doMock("../components/replay/ReplayCanvas", () => ({ ManiaReplayRenderer: renderer }));
    const retried = loadReplayRenderer();
    expect(retried).not.toBe(failed);
    expect((await retried).ManiaReplayRenderer).toBe(renderer);
  });
});
