// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RevealedCard } from "./RevealStage";

vi.mock("./TierBurst", () => ({
  TierBurst: () => <div data-testid="tier-burst" />,
}));
vi.mock("./GoatBurst", () => ({
  GoatBurst: () => <div data-testid="goat-burst" />,
}));

const { CascadeTile } = await import("./RevealStage");

function revealedCard(tier: RevealedCard["tier"] = "rare"): RevealedCard {
  return {
    player: {
      user: {
        id: 7,
        username: "player7",
        avatar_url: "https://a.ppy.sh/7",
        country_code: "CR",
        statistics: { global_rank: 7, pp: 12_000 },
      },
      globalRank: 7,
      pp: 12_000,
    },
    tier,
    tierLabel: tier,
    glowColor: { r: 120, g: 80, b: 220, a: 1 },
    thumbnail: "data:image/webp;base64,front",
    skills: null,
    isNew: true,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CascadeTile", () => {
  it("flattens a landed card and retires its tier burst", () => {
    const onLanded = vi.fn();
    const onFaceVisible = vi.fn();
    const { container } = render(
      <CascadeTile
        entry={revealedCard()}
        username="player7"
        cardBack="data:image/png;base64,back"
        reducedMotion={false}
        onLanded={onLanded}
        onFaceVisible={onFaceVisible}
      />,
    );

    // jsdom has no Web Animations API, so the tile takes the same immediate
    // fallback used by older/mobile browsers. Once landed, its two-sided 3D
    // scene is replaced by the ordinary front image.
    expect(onFaceVisible).toHaveBeenCalledTimes(1);
    expect(onLanded).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[style*="preserve-3d"]')).toBeNull();
    expect(screen.getByRole("img", { name: "player7" })).toBeTruthy();
    expect(screen.getByTestId("tier-burst")).toBeTruthy();

    act(() => vi.advanceTimersByTime(999));
    expect(screen.getByTestId("tier-burst")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId("tier-burst")).toBeNull();
  });

  it("keeps the longer GOAT ceremony bounded too", () => {
    render(
      <CascadeTile
        entry={revealedCard("goat")}
        username="player7"
        cardBack="data:image/png;base64,back"
        reducedMotion={false}
        onLanded={() => {}}
        onFaceVisible={() => {}}
      />,
    );

    act(() => vi.advanceTimersByTime(2_599));
    expect(screen.getByTestId("goat-burst")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId("goat-burst")).toBeNull();
  });
});
