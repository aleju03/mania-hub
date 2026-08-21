// @vitest-environment jsdom
/* The album cover's triangle field is positioned entirely by an inline
   animation-delay, so anything that restamps that delay teleports the whole
   field -- which is what "the triangle animation resets the moment i release
   the cover" was. And the shelf stays mounted behind an open album, so it needs
   a memo boundary or every page turn re-renders ~90 covers nobody can see. */
import { useState, type ReactElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render as rtlRender } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AlbumShelf,
  CoverTriangles,
  GoatSlot,
  albumCountText,
  albumSubtitle,
  useFramePulse,
} from "./AlbumView";
import { buildAlbumSections, GOAT_ALBUM_ROSTER } from "./albumModel";
import { getI18n } from "../../../lib/i18n";
import { I18nProvider } from "@lingui/react";

// The album components read copy through Lingui; en resolves to the source
// strings these tests assert on.
const I18nWrap = ({ children }: { children: ReactNode }) => (
  <I18nProvider i18n={getI18n("en")}>{children}</I18nProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: I18nWrap });

/* The three drift layers, in the order CoverTriangles renders them. */
const LAYER_DURATIONS = [26, 40, 58];

/* memo() stops a parent re-render from reaching the component at all, which is
   one half of the fix; unwrapping it exercises the other half -- that the
   component re-rendering does not restamp its phase. */
const RawCoverTriangles = (CoverTriangles as unknown as { type: () => ReactElement }).type;

function layerStyles(container: HTMLElement): Array<string | null> {
  return Array.from(container.querySelectorAll(".album-tri-layer")).map((node) =>
    node.getAttribute("style"),
  );
}

function delaySeconds(style: string | null): number {
  const match = /animation-delay:\s*(-?\d+(?:\.\d+)?)s/.exec(style ?? "");
  if (!match) throw new Error(`no animation-delay in ${style}`);
  return Number(match[1]);
}

/* vitest runs without globals, so testing-library's own auto-cleanup hook never
   registers and renders would pile up in one document. */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CoverTriangles", () => {
  it("stamps the drift phase once and never restamps it on a re-render", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    function Host() {
      const [tick, setTick] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setTick(tick + 1)}>
            bump {tick}
          </button>
          <RawCoverTriangles />
        </div>
      );
    }
    const { container, getByRole } = render(<Host />);
    const before = layerStyles(container);
    expect(before).toHaveLength(3);

    /* Nine seconds pass, then the parent re-renders -- exactly what a page turn
       does through setCurrentPage. Restamping here shifted the animation's local
       time by the whole gap and the field visibly jumped. */
    now.mockReturnValue(1_700_000_009_000);
    act(() => {
      fireEvent.click(getByRole("button"));
    });
    expect(layerStyles(container)).toEqual(before);
  });

  it("locks every instance to the same wall-clock phase whenever it mounts", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const first = layerStyles(render(<CoverTriangles />).container);
    now.mockReturnValue(1_700_000_009_000);
    const second = layerStyles(render(<CoverTriangles />).container);

    /* Two covers mounted nine seconds apart carry different stamps... */
    expect(second).not.toEqual(first);
    /* ...but land on the same point of the drift, which is what keeps the
       stand-in cover and the book's own cover face in step across the hand-off. */
    LAYER_DURATIONS.forEach((duration, index) => {
      expect((1_700_000_000 + delaySeconds(first[index])) % duration).toBe(0);
      expect((1_700_000_009 + delaySeconds(second[index])) % duration).toBe(0);
    });
  });

  it("is a memo barrier, so AlbumView state changes never walk the mounted covers", () => {
    expect((CoverTriangles as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    );
  });
});

