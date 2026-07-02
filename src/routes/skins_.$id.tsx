import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";
import { Download, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ManiaRain } from "../components/home/ManiaRain";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { PageHeader } from "../components/layout/PageHeader";
import { SKIN_FALLBACK_ACCENT, SkinKeymodeTags } from "../components/skins/SkinCard";
import { Avatar } from "../components/ui/Avatar";
import { useAuth } from "../lib/auth-context";
import { canUseDevFeatures } from "../lib/auth-shared";
import { formatTimeAgo } from "../lib/format";
import { deleteMySkin, fetchSkinById, formatKeymodes, formatSkinFileSize, moderateSkin, skinDownloadUrl, type SkinSummary } from "../lib/skins";
import { pageSeo } from "../lib/seo";

export const Route = createFileRoute("/skins_/$id")({
  // Dev-gated while unfinished, same as /skins.
  beforeLoad: ({ context }) => {
    if (!canUseDevFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  loader: async ({ params }) => {
    try {
      return await fetchSkinById({ data: { id: params.id } });
    } catch {
      return null;
    }
  },
  head: ({ match }) => {
    const skin = match.loaderData as SkinSummary | null | undefined;
    if (!skin) {
      return pageSeo({
        title: "Skin",
        description: "osu!mania skins on Mania Hub.",
        path: `/skins/${match.params.id}`,
        origin: match.context.origin,
        noindex: true,
      });
    }
    return pageSeo({
      title: skin.name,
      description: skin.description?.replace(/\s+/g, " ").slice(0, 160)
        || `${skin.name}, an osu!mania skin for ${formatKeymodes(skin.keymodes) || "mania"} uploaded by ${skin.ownerUsername}. Download the .osk or browse more skins.`,
      path: `/skins/${skin.slug ?? skin.id}`,
      origin: match.context.origin,
      image: skin.previewUrl ?? undefined,
      noindex: true,
    });
  },
  component: SkinDetailPage,
});

interface GalleryItem {
  url: string;
  width: number | null;
  height: number | null;
  label: string;
}

function SkinDetailPage() {
  const skin = Route.useLoaderData() as SkinSummary | null;
  const params = Route.useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Canonicalize pre-slug links: a skin opened via its raw id gets its URL
  // swapped for the slug without a reload.
  useEffect(() => {
    if (skin?.slug && params.id !== skin.slug) {
      void navigate({ to: "/skins/$id", params: { id: skin.slug }, replace: true });
    }
  }, [skin?.slug, params.id, navigate]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Gallery: one playfield preview per keymode, then uploader screenshots.
  // Older uploads only have the single cover preview.
  const gallery = useMemo<GalleryItem[]>(() => {
    if (!skin) return [];
    const previews: GalleryItem[] = skin.previews.length > 0
      ? skin.previews.map((preview) => ({ url: preview.url, width: preview.width, height: preview.height, label: `${preview.keys}K` }))
      : skin.previewUrl
        ? [{ url: skin.previewUrl, width: skin.previewWidth, height: skin.previewHeight, label: "Preview" }]
        : [];
    const screenshots: GalleryItem[] = skin.screenshots.map((shot, index) => ({
      url: shot.url,
      width: shot.width,
      height: shot.height,
      label: `Shot ${index + 1}`,
    }));
    return [...previews, ...screenshots];
  }, [skin]);
  const [heroIndex, setHeroIndex] = useState(() => {
    const coverIndex = skin?.previewUrl ? gallery.findIndex((item) => item.url === skin.previewUrl) : -1;
    return coverIndex >= 0 ? coverIndex : 0;
  });
  const hero = gallery[Math.min(heroIndex, Math.max(0, gallery.length - 1))];

  const isOwner = skin != null && auth.viewer?.id === skin.ownerUserId;

  const removeSkin = async () => {
    if (!skin || busy) return;
    setBusy(true);
    setActionError(null);
    const result = isOwner && !auth.isAdmin
      ? await deleteMySkin({ data: { id: skin.id } })
      : await moderateSkin({ data: { id: skin.id, action: "delete" } }).catch(() => ({ ok: false }));
    setBusy(false);
    if (result.ok) {
      void navigate({ to: "/skins", search: {} });
    } else {
      setActionError("The delete failed. Try again.");
      setConfirmingDelete(false);
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col overflow-clip bg-osu-b5">
        <OsuTriangleBackdrop />
        {/* Same falling notes as /skins so the two pages read as one surface. */}
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <ManiaRain />
        </div>
        <div className="relative z-10 flex flex-1 flex-col">
          <PageHeader
            iconSrc="/images/icons/skins.svg"
            title={
              <Link to="/skins" search={{}} className="transition-colors hover:text-white">
                osu!mania skins
              </Link>
            }
          />

          <div className="mx-auto w-full max-w-[1100px] flex-1 px-4 py-6 sm:px-5">
            {!skin ? (
              <div className="mx-auto max-w-md px-4 py-20 text-center">
                <div className="text-sm font-bold text-white">This skin is not available.</div>
                <p className="mt-2 text-[12px] text-osu-f1">It may have been removed by its uploader.</p>
                <Link
                  to="/skins"
                  search={{}}
                  className="mt-4 inline-block rounded-full bg-osu-pink px-5 py-1.5 text-[12.5px] font-bold text-white transition hover:brightness-110"
                >
                  Browse skins
                </Link>
              </div>
            ) : (
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
                <div className="min-w-0">
                  <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
                    {hero ? (
                      <img
                        src={hero.url}
                        alt={`${skin.name} ${hero.label}`}
                        width={hero.width ?? 1280}
                        height={hero.height ?? 720}
                        className="aspect-video w-full object-cover"
                      />
                    ) : (
                      <div className="flex aspect-video w-full items-center justify-center text-[12px] text-osu-f1">
                        No preview available.
                      </div>
                    )}
                    {/* Accent bar, same note-art colour the browse card carries. */}
                    <div
                      className="h-[3px] w-full"
                      style={{ backgroundColor: skin.accentColor ?? SKIN_FALLBACK_ACCENT }}
                      aria-hidden="true"
                    />
                  </div>
                  {gallery.length > 1 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {gallery.map((item, index) => (
                        <button
                          key={item.url}
                          type="button"
                          onClick={() => setHeroIndex(index)}
                          aria-pressed={index === heroIndex}
                          aria-label={`Show ${item.label}`}
                          className={`w-[108px] overflow-hidden rounded-lg border text-left transition-colors duration-100 cursor-pointer ${
                            index === heroIndex ? "border-osu-pink" : "border-osu-b3/40 hover:border-osu-f1/40"
                          }`}
                        >
                          <img
                            src={item.url}
                            alt={item.label}
                            loading="lazy"
                            className="aspect-video w-full object-cover"
                          />
                          <div className={`px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums ${
                            index === heroIndex ? "bg-osu-pink text-white" : "bg-osu-b4 text-osu-l2"
                          }`}>
                            {item.label}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex min-w-0 flex-col gap-4">
                  <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 px-4 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <h1 className="text-[18px] font-bold leading-tight text-white">{skin.name}</h1>
                      {skin.status === "hidden" && (
                        <span className="rounded bg-osu-b5 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-osu-f1">
                          hidden
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-osu-f1">
                      <span>uploaded by</span>
                      <Link
                        to="/player/$username"
                        params={{ username: skin.ownerUsername }}
                        className="inline-flex items-center gap-1.5 font-semibold text-osu-l2 transition-colors hover:text-white"
                      >
                        <Avatar userId={skin.ownerUserId} size={16} shape="circle" />
                        {skin.ownerUsername}
                      </Link>
                      {skin.publishedAt && (
                        <span suppressHydrationWarning>{formatTimeAgo(skin.publishedAt)}</span>
                      )}
                    </div>
                    {skin.description && (
                      <p className="mt-3 whitespace-pre-line text-[13px] leading-relaxed text-osu-l2">
                        {skin.description}
                      </p>
                    )}
                    {skin.oskUrl && (
                      <a
                        href={skinDownloadUrl(skin.id) ?? skin.oskUrl}
                        className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-osu-pink px-5 py-2 text-[13px] font-bold text-white transition hover:brightness-110"
                      >
                        <Download className="h-4 w-4" aria-hidden="true" />
                        Download .osk
                        {skin.oskSizeBytes ? (
                          <span className="font-semibold text-white/75 tabular-nums">{formatSkinFileSize(skin.oskSizeBytes)}</span>
                        ) : null}
                      </a>
                    )}
                  </div>

                  <dl className="rounded-xl border border-osu-b3/20 bg-osu-b4 px-4 py-1 text-[12.5px]">
                    <FactRow label="Keymodes">
                      <SkinKeymodeTags keymodes={skin.keymodes} max={10} />
                    </FactRow>
                    <FactRow label="Downloads">
                      <span className="tabular-nums text-osu-l1">{skin.downloadCount.toLocaleString()}</span>
                    </FactRow>
                    {skin.oskSizeBytes ? (
                      <FactRow label="File size">
                        <span className="tabular-nums text-osu-l1">{formatSkinFileSize(skin.oskSizeBytes)}</span>
                      </FactRow>
                    ) : null}
                    {skin.publishedAt && (
                      <FactRow label="Uploaded">
                        <span className="tabular-nums text-osu-l1" suppressHydrationWarning>
                          {new Date(skin.publishedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                        </span>
                      </FactRow>
                    )}
                  </dl>

                  {(isOwner || auth.isAdmin) && (
                    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-osu-b3/20 bg-osu-b4 px-4 py-3">
                      <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
                        {auth.isAdmin && !isOwner ? "Moderation" : "Your skin"}
                      </span>
                      {confirmingDelete ? (
                        <span className="ml-auto flex items-center gap-2 text-[12px]">
                          <span className="text-osu-f1">Delete for good?</span>
                          <button
                            type="button"
                            onClick={() => void removeSkin()}
                            disabled={busy}
                            className="inline-flex items-center gap-1.5 rounded-full bg-osu-red/25 px-3 py-1.5 font-bold text-osu-red-light transition-colors cursor-pointer hover:bg-osu-red/40 disabled:opacity-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmingDelete(false)}
                            disabled={busy}
                            className="font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-osu-l1"
                          >
                            Keep it
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmingDelete(true)}
                          disabled={busy}
                          className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-osu-red/35 px-3 py-1.5 text-[12px] font-semibold text-osu-red-light transition-colors cursor-pointer hover:bg-osu-red/20 disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          Delete skin
                        </button>
                      )}
                      {actionError && <span className="text-[12px] font-semibold text-osu-red-light">{actionError}</span>}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function FactRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-osu-b3/25 py-2.5 last:border-b-0">
      <dt className="shrink-0 text-osu-f1">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
