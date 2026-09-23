/*
 * The website's half of the integration: everything /companella can do on
 * behalf of the signed-in account.
 *
 * The actor is always derived from the signed session cookie on this server
 * and forwarded to the backend in an internal header; a userId in a query
 * string or a body is never believed. Mutations additionally require a
 * same-origin request, so a cross-site form post cannot revoke somebody's
 * installation or delete their score.
 */

import { createServerFn } from "@tanstack/react-start";

import { liveBridgeToken } from "../live-backend-tokens";
import type {
  CompanellaAccess,
  CompanellaChart,
  CompanellaChartMatch,
  CompanellaAnalysis,
  CompanellaInstallation,
  CompanellaPreview,
  CompanellaScore,
  CompanellaScoreTiming,
  CompanellaSecurityEvent,
  CompanellaSubmissionRow,
} from "./shared";
import { encodeActorName } from "./shared";

const TIMEOUT_MS = 15_000;

/** Who the request acts as. Deliberately no admin flag: nothing on the manage
    surface is decided by the viewer being an admin. */
interface Actor {
  userId: number;
  username: string;
}

function backendBase(): string | null {
  return (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/+$/, "") || null;
}

async function readActor(): Promise<Actor | null> {
  const { readCurrentAuth } = await import("../auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  return {
    userId: auth.viewer.id,
    username: auth.viewer.username,
  };
}

/** Refuses a mutation that did not come from our own page. */
async function requireSameOrigin(): Promise<void> {
  const { getRequest } = await import("@tanstack/react-start/server");
  const { isSameOriginRequest } = await import("../origin");
  if (!isSameOriginRequest(getRequest())) {
    throw new Error("This action must come from the Mania Tracker site.");
  }
}

async function callManage(
  path: string,
  options: { method?: "GET" | "POST"; actor: Actor; body?: unknown; search?: Record<string, string> },
): Promise<Response | null> {
  const base = backendBase();
  const token = liveBridgeToken();
  if (!base || !token) return null;
  const url = new URL(`${base}/api/integrations/companella/manage/${path}`);
  for (const [key, value] of Object.entries(options.search ?? {})) url.searchParams.set(key, value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        // The actor the site verified. Built here; never forwarded from the
        // incoming request.
        "x-companella-actor": String(options.actor.userId),
        "x-companella-actor-name": encodeActorName(options.actor.username),
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readJson<T>(response: Response | null, fallback: T): Promise<T> {
  if (!response || !response.ok) return fallback;
  return readJsonBody(response, fallback);
}

/** Parses the body whatever the status: the backend's refusals carry their
    reason as `{ error }`, and a 400 that reads as "failed" hides it. */
async function readJsonBody<T>(response: Response | null, fallback: T): Promise<T> {
  if (!response) return fallback;
  try {
    return await response.json() as T;
  } catch {
    return fallback;
  }
}

/** A backend refusal code to hand the page. Only a code: an unhandled error's
    raw message (a driver string naming tables, say) stays on the server. */
function refusalCode(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : fallback;
}

async function noStore(): Promise<void> {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  // Receipts, installations and previews are per-viewer and must never reach a
  // shared cache.
  setResponseHeader("Cache-Control", "private, no-store");
}

// ── Access ────────────────────────────────────────────────────────────────

export const fetchCompanellaAccess = createServerFn({ method: "GET" })
  .handler(async (): Promise<CompanellaAccess> => {
    await noStore();
    const actor = await readActor();
    const base = backendBase();
    const unavailable: CompanellaAccess = {
      enabled: false, allowed: false, hasData: false, signedIn: Boolean(actor), testClientEnabled: false,
      environment: "", storageReady: false, backendReachable: false,
    };
    if (!base) return unavailable;
    let capabilities: Record<string, unknown> | null = null;
    try {
      const response = await fetch(`${base}/api/integrations/companella/capabilities`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      capabilities = response.ok ? await response.json() as Record<string, unknown> : null;
    } catch {
      capabilities = null;
    }
    if (!capabilities) return unavailable;
    const enabled = capabilities.enabled === true;
    // Whether this account is allowed is the backend's answer, not a list the
    // frontend keeps: hiding the page is not the access control. The list
    // answers members and former members alike and says which this is; an
    // older backend refused non-members with a 403 instead.
    const response = actor && enabled
      ? await callManage("installations", { actor })
      : null;
    const listed = response?.ok
      ? await readJsonBody<{ installations?: unknown; allowed?: unknown } | null>(response, null)
      : null;
    const member = listed
      ? (typeof listed.allowed === "boolean" ? listed.allowed : true)
      : response?.status !== 403;
    return {
      enabled,
      allowed: Boolean(actor) && enabled && member,
      hasData: Array.isArray(listed?.installations) && listed.installations.length > 0,
      signedIn: Boolean(actor),
      testClientEnabled: Array.isArray(capabilities.clients_supported)
        && (capabilities.clients_supported as string[]).some((id) => id.endsWith("-test")),
      environment: String(capabilities.environment ?? ""),
      storageReady: capabilities.storage === "r2" || capabilities.storage === "local",
      backendReachable: true,
    };
  });

// ── Installations ─────────────────────────────────────────────────────────

export const fetchCompanellaInstallations = createServerFn({ method: "GET" })
  .handler(async (): Promise<{ installations: CompanellaInstallation[] }> => {
    await noStore();
    const actor = await readActor();
    if (!actor) return { installations: [] };
    return readJson(await callManage("installations", { actor }), { installations: [] });
  });

export const renameCompanellaInstallation = createServerFn({ method: "POST" })
  .validator((data: { installationId: string; displayName: string }) => ({
    installationId: String(data.installationId ?? ""),
    displayName: String(data.displayName ?? "").slice(0, 60),
  }))
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    await noStore();
    await requireSameOrigin();
    const actor = await readActor();
    if (!actor) return { ok: false };
    return readJson(await callManage("installations/rename", {
      actor, method: "POST",
      body: { installation_id: data.installationId, display_name: data.displayName },
    }), { ok: false });
  });

export const revokeCompanellaInstallation = createServerFn({ method: "POST" })
  .validator((data: { installationId: string }) => ({ installationId: String(data.installationId ?? "") }))
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    await noStore();
    await requireSameOrigin();
    const actor = await readActor();
    if (!actor) return { ok: false };
    return readJson(await callManage("installations/revoke", {
      actor, method: "POST", body: { installation_id: data.installationId },
    }), { ok: false });
  });

