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
  it("uses a flat face without a particle subtree on mobile", () => {
    const onLanded = vi.fn();
    const onFaceVisible = vi.fn();
    const { container } = render(
      <CascadeTile
        entry={revealedCard()}
        username="player7"
        cardBack="data:image/png;base64,back"
        mobile={true}
        reducedMotion={false}
        onLanded={onLanded}
        onFaceVisible={onFaceVisible}
      />,
    );

    // jsdom has no Web Animations API, so the flat mobile path lands
    // immediately. It must never introduce the preserve-3d/backface scene
    // that corrupts page tiles on mobile WebKit.
    expect(onFaceVisible).toHaveBeenCalledTimes(1);
    expect(onLanded).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[style*="preserve-3d"]')).toBeNull();
    const face = screen.getByRole("img", { name: "player7" });
    expect(face.parentElement?.style.opacity).toBe("1");
    expect(screen.queryByTestId("tier-burst")).toBeNull();
  });

  it("retires a desktop cascade tier burst", () => {
    render(
      <CascadeTile
        entry={revealedCard()}
        username="player7"
        cardBack="data:image/png;base64,back"
        mobile={false}
        reducedMotion={false}
        onLanded={() => {}}
        onFaceVisible={() => {}}
      />,
    );

    expect(screen.getByTestId("tier-burst")).toBeTruthy();

    act(() => vi.advanceTimersByTime(999));
    expect(screen.getByTestId("tier-burst")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId("tier-burst")).toBeNull();
  });

  it("draws a cut card in halves and skips its tier ceremony", () => {
    const damage = { path: [0.42, 0.5, 0.44, 0.58, 0.5] };
    const { container } = render(
      <CascadeTile
        entry={revealedCard("goat")}
        username="player7"
        cardBack="data:image/png;base64,back"
        mobile={false}
        reducedMotion={false}
        damage={damage}
        onLanded={() => {}}
        onFaceVisible={() => {}}
      />,
    );

    // Both faces come apart: two clipped copies of the back and two of the
    // front, cut along the same line.
    const halves = container.querySelectorAll('[style*="clip-path"]');
    expect(halves).toHaveLength(4);
    // The card is still named exactly once, not once per piece.
    expect(screen.getAllByRole("img", { name: "player7" })).toHaveLength(1);
    // Nothing celebrates a GOAT that came out in two pieces.
    expect(screen.queryByTestId("goat-burst")).toBeNull();
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.queryByTestId("goat-burst")).toBeNull();
  });

  it("keeps the longer GOAT ceremony bounded too", () => {
    render(
      <CascadeTile
        entry={revealedCard("goat")}
        username="player7"
        cardBack="data:image/png;base64,back"
        mobile={false}
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
