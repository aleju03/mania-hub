import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

// False during SSR and during the hydration render, true from the post-mount render on.
//
// This is the gate for anything the client knows and the server cannot: browser-only prefs read
// synchronously out of localStorage before hydration (avatar accents, hidden players). Feeding
// those into the hydration render makes the client markup disagree with the HTML the server sent -
// React #418 for text, a silently dropped style prop for attributes - so they have to join one
// render later, through a normal diff.
//
// Not the same thing as the store's useHasHydrated(), which waits on Zustand persist's async merge.
// That lands strictly later and is unnecessary for values seeded at module init; this flips on the
// first render after hydration, which is the earliest point that is safe.
export function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, getClientSnapshot, getServerSnapshot);
}
