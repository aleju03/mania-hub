// @vitest-environment jsdom
import { Suspense, type ComponentProps } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.doUnmock("./ReplaySkinSettingsModal");
  vi.resetModules();
  vi.useRealTimers();
});

describe("replay editor code warming", () => {
  it("warms code without mounting the editor and opens the warmed component synchronously", async () => {
    const editor = vi.fn(() => <div>Full editor</div>);
    vi.doMock("./ReplaySkinSettingsModal", () => ({ ReplaySkinSettingsModal: editor }));
    const { preloadReplaySkinSettingsModal, loadReplaySkinSettingsModal, ReplaySkinSettingsModal } = await import("./LazyReplaySkinSettingsModal");
    preloadReplaySkinSettingsModal();
    const request = loadReplaySkinSettingsModal();
    expect(loadReplaySkinSettingsModal()).toBe(request);
    await request;
    expect(editor).not.toHaveBeenCalled();
    render(
      <Suspense fallback={<div>Unexpected loading screen</div>}>
        <ReplaySkinSettingsModal {...{} as ComponentProps<typeof ReplaySkinSettingsModal>} />
      </Suspense>,
    );
    expect(screen.getByText("Full editor")).toBeTruthy();
    expect(screen.queryByText("Unexpected loading screen")).toBeNull();
  });

  it("allows a failed prefetch to be retried when the editor is opened", async () => {
    vi.doMock("./ReplaySkinSettingsModal", () => { throw new Error("offline"); });
    const { loadReplaySkinSettingsModal, preloadReplaySkinSettingsModal } = await import("./LazyReplaySkinSettingsModal");
    preloadReplaySkinSettingsModal();
    await expect(loadReplaySkinSettingsModal()).rejects.toThrow();
    const editor = () => null;
    vi.doMock("./ReplaySkinSettingsModal", () => ({ ReplaySkinSettingsModal: editor }));
    expect((await loadReplaySkinSettingsModal()).ReplaySkinSettingsModal).toBe(editor);
  });

  it("cancels deferred warming when the replay leaves before idle time", async () => {
    vi.useFakeTimers();
    const importEditor = vi.fn(() => ({ ReplaySkinSettingsModal: () => null }));
    vi.doMock("./ReplaySkinSettingsModal", importEditor);
    const { scheduleReplaySkinSettingsPreload } = await import("./LazyReplaySkinSettingsModal");
    const cancel = scheduleReplaySkinSettingsPreload();
    cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(importEditor).not.toHaveBeenCalled();
  });
});
