import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { fetchServerPackCollectionPage } from "../../lib/pack-wallet-sync";
import { packCardKeyOf, type CollectedCard } from "../../lib/pack-collection";
import type { SupporterBinderId } from "../../lib/supporter-pack-style";
import { BINDER_PAGE_SIZE, BinderPages } from "../packs/BinderPages";
import { CollectionCardTile } from "../packs/CardTile";
import { cardThumbnailKeyForCollectionCard, getMemoryCardThumbnail } from "../packs/cardThumbnailCache";
import { useCardThumbnails } from "../packs/useCardThumbnails";

/* The binder on show in the /supporter stage, holding the viewer's own best
   cards, two spreads of them, so a cover can be seen with real cards in it
   and a page turned. Read once per visit; nothing here writes. */

const SPREADS = 2;
let cached: CollectedCard[] | null = null;

export function TestBinder({ binder }: { binder: SupporterBinderId | null }) {
  const { t } = useLingui();
  const [cards, setCards] = useState<CollectedCard[] | null>(cached);
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (cached) return;
    let alive = true;
    void fetchServerPackCollectionPage({ data: { page: 0, pageSize: BINDER_PAGE_SIZE * SPREADS, sort: "rarity", teams: true } })
      .then((result) => {
        cached = (result?.cards as CollectedCard[] | undefined) ?? [];
        if (alive) setCards(cached);
      })
      .catch(() => {
        if (alive) setCards([]);
      });
    return () => {
      alive = false;
    };
  }, []);
  const shown = (cards ?? []).slice(page * BINDER_PAGE_SIZE, (page + 1) * BINDER_PAGE_SIZE);
  const { onThumbnailError } = useCardThumbnails(cards ?? []);

  if (!binder) {
    return <p className="py-16 text-center text-[13px] text-osu-f1">{t`Without a binder, your collection shows as the usual grid.`}</p>;
  }
  return (
    <div className="w-full py-3">
      <BinderPages binder={binder} page={page} ready={cards !== null} className="bnd--contained">
        {shown.map((card) => (
          <CollectionCardTile
            key={packCardKeyOf(card)}
            card={card}
            thumbnail={getMemoryCardThumbnail(cardThumbnailKeyForCollectionCard(card))}
            canBackfill={false}
            onApplyMint={() => false}
            onThumbnailError={onThumbnailError}
          />
        ))}
      </BinderPages>
      <div className="mt-2 flex items-center justify-center gap-2">
        <button type="button" aria-label={t`Previous page`} disabled={page === 0} onClick={() => setPage((n) => Math.max(0, n - 1))} className="grid h-8 w-8 cursor-pointer place-items-center rounded-lg bg-white/[0.06] text-osu-l2 transition-colors hover:bg-white/[0.12] disabled:cursor-default disabled:opacity-30">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button type="button" aria-label={t`Next page`} disabled={page >= SPREADS - 1} onClick={() => setPage((n) => Math.min(SPREADS - 1, n + 1))} className="grid h-8 w-8 cursor-pointer place-items-center rounded-lg bg-white/[0.06] text-osu-l2 transition-colors hover:bg-white/[0.12] disabled:cursor-default disabled:opacity-30">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
