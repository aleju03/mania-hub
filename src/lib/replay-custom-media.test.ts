// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stored = new Map<string, Blob>();

vi.mock("./replay-idb", () => ({
  REPLAY_CUSTOM_MEDIA_STORE: "custom-media",
  withReplayStore: async (_store: string, _mode: string, run: (store: unknown) => { result: unknown }) => run({
    getAllKeys: () => ({ result: [...stored.keys()] }),
    get: (key: string) => ({ result: stored.get(key) }),
    put: (value: Blob, key: string) => {
      stored.set(key, value);
      return { result: key };
    },
    delete: (key: string) => {
      stored.delete(key);
      return { result: undefined };
    },
  }).result,
}));

import { loadReplayCustomMediaBlob, saveReplayCustomMediaFile } from "./replay-custom-media";
import { DEFAULT_REPLAY_OVERLAY_SETTINGS, writeReplayOverlaySettings } from "./replay-overlays";

function saveSettingsPointingAt(fileId: string) {
  writeReplayOverlaySettings({
    ...DEFAULT_REPLAY_OVERLAY_SETTINGS,
    media: { ...DEFAULT_REPLAY_OVERLAY_SETTINGS.media, enabled: true, media: { kind: "image", url: "", fileId, width: 320, opacity: 1 } },
  });
}

describe("custom media files", () => {
  beforeEach(() => {
    stored.clear();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never deletes the file the saved settings use, whatever is picked and dropped after it", async () => {
    const saved = await saveReplayCustomMediaFile(new Blob(["a"]));
    saveSettingsPointingAt(saved!);
    // Two picks in the settings modal, then Cancel: the saved file survives
    // and only the latest unsaved pick is kept beside it.
    const first = await saveReplayCustomMediaFile(new Blob(["b"]));
    const second = await saveReplayCustomMediaFile(new Blob(["c"]));
    expect([...stored.keys()].sort()).toEqual([saved, second].sort());
    expect(stored.has(first!)).toBe(false);
  });

  it("drops a file once saved settings no longer point at it", async () => {
    const old = await saveReplayCustomMediaFile(new Blob(["a"]));
    saveSettingsPointingAt(old!);
    const next = await saveReplayCustomMediaFile(new Blob(["b"]));
    saveSettingsPointingAt(next!);
    const latest = await saveReplayCustomMediaFile(new Blob(["c"]));
    expect([...stored.keys()].sort()).toEqual([next, latest].sort());
  });

  it("holds a link to the same size cap as a picked file, even when it does not declare its length", async () => {
    const body = () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body(), { status: 200, headers: { "content-type": "image/gif" } })));
    const media = { kind: "image" as const, url: "https://example.com/cat.gif", width: 320, opacity: 1 };
    expect(await loadReplayCustomMediaBlob(media, 10)).toBeNull();
    const blob = await loadReplayCustomMediaBlob(media, 12);
    expect(blob?.size).toBe(12);
    expect(blob?.type).toBe("image/gif");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(body(), { status: 200, headers: { "content-length": "500" } })));
    expect(await loadReplayCustomMediaBlob(media, 100)).toBeNull();
  });
});
