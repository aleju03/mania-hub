// Refcounted storyboard texture store shared by every renderer instance: the
// live viewer and the video-export renderer draw the same object URLs at the
// same time, and Pixi's Assets cache is global, so a plain per-renderer
// unload would pull textures out from under the other instance. Textures
// unload when the last holder releases them, keeping repeated viewer opens
// from accumulating dead blob-URL textures on the GPU.

import { Assets, Texture } from "pixi.js";

type StoreEntry = {
  refs: number;
  texture: Texture | null;
  failed: boolean;
  promise: Promise<Texture | null> | null;
};

const entries = new Map<string, StoreEntry>();

export function retainStoryboardTexture(url: string, onSettled?: () => void): Promise<Texture | null> {
  let entry = entries.get(url);
  if (!entry) {
    entry = { refs: 0, texture: null, failed: false, promise: null };
    entries.set(url, entry);
  }
  entry.refs++;

  if (entry.texture || entry.failed) return Promise.resolve(entry.texture);
  if (entry.promise) {
    if (onSettled) void entry.promise.finally(onSettled);
    return entry.promise;
  }

  const held = entry;
  // Storyboard images arrive as object URLs (and the background as an inline
  // proxy URL); neither carries a file extension, so the texture parser must
  // be named explicitly or Pixi refuses to load them. The parser is "texture"
  // since Pixi 8: the old "loadTextures" name still resolves but warns.
  held.promise = Assets.load<Texture>({ src: url, parser: "texture" })
    .then((texture) => {
      // Released (or replaced) while loading: drop the asset again.
      if (entries.get(url) !== held || held.refs <= 0) {
        void Assets.unload(url).catch(() => {});
        return null;
      }
      held.texture = texture ?? null;
      if (!texture) held.failed = true;
      return held.texture;
    })
    .catch(() => {
      held.failed = true;
      return null;
    })
    .finally(() => {
      held.promise = null;
      onSettled?.();
    });
  return held.promise;
}

export function peekStoryboardTexture(url: string): Texture | null {
  return entries.get(url)?.texture ?? null;
}

export function releaseStoryboardTexture(url: string): void {
  const entry = entries.get(url);
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  entries.delete(url);
  if (entry.texture || entry.promise) void Assets.unload(url).catch(() => {});
}
