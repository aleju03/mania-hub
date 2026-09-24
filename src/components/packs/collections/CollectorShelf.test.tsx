// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { afterEach, expect, it, vi } from "vitest";
import { getI18n } from "#/lib/i18n";
import type { LivePackCollectorProfile, LivePackCommunityCollectionPage } from "#/lib/live-backend";
import type { CollectedCard } from "#/lib/pack-collection";
import type { CardSpotlightTarget } from "../CardSpotlight";

const { fetchProfile, fetchPage, track } = vi.hoisted(() => ({ fetchProfile: vi.fn(), fetchPage: vi.fn(), track: vi.fn() }));
vi.mock("#/lib/live-backend", async (original) => ({
  ...await original<typeof import("#/lib/live-backend")>(),
  fetchLivePackCollector: fetchProfile,
  fetchLivePackShowcasedBinders: async () => [],
}));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock("#/lib/analytics", () => ({ track }));
vi.mock("../CardTile", () => ({
  CollectionCardTile: ({ card }: { card: CollectedCard }) => <span data-testid="card" data-key={card.cardKey} />,
  CollectionCardPlaceholder: () => null,
}));
vi.mock("../CardSpotlight", () => ({
  CardSpotlight: ({ target }: { target: CardSpotlightTarget | null }) => target ? <div role="dialog">{target.card.cardKey} / {target.ownerUserId}</div> : null,
}));
vi.mock("../useCardThumbnails", () => ({ useCardThumbnails: () => ({ onThumbnailError: () => {} }) }));
vi.mock("../cardThumbnailCache", () => ({ cardThumbnailKeyForCollectionCard: () => "", getMemoryCardThumbnail: () => null }));
vi.mock("./ShowcaseCards", () => ({ ShowcaseCards: () => null }));
import { CollectorShelf } from "./CollectorShelf";

const marks = { only: 0, first: 0, second: 0, third: 0, self: 0 };
const completion = { poolTotal: 25, poolOwnedCount: 25, goatsOwned: 0, goatsTotal: 0, teamsOwned: 24, teamsTotal: 24 };
const profile: LivePackCollectorProfile = {
  collector: {
    userId: 77, username: "Collector", avatarUrl: "https://a.ppy.sh/77", countryCode: null, tracked: false,
    cards: 25, players: 25, copies: 25, goats: 0, eternals: 0, duplicates: 0, recycled: 0,
    firstFinds: 0, packsOpened: 10, joinedAt: 0, lastPulledAt: 0, completion,
  },
  completion, showcase: [], ranks: { cards: 1, packsOpened: 1 },
};
const card = (id: number, team = false): CollectedCard => ({
  userId: team ? -id : id, cardKey: team ? `team:${id}` : String(id), username: `${team ? "Team" : "Player"} ${id}`,
  avatarUrl: "", countryCode: "", tier: "rare", tierLabel: "Rare", skills: null,
  pp: 0, globalRank: 0, copies: 1, recycledCopies: 0, firstPulledAt: 0, lastPulledAt: 0,
  ...(team ? { team: { teamId: id, name: `Team ${id}`, shortName: `T${id}`, flagUrl: null, coverUrl: null, tier: "rare", skills: { cardPower: 50, speed: 50, fingerControl: 50, accuracy: 50, starAvg: 5, mainKeyMode: 4 } } } : {}),
});
const players = Array.from({ length: 25 }, (_, index) => card(index + 1));
const teams = Array.from({ length: 24 }, (_, index) => card(index + 1, true));
const eternal: CollectedCard = { ...teams[0], cardKey: "team:1:eternal", username: "Eternal Team 1", tier: "eternal", team: { ...teams[0].team!, tier: "eternal" } };
const allTeams = [eternal, ...teams];
const allTiers = { eternal: 1, rare: 49 };

function respond(input: string): Response {
  const query = new URL(input).searchParams;
  const includeTeams = query.get("teams") === "1";
  const teamsOnly = includeTeams && query.get("teamsOnly") === "1";
  const playersOnly = !includeTeams || query.get("playersOnly") === "1";
  const pool = teamsOnly ? allTeams : playersOnly ? players : [...allTeams, ...players];
  const cards = pool.filter((held) => (!query.get("tier") || held.tier === query.get("tier")) && held.username.toLowerCase().includes((query.get("q") ?? "").toLowerCase()));
  const start = Number(query.get("page") ?? 0) * 24;
  const result: LivePackCommunityCollectionPage = {
    cards: cards.slice(start, start + 24), total: cards.length,
    playerCount: 25, teamCount: includeTeams ? 25 : 0,
    tierCounts: teamsOnly ? { eternal: 1, rare: 24 } : playersOnly ? { rare: 25 } : allTiers,
    filterCounts: { tiers: allTiers, marks, duplicates: 0 }, markCounts: marks,
  };
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("browses both card kinds, resets pages on pool changes and keeps their cached pages separate", async () => {
  vi.stubEnv("VITE_LIVE_BACKEND_URL", "http://live.test");
  fetchProfile.mockResolvedValue(profile);
  fetchPage.mockImplementation(async (input: string) => respond(input));
  vi.stubGlobal("fetch", fetchPage);
  render(<I18nProvider i18n={getI18n("en")}><CollectorShelf collector="Collector" /></I18nProvider>);
  await screen.findByText("Eternal Team 1");
  expect(screen.getByPlaceholderText("Find a player or team")).toBeTruthy();
  expect(screen.getByText("1 / 3")).toBeTruthy();
  expect(new URL(fetchPage.mock.calls[0][0]).searchParams.get("teams")).toBe("1");

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Player 1");
  expect(screen.getByText("2 / 3")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /^Teams\s*25$/ }));
  await waitFor(() => expect(screen.getByText("1 / 2")).toBeTruthy());
  expect(screen.queryByText("Player 1")).toBeNull();
  expect(screen.getByRole("button", { name: /^Teams\s*25$/ }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Team 24");
  expect(screen.getAllByTestId("card")).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: /^Players\s*25$/ }));
  await screen.findByText("Player 1");
  expect(screen.getByText("1 / 2")).toBeTruthy();
  expect(screen.queryByText("Team 24")).toBeNull();
  expect(screen.getByRole("button", { name: /^Eternal\s*0$/ }).hasAttribute("disabled")).toBe(true);

  // Turning the active chip off returns to the original merged cache.
  fireEvent.click(screen.getByRole("button", { name: /^Players\s*25$/ }));
  await screen.findByText("Eternal Team 1");
  expect(screen.getByText("1 / 3")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Teams\s*25$/ }));
  await screen.findByText("Eternal Team 1");
  fireEvent.click(screen.getByRole("button", { name: "Eternal Team 1" }));
  expect(screen.getByRole("dialog").textContent).toBe("team:1:eternal / 77");
  expect(track).toHaveBeenCalledWith("packs_collections_shelf", expect.objectContaining({ collections_pool: "Teams" }));

  fireEvent.click(screen.getByRole("button", { name: /^Rare\s*24$/ }));
  await waitFor(() => expect(screen.queryByText("Eternal Team 1")).toBeNull());
  fireEvent.change(screen.getByPlaceholderText("Find a team"), { target: { value: "Team 12" } });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  await waitFor(() => expect(screen.getAllByTestId("card")).toHaveLength(1));
  expect(screen.getByText("Team 12")).toBeTruthy();
  const search = fetchPage.mock.calls.map(([input]) => new URL(input).searchParams).find((params) => params.get("q") === "Team 12");
  expect(search?.get("teamsOnly")).toBe("1");
  expect(search?.get("tier")).toBe("rare");
});
