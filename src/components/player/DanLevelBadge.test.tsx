// @vitest-environment jsdom
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "@lingui/react";
import { afterEach, describe, expect, it } from "vitest";

import { getI18n } from "../../lib/i18n";
import { DanLevelBadge } from "./DanLevelBadge";

// The badge's window marker carries its own sentence, so renders need the
// provider; en resolves to the source strings.
const I18nWrap = ({ children }: { children: ReactNode }) => (
  <I18nProvider i18n={getI18n("en")}>{children}</I18nProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: I18nWrap });

afterEach(cleanup);

/* The ring is the only thing on the badge that says "this estimate is thin",
   and it is drawn on three surfaces that never open the evidence window. What
   is worth pinning is that it appears exactly when the window is short: a
   verdict stored before the field shipped, or one a course clear set, has no
   window at all and must not be drawn as if it were complete. */
describe("DanLevelBadge", () => {
  const badge = (clearWindow?: { have: number; need: number; skills?: { full: number; total: number } } | null) => (
    <DanLevelBadge
      label="8"
      keyCount={4}
      side="rc"
      clearWindow={clearWindow}
      formatLabel={(label) => `${label} dan`}
    />
  );

  it("marks an estimate whose averaging window is not full", () => {
    render(badge({ have: 65, need: 80, skills: { full: 3, total: 4 } }));
    // A side says it in skills: the clear sum reads as nearly done even when a
    // whole skill is missing, which is the reading the mark exists to prevent.
    expect(screen.getByRole("img", { name: /3 of 4 skills have their full 20 weighted clears/ })).toBeTruthy();
  });

  it("counts clears on a single pool, which has no skills to count", () => {
    render(badge({ have: 12, need: 20 }));
    expect(screen.getByRole("img", { name: /12 of 20 weighted clears/ })).toBeTruthy();
  });

  it("shows fractional evidence without rounding an incomplete window up to full", () => {
    render(badge({ have: 19.99999, need: 20 }));
    expect(screen.getByRole("img", { name: /19.9 of 20 weighted clears/ })).toBeTruthy();
  });

  it("draws nothing on a full window, or on a verdict that carries none", () => {
    const { unmount } = render(badge({ have: 80, need: 80, skills: { full: 4, total: 4 } }));
    expect(screen.queryByRole("img", { name: /clears/ })).toBeNull();
    unmount();

    render(badge(undefined));
    expect(screen.queryByRole("img", { name: /clears/ })).toBeNull();
  });
});