describe("useFramePulse", () => {
  it("collapses a burst of pulses into one render on the next frame", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    let renders = 0;
    let pulse = () => {};
    function Host() {
      renders += 1;
      pulse = useFramePulse();
      return null;
    }
    render(<Host />);
    expect(renders).toBe(1);

    /* Six thumbnails landing in six separate tasks: React cannot batch those,
       so unbatched this is six full AlbumView renders mid page turn. */
    act(() => {
      for (let index = 0; index < 6; index += 1) pulse();
    });
    expect(frames).toHaveLength(1);
    expect(renders).toBe(1);

    act(() => {
      frames[0](0);
    });
    expect(renders).toBe(2);

    // The next batch schedules a fresh frame rather than being swallowed.
    act(() => {
      pulse();
    });
    expect(frames).toHaveLength(2);
  });

  it("cancels a pending frame when the album unmounts", () => {
    const cancelled: number[] = [];
    vi.stubGlobal("requestAnimationFrame", () => 77);
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      cancelled.push(handle);
    });
    let pulse = () => {};
    function Host() {
      pulse = useFramePulse();
      return null;
    }
    const { unmount } = render(<Host />);
    act(() => {
      pulse();
    });
    unmount();
    expect(cancelled).toEqual([77]);
  });
});

describe("cover captions", () => {
  const en = getI18n("en");
  it("pluralizes and localizes the card count", () => {
    const counts = new Map([
      ["CR", 1],
      ["US", 1234],
    ]);
    expect(albumCountText(counts, "CR", en)).toBe("1 card");
    expect(albumCountText(counts, "US", en)).toBe("1,234 cards");
    expect(albumCountText(counts, "JP", en)).toBe("0 cards");
  });

  it("labels the Global album by its cap", () => {
    expect(albumSubtitle("GLOBAL", en)).toBe("Top 100 players");
    expect(albumSubtitle("GOAT", en)).toBe("Honorary roster");
    expect(albumSubtitle("CR", en)).toBe("Card collection");
  });
});

/* The point of the GOATs album: a member you have not pulled gives nothing
   away. Anything that leaks a name, a face or a profile link out of an
   uncollected slot defeats it. */
describe("GoatSlot", () => {
  const player = GOAT_ALBUM_ROSTER[0];
  const noop = () => {};

  it("keeps an uncollected member face-down", () => {
    const { container } = render(
      <GoatSlot
        player={player}
        card={null}
        owned={false}
        thumbnail={null}
        lifted={false}
        onSpotlight={noop}
        onThumbnailError={noop}
      />,
    );
    expect(container.textContent).toBe("");
    expect(container.innerHTML).not.toContain(player.username);
    expect(container.innerHTML).not.toContain(player.avatarUrl);
    expect(container.querySelector("button")).toBeNull();
  });

  it("names a member the reader already holds", () => {
    const { container, getByText } = render(
      <GoatSlot
        player={player}
        card={null}
        owned
        thumbnail={null}
        lifted={false}
        onSpotlight={noop}
        onThumbnailError={noop}
      />,
    );
    expect(getByText(player.cardName ?? player.username)).toBeTruthy();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(player.avatarUrl);
  });

  const card = {
    userId: player.id,
    username: player.username,
    avatarUrl: player.avatarUrl,
    countryCode: player.countryCode,
    tier: "goat" as const,
    tierLabel: "GOAT",
    skills: null,
    pp: player.peakPp,
    globalRank: player.peakRank ?? 0,
    copies: 2,
    recycledCopies: 0,
    firstPulledAt: 0,
    lastPulledAt: 0,
  };

  it("opens the card itself once its art has loaded", () => {
    const onSpotlight = vi.fn();
    const { getByTitle, getByText } = render(
      <GoatSlot
        player={player}
        card={card}
        owned
        thumbnail="blob:card"
        lifted={false}
        onSpotlight={onSpotlight}
        onThumbnailError={noop}
      />,
    );
    expect(getByText("x2")).toBeTruthy();
    fireEvent.click(getByTitle(player.username));
    expect(onSpotlight).toHaveBeenCalledWith(card, "blob:card", expect.anything());
  });

  /* The spotlight flies the card out of its slot and back again, so a slot
     still drawing its card would put the same card on screen twice. */
  it("holds its place empty while the card is up in the spotlight", () => {
    const { container } = render(
      <GoatSlot
        player={player}
        card={card}
        owned
        thumbnail="blob:card"
        lifted
        onSpotlight={noop}
        onThumbnailError={noop}
      />,
    );
    expect((container.firstElementChild as HTMLElement).style.visibility).toBe("hidden");
  });
});

