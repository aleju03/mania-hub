import { useEffect } from "react";
import { AVATAR_ACCENT_VERSION, getAvatarAccentStoreKey } from "../../lib/avatar-accent";
import { getAvatarAccents } from "../../lib/avatar";
import { AVATAR_ACCENT_CLIENT_TTL, useAppStore } from "../../store";

const pendingUrls = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const AVATAR_ACCENT_FAILURE_RETRY_TTL = 5 * 60 * 1000;
// A single failed batch used to paint every visible username white and keep it
// that way for AVATAR_ACCENT_FAILURE_RETRY_TTL. Most failures are transient (a
// cold serverless start, a momentary network blip, a Turso hiccup), so retry
// the same batch a few times with backoff before recording the null result that
// triggers the longer cooldown.
const AVATAR_ACCENT_FETCH_MAX_RETRIES = 3;
const AVATAR_ACCENT_FETCH_RETRY_BASE_MS = 600;

function commitAvatarAccentResults(accents: Record<string, string | null>, startedAt: number) {
  const currentAccents = useAppStore.getState().avatarAccents;
  const currentEntries = Object.entries(accents);
  const freshEntries = currentEntries.filter(([url, accent]) => {
    if (accent !== null) return true;
    const current = currentAccents[getAvatarAccentStoreKey(url)];
    return !current || current.fetchedAt <= startedAt;
  });
  if (freshEntries.length === 0) return;
  useAppStore.getState().setAvatarAccents(Object.fromEntries(freshEntries));
}

function requestAvatarAccents(urls: string[], attempt: number, startedAt: number) {
  getAvatarAccents({ data: { urls, version: AVATAR_ACCENT_VERSION } })
    .then((accents) => {
      commitAvatarAccentResults(accents, startedAt);
    })
    .catch(() => {
      if (attempt < AVATAR_ACCENT_FETCH_MAX_RETRIES) {
        const delay = AVATAR_ACCENT_FETCH_RETRY_BASE_MS * 2 ** attempt;
        setTimeout(() => requestAvatarAccents(urls, attempt + 1, startedAt), delay);
        return;
      }
      const failed = Object.fromEntries(urls.map((url) => [url, null])) as Record<string, null>;
      commitAvatarAccentResults(failed, startedAt);
    });
}

function flushAvatarAccentQueue() {
  if (pendingUrls.size === 0) return;

  const urls = [...pendingUrls];
  pendingUrls.clear();
  flushTimer = null;

  requestAvatarAccents(urls, 0, Date.now());
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
