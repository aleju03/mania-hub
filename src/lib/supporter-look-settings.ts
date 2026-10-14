import { createServerFn } from "@tanstack/react-start";

import { bridgeAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl } from "./live-backend";
import { parseSupporterLook, type SupporterLook } from "./supporter-card-looks";

// Server functions behind the /supporter page: the viewer's supporter status
// and the look their card wears. The viewer always comes from the osu! login
// cookie, never from client input, so a player can only change their own card.
// The backend routes are bridge-token gated; that token only exists
// server-side. Mirrors the signature bridge.

export interface SupporterLookState {
  signedIn: boolean;
  supporter: boolean;
  /** When the bought time runs out (ms); past for a lapsed supporter, null if they never supported. */
  expiresAt: number | null;
  look: SupporterLook | null;
  /** The last uploaded image, kept while a preset is picked so it can be picked again. */
  custom: { url: string; scale: number; opacity: number } | null;
}

const SIGNED_OUT: SupporterLookState = { signedIn: false, supporter: false, expiresAt: null, look: null, custom: null };

async function requireViewer(): Promise<{ userId: number; base: string } | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = getServerLiveBackendUrl();
  if (!base) return null;
  return { userId: auth.viewer.id, base };
}

function readState(body: unknown): SupporterLookState {
  const raw = (body ?? {}) as { supporter?: unknown; expiresAt?: unknown; look?: unknown; custom?: unknown };
  const custom = parseSupporterLook(raw.custom ? { ...(raw.custom as object), motif: "custom" } : null);
  return {
    signedIn: true,
    supporter: raw.supporter === true,
    expiresAt: typeof raw.expiresAt === "number" && Number.isFinite(raw.expiresAt) ? raw.expiresAt : null,
    look: parseSupporterLook(raw.look),
    custom: custom?.motif === "custom" && custom.url ? { url: custom.url, scale: custom.scale ?? 1, opacity: custom.opacity ?? 0.85 } : null,
  };
}

export const fetchSupporterLookState = createServerFn({ method: "GET" }).handler(
  async (): Promise<SupporterLookState> => {
    const viewer = await requireViewer();
    if (!viewer) return SIGNED_OUT;
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const response = await fetch(`${viewer.base}/api/supporters/self/look?userId=${viewer.userId}`, { headers: bridgeAuthHeaders() });
    if (!response.ok) throw new Error(`Server ${response.status}`);
    return readState(await response.json().catch(() => null));
  },
);

export const saveSupporterLookSetting = createServerFn({ method: "POST" })
  .validator((data: { motif?: unknown; palette?: unknown; url?: unknown; scale?: unknown; opacity?: unknown }) => {
    const look = parseSupporterLook({ ...data, palette: data?.palette ?? null });
    if (!look || (data?.motif === "custom" && look.motif !== "custom")) throw new Error("Pick a motif.");
    return look;
  })
  .handler(async ({ data }): Promise<SupporterLookState> => {
    const viewer = await requireViewer();
    if (!viewer) return SIGNED_OUT;
    const response = await fetch(`${viewer.base}/api/supporters/self/look`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, ...data }),
    });
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    if (response.status === 403) throw new Error("Your supporter time has run out.");
    if (!response.ok) throw new Error(String(body?.error ?? `Server ${response.status}`));
    return readState(body);
  });
