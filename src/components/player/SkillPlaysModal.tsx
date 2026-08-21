import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  fetchLivePlayerSkillPlaysDirect,
  loadLiveMapSearchEntry,
  peekLiveMapSearchEntry,
  prefetchLiveMapSearchEntry,
  type LiveMapSearchEntry,
  type LivePlayerSkillPlay,
} from "../../lib/live-backend";
import { formatAccuracy, formatPP, formatTimeAgo, formatTimeAgoTooltip } from "../../lib/format";
import { Skeleton } from "../ui/LoadingSkeleton";
import { ModBadge } from "../ui/ModBadge";
import { MapDetailModal } from "../maps/MapDetailModal";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";

const SKILL_PLAYS_PAGE_SIZE = 50;

/** The badge a non-1.0x rate stands for: osu shows the speed mod with the rate
 *  on its extender, so a 0.75x play reads as an HT badge tailed "0.75×". */
function rateModFor(rate: number): { acronym: string; rate: number } | null {
  if (Math.abs(rate - 1) < 0.01) return null;
  return { acronym: rate > 1 ? "DT" : "HT", rate };
}

// What the play row already knows, shaped as a map entry so the detail modal
// can mount on the click instead of after the catalog round trip. Everything
// the row does not carry (stars, bpm, the set's other diffs, MSD) stays at its
// empty value and renders as pending until the real entry replaces this.
function stubEntry(play: LivePlayerSkillPlay): LiveMapSearchEntry {
  return {
    beatmapId: play.beatmapId,
    beatmapsetId: play.beatmapsetId ?? 0,
    title: play.title,
    artist: play.artist,
    creator: play.creator ?? "",
    version: play.version,
    status: "",
    keyCount: play.keyCount,
    stars: 0,
    bpm: 0,
    length: 0,
    playCount: 0,
    lnCount: 0,
    primaryPattern: "",
    patterns: {},
    covers: play.coverUrl ? { card: play.coverUrl } : null,
  };
}

interface SkillPlaysModalProps {
  userId: number;
  username: string;
  keyCount: number;
  axis: string;
  label: string;
  color: string;
  onClose: () => void;
}

