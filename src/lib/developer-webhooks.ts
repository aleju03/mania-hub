import { createServerFn } from "@tanstack/react-start";
import { liveBridgeToken } from "./live-backend-tokens";

/* Mania Tracker API webhooks for the signed-in player (/developers), through
   the backend's bridge route like the keys (developer-keys.ts): the viewer
   comes from the osu! login cookie, never from client input. */

export type DeveloperWebhookEvent = "top_play" | "snipe";

export interface DeveloperWebhook {
  id: number;
  url: string;
  kind: "json" | "discord";
  events: DeveloperWebhookEvent[];
  country: string | null;
  keys: "4" | "other" | null;
  secret: string | null;
  enabled: boolean;
  disabledReason: string | null;
  createdAt: number;
  deliveries: number;
  failures: number;
  lastDeliveryAt: number | null;
  lastError: string | null;
}

export interface DeveloperWebhooks {
  webhooks: DeveloperWebhook[];
  maxWebhooks: number;
}

export type DeveloperWebhookInput =
  | { action: "create"; url: string; events: DeveloperWebhookEvent[]; country: string; keys: string }
  | { action: "set-enabled"; id: number; enabled: boolean }
  | { action: "delete"; id: number }
  | { action: "test"; id: number };

export type DeveloperWebhookResult =
  | { status: "ok"; state: DeveloperWebhooks; test?: { ok: boolean; status: number | null; error?: string } }
  | { status: "refused"; reason: string };

async function getTarget(): Promise<{ url: string; headers: HeadersInit } | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = process.env.LIVE_BACKEND_URL?.trim().replace(/\/$/, "");
  if (!base) return null;
  const headers: HeadersInit = { "content-type": "application/json" };
  const bridgeToken = liveBridgeToken();
  if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;
  return { url: `${base}/api/developer-webhooks/${auth.viewer.id}`, headers };
}

function parseState(value: unknown): DeveloperWebhooks {
  const body = (value ?? {}) as { webhooks?: unknown; maxWebhooks?: unknown };
  const webhooks = (Array.isArray(body.webhooks) ? body.webhooks : [])
    .map((raw) => raw as DeveloperWebhook)
    .filter((raw) => Math.floor(Number(raw?.id) || 0) > 0 && typeof raw.url === "string");
  return { webhooks, maxWebhooks: Math.max(1, Math.floor(Number(body.maxWebhooks) || 3)) };
}

async function noStore() {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
}

export const fetchOwnWebhooks = createServerFn({ method: "GET" }).handler(async (): Promise<DeveloperWebhooks | null> => {
  await noStore();
  const target = await getTarget();
  if (!target) return null;
  const response = await fetch(target.url, { headers: target.headers });
  if (!response.ok) throw new Error(`Webhook list failed (${response.status}).`);
  return parseState(await response.json());
});

export const mutateOwnWebhooks = createServerFn({ method: "POST" })
  .validator((input: DeveloperWebhookInput): DeveloperWebhookInput => {
    if (input?.action === "create") {
      const events = (Array.isArray(input.events) ? input.events : []).filter((entry) => entry === "top_play" || entry === "snipe");
      return {
        action: "create",
        url: String(input.url ?? "").slice(0, 500),
        events,
        country: String(input.country ?? "").slice(0, 2),
        keys: input.keys === "4" || input.keys === "other" ? input.keys : "",
      };
    }
    const id = Math.floor(Number((input as { id?: unknown })?.id) || 0);
    if (id <= 0) throw new Error("Invalid webhook.");
    if (input?.action === "set-enabled") return { action: "set-enabled", id, enabled: input.enabled === true };
    if (input?.action === "delete") return { action: "delete", id };
    if (input?.action === "test") return { action: "test", id };
    throw new Error("Invalid webhook change.");
  })
  .handler(async ({ data }): Promise<DeveloperWebhookResult | null> => {
    await noStore();
    const target = await getTarget();
    if (!target) return null;
    const response = await fetch(target.url, { method: "POST", headers: target.headers, body: JSON.stringify(data) });
    const body = (await response.json().catch(() => null)) as { error?: unknown; test?: { ok: boolean; status: number | null; error?: string } } | null;
    if (!response.ok) {
      if (typeof body?.error === "string" && response.status < 500) return { status: "refused", reason: body.error };
      throw new Error(`Webhook change failed (${response.status}).`);
    }
    return { status: "ok", state: parseState(body), ...(body?.test ? { test: body.test } : {}) };
  });
