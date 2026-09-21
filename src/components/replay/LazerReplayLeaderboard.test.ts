// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { MaskFilter, Sprite, Texture, TextureSource } from "pixi.js";
import { LazerReplayLeaderboard } from "./LazerReplayLeaderboard";

// The resource-lifetime check needs no GPU; suppress Pixi's canvas probe.
vi.hoisted(() => vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null));

it("leaves Pixi's pooled mask filter reusable after a leaderboard is destroyed", () => {
  const source = new TextureSource({ width: 2, height: 512 });
  const texture = new Texture({ source });
  const sprite = new Sprite(texture);
  const pooledFilter = new MaskFilter({ sprite });
  const leaderboard = new LazerReplayLeaderboard(() => Texture.EMPTY);
  const textures = (leaderboard as unknown as { maskTextures: Map<string, Texture> }).maskTextures;
  textures.set("fade", texture);

  try {
    leaderboard.destroy();
    expect(texture.destroyed).toBe(true);
    // AlphaMaskPipe takes this filter back out of its global pool on the
    // next render, before it binds the next leaderboard's mask texture.
    expect(() => { pooledFilter.inverse = false; }).not.toThrow();
  } finally {
    pooledFilter.destroy();
    sprite.destroy();
    source.destroy();
  }
});
