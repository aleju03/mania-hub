// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkinSummary } from "../../lib/skins";

const track = vi.hoisted(() => vi.fn());
vi.mock("../../lib/analytics", () => ({ track }));
// The card only needs Link to render an anchor; the real one wants a router.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, search: _search, ...rest }: {
    to: string;
    params?: { id?: string };
    search?: unknown;
    children?: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to.replace("$id", params?.id ?? "")} {...rest}>{children}</a>
  ),
}));

vi.stubEnv("VITE_LIVE_BACKEND_URL", "https://live.test");
const { SkinCard } = await import("./SkinCard");

const SKIN: SkinSummary = {
  id: "6f1c0f6c-0000-4000-8000-000000000001",
  slug: "aleju03-lazer",
  name: "aleju03 lazer",
  author: "aleju03",
  description: null,
  ownerUserId: 12345,
  ownerUsername: "Aleju03",
  keymodes: [4, 7],
  accentColor: "#88ccff",
  downloadCount: 0,
  previewUrl: "https://cdn.test/preview-4k.webp",
  previewWidth: 1280,
  previewHeight: 720,
  previews: [],
  screenshots: [],
  oskUrl: "https://cdn.test/skin.osk",
  oskSizeBytes: 5_976_883,
  oskSha256: null,
  oskUpdatedAt: null,
  status: "published",
  publishedAt: new Date().toISOString(),
};

afterEach(() => {
  cleanup();
  track.mockReset();
});

describe("SkinCard", () => {
  it("offers the .osk straight from the grid, through the counted download", () => {
    render(<SkinCard skin={SKIN} />);

    const download = screen.getByLabelText("Download aleju03 lazer");
    expect(download.getAttribute("href")).toBe(`https://live.test/api/skins/download?id=${SKIN.id}`);
    // Downloads from the grid count the same as the ones from the skin page.
    fireEvent.click(download);
    expect(track).toHaveBeenCalledWith("skin_download", expect.objectContaining({ skin_ref: "aleju03-lazer" }));
  });

  it("keeps the download out of the card link, which cannot hold an anchor", () => {
    render(<SkinCard skin={SKIN} />);

    const cardLink = screen.getByRole("link", { name: /aleju03 lazer preview/i });
    expect(cardLink.getAttribute("href")).toBe("/skins/aleju03-lazer");
    // closest() walks up from the download itself: a nested anchor would show
    // up here, and nested anchors do not survive the browser's parser.
    expect(screen.getByLabelText("Download aleju03 lazer").closest("[href='/skins/aleju03-lazer']")).toBeNull();
  });

  it("has nothing to download when the skin carries no file", () => {
    render(<SkinCard skin={{ ...SKIN, oskUrl: null }} />);
    expect(screen.queryByLabelText("Download aleju03 lazer")).toBeNull();
  });
});
