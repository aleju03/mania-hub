import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { ExternalLink, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { BBCodePreview } from "../../components/player/bbcode/BBCodePreview";
import { ConfirmModal } from "../../components/ui/ConfirmModal";
import { Skeleton } from "../../components/ui/LoadingSkeleton";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { formatTimeAgo } from "../../lib/format";
import {
  clearSavedAboutPage,
  deleteSavedAboutImage,
  listSavedAboutPages,
  type SavedAboutImage,
  type SavedAboutPage,
} from "../../lib/own-about-admin";

/* About pages restricted players saved on their profile (own-about.ts). They
 * show to everyone with no review first, so this lists each one with every
 * image it shows. Clear page removes the page; the player can write a new
 * one. Delete file removes an image we host (bbcode/ in the public bucket)
 * from the bucket and Cloudflare's cache, even if other pages embed it. */

export const Route = createFileRoute("/admin/about-pages")({
  head: () => ({
    meta: [
      { title: "About pages - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: AboutPagesAdminPage,
});

const BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-default cursor-pointer";
const ACTION_CLASS = `${BUTTON_CLASS} border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:bg-osu-b3/60 hover:text-white`;
const DANGER_CLASS = `${BUTTON_CLASS} border-osu-red/40 bg-osu-red/10 text-osu-red-light hover:bg-osu-red/20`;

const STATUS_LABEL: Record<NonNullable<SavedAboutPage["accountStatus"]>, string> = {
  restricted: "restricted",
  missing: "missing",
  wiped: "wiped",
};

type Ask =
  | { kind: "clear"; page: SavedAboutPage }
  | { kind: "delete"; image: SavedAboutImage };

function hostOf(src: string): string {
  try {
    return new URL(src).hostname.replace(/^www\./, "");
  } catch {
    return src;
  }
}

function AboutPagesAdminPage() {
  const [pages, setPages] = useState<SavedAboutPage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setPages(await listSavedAboutPages());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPages((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      setMessage(await action());
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const imageCount = pages?.reduce((sum, page) => sum + page.images.length, 0) ?? 0;

  return (
    <div className="flex-1">
      <div className="bg-osu-d5 border-b border-osu-b3/40">
        <div className="max-w-[1000px] mx-auto px-4 sm:px-5 py-3 flex items-center gap-3">
          <h2 className="text-[13px] sm:text-[15px] font-medium text-osu-c2">About pages</h2>
          {pages ? (
            <span className="text-[11px] text-osu-f1">
              {pages.length} {pages.length === 1 ? "page" : "pages"}, {imageCount} {imageCount === 1 ? "image" : "images"}
            </span>
          ) : null}
          <button onClick={() => void refresh()} className={`${ACTION_CLASS} ml-auto`} aria-label="Refresh">
            <RefreshCw size={13} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      <div className="bg-osu-b5 min-h-[calc(100vh-60px)]">
        <div className="max-w-[1000px] mx-auto px-3 sm:px-5 py-4 sm:py-5 space-y-3">
          {error ? <Notice text={error} tone="error" onDismiss={() => setError(null)} /> : null}
          {message ? <Notice text={message} onDismiss={() => setMessage(null)} /> : null}

          {pages === null ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="flex items-center gap-3">
                  <Skeleton className="h-9 w-9 rounded-full" />
                  <Skeleton className="h-[15px] w-[220px] max-w-[60%] rounded" />
                </div>
              ))}
            </div>
          ) : pages.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-osu-f1">Nobody has saved an About page.</div>
          ) : (
            <div className="divide-y divide-white/[0.07]">
              {pages.map((page) => (
                <section key={page.userId} className="py-4 first:pt-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    {page.avatarUrl ? (
                      <img src={page.avatarUrl} alt="" className="h-9 w-9 rounded-full object-cover" />
                    ) : (
                      <span className="h-9 w-9 rounded-full bg-osu-b4" />
                    )}
                    <div className="min-w-0">
                      <Link
                        to="/player/$username/about"
                        params={{ username: page.username }}
                        className="text-[14px] font-semibold text-osu-c1 hover:text-white"
                      >
                        {page.username}
                      </Link>
                      <div className="text-[11px] text-osu-f1">
                        {page.accountStatus ? STATUS_LABEL[page.accountStatus] : "active on osu!"}
                        {" · saved "}
                        <span title={page.updatedAt}>{formatTimeAgo(page.updatedAt)}</span>
                      </div>
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                      <button onClick={() => setOpenId((current) => current === page.userId ? null : page.userId)} className={ACTION_CLASS}>
                        {openId === page.userId ? "Hide page" : "View page"}
                      </button>
                      <button disabled={busy} onClick={() => setAsk({ kind: "clear", page })} className={DANGER_CLASS}>
                        Clear page
                      </button>
                    </div>
                  </div>

                  {page.images.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-3">
                      {page.images.map((image) => (
                        <figure key={image.src} className="w-[168px]">
                          <a href={image.src} target="_blank" rel="noopener noreferrer nofollow" title={image.src} className="block">
                            <img
                              src={image.src}
                              alt=""
                              loading="lazy"
                              className="h-[112px] w-full rounded-md bg-osu-b4 object-cover transition hover:brightness-110"
                            />
                          </a>
                          <figcaption className="mt-1 flex items-center gap-1.5 text-[11px] text-osu-f1">
                            <span className="min-w-0 flex-1 truncate">{image.key ? "hosted here" : hostOf(image.src)}</span>
                            <a href={image.src} target="_blank" rel="noopener noreferrer nofollow" aria-label="Open image" className="hover:text-white">
                              <ExternalLink size={12} />
                            </a>
                            {image.key ? (
                              <button
                                disabled={busy}
                                onClick={() => setAsk({ kind: "delete", image })}
                                aria-label="Delete file"
                                title="Delete file"
                                className="cursor-pointer text-osu-red-light hover:text-white disabled:opacity-50"
                              >
                                <Trash2 size={12} />
                              </button>
                            ) : null}
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-2 text-[11px] text-osu-f1">No images</div>
                  )}

                  {openId === page.userId ? (
                    <div className="bbcode-content mt-3 max-h-[520px] overflow-y-auto border-t border-white/[0.07] pt-3 text-sm text-osu-l2">
                      <BBCodePreview source={page.raw} />
                    </div>
                  ) : null}
                </section>
              ))}
            </div>
          )}
        </div>
      </div>

      {ask?.kind === "clear" ? (
        <ConfirmModal
          title={`Clear ${ask.page.username}'s About page?`}
          body="Their profile goes back to the page osu! last served. They can save a new one."
          confirmLabel="Clear page"
          danger
          onConfirm={() => {
            const page = ask.page;
            setAsk(null);
            void run(async () => {
              await clearSavedAboutPage({ data: { userId: page.userId } });
              return `Cleared ${page.username}'s About page.`;
            });
          }}
          onClose={() => setAsk(null)}
        />
      ) : ask?.kind === "delete" ? (
        <ConfirmModal
          title="Delete this image file?"
          body="It is removed from our bucket and every page that embeds it, here or on osu!, shows a broken image. This cannot be undone."
          confirmLabel="Delete file"
          danger
          onConfirm={() => {
            const image = ask.image;
            setAsk(null);
            void run(async () => {
              const { purged } = await deleteSavedAboutImage({ data: { key: image.key } });
              return purged ? "Deleted the file and cleared it from Cloudflare's cache." : "Deleted the file. Cloudflare's cache was not purged, so it can linger there until it expires.";
            });
          }}
          onClose={() => setAsk(null)}
        />
      ) : null}
    </div>
  );
}

function Notice({ text, tone, onDismiss }: { text: string; tone?: "error"; onDismiss: () => void }) {
  return (
    <div className={`flex items-start gap-2 text-[12px] ${tone === "error" ? "text-osu-red-light" : "text-osu-l2"}`}>
      <p className="min-w-0 flex-1 pt-0.5">{text}</p>
      <button onClick={onDismiss} aria-label="Dismiss" className="grid h-6 w-6 flex-shrink-0 cursor-pointer place-items-center rounded text-osu-f1 hover:bg-osu-b4/60 hover:text-white">
        <X size={13} />
      </button>
    </div>
  );
}
