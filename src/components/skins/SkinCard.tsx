import { Link } from "@tanstack/react-router";
import { Download, Eye, Lock } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { rememberSkinName, skinEventProperties } from "../../lib/analytics-skins";
import { track } from "../../lib/analytics";
import { formatCompactCount, formatTimeAgo } from "../../lib/format";
import { formatSkinFileSize, keymodeLabel, pingSkinView, rememberSkinsBrowseEntry, skinDownloadUrl, type SkinSummary } from "../../lib/skins";
import { Avatar } from "../ui/Avatar";

const MAX_KEYMODE_TAGS = 3;
export const SKIN_FALLBACK_ACCENT = "#ff66ab";

// A view can be earned from the grid, not just by opening the page: a hover
// that settles on a card is somebody looking at the skin in the sense the
// counter measures. (A download straight off the grid counts one too, but the
// backend does that itself - every counted download moves the view count.)
// The dwell filters the sweep of a mouse crossing the grid on its way
// somewhere else; the set spares repeat requests for a card re-rendered by
// filtering (what actually counts is the backend's 6h-per-IP dedup either
// way). Touch has no hover and its tap fires pointerenter on the way to a
// click, so touch is ignored here: the tap either opens the page, which
// counts there, or hits the download button, which the backend counts.
export const HOVER_VIEW_DWELL_MS = 400;
const pingedViewRefs = new Set<string>();

export function SkinKeymodeTags({ keymodes, specialKeymodes, overlay = false, max = MAX_KEYMODE_TAGS }: { keymodes: number[]; specialKeymodes?: number[]; overlay?: boolean; max?: number }) {
  const shown = keymodes.slice(0, max);
  const rest = keymodes.length - shown.length;
  const pill = overlay
    ? "rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-bold text-white/90 tabular-nums"
    : "rounded bg-osu-b5/80 px-1.5 py-0.5 text-[10px] font-bold text-osu-l2 tabular-nums";
  return (
    // Wraps and stays right-aligned: a 1K-to-10K skin lists ten pills, which
    // overflowed the fact row on the skin page. The overlay use sits in an
    // absolutely positioned corner with three pills, so it never wraps.
    <div className={`flex items-center gap-1 ${overlay ? "shrink-0" : "flex-wrap justify-end gap-y-1"}`}>
      {shown.map((keys) => (
        <span key={keys} className={pill}>
          {keymodeLabel(keys, specialKeymodes)}
        </span>
      ))}
      {rest > 0 && <span className={pill}>+{rest}</span>}
    </div>
  );
}

// Previews are lazy-loaded and land one at a time well after the markup around
// them: fading them in stops the grid from snapping. Mount the img with a key
// on its url so swapping which preview is shown starts the fade over. The ref
// check is for an already-decoded image (a back-navigation, a re-render): its
// load event fires before React attaches onLoad, so without it the preview
// would sit at zero opacity forever.
export function SkinPreviewImage({
  src,
  alt,
  width,
  height,
  className,
  loading = "lazy",
}: { src: string; alt: string; width?: number; height?: number; className: string; loading?: "lazy" | "eager" }) {
  const [loaded, setLoaded] = useState(false);
  const markLoaded = useCallback((node: HTMLImageElement | null) => {
    if (node?.complete) setLoaded(true);
  }, []);
  return (
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      loading={loading}
      ref={markLoaded}
      onLoad={() => setLoaded(true)}
      className={`${className} transition-[opacity,filter] duration-150 ${loaded ? "opacity-100" : "opacity-0"}`}
    />
  );
}

