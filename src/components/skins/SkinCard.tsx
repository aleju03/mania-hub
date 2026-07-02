import { Link } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { formatTimeAgo } from "../../lib/format";
import type { SkinSummary } from "../../lib/skins";

const MAX_KEYMODE_TAGS = 3;
const FALLBACK_ACCENT = "#ff66ab";

export function SkinKeymodeTags({ keymodes, overlay = false }: { keymodes: number[]; overlay?: boolean }) {
  const shown = keymodes.slice(0, MAX_KEYMODE_TAGS);
  const rest = keymodes.length - shown.length;
  const pill = overlay
    ? "rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-bold text-white/90 tabular-nums"
    : "rounded bg-osu-b5/80 px-1.5 py-0.5 text-[10px] font-bold text-osu-l2 tabular-nums";
  return (
    <div className="flex shrink-0 items-center gap-1">
      {shown.map((keys) => (
        <span key={keys} className={pill}>
          {keys}K
        </span>
      ))}
      {rest > 0 && <span className={pill}>+{rest}</span>}
    </div>
  );
}

export function SkinCard({ skin }: { skin: SkinSummary }) {
  const accent = skin.accentColor ?? FALLBACK_ACCENT;
  return (
    <Link
      to="/skins/$id"
      params={{ id: skin.id }}
      className="group relative block overflow-hidden rounded-xl border border-osu-b3/40 bg-osu-b4"
    >
      {/* Accent-tinted hover border, colour taken from the skin's own notes. */}
      <div
        className="pointer-events-none absolute inset-0 z-10 rounded-xl border-2 opacity-0 transition-opacity duration-100 group-hover:opacity-100"
        style={{ borderColor: accent }}
        aria-hidden="true"
      />
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
        <div className="absolute right-2 top-2">
          <SkinKeymodeTags keymodes={skin.keymodes} overlay />
        </div>
        {skin.status === "hidden" && (
          <span className="absolute left-2 top-2 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white/80">
            hidden
          </span>
        )}
      </div>
      <div className="h-[3px] w-full" style={{ backgroundColor: accent }} aria-hidden="true" />
      <div className="px-3 py-2.5">
        <div className="truncate text-[13.5px] font-bold leading-tight text-white">{skin.name}</div>
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-osu-f1">
          <Download className="h-3 w-3" aria-hidden="true" />
          <span className="tabular-nums">{skin.downloadCount.toLocaleString()}</span>
          {skin.publishedAt && (
            <>
              <span aria-hidden="true">·</span>
              <span suppressHydrationWarning>{formatTimeAgo(skin.publishedAt)}</span>
            </>
          )}
        </div>
      </div>
    </Link>
  );
}
