// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "../../lib/i18n";
import type { SkinSummary } from "../../lib/skins";
import type { SkinAssetEntry } from "../../lib/skin-asset-explorer";

vi.stubEnv("VITE_LIVE_BACKEND_URL", "https://live.test");
const { SkinAssetExplorer, SkinAssetTiles } = await import("./SkinAssetExplorer");

const SKIN: SkinSummary = {
  id: "6f1c0f6c-0000-4000-8000-000000000001",
  slug: "aleju03-lazer",
  name: "aleju03 lazer",
  author: "aleju03",
  description: null,
  ownerUserId: 12345,
  ownerUsername: "Aleju03",
  keymodes: [4],
  accentColor: null,
  downloadCount: 0,
  previewUrl: null,
  previewWidth: null,
  previewHeight: null,
  previews: [],
  screenshots: [],
  oskUrl: "https://cdn.test/skins/6f1c0f6c/skin.osk",
  oskSizeBytes: 5_976_883,
  oskSha256: null,
  oskUpdatedAt: null,
  status: "published",
  visibility: "public",
  publishedAt: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const IMAGE: SkinAssetEntry = {
  name: "holdbody",
  kind: "image",
  paths: ["mania/holdbody.png"],
  primaryPath: "mania/holdbody.png",
  frameCount: 1,
  totalBytes: 100,
};

function renderTiles(entries: SkinAssetEntry[], resolve: (path: string) => Promise<string | null>) {
  return render(
    <I18nProvider i18n={getI18n("en")}>
      <SkinAssetTiles entries={entries} resolve={resolve} className="" />
    </I18nProvider>,
  );
}

describe("skin asset previews", () => {
  it("replaces a broken thumbnail with a readable fallback and keeps the original downloadable", async () => {
    renderTiles([IMAGE], async () => "blob:holdbody");
    fireEvent.error(await screen.findByRole("img", { name: "holdbody" }));
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByText("unreadable"));

    const dialog = within(screen.getByRole("dialog"));
    fireEvent.error(await dialog.findByRole("img"));
    expect(dialog.getByText("This file could not be decoded.")).toBeTruthy();
    const download = dialog.getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toBe("blob:holdbody");
    expect(download.getAttribute("download")).toBe("holdbody.png");
  });

  it("handles extraction rejections in both the thumbnail and viewer", async () => {
    renderTiles([IMAGE], async () => { throw new Error("bad archive entry"); });
    fireEvent.click(await screen.findByText("unreadable"));
    const dialog = within(screen.getByRole("dialog"));
    expect(await dialog.findByText("This file could not be decoded.")).toBeTruthy();
    expect(dialog.queryByRole("link", { name: "Download" })).toBeNull();
    expect((dialog.getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("downloads the selected animation frame and never pairs it with the previous frame's bytes", async () => {
    const paths = ["mania/holdbody-0@2x.png", "mania/holdbody-1@2x.png"];
    let finishFrame!: (url: string) => void;
    const nextFrame = new Promise<string>((resolve) => { finishFrame = resolve; });
    renderTiles([{ ...IMAGE, paths, primaryPath: paths[0], frameCount: 2 }],
      async (path) => path === paths[0] ? "blob:frame0" : nextFrame);
    fireEvent.click(await screen.findByRole("img"));
    const dialog = within(screen.getByRole("dialog"));
    expect((await dialog.findByRole("link", { name: "Download" })).getAttribute("download")).toBe("holdbody-0@2x.png");

    fireEvent.click(dialog.getByRole("button", { name: "1" }));
    expect(dialog.queryByRole("link", { name: "Download" })).toBeNull();
    finishFrame("blob:frame1");
    const download = await dialog.findByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toBe("blob:frame1");
    expect(download.getAttribute("download")).toBe("holdbody-1@2x.png");
  });

  it("clears stale dimensions and recovers when navigating from an unreadable asset", async () => {
    const next = { ...IMAGE, name: "note", paths: ["note.png"], primaryPath: "note.png" };
    renderTiles([IMAGE, next], async (path) => `blob:${path}`);
    fireEvent.click(await screen.findByRole("img", { name: "holdbody" }));
    const dialog = within(screen.getByRole("dialog"));
    const preview = await dialog.findByRole("img");
    Object.defineProperties(preview, {
      naturalWidth: { value: 150 },
      naturalHeight: { value: 146 },
    });
    fireEvent.load(preview);
    expect(dialog.getByText("150 × 146")).toBeTruthy();
    fireEvent.error(preview);
    expect(dialog.queryByText("150 × 146")).toBeNull();

    fireEvent.click(dialog.getByRole("button", { name: "Next asset" }));
    expect(await dialog.findByRole("img", { name: "note" })).toBeTruthy();
    expect(dialog.queryByText("This file could not be decoded.")).toBeNull();
    expect(dialog.getByRole("link", { name: "Download" }).getAttribute("download")).toBe("note.png");
  });
});

// The explorer uses <Trans>, which throws without a provider; en resolves to
// the source strings, matching what these tests assert on.
function renderExplorer(skin: SkinSummary) {
  return render(
    <I18nProvider i18n={getI18n("en")}>
      <SkinAssetExplorer skin={skin} />
    </I18nProvider>,
  );
}

describe("SkinAssetExplorer", () => {
  it("reads as one clickable strip before the archive is opened", () => {
    renderExplorer(SKIN);

    const strip = screen.getByRole("button", { name: /inside the \.osk/i });
    expect(strip.getAttribute("aria-expanded")).toBe("false");
    expect(strip.textContent).toContain("Browse every image and sound this skin ships");
    // The archive's weight is on the strip, so the click is an informed one.
    expect(strip.textContent).toContain("5.7 MB");
  });

  it("says so when the archive cannot be read, and takes another click", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    renderExplorer(SKIN);

    fireEvent.click(screen.getByRole("button", { name: /inside the \.osk/i }));
    await waitFor(() => expect(screen.getByText(/could not be read/i)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /inside the \.osk/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("has no strip at all for a skin with no stored file", () => {
    renderExplorer({ ...SKIN, oskUrl: null });
    expect(screen.queryByRole("button", { name: /inside the \.osk/i })).toBeNull();
  });
});
