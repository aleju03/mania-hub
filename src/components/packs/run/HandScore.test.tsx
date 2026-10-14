// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "../../../lib/i18n";
import {
  applyPack,
  freshProgress,
  newRun,
  unlocksFor,
  type PackRunOpenPayload,
  type RunCardInput,
} from "../../../lib/pack-run";

vi.mock("../packSfx", () => ({
  playRunNote: vi.fn(),
  playRunCombo: vi.fn(),
  playRunFinish: vi.fn(),
  playRunMiss: vi.fn(),
  playRunCredit: vi.fn(),
  playRunMeterTick: vi.fn(),
  prefetchRunSounds: vi.fn(),
  playRunTotal: vi.fn(),
  playRunBlindCleared: vi.fn(),
  playRunOver: vi.fn(),
}));

const { HandScore } = await import("./HandScore");

const card = (country: string): RunCardInput => ({
  key: country,
  tier: "rare",
  country,
  keyMode: 4,
  globalRank: 100,
  isNew: false,
  mastery: 0,
  goat: false,
  eternal: false,
  team: false,
  firstFind: false,
  chained: false,
  edition: null,
});

function payload(rungsCrossed: number[] = []): PackRunOpenPayload {
  const unlocks = unlocksFor(0);
  const state = newRun(freshProgress(), 1, () => 0.5, unlocks);
  const applied = applyPack(state, [card("CR"), card("CR"), card("US")], { ownCountry: "CR", collectorLevel: 0 }, unlocks, () => 0.5, 1);
  return {
    editions: [null, null, null],
    wrapper: "plain",
    outcome: applied.outcome,
    rungsCrossed,
    view: { state: applied.state, unlocks, distinct: 0, rungs: [] },
  };
}

function renderScore(run: PackRunOpenPayload, reducedMotion: boolean) {
  return render(
    <I18nProvider i18n={getI18n("en")}>
      <HandScore run={run} cardCount={3} reducedMotion={reducedMotion} />
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe("HandScore", () => {
  it("lands on the server's totals at once under reduced motion", () => {
    const run = payload();
    renderScore(run, true);
    expect(screen.getByText("Jump")).toBeTruthy();
    expect(screen.getAllByText(String(run.outcome.score.chips)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(String(run.outcome.score.total)).length).toBeGreaterThan(0);
  });

  it("skips to the end of the tally", () => {
    const run = payload();
    renderScore(run, false);
    fireEvent.click(screen.getByText("Skip"));
    expect(screen.getAllByText(String(run.outcome.score.total)).length).toBeGreaterThan(0);
  });

  it("announces rungs crossed once the tally settles", () => {
    renderScore(payload([1000]), true);
    expect(screen.getByText("The Rainbow finish")).toBeTruthy();
  });
});
