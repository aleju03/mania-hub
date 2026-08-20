import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LiveTopPlaysPpGain } from "../../lib/live-backend";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "../../lib/i18n";
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
    // The rail uses <Trans>, which throws without a provider; en resolves to
    // the source strings, matching what this test asserts on.
    const html = renderToString(
      <I18nProvider i18n={getI18n("en")}>
        <PpGainsRail players={players(500)} selectedPlayerIds={[]} onTogglePlayer={vi.fn()} />
      </I18nProvider>,
    );

    const renderedButtons = html.match(/<button/g)?.length ?? 0;
    expect(renderedButtons).toBeGreaterThan(0);
    expect(renderedButtons).toBeLessThan(100);
    expect(html).toContain(">500</span>");
    expect(html).not.toContain("Player 500:");
  });
});
