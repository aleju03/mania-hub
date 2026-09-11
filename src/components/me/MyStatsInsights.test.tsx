// @vitest-environment jsdom
/* The three cards read numbers the backend derives from its own projections;
   what is worth pinning here is the wiring between the two halves of the play
   diet (a tag's share of the plays, and the rating aggregated from that same
   tag) and the copy that only appears in edge states. */
import { render as rtlRender } from "@testing-library/react";
import { expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "../../lib/i18n";
import type { MyDataInsights, MyDataSkillMode } from "../../lib/my-data";
import { JudgementCard, PlayDietCard, SessionShapeCard } from "./MyStatsInsights";

const I18nWrap = ({ children }: { children: ReactNode }) => (
  <I18nProvider i18n={getI18n("en")}>{children}</I18nProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: I18nWrap });

const mode: MyDataSkillMode = {
  keyCount: 7,
  analyzedPlays: 340,
  ratings: { Overall: 24 },
  patterns: [
    { id: "ln", rating: 23.5, plays: 138 },
    { id: "tech", rating: 21.25, plays: 107 },
    { id: "jack", rating: 12.5, plays: 37 },
  ],
};

const insights: MyDataInsights = {
  diet: [{
    keyCount: 7,
    analyzed: 340,
    untagged: 54,
    tags: [
      { id: "ln", plays: 138, pct: 41 },
      { id: "tech", plays: 107, pct: 31 },
      { id: "jack", plays: 37, pct: 11 },
    ],
  }],
  sessions: null,
  grind: { mostPlayed: null },
  judgement: null,
  generatedAt: "2026-09-09T00:00:00Z",
};

it("puts each pattern's share of the plays next to the rating from the same tag", () => {
  const { container } = render(<PlayDietCard insights={insights} mode={mode} />);
  const text = container.textContent ?? "";
  expect(text).toContain("41%");
  expect(text).toContain("23.50");
  expect(text).toContain("41% of your analyzed 7K plays are LN.");
  // skillModeEntries sorts the axes by rating, so the weakest is the last one.
  expect(text).toContain("Your lowest rating is Jack.");
});

it("shows a dash rather than a rating for a tag with too few plays to rate", () => {
  const thin: MyDataSkillMode = { ...mode, patterns: [{ id: "ln", rating: 23.5, plays: 138 }] };
  const { container } = render(<PlayDietCard insights={insights} mode={thin} />);
  expect(container.textContent).toContain("-");
});

it("renders nothing for a keymode with no diet or too few analyzed plays", () => {
  const fourKey: MyDataSkillMode = { ...mode, keyCount: 4 };
  expect(render(<PlayDietCard insights={insights} mode={fourKey} />).container.textContent).toBe("");
  expect(render(<PlayDietCard insights={insights} mode={null} />).container.textContent).toBe("");
});

it("prints a session length in hours and minutes", () => {
  const { container } = render(<SessionShapeCard sessions={{
    sessions: 134,
    plays: 1178,
    avgPlays: 8.79,
    avgMinutes: 49.6,
    longest: { minutes: 191.1, plays: 30, startedAt: "2026-06-13T18:47:38.000Z", endedAt: "2026-06-13T21:58:45.000Z" },
    busiest: { plays: 30, minutes: 191.1, startedAt: "2026-06-13T18:47:38.000Z" },
    firstPlayAt: "2021-02-22T21:37:31.000Z",
  }} />);
  const text = container.textContent ?? "";
  expect(text).toContain("50m");
  expect(text).toContain("8.8");
  expect(text).toContain("3h 11m");
  expect(text).toContain("30 plays");
});

it("splits accuracy by keymode only when more than one was played", () => {
  const judgement = {
    plays: 193,
    notes: 878292,
    maxShare: 0.6231,
    maxRatio: 1.79,
    missPer1k: 13.81,
    accuracy: 0.9577,
    byKey: [
      { keyCount: 4, plays: 90, accuracy: 0.96689 },
      { keyCount: 7, plays: 73, accuracy: 0.95164 },
    ],
    since: "2026-08-01T00:00:00Z",
  };
  const both = render(<JudgementCard judgement={judgement} />).container.textContent ?? "";
  expect(both).toContain("1.79");
  expect(both).toContain("62% of notes");
  expect(both).toContain("193 plays since Aug 2026");
  expect(both).toContain("13.8");
  expect(both).toContain("96.69%");
  expect(both).toContain("7K");

  const single = render(<JudgementCard judgement={{ ...judgement, byKey: judgement.byKey.slice(0, 1) }} />).container.textContent ?? "";
  expect(single).not.toContain("4K");
});
