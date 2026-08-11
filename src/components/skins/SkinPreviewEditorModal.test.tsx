// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkinSummary } from "../../lib/skins";

vi.stubEnv("VITE_LIVE_BACKEND_URL", "https://live.test");

const { importOsk, renderPreview } = vi.hoisted(() => ({
  importOsk: vi.fn(),
  renderPreview: vi.fn(),
}));

// The pickers are a row of thumbnails over a pool the backend deals; all this
// test needs from them is the one click that starts the download.
vi.mock("./SkinPreviewPickers", () => ({
  SkinPreviewPickers: ({ backdrop }: { backdrop: { onPick: (choice: string) => void } }) => (
    <button type="button" onClick={() => backdrop.onPick("flat")}>pick flat</button>
  ),
}));
vi.mock("./SkinBackdropPicker", () => ({
  useSkinBackdropPool: () => ({
    candidates: [],
    drawing: false,
    shuffle: vi.fn(),
    drop: vi.fn(),
    image: vi.fn(async () => null),
    decoded: new Map(),
  }),
}));
vi.mock("./SkinPatternPicker", () => ({
  useSkinPatternPool: () => ({ candidates: [], keys: 4, drawing: false, shuffle: vi.fn(), ensure: vi.fn() }),
}));
vi.mock("../../lib/replay-skin-import", () => ({ importReplaySkinFromOsk: importOsk }));
vi.mock("../../lib/skin-preview-render", () => ({ renderSkinPreview: renderPreview }));

const { SkinPreviewEditorModal } = await import("./SkinPreviewEditorModal");

const SKIN: SkinSummary = {
  id: "6f1c0f6c-0000-4000-8000-000000000001",
  slug: "r-skin",
  name: "R Skin",
  author: "Retsukiya",
  description: null,
  ownerUserId: 12345,
  ownerUsername: "Miffey",
  keymodes: [4],
  accentColor: null,
  downloadCount: 0,
  previewUrl: null,
  previewWidth: null,
  previewHeight: null,
  previews: [],
  screenshots: [],
  oskUrl: "https://live.test/api/skins/file/6f1c0f6c/skin.osk",
  oskSizeBytes: 8_434_014,
  oskSha256: null,
  oskUpdatedAt: null,
  status: "published",
  visibility: "public",
  publishedAt: null,
};

function archiveResponse(): unknown {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: null,
    blob: async () => new Blob(["osk"]),
  };
}

function renderEditor() {
  return render(<SkinPreviewEditorModal skin={SKIN} open onClose={vi.fn()} onSaved={vi.fn()} />);
}

// The pick is what pulls the .osk down; everything under test hangs off it.
async function pickBackdrop() {
  fireEvent.click(await screen.findByRole("button", { name: /pick flat/i }));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  importOsk.mockReset();
  renderPreview.mockReset();
});

describe("SkinPreviewEditorModal download failures", () => {
  it("runs again on its own before saying anything, and blames the download", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection reset"));
    vi.stubGlobal("fetch", fetchMock);
    renderEditor();

    await pickBackdrop();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // The first drop is quiet: the strip keeps reading as a download in
    // progress rather than red text the retry would erase.
    expect(screen.queryByText(/could not be/i)).toBeNull();
    expect(screen.getByText(/downloading the skin file/i)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByText(/could not be downloaded/i)).toBeTruthy());
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  it("takes a manual retry once the automatic one is spent", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection reset"));
    vi.stubGlobal("fetch", fetchMock);
    renderEditor();

    await pickBackdrop();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // The second failure leaves the offer standing, and the .osk arrives on
    // the third try: the error clears rather than sticking for the session.
    importOsk.mockResolvedValue({ settings: {}, summary: { keymodes: [4] }, sounds: {} });
    renderPreview.mockResolvedValue({ blob: new Blob(["png"]), width: 1280, height: 720, accent: "#fff" });
    fetchMock.mockResolvedValue(archiveResponse());
    fireEvent.click(await screen.findByRole("button", { name: /try again/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByText(/could not be downloaded/i)).toBeNull());
  });

  it("goes past the HTTP cache on the second try, since the stored copy is a suspect", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    renderEditor();

    await pickBackdrop();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "default" });

    // A cached answer to the download button's Origin-less request carries no
    // allow-origin header, and a browser holding one fails this fetch before
    // it reaches the network. The retry must not be handed the same copy.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ cache: "reload" });
  });

  it("says the file is unreadable only when the parse is what failed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(archiveResponse()));
    importOsk.mockRejectedValue(new Error("No skin.ini was found in this .osk file."));
    renderEditor();

    await pickBackdrop();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await waitFor(() => expect(screen.getByText(/could not be read/i)).toBeTruthy());
    expect(screen.queryByText(/could not be downloaded/i)).toBeNull();
  });

  it("says a missing object is missing, without a retry that cannot help", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);
    renderEditor();

    await pickBackdrop();
    await waitFor(() => expect(screen.getByText(/not in storage/i)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The offer still stands in case storage gets fixed under them; it just
    // does not fire on its own for a 404.
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("names the rate limit instead of the file when the backend turns it away", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    renderEditor();

    await pickBackdrop();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await waitFor(() => expect(screen.getByText(/too many requests/i)).toBeTruthy());
  });
});
