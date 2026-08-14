import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LiveTopPlaysPpGain } from "../../lib/live-backend";
import { PpGainsRail } from "./PpGainsRail";

function players(count: number): LiveTopPlaysPpGain[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    username: `Player ${index + 1}`,
    avatar_url: `https://a.ppy.sh/${index + 1}`,
    totalGain: count - index,
  }));
}

describe("PpGainsRail", () => {
  it("only mounts the visible windows for a large global leaderboard", () => {
    const html = renderToString(
      <PpGainsRail players={players(500)} selectedPlayerIds={[]} onTogglePlayer={vi.fn()} />,
    );

    const renderedButtons = html.match(/<button/g)?.length ?? 0;
    expect(renderedButtons).toBeGreaterThan(0);
    expect(renderedButtons).toBeLessThan(100);
    expect(html).toContain(">500</span>");
    expect(html).not.toContain("Player 500:");
  });
});
