import { useEffect, useState, useSyncExternalStore } from "react";
import { track } from "./analytics";
import { skinEventProperties } from "./analytics-skins";
import { useAuth } from "./auth-context";
import { likeSkin, loadLikedSkinIds, markSkinsListStale, readLikedSkinIds, readSkinLikeCount, rememberSkinLiked, subscribeLikedSkins, type SkinSummary } from "./skins";

// The signed-in viewer's liked skin ids, loaded once per tab and shared by
// every caller; null signed out and until the first read lands.
export function useLikedSkinIds(): Set<string> | null {
  const viewerId = useAuth().viewer?.id ?? null;
  useEffect(() => {
    if (viewerId != null) void loadLikedSkinIds(viewerId);
  }, [viewerId]);
  return useSyncExternalStore(subscribeLikedSkins, () => readLikedSkinIds(viewerId), () => null);
}

// One skin's heart: the shared liked ids once loaded (the skin page's own
// read says it before then), and the count the latest like came back with
// over whatever the summary was fetched with. `toggle` likes or unlikes,
// optimistically: a failed write puts the old state back.
export function useSkinLike(skin: SkinSummary): {
  liked: boolean;
  likeCount: number;
  // Signed in, and not the skin's own uploader.
  canLike: boolean;
  own: boolean;
  signedIn: boolean;
  toggle: () => void;
} {
  const viewerId = useAuth().viewer?.id ?? null;
  const ids = useLikedSkinIds();
  const counted = useSyncExternalStore(subscribeLikedSkins, () => readSkinLikeCount(skin.id), () => null);
  const [pending, setPending] = useState<{ liked: boolean; likeCount: number } | null>(null);
  const liked = ids ? ids.has(skin.id) : skin.liked === true;
  const likeCount = counted ?? skin.likeCount ?? 0;
  const own = viewerId != null && viewerId === skin.ownerUserId;
  const canLike = viewerId != null && !own && skin.status === "published" && skin.visibility !== "private";

  const toggle = () => {
    if (!canLike || viewerId == null || pending) return;
    const next = !liked;
    setPending({ liked: next, likeCount: Math.max(0, likeCount + (next ? 1 : -1)) });
    void likeSkin({ data: { id: skin.id, liked: next } })
      .then((result) => {
        if (!result.ok) return;
        rememberSkinLiked(viewerId, skin.id, result.liked, result.likeCount);
        markSkinsListStale();
        if (result.liked) track("skin_like", skinEventProperties(skin));
      })
      .catch(() => {})
      .finally(() => setPending(null));
  };

  return { ...(pending ?? { liked, likeCount }), canLike, own, signedIn: viewerId != null, toggle };
}
