// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { getI18n, loadLocaleCatalog } from "../../lib/i18n";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { SettingsDrawer } from "./SettingsDrawer";

vi.mock("../settings/SettingsPanel", () => ({
  SettingsPanel: ({ onClose }: { onClose: () => void }) => (
    <div>
      <button onClick={onClose}>Close settings</button>
      <label>Background dim<input type="range" defaultValue={80} /></label>
    </div>
  ),
}));

beforeAll(async () => { await loadLocaleCatalog("en"); });
afterEach(cleanup);

it("renders usable settings in the opening commit, without waiting for a lazy panel", () => {
  const onClose = vi.fn();
  const view = (open: boolean) => (
    <I18nProvider i18n={getI18n("en")}>
      <SettingsDrawer open={open} onClose={onClose} />
    </I18nProvider>
  );
  const { rerender } = render(view(false));
  expect(screen.queryByRole("slider")).toBeNull();

  rerender(view(true));
  // Deliberately synchronous: opening the drawer must commit its actual controls.
  expect(screen.getByRole("slider", { name: "Background dim" })).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
  expect(onClose).toHaveBeenCalledOnce();

  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(2);
  rerender(view(false));
  expect(screen.queryByRole("slider")).toBeNull();
});
