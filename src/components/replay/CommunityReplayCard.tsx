import { memo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Play } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { avatarImageSrc } from "#/components/ui/Avatar";
import { GradeImg } from "#/components/ui/GradeImg";
import { ModBadge } from "#/components/ui/ModBadge";
import { StarRatingBadge } from "#/components/ui/StarRating";
import { getCommunityBeatmapAssetUrl } from "#/lib/community-beatmap-assets";
import { formatAccuracy, formatTimeAgo } from "#/lib/format";
import { useLocale } from "#/lib/locale-context";
import { withModRate } from "#/lib/score";
import type { CommunityUploadEntry } from "#/lib/uploaded-replay-payload";
import { ReplayCoverFallback } from "./ReplayCoverFallback";

export const CommunityReplayCard = memo(function CommunityReplayCard({ upload }: { upload: CommunityUploadEntry }) {
  const { t } = useLingui();
  const locale = useLocale();
  const [failedCover, setFailedCover] = useState<string | null>(null);
  const title = upload.beatmap?.title || upload.originalFilename || t`Unknown beatmap`;
  const uploader = upload.uploadedBy;
  const cover = upload.beatmap?.beatmapsetId
    ? `https://assets.ppy.sh/beatmaps/${upload.beatmap.beatmapsetId}/covers/cover.jpg`
    : upload.communityBackground && upload.beatmapHash ? getCommunityBeatmapAssetUrl(upload.beatmapHash, "background") : null;
  return (
    <Link
      to="/replay"
      search={{ uploadId: upload.id }}
      preload={false}
      className="group block min-w-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-osu-pink"
    >
      <div className="relative aspect-video overflow-hidden rounded-xl bg-gradient-to-br from-osu-b3 to-osu-b6">
        {cover && cover !== failedCover
          ? <img src={cover} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover transition-transform duration-200 group-hover:scale-105" onError={() => setFailedCover(cover)} />
          : <ReplayCoverFallback seed={upload.beatmapHash || upload.id} keyCount={upload.keyCount} playerName={upload.playerName} />}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/5" />
        <span className="absolute left-2.5 top-2.5 rounded-md bg-black/70 px-2 py-1 text-xs font-bold text-white">{upload.keyCount}K</span>
        {upload.beatmap?.starRating != null && (
          <span className="absolute right-2.5 top-2.5 flex" title={t`Beatmap difficulty (without mods)`}>
            <StarRatingBadge stars={upload.beatmap.starRating} size={1.2} />
          </span>
        )}
        <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <span className="rounded-full bg-black/65 p-3"><Play className="h-6 w-6 fill-white text-white" aria-hidden="true" /></span>
        </span>
        <div className="absolute inset-x-2.5 bottom-2.5 flex items-end justify-between gap-2">
          <div className="flex flex-wrap gap-1">
            {withModRate(upload.mods, upload.modRate).slice(0, 4).map((mod, index) => <ModBadge key={`${mod.acronym}-${index}`} mod={mod.acronym} rate={mod.rate} size={0.85} />)}
          </div>
          <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-black/75 px-2 py-1 text-xs font-bold text-white">
            <GradeImg grade={upload.grade} size={22} />{formatAccuracy(upload.accuracy)}
          </span>
        </div>
      </div>
      <div className="flex gap-2.5 px-0.5 pt-3">
        {uploader && <img src={avatarImageSrc(undefined, uploader.userId)} alt="" loading="lazy" decoding="async" className="mt-0.5 h-8 w-8 shrink-0 rounded-full bg-osu-b4" />}
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-2 text-sm font-bold leading-snug text-white group-hover:text-osu-pink-light">{title}</h2>
          {upload.beatmap && <p className="mt-1 truncate text-xs text-osu-f1" title={`${upload.beatmap.artist} · ${upload.beatmap.version}`}>{upload.beatmap.artist} · {upload.beatmap.version}</p>}
          <p className="mt-1.5 truncate text-xs font-semibold text-osu-l2">{upload.playerName}</p>
          <p className="mt-0.5 truncate text-[11px] text-osu-f1">
            {uploader && <><Trans>Uploaded by {uploader.username || String(uploader.userId)}</Trans><span aria-hidden="true"> · </span></>}
            {formatTimeAgo(new Date(upload.uploadedAt).toISOString(), locale)}
          </p>
        </div>
      </div>
    </Link>
  );
});
