// @vitest-environment jsdom
import { cleanup, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimilarSkin, SkinSummary } from "../../lib/skins";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "../../lib/i18n";


// These components read copy through Lingui, so renders need the provider;
// en resolves to the source strings the assertions match.
const I18nWrap = ({ children }: { children: ReactNode }) => (
  <I18nProvider i18n={getI18n("en")}>{children}</I18nProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: I18nWrap });

const track = vi.hoisted(() => vi.fn());
vi.mock("../../lib/analytics", () => ({ track }));
// The cards only need Link to render an anchor; the real one wants a router.
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

// Only the network call is stubbed; the cards render through the real module.
const fetchSimilarSkins = vi.hoisted(() => vi.fn<(ref: string, keys?: number | null) => Promise<SimilarSkin[]>>());
vi.mock("../../lib/skins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/skins")>()),
  fetchSimilarSkins,
}));

vi.stubEnv("VITE_LIVE_BACKEND_URL", "https://live.test");
const { SimilarSkins } = await import("./SimilarSkins");

const SKIN: SkinSummary = {
  id: "6f1c0f6c-0000-4000-8000-000000000002",
  slug: "neighbour",
  name: "Neighbour",
  author: "sona",
  description: null,
  ownerUserId: 202,
  ownerUsername: "Echo",
  keymodes: [4],
  specialKeymodes: [],
  accentColor: "#88ccff",
  downloadCount: 3,
  previewUrl: "https://cdn.test/neighbour.webp",
  previewWidth: 1280,
  previewHeight: 720,
  previews: [],
  screenshots: [],
  oskUrl: "https://cdn.test/neighbour.osk",
  oskSizeBytes: 1024,
  oskSha256: null,
  oskUpdatedAt: null,
  status: "published",
  visibility: "public",
  publishedAt: new Date().toISOString(),
};

afterEach(() => {
  cleanup();
  fetchSimilarSkins.mockReset();
});

describe("SimilarSkins", () => {
  it("shows nothing until lookalikes arrive, then a card per skin", async () => {
    fetchSimilarSkins.mockResolvedValue([SKIN]);
    const { container } = render(<SimilarSkins skinRef="target" />);
    expect(container.textContent).toBe("");

    await waitFor(() => expect(screen.getByText("Similar skins")).toBeTruthy());
    expect(fetchSimilarSkins).toHaveBeenCalledWith("target", undefined);
    expect(screen.getByRole("link", { name: /neighbour preview/i }).getAttribute("href")).toBe("/skins/neighbour");
  });

  const WITH_PREVIEWS: SimilarSkin = {
    ...SKIN,
    previews: [
      { keys: 4, url: "https://cdn.test/neighbour-4k.webp", width: 1280, height: 720 },
      { keys: 6, url: "https://cdn.test/neighbour-6k.webp", width: 1280, height: 720 },
    ],
    matchKeys: 6,
  };

  it("asks the backend for the keymode the viewer has open, and fronts that render", async () => {
    fetchSimilarSkins.mockResolvedValue([{ ...WITH_PREVIEWS, matchKeys: 4 }]);
    render(<SimilarSkins skinRef="target" keys={4} />);
    await waitFor(() => expect(screen.getByAltText("Neighbour preview")).toBeTruthy());
    expect(fetchSimilarSkins).toHaveBeenCalledWith("target", 4);
    expect(screen.getByAltText("Neighbour preview").getAttribute("src")).toBe("https://cdn.test/neighbour-4k.webp");
  });

  it("asks again when the viewer opens another keymode", async () => {
    fetchSimilarSkins.mockResolvedValue([WITH_PREVIEWS]);
    const { rerender } = render(<SimilarSkins skinRef="target" keys={4} />);
    await waitFor(() => expect(fetchSimilarSkins).toHaveBeenCalledWith("target", 4));
    // The answer is per keymode, so switching playfields is a new question,
    // not a re-render of the old answer.
    rerender(<SimilarSkins skinRef="target" keys={6} />);
    await waitFor(() => expect(fetchSimilarSkins).toHaveBeenCalledWith("target", 6));
    await waitFor(() => expect(screen.getByAltText("Neighbour preview").getAttribute("src")).toBe("https://cdn.test/neighbour-6k.webp"));
  });

  it("vanishes whole, heading included, when nothing is similar", async () => {
    fetchSimilarSkins.mockResolvedValue([]);
    const { container } = render(<SimilarSkins skinRef="loner" />);
    await waitFor(() => expect(fetchSimilarSkins).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
