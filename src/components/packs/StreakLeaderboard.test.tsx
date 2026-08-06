// @vitest-environment jsdom
/* The board is public and its records are permanent, so the only moderation
   that exists is removing one, and it lives on the board itself. These cover
   who is offered that and what one click does, since a stray click here would
   delete somebody's record. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LiveStreakBoard } from "#/lib/live-backend";

const removeLiveStreakBest = vi.hoisted(() => vi.fn());
vi.mock("#/lib/live-backend", () => ({
  fetchLiveStreakBoard: vi.fn(),
  removeLiveStreakBest,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params }: { children?: React.ReactNode; params?: { username?: string } }) => (
    <a href={`/player/${params?.username ?? ""}`}>{children}</a>
  ),
}));

const { StreakLeaderboard } = await import("./StreakLeaderboard");

const board: LiveStreakBoard = {
  pool: "top500",
  entries: [
    { rank: 1, userId: 11, username: "alpha", streak: 31, achievedAt: 1 },
    { rank: 2, userId: 22, username: "bravo", streak: 12, achievedAt: 2 },
  ],
  viewer: null,
};

afterEach(() => {
  cleanup();
  removeLiveStreakBest.mockReset();
});

it("offers nobody but an admin a way to remove a record", () => {
  render(<StreakLeaderboard board={board} failed={false} viewerId={11} />);
  expect(screen.getByText("alpha")).toBeTruthy();
  expect(screen.queryByLabelText("Remove alpha's streak")).toBeNull();
});

it("takes two clicks, sends the row's account and the board's pool, then re-reads", async () => {
  removeLiveStreakBest.mockResolvedValue({ ok: true, removed: true, entry: null, runsDeleted: 1 });
  const onRemoved = vi.fn();
  render(<StreakLeaderboard board={board} failed={false} viewerId={null} canModerate onRemoved={onRemoved} />);

  fireEvent.click(screen.getByLabelText("Remove bravo's streak"));
  // Arming is not removing: nothing has been sent yet.
  expect(removeLiveStreakBest).not.toHaveBeenCalled();

  fireEvent.click(screen.getByText("remove"));
  await waitFor(() => expect(onRemoved).toHaveBeenCalled());
  expect(removeLiveStreakBest).toHaveBeenCalledWith({ data: { userId: 22, pool: "top500" } });
});

it("lets an armed row be backed out of", () => {
  render(<StreakLeaderboard board={board} failed={false} viewerId={null} canModerate />);
  fireEvent.click(screen.getByLabelText("Remove alpha's streak"));
  fireEvent.click(screen.getByText("no"));
  expect(screen.getByLabelText("Remove alpha's streak")).toBeTruthy();
  expect(removeLiveStreakBest).not.toHaveBeenCalled();
});

it("says so when the removal is refused, and leaves the row alone", async () => {
  removeLiveStreakBest.mockRejectedValue(new Error("only available to admin users."));
  const onRemoved = vi.fn();
  render(<StreakLeaderboard board={board} failed={false} viewerId={null} canModerate onRemoved={onRemoved} />);
  fireEvent.click(screen.getByLabelText("Remove alpha's streak"));
  fireEvent.click(screen.getByText("remove"));
  await waitFor(() => expect(screen.getByText("only available to admin users.")).toBeTruthy());
  expect(onRemoved).not.toHaveBeenCalled();
  expect(screen.getByText("alpha")).toBeTruthy();
});
