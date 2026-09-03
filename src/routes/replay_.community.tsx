import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";

import { getI18n } from "../lib/i18n";
import { PageHeader } from "../components/layout/PageHeader";
import { ReplayRecentlyViewed } from "../components/replay/ReplayRecentlyViewed";
import { getCommunityBeatmapAssetUrl } from "../lib/community-beatmap-assets";
import { recentReplayUploadKey, type RecentReplayEntry } from "../lib/replay-recent";
import { withModRate } from "../lib/score";
import { pageSeo } from "../lib/seo";
import { getCommunityUploadsPage, type CommunityUploadEntry } from "../lib/uploaded-replay-community";

// Every replay anyone has uploaded, newest first. The Upload tab shows the
// nine newest as a preview; this is the whole list behind it. Nothing here can
// be deleted - that stays on /replay/uploads, where ownership is checked.

export const Route = createFileRoute("/replay_/community")({
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: i18n._(msg`Community Replays`),
      description: i18n._(msg`Every osu!mania replay uploaded to Mania Hub, newest first. Open any of them in the replay watcher.`),
      path: "/replay/community",
      origin: match.context.origin,
      // Localized title, so the OG image key rides the English original.
      imageTitle: "Community Replays",
    });
  },
  component: CommunityReplaysPage,
});

// The same card shape the Upload tab's community list renders; viewedAt is
// repurposed as the upload time, which is what the card's "x ago" reads here.
function toRecentEntry(upload: CommunityUploadEntry, unknownBeatmap: string): RecentReplayEntry {
  return {
    key: recentReplayUploadKey(upload.id),
    uploadId: upload.id,
    beatmapsetId: upload.beatmap?.beatmapsetId ?? undefined,
    title: upload.beatmap?.title || upload.originalFilename || unknownBeatmap,
    artist: upload.beatmap?.artist || undefined,
    version: upload.beatmap?.version || undefined,
    keyCount: upload.keyCount,
    playerName: upload.playerName,
    coverUrl: upload.beatmap?.beatmapsetId
      ? `https://assets.ppy.sh/beatmaps/${upload.beatmap.beatmapsetId}/covers/list.jpg`
      : upload.communityBackground && upload.beatmapHash
        ? getCommunityBeatmapAssetUrl(upload.beatmapHash, "background")
        : undefined,
    grade: upload.grade,
    accuracy: upload.accuracy,
    mods: withModRate(upload.mods, upload.modRate),
    viewedAt: upload.uploadedAt,
    uploadedBy: upload.uploadedBy ?? undefined,
  };
}

function CommunityReplaysPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [entries, setEntries] = useState<RecentReplayEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback(async (nextPage: number, append: boolean) => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setFailed(false);
    try {
      const result = await getCommunityUploadsPage({ data: { page: nextPage } });
      if (requestRef.current !== requestId) return;
      const unknownBeatmap = t`Unknown beatmap`;
      const next = result.uploads.map((upload) => toRecentEntry(upload, unknownBeatmap));
      setEntries((previous) => {
        if (!append) return next;
        // A page boundary can shift while someone is paging (a new upload
        // lands at the top), so a card already shown is not shown twice.
        const seen = new Set(previous.map((entry) => entry.key));
        return [...previous, ...next.filter((entry) => !seen.has(entry.key))];
      });
      setTotal(result.total);
      setHasMore(result.hasMore);
      setPage(result.page);
    } catch {
      if (requestRef.current !== requestId) return;
      setFailed(true);
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(0, false);
  }, [load]);

  const handleOpen = useCallback((entry: RecentReplayEntry) => {
    if (!entry.uploadId) return;
    navigate({ to: "/replay", search: { uploadId: entry.uploadId } });
  }, [navigate]);

  return (
    <div className="flex-1">
      <PageHeader iconSrc="/images/icons/home.svg" title={t`Community Replays`} />
      <div className="bg-osu-b5 min-h-[80vh]">
        <div className="mx-auto max-w-[1200px] px-3 py-3 sm:px-5 sm:py-6">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <div className="mx-auto mb-4 flex max-w-5xl items-center gap-x-3">
              <Link
                to="/replay"
                search={{ tab: "upload" }}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-osu-f1 transition-colors hover:text-white"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                <Trans>Replays</Trans>
              </Link>
            </div>

            {failed && entries.length === 0 ? (
              <p className="py-12 text-center text-sm text-osu-f1">
                <Trans>Couldn't load the uploads; refresh to retry.</Trans>
              </p>
            ) : loading && entries.length === 0 ? (
              <div className="mx-auto max-w-5xl">
                <div className="mb-3 flex justify-center">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-osu-f1">
                    <Trans>Uploaded by the Community</Trans>
                  </h4>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {Array.from({ length: 12 }, (_, index) => (
                    <div key={index} className="h-[57px] animate-pulse rounded-xl border border-osu-b3/20 bg-osu-b4" />
                  ))}
                </div>
              </div>
            ) : entries.length === 0 ? (
              <p className="py-12 text-center text-sm text-osu-f1">
                <Trans>Nobody has uploaded a replay yet.</Trans>{" "}
                <Link
                  to="/replay"
                  search={{ tab: "upload" }}
                  className="font-semibold text-osu-pink-light transition-colors hover:text-white"
                >
                  <Trans>Upload a replay</Trans>
                </Link>
              </p>
            ) : (
              <ReplayRecentlyViewed
                entries={entries}
                title={total > 0 ? t`Uploaded by the Community (${total})` : t`Uploaded by the Community`}
                showRemove={false}
                onOpen={handleOpen}
                onRemove={() => {}}
                onClear={() => {}}
              />
            )}

            {hasMore && (
              <div className="mt-3 flex justify-center">
                <button
                  type="button"
                  onClick={() => void load(page + 1, true)}
                  disabled={loading}
                  className="rounded-lg bg-osu-b4 px-3 py-1.5 text-xs font-semibold text-osu-f1 transition-colors cursor-pointer hover:bg-osu-b3 hover:text-white disabled:opacity-40"
                >
                  {loading ? <Trans>Loading...</Trans> : <Trans>Show more</Trans>}
                </button>
              </div>
            )}
          </motion.div>
        </div>
      </div>
    </div>
  );
}
