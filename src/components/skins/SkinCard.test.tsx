// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { SkinSummary } from "../../lib/skins";
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

// jsdom has no IntersectionObserver. This stand-in records what each card
// watches and lets a test scroll a card into or out of view by hand.
type SeenCallback = (entries: IntersectionObserverEntry[]) => void;
const observed = new Map<Element, SeenCallback>();
class FakeIntersectionObserver {
  constructor(private readonly callback: SeenCallback) {}
  observe(element: Element) {
    observed.set(element, this.callback);
  }
  unobserve(element: Element) {
    observed.delete(element);
  }
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
function scrollTo(element: Element, ratio: number) {
  observed.get(element)?.([{ target: element, intersectionRatio: ratio, isIntersecting: ratio > 0 } as IntersectionObserverEntry]);
}

const { SkinCard, SkinPreviewImage, HOVER_VIEW_DWELL_MS, SEEN_VIEW_DWELL_MS } = await import("./SkinCard");
const { SKIN_VIEW_FLUSH_MS, resetSkinViewQueue } = await import("../../lib/skin-view-queue");

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
  viewCount: 0,
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
  visibility: "public",
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

  it("credits the author, and credits nobody when the skin has none", () => {
    render(<SkinCard skin={SKIN} />);
    expect(screen.getByText("aleju03")).toBeTruthy();
    cleanup();

    // The uploader is not the author: standing them in that spot claimed they
    // drew it. The skin page still says "uploaded by" in full.
    render(<SkinCard skin={{ ...SKIN, author: null }} />);
    expect(screen.queryByText("aleju03")).toBeNull();
    expect(screen.queryByText("Aleju03")).toBeNull();
  });

  it("ages off the day the skin reached the catalog, not the day it was uploaded", () => {
    const uploaded = new Date(Date.now() - 40 * 86400_000).toISOString();
    const listed = new Date(Date.now() - 2 * 86400_000).toISOString();

    // A skin uploaded private and made public two days ago is two days old on
    // the grid, which is the order the newest sort just put it in.
    const { container } = render(<SkinCard skin={{ ...SKIN, publishedAt: uploaded, listedAt: listed }} />);
    expect(container.textContent).toContain("2d ago");
    cleanup();

    // A summary cached before the field existed still has a date to show.
    const older = render(<SkinCard skin={{ ...SKIN, publishedAt: uploaded, listedAt: undefined }} />);
    expect(older.container.textContent).toContain("1mo ago");
  });

  it("names the uploader on the moderation shelf, where every uploader's skins are mixed", () => {
    const { container } = render(<SkinCard skin={{ ...SKIN, author: null }} showUploader />);
    expect(screen.getByText("Aleju03")).toBeTruthy();
    expect(container.textContent).toContain("uploaded by");
  });

  it("has nothing to download when the skin carries no file", () => {
    render(<SkinCard skin={{ ...SKIN, oskUrl: null }} />);
    expect(screen.queryByLabelText("Download aleju03 lazer")).toBeNull();
  });

  it("shows downloads and views compactly, spelling both out for a screen reader", () => {
    render(<SkinCard skin={{ ...SKIN, downloadCount: 1203, viewCount: 45_600 }} />);
    // Two counts share the space one spelled-out figure held, so both shorten.
    expect(screen.getByText("1.2k")).toBeTruthy();
    expect(screen.getByText("46k")).toBeTruthy();
    // The exact numbers stay reachable, since the icons carry no words.
    expect(screen.getByLabelText("1,203 downloads, 45,600 views")).toBeTruthy();
  });

  it("counts nothing on a private skin, which only its owner can see", () => {
    render(<SkinCard skin={{ ...SKIN, visibility: "private", downloadCount: 4, viewCount: 9 }} />);
    expect(screen.getByText("only you")).toBeTruthy();
    expect(screen.queryByText("4")).toBeNull();
    expect(screen.queryByText("9")).toBeNull();
  });

  // Summaries cached before views existed lack the field entirely.
  it("reads a missing view count as zero rather than rendering a hole", () => {
    const { viewCount: _dropped, ...withoutViews } = SKIN;
    render(<SkinCard skin={withoutViews} />);
    expect(screen.getByLabelText("0 downloads, 0 views")).toBeTruthy();
  });

  it("fronts the note-filter proof render unless an explicit keymode wins", () => {
    const mixed: SkinSummary = {
      ...SKIN,
      filterKeys: 7,
      previews: [
        { keys: 4, url: "https://cdn.test/preview-4k.webp", width: 1280, height: 720 },
        { keys: 7, url: "https://cdn.test/preview-7k.webp", width: 1280, height: 720 },
      ],
    };
    render(<SkinCard skin={mixed} />);
    expect(screen.getByAltText("aleju03 lazer preview").getAttribute("src")).toBe("https://cdn.test/preview-7k.webp");
    cleanup();

    render(<SkinCard skin={mixed} previewKeys={4} />);
    expect(screen.getByAltText("aleju03 lazer preview").getAttribute("src")).toBe("https://cdn.test/preview-4k.webp");
  });
});

