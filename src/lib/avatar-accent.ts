export const AVATAR_ACCENT_VERSION = 2;

export function getAvatarAccentCacheKey(url: string): string {
  return `avatar-accent:v${AVATAR_ACCENT_VERSION}:${url}`;
}

export function getAvatarAccentStoreKey(url: string): string {
  return `v${AVATAR_ACCENT_VERSION}:${url}`;
}
