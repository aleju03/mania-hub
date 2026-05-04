import { useEffect } from "react";
import { AVATAR_ACCENT_VERSION, getAvatarAccentStoreKey } from "../../lib/avatar-accent";
import { getAvatarAccents } from "../../lib/avatar";
import { AVATAR_ACCENT_CLIENT_TTL, useAppStore } from "../../store";

const pendingUrls = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const AVATAR_ACCENT_FAILURE_RETRY_TTL = 5 * 60 * 1000;

function flushAvatarAccentQueue() {
  if (pendingUrls.size === 0) return;

  const urls = [...pendingUrls];
  pendingUrls.clear();
  flushTimer = null;

  getAvatarAccents({ data: { urls, version: AVATAR_ACCENT_VERSION } })
    .then((accents) => {
      useAppStore.getState().setAvatarAccents(accents);
    })
    .catch(() => {
      const failed = Object.fromEntries(urls.map((url) => [url, null])) as Record<string, null>;
      useAppStore.getState().setAvatarAccents(failed);
    });
}

function queueAvatarAccent(url: string) {
  pendingUrls.add(url);
  if (flushTimer) return;

  flushTimer = setTimeout(() => {
    flushAvatarAccentQueue();
  }, 16);
}

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
  const accentEntry = useAppStore((state) => (accentKey ? state.avatarAccents[accentKey] : undefined));
  const accent = accentEntry?.value ?? null;

  useEffect(() => {
    if (!avatarUrl) {
      return;
    }

    const existing = useAppStore.getState().avatarAccents[getAvatarAccentStoreKey(avatarUrl)];
    if (
      existing &&
      existing.value !== null &&
      Date.now() - existing.fetchedAt < AVATAR_ACCENT_CLIENT_TTL
    ) {
      return;
    }

    if (
      existing &&
      existing.value === null &&
      Date.now() - existing.fetchedAt < AVATAR_ACCENT_FAILURE_RETRY_TTL
    ) {
      const retryDelay = AVATAR_ACCENT_FAILURE_RETRY_TTL - (Date.now() - existing.fetchedAt);
      const retryTimer = setTimeout(() => queueAvatarAccent(avatarUrl), retryDelay);
      return () => clearTimeout(retryTimer);
    }

    queueAvatarAccent(avatarUrl);
  }, [avatarUrl, accentEntry?.fetchedAt, accentEntry?.value]);

  return (
    <span
      className={className}
      style={{ transition: "color 220ms ease-out", ...(accent ? { color: accent } : null) }}
    >
      {username}
    </span>
  );
}
