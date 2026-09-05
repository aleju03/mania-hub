// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@lingui/react";
import { getI18n } from "#/lib/i18n";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CollectedCard } from "#/lib/pack-collection";
import type { ReactNode } from "react";
const { search, send, inbox, dismiss, respond } = vi.hoisted(() => ({ search: vi.fn(), send: vi.fn(), inbox: vi.fn(), dismiss: vi.fn(), respond: vi.fn() }));
vi.mock("#/lib/pack-gifts", () => ({ GIFT_MESSAGE_MAX_CHARS: 140, searchOwnGiftRecipients: search, sendOwnPackGift: send, fetchOwnPackGifts: inbox, dismissOwnPackGifts: dismiss, respondToOwnPackGift: respond }));
vi.mock("./PackDialog", () => ({ PackDialog: ({ title, children }: { title: string; children: ReactNode }) => <div role="dialog" aria-label={title}>{children}</div> }));
vi.mock("./CardTile", () => ({ CollectionCardTile: ({ card }: { card: { username: string } }) => <div>{card.username} card</div> }));
vi.mock("./useCardThumbnails", () => ({ useCardThumbnails: () => ({ onThumbnailError: () => {} }) }));
vi.mock("./cardThumbnailCache", () => ({ cardThumbnailKeyForCollectionCard: () => "key", getMemoryCardThumbnail: () => null }));
import { GiftSpareDialog } from "./GiftSpareDialog";
import { GiftInbox } from "./GiftInbox";
const card: CollectedCard = { userId: 77, cardKey: "77", username: "Friend", avatarUrl: "https://a.ppy.sh/77", countryCode: "CR", tier: "rare", tierLabel: "Rare", skills: null, pp: 1000, globalRank: 20, copies: 3, recycledCopies: 0, firstPulledAt: 1, lastPulledAt: 1 };
const recipient = { userId: 102, username: "Recipient", avatarUrl: "https://a.ppy.sh/102", countryCode: "CR" };
const wrap = (children: ReactNode) => <I18nProvider i18n={getI18n("en")}>{children}</I18nProvider>;
beforeEach(() => { vi.clearAllMocks(); search.mockResolvedValue([recipient]); send.mockResolvedValue({ ok: true, giftId: 1, recipient, remainingCopies: 2, replayed: false }); });
afterEach(cleanup);
it("selects and confirms the recipient before sending exactly one named card", async () => {
  const onSent = vi.fn();
  render(wrap(<GiftSpareDialog card={card} onClose={() => {}} onSent={onSent} />));
  expect(send).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: "Find a collector" }), { target: { value: "Reci" } });
  fireEvent.click(await screen.findByRole("button", { name: "Recipient" }));
  expect(send).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "  enjoy it  " } });
  fireEvent.click(screen.getByRole("button", { name: "Send to Recipient" }));
  await screen.findByRole("status");
  expect(send).toHaveBeenCalledWith({ data: { recipientUserId: 102, cardKey: "77", requestId: expect.any(String), message: "  enjoy it  " } });
  expect(screen.getByRole("status").textContent).toContain("enjoy it");
  expect(onSent).toHaveBeenCalledTimes(1);
});
it("reuses the same request id when delivery could not be confirmed", async () => {
  send.mockRejectedValueOnce(new Error("connection lost"));
  const onSent = vi.fn();
  render(wrap(<GiftSpareDialog card={card} onClose={() => {}} onSent={onSent} />));
  fireEvent.change(screen.getByRole("textbox", { name: "Find a collector" }), { target: { value: "Reci" } });
  fireEvent.click(await screen.findByRole("button", { name: "Recipient" }));
  fireEvent.click(screen.getByRole("button", { name: "Send to Recipient" }));
  await screen.findByRole("alert");
  expect(onSent).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Send to Recipient" }));
  await screen.findByRole("status");
  expect(send.mock.calls[0][0]).toEqual(send.mock.calls[1][0]);
  expect(onSent).toHaveBeenCalledTimes(1);
});
it("does not announce success when the server refuses the card", async () => {
  send.mockResolvedValue({ ok: false, error: "no_spare" });
  const onSent = vi.fn();
  render(wrap(<GiftSpareDialog card={card} onClose={() => {}} onSent={onSent} />));
  fireEvent.change(screen.getByRole("textbox", { name: "Find a collector" }), { target: { value: "Reci" } });
  fireEvent.click(await screen.findByRole("button", { name: "Recipient" }));
  fireEvent.click(screen.getByRole("button", { name: "Send to Recipient" }));
  expect((await screen.findByRole("alert")).textContent).toContain("no longer have a copy");
  expect(onSent).not.toHaveBeenCalled();
});
it("accepts an offer before the card counts as received", async () => {
  const offered = { ...card, copies: 0 };
  inbox.mockResolvedValue({ gifts: [{ id: 9, sender: recipient, card: offered, message: "happy birthday", status: "pending" }], total: 1 });
  respond.mockResolvedValue({ ok: true, giftId: 9, status: "accepted", gifts: [{ id: 9, sender: recipient, card, message: "happy birthday", status: "accepted" }], total: 1 });
  const onReceived = vi.fn();
  render(wrap(<GiftInbox onReceived={onReceived} />));
  fireEvent.click(await screen.findByRole("button", { name: "Gifts (1)" }));
  expect(screen.getByText("Recipient")).toBeTruthy();
  expect(screen.getByText("happy birthday")).toBeTruthy();
  expect(onReceived).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  await waitFor(() => expect(onReceived).toHaveBeenCalledTimes(1));
  expect(respond).toHaveBeenCalledWith({ data: { giftId: 9, action: "accept", page: 0 } });
  expect(screen.getByText("It's already in your collection.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
});
it("declines an offer without touching the collection", async () => {
  inbox.mockResolvedValue({ gifts: [{ id: 9, sender: recipient, card: { ...card, copies: 0 }, message: null, status: "pending" }], total: 1 });
  respond.mockResolvedValue({ ok: true, giftId: 9, status: "declined", gifts: [], total: 0 });
  const onReceived = vi.fn();
  render(wrap(<GiftInbox onReceived={onReceived} />));
  fireEvent.click(await screen.findByRole("button", { name: "Gifts (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(respond).toHaveBeenCalledWith({ data: { giftId: 9, action: "decline", page: 0 } });
  expect(onReceived).not.toHaveBeenCalled();
  expect(dismiss).not.toHaveBeenCalled();
});
it("closes only the receipts of cards already taken", async () => {
  inbox.mockResolvedValue({ gifts: [
    { id: 9, sender: recipient, card, message: null, status: "accepted" },
    { id: 10, sender: recipient, card: { ...card, copies: 0 }, message: null, status: "pending" },
  ], total: 2 });
  dismiss.mockResolvedValue({ gifts: [{ id: 10, sender: recipient, card: { ...card, copies: 0 }, message: null, status: "pending" }], total: 1 });
  render(wrap(<GiftInbox onReceived={() => {}} />));
  fireEvent.click(await screen.findByRole("button", { name: "Gifts (2)" }));
  fireEvent.click(screen.getByRole("button", { name: "Ok" }));
  await waitFor(() => expect(dismiss).toHaveBeenCalledWith({ data: { ids: [9], page: 0 } }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
});
it("adds no toolbar button when there are no incoming gifts", async () => {
  inbox.mockResolvedValue({ gifts: [], total: 0 });
  render(wrap(<GiftInbox onReceived={() => {}} />));
  await waitFor(() => expect(inbox).toHaveBeenCalled());
  expect(screen.queryByRole("button")).toBeNull();
});

it("refreshes once when polling discovers acceptance in another tab", async () => {
  inbox.mockResolvedValue({ gifts: [{ id: 9, sender: recipient, card, message: null, status: "pending" }], total: 1, page: 0 });
  const onReceived = vi.fn();
  render(wrap(<GiftInbox onReceived={onReceived} />));
  fireEvent.click(await screen.findByRole("button", { name: "Gifts (1)" }));
  expect(onReceived).not.toHaveBeenCalled();
  inbox.mockResolvedValue({ gifts: [{ id: 9, sender: recipient, card, message: null, status: "accepted" }], total: 1, page: 0 });
  fireEvent.focus(window);
  await screen.findByText("It's already in your collection.");
  expect(onReceived).toHaveBeenCalledTimes(1);
  fireEvent.focus(window);
  await waitFor(() => expect(inbox).toHaveBeenCalledTimes(3));
  expect(onReceived).toHaveBeenCalledTimes(1);
});
it("pages past pending offers and answers an older offer on its own page", async () => {
  const offer = { id: 30, sender: recipient, card, message: null, status: "pending" };
  inbox.mockResolvedValue({ gifts: [offer], total: 21, page: 0 });
  render(wrap(<GiftInbox onReceived={() => {}} />));
  fireEvent.click(await screen.findByRole("button", { name: "Gifts (21)" }));
  inbox.mockResolvedValue({ gifts: [{ ...offer, id: 9 }], total: 21, page: 1 });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(screen.getByText("2 / 2")).toBeTruthy());
  expect(inbox).toHaveBeenLastCalledWith({ data: { page: 1 } });
  expect(dismiss).not.toHaveBeenCalled();
  expect(respond).not.toHaveBeenCalled();
  respond.mockResolvedValue({ ok: true, giftId: 9, status: "declined", gifts: [offer], total: 20, page: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  await waitFor(() => expect(respond).toHaveBeenCalledWith({ data: { giftId: 9, action: "decline", page: 1 } }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Next" })).toBeNull());
});
