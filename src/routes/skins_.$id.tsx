import { createFileRoute, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, Check, Download, Lock, MonitorPlay, Settings } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ManiaRain } from "../components/home/ManiaRain";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { PageHeader } from "../components/layout/PageHeader";
import { SKIN_FALLBACK_ACCENT, SkinKeymodeTags } from "../components/skins/SkinCard";
import { SkinAssetExplorer } from "../components/skins/SkinAssetExplorer";
import { SkinPreviewEditorModal } from "../components/skins/SkinPreviewEditorModal";
import { SkinSettingsModal } from "../components/skins/SkinSettingsModal";
import { SkinUpdateModal } from "../components/skins/SkinUpdateModal";
import { Avatar } from "../components/ui/Avatar";
import { useAuth } from "../lib/auth-context";
import { formatTimeAgo } from "../lib/format";
import { skinEventProperties } from "../lib/analytics-skins";
import { track } from "../lib/analytics";
import {
  dehydrateReplaySkinSettings,
  fetchMyReplaySkinCached,
  setMyReplaySkin,
  writeMyReplaySkinMemory,
} from "../lib/replay-owner-skin";
import { importReplaySkinFromOsk } from "../lib/replay-skin-import";
import { canModerateSkinKeymodes, fetchSkinById, formatKeymodes, formatSkinFileSize, keymodeLabel, readSkinsBrowseEntry, skinDownloadUrl, skinOskFileUrl, type SkinSummary } from "../lib/skins";
import { pageSeo } from "../lib/seo";

