import { createServerFn } from "@tanstack/react-start";

// Server functions bridging the browser's pack wallet to the live backend's
// pack_wallets store. The viewer always comes from the osu! login cookie,
// never from client input, so a logged-in user can only ever read and write
// their own wallet. The backend route is admin-token gated; that token only
// exists server-side.

export interface ServerPackWallet {
  payload: string | null;
  rev: number;
}

export type PushPackWalletResult =
  | { ok: true; rev: number }
  | { ok: false; conflict: { payload: string; rev: number } };

const PAYLOAD_MAX_CHARS = 3_500_000;

async function getSyncTarget(): Promise<{ url: string; headers: HeadersInit } | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = process.env.LIVE_BACKEND_URL?.trim().replace(/\/$/, "");
  if (!base) return null;
  const headers: HeadersInit = { "content-type": "application/json" };
  if (process.env.LIVE_ADMIN_TOKEN) {
    headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
  }
  return { url: `${base}/api/pack-wallet/${auth.viewer.id}`, headers };
}

/* Null when sync is unavailable (logged out or no live backend configured);
   the wallet then stays browser-local. */
export const fetchServerPackWallet = createServerFn({ method: "GET" }).handler(
  async (): Promise<ServerPackWallet | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getSyncTarget();
    if (!target) return null;
    const response = await fetch(target.url, { headers: target.headers });
    if (!response.ok) throw new Error(`Pack wallet fetch failed (${response.status}).`);
    const body = (await response.json()) as { payload?: unknown; rev?: unknown };
    return {
      payload: typeof body.payload === "string" ? body.payload : null,
      rev: Number(body.rev) || 0,
    };
  },
);

export const pushServerPackWallet = createServerFn({ method: "POST" })
  .inputValidator((input: { payload?: unknown; baseRev?: unknown }) => {
    const payload = typeof input?.payload === "string" ? input.payload : "";
    const baseRev = Number(input?.baseRev);
    if (!payload || payload.length > PAYLOAD_MAX_CHARS || !Number.isFinite(baseRev) || baseRev < 0) {
      throw new Error("Invalid pack wallet payload.");
    }
    return { payload, baseRev: Math.floor(baseRev) };
  })
  .handler(async ({ data }): Promise<PushPackWalletResult | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const target = await getSyncTarget();
    if (!target) return null;
    // Normalize through the shared sanitizer so a tampered client can only
    // ever store a structurally valid wallet under its own account.
    const { sanitizeWallet } = await import("./pack-collection");
    let wallet: unknown;
    try {
      wallet = JSON.parse(data.payload);
    } catch {
      throw new Error("Pack wallet payload is not valid JSON.");
    }
    const sanitized = sanitizeWallet(wallet, Date.now());
    if (!sanitized) throw new Error("Pack wallet payload has an invalid shape.");
    const response = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: JSON.stringify({ payload: JSON.stringify(sanitized), baseRev: data.baseRev }),
    });
    if (response.status === 409) {
      const body = (await response.json()) as { payload?: unknown; rev?: unknown };
      return {
        ok: false,
        conflict: {
          payload: typeof body.payload === "string" ? body.payload : "",
          rev: Number(body.rev) || 0,
        },
      };
    }
    if (!response.ok) throw new Error(`Pack wallet push failed (${response.status}).`);
    const body = (await response.json()) as { rev?: unknown };
    return { ok: true, rev: Number(body.rev) || 0 };
  });
