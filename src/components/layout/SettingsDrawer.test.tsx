// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { getI18n, loadLocaleCatalog } from "../../lib/i18n";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

const Panel = ({ onClose }: { onClose?: () => void }) => (
  <div>
    <button onClick={onClose}>Close settings</button>
    <label>Background dim<input type="range" defaultValue={80} /></label>
  </div>
);

beforeAll(async () => { await loadLocaleCatalog("en"); });
afterEach(() => {
  cleanup();
  vi.doUnmock("../settings/SettingsPanel");
  vi.resetModules();
});

it("leaves the panel unloaded while closed and keeps cold loading closeable", async () => {
  let resolvePanel!: (value: { SettingsPanel: typeof Panel }) => void;
  const request = new Promise<{ SettingsPanel: typeof Panel }>((resolve) => { resolvePanel = resolve; });
  const importPanel = vi.fn(() => request);
  vi.doMock("../settings/SettingsPanel", importPanel);
  const { SettingsDrawer } = await import("./SettingsDrawer");
  const { loadSettingsPanel } = await import("../settings/LazySettingsPanel");
  const onClose = vi.fn();
  const onBackdropClose = vi.fn();
  const view = (open: boolean) => (
    <I18nProvider i18n={getI18n("en")}>
      <SettingsDrawer open={open} onClose={onClose} onBackdropClose={onBackdropClose} />
    </I18nProvider>
  );
  const { rerender, container } = render(view(false));
  expect(importPanel).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();

  rerender(view(true));
  expect(screen.getByRole("status")).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(2);
  fireEvent.click(container.firstElementChild!);
  expect(onBackdropClose).toHaveBeenCalledOnce();

  await act(async () => {
    resolvePanel({ SettingsPanel: Panel });
    await loadSettingsPanel();
  });
  expect(screen.getByRole("slider", { name: "Background dim" })).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  rerender(view(false));
  expect(screen.queryByRole("slider")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("opens warmed settings synchronously without mounting controls during preloading", async () => {
  const panel = vi.fn(Panel);
  vi.doMock("../settings/SettingsPanel", () => ({ SettingsPanel: panel }));
  const { preloadSettingsPanel, loadSettingsPanel } = await import("../settings/LazySettingsPanel");
  const { SettingsDrawer } = await import("./SettingsDrawer");
  preloadSettingsPanel();
  const request = loadSettingsPanel();
  expect(loadSettingsPanel()).toBe(request);
  await request;
  expect(panel).not.toHaveBeenCalled();

  render(<I18nProvider i18n={getI18n("en")}><SettingsDrawer open onClose={vi.fn()} /></I18nProvider>);
  expect(screen.getByRole("slider", { name: "Background dim" })).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
});

it("can retry a failed import without leaving the drawer", async () => {
  vi.doMock("../settings/SettingsPanel", () => { throw new Error("offline"); });
  const { SettingsDrawer } = await import("./SettingsDrawer");
  render(<I18nProvider i18n={getI18n("en")}><SettingsDrawer open onClose={vi.fn()} /></I18nProvider>);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Close settings" })).toBeTruthy();
  vi.doMock("../settings/SettingsPanel", () => ({ SettingsPanel: Panel }));
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("slider", { name: "Background dim" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("allows an unsuccessful intent preload to be retried on opening", async () => {
  vi.doMock("../settings/SettingsPanel", () => { throw new Error("offline"); });
  const { preloadSettingsPanel, loadSettingsPanel } = await import("../settings/LazySettingsPanel");
  preloadSettingsPanel();
  await expect(loadSettingsPanel()).rejects.toThrow();
  vi.doMock("../settings/SettingsPanel", () => ({ SettingsPanel: Panel }));
  const { SettingsDrawer } = await import("./SettingsDrawer");
  render(<I18nProvider i18n={getI18n("en")}><SettingsDrawer open onClose={vi.fn()} /></I18nProvider>);
  expect(await screen.findByRole("slider", { name: "Background dim" })).toBeTruthy();
});

it("does not mount late settings when the drawer closes during loading", async () => {
  let resolvePanel!: (value: { SettingsPanel: typeof Panel }) => void;
  const panel = vi.fn(Panel);
  vi.doMock("../settings/SettingsPanel", () => new Promise((resolve) => { resolvePanel = resolve; }));
  const { SettingsDrawer } = await import("./SettingsDrawer");
  const { loadSettingsPanel } = await import("../settings/LazySettingsPanel");
  const view = (open: boolean) => (
    <I18nProvider i18n={getI18n("en")}><SettingsDrawer open={open} onClose={vi.fn()} /></I18nProvider>
  );
  const { rerender } = render(view(true));
  await vi.waitFor(() => { expect(resolvePanel).toBeDefined(); });
  rerender(view(false));
  await act(async () => {
    resolvePanel({ SettingsPanel: panel });
    await loadSettingsPanel();
  });
  expect(panel).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();
});
