import { Link } from "@tanstack/react-router";
import { Download } from "lucide-react";
import type { CSSProperties } from "react";
import { rememberSkinName, skinEventProperties } from "../../lib/analytics-skins";
import { track } from "../../lib/analytics";
import { formatTimeAgo } from "../../lib/format";
import { formatSkinFileSize, rememberSkinsBrowseEntry, skinDownloadUrl, type SkinSummary } from "../../lib/skins";
import { Avatar } from "../ui/Avatar";

const MAX_KEYMODE_TAGS = 3;
export const SKIN_FALLBACK_ACCENT = "#ff66ab";

export function SkinKeymodeTags({ keymodes, overlay = false, max = MAX_KEYMODE_TAGS }: { keymodes: number[]; overlay?: boolean; max?: number }) {
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
          {keys}K
        </span>
      ))}
      {rest > 0 && <span className={pill}>+{rest}</span>}
    </div>
  );
}

// onClick is for callers that render the card outside the browse grid (the
// upload modal's publish confirmation) and need to tear their own UI down as
// the navigation happens.
export function SkinCard({ skin, onClick }: { skin: SkinSummary; onClick?: () => void }) {
  const accent = skin.accentColor ?? SKIN_FALLBACK_ACCENT;
  const downloadUrl = skin.oskUrl ? skinDownloadUrl(skin.id) ?? skin.oskUrl : null;
  return (
    // The download sits outside the card link (an anchor cannot nest in
    // another), overlaid on the preview's corner, so a skin can be grabbed
    // straight from the grid without opening its page.
    <div className="group relative">
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
          {skin.previewUrl ? (
            <img
              src={skin.previewUrl}
              alt={`${skin.name} preview`}
              width={skin.previewWidth ?? 1280}
              height={skin.previewHeight ?? 720}
              loading="lazy"
              className="h-full w-full object-cover transition-[filter] duration-150 group-hover:brightness-110"
            />
          ) : null}
          <div className="absolute right-1.5 top-1.5">
            <SkinKeymodeTags keymodes={skin.keymodes} overlay />
          </div>
          {skin.status === "hidden" && (
            <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-extrabold uppercase leading-none tracking-wide text-white/80">
              hidden
            </span>
          )}
        </div>
        {/* Accent bar, colour sampled from the skin's own note art. */}
        <div className="h-[3px] w-full shrink-0" style={{ backgroundColor: accent }} aria-hidden="true" />
        <div className="flex flex-1 flex-col gap-1 px-2.5 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <div className="truncate text-[13px] font-bold leading-tight text-white">{skin.name}</div>
            {/* Spelled out rather than pilled behind an icon: the download
                button sits right above it, and two download glyphs an inch
                apart read as a mistake. */}
            <span className="shrink-0 text-[11px] text-osu-f1">
              <span className="tabular-nums">{skin.downloadCount.toLocaleString()}</span>
              {skin.downloadCount === 1 ? " download" : " downloads"}
            </span>
          </div>
          {/* Primary credit goes to whoever made the skin; the uploader (with
              avatar) only fronts the card when no author is known. */}
          <div className="flex items-center gap-1.5 text-[11px] text-osu-f1">
            {skin.author ? (
              <span className="truncate">
                by <span className="font-semibold text-osu-l2">{skin.author}</span>
              </span>
            ) : (
              <>
                <Avatar userId={skin.ownerUserId} size={14} shape="circle" />
                <span className="truncate font-semibold text-osu-l2">{skin.ownerUsername}</span>
              </>
            )}
            {skin.publishedAt && (
              <>
                <span aria-hidden="true">·</span>
                <span suppressHydrationWarning>{formatTimeAgo(skin.publishedAt)}</span>
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
