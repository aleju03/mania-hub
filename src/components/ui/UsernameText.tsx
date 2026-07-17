import { getAvatarAccentStoreKey } from "../../lib/avatar-accent";
import { useAppStore } from "../../store";

// Colored player names. Accents are computed by the live backend and arrive inside the same
// payloads that carry the names (harvested into the store by avatar-accent-harvest.ts), so this is
// a pure store read: no fetching, no queues. A URL with no accent yet simply renders in the
// surrounding text color until a later payload carries it.
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

  return (
    <span
      className={className}
      style={{ transition: "color 220ms ease-out", ...(accent ? { color: accent } : null) }}
    >
      {username}
    </span>
  );
}
