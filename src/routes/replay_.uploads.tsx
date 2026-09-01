import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { ArrowLeft, Trash2 } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";

import { getI18n } from "../lib/i18n";
import { PageHeader } from "../components/layout/PageHeader";
import { avatarImageSrc } from "../components/ui/Avatar";
import { GradeImg } from "../components/ui/GradeImg";
import { ModBadge } from "../components/ui/ModBadge";
import { useAuth } from "../lib/auth-context";
import { formatAccuracy, formatTimeAgo } from "../lib/format";
import { useLocale } from "../lib/locale-context";
import { withModRate } from "../lib/score";
import { getCommunityBeatmapAssetUrl } from "../lib/community-beatmap-assets";
import { pageSeo } from "../lib/seo";
import {
  backfillUploadedReplayOwners,
  deleteUploadedReplay,
  fetchMyUploadedReplays,
  type MyUploadedReplay,
} from "../lib/uploaded-replays";

// Everything the signed-in viewer has uploaded, with the delete beside each
// row. Uploads are otherwise unlisted - a share link is the only way back to
// one - so this page is where someone finds an old upload again and the only
// place they can take one down. An admin gets the same page over every
// uploader's files, with the uploader named on each row.

export const Route = createFileRoute("/replay_/uploads")({
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: i18n._(msg`Your Replay Uploads`),
      description: i18n._(msg`The replays you have uploaded to Mania Hub, with their share links and deletes.`),
      path: "/replay/uploads",
      origin: match.context.origin,
      // Localized title, so the OG image key rides the English original.
      imageTitle: "Your Replay Uploads",
      // Per-viewer content; there is nothing here for a crawler.
      noindex: true,
    });
  },
  component: ReplayUploadsPage,
});

