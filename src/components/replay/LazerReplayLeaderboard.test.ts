// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { MaskFilter, Sprite, Text, Texture, TextureSource } from "pixi.js";
import { LazerReplayLeaderboard } from "./LazerReplayLeaderboard";
import { LAZER_LEADERBOARD } from "../../lib/replay-leaderboard";

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

function animatedLeaderboard() {
  const leaderboard = new LazerReplayLeaderboard(() => Texture.EMPTY);
  // Keep card geometry and transitions real; no canvas text measurement or
  // mask rasterization is needed to check their sizes and visibility.
  const internals = leaderboard as unknown as {
    getFadeMask(top: boolean, bottom: boolean): Texture;
    panelGradients(color: number): { left: number; right: number; border: number };
    cards: Map<string, { rank: Text; name: Text; accuracy: Text; score: Text; combo: Text; avatar: { x: number; y: number } }>;
  };
  const mask = vi.spyOn(internals, "getFadeMask").mockReturnValue(Texture.EMPTY);
  const fills = vi.spyOn(internals, "panelGradients").mockReturnValue({ left: 0xffffff, right: 0xffffff, border: 0xffffff });
  const measure = vi.spyOn(Text.prototype, "width", "get").mockReturnValue(30);
  const entries = [{ name: "Leader", score: 900000, combo: 1000, accuracy: 0.99 }];
  const player = { name: "Player", score: 500000, combo: 500, accuracy: 0.98 };
  return {
    leaderboard,
    cards: internals.cards,
    update: (now: number, expanded: boolean, reset = false) => leaderboard.update(entries, player, {}, { x: 10, y: 20, scale: 1.5 }, now, reset, expanded),
    destroy: () => { leaderboard.destroy(); mask.mockRestore(); fills.mockRestore(); measure.mockRestore(); },
  };
}

it("folds score details away without scaling ranks, avatars or the board's height", () => {
  const board = animatedLeaderboard();
  try {
    board.update(0, true);
    const card = board.cards.get("player")!;
    const avatar = { x: card.avatar.x, y: card.avatar.y };
    expect(board.leaderboard.width).toBe(LAZER_LEADERBOARD.width);
    board.update(10, false);
    board.update(210, false);
    expect(card.name.alpha).toBe(0);
    board.update(510, false);
    expect(board.leaderboard.width).toBe(LAZER_LEADERBOARD.compactWidth);
    expect(board.leaderboard.container.scale.x).toBe(1.5);
    expect(card.rank.style.fontSize).toBe(14);
    expect(card.rank.alpha).toBe(1);
    expect({ x: card.avatar.x, y: card.avatar.y }).toEqual(avatar);
    expect(card.name.visible).toBe(false);
    expect(card.accuracy.visible).toBe(false);
    board.update(600, true);
    board.update(1100, true);
    expect(board.leaderboard.width).toBe(LAZER_LEADERBOARD.width);
    expect(card.name.alpha).toBe(1);
    expect(card.name.visible).toBe(true);
    expect(card.accuracy.visible).toBe(true);
  } finally {
    board.destroy();
  }
});

it("reverses a hover transition from its current width and snaps on a seek", () => {
  const board = animatedLeaderboard();
  try {
    board.update(0, false);
    expect(board.leaderboard.width).toBe(LAZER_LEADERBOARD.compactWidth);
    board.update(100, true);
    board.update(200, true);
    const partial = board.leaderboard.width;
    expect(partial).toBeGreaterThan(LAZER_LEADERBOARD.compactWidth);
    expect(partial).toBeLessThan(LAZER_LEADERBOARD.width);
    board.update(200, false);
    expect(board.leaderboard.width).toBe(partial);
    board.update(700, false);
    expect(board.leaderboard.width).toBe(LAZER_LEADERBOARD.compactWidth);
    board.update(1000, true, true);
    expect(board.leaderboard.width).toBe(LAZER_LEADERBOARD.width);
    board.update(0, false, true);
    expect(board.leaderboard.width).toBe(LAZER_LEADERBOARD.compactWidth);
  } finally {
    board.destroy();
  }
});