export const revokeAllCompanellaInstallations = createServerFn({ method: "POST" })
  .handler(async (): Promise<{ revoked: number }> => {
    await noStore();
    await requireSameOrigin();
    const actor = await readActor();
    if (!actor) return { revoked: 0 };
    return readJson(await callManage("installations/revoke-all", { actor, method: "POST" }), { revoked: 0 });
  });

// ── Submissions and scores ────────────────────────────────────────────────

export const fetchCompanellaSubmissions = createServerFn({ method: "GET" })
  .validator((data: { limit?: number; cursor?: string | null } | undefined) => ({
    limit: Math.max(1, Math.min(50, Math.floor(Number(data?.limit ?? 20)) || 20)),
    cursor: data?.cursor ? String(data.cursor) : null,
  }))
  .handler(async ({ data }): Promise<{ submissions: CompanellaSubmissionRow[]; next_cursor: string | null }> => {
    await noStore();
    const actor = await readActor();
    if (!actor) return { submissions: [], next_cursor: null };
    return readJson(await callManage("submissions", {
      actor,
      search: { limit: String(data.limit), ...(data.cursor ? { cursor: data.cursor } : {}) },
    }), { submissions: [], next_cursor: null });
  });

export interface CompanellaScoreDetail {
  score: CompanellaScore | null;
  analysis: CompanellaAnalysis | null;
  chart: CompanellaChart | null;
  match: CompanellaChartMatch | null;
  timing: CompanellaScoreTiming | null;
}

export const fetchCompanellaScore = createServerFn({ method: "GET" })
  .validator((data: { scoreId: string }) => ({ scoreId: String(data.scoreId ?? "") }))
  .handler(async ({ data }): Promise<CompanellaScoreDetail> => {
    await noStore();
    const actor = await readActor();
    const empty: CompanellaScoreDetail = { score: null, analysis: null, chart: null, match: null, timing: null };
    if (!actor) return empty;
    return readJson(await callManage(`scores/${encodeURIComponent(data.scoreId)}`, { actor }), empty);
  });

