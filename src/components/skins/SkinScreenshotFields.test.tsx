// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "../../lib/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftScreenshot } from "../../lib/skin-screenshot-process";
import { SkinScreenshotFields } from "./SkinScreenshotFields";

// The fields read their copy through Lingui; en resolves to the source strings.
const I18nWrap = ({ children }: { children: ReactNode }) => (
  <I18nProvider i18n={getI18n("en")}>{children}</I18nProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: I18nWrap });

function draft(index: number, label = ""): DraftScreenshot {
  return { blob: new Blob(["x"]), width: 1920, height: 1080, url: `blob:shot-${index}`, label };
}

function renderFields(overrides: {
  screenshots?: DraftScreenshot[];
  cover?: number | null;
  onRename?: (index: number, label: string) => void;
  onCover?: (index: number | null) => void;
  onRemove?: (index: number) => void;
} = {}) {
  const props = {
    screenshots: overrides.screenshots ?? [draft(0), draft(1, "Gameplay")],
    onAdd: () => {},
    onRename: overrides.onRename ?? (() => {}),
    onRemove: overrides.onRemove ?? (() => {}),
    cover: overrides.cover ?? null,
    onCover: overrides.onCover,
  };
  render(<SkinScreenshotFields {...props} />);
  return props;
}

afterEach(cleanup);

describe("SkinScreenshotFields", () => {
  it("shows the stored name and numbers an unnamed shot in its placeholder", () => {
    renderFields();
    const first = screen.getByLabelText("Name for screenshot 1") as HTMLInputElement;
    expect(first.value).toBe("");
    expect(first.placeholder).toBe("Shot 1");
    expect((screen.getByLabelText("Name for screenshot 2") as HTMLInputElement).value).toBe("Gameplay");
  });

  it("reports a typed name against its position", () => {
    const onRename = vi.fn();
    renderFields({ onRename });
    fireEvent.change(screen.getByLabelText("Name for screenshot 2"), { target: { value: "Score screen" } });
    expect(onRename).toHaveBeenCalledWith(1, "Score screen");
  });

  it("stars a shot as the cover and unstars the one already holding it", () => {
    const onCover = vi.fn();
    renderFields({ onCover, cover: null });
    fireEvent.click(screen.getByLabelText("Use screenshot 2 as the card cover"));
    expect(onCover).toHaveBeenCalledWith(1);

    cleanup();
    renderFields({ onCover, cover: 1 });
    fireEvent.click(screen.getByLabelText("Fronts the browse card"));
    // Clicking the star again hands the card back to a rendered playfield.
    expect(onCover).toHaveBeenLastCalledWith(null);
  });

  it("leaves the star out when the form does not own the cover", () => {
    renderFields({ onCover: undefined });
    expect(screen.queryByLabelText("Use screenshot 1 as the card cover")).toBeNull();
    expect(screen.getByLabelText("Remove screenshot 1")).toBeTruthy();
  });
});
