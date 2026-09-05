import { createServerFn } from "@tanstack/react-start";
import { liveBridgeToken } from "./live-backend-tokens";
import type { ServerPackCollectionCard } from "./pack-wallet-sync";

export interface GiftCollector { userId: number; username: string; avatarUrl: string; countryCode: string | null }
export interface PackGiftReceipt { id: number; sender: GiftCollector; card: ServerPackCollectionCard | null }
export interface PackGiftInbox { gifts: PackGiftReceipt[]; total: number }
export type PackGiftError = "invalid_request" | "self_gift" | "recipient_not_found" | "no_spare" | "card_not_ready" | "unverified_card" | "special_card" | "daily_limit" | "collection_changed";
export type PackGiftResult = { ok: true; giftId: number; recipient: GiftCollector; remainingCopies: number; replayed: boolean } | { ok: false; error: PackGiftError };

async function giftTarget() {
  const { readCurrentAuth } = await import("./auth-server");
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
  const auth = await readCurrentAuth();
  const base = process.env.LIVE_BACKEND_URL?.trim().replace(/\/$/, "");
  if (!auth.viewer || !base) return null;
  const token = liveBridgeToken();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return { url: `${base}/api/pack-collection/${auth.viewer.id}/gifts`, headers };
}
export const searchOwnGiftRecipients = createServerFn({ method: "GET" })
  .validator((input: { query: string }) => ({ query: String(input.query ?? "").trim().slice(0, 32) }))
  .handler(async ({ data }): Promise<GiftCollector[]> => {
    const target = await giftTarget();
    if (!target || data.query.length < 2) return [];
    const response = await fetch(`${target.url}?q=${encodeURIComponent(data.query)}`, { headers: target.headers });
    if (!response.ok) throw new Error("Recipient search failed.");
    return ((await response.json()) as { collectors: GiftCollector[] }).collectors;
  });
export const sendOwnPackGift = createServerFn({ method: "POST" })
  .validator((input: { recipientUserId: number; cardKey: string; requestId: string }) => {
    if (!Number.isSafeInteger(input?.recipientUserId) || input.recipientUserId <= 0 || typeof input.cardKey !== "string" || input.cardKey.length > 40 || typeof input.requestId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(input.requestId)) throw new Error("Invalid gift.");
    return { recipientUserId: input.recipientUserId, cardKey: input.cardKey, requestId: input.requestId };
  })
  .handler(async ({ data }): Promise<PackGiftResult | null> => {
    const target = await giftTarget();
    if (!target) return null;
    const response = await fetch(target.url, { method: "POST", headers: target.headers, body: JSON.stringify({ action: "send", ...data }) });
    if (!response.ok && response.status !== 409) throw new Error("Gift request failed.");
    return response.json() as Promise<PackGiftResult>;
  });
export const fetchOwnPackGifts = createServerFn({ method: "GET" }).handler(async (): Promise<PackGiftInbox | null> => {
  const target = await giftTarget();
  if (!target) return null;
  const response = await fetch(target.url, { headers: target.headers });
  if (!response.ok) throw new Error("Gift inbox failed.");
  return response.json() as Promise<PackGiftInbox>;
});
export const dismissOwnPackGifts = createServerFn({ method: "POST" })
  .validator((input: { ids: number[] }) => ({ ids: Array.isArray(input.ids) ? input.ids.filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 20) : [] }))
  .handler(async ({ data }): Promise<PackGiftInbox | null> => {
    const target = await giftTarget();
    if (!target) return null;
    const response = await fetch(target.url, { method: "POST", headers: target.headers, body: JSON.stringify({ action: "ack", ids: data.ids }) });
    if (!response.ok) throw new Error("Could not dismiss gifts.");
    return response.json() as Promise<PackGiftInbox>;
  });