// React derives onPointerEnter/Leave from pointerover/out, and jsdom has no
// PointerEvent, so the pointerType React reads off the native event is pinned
// onto a MouseEvent by hand.
function pointer(type: "pointerover" | "pointerout", pointerType: string) {
  const event = new MouseEvent(type, { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  return event;
}

// Grid views. Each test uses a skin with its own slug: the queue remembers
// what it sent for the life of the page, so a shared slug would make one
// test's view swallow the next one's.
describe("SkinCard grid views", () => {
  const viewsUrl = "https://live.test/api/skins/views";
  const sentIds = () => fetchSpy.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).ids as string[]);
  let fetchSpy: MockInstance<typeof fetch>;
  beforeEach(() => {
    vi.useFakeTimers();
    resetSkinViewQueue();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it("counts a hover that settles, once per skin for the page's life", () => {
    const { container } = render(<SkinCard skin={{ ...SKIN, slug: "hover-settles" }} />);
    const card = container.firstElementChild!;

    fireEvent(card, pointer("pointerover", "mouse"));
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(HOVER_VIEW_DWELL_MS + SKIN_VIEW_FLUSH_MS);
    expect(fetchSpy).toHaveBeenCalledWith(viewsUrl, expect.objectContaining({ method: "POST", keepalive: true }));
    expect(sentIds()).toEqual([["hover-settles"]]);

    // Coming back to the same card sends nothing new, nor does it being seen.
    fireEvent(card, pointer("pointerout", "mouse"));
    fireEvent(card, pointer("pointerover", "mouse"));
    scrollTo(card, 1);
    vi.advanceTimersByTime(SEEN_VIEW_DWELL_MS + SKIN_VIEW_FLUSH_MS);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not count a mouse just passing through", () => {
    const { container } = render(<SkinCard skin={{ ...SKIN, slug: "swept-past" }} />);
    const card = container.firstElementChild!;

    fireEvent(card, pointer("pointerover", "mouse"));
    vi.advanceTimersByTime(HOVER_VIEW_DWELL_MS - 100);
    fireEvent(card, pointer("pointerout", "mouse"));
    vi.advanceTimersByTime(HOVER_VIEW_DWELL_MS * 2 + SKIN_VIEW_FLUSH_MS);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ignores the enter a touch tap fires on its way to a click", () => {
    const { container } = render(<SkinCard skin={{ ...SKIN, slug: "tapped" }} />);
    fireEvent(container.firstElementChild!, pointer("pointerover", "touch"));
    vi.advanceTimersByTime(HOVER_VIEW_DWELL_MS * 2 + SKIN_VIEW_FLUSH_MS);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("counts every card a scroll settles on, as one request", () => {
    const first = render(<SkinCard skin={{ ...SKIN, slug: "seen-first" }} />).container.firstElementChild!;
    const second = render(<SkinCard skin={{ ...SKIN, slug: "seen-second" }} />).container.firstElementChild!;

    scrollTo(first, 1);
    vi.advanceTimersByTime(100);
    scrollTo(second, 0.6);
    vi.advanceTimersByTime(SEEN_VIEW_DWELL_MS);
    // Both dwelled; nothing has left yet because the queue waits for the rest.
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SKIN_VIEW_FLUSH_MS);
    expect(sentIds()).toEqual([["seen-first", "seen-second"]]);
  });

  it("does not count a card flicked past or only half shown", () => {
    const flicked = render(<SkinCard skin={{ ...SKIN, slug: "flicked" }} />).container.firstElementChild!;
    const clipped = render(<SkinCard skin={{ ...SKIN, slug: "clipped" }} />).container.firstElementChild!;

    scrollTo(flicked, 1);
    vi.advanceTimersByTime(SEEN_VIEW_DWELL_MS - 100);
    scrollTo(flicked, 0.2);
    scrollTo(clipped, 0.3);
    vi.advanceTimersByTime(SEEN_VIEW_DWELL_MS * 2 + SKIN_VIEW_FLUSH_MS);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends what is queued when the page hides, before the flush would", () => {
    const card = render(<SkinCard skin={{ ...SKIN, slug: "left-early" }} />).container.firstElementChild!;
    scrollTo(card, 1);
    vi.advanceTimersByTime(SEEN_VIEW_DWELL_MS);
    expect(fetchSpy).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pagehide"));
    expect(sentIds()).toEqual([["left-early"]]);
    vi.advanceTimersByTime(SKIN_VIEW_FLUSH_MS * 2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // A download from the grid is a view too, but that is the backend's own
  // invariant (recordSkinDownload moves both counts), not a ping from here.
  it("never pings for a skin without a public number to move", () => {
    const { container } = render(<SkinCard skin={{ ...SKIN, slug: "kept-private", visibility: "private" }} />);
    const card = container.firstElementChild!;
    fireEvent(card, pointer("pointerover", "mouse"));
    scrollTo(card, 1);
    vi.advanceTimersByTime(SEEN_VIEW_DWELL_MS * 2 + SKIN_VIEW_FLUSH_MS);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// The cover a browse card shows is the same file the skin page it opens leads
// with, so the second mount of that url must not start invisible: the fade is
// for a picture arriving, not for one the reader was already looking at.
describe("SkinPreviewImage", () => {
  it("fades in a preview this session has not shown yet", () => {
    render(<SkinPreviewImage src="https://cdn.test/cold.webp" alt="cold" className="cover" />);
    expect(screen.getByAltText("cold").className).toContain("opacity-0");
  });

  it("mounts a preview it has already painted at full opacity", () => {
    const { unmount } = render(<SkinPreviewImage src="https://cdn.test/warm.webp" alt="warm" className="cover" />);
    const first = screen.getByAltText("warm");
    expect(first.className).toContain("opacity-0");
    fireEvent.load(first);
    expect(first.className).toContain("opacity-100");
    unmount();

    render(<SkinPreviewImage src="https://cdn.test/warm.webp" alt="warm" className="cover" />);
    expect(screen.getByAltText("warm").className).toContain("opacity-100");
  });
});
