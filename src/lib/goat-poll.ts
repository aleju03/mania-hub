import { createServerFn } from "@tanstack/react-start";
import type { GoatPollBoardPayload, GoatPollNominee } from "./live-backend";

// Server functions for the temporary GOAT nomination poll on /packs. The viewer
// always comes from the osu! login cookie, never from client input, so a user
// can only ever vote or nominate as themselves. The backend routes are
// admin-token gated and that token only exists server-side. Mirrors the
// roster-self-track / pack-wallet bridge.
//
// While the poll is unreleased (GOAT_POLL.adminOnly in the backend) it is also
// admin-gated, and this is the process that can prove it: the shared token means
// "our frontend sent this", not "this user is an admin", so every call forwards
// the viewer's admin flag off the same verified cookie that supplies their id.
// A browser cannot set either field — both are overwritten here.
//
// The public board read is NOT here: it goes browser-direct through
// fetchGoatPollBoard() in live-backend.ts, so a released poll's refresh never
// touches this process. Only identity-bearing calls, and the admin-only read
// below, pay for the round trip.

export type GoatPollWriteStatus =
  | "created"
  | "already_nominated"
  | "cap_reached"
  | "invalid_username"
  | "invalid_proof"
  | "invalid_value"
  | "unknown_nominee"
  | "recorded"
  | "cleared"
  | "poll_closed"
  | "already_honorary"
  | "unavailable";

export interface GoatPollWriteResult {
  ok: boolean;
  status: GoatPollWriteStatus;
  nomineeId: string | null;
  /* The board and ballot as they stand after the write, so a vote is one round
     trip instead of a write plus a refetch race. Null when the call never
     reached the backend. */
  nominees: GoatPollNominee[] | null;
  votes: Record<string, number> | null;
}

interface BackendResponse {
  ok?: unknown;
  status?: unknown;
  nomineeId?: unknown;
  nominees?: unknown;
  votes?: unknown;
}

/* The osu! id inside a Wayback proof URL, when it carries one. Deliberately
   lax next to normalizeArchiveProof in the backend, which is what actually
   validates the link: all this needs to answer is "does this point at a player
   already on the roster", and a URL that would fail validation there is refused
   anyway. */
function archiveProofUserId(proofUrl: string | null | undefined): number | null {
  if (!proofUrl) return null;
  const match = /osu\.ppy\.sh\/(?:users|u)\/(\d+)/i.exec(proofUrl);
  return match ? Number(match[1]) : null;
}

function unavailable(): GoatPollWriteResult {
  return { ok: false, status: "unavailable", nomineeId: null, nominees: null, votes: null };
}

function readResult(response: Response, body: BackendResponse): GoatPollWriteResult {
  return {
    ok: response.ok && body.ok === true,
    status: (typeof body.status === "string" ? body.status : "unavailable") as GoatPollWriteStatus,
    nomineeId: typeof body.nomineeId === "string" ? body.nomineeId : null,
    nominees: Array.isArray(body.nominees) ? (body.nominees as GoatPollNominee[]) : null,
    votes: body.votes && typeof body.votes === "object" ? (body.votes as Record<string, number>) : null,
  };
}

function backendBase(): string | null {
  return (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "") || null;
}

function bridgeHeaders(json = false): HeadersInit {
  const headers: HeadersInit = json ? { "content-type": "application/json" } : {};
  if (process.env.LIVE_ADMIN_TOKEN) {
    headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
  }
  return headers;
}

async function callGoatPoll(path: string, payload: Record<string, unknown>): Promise<GoatPollWriteResult> {
  const { readCurrentAuth } = await import("./auth-server");
  const { canUseAdminFeatures } = await import("./auth-shared");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return unavailable();
  const base = backendBase();
  if (!base) return unavailable();
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: bridgeHeaders(true),
      // Both of these come from the verified cookie, not from anything the
      // browser sent. viewerIsAdmin is what lets the backend refuse writes while
      // the poll is unreleased.
      body: JSON.stringify({ ...payload, userId: auth.viewer.id, viewerIsAdmin: canUseAdminFeatures(auth) }),
    });
  } catch {
    return unavailable();
  }
  return readResult(response, (await response.json().catch(() => ({}))) as BackendResponse);
}

/**
 * The board, read with the bridge token on an admin's behalf. This is the only
 * way to see an unreleased poll: the public endpoint 404s while
 * `GOAT_POLL.adminOnly` is set, and a browser has no token of its own. Returns
 * null for everyone else, so a non-admin calling this directly learns nothing.
 */
