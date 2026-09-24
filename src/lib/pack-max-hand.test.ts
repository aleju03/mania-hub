// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { mapServerPackDraw, PACK_TYPES } from "./packs";
import type { ServerPackDrawResult } from "./pack-draw";
import { consumePendingPackCard, effectivePackDamage, readPendingPack, writePendingPack } from "./pack-pending";
import * as limits from "./pack-limits";
import * as serverLimits from "../../live-backend/src/features/pack-limits";
import { warmLivePackPlayers } from "./live-backend";

const result: ServerPackDrawResult = {
  poolTotal: 1000, cards: [], wallet: null,
  players: [
    ...Array.from({ length: 10 }, (_, index) => ({ userId: index + 1, username: `Player ${index + 1}`, pp: 1000, globalRank: index + 1 })),
    ...[{ teamId: 1, tier: "rare" }, { teamId: 2, tier: "eternal" }, { teamId: 1, tier: "eternal" }].map(({ teamId, tier }) => ({
      userId: -teamId, team: { teamId, tier, name: `Team ${teamId}`, shortName: `T${teamId}`, flagUrl: null, coverUrl: null,
        skills: { cardPower: 50, fingerControl: 50, speed: 50, accuracy: 50, starAvg: 5, mainKeyMode: 4 } },
    })),
    { userId: 11, username: "Other Eternal", eternal: true },
    { userId: 12, username: "Own Eternal", eternal: true },
    { userId: 12, username: "Own Milestone", eternal: true, milestone: true, cardKey: "12:v1", milestoneTarget: 1_000_000 },
  ],
};

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("keeps frontend and backend limits in sync with the largest purchasable pack", () => {
  expect(limits).toEqual(serverLimits);
  expect(Math.max(...PACK_TYPES.map((pack) => pack.cardCount))).toBe(limits.PACK_MAX_BASE_CARDS);
});

it("maps and resumes every slot of the maximum hand, including same-player and same-team variants", () => {
  const { draw } = mapServerPackDraw(result);
  expect(draw.players).toHaveLength(16);
  expect(draw.players.at(-1)).toMatchObject({ user: { id: 12 }, cardKey: "12:v1", milestone: true });
  expect(effectivePackDamage(draw.players, { path: [0.4, 0.5] })).toBeNull();
  writePendingPack(draw.players);
  const resumed = readPendingPack()!;
  expect(resumed.players).toHaveLength(16);
  expect(resumed.players.filter((card) => card.eternal)).toHaveLength(5);
  for (let index = 0; index < resumed.players.length; index += 1) {
    const card = resumed.players[index];
    consumePendingPackCard(card.user.id, card.cardKey);
    expect(readPendingPack()?.players.length ?? 0).toBe(15 - index);
  }
});

it("warms all twelve distinct player identities from a maximum hand", async () => {
  vi.stubEnv("VITE_LIVE_BACKEND_URL", "https://live.example.test");
  const fetch = vi.fn(async () => new Response("{}", { status: 202 }));
  vi.stubGlobal("fetch", fetch);
  await warmLivePackPlayers(result.players.map((card) => card.userId));
  expect(fetch).toHaveBeenCalledOnce();
  const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
  expect(JSON.parse(String(init.body)).userIds).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
});