// onClick is for callers that render the card outside the browse grid (the
// upload modal's publish confirmation) and need to tear their own UI down as
// the navigation happens.
// previewKeys is the browse grid's keymode filter: with it set the card fronts
// that keymode's own render when the skin has one, so filtering 4K shows every
// skin's 4K playfield even where a 7K render was chosen as the cover.
// showUploader is for the admin private shelf, which mixes every uploader's
// skins and would otherwise give no way to tell whose is whose.
export function SkinCard({ skin, previewKeys, showUploader = false, onClick }: { skin: SkinSummary; previewKeys?: number; showUploader?: boolean; onClick?: () => void }) {
  const accent = skin.accentColor ?? SKIN_FALLBACK_ACCENT;
  const isPrivate = skin.visibility === "private";
  const keymodePreview = previewKeys != null ? skin.previews.find((preview) => preview.keys === previewKeys) : undefined;
  const preview = keymodePreview
    ? { url: keymodePreview.url, width: keymodePreview.width, height: keymodePreview.height }
    : { url: skin.previewUrl, width: skin.previewWidth, height: skin.previewHeight };
  // A private skin has no counted download, and a card for one only reaches its
  // owner or a moderating admin: the corner button links straight at the
  // capability URL on that copy of the summary.
  const downloadUrl = !skin.oskUrl ? null : isPrivate ? skin.oskUrl : skinDownloadUrl(skin.id) ?? skin.oskUrl;
  const downloadCount = skin.downloadCount ?? 0;
  // Absent on a summary cached before views existed, which reads as zero until
  // the list refetches rather than rendering a hole in the row.
  const viewCount = skin.viewCount ?? 0;
  // Only a published public skin has a public number to move, same predicate
  // as the skin page's own ping; the backend refuses anything else anyway.
  const viewRef = skin.slug ?? skin.id;
  const viewCountable = skin.status === "published" && !isPrivate;
  const hoverViewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingView = useCallback(() => {
    if (!viewCountable || pingedViewRefs.has(viewRef)) return;
    pingedViewRefs.add(viewRef);
    pingSkinView(viewRef);
  }, [viewCountable, viewRef]);
  const cancelHoverView = useCallback(() => {
    if (hoverViewTimer.current != null) {
      clearTimeout(hoverViewTimer.current);
      hoverViewTimer.current = null;
    }
  }, []);
  useEffect(() => cancelHoverView, [cancelHoverView]);
  return (
    // The download sits outside the card link (an anchor cannot nest in
    // another), overlaid on the preview's corner, so a skin can be grabbed
    // straight from the grid without opening its page.
    <div
      className="group relative"
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        cancelHoverView();
        hoverViewTimer.current = setTimeout(pingView, HOVER_VIEW_DWELL_MS);
      }}
      onPointerLeave={cancelHoverView}
    >
      <Link
        to="/skins/$id"
        params={{ id: skin.slug ?? skin.id }}
        onClick={() => {
          // The detail pageview only sees a slug, so the card hands the real
          // name forward for the activity feed.
          rememberSkinName(skin.slug ?? skin.id, skin.name);
          // Lets the skin page's back button return to this exact browse state.
          rememberSkinsBrowseEntry();
          onClick?.();
        }}
        style={{ "--skin-accent": accent } as CSSProperties}
        className="flex h-full flex-col overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4 transition-[border-color,box-shadow] group-hover:border-(--skin-accent) group-hover:shadow-[0_0_18px_-8px_var(--skin-accent)]"
      >
        <div className="relative aspect-video w-full bg-osu-b5">
          {preview.url ? (
            <SkinPreviewImage
              key={preview.url}
              src={preview.url}
              alt={`${skin.name} preview`}
              width={preview.width ?? 1280}
              height={preview.height ?? 720}
              className="h-full w-full object-cover group-hover:brightness-110"
            />
          ) : null}
          <div className="absolute right-1.5 top-1.5">
            <SkinKeymodeTags keymodes={skin.keymodes} specialKeymodes={skin.specialKeymodes} overlay />
          </div>
          {(skin.status === "hidden" || isPrivate) && (
            <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-extrabold uppercase leading-none tracking-wide text-white/80">
              {isPrivate && <Lock className="h-2.5 w-2.5" aria-hidden="true" />}
              {isPrivate ? "private" : "hidden"}
            </span>
          )}
        </div>
        {/* Accent bar, colour sampled from the skin's own note art. */}
        <div className="h-[3px] w-full shrink-0" style={{ backgroundColor: accent }} aria-hidden="true" />
        <div className="flex flex-1 flex-col gap-1 px-2.5 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <div className="truncate text-[13px] font-bold leading-tight text-white">{skin.name}</div>
            {/* Two counts where one spelled-out figure used to sit, so both
                give up their words. The download glyph here is a statistic and
                the one over the preview is the button that does something;
                they read as a pair rather than a mistake because they are in
                different blocks of the card, and neither number is ever the
                only thing saying what it is - the label lives on the group, and
                the page itself spells both out. */}
            <span
              className="shrink-0 text-[11px] text-osu-f1"
              aria-label={isPrivate ? undefined : `${downloadCount.toLocaleString()} downloads, ${viewCount.toLocaleString()} views`}
            >
              {isPrivate ? (
                "only you"
              ) : (
                <span className="inline-flex items-center gap-2" aria-hidden="true">
                  <span className="inline-flex items-center gap-1" title={`${downloadCount.toLocaleString()} downloads`}>
                    <Download className="h-3 w-3" />
                    <span className="tabular-nums">{formatCompactCount(downloadCount)}</span>
                  </span>
                  <span className="inline-flex items-center gap-1" title={`${viewCount.toLocaleString()} views`}>
                    <Eye className="h-3 w-3" />
                    <span className="tabular-nums">{formatCompactCount(viewCount)}</span>
                  </span>
                </span>
              )}
            </span>
          </div>
          {/* Credit is for whoever made the skin. With no author on file the
              line just drops it: standing the uploader in that spot read as a
              claim they drew it, and the skin's page says "uploaded by" in
              full. showUploader is the moderation shelf, where an admin is
              looking at every uploader's skins at once and needs to tell them
              apart; it is labelled there, never bare. */}
          <div className="flex items-center gap-1.5 text-[11px] text-osu-f1">
            {skin.author ? (
              <span className="truncate">
                by <span className="font-semibold text-osu-l2">{skin.author}</span>
              </span>
            ) : showUploader ? (
              <>
                <Avatar userId={skin.ownerUserId} size={14} shape="circle" />
                <span className="truncate">
                  uploaded by <span className="font-semibold text-osu-l2">{skin.ownerUsername}</span>
                </span>
              </>
            ) : null}
            {skin.publishedAt && (
              <>
                {(skin.author || showUploader) && <span aria-hidden="true">·</span>}
                <span className="shrink-0" suppressHydrationWarning>{formatTimeAgo(skin.publishedAt)}</span>
              </>
            )}
            {skin.oskSizeBytes ? (
              <span className="ml-auto shrink-0 tabular-nums">{formatSkinFileSize(skin.oskSizeBytes)}</span>
            ) : null}
          </div>
        </div>
      </Link>
      {downloadUrl && (
        // Pinned to the preview box, which is the card's leading aspect-video
        // block. Always there on touch, where there is no hover to reveal it.
        <div className="pointer-events-none absolute inset-x-0 top-0 aspect-video">
          <a
            href={downloadUrl}
            onClick={() => track("skin_download", skinEventProperties(skin))}
            title={`Download the .osk${skin.oskSizeBytes ? `, ${formatSkinFileSize(skin.oskSizeBytes)}` : ""}`}
            aria-label={`Download ${skin.name}`}
            className="pointer-events-auto absolute bottom-1.5 right-1.5 grid h-8 w-8 place-items-center rounded-full bg-black/70 text-white opacity-100 backdrop-blur-[2px] transition-[opacity,background-color] hover:bg-osu-pink sm:opacity-0 sm:group-hover:opacity-100"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
          </a>
        </div>
      )}
    </div>
  );
}