export function SkillPlaysModal({
  userId,
  username,
  keyCount,
  axis,
  label,
  color,
  onClose,
}: SkillPlaysModalProps) {
  const { t } = useLingui();
  const [items, setItems] = useState<LivePlayerSkillPlay[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // The map-detail view for a clicked play, stacked on top of this list. It
  // opens on the click with what the row knows and upgrades in place when the
  // catalog entry lands, so the round trip never sits between the two.
  const [detail, setDetail] = useState<
    { play: LivePlayerSkillPlay; entry: LiveMapSearchEntry; status: "ready" | "pending" | "missing" | "error" } | null
  >(null);
  const mountedRef = useRef(true);

  // Ref-counted with the map-detail modal's own lock, so stacking is safe.
  useBodyScrollLock(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // While the map-detail modal sits on top, Escape belongs to it.
      if (event.key === "Escape" && !detail) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [detail, onClose]);

  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    setTotal(0);
    setLoading(true);
    setError(null);
    fetchLivePlayerSkillPlaysDirect(userId, keyCount, axis, {
      limit: SKILL_PLAYS_PAGE_SIZE,
      offset: 0,
      signal: controller.signal,
    })
      .then((page) => {
        if (controller.signal.aborted) return;
        setItems(page.items);
        setTotal(page.total);
      })
      .catch((fetchError) => {
        if (controller.signal.aborted) return;
        setError(fetchError instanceof Error ? fetchError.message : t`Could not load these plays.`);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [axis, keyCount, reloadKey, userId]);

  const showMore = async () => {
    if (loadingMore || items.length >= total) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchLivePlayerSkillPlaysDirect(userId, keyCount, axis, {
        limit: SKILL_PLAYS_PAGE_SIZE,
        offset: items.length,
      });
      if (!mountedRef.current) return;
      setItems((current) => [...current, ...page.items]);
      setTotal(page.total);
    } catch (fetchError) {
      if (!mountedRef.current) return;
      setError(fetchError instanceof Error ? fetchError.message : t`Could not load more plays.`);
    } finally {
      if (mountedRef.current) setLoadingMore(false);
    }
  };

  const openDetail = (play: LivePlayerSkillPlay) => {
    // A hovered (or already opened) row answers from memory, so the modal opens
    // complete; otherwise the stub carries it until the request lands.
    const cached = peekLiveMapSearchEntry(play.beatmapId);
    if (cached !== undefined) {
      setDetail({ play, entry: cached ?? stubEntry(play), status: cached ? "ready" : "missing" });
      return;
    }
    setDetail({ play, entry: stubEntry(play), status: "pending" });
    loadLiveMapSearchEntry(play.beatmapId)
      .then((entry) => {
        if (!mountedRef.current) return;
        // A second click while this was in flight owns the modal now.
        setDetail((current) => (
          current && current.play.beatmapId === play.beatmapId && current.status === "pending"
            // Chart unknown to the map catalog (a graveyarded tracked play):
            // the stub plus the osu! link is the whole detail view there is.
            ? { play, entry: entry ?? current.entry, status: entry ? "ready" : "missing" }
            : current
        ));
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setDetail((current) => (
          current && current.play.beatmapId === play.beatmapId && current.status === "pending"
            ? { ...current, status: "error" }
            : current
        ));
      });
  };

  return (
    <>
      <AnimatePresence>
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-2 backdrop-blur-sm sm:p-4"
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={t`${username}'s top ${label} plays`}
            className="modal-card-mobile-safe flex max-h-[calc(100dvh-1rem)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-osu-b3/25 bg-osu-b5 shadow-[0_18px_70px_rgba(0,0,0,0.65)] sm:max-h-[calc(100vh-2rem)]"
            onClick={(event) => event.stopPropagation()}
            initial={{ opacity: 0, y: 10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.985 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
          >
            <header className="relative shrink-0 overflow-hidden border-b border-osu-b3/25 bg-osu-b4 px-4 py-4 sm:px-6 sm:py-5">
              <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: color }} />
              <div className="pr-10">
                <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-osu-f1"><Trans>{keyCount}K skillset</Trans></div>
                <h2 className="mt-1 text-xl font-black text-white sm:text-2xl">
                  <Trans>{username}'s top <span style={{ color }}>{label}</span> plays</Trans>
                </h2>
                <p className="mt-1.5 max-w-2xl text-[11px] leading-relaxed text-osu-f1 sm:text-xs">
                  <Trans>Ranked by {label} skill rating from the plays behind this profile rating, including tracked history.</Trans>
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={t`Close skill plays`}
                className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-white sm:right-4 sm:top-4"
              >
                <X size={16} />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 [scrollbar-gutter:stable] sm:px-4 sm:py-3">
              {loading ? (
                <div className="space-y-1.5">
                  {Array.from({ length: 7 }).map((_, index) => <SkillPlaySkeleton key={index} />)}
                </div>
              ) : items.length === 0 ? (
                <div className="px-4 py-14 text-center">
                  <div className="text-sm font-semibold text-osu-l2">
                    {error ? t`Could not load these plays` : t`No rated ${label} plays found`}
                  </div>
                  <div className="mt-1 text-xs text-osu-f1">
                    {error ?? t`The rating may be waiting for a fresh chart-analysis pass.`}
                  </div>
                  {error ? (
                    <button
                      type="button"
                      onClick={() => setReloadKey((key) => key + 1)}
                      className="mt-4 rounded-lg bg-osu-pink/15 px-4 py-2 text-xs font-semibold text-osu-pink-light hover:bg-osu-pink/25"
                    >
                      <Trans>Try again</Trans>
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {items.map((play, index) => (
                    <SkillPlayRow
                      key={`${play.beatmapId}:${play.rate}:${play.scoreId ?? play.playedAt ?? index}`}
                      play={play}
                      position={index + 1}
                      label={label}
                      color={color}
                      onOpen={() => openDetail(play)}
                      onPrefetch={() => prefetchLiveMapSearchEntry(play.beatmapId)}
                    />
                  ))}
                </div>
              )}

              {error && items.length > 0 ? (
                <div className="mt-3 rounded-lg border border-osu-red-light/20 bg-osu-red-light/5 px-3 py-2 text-center text-[11px] text-osu-red-light">
                  {error}
                </div>
              ) : null}

              {!loading && items.length < total ? (
                <div className="flex justify-center py-4">
                  <button
                    type="button"
                    onClick={() => void showMore()}
                    disabled={loadingMore}
                    className="rounded-lg border border-osu-b3/30 bg-osu-b4 px-5 py-2 text-xs font-semibold text-osu-l2 transition-colors hover:border-osu-pink/30 hover:bg-osu-b3/50 hover:text-white disabled:cursor-wait disabled:opacity-60"
                  >
                    {loadingMore ? t`Loading…` : t`Show more`}
                  </button>
                </div>
              ) : null}
            </div>

            {!loading && total > 0 ? (
              <footer className="shrink-0 border-t border-osu-b3/20 bg-osu-b4/70 px-4 py-2.5 text-center text-[10px] text-osu-f1">
                Showing {items.length.toLocaleString("en-US")} of {total.toLocaleString("en-US")} rated {label} {total === 1 ? "play" : "plays"}
              </footer>
            ) : null}
          </motion.div>
        </motion.div>
      </AnimatePresence>
      {detail ? (
        <MapDetailModal
          entry={detail.entry}
          status={detail.status}
          onClose={() => setDetail(null)}
          play={{
            beatmapId: detail.play.beatmapId,
            username,
            accuracy: detail.play.accuracy,
            pp: detail.play.pp,
            rateMod: rateModFor(detail.play.rate),
            playedAt: detail.play.playedAt,
            source: detail.play.source,
            rating: detail.play.rating,
            ratingLabel: label,
            ratingColor: color,
          }}
        />
      ) : null}
    </>
  );
}

function SkillPlayRow({
  play,
  position,
  label,
  color,
  onOpen,
  onPrefetch,
}: {
  play: LivePlayerSkillPlay;
  position: number;
  label: string;
  color: string;
  onOpen: () => void;
  // Warms the catalog entry ahead of the click; pointing at a row (or tabbing
  // to it) buys more than the request costs, so the modal usually opens whole.
  onPrefetch: () => void;
}) {
  const { t } = useLingui();
  const rateMod = rateModFor(play.rate);
  return (
    <button
      type="button"
      onClick={onOpen}
      onPointerEnter={onPrefetch}
      onFocus={onPrefetch}
      className="group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-xl border border-transparent bg-osu-b4/55 px-2 py-2 text-left transition-colors hover:border-osu-b3/30 hover:bg-osu-b4 sm:gap-3 sm:px-3"
      title={t`View map details`}
    >
      <span className="w-6 shrink-0 text-right text-[11px] font-bold tabular-nums text-osu-f1 sm:w-7 sm:text-xs">{position}.</span>
      <div className="relative h-10 w-16 shrink-0 overflow-hidden rounded-md bg-osu-b3/35 sm:h-12 sm:w-20">
        {play.coverUrl ? (
          <img
            src={play.coverUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            onError={(event) => { event.currentTarget.style.display = "none"; }}
          />
        ) : null}
        <div className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/[0.06]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs font-semibold text-white sm:text-sm">{play.title}</span>
          <span className="hidden shrink-0 truncate text-[10px] text-osu-f1 md:inline">[{play.version}]</span>
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] text-osu-f1 sm:text-[10px]">
          <span className="max-w-44 truncate">
            {play.artist}<span className="md:hidden"> · [{play.version}]</span>
          </span>
          <span className="rounded bg-osu-b3/35 px-1 py-0.5 font-bold text-osu-yellow">{play.keyCount}K</span>
          {rateMod ? <ModBadge mod={rateMod.acronym} rate={rateMod.rate} size={0.8} /> : null}
          <span>{play.source === "top" ? t`profile top play` : t`tracked history`}</span>
          {play.playedAt ? (
            <span className="hidden sm:inline" title={formatTimeAgoTooltip(play.playedAt)}>{formatTimeAgo(play.playedAt)}</span>
          ) : null}
        </div>
      </div>
      <div className="hidden shrink-0 items-end gap-4 text-right sm:flex">
        {play.accuracy != null ? (
          <div>
            <div className="text-xs font-semibold tabular-nums text-osu-l2">{formatAccuracy(play.accuracy)}</div>
            <div className="mt-0.5 text-[8px] uppercase tracking-wide text-osu-f1">{t`accuracy`}</div>
          </div>
        ) : null}
        {play.pp != null ? (
          <div>
            <div className="text-xs font-bold tabular-nums text-osu-pink-light">{formatPP(play.pp)}</div>
            <div className="mt-0.5 text-[8px] uppercase tracking-wide text-osu-f1">pp</div>
          </div>
        ) : null}
      </div>
      <div className="w-14 shrink-0 text-right sm:w-16">
        <div className="text-base font-black leading-none tabular-nums sm:text-lg" style={{ color }}>{play.rating.toFixed(2)}</div>
        <div className="mt-1 truncate text-[8px] font-semibold uppercase tracking-wide text-osu-f1" title={t`${label} rating`}>{label}</div>
      </div>
    </button>
  );
}

function SkillPlaySkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-osu-b4/55 px-3 py-2">
      <Skeleton className="h-3 w-5" />
      <Skeleton className="h-12 w-20 rounded-md" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-2.5 w-1/3" />
      </div>
      <Skeleton className="h-5 w-12" />
    </div>
  );
}