describe("AlbumShelf", () => {
  const sections = buildAlbumSections(["CR", "US", "JP"]);
  const counts = new Map([["CR", 3]]);

  /* The sort choice is persisted, so a leftover value would leak into the
     next test's shelf. */
  afterEach(() => {
    window.localStorage.clear();
  });

  function shelfOrder(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("button[aria-label^='Open the ']")).map(
      (node) => node.getAttribute("aria-label") ?? "",
    );
  }

  it("filters by name and reports the count against the full shelf", () => {
    const { getByLabelText, getByText, queryByLabelText } = render(
      <AlbumShelf sections={sections} counts={counts} onOpen={() => {}} />,
    );
    fireEvent.change(getByLabelText("Find an album"), { target: { value: "costa" } });
    expect(getByText("1 of 5 albums")).toBeTruthy();
    expect(queryByLabelText("Open the United States album")).toBeNull();

    fireEvent.change(getByLabelText("Find an album"), { target: { value: "zzz" } });
    expect(getByText('No album matches "zzz".')).toBeTruthy();
  });

  it("filters by country code too", () => {
    const { getByLabelText, getByText } = render(
      <AlbumShelf sections={sections} counts={counts} onOpen={() => {}} />,
    );
    fireEvent.change(getByLabelText("Find an album"), { target: { value: "jp" } });
    expect(getByText("1 of 5 albums")).toBeTruthy();
    expect(getByLabelText("Open the Japan album")).toBeTruthy();
  });

  it("opens an album by its section code", () => {
    const onOpen = vi.fn();
    const { getByLabelText } = render(
      <AlbumShelf sections={sections} counts={counts} onOpen={onOpen} />,
    );
    fireEvent.click(getByLabelText("Open the Costa Rica album"));
    expect(onOpen).toHaveBeenCalledWith("CR");
  });

  it("shelves the albums alphabetically until the reader asks for their biggest collections", () => {
    const owned = new Map([
      ["CR", 3],
      ["US", 12],
    ]);
    const { container, getByRole } = render(
      <AlbumShelf sections={sections} counts={owned} onOpen={() => {}} />,
    );
    expect(shelfOrder(container)).toEqual([
      "Open the Global album",
      "Open the GOATs album",
      "Open the Costa Rica album",
      "Open the Japan album",
      "Open the United States album",
    ]);

    fireEvent.click(getByRole("button", { name: "Most cards" }));
    expect(shelfOrder(container)).toEqual([
      "Open the Global album",
      "Open the GOATs album",
      "Open the United States album",
      "Open the Costa Rica album",
      "Open the Japan album",
    ]);

    fireEvent.click(getByRole("button", { name: "A-Z" }));
    expect(shelfOrder(container)[2]).toBe("Open the Costa Rica album");
  });

  it("remembers the chosen sort for the next visit", () => {
    const { getByRole, unmount } = render(
      <AlbumShelf sections={sections} counts={counts} onOpen={() => {}} />,
    );
    fireEvent.click(getByRole("button", { name: "Most cards" }));
    unmount();

    const second = render(<AlbumShelf sections={sections} counts={counts} onOpen={() => {}} />);
    expect(second.getByRole("button", { name: "Most cards" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("is a memo barrier, so an open album's page turns never re-render the hidden shelf", () => {
    expect((AlbumShelf as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
  });

  it("keeps the query across a parent re-render, since the state moved in with it", () => {
    function Host() {
      const [tick, setTick] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setTick(tick + 1)}>
            bump {tick}
          </button>
          <AlbumShelf sections={sections} counts={counts} onOpen={() => {}} />
        </div>
      );
    }
    const { getByLabelText, getByRole } = render(<Host />);
    fireEvent.change(getByLabelText("Find an album"), { target: { value: "costa" } });
    act(() => {
      fireEvent.click(getByRole("button", { name: /bump/ }));
    });
    expect((getByLabelText("Find an album") as HTMLInputElement).value).toBe("costa");
  });
});
