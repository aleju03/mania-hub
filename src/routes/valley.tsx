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
const POSTHOG_QUERY_TIMEOUT_MS = 15_000;

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
// pageviews. Prefers the in-house store; falls back to PostHog, then degrades
// to unavailable so the valley still runs from backend status alone.
const getValleyVisitors = createServerFn({ method: "GET" }).handler(async (): Promise<ValleyVisitors> => {
  await requireAdminAccess("Valley visitors");
  const liveBase = getServerLiveBackendUrl();
  if (liveBase && process.env.LIVE_ADMIN_TOKEN) {
    try {
      return await getValleyVisitorsFromLiveBackend(liveBase);
    } catch {
      // Fall through to the PostHog path below.
    }
  }
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  if (!apiKey || !projectId) {
    return { available: false, activeVisitors: 0, recent: [], fetchedAt: Date.now() };
  }
  const endpoint = `https://us.posthog.com/api/projects/${projectId}/query/`;

  async function runQuery(query: string): Promise<unknown[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), POSTHOG_QUERY_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`PostHog query failed (${res.status})`);
      const body = (await res.json()) as { results?: unknown[][] };
      return body.results ?? [];
    } finally {
      clearTimeout(timeout);
    }
  }

  const [active, recent] = await Promise.all([
    runQuery(
      `SELECT count(DISTINCT distinct_id) FROM events WHERE timestamp > now() - interval 5 minute AND distinct_id != 'server'`,
    ),
    runQuery(
      `SELECT toString(timestamp), properties.$pathname, properties.$geoip_country_code, distinct_id, properties.profile_username FROM events WHERE event IN ('$pageview', 'replay_view') AND timestamp > now() - interval 10 minute AND distinct_id != 'server' AND (properties.$pathname IS NULL OR properties.$pathname NOT LIKE '/admin/%') ORDER BY timestamp DESC LIMIT 30`,
    ),
  ]);

  return {
    available: true,
    activeVisitors: Number(active[0]?.[0] ?? 0),
    recent: recent.map((row) => {
      const path = row[1] ? String(row[1]) : null;
      return {
        key: `${String(row[0] ?? "")}:${String(row[3] ?? "")}`,
        label: eventLabelForPath(path, row[4] ? String(row[4]) : null),
        path: path ?? "/",
        country: row[2] ? String(row[2]) : null,
      };
    }),
    fetchedAt: Date.now(),
  };
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
