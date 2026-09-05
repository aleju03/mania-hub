import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Star } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import type { ServerPackCollectionMissingPlayer } from "#/lib/pack-wallet-sync";
import { CountryFlag } from "../ui/CountryFlag";
import type { WishlistApi } from "./useWishlist";

export function MissingPlayerTile({ player, wishlist }: {
  player: ServerPackCollectionMissingPlayer;
  wishlist?: Pick<WishlistApi, "userIds" | "toggle" | "full">;
}) {
  const { t } = useLingui();
  const tileRef = useRef<HTMLAnchorElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const wished = wishlist?.userIds.has(player.userId) ?? false;
  const wishFull = Boolean(wishlist && !wished && wishlist.full);
  const openMenu = (x: number, y: number) => setMenu({ x: Math.max(8, Math.min(x, window.innerWidth - 220)), y: Math.max(8, Math.min(y, window.innerHeight - 145)) });
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const close = () => setMenu(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); tileRef.current?.focus(); }
      if (event.key === "Tab") { event.preventDefault(); close(); tileRef.current?.focus(); }
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("keydown", escape); window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [menu]);
  const wish = () => {
    if (wishlist && !wishFull) void wishlist.toggle(player.userId);
    if (menu) tileRef.current?.focus({ preventScroll: true });
    setMenu(null);
  };
  return <div className="flex flex-col gap-1">
    <Link ref={tileRef} to="/player/$username/maniacard" params={{ username: player.username }}
      onContextMenu={(event) => {
        if (!wishlist) return;
        event.preventDefault(); openMenu(event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (!wishlist || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
        event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openMenu(rect.left + 12, rect.top + 12);
      }}
      className="relative flex flex-col items-center justify-center overflow-hidden rounded-[10px] border border-dashed border-white/12 bg-black/20 px-1.5 transition-colors hover:border-white/25 hover:bg-black/30" style={{ aspectRatio: "5 / 7" }}>
      <span className="absolute left-1.5 top-1.5 text-[10px] text-osu-f1/60 tabular-nums">#{player.poolRank}</span>
      <CountryFlag code={player.countryCode} size="xs" decorative className="absolute right-1.5 top-2" />
      <img src={player.avatarUrl} alt="" className="h-1/2 w-auto rounded-full object-cover opacity-30 grayscale" loading="lazy" draggable={false} />
      <span className="mt-2 w-full truncate text-center text-[11px] text-osu-f1">{player.username}</span>
    </Link>
    {wishlist && <button type="button" onClick={wish} disabled={wishFull} title={wishFull ? t`Wishlist is full (5)` : undefined} aria-pressed={wished}
      className={`text-center text-[10px] ${wished ? "cursor-pointer text-osu-pink hover:text-white" : wishFull ? "cursor-not-allowed text-osu-f1/40" : "cursor-pointer text-osu-f1/70 hover:text-white"}`}>
      {wished ? t`Wished` : t`Wish`}
    </button>}
    {menu && createPortal(<>
      <div className="fixed inset-0 z-40" onPointerDown={() => setMenu(null)} onContextMenu={(event) => { event.preventDefault(); setMenu(null); }} />
      <div ref={menuRef} role="menu" aria-label={player.username} style={{ left: menu.x, top: menu.y }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
          const index = items.indexOf(document.activeElement as HTMLElement);
          items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        }}
        className="fixed z-50 w-[210px] rounded-lg border border-osu-b3/50 bg-osu-b5 py-1 shadow-[0_12px_32px_rgba(0,0,0,0.55)]">
        <div className="truncate px-3 py-2 text-[12px] font-bold text-white">{player.username}</div>
        <button type="button" role="menuitem" onClick={wish} disabled={wishFull}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-osu-f1 hover:bg-osu-b4/60 hover:text-white focus:bg-osu-b4/60 disabled:cursor-not-allowed disabled:opacity-40">
          <Star size={13} />{wishFull ? t`Wishlist is full (5)` : wished ? t`Remove wish` : t`Wish`}
        </button>
        <Link to="/player/$username" params={{ username: player.username }} role="menuitem" onClick={() => setMenu(null)}
          className="block px-3 py-2 text-[12px] text-osu-f1 hover:bg-osu-b4/60 hover:text-white focus:bg-osu-b4/60">{t`Open profile`}</Link>
      </div>
    </>, document.body)}
  </div>;
}
