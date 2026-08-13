import { describe, expect, it, vi } from "vitest";
import { skinPreviewUploadLabel, uploadSkinPreviewsParallel } from "./skins";

describe("uploadSkinPreviewsParallel", () => {
  it("runs no more than three thumbnail uploads at once", async () => {
    const releases: Array<() => void> = [];
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const run = uploadSkinPreviewsParallel(
      [3, 4, 5, 6, 7].map((keys) => ({ keys, sizeBytes: 10 })),
      async ({ keys }, onProgress) => {
        started.push(keys);
        active += 1;
        peak = Math.max(peak, active);
        onProgress(5);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
      },
    );

    await vi.waitFor(() => expect(started).toEqual([3, 4, 5]));
    expect(peak).toBe(3);
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(started).toEqual([3, 4, 5, 6, 7]));
    releases.splice(0).forEach((release) => release());
    await run;
    expect(peak).toBe(3);
  });

  it("aggregates byte progress across all active previews", async () => {
    const updates: Array<{ sentBytes: number; completed: number; activeKeys: number[] }> = [];
    await uploadSkinPreviewsParallel(
      [{ keys: 4, sizeBytes: 10 }, { keys: 7, sizeBytes: 20 }],
      async (item, onProgress) => onProgress(item.sizeBytes / 2),
      ({ sentBytes, completed, activeKeys }) => updates.push({ sentBytes, completed, activeKeys }),
    );

    expect(updates.at(-1)).toEqual({ sentBytes: 30, completed: 2, activeKeys: [] });
    expect(updates.some((update) => update.sentBytes === 15)).toBe(true);
  });

  it("describes one or several active keymodes without a fake current file", () => {
    expect(skinPreviewUploadLabel([4], 0, 4)).toBe("Uploading the 4K preview.");
    expect(skinPreviewUploadLabel([3, 4, 7], 0, 4)).toBe("Uploading 3K, 4K, 7K previews.");
    expect(skinPreviewUploadLabel([], 4, 4)).toBe("Previews uploaded.");
  });
});
