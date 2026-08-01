// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkinSummary } from "../../lib/skins";

vi.stubEnv("VITE_LIVE_BACKEND_URL", "https://live.test");
const { SkinAssetExplorer } = await import("./SkinAssetExplorer");

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
  downloadCount: null,
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
  publishedAt: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SkinAssetExplorer", () => {
  it("reads as one clickable strip before the archive is opened", () => {
    render(<SkinAssetExplorer skin={SKIN} />);

    const strip = screen.getByRole("button", { name: /inside the \.osk/i });
    expect(strip.getAttribute("aria-expanded")).toBe("false");
    expect(strip.textContent).toContain("Browse every image and sound this skin ships");
    // The archive's weight is on the strip, so the click is an informed one.
    expect(strip.textContent).toContain("5.7 MB");
  });

  it("says so when the archive cannot be read, and takes another click", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    render(<SkinAssetExplorer skin={SKIN} />);

    fireEvent.click(screen.getByRole("button", { name: /inside the \.osk/i }));
    await waitFor(() => expect(screen.getByText(/could not be read/i)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /inside the \.osk/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("has no strip at all for a skin with no stored file", () => {
    render(<SkinAssetExplorer skin={{ ...SKIN, oskUrl: null }} />);
    expect(screen.queryByRole("button", { name: /inside the \.osk/i })).toBeNull();
  });
});
