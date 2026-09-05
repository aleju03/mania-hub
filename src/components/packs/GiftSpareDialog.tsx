import { useEffect, useRef, useState } from "react";
import { Check, Gift, Loader2, Search } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { packCardKeyOf, type CollectedCard } from "#/lib/pack-collection";
import { GIFT_MESSAGE_MAX_CHARS, searchOwnGiftRecipients, sendOwnPackGift, type GiftCollector, type PackGiftError } from "#/lib/pack-gifts";
import { PackDialog } from "./PackDialog";
import { CollectionCardTile } from "./CardTile";
import { useCardThumbnails } from "./useCardThumbnails";
import { cardThumbnailKeyForCollectionCard, getMemoryCardThumbnail } from "./cardThumbnailCache";

export function GiftSpareDialog({ card, onClose, onSent }: { card: CollectedCard; onClose: () => void; onSent: () => void }) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [recipients, setRecipients] = useState<GiftCollector[]>([]);
  const [recipient, setRecipient] = useState<GiftCollector | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const remaining = card.copies - 1;
  const thumbnails = useCardThumbnails([card]);
  useEffect(() => {
    if (recipient || query.trim().length < 2) { setRecipients([]); setSearching(false); return; }
    let cancelled = false;
    setSearching(true); setSearchFailed(false);
    const timer = setTimeout(() => {
      searchOwnGiftRecipients({ data: { query } }).then((next) => { if (!cancelled) setRecipients(next); })
        .catch(() => { if (!cancelled) { setRecipients([]); setSearchFailed(true); } })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, recipient, searchAttempt]);
  const refusal = (reason: PackGiftError) => {
    if (reason === "no_spare") return t`You no longer have a copy of this card.`;
    if (reason === "special_card") return t`This special-edition Eternal stays with its collector.`;
    if (reason === "unverified_card") return t`Pull this card while signed in before gifting it.`;
    if (reason === "card_not_ready") return t`This card is not ready to gift. Open it to finish loading its stats.`;
    if (reason === "recipient_not_found") return t`That collector is no longer available.`;
    if (reason === "self_gift") return t`Choose another collector for your gift.`;
    if (reason === "gift_not_found") return t`That gift is no longer there.`;
    return t`Your collection changed. Nothing was sent. Refresh and try again.`;
  };
  const send = async () => {
    if (!recipient || busy || sent) return;
    requestId.current ??= crypto.randomUUID();
    setAttempted(true); setBusy(true); setError(null);
    try {
      const result = await sendOwnPackGift({ data: { recipientUserId: recipient.userId, cardKey: packCardKeyOf(card), requestId: requestId.current, message } });
      if (!result) { setError(t`Sign in again to send a gift.`); return; }
      if (!result.ok) { setError(refusal(result.error)); return; }
      setSent(true); onSent();
    } catch { setError(t`Could not confirm delivery. Retry to check this same gift.`); }
    finally { setBusy(false); }
  };
  return <PackDialog title={sent ? t`Gift sent` : t`Gift a card`} onClose={onClose} busy={busy} width="md">
    <div className="flex items-start gap-4">
      <div className="w-[104px] shrink-0">
        <CollectionCardTile card={card} thumbnail={getMemoryCardThumbnail(cardThumbnailKeyForCollectionCard(card))} canBackfill={false} onApplyMint={() => false} onThumbnailError={thumbnails.onThumbnailError} showCopies={false} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-white">{card.username}</p>
        <p className="mt-1 text-[12px] text-osu-f1">{remaining > 0 ? t`One copy for a friend. You keep ${remaining}.` : t`Your only copy. It leaves your collection when they accept.`}</p>
        {sent ? <div role="status" className="mt-4">
          <p className="flex items-center gap-2 text-[13px] text-white"><Check className="shrink-0 text-emerald-300" size={16} />{t`Sent to ${recipient?.username ?? ""}.`}</p>
          <p className="mt-1 text-[12px] text-osu-f1">{t`The card stays yours until they accept it.`}</p>
          {message.trim() && <p className="mt-2 break-words text-[12px] italic text-osu-f1 [overflow-wrap:anywhere]">{message.trim()}</p>}
          <button type="button" onClick={onClose} className="mt-4 rounded-lg bg-osu-pink/20 px-4 py-2 text-[12px] font-semibold text-white">{t`Done`}</button>
        </div> : <>
          {recipient ? <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg bg-white/5 p-2">
            <img src={recipient.avatarUrl} alt="" width={28} height={28} className="h-7 w-7 rounded-full" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-white">{recipient.username}</span>
            {!attempted && <button type="button" onClick={() => setRecipient(null)} className="text-[11px] text-osu-f1 hover:text-white">{t`Change`}</button>}
          </div> : <>
            <label className="relative mt-4 block">
              <Search size={13} className="pointer-events-none absolute left-2 top-2.5 text-osu-f1" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t`Find a collector`} aria-label={t`Find a collector`} maxLength={32}
                className="w-full rounded-lg border border-osu-b3/40 bg-osu-b4/50 py-2 pl-7 pr-2 text-[12px] text-white outline-none focus:border-osu-pink/50" />
            </label>
            {searching ? <Loader2 size={15} className="mt-3 animate-spin text-osu-f1" />
              : searchFailed ? <p className="mt-3 text-[11px] text-rose-300">{t`Could not search collectors. Try again.`} <button type="button" onClick={() => setSearchAttempt((value) => value + 1)} className="underline">{t`Try again`}</button></p>
              : query.trim().length >= 2 && recipients.length === 0 ? <p className="mt-3 text-[11px] text-osu-f1">{t`No collector found. They need to open a pack first.`}</p> : null}
            <div className="mt-2 max-h-48 overflow-y-auto">{recipients.map((person) => <button key={person.userId} type="button" onClick={() => { setRecipient(person); setError(null); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[12px] text-osu-l2 hover:bg-white/5 hover:text-white">
              <img src={person.avatarUrl} alt="" width={24} height={24} className="h-6 w-6 rounded-full" /><span className="truncate">{person.username}</span>
            </button>)}</div>
          </>}
          <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={2} maxLength={GIFT_MESSAGE_MAX_CHARS}
            placeholder={t`Add a message (optional)`} aria-label={t`Message`}
            className="mt-3 w-full resize-none rounded-lg border border-osu-b3/40 bg-osu-b4/50 px-2 py-2 text-[12px] text-white outline-none focus:border-osu-pink/50" />
          {message.length > GIFT_MESSAGE_MAX_CHARS - 20 && <p className="mt-1 text-right text-[11px] text-osu-f1">{GIFT_MESSAGE_MAX_CHARS - message.length}</p>}
          {error && <p role="alert" className="mt-3 text-[12px] text-rose-300">{error}</p>}
          <button type="button" onClick={() => void send()} disabled={!recipient || busy || card.copies < 1} className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-osu-pink/20 px-3 py-2 text-[12px] font-semibold text-white hover:bg-osu-pink/30 disabled:cursor-not-allowed disabled:opacity-40">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Gift size={14} />}{busy ? t`Sending…` : recipient ? t`Send to ${recipient.username}` : t`Choose a collector`}
          </button>
        </>}
      </div>
    </div>
  </PackDialog>;
}
