// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "../../lib/i18n";
import type { SkinSummary } from "../../lib/skins";

vi.stubEnv("VITE_LIVE_BACKEND_URL", "https://live.test");
// jsdom has no object URLs; the drafts only need them released.
URL.revokeObjectURL = vi.fn();

const calls: string[] = [];
const { skinApi } = vi.hoisted(() => ({
  skinApi: {
    startSkinEdit: vi.fn(),
    uploadSkinPart: vi.fn(),
    finishSkinEdit: vi.fn(),
    removeSkinScreenshot: vi.fn(),
    setSkinCover: vi.fn(),
    setSkinScreenshotLabels: vi.fn(),
  },
}));

vi.mock("../../lib/skins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/skins")>()),
  ...skinApi,
}));
vi.mock("../../lib/skin-screenshot-process", () => ({
  processScreenshot: vi.fn(async (file: File) => ({
    blob: new Blob([file.name]),
    width: 1920,
    height: 1080,
    url: `blob:${file.name}`,
  })),
}));
vi.mock("./SkinPreviewPickers", () => ({ SkinPreviewPickers: () => null }));
vi.mock("./SkinBackdropPicker", () => ({
  useSkinBackdropPool: () => ({ candidates: [], drawing: false, shuffle: vi.fn(), drop: vi.fn(), image: vi.fn(), decoded: new Map() }),
}));
vi.mock("./SkinPatternPicker", () => ({
  useSkinPatternPool: () => ({ candidates: [], keys: 4, drawing: false, shuffle: vi.fn(), ensure: vi.fn() }),
}));
vi.mock("../../lib/analytics", () => ({ track: vi.fn() }));

const { SkinPreviewEditorModal } = await import("./SkinPreviewEditorModal");

const OLD_SHOT = { key: "skins/x/shot-0.webp", url: "https://cdn.test/shot-0.webp", width: 1920, height: 1080, label: "Old" };
const SKIN: SkinSummary = {
  id: "6f1c0f6c-0000-4000-8000-000000000001",
  slug: "r-skin",
  name: "R Skin",
  author: "Retsukiya",
  description: null,
  ownerUserId: 12345,
  ownerUsername: "owner",
  keymodes: [4],
  accentColor: null,
  downloadCount: 0,
  previewUrl: OLD_SHOT.url,
  previewWidth: 1920,
  previewHeight: 1080,
  previews: [{ keys: 4, url: "https://cdn.test/preview-4k.png", width: 1280, height: 720 }],
  screenshots: [OLD_SHOT],
  oskUrl: "https://live.test/api/skins/file/6f1c0f6c/skin.osk",
  oskSizeBytes: 1000,
  oskSha256: null,
  oskUpdatedAt: null,
  status: "published",
  visibility: "public",
  publishedAt: null,
} as SkinSummary;

afterEach(() => {
  cleanup();
  calls.length = 0;
  Object.values(skinApi).forEach((mock) => mock.mockReset());
});

describe("SkinPreviewEditorModal screenshots", () => {
  it("swaps an old screenshot for a new one and moves the card onto it", async () => {
    skinApi.removeSkinScreenshot.mockImplementation(async ({ data }) => {
      calls.push(`remove:${data.screenshot}`);
      return { ok: true, skin: { ...SKIN, screenshots: [] } };
    });
    skinApi.startSkinEdit.mockImplementation(async () => {
      calls.push("start");
      return { ok: true, id: SKIN.id, token: "ticket", expiresAt: "" };
    });
    skinApi.uploadSkinPart.mockImplementation(async (options: { part: string; label?: string }) => {
      calls.push(`upload:${options.part}:${options.label}`);
    });
    skinApi.finishSkinEdit.mockImplementation(async () => {
      calls.push("finish");
      return SKIN;
    });
    skinApi.setSkinCover.mockImplementation(async ({ data }) => {
      calls.push(`cover:${data.screenshot}`);
      return { ok: true, skin: SKIN };
    });
    const onSaved = vi.fn();
    const { container } = render(
      <I18nProvider i18n={getI18n("en")}>
        <SkinPreviewEditorModal skin={SKIN} open onClose={vi.fn()} onSaved={onSaved} />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /remove screenshot 1/i }));
    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]') ?? container.querySelector("input");
    fireEvent.change(input!, { target: { files: [new File(["x"], "lazer.png", { type: "image/png" })] } });
    const nameField = await screen.findByRole("textbox", { name: /name for screenshot 1/i });
    fireEvent.change(nameField, { target: { value: "Lazer" } });
    fireEvent.click(screen.getByRole("button", { name: /use screenshot 1 as the card cover/i }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // The old shot leaves before the new one arrives (the limit counts both),
    // and the cover goes last, by the position the new shot ends up at.
    expect(calls).toEqual(["start", "remove:0", "upload:screenshot:Lazer", "finish", "cover:0"]);
  });
});