export const deleteCompanellaScore = createServerFn({ method: "POST" })
  .validator((data: { scoreId: string }) => ({ scoreId: String(data.scoreId ?? "") }))
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    await noStore();
    await requireSameOrigin();
    const actor = await readActor();
    if (!actor) return { ok: false };
    return readJson(await callManage(`scores/${encodeURIComponent(data.scoreId)}/delete`, {
      actor, method: "POST",
    }), { ok: false });
  });

export const fetchCompanellaPreview = createServerFn({ method: "GET" })
  .validator((data: { refresh?: boolean } | undefined) => ({ refresh: data?.refresh === true }))
  .handler(async ({ data }): Promise<{ preview: CompanellaPreview | null }> => {
    await noStore();
    const actor = await readActor();
    if (!actor) return { preview: null };
    return readJson(await callManage("preview", {
      actor, search: data.refresh ? { refresh: "1" } : {},
    }), { preview: null });
  });

export const fetchCompanellaSecurityEvents = createServerFn({ method: "GET" })
  .handler(async (): Promise<{ events: CompanellaSecurityEvent[] }> => {
    await noStore();
    const actor = await readActor();
    if (!actor) return { events: [] };
    return readJson(await callManage("security-events", { actor }), { events: [] });
  });

// ── Private artifact reads ────────────────────────────────────────────────

/**
 * The owner's own replay bytes. Deliberately a route handler concern rather
 * than a server function returning base64: the viewer wants a stream, and the
 * authorization has to run before a single byte moves.
 */
export async function readOwnedReplay(request: Request, scoreId: string): Promise<Response> {
  return streamOwnedArtifact(request, scoreId, "replay", "application/octet-stream");
}

export async function readOwnedChart(request: Request, scoreId: string): Promise<Response> {
  return streamOwnedArtifact(request, scoreId, "chart", "text/plain; charset=utf-8");
}

async function streamOwnedArtifact(
  request: Request,
  scoreId: string,
  kind: "replay" | "chart",
  contentType: string,
): Promise<Response> {
  const { readViewerFromRequest } = await import("../auth-server");
  const viewer = await readViewerFromRequest(request);
  const deny = () => new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
  });
  if (!viewer || !/^[A-Za-z0-9_-]{8,64}$/.test(scoreId)) return deny();
  const response = await callManage(`scores/${encodeURIComponent(scoreId)}/${kind}`, {
    actor: { userId: viewer.id, username: viewer.username },
  });
  if (!response || !response.ok) return deny();
  return new Response(await response.arrayBuffer(), {
    status: 200,
    headers: {
      "content-type": contentType,
      // Private data: no shared cache, no sniffing, no embedding.
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": kind === "replay" ? `attachment; filename="${scoreId}.osr"` : "inline",
    },
  });
}

// ── Authorization (the consent page) ──────────────────────────────────────

export interface AuthorizationDetail {
  client_id: string;
  redirect_uri: string;
  scopes: string[];
  expires_at: string;
  outcome: string | null;
  app_name: string | null;
  loopback: boolean;
}

export const fetchCompanellaAuthorizationRequest = createServerFn({ method: "GET" })
  .validator((data: { requestId: string }) => ({ requestId: String(data.requestId ?? "") }))
  .handler(async ({ data }): Promise<AuthorizationDetail | null> => {
    await noStore();
    const actor = await readActor();
    if (!actor) return null;
    const response = await callManage("authorize/detail", { actor, search: { requestId: data.requestId } });
    return readJson<AuthorizationDetail | null>(response, null);
  });