function ReplayUploadsPage() {
  const { t } = useLingui();
  const auth = useAuth();
  const navigate = useNavigate();
  const isAdmin = auth.canUseAdminFeatures;
  const canSee = Boolean(auth.viewer) || isAdmin;

  const [allOwners, setAllOwners] = useState(false);
  const [uploads, setUploads] = useState<MyUploadedReplay[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  // The id being deleted, so only that row's button waits.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async (nextPage: number, owners: boolean, append: boolean) => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setNotice(null);
    try {
      const result = await fetchMyUploadedReplays({ data: { page: nextPage, allOwners: owners } });
      if (requestRef.current !== requestId) return;
      setUploads((previous) => (append ? [...previous, ...result.uploads] : result.uploads));
      setTotal(result.total);
      setHasMore(result.hasMore);
      setPage(result.page);
    } catch {
      if (requestRef.current !== requestId) return;
      setNotice(t`Couldn't load the uploads; refresh to retry.`);
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canSee) {
      setLoading(false);
      return;
    }
    void load(0, allOwners, false);
  }, [allOwners, canSee, load]);

  const handleOpen = useCallback((upload: MyUploadedReplay) => {
    navigate({ to: "/replay", search: { uploadId: upload.id } });
  }, [navigate]);

  const handleDelete = useCallback(async (upload: MyUploadedReplay) => {
    if (busyId) return;
    if (!window.confirm(t`Delete this upload? Its share link stops working and the file is gone for good.`)) return;
    setBusyId(upload.id);
    setNotice(null);
    try {
      const result = await deleteUploadedReplay({ data: { id: upload.id } });
      if (!result.ok) {
        setNotice(result.error === "not_found"
          ? t`That upload is already gone.`
          : t`Couldn't delete that upload; try again.`);
        return;
      }
      setUploads((previous) => previous.filter((item) => item.id !== upload.id));
      setTotal((previous) => Math.max(0, previous - 1));
    } catch {
      setNotice(t`Couldn't delete that upload; try again.`);
    } finally {
      setBusyId(null);
    }
  }, [busyId]);

  const handleBackfill = useCallback(async () => {
    if (backfilling) return;
    setBackfilling(true);
    setNotice(null);
    try {
      const result = await backfillUploadedReplayOwners();
      setNotice(`Indexed ${result.indexed} of ${result.scanned} uploads (${result.unowned} with no uploader, ${result.failed} failed).`);
      await load(0, allOwners, false);
    } catch {
      setNotice("Backfill failed.");
    } finally {
      setBackfilling(false);
    }
  }, [allOwners, backfilling, load]);

  // "All uploads" is admin-only and stays English, like the rest of the
  // admin-gated controls on this page.
  const title = allOwners ? "All uploads" : t`Your uploads`;

  return (
    <div className="flex-1">
      <PageHeader iconSrc="/images/icons/home.svg" title={t`Replay Uploads`} />
      <div className="bg-osu-b5 min-h-[80vh]">
        <div className="mx-auto max-w-[1200px] px-3 py-3 sm:px-5 sm:py-6">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto max-w-3xl">
            <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
              <Link
                to="/replay"
                search={{ tab: "upload" }}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-osu-f1 transition-colors hover:text-white"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                <Trans>Replays</Trans>
              </Link>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-osu-f1">
                {title}{total > 0 ? ` (${total})` : ""}
              </h3>
              {isAdmin && (
                <div className="ml-auto flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setUploads([]);
                      setTotal(0);
                      setAllOwners((previous) => !previous);
                    }}
                    className="rounded-lg px-2 py-1 text-[11px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:bg-osu-b4 hover:text-white"
                  >
                    {allOwners ? "Only yours" : "Everyone's"}
                  </button>
                  {allOwners && (
                    <button
                      type="button"
                      onClick={handleBackfill}
                      disabled={backfilling}
                      className="rounded-lg px-2 py-1 text-[11px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:bg-osu-b4 hover:text-white disabled:opacity-40"
                    >
                      {backfilling ? "Backfilling..." : "Backfill owners"}
                    </button>
                  )}
                </div>
              )}
            </div>

            {notice && (
              <p className="mb-3 text-center text-xs text-osu-f1">{notice}</p>
            )}

            {!canSee ? (
              <p className="py-12 text-center text-sm text-osu-f1">
                <Trans>Sign in with osu! to see your uploads.</Trans>
              </p>
            ) : loading && uploads.length === 0 ? (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 4 }, (_, index) => (
                  <div key={index} className="h-[57px] animate-pulse rounded-xl border border-osu-b3/20 bg-osu-b4" />
                ))}
              </div>
            ) : uploads.length === 0 ? (
              <p className="py-12 text-center text-sm text-osu-f1">
                {allOwners ? "Nobody has uploaded a replay yet." : t`Nothing uploaded yet.`}{" "}
                <Link
                  to="/replay"
                  search={{ tab: "upload" }}
                  className="font-semibold text-osu-pink-light transition-colors hover:text-white"
                >
                  <Trans>Upload a replay</Trans>
                </Link>
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {uploads.map((upload) => (
                  <UploadRow
                    key={upload.id}
                    upload={upload}
                    showUploader={allOwners}
                    busy={busyId === upload.id}
                    onOpen={() => handleOpen(upload)}
                    onDelete={() => void handleDelete(upload)}
                  />
                ))}
              </div>
            )}

            {hasMore && (
              <div className="mt-3 flex justify-center">
                <button
                  type="button"
                  onClick={() => void load(page + 1, allOwners, true)}
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

function UploadRow({
  upload,
  showUploader,
  busy,
  onOpen,
  onDelete,
}: {
  upload: MyUploadedReplay;
  showUploader: boolean;
  busy: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { t } = useLingui();
  const locale = useLocale();
  const description = upload.description;
  const coverUrl = description?.beatmap?.beatmapsetId
    ? `https://assets.ppy.sh/beatmaps/${description.beatmap.beatmapsetId}/covers/list.jpg`
    : upload.communityBackground && description?.beatmapHash
      ? getCommunityBeatmapAssetUrl(description.beatmapHash, "background")
      : null;
  // "[Insane] 7K // player", with whatever parts the description has; a row
  // whose file is gone still renders (and deletes) from the index row alone.
  const chart = description
    ? [description.beatmap?.version ? `[${description.beatmap.version}]` : null, description.keyCount ? `${description.keyCount}K` : null]
      .filter(Boolean)
      .join(" ")
    : "";
  const rowTitle = description?.beatmap?.title || upload.originalFilename || t`Upload`;
  const subtitle = description
    ? `${chart ? `${chart} // ` : ""}${description.playerName}`
    : t`File missing`;
  const mods = description ? withModRate(description.mods, description.modRate) : [];

  return (
    <div className="group relative overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
      {coverUrl && (
        <img src={coverUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-[0.12]" loading="lazy" />
      )}
      <button
        type="button"
        onClick={onOpen}
        className="relative flex w-full items-center gap-2.5 py-2.5 pl-3 pr-12 text-left transition-colors cursor-pointer hover:bg-osu-b3/50 focus:outline-none focus-visible:bg-osu-b3/50"
      >
        {description?.grade ? (
          <GradeImg grade={description.grade} size={22} />
        ) : (
          <span className="rounded bg-osu-b5/70 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-osu-f1">
            osr
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-white">{rowTitle}</div>
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-[10px] text-osu-f1">{subtitle}</div>
            {mods.length > 0 && (
              <div className="hidden shrink-0 gap-0.5 sm:flex">
                {mods.map((mod, modIndex) => (
                  <ModBadge key={`${mod.acronym}-${modIndex}`} mod={mod.acronym} rate={mod.rate} size={0.7} />
                ))}
              </div>
            )}
          </div>
        </div>
        {showUploader && (
          // Who uploaded it - rarely the player in the replay.
          <span className="flex shrink-0 items-center gap-1.5">
            <img
              src={avatarImageSrc(undefined, upload.ownerUserId)}
              alt=""
              className="h-5 w-5 rounded-full"
              loading="lazy"
            />
            <span className="hidden max-w-32 truncate text-xs font-semibold text-white sm:inline">
              {upload.ownerUsername || `user ${upload.ownerUserId}`}
            </span>
          </span>
        )}
        <div className="shrink-0 text-right">
          {description != null && (
            <div className="text-[11px] font-semibold text-osu-l2">{formatAccuracy(description.accuracy)}</div>
          )}
          <div className="text-[10px] text-osu-f1">{formatTimeAgo(new Date(upload.uploadedAt).toISOString(), locale)}</div>
        </div>
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        aria-label={t`Delete ${rowTitle} from your uploads`}
        title={t`Delete this upload`}
        className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-osu-f1 transition-colors cursor-pointer hover:bg-osu-red/20 hover:text-osu-red-light disabled:cursor-wait disabled:opacity-40"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
