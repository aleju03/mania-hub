// Store-key builder for the URL-keyed avatar accent map (accents themselves are computed by the
// live backend and harvested from payloads; see avatar-accent-harvest.ts). The version survives
// from the legacy client-side extractor so persisted entries stay compatible; bump it if the
// backend's extraction algorithm ever changes colors wholesale.
export const AVATAR_ACCENT_VERSION = 3;

export function getAvatarAccentStoreKey(url: string): string {
  return `v${AVATAR_ACCENT_VERSION}:${url}`;
}
