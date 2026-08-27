import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Heart, Loader2, Pencil, Share2, Trash2 } from "lucide-react";
import { useAuth } from "../../lib/auth-context";
import { formatNumber, formatTimeAgo } from "../../lib/format";
import { useLocale } from "../../lib/locale-context";
import { avatarImageSrc } from "../ui/Avatar";
import { MapDetailModal } from "./MapDetailModal";
import { MapPreviewPlayerBar, useMapPreviewAudio } from "./MapPreviewAudio";
import { SearchCard, toPreviewTrack } from "./SearchCard";
import { UserCollectionEditor } from "./UserCollectionEditor";
import { useHoldToConfirm } from "../../lib/use-hold-to-confirm";
import type { LiveMapSearchEntry } from "../../lib/live-backend";
import {
  collectionPath,
  deleteMapCollection,
  favouriteMapCollection,
  fetchUserMapCollection,
  groupCollectionItemsBySet,
  userCollectionKeyLabel,
  type UserMapCollectionDetail as CollectionDetail,
} from "../../lib/user-map-collections";

/* One posted collection on its own page (/collections/<slug>). Loaded on the
   server so the link a player shares carries a real title, blurb and card
   image, and re-read here after an edit. */

function ShareCollectionButton({ path }: { path: string }) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);

  const share = async () => {
    const url = typeof window === "undefined" ? path : new URL(path, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const Icon = copied ? Check : Share2;
  return (
    <button
      type="button"
      onClick={share}
      className="inline-flex items-center gap-1.5 rounded-lg bg-osu-pink/20 px-3 py-1.5 text-[12px] font-semibold text-osu-pink-light transition-colors cursor-pointer hover:bg-osu-pink/30 hover:text-white"
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {copied ? t`Copied` : t`Share`}
    </button>
  );
}

function FavouriteButton({
  collection,
  onChange,
}: {
  collection: Pick<CollectionDetail, "id" | "favourited" | "favouriteCount">;
  onChange: (favourited: boolean, count: number) => void;
}) {
  const { t } = useLingui();
  const signedIn = useAuth().viewer != null;
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (busy || !signedIn) return;
    const next = !collection.favourited;
    setBusy(true);
    // Optimistic: the heart is the whole feedback, and a round trip's worth of
    // nothing reads as a dead button. A failed write puts the old state back.
    onChange(next, Math.max(0, collection.favouriteCount + (next ? 1 : -1)));
    try {
      const result = await favouriteMapCollection({ data: { id: collection.id, favourited: next } });
      if (result.ok) onChange(result.favourited, result.favouriteCount);
      else onChange(!next, collection.favouriteCount);
    } catch {
      onChange(!next, collection.favouriteCount);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={!signedIn}
      aria-pressed={collection.favourited}
      title={signedIn ? t`Like this collection` : t`Sign in to like collections`}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-bold transition-colors ${
        collection.favourited ? "bg-osu-pink/25 text-osu-pink-light" : "bg-osu-b4 text-osu-f1"
      } ${signedIn ? "cursor-pointer hover:text-osu-pink-light" : "cursor-not-allowed opacity-70"}`}
    >
      <Heart className="h-3.5 w-3.5" fill={collection.favourited ? "currentColor" : "none"} aria-hidden="true" />
      {formatNumber(collection.favouriteCount)}
    </button>
  );
}

export function UserCollectionDetailView({ collection }: { collection: CollectionDetail }) {
  const { t } = useLingui();
  const auth = useAuth();
  const locale = useLocale();
  const navigate = useNavigate();
  const preview = useMapPreviewAudio();
  const { stop: stopPreview } = preview;
  const [detail, setDetail] = useState<CollectionDetail>(collection);
  const [error, setError] = useState<string | null>(null);
  const [mapEntry, setMapEntry] = useState<LiveMapSearchEntry | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Navigating between two collection pages re-renders this in place, so the
  // loader's row has to replace the one being held.
  useEffect(() => setDetail(collection), [collection]);
  useEffect(() => () => stopPreview(), [stopPreview]);

  // One card per mapset, not per chart: a collection that took a whole pack in
  // is a list of sets as far as the page is concerned, and the card already
  // knows how to show several difficulties of one set.
  const cards = useMemo(() => groupCollectionItemsBySet(detail.items), [detail]);
  const previewTracks = useMemo(() => cards.map(toPreviewTrack), [cards]);
  const canEdit = auth.viewer?.id === detail.owner.userId || auth.isAdmin;
  const handleDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      const result = await deleteMapCollection({ data: { id: detail.id } });
      if (result.ok) void navigate({ to: "/maps", search: { tab: "collections", cSrc: "community" } as never });
      else setError(t`Couldn't delete this collection.`);
    } catch {
      setError(t`Couldn't delete this collection.`);
    } finally {
      setDeleting(false);
    }
  };

  // Deleting a collection is one gesture, not a confirm step: press and hold,
  // the same shape the packs collection uses for Recycle all.
  const hold = useHoldToConfirm(() => void handleDelete());

  return (
    <div className="bg-osu-b5 min-h-[60vh]">
      <div className="max-w-[1200px] mx-auto flex flex-col gap-4 px-4 py-4 sm:px-5">
        <Link
          to="/maps"
          search={{ tab: "collections", cSrc: "community" } as never}
          className="group self-start inline-flex items-center gap-1.5 rounded-lg bg-osu-b4 px-2.5 py-1.5 text-[11px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:bg-osu-b3 hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" aria-hidden="true" />
          <span>{t`All collections`}</span>
        </Link>

        <div className="flex flex-col gap-3 border-b border-osu-b3/25 pb-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-[20px] font-extrabold tracking-tight text-osu-l1 sm:text-[22px]">{detail.title}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-osu-f1">
              <Link
                to="/player/$username"
                params={{ username: detail.owner.username }}
                className="inline-flex items-center gap-1.5 transition-colors hover:text-osu-l2"
              >
                <img
                  src={avatarImageSrc(detail.owner.avatarUrl ?? undefined, detail.owner.userId)}
                  alt=""
                  className="h-4 w-4 rounded-full object-cover"
                  loading="lazy"
                />
                <span className="font-semibold text-osu-l2">{detail.owner.username}</span>
              </Link>
              <span>
                · {formatNumber(detail.memberCount)} <Plural value={detail.memberCount} one="map" other="maps" />
                {cards.length > 0 && cards.length < detail.memberCount ? (
                  <> · <Plural value={cards.length} one="# mapset" other="# mapsets" /></>
                ) : null}
                {detail.keyCount != null ? ` · ${userCollectionKeyLabel(detail.keyCount)}` : ""}
                {" · "}
                {formatTimeAgo(detail.createdAt, locale)}
              </span>
            </p>
            {detail.description && (
              <p className="mt-2 max-w-[70ch] whitespace-pre-line text-[12.5px] leading-relaxed text-osu-l2">{detail.description}</p>
            )}
            {detail.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {detail.tags.map((entry) => (
                  <span key={entry} className="rounded-full bg-osu-b4/70 px-2.5 py-1 text-[11px] font-semibold text-osu-f1">
                    {entry}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <FavouriteButton
              collection={detail}
              onChange={(favourited, favouriteCount) => setDetail((current) => ({ ...current, favourited, favouriteCount }))}
            />
            <ShareCollectionButton path={collectionPath(detail)} />
            {canEdit && (
              <>
                <button
                  type="button"
                  onClick={() => setEditorOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-osu-b4 px-3 py-1.5 text-[12px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:bg-osu-b3 hover:text-white"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  <Trans>Edit</Trans>
                </button>
                <button
                  type="button"
                  {...hold.handlers}
                  disabled={deleting}
                  // Holding on a phone is a press, not the start of a scroll.
                  style={{ touchAction: "none" }}
                  aria-label={t`Hold to delete this collection`}
                  className="relative overflow-hidden inline-flex items-center gap-1.5 rounded-lg border border-osu-red/30 bg-osu-red/15 px-3 py-1.5 text-[12px] font-semibold text-osu-red transition-colors select-none cursor-pointer hover:bg-osu-red/25 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {/* The hold itself: sweeps across on press, drains fast on an
                      early release so an aborted hold reads as aborted. */}
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 bg-osu-red/35"
                    style={{
                      width: hold.holding ? "100%" : "0%",
                      transition: `width ${hold.holding ? hold.holdMs : 160}ms linear`,
                    }}
                  />
                  <span className="relative inline-flex items-center gap-1.5">
                    {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                    {/* The hint rides an invisible copy of the label as a sizer,
                        so an aborted hold does not resize the button row. */}
                    <span className="grid place-items-center">
                      <span aria-hidden="true" className="col-start-1 row-start-1 invisible"><Trans>hold to delete</Trans></span>
                      <span className="col-start-1 row-start-1 whitespace-nowrap">
                        {hold.hint ? t`hold to delete` : t`Delete`}
                      </span>
                    </span>
                  </span>
                </button>
              </>
            )}
          </div>
        </div>

        {error && <p className="text-[12px] font-semibold text-osu-red">{error}</p>}

        {cards.length === 0 ? (
          <div className="py-16 text-center text-[13px] text-osu-f1">{t`This collection has no maps in it yet.`}</div>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {cards.map((entry) => (
              <SearchCard
                key={entry.beatmapId}
                entry={entry}
                onOpen={(opened) => {
                  // The detail modal has its own chart-preview audio; don't
                  // leave the card's song preview playing over it.
                  stopPreview();
                  setMapEntry(opened);
                }}
                preview={preview}
              />
            ))}
          </div>
        )}

        <UserCollectionEditor
          open={editorOpen}
          editing={detail}
          onClose={() => setEditorOpen(false)}
          onSaved={(saved) => {
            setEditorOpen(false);
            if (!saved.ok) return;
            // The write answers with the summary; the maps come back with the
            // refetch, which is also what re-derives the keymode chip.
            fetchUserMapCollection({ data: { id: saved.collection.id } })
              .then((data) => {
                if (data) setDetail(data);
              })
              .catch(() => {});
          }}
        />
        <MapDetailModal entry={mapEntry} onClose={() => setMapEntry(null)} />
        <MapPreviewPlayerBar preview={preview} tracks={previewTracks} />
      </div>
    </div>
  );
}
