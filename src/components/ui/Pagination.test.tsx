// @vitest-environment jsdom
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getI18n, loadLocaleCatalog } from "../../lib/i18n";
import { Pagination } from "./Pagination";

afterEach(cleanup);
beforeAll(() => loadLocaleCatalog("en"));

function setup(page: number, links = true) {
  const onPageChange = vi.fn();
  render(
    <I18nProvider i18n={getI18n("en")}>
      <Pagination
        page={page}
        totalPages={3}
        onPageChange={onPageChange}
        renderPageLink={links ? (next, props) => <a {...props} href={next ? `/skins?page=${next}` : "/skins"} /> : undefined}
      />
    </I18nProvider>,
  );
  return onPageChange;
}

describe("pagination links", () => {
  it("exposes sequential URLs and a link back to the start", () => {
    setup(1);
    expect(screen.getByTitle("First page").getAttribute("href")).toBe("/skins");
    expect(screen.getByTitle("Previous page").getAttribute("href")).toBe("/skins");
    expect(screen.getByTitle("Next page").getAttribute("href")).toBe("/skins?page=2");
  });

  it.each([0, 2])("does not link past the catalogue boundary on page %i", (page) => {
    setup(page);
    for (const title of page === 0 ? ["First page", "Previous page"] : ["Next page", "Last page"]) {
      const control = screen.getByTitle(title) as HTMLButtonElement;
      expect(control.tagName).toBe("BUTTON");
      expect(control.disabled).toBe(true);
      expect(control.hasAttribute("href")).toBe(false);
    }
  });

  it("preserves page jumping when using links", () => {
    const onPageChange = setup(0);
    fireEvent.click(screen.getByTitle("Click to jump to page"));
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.submit(input.closest("form")!);
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("preserves button navigation for existing callers", () => {
    const onPageChange = setup(0, false);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    fireEvent.click(screen.getByTitle("Next page"));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });
});
