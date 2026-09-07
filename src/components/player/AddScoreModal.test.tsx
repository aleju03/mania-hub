// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getI18n, loadLocaleCatalog } from "../../lib/i18n";
import { submitLiveMissingScore, type LiveScoreSubmissionResult } from "../../lib/live-backend";
import { AddScoreModal } from "./AddScoreModal";

vi.mock("../../lib/live-backend", () => ({
  submitLiveMissingScore: vi.fn(),
  loadLiveMapSearchEntry: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../../lib/auth-context", () => ({ useAuth: () => ({ canUseAdminFeatures: false }) }));
vi.mock("../../lib/locale-context", () => ({ useLocale: () => "en" }));
vi.mock("../../lib/leaderboard-import", () => ({}));

function deferred() {
  let resolve!: (result: LiveScoreSubmissionResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<LiveScoreSubmissionResult>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function success(scoreId: number, alreadyTracked = false): LiveScoreSubmissionResult {
  return {
    ok: true, alreadyTracked, countries: ["CR"],
    play: {
      scoreId, beatmapId: null, title: `Chart ${scoreId}`, version: null,
      accuracy: 0.95, rank: "A", pp: null, endedAt: null,
      scoreUrl: `https://osu.ppy.sh/scores/${scoreId}`,
    },
  };
}

function setup() {
  const onSubmitted = vi.fn();
  const view = render(
    <I18nProvider i18n={getI18n("en")}>
      <AddScoreModal userId={123} username="Player" onClose={vi.fn()} onSubmitted={onSubmitted} />
    </I18nProvider>,
  );
  const input = view.getByRole("textbox", { name: "osu! score link" }) as HTMLInputElement;
  const paste = (id: number) => fireEvent.paste(input, {
    clipboardData: { getData: () => `https://osu.ppy.sh/scores/${id}` },
  });
  return { ...view, input, paste, onSubmitted };
}

beforeAll(() => loadLocaleCatalog("en"));
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(cleanup);

describe("AddScoreModal queue", () => {
  it("accepts successive pastes immediately, deduplicates pending links, and preserves the next draft", async () => {
    const first = deferred();
    const second = deferred();
    vi.mocked(submitLiveMissingScore).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = setup();
    view.paste(1);
    view.paste(2);
    view.paste(2);
    expect(view.input.value).toBe("");
    expect(view.getAllByText("queued")).toHaveLength(1);
    expect(submitLiveMissingScore).toHaveBeenCalledTimes(1);

    fireEvent.change(view.input, { target: { value: "next link being typed" } });
    expect((view.getByRole("button", { name: "Add score" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => first.resolve(success(1)));
    expect(submitLiveMissingScore).toHaveBeenNthCalledWith(2, 123, "https://osu.ppy.sh/scores/2");
    expect(view.input.value).toBe("next link being typed");
    expect(view.getByText("Chart 1")).toBeTruthy();

    await act(async () => second.resolve(success(2, true)));
    expect(view.input.value).toBe("next link being typed");
    expect(view.getByText("Chart 2")).toBeTruthy();
    expect(view.onSubmitted).toHaveBeenCalledTimes(1);
    expect(view.queryByText("importing")).toBeNull();
  });

  it("keeps failures attached to their links, continues the queue, and retries without clearing a draft", async () => {
    const first = deferred();
    const second = deferred();
    const retry = deferred();
    vi.mocked(submitLiveMissingScore)
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(retry.promise);
    const view = setup();
    view.paste(1);
    view.paste(2);
    await act(async () => first.resolve({ ok: false, reason: "not_owned", owner: "Someone" }));
    expect(view.getByText("That score belongs to a different player (Someone).")).toBeTruthy();
    expect(submitLiveMissingScore).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve(success(2)));
    fireEvent.change(view.input, { target: { value: "draft" } });
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    expect(submitLiveMissingScore).toHaveBeenNthCalledWith(3, 123, "https://osu.ppy.sh/scores/1");
    expect(view.input.value).toBe("draft");
    await act(async () => retry.resolve(success(1)));
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("continues after a rejected request", async () => {
    const first = deferred();
    vi.mocked(submitLiveMissingScore).mockReturnValueOnce(first.promise).mockResolvedValueOnce(success(2));
    const view = setup();
    view.paste(1);
    view.paste(2);
    await act(async () => first.reject(new Error("offline")));
    expect(view.getByText("Could not send that. Try again.")).toBeTruthy();
    expect(view.getByText("Chart 2")).toBeTruthy();
  });

  it("finishes queued submissions and refreshes the profile after the dialog closes", async () => {
    const first = deferred();
    vi.mocked(submitLiveMissingScore).mockReturnValueOnce(first.promise).mockResolvedValueOnce(success(2));
    const view = setup();
    view.paste(1);
    view.paste(2);
    view.unmount();
    await act(async () => first.resolve(success(1)));
    expect(submitLiveMissingScore).toHaveBeenCalledTimes(2);
    expect(view.onSubmitted).toHaveBeenCalledTimes(2);
  });
});
