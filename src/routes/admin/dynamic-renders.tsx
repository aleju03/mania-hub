import { createFileRoute, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { ConfirmModal } from "../../components/ui/ConfirmModal";
import { Skeleton } from "../../components/ui/LoadingSkeleton";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import {
  clearSignatureImages,
  fetchSignatureAdminList,
  fetchSignatureImagePreviews,
  setSignatureBlocked,
  type SignatureAdminRow,
} from "../../lib/signature";

/* Moderation for dynamic renders. An admin action of its own rather than a
   section bolted onto /dynamic-renders: that page is where a player builds
   their own signature, and reviewing everyone else's is a different job for a
   different person.
 *
 * The thing being moderated is the background image url, because that is the
 * only part of a signature a player can point at arbitrary content. Two
 * actions, since the proportionate response is usually the smaller one: drop
 * the picture and leave the signature working, or block the whole thing.
 *
 * Blocking is deliberately not a reuse of the player's own on/off switch - they
 * can flip that back. A blocked row stops resolving, so every image already
 * pasted into an osu! profile 404s, and only an admin can undo it.
 */

export const Route = createFileRoute("/admin/dynamic-renders")({
  head: () => ({
    meta: [
      { title: "Dynamic renders - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: DynamicRendersAdminPage,
});

function formatDay(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

/* The pictures, small, alongside the row that can remove them. Judging a
   background by reading its url is guesswork; opening each one in a tab hands
   the host a moderator's IP and an audience.
 *
 * These are fetched and re-encoded server side, so what lands here is bytes
 * this server already decoded rather than a live request to somewhere else,
 * and a url that no longer resolves shows as a gap instead of a broken image.
 * Per row rather than in the list response: most rows have no picture, and one
 * unreachable host must not hold up the whole page. */
function RowThumbnails({ userId, count }: { userId: number; count: number }) {
  const [previews, setPreviews] = useState<Array<{ url: string; dataUrl: string | null }> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPreviews(null);
    void fetchSignatureImagePreviews({ data: { userId } })
      .then((result) => { if (!cancelled) setPreviews(result.previews); })
      .catch(() => { if (!cancelled) setPreviews([]); });
    return () => { cancelled = true; };
  }, [userId]);

  if (!previews) {
    return (
      <div className="flex gap-1.5">
        {Array.from({ length: count }, (_, index) => (
          <Skeleton key={index} className="h-[36px] w-[64px] rounded" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {previews.map((preview) => (
        <a
          key={preview.url}
          href={preview.url}
          target="_blank"
          rel="noreferrer noopener"
          title={preview.url}
          className="block"
        >
          {preview.dataUrl ? (
            <img
              src={preview.dataUrl}
              alt=""
              className="h-[36px] w-[64px] rounded border border-osu-b3/40 object-cover"
            />
          ) : (
            <span className="flex h-[36px] w-[64px] items-center justify-center rounded border border-osu-b3/40 bg-osu-b4/50 text-[9px] text-osu-f1">
              no image
            </span>
          )}
        </a>
      ))}
    </div>
  );
}

function DynamicRendersAdminPage() {
  const [rows, setRows] = useState<SignatureAdminRow[] | null>(null);
  const [customOnly, setCustomOnly] = useState(true);
  const [busy, setBusy] = useState(0);
  const [blockAsk, setBlockAsk] = useState<SignatureAdminRow | null>(null);

  const load = useCallback(async (only: boolean) => {
    try {
      const result = await fetchSignatureAdminList({ data: { customOnly: only } });
      setRows(result.signatures);
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => { void load(customOnly); }, [customOnly, load]);

  const act = useCallback(async (userId: number, run: () => Promise<{ ok: boolean }>) => {
    setBusy(userId);
    try {
      await run();
      await load(customOnly);
    } finally {
      setBusy(0);
    }
  }, [customOnly, load]);

  const withImages = rows?.filter((row) => row.customImageUrls.length > 0).length ?? 0;

  return (
    <div className="flex-1">
      <div className="bg-osu-d5 border-b border-osu-b3/40">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-3 flex items-center gap-3">
          <div className="relative flex-shrink-0">
            <span className="block w-2.5 h-2.5 rounded-full bg-osu-yellow" />
            {rows === null || busy ? (
              <span className="absolute inset-0 rounded-full bg-osu-yellow animate-ping opacity-75" />
            ) : null}
          </div>
          <h2 className="text-[13px] sm:text-[15px] font-medium text-osu-c2">Dynamic renders</h2>
          <div className="ml-auto flex items-center gap-3 text-[11px] text-osu-f1">
            {rows ? <span>{rows.length} shown, {withImages} with an image</span> : null}
            <button
              onClick={() => void load(customOnly)}
              disabled={busy > 0}
              className="px-2.5 py-1 rounded-md bg-osu-b4/60 border border-osu-b3/30 text-osu-l2 hover:bg-osu-b3/60 hover:text-white transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="bg-osu-b5 min-h-[calc(100vh-60px)]">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-5 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {([["With an image URL", true], ["All signatures", false]] as const).map(([label, value]) => (
              <button
                key={label}
                onClick={() => setCustomOnly(value)}
                className={`px-2.5 py-1 rounded-md border text-[12px] transition-colors duration-[120ms] cursor-pointer ${
                  customOnly === value
                    ? "border-osu-pink/50 bg-osu-pink/15 text-osu-pink-light"
                    : "border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:bg-osu-b3/60 hover:text-white"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {rows === null ? (
            <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 divide-y divide-osu-b3/20">
              {Array.from({ length: 5 }, (_, index) => (
                <div key={index} className="flex items-center gap-3 px-3 py-2.5">
                  <Skeleton className="h-[17px] w-[110px] rounded" />
                  <Skeleton className="h-[13px] w-[180px]" />
                  <Skeleton className="ml-auto h-[22px] w-[120px] rounded-md" />
                </div>
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 px-3 py-6 text-center text-[12px] text-osu-f1">
              {customOnly ? "Nobody is using a custom image." : "Nobody has set one up yet."}
            </div>
          ) : (
            <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 overflow-hidden divide-y divide-osu-b3/20">
              {rows.map((row) => (
                <div key={row.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
                  <a
                    href={`https://osu.ppy.sh/users/${row.userId}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-[13px] font-medium text-white hover:text-osu-pink-light"
                  >
                    {row.username || row.userId}
                  </a>
                  <span className="text-[11px] text-osu-f1">{row.enabledTypes.join(", ") || "none"}</span>
                  <span className="text-[11px] text-osu-f1">{formatDay(row.updatedAt)}</span>
                  {row.blockedAt ? (
                    <span className="text-[11px] font-medium text-osu-red-light">blocked</span>
                  ) : !row.enabled ? (
                    <span className="text-[11px] text-osu-f1">off</span>
                  ) : null}
                  {/* Clearing a picture is silent and reversible by the player,
                      so a repeat offender is only obvious if the count says so. */}
                  {row.clearedCount > 0 ? (
                    <span className="text-[11px] font-medium text-osu-yellow">cleared {row.clearedCount}x</span>
                  ) : null}

                  {/* The picture itself, and its address under it - the host
                      is often the thing that decides whether a link is worth
                      looking at twice. Each thumbnail still opens the source. */}
                  {row.customImageUrls.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <RowThumbnails userId={row.userId} count={row.customImageUrls.length} />
                      <div className="flex flex-col gap-0.5">
                        {row.customImageUrls.map((url) => (
                          <a
                            key={url}
                            href={url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="max-w-[380px] truncate text-[11px] text-osu-l2 underline decoration-osu-b3 hover:text-white"
                          >
                            {url}
                          </a>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="ml-auto flex flex-shrink-0 items-center gap-2">
                    {row.customImageUrls.length > 0 ? (
                      <button
                        disabled={busy === row.userId}
                        onClick={() => void act(row.userId, () => clearSignatureImages({ data: { userId: row.userId } }))}
                        className="px-2.5 py-1 rounded-md bg-osu-b4/60 border border-osu-b3/30 text-[11px] text-osu-l2 hover:bg-osu-b3/60 hover:text-white transition-colors duration-[120ms] disabled:opacity-50 cursor-pointer"
                      >
                        Clear image
                      </button>
                    ) : null}
                    <button
                      disabled={busy === row.userId}
                      onClick={() => {
                        // Unblocking restores what the player had, so only the
                        // switch that breaks their images asks first.
                        if (row.blockedAt) {
                          void act(row.userId, () => setSignatureBlocked({ data: { userId: row.userId, blocked: false } }));
                          return;
                        }
                        setBlockAsk(row);
                      }}
                      className={`px-2.5 py-1 rounded-md border text-[11px] transition-colors duration-[120ms] disabled:opacity-50 cursor-pointer ${
                        row.blockedAt
                          ? "border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:bg-osu-b3/60 hover:text-white"
                          : "border-osu-red/40 bg-osu-red/10 text-osu-red-light hover:bg-osu-red/20"
                      }`}
                    >
                      {row.blockedAt ? "Unblock" : "Block"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {blockAsk ? (
        <ConfirmModal
          title={`Block ${blockAsk.username || blockAsk.userId}'s renders?`}
          body="Every image they have already pasted stops loading, and they cannot turn it back on."
          confirmLabel="Block"
          danger
          onConfirm={() => void act(blockAsk.userId, () => setSignatureBlocked({
            data: { userId: blockAsk.userId, blocked: true },
          }))}
          onClose={() => setBlockAsk(null)}
        />
      ) : null}
    </div>
  );
}
