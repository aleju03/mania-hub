// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getI18n, loadLocaleCatalog } from "#/lib/i18n";
import { SelectMenu } from "./SelectMenu";

beforeAll(() => loadLocaleCatalog("en"));
afterEach(cleanup);

function setup(searchable = false) {
  const onChange = vi.fn();
  render(<I18nProvider i18n={getI18n("en")}>
    <SelectMenu value="newest" onChange={onChange} ariaLabel="Sort replays" searchable={searchable}
      options={[{ value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }, { value: "difficulty", label: "Highest difficulty" }]} />
  </I18nProvider>);
  return { onChange, trigger: screen.getByRole("button", { name: "Sort replays" }) };
}

describe("SelectMenu interaction", () => {
  it("selects through a click (including keyboard-generated clicks) and restores trigger focus", () => {
    const { onChange, trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "Highest difficulty" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("difficulty");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("opens with an arrow and moves among options without committing until activation", async () => {
    const { onChange, trigger } = setup();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("option", { name: "Newest first" })));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Oldest first" }));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Highest difficulty" }));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Newest first" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps search input Home/End behavior and closes when focus leaves", () => {
    const { onChange, trigger } = setup(true);
    fireEvent.click(trigger);
    const input = screen.getByRole("textbox");
    input.focus();
    fireEvent.keyDown(input, { key: "Home" });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "difficulty" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.blur(input, { relatedTarget: document.body });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(onChange).not.toHaveBeenCalled();
  });
});
