import { createServerFn } from "@tanstack/react-start";
import { liveBridgeToken } from "./live-backend-tokens";
import type { CollectedCard } from "./pack-collection";
import { teamCardSkills, teamPackCardKey, type PackTeamCard } from "./team-cards";

/* The team collection (live-backend pack-teams.ts): team cards the Team pack
   and the other packs' rare extra slot dealt, kept apart from the player
   collection. Signed-in only, like everything the server deals; the viewer
   always comes from the osu! login cookie. */

export interface ServerPackTeamCard extends PackTeamCard {
  copies: number;
  recycledCopies: number;
  firstPulledAt: number;
  lastPulledAt: number;
}

export interface ServerPackTeamCollection {
  cards: ServerPackTeamCard[];
  missing: Array<Pick<PackTeamCard, "teamId" | "name" | "shortName" | "flagUrl">>;
  poolTotal: number;
  ownedInPool: number;
  totalOwned: number;
  totalMissing: number;
  duplicateValue: number;
  page: number;
  pageSize: number;
}

async function teamCollectionTarget(): Promise<{ url: string; headers: Record<string, string> } | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = process.env.LIVE_BACKEND_URL?.trim().replace(/\/$/, "");
  if (!base) return null;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const bridgeToken = liveBridgeToken();
  if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;
  return { url: `${base}/api/pack-teams/${auth.viewer.id}`, headers };
}

/* Null when logged out or no backend is configured. */
export const fetchServerPackTeamCollection = createServerFn({ method: "GET" })
  .validator((input: { page?: number; query?: string } = {}) => ({ page: Math.max(1, Math.floor(input.page ?? 1)), query: input.query?.trim().slice(0, 80) ?? "" }))
  .handler(
  async ({ data }): Promise<ServerPackTeamCollection | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await teamCollectionTarget();
    if (!target) return null;
    const response = await fetch(`${target.url}?page=${data.page}&q=${encodeURIComponent(data.query)}`, { headers: target.headers });
    if (!response.ok) throw new Error(`Team collection fetch failed (${response.status}).`);
    const body = (await response.json()) as Partial<ServerPackTeamCollection>;
    return {
      cards: Array.isArray(body.cards) ? body.cards : [],
      missing: Array.isArray(body.missing) ? body.missing : [],
      poolTotal: Math.max(0, Math.floor(Number(body.poolTotal) || 0)),
      ownedInPool: Math.max(0, Math.floor(Number(body.ownedInPool) || 0)),
      totalOwned: Number(body.totalOwned) || 0,
      totalMissing: Number(body.totalMissing) || 0,
      duplicateValue: Number(body.duplicateValue) || 0,
      page: Number(body.page) || 1,
      pageSize: Number(body.pageSize) || 50,
    };
  },
);

/* The reveal finished: the team pulls the draw logged are held off the pull
   feed until now, so the feed never shows a card before its opener saw it. */
export const releaseServerTeamPackPulls = createServerFn({ method: "POST" })
  .validator((input: { eventIds?: unknown }) => {
    const eventIds = (Array.isArray(input?.eventIds) ? input.eventIds : [])
      .slice(0, 12)
      .map((id: unknown) => Math.floor(Number(id) || 0))
      .filter((id: number) => id > 0);
    if (eventIds.length === 0) throw new Error("Invalid team pull release.");
    return { eventIds };
  })
  .handler(async ({ data }): Promise<{ released: number } | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const { readCurrentAuth } = await import("./auth-server");
    const auth = await readCurrentAuth();
    if (!auth.viewer) return null;
    const base = process.env.LIVE_BACKEND_URL?.trim().replace(/\/$/, "");
    if (!base) return null;
    const headers: Record<string, string> = { "content-type": "application/json" };
    const bridgeToken = liveBridgeToken();
    if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;
    const response = await fetch(`${base}/api/packs/team-pulls/release`, {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: auth.viewer.id, eventIds: data.eventIds }),
    });
    if (!response.ok) throw new Error(`Team pull release failed (${response.status}).`);
    const body = (await response.json()) as { released?: unknown };
    return { released: Number(body.released) || 0 };
  });

/* Hands team cards back for shards: some copies of some teams (the pack
   summary), or every copy past the first of every team. */
export const recycleServerPackTeamCards = createServerFn({ method: "POST" })
  .validator((input: { mode?: unknown; entries?: unknown }) => {
    if (input?.mode === "duplicates") return { mode: "duplicates" as const, entries: [] };
    const entries = (Array.isArray(input?.entries) ? input.entries : [])
      .slice(0, 50)
      .map((entry) => ({
        teamId: Math.floor(Number((entry as { teamId?: unknown })?.teamId) || 0),
        tier: (entry as { tier?: unknown })?.tier === "eternal" ? "eternal" : undefined,
        copies: Math.min(100, Math.floor(Number((entry as { copies?: unknown })?.copies) || 0)),
      }))
      .filter((entry) => entry.teamId > 0 && entry.copies > 0);
    if (entries.length === 0) throw new Error("Invalid recycle request.");
    return { mode: "copies" as const, entries };
  })
  .handler(async ({ data }): Promise<{ gained: number; payload: string; rev: number } | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await teamCollectionTarget();
    if (!target) return null;
    const response = await fetch(target.url, { method: "POST", headers: target.headers, body: JSON.stringify(data) });
    if (!response.ok) throw new Error(`Team recycle failed (${response.status}).`);
    const body = (await response.json()) as { gained?: unknown; payload?: unknown; rev?: unknown };
    return {
      gained: Number(body.gained) || 0,
      payload: typeof body.payload === "string" ? body.payload : "",
      rev: Number(body.rev) || 0,
    };
  });

/* A held team card in the collection's card shape, for the spotlight and the
   showcase picker: named after the team, keyed "team:<id>", drawn with the
   numbers it was pulled at. */
export function teamCollectedCard(card: ServerPackTeamCard): CollectedCard {
  return {
    userId: -card.teamId,
    cardKey: teamPackCardKey(card.teamId, card.tier),
    team: card,
    username: card.name,
    avatarUrl: "",
    countryCode: "",
    tier: card.tier,
    tierLabel: null,
    skills: teamCardSkills(card),
    pp: 0,
    globalRank: 0,
    copies: card.copies,
    recycledCopies: card.recycledCopies,
    firstPulledAt: card.firstPulledAt,
    lastPulledAt: card.lastPulledAt,
  };
}
