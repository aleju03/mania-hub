import { useEffect, useRef, useState } from "react";
import { Check, Gift, Loader2, X } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { dismissOwnPackGifts, fetchOwnPackGifts, respondToOwnPackGift, type PackGiftError, type PackGiftInbox, type PackGiftReceipt } from "#/lib/pack-gifts";
import { collectedCardTier, type CollectedCard } from "#/lib/pack-collection";
import { MANIA_TIER_STYLES } from "#/lib/maniacard";
import { PackDialog } from "./PackDialog";
import { CollectionCardTile } from "./CardTile";
import { useCardThumbnails } from "./useCardThumbnails";
import { cardThumbnailKeyForCollectionCard, getMemoryCardThumbnail } from "./cardThumbnailCache";

export function GiftInbox({ onReceived }: { onReceived: () => void }) {
  const { t } = useLingui();
  const [inbox, setInbox] = useState<PackGiftInbox | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [answering, setAnswering] = useState<number | null>(null);
  const inboxRevision = useRef(0);
  const page = useRef(0);
  const mutating = useRef(false);
  const accepted = useRef(new Set<number>());
  const onReceivedRef = useRef(onReceived);
  onReceivedRef.current = onReceived;
  const updateInbox = (next: PackGiftInbox, acceptedGiftId?: number) => {
    let received = false;
    const ids = next.gifts.filter((gift) => gift.status === "accepted").map((gift) => gift.id);
    if (acceptedGiftId !== undefined) ids.push(acceptedGiftId);
    for (const id of ids) {
      if (!accepted.current.has(id)) received = true;
      accepted.current.add(id);
    }
    page.current = next.page ?? 0;
    setInbox(next);
    if (received) onReceivedRef.current();
  };
  useEffect(() => {
    let cancelled = false;
    let loading = false;
    const read = async () => {
      if (loading || mutating.current || document.visibilityState === "hidden") return;
      loading = true;
      const revision = inboxRevision.current;
      try {
        const next = await fetchOwnPackGifts({ data: { page: page.current } });
        if (cancelled || !next || revision !== inboxRevision.current) return;
        updateInbox(next);
      } catch { /* Keep the last receipt; focus/the next poll retries. */ }
      finally { loading = false; }
    };
    void read();
    const timer = setInterval(() => { void read(); }, 30_000);
    const onFocus = () => { void read(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, []);
  const cards = open ? (inbox?.gifts.flatMap((gift) => gift.card ? [gift.card as CollectedCard] : []) ?? []) : [];
  const thumbnails = useCardThumbnails(cards);
  // An offer is answered, not dismissed: only the receipts of cards already
  // taken can be closed, and a pending offer stays until it is one or the other.
  const dismiss = async () => {
    if (!inbox || mutating.current) return;
    const ids = inbox.gifts.filter((gift) => gift.status !== "pending").map((gift) => gift.id);
    if (ids.length === 0) { setOpen(false); return; }
    mutating.current = true;
    setBusy(true); setFailed(null);
    inboxRevision.current += 1;
    try {
      const next = await dismissOwnPackGifts({ data: { ids, page: page.current } });
      if (!next) throw new Error("Gift inbox unavailable");
      inboxRevision.current += 1;
      updateInbox(next); setOpen(next.gifts.length > 0);
    } catch { setFailed(t`That did not go through. Try again.`); }
    finally { mutating.current = false; setBusy(false); }
  };
  const refusal = (reason: PackGiftError) => {
    if (reason === "no_spare") return t`They no longer have that card to give.`;
    if (reason === "gift_not_found") return t`That gift is no longer there.`;
    return t`That did not go through. Try again.`;
  };
  const respond = async (giftId: number, action: "accept" | "decline") => {
    if (mutating.current) return;
    mutating.current = true;
    setAnswering(giftId); setFailed(null);
    inboxRevision.current += 1;
    try {
      const next = await respondToOwnPackGift({ data: { giftId, action, page: page.current } });
      if (!next) throw new Error("Gift inbox unavailable");
      inboxRevision.current += 1;
      updateInbox(next, next.ok && next.status === "accepted" ? next.giftId : undefined);
      if (!next.ok) { setFailed(refusal(next.error)); return; }
      if (next.gifts.length === 0) setOpen(false);
    } catch { setFailed(t`That did not go through. Try again.`); }
    finally { mutating.current = false; setAnswering(null); }
  };
  const changePage = async (requestedPage: number) => {
    if (mutating.current) return;
    mutating.current = true;
    setBusy(true); setFailed(null);
    inboxRevision.current += 1;
    try {
      const next = await fetchOwnPackGifts({ data: { page: requestedPage } });
      if (!next) throw new Error("Gift inbox unavailable");
      updateInbox(next);
    } catch { setFailed(t`That did not go through. Try again.`); }
    finally { inboxRevision.current += 1; mutating.current = false; setBusy(false); }
  };
  if (!inbox?.total) return null;
  return <>
    <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-semibold text-osu-pink-light hover:bg-white/5 hover:text-white">
      <Gift size={14} />{t`Gifts (${inbox.total})`}
    </button>
    {open && <PackDialog title={t`A little something for you`} onClose={() => setOpen(false)} busy={busy || answering !== null} width="sm">
      <div className="space-y-3">
        {inbox.gifts.map((gift) => <GiftReceipt key={gift.id} gift={gift} onThumbnailError={thumbnails.onThumbnailError}
          answering={answering === gift.id} disabled={busy || answering !== null}
          onRespond={(action) => void respond(gift.id, action)} />)}
      </div>
      {inbox.total > 20 && <div className="mt-4 flex items-center justify-between gap-3">
        <button type="button" disabled={busy || answering !== null || page.current === 0} onClick={() => void changePage(page.current - 1)}
          className="rounded-lg px-3 py-1.5 text-[12px] text-osu-f1 hover:bg-white/5 disabled:opacity-40">{t`Previous`}</button>
        <span className="text-[11px] text-osu-f1">{page.current + 1} / {Math.ceil(inbox.total / 20)}</span>
        <button type="button" disabled={busy || answering !== null || (page.current + 1) * 20 >= inbox.total} onClick={() => void changePage(page.current + 1)}
          className="rounded-lg px-3 py-1.5 text-[12px] text-osu-f1 hover:bg-white/5 disabled:opacity-40">{t`Next`}</button>
      </div>}
      {failed && <p role="alert" className="mt-4 text-[12px] text-rose-300">{failed}</p>}
      <button type="button" disabled={busy || answering !== null} onClick={() => void dismiss()} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-osu-pink/20 px-4 py-2.5 text-[12px] font-semibold text-white transition-colors hover:bg-osu-pink/30 disabled:opacity-40">
        {busy && <Loader2 size={14} className="animate-spin" />}
        {t`Ok`}
      </button>
    </PackDialog>}
  </>;
}

function GiftReceipt({ gift, onThumbnailError, onRespond, answering, disabled }: {
  gift: PackGiftReceipt;
  onThumbnailError: (card: CollectedCard) => void;
  onRespond: (action: "accept" | "decline") => void;
  answering: boolean;
  disabled: boolean;
}) {
  const { t } = useLingui();
  const card = gift.card;
  const tier = card ? MANIA_TIER_STYLES[collectedCardTier(card)] : null;

  return (
    <div className="relative isolate overflow-hidden rounded-xl border border-white/5 bg-black/15 px-3 py-5 sm:px-4">
      <div aria-hidden="true" className="pointer-events-none absolute -left-12 -top-8 -z-10 h-64 w-64 rounded-full opacity-25 blur-3xl" style={{ background: tier?.badgeHalo ?? "var(--color-osu-pink)" }} />
      <div className="flex items-center gap-5 sm:gap-6">
        <div className="relative w-[112px] shrink-0 sm:w-[136px]">
          {card ? <div className="-rotate-3 drop-shadow-[0_8px_12px_rgba(0,0,0,0.4)]">
            <CollectionCardTile card={card} thumbnail={getMemoryCardThumbnail(cardThumbnailKeyForCollectionCard(card))} canBackfill={false} onApplyMint={() => false} onThumbnailError={onThumbnailError} showCopies={false} />
          </div> : <div className="flex aspect-[5/7] items-center justify-center rounded-xl border border-white/10 bg-white/5"><Gift aria-hidden="true" size={36} className="text-osu-pink-light" /></div>}
          <div aria-hidden="true" className="absolute -bottom-2 -right-2 flex h-8 w-8 rotate-6 items-center justify-center rounded-lg border border-white/15 bg-osu-b4 text-osu-pink-light shadow-lg">
            <Gift size={16} />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-osu-f1">{t`A gift from`}</p>
          <div className="mt-1.5 flex items-center gap-2">
            <img src={gift.sender.avatarUrl} alt="" width={24} height={24} className="h-6 w-6 shrink-0 rounded-full ring-1 ring-white/10" />
            <span className="break-words text-[12px] font-semibold leading-snug text-white [overflow-wrap:anywhere]">{gift.sender.username}</span>
          </div>
          {card ? <>
            <p className="mt-4 break-words text-[17px] font-bold leading-tight text-white [overflow-wrap:anywhere]">{card.username}</p>
            <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-osu-f1">{card.customLabel ?? tier?.label}</p>
            {gift.status === "pending"
              ? card.copies > 0 && <p className="mt-4 text-[11px] leading-relaxed text-osu-f1">{t`You already have ${card.copies}.`}</p>
              : <p className="mt-4 text-[11px] leading-relaxed text-osu-f1">{t`It's already in your collection.`}</p>}
          </> : <p className="mt-4 text-[12px] text-osu-f1">{t`Sent you a card.`}</p>}
          {gift.message && <p className="mt-3 break-words border-l-2 border-white/10 pl-3 text-[12px] italic leading-relaxed text-osu-l2 [overflow-wrap:anywhere]">{gift.message}</p>}
          {gift.status === "pending" && <div className="mt-4 flex items-center gap-2">
            <button type="button" disabled={disabled} onClick={() => onRespond("accept")}
              className="flex items-center gap-1.5 rounded-lg bg-osu-pink/20 px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-osu-pink/30 disabled:opacity-40">
              {answering ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}{t`Accept`}
            </button>
            <button type="button" disabled={disabled} onClick={() => onRespond("decline")}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold text-osu-f1 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-40">
              <X size={13} />{t`Decline`}
            </button>
          </div>}
        </div>
      </div>
    </div>
  );
}
