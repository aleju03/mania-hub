import { useEffect, useSyncExternalStore, type CSSProperties } from "react";
import { getAvatarAccentStoreKey } from "../../lib/avatar-accent";
import { requestAvatarAccent } from "../../lib/avatar-accent-harvest";
import { ensureSupporterNameStyles, getSupporterNameFont, getSupporterNameOutline, getSupporterNameStyle, subscribeSupporterNameStyles } from "../../lib/live-backend";
import { SupporterStyledName } from "../supporter/SupporterNameStyle";
import { nameOutlineInline } from "../../lib/supporter-name-styles";
import type { SupporterNameFontId } from "../../lib/supporter-name-fonts";
import { avatarUrlUserId } from "./Avatar";
import { useHydrated } from "../../lib/use-hydrated";
import { useAppStore } from "../../store";

// Colored player names. Accents are computed by the live backend and arrive inside the same
// payloads that carry the names (harvested into the store by avatar-accent-harvest.ts), so this is
// normally a pure store read. Names from osu!-API-sourced data (home top players, /rankings) have
// no payload to ride, so a miss registers the URL for a batched backend lookup; until it answers,
// the name renders in the surrounding text color.
// An active supporter's name wears their name tag style and name font instead, looked up by the user id in the
// avatar URL from one shared map (ensureSupporterNameStyles); it joins after hydration like the
// store accent, so server and client markup agree.
export function UsernameText({
  username,
  avatarUrl,
  userId: userIdProp,
  accent: accentProp,
  nameTag,
  className,
}: {
  username: string;
  avatarUrl?: string;
  /** The player's osu! id, for name tags where there is no avatar URL to read it from. */
  userId?: number | string | null;
  /** Accent carried inline by the caller's data; skips the store and the backend lookup. */
  accent?: string | null;
  /** The player's own look, when the caller has it and it has no name style
      (their profile): the shared map, which can be a minute behind, is left unread. */
  nameTag?: { font: SupporterNameFontId | null; outline: string | null };
  className?: string;
}) {
  const accentKey = avatarUrl ? getAvatarAccentStoreKey(avatarUrl) : null;
  const storeAccent = useAppStore((state) => (accentKey ? state.avatarAccents[accentKey]?.value ?? null : null));
  // React skips attribute diffing while hydrating, so a style that exists only in the client render
  // (persisted accents seed the store before hydration) is silently never written to the DOM - and
  // since the store value doesn't change afterwards, nothing re-renders and the name stays
  // uncolored until another visit misses the cache. Deferring store accents to the post-hydration
  // render makes the color land through a normal style-prop diff instead.
  const hydrated = useHydrated();
  // During hydration only the inline accent may render: it's the one piece the server also had, so
  // server and client markup agree. The store accent joins one render later.
  const accent = (hydrated ? storeAccent : null) ?? accentProp ?? null;

  useEffect(() => {
    if (!accent && avatarUrl) requestAvatarAccent(avatarUrl);
  }, [accent, avatarUrl]);

  const userId = nameTag ? null : Number(userIdProp) > 0 ? Number(userIdProp) : avatarUrlUserId(avatarUrl);
  const nameStyle = useSyncExternalStore(
    subscribeSupporterNameStyles,
    () => (hydrated && userId ? getSupporterNameStyle(userId) : null),
    () => null,
  );
  const mapFont = useSyncExternalStore(
    subscribeSupporterNameStyles,
    () => (hydrated && userId ? getSupporterNameFont(userId) : null),
    () => null,
  );
  const mapOutline = useSyncExternalStore(
    subscribeSupporterNameStyles,
    () => (hydrated && userId ? getSupporterNameOutline(userId) : null),
    () => null,
  );
  useEffect(() => {
    if (userId) ensureSupporterNameStyles();
  }, [userId]);
  const nameFont = nameTag ? nameTag.font : mapFont;
  const nameOutline = nameTag ? nameTag.outline : mapOutline;

  if (nameStyle) return <SupporterStyledName nameStyle={nameStyle} nameFont={nameFont} outline={nameOutline} name={username} className={className} />;

  // A name font alone changes the letters, not the colour: the accent stays.
  return (
    <span
      className={`${className ?? ""}${nameFont ? ` name-font--${nameFont}` : ""}${nameOutline ? " name-outline" : ""}`}
      style={{ transition: "color 220ms ease-out", ...(accent ? { color: accent } : null), ...(nameOutline ? nameOutlineInline(nameOutline) : null) } as CSSProperties}
    >
      {username}
    </span>
  );
}
