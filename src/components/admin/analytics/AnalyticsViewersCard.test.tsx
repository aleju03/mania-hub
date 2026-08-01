// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsViewersResult } from "../../../lib/analytics-monitor";

const getAnalyticsViewers = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/analytics-monitor-data", () => ({ getAnalyticsViewers }));

const { AnalyticsViewersCard } = await import("./AnalyticsViewersCard");

const NOW = Date.now();

const RESULT: AnalyticsViewersResult = {
  total: 3,
  viewers: [
    { viewerId: 111, username: "juan", firstSeen: NOW - 30 * 86_400_000, lastSeen: NOW - 60_000, events: 412, country: "CR" },
    { viewerId: 222, username: "kanaria", firstSeen: NOW - 2 * 86_400_000, lastSeen: NOW - 3 * 3_600_000, events: 87, country: "JP" },
    { viewerId: 333, username: "Ranshii", firstSeen: NOW - 900_000, lastSeen: NOW - 900_000, events: 4, country: null },
  ],
};

afterEach(() => {
  cleanup();
  getAnalyticsViewers.mockReset();
});

describe("AnalyticsViewersCard", () => {
  it("lists every signed-in account with how long they have been around", async () => {
    getAnalyticsViewers.mockResolvedValue(RESULT);
    render(<AnalyticsViewersCard />);

    await waitFor(() => expect(screen.getByText("juan")).toBeTruthy());
    expect(screen.getByText("3 osu! accounts have signed in")).toBeTruthy();
    expect(screen.getByText("kanaria")).toBeTruthy();
    expect(screen.getByText("Ranshii")).toBeTruthy();
    expect(screen.getByText("412 events")).toBeTruthy();
    // A single-visit account has no span to report.
    expect(screen.getByText("first visit")).toBeTruthy();
    // Rows link into the player's profile page.
    expect(screen.getByText("juan").closest("a")!.getAttribute("href")).toContain("/player/juan");
  });

  it("says the roster is truncated rather than implying it is complete", async () => {
    getAnalyticsViewers.mockResolvedValue({ total: 900, viewers: RESULT.viewers });
    render(<AnalyticsViewersCard />);
    await waitFor(() => expect(screen.getByText(/900 osu! accounts have signed in/)).toBeTruthy());
    expect(screen.getByText(/showing the 3 most recent/)).toBeTruthy();
  });

  it("filters by username", async () => {
    getAnalyticsViewers.mockResolvedValue({
      total: 12,
      viewers: Array.from({ length: 12 }, (_, index) => ({
        viewerId: 100 + index,
        username: index === 0 ? "kanaria" : `player${index}`,
        firstSeen: NOW - 86_400_000,
        lastSeen: NOW - 60_000,
        events: 5,
        country: null,
      })),
    });
    render(<AnalyticsViewersCard />);
    await waitFor(() => expect(screen.getByText("kanaria")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Find a signed-in player"), { target: { value: "kana" } });
    expect(screen.getByText("kanaria")).toBeTruthy();
    expect(screen.queryByText("player3")).toBeNull();

    fireEvent.change(screen.getByLabelText("Find a signed-in player"), { target: { value: "nobody" } });
    expect(screen.getByText('No signed-in player matches "nobody".')).toBeTruthy();
  });

  it("reports a failed load instead of showing an empty roster", async () => {
    getAnalyticsViewers.mockRejectedValue(new Error("Analytics viewers failed (503)."));
    render(<AnalyticsViewersCard />);
    await waitFor(() => expect(screen.getByText("Analytics viewers failed (503).")).toBeTruthy());
    expect(screen.getByText("could not load")).toBeTruthy();
  });

  it("says so plainly when nobody has signed in yet", async () => {
    getAnalyticsViewers.mockResolvedValue({ total: 0, viewers: [] });
    render(<AnalyticsViewersCard />);
    await waitFor(() => expect(screen.getByText("Nobody has signed in yet.")).toBeTruthy());
  });
});
