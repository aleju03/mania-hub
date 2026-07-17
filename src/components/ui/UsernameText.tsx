import { useEffect } from "react";
import { getAvatarAccentStoreKey } from "../../lib/avatar-accent";
import { requestAvatarAccent } from "../../lib/avatar-accent-harvest";
import { useAppStore } from "../../store";

// Colored player names. Accents are computed by the live backend and arrive inside the same
// payloads that carry the names (harvested into the store by avatar-accent-harvest.ts), so this is
// normally a pure store read. Names from osu!-API-sourced data (home top players, /rankings) have
// no payload to ride, so a miss registers the URL for a batched backend lookup; until it answers,
// the name renders in the surrounding text color.
export function UsernameText({
  username,
  avatarUrl,
  className,
}: {
  username: string;
  avatarUrl?: string;
  className?: string;
}) {
  const accentKey = avatarUrl ? getAvatarAccentStoreKey(avatarUrl) : null;
  const accent = useAppStore((state) => (accentKey ? state.avatarAccents[accentKey]?.value ?? null : null));

  useEffect(() => {
    if (!accent && avatarUrl) requestAvatarAccent(avatarUrl);
  }, [accent, avatarUrl]);

  return (
    <span
      className={className}
      style={{ transition: "color 220ms ease-out", ...(accent ? { color: accent } : null) }}
    >
      {username}
    </span>
  );
}