export const approveCompanellaAuthorization = createServerFn({ method: "POST" })
  .validator((data: {
    requestId: string; consentToken: string; displayName: string;
    platformHint?: string | null; consentScores: boolean; consentCharts: boolean;
  }) => ({
    requestId: String(data.requestId ?? ""),
    consentToken: String(data.consentToken ?? ""),
    displayName: String(data.displayName ?? "").slice(0, 60),
    platformHint: data.platformHint == null ? null : String(data.platformHint).slice(0, 40),
    consentScores: data.consentScores === true,
    consentCharts: data.consentCharts === true,
  }))
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string; redirectUrl?: string }> => {
    await noStore();
    await requireSameOrigin();
    const actor = await readActor();
    if (!actor) return { ok: false, error: "not_signed_in" };
    const response = await callManage("authorize/approve", {
      actor, method: "POST",
      body: {
        request_id: data.requestId,
        consent_token: data.consentToken,
        display_name: data.displayName,
        platform_hint: data.platformHint,
        consent_scores: data.consentScores,
        consent_charts: data.consentCharts,
      },
    });
    const payload = await readJsonBody<{ code?: string; state?: string; redirect_uri?: string; error?: string }>(response, {});
    if (!payload.code || !payload.redirect_uri) return { ok: false, error: refusalCode(payload.error, "approve_failed") };
    // The backend validated this redirect when the request was created and
    // froze it on the grant; the code and state are the only things added.
    const target = new URL(payload.redirect_uri);
    target.searchParams.set("code", payload.code);
    target.searchParams.set("state", payload.state ?? "");
    return { ok: true, redirectUrl: target.toString() };
  });

export const denyCompanellaAuthorization = createServerFn({ method: "POST" })
  .validator((data: { requestId: string }) => ({ requestId: String(data.requestId ?? "") }))
  .handler(async ({ data }): Promise<{ ok: boolean; redirectUrl?: string }> => {
    await noStore();
    await requireSameOrigin();
    const actor = await readActor();
    if (!actor) return { ok: false };
    const response = await callManage("authorize/deny", { actor, method: "POST", body: { request_id: data.requestId } });
    const payload = await readJsonBody<{ denied?: boolean; redirect_uri?: string; state?: string }>(response, {});
    if (!payload.redirect_uri) return { ok: payload.denied === true };
    // Same frozen redirect as approve, carrying the RFC 6749 error instead of
    // a code, so a waiting loopback listener learns the answer at once.
    const target = new URL(payload.redirect_uri);
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("state", payload.state ?? "");
    return { ok: true, redirectUrl: target.toString() };
  });

/**
 * Opens the authorization transaction behind the consent page, from the OAuth
 * parameters a client put on /companella/authorize. Only for a signed-in
 * viewer: the backend writes no request row for an anonymous visitor, so the
 * page signs in first and comes back with the same parameters.
 */
export const createCompanellaAuthorizationRequest = createServerFn({ method: "POST" })
  .validator((data: {
    clientId: string; redirectUri: string; state: string;
    codeChallenge: string; scope?: string | null; dpopJkt: string; appName?: string | null;
  }) => ({
    clientId: String(data.clientId ?? ""),
    redirectUri: String(data.redirectUri ?? ""),
    state: String(data.state ?? ""),
    codeChallenge: String(data.codeChallenge ?? ""),
    scope: data.scope == null ? null : String(data.scope),
    dpopJkt: String(data.dpopJkt ?? ""),
    appName: data.appName == null ? null : String(data.appName),
  }))
  .handler(async ({ data }): Promise<{ requestId?: string; consentToken?: string; error?: string }> => {
    await noStore();
    await requireSameOrigin();
    const actor = await readActor();
    if (!actor) return { error: "not_signed_in" };
    const response = await callManage("authorize/request", {
      actor, method: "POST",
      body: {
        client_id: data.clientId,
        redirect_uri: data.redirectUri,
        state: data.state,
        code_challenge: data.codeChallenge,
        code_challenge_method: "S256",
        scope: data.scope,
        dpop_jkt: data.dpopJkt,
        app_name: data.appName,
      },
    });
    if (!response) return { error: "integration_unavailable" };
    const payload = await readJsonBody<{ request_id?: string; consent_token?: string; error?: string }>(response, {});
    if (!payload.request_id || !payload.consent_token) {
      return { error: refusalCode(payload.error, "request_failed") };
    }
    return { requestId: payload.request_id, consentToken: payload.consent_token };
  });