export const fetchGoatPollBoardAsAdmin = createServerFn({ method: "GET" }).handler(
  async (): Promise<GoatPollBoardPayload | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const { readCurrentAuth } = await import("./auth-server");
    const { canUseAdminFeatures } = await import("./auth-shared");
    const auth = await readCurrentAuth();
    if (!canUseAdminFeatures(auth)) return null;
    const base = backendBase();
    if (!base) return null;
    try {
      const response = await fetch(`${base}/api/goat-poll`, { headers: bridgeHeaders() });
      if (!response.ok) return null;
      return (await response.json()) as GoatPollBoardPayload;
    } catch {
      return null;
    }
  },
);

export const castGoatPollVote = createServerFn({ method: "POST" })
  .validator((data: { nomineeId: string; value: number }) => data)
  .handler(async ({ data }): Promise<GoatPollWriteResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const value = data.value > 0 ? 1 : data.value < 0 ? -1 : 0;
    return callGoatPoll("/api/goat-poll/vote", { nomineeId: data.nomineeId, value });
  });

export const nominateGoatPollPlayer = createServerFn({ method: "POST" })
  .validator((data: {
    osuUserId?: number | null;
    username: string;
    countryCode?: string | null;
    avatarUrl?: string | null;
    banned: boolean;
    proofUrl?: string | null;
  }) => data)
  .handler(async ({ data }): Promise<GoatPollWriteResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    // The roster lives in one place (honorary-players.ts), so the "they are
    // already a GOAT" check happens here rather than duplicating 23 ids into the
    // backend. Three ways in, so all three are checked: the player search (an
    // id), the manual form (a name), and the archive proof — whose URL is where
    // a deleted honoree's id actually comes from, since the manual form never
    // sends one and a roster member typed as "Jakads2" would otherwise sail past
    // a name check into a duplicate GOAT.
    const { isHonoraryPlayer, honoraryPlayerByName } = await import("./honorary-players");
    const alreadyHonorary = isHonoraryPlayer(data.osuUserId ?? null)
      || isHonoraryPlayer(archiveProofUserId(data.proofUrl))
      || honoraryPlayerByName(data.username) != null;
    if (alreadyHonorary) {
      return { ok: false, status: "already_honorary", nomineeId: null, nominees: null, votes: null };
    }
    return callGoatPoll("/api/goat-poll/nominate", {
      osuUserId: data.osuUserId ?? null,
      username: data.username,
      countryCode: data.countryCode ?? null,
      avatarUrl: data.avatarUrl ?? null,
      banned: data.banned,
      proofUrl: data.proofUrl ?? null,
    });
  });

/**
 * Moderation for the board, done from the board itself: takes one nominee off,
 * with their votes. True-admin only, and server-side like every other admin
 * call, so the backend token never reaches a browser.
 *
 * A delete key rather than a ban — the nominator keeps their other nominations
 * and the player can be put up again — because the poll is open to anyone
 * signed in and a joke nomination should not be a permanent fixture of a public
 * board for the rest of the window.
 */
export const removeGoatPollNominee = createServerFn({ method: "POST" })
  .validator((data: { nomineeId: string }) => {
    if (typeof data?.nomineeId !== "string" || !data.nomineeId) throw new Error("A nominee id is required.");
    return { nomineeId: data.nomineeId };
  })
  .handler(async ({ data }): Promise<GoatPollWriteResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const { requireTrueAdminAccess } = await import("./auth-server");
    await requireTrueAdminAccess("Remove a GOAT poll nominee");
    const base = backendBase();
    if (!base) return unavailable();
    let response: Response;
    try {
      response = await fetch(`${base}/api/admin/goat-poll/remove`, {
        method: "POST",
        headers: bridgeHeaders(true),
        body: JSON.stringify({ nomineeId: data.nomineeId }),
      });
    } catch {
      return unavailable();
    }
    return readResult(response, (await response.json().catch(() => ({}))) as BackendResponse);
  });

/** The signed-in viewer's ballot, read once when the widget mounts. */
export const fetchMyGoatPollVotes = createServerFn({ method: "GET" }).handler(
  async (): Promise<Record<string, number>> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const { readCurrentAuth } = await import("./auth-server");
    const { canUseAdminFeatures } = await import("./auth-shared");
    const auth = await readCurrentAuth();
    if (!auth.viewer) return {};
    const base = backendBase();
    if (!base) return {};
    const admin = canUseAdminFeatures(auth) ? "&admin=1" : "";
    try {
      const response = await fetch(`${base}/api/goat-poll/mine?userId=${auth.viewer.id}${admin}`, {
        headers: bridgeHeaders(),
      });
      if (!response.ok) return {};
      const body = (await response.json()) as { votes?: unknown };
      return body.votes && typeof body.votes === "object" ? (body.votes as Record<string, number>) : {};
    } catch {
      return {};
    }
  },
);
