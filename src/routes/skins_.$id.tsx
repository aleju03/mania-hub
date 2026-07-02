import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { useState } from "react";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { PageHeader } from "../components/layout/PageHeader";
import { SkinKeymodeTags } from "../components/skins/SkinCard";
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
      path: `/skins/${skin.id}`,
      origin: match.context.origin,
      image: skin.previewUrl ?? undefined,
      noindex: true,
    });
  },
  component: SkinDetailPage,
});

function SkinDetailPage() {
  const skin = Route.useLoaderData() as SkinSummary | null;
  const auth = useAuth();
  const navigate = useNavigate();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(skin?.status === "hidden");
  const [actionError, setActionError] = useState<string | null>(null);

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

  const toggleHidden = async () => {
    if (!skin || busy) return;
    setBusy(true);
    setActionError(null);
    const result = await moderateSkin({ data: { id: skin.id, action: hidden ? "unhide" : "hide" } }).catch(() => ({ ok: false }));
    setBusy(false);
    if (result.ok) setHidden(!hidden);
    else setActionError("The moderation action failed.");
  };

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col overflow-clip bg-osu-b5">
        <OsuTriangleBackdrop />
        <div className="relative z-10 flex flex-1 flex-col">
          <PageHeader
            iconSrc="/images/icons/skins.svg"
            title={
              <Link to="/skins" search={{}} className="transition-colors hover:text-white">
                Skins
              </Link>
            }
          />

          <div className="mx-auto w-full max-w-[1000px] flex-1 px-4 py-6 sm:px-5">
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
              <>
                <div className="overflow-hidden rounded-2xl border border-osu-b3/40 bg-osu-b4">
                  {skin.previewUrl && (
                    <img
                      src={skin.previewUrl}
                      alt={`${skin.name} preview`}
                      width={skin.previewWidth ?? 1280}
                      height={skin.previewHeight ?? 720}
                      className="aspect-video w-full object-cover"
                    />
                  )}
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-4 sm:px-5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h1 className="text-[18px] font-bold leading-tight text-white">{skin.name}</h1>
                        <SkinKeymodeTags keymodes={skin.keymodes} />
                        {hidden && (
                          <span className="rounded bg-osu-b5 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-osu-f1">
                            hidden
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-osu-f1">
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
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">
                          {skin.downloadCount.toLocaleString()} {skin.downloadCount === 1 ? "download" : "downloads"}
                        </span>
                      </div>
                      {skin.description && (
                        <p className="mt-2.5 max-w-[640px] whitespace-pre-line text-[13px] leading-relaxed text-osu-l2">
                          {skin.description}
                        </p>
                      )}
                    </div>
                    {skin.oskUrl && (
                      <a
                        href={skinDownloadUrl(skin.id) ?? skin.oskUrl}
                        className="inline-flex shrink-0 items-center gap-2 rounded-full bg-osu-pink px-5 py-2 text-[13px] font-bold text-white transition hover:brightness-110"
                      >
                        <Download className="h-4 w-4" aria-hidden="true" />
                        Download .osk
                        {skin.oskSizeBytes ? (
                          <span className="font-semibold text-white/75 tabular-nums">{formatSkinFileSize(skin.oskSizeBytes)}</span>
                        ) : null}
                      </a>
                    )}
                  </div>
                </div>

                {skin.screenshots.length > 0 && (
                  <div className="mt-5">
                    <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">Screenshots</div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {skin.screenshots.map((shot, index) => (
                        <a
                          key={shot.url}
                          href={shot.url}
                          target="_blank"
                          rel="noreferrer"
                          className="group overflow-hidden rounded-lg border border-osu-b3/40 bg-osu-b4"
                        >
                          <img
                            src={shot.url}
                            alt={`${skin.name} screenshot ${index + 1}`}
                            width={shot.width ?? 1920}
                            height={shot.height ?? 1080}
                            loading="lazy"
                            className="aspect-video w-full object-cover transition-opacity group-hover:opacity-85"
                          />
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {(isOwner || auth.isAdmin) && (
                  <div className="mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-osu-b3/30 bg-osu-b4 px-4 py-3">
                    <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
                      {auth.isAdmin && !isOwner ? "Moderation" : "Your skin"}
                    </span>
                    {auth.isAdmin && (
                      <button
                        type="button"
                        onClick={() => void toggleHidden()}
                        disabled={busy}
                        className="rounded-md bg-osu-b5 px-3 py-1.5 text-[12px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:bg-osu-b3 hover:text-osu-l1 disabled:opacity-50"
                      >
                        {hidden ? "Unhide" : "Hide from browsing"}
                      </button>
                    )}
                    {confirmingDelete ? (
                      <span className="flex items-center gap-2 text-[12px]">
                        <span className="text-osu-f1">Delete this skin and its files for good?</span>
                        <button
                          type="button"
                          onClick={() => void removeSkin()}
                          disabled={busy}
                          className="rounded-md bg-osu-red/20 px-3 py-1.5 font-bold text-osu-red-light transition-colors cursor-pointer hover:bg-osu-red/30 disabled:opacity-50"
                        >
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
                        className="rounded-md bg-osu-b5 px-3 py-1.5 text-[12px] font-semibold text-osu-red-light transition-colors cursor-pointer hover:bg-osu-red/20 disabled:opacity-50"
                      >
                        Delete skin
                      </button>
                    )}
                    {actionError && <span className="text-[12px] font-semibold text-osu-red-light">{actionError}</span>}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
