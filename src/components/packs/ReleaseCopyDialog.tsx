import { useEffect, useState } from "react";
import { Check, Loader2, Undo2 } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { packCardKeyOf, releaseShardValue, type CollectedCard } from "#/lib/pack-collection";
import { masteryLevel } from "#/lib/pack-run";
import { fetchOwnHeldCopies, type HeldCopies } from "#/lib/pack-gifts";
import { PackDialog } from "./PackDialog";
import { CollectionCardTile } from "./CardTile";
import { CopyPicker } from "./GiftSpareDialog";
import { useCardThumbnails } from "./useCardThumbnails";
import { cardThumbnailKeyForCollectionCard, getMemoryCardThumbnail } from "./cardThumbnailCache";
import { UsernameText } from "../ui/UsernameText";

/* Putting one numbered copy back in the pool: it pays what recycling it
   would, and its number waits for the next pull of the card instead of
   burning (backend pack-copy-pool.ts). Left alone the copy is the highest
   number held, so a #1 only goes back when it is picked. */
export function ReleaseCopyDialog({ card, onClose, onRelease, onReleased }: {
  card: CollectedCard;
  onClose: () => void;
  onRelease: (cardKey: string, serial: number) => Promise<{ released: boolean; gained: number } | null>;
  onReleased: (gained: number) => void;
}) {
  const { t } = useLingui();
  const cardKey = packCardKeyOf(card);
  const [held, setHeld] = useState<HeldCopies | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ serial: number; gained: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const thumbnails = useCardThumbnails([card]);

  useEffect(() => {
    let cancelled = false;
    fetchOwnHeldCopies({ data: { cardKey } })
      .then((next) => { if (!cancelled) { setHeld(next); setLoadFailed(!next); } })
      .catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, [cardKey]);

  const serial = picked ?? held?.serials.at(-1)?.serial ?? null;
  const remaining = card.copies - 1;
  const gain = releaseShardValue(card);
  /* The number takes the recycled copies behind the card level with it
     (backend pack-copy-pool.ts): its next holder gets that level, and the
     collector keeps what their remaining copies give. */
  const carriedLevel = masteryLevel((card.recycledCopies ?? 0) + 1);
  const levelLeft = masteryLevel(card.copies - 1);

  const release = async () => {
    if (serial == null || busy || done) return;
    setBusy(true); setError(null);
    try {
      const result = await onRelease(cardKey, serial);
      if (!result) { setError(t`Could not reach the server. Nothing changed.`); return; }
      if (!result.released) { setError(t`That copy is no longer yours. Nothing changed.`); return; }
      setDone({ serial, gained: result.gained });
      onReleased(result.gained);
    } finally {
      setBusy(false);
    }
  };

  const number = (value: number) => value.toLocaleString("en-US");

  return <PackDialog title={done ? t`Back in the pool` : t`Put back in the pool`} onClose={onClose} busy={busy} width="md">
    <div className="flex items-start gap-4">
      <div className="w-[104px] shrink-0">
        <CollectionCardTile card={card} thumbnail={getMemoryCardThumbnail(cardThumbnailKeyForCollectionCard(card))} canBackfill={false} onApplyMint={() => false} onThumbnailError={thumbnails.onThumbnailError} showCopies={false} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-white"><UsernameText username={card.username} userId={card.userId} /></p>
        {done ? <div role="status" className="mt-3">
          <p className="flex items-center gap-2 text-[13px] text-white"><Check className="shrink-0 text-emerald-300" size={16} />{t`#${number(done.serial)} is back in the pool. You got ${number(done.gained)} shards.`}</p>
          <button type="button" onClick={onClose} className="mt-4 rounded-lg bg-osu-pink/20 px-4 py-2 text-[12px] font-semibold text-white">{t`Done`}</button>
        </div> : <>
          <p className="mt-1 text-[12px] text-osu-f1">{remaining > 0
            ? serial != null ? t`You give back #${number(serial)} and keep ${remaining}.` : t`You give back one copy and keep ${remaining}.`
            : t`This is your only copy, so the card leaves your collection.`}</p>
          <p className="mt-2 text-[12px] text-osu-f1">{t`The next time anyone pulls this card, there's a 50% chance it comes with this number instead of a new one.`}</p>
          {carriedLevel > 0 && <p className="mt-2 text-[12px] text-osu-f1">{t`Your card level goes with it. Whoever gets this number gets level ${carriedLevel}, and you go down to level ${levelLeft}.`}</p>}
          {held && held.serials.length > 1 ? <CopyPicker held={held} picked={serial} locked={busy} onPick={setPicked} /> : null}
          {loadFailed && <p role="alert" className="mt-3 text-[12px] text-rose-300">{t`Could not load your copies. Close and try again.`}</p>}
          {error && <p role="alert" className="mt-3 text-[12px] text-rose-300">{error}</p>}
          <button type="button" onClick={() => void release()} disabled={serial == null || busy}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-osu-pink/20 px-3 py-2 text-[12px] font-semibold text-white hover:bg-osu-pink/30 disabled:cursor-not-allowed disabled:opacity-40">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Undo2 size={14} />}
            {serial != null ? t`Put back #${number(serial)} +${number(gain)} shards` : t`Loading your copies…`}
          </button>
        </>}
      </div>
    </div>
  </PackDialog>;
}
