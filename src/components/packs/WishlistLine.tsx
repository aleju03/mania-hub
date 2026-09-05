import { useState } from "react";
import { Star, X } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useLingui } from "@lingui/react/macro";
import { useLocale } from "#/lib/locale-context";
import { formatNumber } from "#/lib/format";
import { avatarImageSrc } from "#/components/ui/Avatar";
import { CountryFlag } from "#/components/ui/CountryFlag";
import type { PackWishlist } from "#/lib/pack-wishlist";
import { PackDialog } from "./PackDialog";

/** The toolbar shows only the count; names and odds belong inside the manager. */
export function WishlistLine({ wishlist, onRemove }: { wishlist: PackWishlist; onRemove: (userId: number) => void }) {
  const { t } = useLingui();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const chance = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(wishlist.state.chance);
  return <>
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-semibold text-osu-f1 transition-colors hover:bg-osu-b4/60 hover:text-white"
    >
      <Star size={12} />
      <span>{t`Wishlist`}</span>
      <span className="tabular-nums text-osu-f1/60">{wishlist.players.length}/5</span>
    </button>
    {open && <PackDialog
      title={t`Your wishlist`}
      subtitle={<span className="tabular-nums">{wishlist.players.length}/5</span>}
      width="sm"
      onClose={() => setOpen(false)}
    >
      <p className="text-[11px] leading-relaxed text-osu-f1">{t`Add players from the missing cards in your collection. Eligible packs have a growing chance to include one of your wishes.`}</p>
      {wishlist.players.length > 0 ? <>
        <p className="mt-2 text-[11px] font-semibold text-osu-pink-light">{t`Bonus chance per eligible pack: ${chance}`}</p>
        <ul className="mt-3 divide-y divide-osu-b3/30">{wishlist.players.map((player) => <li key={player.userId} className="flex items-center gap-2.5 py-2">
          <img
            src={avatarImageSrc(player.avatarUrl, player.userId)}
            alt=""
            width={28}
            height={28}
            className="h-7 w-7 shrink-0 rounded-full object-cover"
            loading="lazy"
            draggable={false}
          />
          <Link
            to="/player/$username/maniacard"
            params={{ username: player.username }}
            translate="no"
            className="min-w-0 flex-1 truncate text-[12px] font-semibold text-osu-c1/85 transition-colors hover:text-osu-pink"
          >
            {player.username}
          </Link>
          {player.countryCode && <CountryFlag code={player.countryCode} size="xs" />}
          {player.globalRank != null && (
            <span className="shrink-0 text-[10px] tabular-nums text-osu-f1/60">#{formatNumber(player.globalRank, locale)}</span>
          )}
          <button
            type="button"
            onClick={() => onRemove(player.userId)}
            aria-label={t`Remove ${player.username} from your wishlist`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-osu-f1 transition-colors hover:bg-osu-b3/60 hover:text-white"
          >
            <X size={13} />
          </button>
        </li>)}</ul>
      </> : <p className="py-10 text-center text-[12px] text-osu-f1">{t`No wishes yet. Choose a missing player to get started.`}</p>}
    </PackDialog>}
  </>;
}
