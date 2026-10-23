import { createServerFn } from "@tanstack/react-start";
import { liveBridgeToken } from "./live-backend-tokens";
import type { ServerPackCollectionCard } from "./pack-wallet-sync";

export const GIFT_MESSAGE_MAX_CHARS = 140;
export interface GiftCollector { userId: number; username: string; avatarUrl: string; countryCode: string | null }
export type PackGiftStatus = "pending" | "accepted" | "declined";
export interface PackGiftReceipt { id: number; sender: GiftCollector; card: ServerPackCollectionCard | null; message: string | null; status: PackGiftStatus; serial?: number | null }
export interface PackGiftInbox { gifts: PackGiftReceipt[]; total: number; page: number }
export type PackGiftError = "invalid_request" | "self_gift" | "recipient_not_found" | "no_spare" | "card_not_ready" | "unverified_card" | "special_card" | "collection_changed" | "gift_not_found" | "serial_not_held";
export type PackGiftResult = { ok: true; giftId: number; recipient: GiftCollector; remainingCopies: number; serial?: number | null; replayed: boolean } | { ok: false; error: PackGiftError };

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
/* The numbers the viewer holds of one card, lowest first, for choosing which
   copy to give. Copies someone else pulled name their puller. */
export interface HeldCopies { serials: { serial: number; pulledBy: { userId: number; username: string } | null }[]; minted: number }
export const fetchOwnHeldCopies = createServerFn({ method: "GET" })
  .validator((input: { cardKey: string }) => {
    if (typeof input?.cardKey !== "string" || input.cardKey.length > 40) throw new Error("Invalid card.");
    return { cardKey: input.cardKey };
  })
  .handler(async ({ data }): Promise<HeldCopies | null> => {
    const target = await giftTarget();
    if (!target) return null;
    const response = await fetch(`${target.url}?copies=${encodeURIComponent(data.cardKey)}`, { headers: target.headers });
    if (!response.ok) throw new Error("Copies lookup failed.");
    return response.json() as Promise<HeldCopies>;
  });
export const sendOwnPackGift = createServerFn({ method: "POST" })
  .validator((input: { recipientUserId: number; cardKey: string; requestId: string; message?: string; serial?: number | null }) => {
    if (!Number.isSafeInteger(input?.recipientUserId) || input.recipientUserId <= 0 || typeof input.cardKey !== "string" || input.cardKey.length > 40 || typeof input.requestId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(input.requestId)) throw new Error("Invalid gift.");
    // The backend normalizes and caps the note; this only keeps a pasted essay
    // off the wire.
    // The number of the copy to give, when the sender picked one; without it
    // the backend gives their highest unpromised copy. It checks they hold it.
    const serial = Number.isSafeInteger(input.serial) && Number(input.serial) > 0 ? Number(input.serial) : null;
    return { recipientUserId: input.recipientUserId, cardKey: input.cardKey, requestId: input.requestId, message: typeof input.message === "string" ? input.message.slice(0, GIFT_MESSAGE_MAX_CHARS) : "", serial };
  })
  .handler(async ({ data }): Promise<PackGiftResult | null> => {
    const target = await giftTarget();
    if (!target) return null;
    const response = await fetch(target.url, { method: "POST", headers: target.headers, body: JSON.stringify({ action: "send", ...data }) });
    if (!response.ok && response.status !== 409) throw new Error("Gift request failed.");
    return response.json() as Promise<PackGiftResult>;
  });
function inboxPage(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
export type PackGiftDecision = ({ ok: true; giftId: number; status: PackGiftStatus } | { ok: false; error: PackGiftError }) & PackGiftInbox;
/* Answering an offer: accepting is what actually moves the card, declining
   closes it and moves nothing. The inbox the answer left behind comes back
   with it, so the page never reads twice. */
export const respondToOwnPackGift = createServerFn({ method: "POST" })
  .validator((input: { giftId: number; action: "accept" | "decline"; page?: number }) => {
    if (!Number.isSafeInteger(input?.giftId) || input.giftId <= 0 || (input.action !== "accept" && input.action !== "decline")) throw new Error("Invalid gift response.");
    return { giftId: input.giftId, action: input.action, page: inboxPage(input.page) };
  })
  .handler(async ({ data }): Promise<PackGiftDecision | null> => {
    const target = await giftTarget();
    if (!target) return null;
    const response = await fetch(target.url, { method: "POST", headers: target.headers, body: JSON.stringify({ action: data.action, giftId: data.giftId, page: data.page }) });
    if (!response.ok && response.status !== 409) throw new Error("Gift response failed.");
    return response.json() as Promise<PackGiftDecision>;
  });
export const fetchOwnPackGifts = createServerFn({ method: "GET" })
  .validator((input: { page?: number } = {}) => ({ page: inboxPage(input.page) }))
  .handler(async ({ data }): Promise<PackGiftInbox | null> => {
    const target = await giftTarget();
    if (!target) return null;
    const response = await fetch(`${target.url}?page=${data.page}`, { headers: target.headers });
    if (!response.ok) throw new Error("Gift inbox failed.");
    return response.json() as Promise<PackGiftInbox>;
  });
export const dismissOwnPackGifts = createServerFn({ method: "POST" })
  .validator((input: { ids: number[]; page?: number }) => ({ ids: Array.isArray(input.ids) ? input.ids.filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 20) : [], page: inboxPage(input.page) }))
  .handler(async ({ data }): Promise<PackGiftInbox | null> => {
    const target = await giftTarget();
    if (!target) return null;
    const response = await fetch(target.url, { method: "POST", headers: target.headers, body: JSON.stringify({ action: "ack", ids: data.ids, page: data.page }) });
    if (!response.ok) throw new Error("Could not dismiss gifts.");
    return response.json() as Promise<PackGiftInbox>;
  });
