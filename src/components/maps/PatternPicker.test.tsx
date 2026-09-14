// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getI18n } from "#/lib/i18n";
import { PATTERN_LABEL } from "#/lib/pattern-labels";
import { PatternPicker, validPatternIds } from "./PatternPicker";

vi.mock("./patternSfx", () => ({ playPatternHit: vi.fn() }));
// jsdom lacks ResizeObserver (the LN share pill measures its track with one).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);
vi.mock("./SearchCard", async () => import("../../lib/pattern-labels"));
afterEach(cleanup);

it("keeps the shield facets out of every keymode's LN dropdown", () => {
  for (const id of ["lnshield", "lnreverseshield"]) {
    for (const keys of [[], ["4k"], ["7k"], ["other"]]) expect(validPatternIds(keys).has(id)).toBe(false);
    expect(PATTERN_LABEL[id]).toBeUndefined();
  }
  render(<I18nProvider i18n={getI18n("en")}><PatternPicker keys={["4k"]} selected={[]} onToggle={vi.fn()} /></I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: "LN subfamilies" }));
  expect(screen.queryByRole("button", { name: "Shields" })).toBeNull();
  expect(screen.getByRole("button", { name: "LN Inverse" })).toBeTruthy();
});

it("puts the LN share slider in the LN dropdown and counts it on the caret", () => {
  const onLnShareChange = vi.fn();
  const { rerender } = render(
    <I18nProvider i18n={getI18n("en")}>
      <PatternPicker keys={["4k"]} selected={[]} onToggle={vi.fn()} lnShare={{ min: 0, max: 0 }} onLnShareChange={onLnShareChange} />
    </I18nProvider>,
  );
  expect(screen.queryByRole("slider", { name: "LN share minimum" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "LN subfamilies" }));
  const min = screen.getByRole("slider", { name: "LN share minimum" });
  fireEvent.keyDown(min, { key: "ArrowRight", shiftKey: true });
  fireEvent.keyUp(min, { key: "ArrowRight" });
  expect(onLnShareChange).toHaveBeenLastCalledWith(10, 0);
  rerender(
    <I18nProvider i18n={getI18n("en")}>
      <PatternPicker keys={["4k"]} selected={[]} onToggle={vi.fn()} lnShare={{ min: 40, max: 0 }} onLnShareChange={onLnShareChange} />
    </I18nProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "LN subfamilies" }));
  expect(screen.getByRole("button", { name: "LN subfamilies" }).textContent).toBe("1");
});
