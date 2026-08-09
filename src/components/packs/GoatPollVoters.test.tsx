// @vitest-environment jsdom
/* The board publishes a net number and nothing else, and this is the one place
   a vote has a name on it. These cover what an admin actually reads off it: the
   two sides apart, whose nomination it was, and a voter the backend could not
   put a name to still being a voter. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GoatPollNominee } from "#/lib/live-backend";

const fetchGoatPollVoters = vi.hoisted(() => vi.fn());
vi.mock("#/lib/goat-poll", () => ({ fetchGoatPollVoters }));

const { GoatPollVotersModal } = await import("./GoatPollVoters");

const nominee: GoatPollNominee = {
  id: "n1",
  osuUserId: 999,
  username: "Jakads",
  countryCode: "KR",
  avatarUrl: "https://a.ppy.sh/999",
  banned: false,
  proofUrl: null,
  nominatedBy: 7,
  createdAt: 1,
  up: 2,
  down: 1,
  net: 1,
};

const voters = [
  { userId: 7, username: "Voter Seven", avatarUrl: null, countryCode: "CR", value: 1 as const, votedAt: Date.now() },
  { userId: 8, username: "Voter Eight", avatarUrl: null, countryCode: null, value: 1 as const, votedAt: Date.now() },
  { userId: 9, username: null, avatarUrl: null, countryCode: null, value: -1 as const, votedAt: Date.now() },
];

afterEach(() => {
  cleanup();
  fetchGoatPollVoters.mockReset();
});

it("reads the ballot for the row it was opened on and names both sides", async () => {
  fetchGoatPollVoters.mockResolvedValue(voters);
  render(<GoatPollVotersModal nominee={nominee} onClose={() => {}} />);

  expect(fetchGoatPollVoters).toHaveBeenCalledWith({ data: { nomineeId: "n1" } });
  await waitFor(() => expect(screen.getByText("Voter Seven")).toBeTruthy());
  expect(screen.getByText("2 up · 1 down")).toBeTruthy();
  // The nominator's own upvote is marked, so a row propped up by whoever put it
  // there is visible as that.
  expect(screen.getAllByText("nominator")).toHaveLength(1);
  expect(screen.getByLabelText("voted against")).toBeTruthy();
  // No name anywhere the backend can look is still a voter, not a blank row.
  expect(screen.getByText("user 9")).toBeTruthy();
});

it("asks for nothing while no row is open", () => {
  render(<GoatPollVotersModal nominee={null} onClose={() => {}} />);
  expect(fetchGoatPollVoters).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("says so when the read fails rather than showing an empty ballot", async () => {
  fetchGoatPollVoters.mockResolvedValue(null);
  render(<GoatPollVotersModal nominee={nominee} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText("Couldn't read the votes.")).toBeTruthy());
});

it("closes on escape and on the backdrop", async () => {
  fetchGoatPollVoters.mockResolvedValue([]);
  const onClose = vi.fn();
  render(<GoatPollVotersModal nominee={nominee} onClose={onClose} />);
  await waitFor(() => expect(screen.getByText("Nobody has voted on this row.")).toBeTruthy());

  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByLabelText("Close"));
  expect(onClose).toHaveBeenCalledTimes(2);
});