export const Route = createFileRoute("/skins_/$id")({
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
        imageKind: "skins",
        noindex: true,
      });
    }
    return pageSeo({
      title: skin.name,
      description: skin.description?.replace(/\s+/g, " ").slice(0, 160)
        || `${skin.name}, an osu!mania skin for ${formatKeymodes(skin.keymodes, skin.specialKeymodes) || "mania"} uploaded by ${skin.ownerUsername}. Download the .osk or browse more skins.`,
      path: `/skins/${skin.slug ?? skin.id}`,
      origin: match.context.origin,
      // A private skin only ever renders for its uploader, so the page must not
      // be indexed and its art must not travel in an embed card.
      noindex: skin.visibility === "private",
      // Skins without a rendered preview fall back to the falling-notes card.
      // The preview renders 16:9, not the 1.91:1 of the generated cards, so its
      // real size travels with it or scrapers crop the embed.
      // The preview of a private skin is behind a capability URL no scraper
      // holds, so it would render as a broken card anyway.
      image: (skin.visibility === "private" ? null : skin.previewUrl) ?? undefined,
      imageWidth: skin.previewWidth,
      imageHeight: skin.previewHeight,
      imageKind: "skins",
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
  const loaded = Route.useLoaderData() as SkinSummary | null;
  // Editing the previews hands back the updated skin; holding it locally shows
  // the new cover and renders right away, without waiting out the browser
  // cache on /api/skins/get.
  const [edited, setEdited] = useState<SkinSummary | null>(null);
  const skin = edited?.id === loaded?.id ? edited ?? loaded : loaded;
  const params = Route.useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const historyIndex = useRouterState({ select: (state) => state.location.state.__TSR_index });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingPreviews, setEditingPreviews] = useState(false);
  const [updatingFile, setUpdatingFile] = useState(false);

  // Stepping back keeps the browse page's filters, page and scroll; only a skin
  // reached from somewhere else takes the plain /skins route.
  const goBackToBrowse = () => {
    const browseEntry = readSkinsBrowseEntry();
    if (browseEntry != null && browseEntry === historyIndex - 1 && typeof window !== "undefined" && window.history.length > 1) {
      window.history.back();
      return;
    }
    void navigate({ to: "/skins", search: {} });
  };

  // Canonicalize pre-slug links: a skin opened via its raw id gets its URL
  // swapped for the slug without a reload.
  useEffect(() => {
    if (skin?.slug && params.id !== skin.slug) {
      void navigate({ to: "/skins/$id", params: { id: skin.slug }, replace: true });
    }
  }, [skin?.slug, params.id, navigate]);
  // "Use for my replays": idle -> working (download + import + save) -> set.
  const [replaySkinStatus, setReplaySkinStatus] = useState<"idle" | "working" | "set">("idle");
  const [replaySkinError, setReplaySkinError] = useState<string | null>(null);

  // Whether THIS skin is already the viewer's replay skin, fetched after
  // mount so the page never blocks on it; the button starts in its idle
  // state and flips to "yours" once the answer lands.
  const viewerId = auth.viewer?.id ?? null;
  const skinId = skin?.id ?? null;
  const skinStatus = skin?.status ?? null;
  useEffect(() => {
    if (!viewerId || !skinId || skinStatus !== "published") return;
    let cancelled = false;
    void fetchMyReplaySkinCached(viewerId)
      .then((record) => {
        if (!cancelled) setReplaySkinStatus(record?.skin.id === skinId ? "set" : "idle");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [viewerId, skinId, skinStatus]);

  const setAsMyReplaySkin = async () => {
    if (!skin || !viewerId || replaySkinStatus !== "idle") return;
    // The streaming endpoint is CORS-safe and does not count as a download.
    const oskFileUrl = skinOskFileUrl(skin);
    if (!oskFileUrl) return;
    setReplaySkinStatus("working");
    setReplaySkinError(null);
    try {
      const response = await fetch(oskFileUrl);
      if (!response.ok) throw new Error("osk_fetch_failed");
      const blob = await response.blob();
      const result = await importReplaySkinFromOsk(new File([blob], `${skin.name}.osk`), {
        targetKeyCount: skin.keymodes[0] ?? 4,
      });
      const payload = dehydrateReplaySkinSettings(result.settings);
      const outcome = await setMyReplaySkin({ data: { skinId: skin.id, settingsJson: JSON.stringify(payload) } });
      if (!outcome.ok) {
        setReplaySkinStatus("idle");
        setReplaySkinError(
          outcome.error === "not_logged_in"
            ? "Sign in to set a replay skin."
            : outcome.error === "payload_too_large"
              ? "This skin's settings are too large to store."
              : "Setting the replay skin failed. Try again.",
        );
        return;
      }
      writeMyReplaySkinMemory(viewerId, {
        skin,
        settings: payload,
        updatedAt: new Date().toISOString(),
        private: skin.visibility === "private",
      });
      setReplaySkinStatus("set");
    } catch {
      setReplaySkinStatus("idle");
      setReplaySkinError("Setting the replay skin failed. Try again.");
    }
  };

  // Gallery: one playfield preview per keymode, then uploader screenshots.
  // Older uploads only have the single cover preview.
  const gallery = useMemo<GalleryItem[]>(() => {
    if (!skin) return [];
    const previews: GalleryItem[] = skin.previews.length > 0
      ? skin.previews.map((preview) => ({ url: preview.url, width: preview.width, height: preview.height, label: keymodeLabel(preview.keys, skin.specialKeymodes) }))
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
  const isPrivate = skin?.visibility === "private";
  // The keymode-moderator grant: the settings entry point opens for them on
  // anyone's public skin, and the modal shows only the keymode labels.
  const isKeymodeModerator = skin != null && !isOwner && !auth.isAdmin
    && canModerateSkinKeymodes(auth.viewer?.id)
    && skin.visibility === "public"
    && skin.keymodes.some((keys) => keys >= 2);

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
            right={
              <button
                type="button"
                onClick={goBackToBrowse}
                className="inline-flex items-center gap-1.5 rounded-lg bg-osu-b4 px-2.5 py-1.5 text-[11px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:bg-osu-b3 hover:text-white"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                <span>back to skins</span>
              </button>
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
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
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
                    // Thumbnails share the column evenly instead of stopping
                    // short of it: a fixed width left a stub of dead space at
                    // the end of the row, against the full-width hero above and
                    // the .osk strip below. auto-fit drops the tracks nothing
                    // sits in, so the row fills whatever the gallery holds. The
                    // width cap is for the two or three preview case, where a
                    // track would otherwise run a third of the column wide: it
                    // holds tiles to 160px and centres the short row.
                    // (The track max has to stay 1fr. A definite one - 160px,
                    // say - is what auto-fit counts columns with, which lays
                    // five previews out three-then-two.)
                    <div
                      className="mx-auto mt-3 grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-2"
                      style={{ maxWidth: gallery.length * 160 + (gallery.length - 1) * 8 }}
                    >
                      {gallery.map((item, index) => (
                        <button
                          key={item.url}
                          type="button"
                          onClick={() => setHeroIndex(index)}
                          aria-pressed={index === heroIndex}
                          aria-label={`Show ${item.label}`}
                          className={`w-full overflow-hidden rounded-lg border text-left transition-colors duration-100 cursor-pointer ${
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
                  <SkinAssetExplorer skin={skin} />
                </div>

                <div className="flex min-w-0 flex-col gap-4">
                  <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 px-4 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      {/* Skin names run long and often carry no spaces, so the
                          heading breaks mid-word rather than spilling out of
                          the 320px column. */}
                      <h1 className="min-w-0 max-w-full break-words text-[18px] font-bold leading-tight text-white [overflow-wrap:anywhere]">
                        {skin.name}
                      </h1>
                      {skin.status === "hidden" && (
                        <span className="rounded bg-osu-b5 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-osu-f1">
                          hidden
                        </span>
                      )}
                      {isPrivate && (
                        <span className="inline-flex items-center gap-1 rounded bg-osu-b5 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-osu-f1">
                          <Lock className="h-2.5 w-2.5" aria-hidden="true" />
                          private
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-osu-f1">
                      {skin.author && (
                        <>
                          <span>
                            by <span className="font-semibold text-osu-l2">{skin.author}</span>
                          </span>
                          <span aria-hidden="true">·</span>
                        </>
                      )}
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
                        href={(isPrivate ? null : skinDownloadUrl(skin.id)) ?? skin.oskUrl}
                        onClick={() => track("skin_download", skinEventProperties(skin))}
                        className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-osu-pink px-5 py-2 text-[13px] font-bold text-white transition hover:brightness-110"
                      >
                        <Download className="h-4 w-4" aria-hidden="true" />
                        Download .osk
                        {skin.oskSizeBytes ? (
                          <span className="font-semibold text-white/75 tabular-nums">{formatSkinFileSize(skin.oskSizeBytes)}</span>
                        ) : null}
                      </a>
                    )}
                    {auth.viewer && skin.status === "published" && skin.oskUrl && (
                      <div className="mt-2">
                        {replaySkinStatus === "set" ? (
                          <>
                            <div className="flex w-full items-center justify-center gap-2 rounded-full border border-osu-pink/45 bg-osu-pink/10 px-5 py-2 text-[13px] font-bold text-osu-pink-light">
                              <Check className="h-4 w-4" aria-hidden="true" />
                              Your replay skin
                            </div>
                            <p className="mt-1.5 text-center text-[11px] text-osu-f1">
                              Anyone watching your replays sees it.{" "}
                              <Link to="/settings" className="font-semibold text-osu-l2 transition-colors hover:text-white">
                                customize it in settings
                              </Link>
                            </p>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void setAsMyReplaySkin()}
                            disabled={replaySkinStatus === "working"}
                            title="Play this skin in your own replays for everyone who watches them"
                            className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-osu-b3/50 px-5 py-2 text-[13px] font-bold text-osu-l2 transition-colors cursor-pointer hover:border-osu-pink/45 hover:text-white disabled:opacity-50"
                          >
                            <MonitorPlay className="h-4 w-4" aria-hidden="true" />
                            {replaySkinStatus === "working" ? "Setting up…" : "Use for my replays"}
                          </button>
                        )}
                        {replaySkinError && (
                          <p className="mt-1.5 text-center text-[12px] font-semibold text-osu-red-light">{replaySkinError}</p>
                        )}
                      </div>
                    )}
                  </div>

                  <dl className="rounded-xl border border-osu-b3/20 bg-osu-b4 px-4 py-1 text-[12.5px]">
                    <FactRow label="Keymodes">
                      <SkinKeymodeTags keymodes={skin.keymodes} specialKeymodes={skin.specialKeymodes} max={10} />
                    </FactRow>
                    {isPrivate ? (
                      <FactRow label="Visible to">
                        <span className="text-osu-l1">only you</span>
                      </FactRow>
                    ) : (
                      <FactRow label="Downloads">
                        <span className="tabular-nums text-osu-l1">{skin.downloadCount.toLocaleString()}</span>
                      </FactRow>
                    )}
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
                    {/* Only there once the uploader has shipped a newer build
                        of the file; a rename or a preview edit is not that. */}
                    {skin.oskUpdatedAt && (
                      <FactRow label="File updated">
                        <span className="tabular-nums text-osu-l1" suppressHydrationWarning>
                          {new Date(skin.oskUpdatedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                        </span>
                      </FactRow>
                    )}
                  </dl>

                  {(isOwner || auth.isAdmin || isKeymodeModerator) && (
                    <>
                      {/* One entry point for everything owner-side; the modal
                          holds name, keymodes, visibility, file, previews and
                          delete, so the sidebar stays one button. A keymode
                          moderator gets the same button, but their modal is
                          just the keymode labels. */}
                      <button
                        type="button"
                        onClick={() => setSettingsOpen(true)}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-osu-b3/50 px-5 py-2 text-[13px] font-bold text-osu-l2 transition-colors cursor-pointer hover:border-osu-pink/45 hover:text-white"
                      >
                        <Settings className="h-4 w-4" aria-hidden="true" />
                        {isOwner ? "Skin settings" : auth.isAdmin ? "Moderate skin" : "Fix keymodes"}
                      </button>
                      <SkinSettingsModal
                        skin={skin}
                        open={settingsOpen}
                        onClose={() => setSettingsOpen(false)}
                        onSaved={setEdited}
                        onDeleted={() => {
                          setSettingsOpen(false);
                          void navigate({ to: "/skins", search: {} });
                        }}
                        onUpdateFile={() => {
                          setSettingsOpen(false);
                          setUpdatingFile(true);
                        }}
                        onEditPreviews={() => {
                          setSettingsOpen(false);
                          setEditingPreviews(true);
                        }}
                      />
                      <SkinPreviewEditorModal
                        skin={skin}
                        open={editingPreviews}
                        onClose={() => setEditingPreviews(false)}
                        onSaved={setEdited}
                      />
                      <SkinUpdateModal
                        skin={skin}
                        open={updatingFile}
                        onClose={() => setUpdatingFile(false)}
                        onUpdated={(next) => {
                          setEdited(next);
                          setHeroIndex(0);
                        }}
                      />
                    </>
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
