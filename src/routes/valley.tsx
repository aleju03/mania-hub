import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useRef } from "react";
import { canUseAdminFeatures } from "#/lib/auth-shared";
import { requireAdminAccess } from "#/lib/auth";
import { fetchLiveBackendAdminStatus, getServerLiveBackendUrl } from "#/lib/live-backend";
import { ValleyGame } from "#/lib/valley/game";
import { eventLabelForPath, type ValleyVisitors } from "#/lib/valley/types";

const STATUS_POLL_MS = 5_000;
const VISITORS_POLL_MS = 30_000;
const LIVE_VISITORS_POLL_MS = 10_000;

/* Villager layer, in-house path: the live backend's analytics store answers
   in milliseconds from a local file, so the valley can poll it faster. */
async function getValleyVisitorsFromLiveBackend(base: string): Promise<ValleyVisitors> {
  const headers: HeadersInit = { connection: "close" };
  if (process.env.LIVE_ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
  const response = await fetch(`${base}/api/admin/analytics/valley`, { headers });
  if (!response.ok) throw new Error(`Valley visitors failed (${response.status}).`);
  const payload = await response.json() as {
    activeVisitors: number;
    recent: Array<{ timestamp: string; path: string | null; country: string | null; distinctId: string; profileUsername: string | null }>;
  };
  return {
    available: true,
    live: true,
    activeVisitors: Number(payload.activeVisitors ?? 0),
    recent: payload.recent.map((row) => ({
      key: `${row.timestamp}:${row.distinctId}`,
      label: eventLabelForPath(row.path, row.profileUsername),
      path: row.path ?? "/",
      country: row.country,
    })),
    fetchedAt: Date.now(),
  };
}

// Small analytics slice for the villager layer: active visitor count + recent
// pageviews. Degrades to unavailable when the in-house store can't answer, so
// the valley still runs from backend status alone.
const getValleyVisitors = createServerFn({ method: "GET" }).handler(async (): Promise<ValleyVisitors> => {
  await requireAdminAccess("Valley visitors");
  const liveBase = getServerLiveBackendUrl();
  if (liveBase && process.env.LIVE_ADMIN_TOKEN) {
    try {
      return await getValleyVisitorsFromLiveBackend(liveBase);
    } catch {
      // Villagers are optional; fall through to the unavailable slice.
    }
  }
  return { available: false, activeVisitors: 0, recent: [], fetchedAt: Date.now() };
});

export const Route = createFileRoute("/valley")({
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  head: () => ({
    meta: [
      { title: "Mania Valley" },
      { name: "description", content: "The mania-tracker server, as a farm." },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: ValleyPage,
});

function ValleyPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<ValleyGame | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const game = new ValleyGame(canvas);
    gameRef.current = game;
    game.start();

    let stopped = false;
    let statusTimer: ReturnType<typeof setTimeout> | null = null;
    let visitorsTimer: ReturnType<typeof setTimeout> | null = null;

    const pollStatus = async () => {
      if (stopped) return;
      try {
        const raw = await fetchLiveBackendAdminStatus({ data: {} });
        if (!stopped) game.updateStatus(raw);
      } catch {
        if (!stopped) game.markConnectionLost();
      }
      if (!stopped && !document.hidden) {
        statusTimer = setTimeout(pollStatus, STATUS_POLL_MS);
      }
    };
    const pollVisitors = async () => {
      if (stopped) return;
      let nextDelay = VISITORS_POLL_MS;
      try {
        const v = await getValleyVisitors();
        if (!stopped) game.updateVisitors(v);
        if (v.live) nextDelay = LIVE_VISITORS_POLL_MS;
      } catch {
        // villagers are optional; keep the farm running
      }
      if (!stopped && !document.hidden) {
        visitorsTimer = setTimeout(pollVisitors, nextDelay);
      }
    };

    const onVisibility = () => {
      if (!document.hidden) {
        void pollStatus();
        void pollVisitors();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    void pollStatus();
    void pollVisitors();

    return () => {
      stopped = true;
      if (statusTimer) clearTimeout(statusTimer);
      if (visitorsTimer) clearTimeout(visitorsTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      game.destroy();
      gameRef.current = null;
    };
  }, []);

  return (
    <div className="min-h-[calc(100vh-60px)] bg-[#0c0a14] flex flex-col items-center justify-center px-3 py-4 gap-2">
      <canvas
        ref={canvasRef}
        className="w-full max-w-[1280px] border-2 border-[#2b2438] select-none touch-manipulation landscape:aspect-video portrait:h-[72svh]"
        style={{ imageRendering: "pixelated" }}
      />
      <div className="font-mono text-[10px] uppercase tracking-wide text-[#5a5468] px-2 text-center">
        <span className="hidden sm:inline">
          wasd or tap to walk · hold shift to run · walk into doors to go inside · z toggles map · m mutes
        </span>
        <span className="sm:hidden">tap to walk · tap doors to go inside · tap things to inspect</span>
      </div>
    </div>
  );
}
