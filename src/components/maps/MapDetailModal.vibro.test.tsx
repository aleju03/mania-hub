// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { getI18n } from "#/lib/i18n";
import { PlayContextBlock } from "./MapDetailModal";

afterEach(cleanup);

it("explains an accepted individual clear while retaining the chart's vibro warning", () => {
  render(<I18nProvider i18n={getI18n("en")}>
    <PlayContextBlock play={{
      beatmapId: 101, username: "player", accuracy: 0.95761536938, pp: 100,
      rateMod: null, playedAt: null, source: "top", rating: 40.82,
      ratingLabel: "Overall", ratingColor: "#ffffff",
      vibroClearEvidence: {
        version: 1, stableAccuracy: 0.95761536938, max300Ratio: 1072 / 418,
        ratioIsLowerBound: false, od: 9,
      },
    }} />
  </I18nProvider>);
  expect(screen.getByText("Accepted clear on a vibro chart: 95.76% accuracy, 2.56:1 MAX:300, OD9.")).toBeTruthy();
  expect(screen.queryByText("does not count")).toBeNull();
});
