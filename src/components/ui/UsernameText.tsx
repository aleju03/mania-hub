import { useEffect } from "react";
import { getAvatarAccents } from "../../lib/avatar";
import { useAppStore } from "../../store";

const pendingUrls = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushAvatarAccentQueue() {
  if (pendingUrls.size === 0) return;

  const urls = [...pendingUrls];
  pendingUrls.clear();
  flushTimer = null;

  getAvatarAccents({ data: { urls } })
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
  const accent = useAppStore((state) => (avatarUrl ? state.avatarAccents[avatarUrl] : null));

  useEffect(() => {
    if (!avatarUrl) {
      return;
    }

    if (useAppStore.getState().avatarAccents[avatarUrl] !== undefined) {
      return;
    }

    queueAvatarAccent(avatarUrl);
  }, [avatarUrl]);

  return (
    <span className={className} style={accent ? { color: accent } : undefined}>
      {username}
    </span>
  );
}
