import { useEffect, useState, useSyncExternalStore } from "react";
import { track } from "./analytics";
import { skinEventProperties } from "./analytics-skins";
import { useAuth } from "./auth-context";
import { guestLikeSkin, likeSkin, loadLikedSkinIds, markSkinsListStale, readLikedSkinIds, readSkinGuestId, readSkinLikeCount, rememberSkinLiked, skinGuestViewerKey, skinUserViewerKey, subscribeLikedSkins, subscribeSkinGuestId, type SkinSummary } from "./skins";

// This browser's guest like id, null until its first signed-out like (and
// on the server, where there is no browser).
export function useSkinGuestId(): string | null {
  return useSyncExternalStore(subscribeSkinGuestId, readSkinGuestId, () => null);
}

// Whose likes the hearts show: the signed-in account, or signed out the
// browser's guest id; null signed out before a first like.
function useLikeViewerKey(): string | null {
  const viewerId = useAuth().viewer?.id ?? null;
  const guestId = useSkinGuestId();
  if (viewerId != null) return skinUserViewerKey(viewerId);
  return guestId ? skinGuestViewerKey(guestId) : null;
}

// The viewer's liked skin ids, loaded once per tab and shared by every
// caller; null with nobody to ask about and until the first read lands.
export function useLikedSkinIds(): Set<string> | null {
  const viewerKey = useLikeViewerKey();
  useEffect(() => {
    if (viewerKey != null) void loadLikedSkinIds(viewerKey);
  }, [viewerKey]);
  return useSyncExternalStore(subscribeLikedSkins, () => readLikedSkinIds(viewerKey), () => null);
}

// One skin's heart: the shared liked ids once loaded (the skin page's own
// read says it before then), and the count the latest like came back with
// over whatever the summary was fetched with. `toggle` likes or unlikes,
// optimistically: a failed write puts the old state back. Signed out, the
// like is the browser's own (guestLikeSkin) until it signs in.
export function useSkinLike(skin: SkinSummary): {
  liked: boolean;
  likeCount: number;
  // Not the skin's own uploader, and a skin the catalog shows.
  canLike: boolean;
  own: boolean;
  toggle: () => void;
} {
  const viewerId = useAuth().viewer?.id ?? null;
  const ids = useLikedSkinIds();
  const counted = useSyncExternalStore(subscribeLikedSkins, () => readSkinLikeCount(skin.id), () => null);
  const [pending, setPending] = useState<{ liked: boolean; likeCount: number } | null>(null);
  const liked = ids ? ids.has(skin.id) : skin.liked === true;
  const likeCount = counted ?? skin.likeCount ?? 0;
  const own = viewerId != null && viewerId === skin.ownerUserId;
  const canLike = !own && skin.status === "published" && skin.visibility !== "private";

  const toggle = () => {
    if (!canLike || pending) return;
    const next = !liked;
    setPending({ liked: next, likeCount: Math.max(0, likeCount + (next ? 1 : -1)) });
    const request = viewerId != null ? likeSkin({ data: { id: skin.id, liked: next } }) : guestLikeSkin(skin.id, next);
    void request
      .then((result) => {
        if (!result.ok) return;
        const guestId = readSkinGuestId();
        const viewerKey = viewerId != null ? skinUserViewerKey(viewerId) : guestId ? skinGuestViewerKey(guestId) : null;
        if (viewerKey) rememberSkinLiked(viewerKey, skin.id, result.liked, result.likeCount);
        markSkinsListStale();
        if (result.liked) track("skin_like", skinEventProperties(skin));
      })
      .catch(() => {})
      .finally(() => setPending(null));
  };

  return { ...(pending ?? { liked, likeCount }), canLike, own, toggle };
}
