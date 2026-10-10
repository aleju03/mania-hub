import { skillPlaySharePath } from "../../lib/skill-play-share";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { plural } from "@lingui/core/macro";
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
import { msdSkillsetMeta } from "../../lib/skill-axes";
import { Skeleton } from "../ui/LoadingSkeleton";
import { ModBadge } from "../ui/ModBadge";
import { MapDetailModal } from "../maps/MapDetailModal";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";
import { useLocale } from "../../lib/locale-context";

const SKILL_PLAYS_PAGE_SIZE = 50;

/** The badge a non-1.0x rate stands for: osu shows the speed mod with the rate
 *  on its extender, so a 0.75x play reads as an HT badge tailed "0.75×". The
 *  stored acronym names the variant when it survives; without it the rate's
 *  sign is all there is, and `pitched` keeps the old reading (audio pitch
 *  follows rate) rather than inventing a mod the play may not have had. */
export function rateModFor(
  rate: number,
  acronym?: string | null,
): { acronym: string; rate: number; pitched: boolean } | null {
  if (Math.abs(rate - 1) < 0.01) return null;
  const known = acronym === "DT" || acronym === "NC" || acronym === "HT" || acronym === "DC" ? acronym : null;
  // NC and DC resample the audio (the nightcore/daycore pitch); DT and HT
  // stretch it and leave the pitch where it was.
  return {
    acronym: known ?? (rate > 1 ? "DT" : "HT"),
    rate,
    pitched: known ? known === "NC" || known === "DC" : true,
  };
}

/* Every mod the score carried. A pre-full-mod retained play can still name its
   speed mod from the old projection; a 1.0x play with no `mods` field is
   unknown, not NoMod, because it may have carried MR/DA/etc. before the raw
   score aged out. */
export function playModAcronyms(play: LivePlayerSkillPlay): string[] | null {
  if (Array.isArray(play.mods)) {
    return [...new Set(play.mods.filter((mod) => typeof mod === "string" && mod.length > 0))];
  }
  const rateMod = rateModFor(play.rate, play.rateMod);
  return rateMod ? [rateMod.acronym] : null;
}

function formatDaOd(od: number): string {
  return Number.isInteger(od) ? String(od) : od.toFixed(1);
}

export function PlayModBadges({ play, size = 0.8 }: { play: LivePlayerSkillPlay; size?: number }) {
  const acronyms = playModAcronyms(play);
  if (!acronyms || acronyms.length === 0) return null;
  const rateMod = rateModFor(play.rate, play.rateMod);
  return (
    <span className="inline-flex flex-wrap items-center gap-0.5">
      {acronyms.map((mod) => (
        <ModBadge
          key={mod}
          mod={mod}
          rate={rateMod?.acronym === mod ? rateMod.rate : undefined}
          detail={mod === "DA" && typeof play.daOd === "number" ? `OD ${formatDaOd(play.daOd)}` : undefined}
          size={size}
        />
      ))}
    </span>
  );
}

// The row's thumbnail is a `list@2x` cover; the detail modal's banner asks for
// `card@2x`. Every size of a set's art shares one URL shape and one cache-busting
// query, so the banner's URL is a filename swap away - handing it over on the stub
// means the banner loads the image it will keep instead of stretching the list
// thumbnail and then fetching the card again once the catalog entry lands.
function bannerCoverUrl(coverUrl: string): string | null {
  const swapped = coverUrl.replace(/\/covers\/[^/?]+\.jpg/, "/covers/card@2x.jpg");
  return swapped === coverUrl ? null : swapped;
}

// What the play row already knows, shaped as a map entry so the detail modal
// can mount on the click instead of after the catalog round trip. Everything
// the row does not carry (stars, bpm, the set's other diffs, MSD) stays at its
// empty value and renders as pending until the real entry replaces this.
export function stubEntry(play: LivePlayerSkillPlay): LiveMapSearchEntry {
  const banner = play.coverUrl ? bannerCoverUrl(play.coverUrl) : null;
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
    covers: play.coverUrl ? { list: play.coverUrl, ...(banner ? { "card@2x": banner } : {}) } : null,
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
            {/* Same header as the dan window: no panel, bar, eyebrow or
                subtitle, and the play count sits beside the keymode instead
                of in a footer. */}
            <header className="relative shrink-0 px-4 pb-3 pt-4 sm:px-6 sm:pt-5">
              <div className="pr-10">
                <div className="flex items-center text-[12px] text-osu-f1">
                  <span>{keyCount}K</span>
                  {!loading && total > 0 ? (
                    <>
                      <span className="mx-2 h-3 w-px bg-white/15" aria-hidden="true" />
                      <span className="tabular-nums">
                        {items.length < total
                          ? t`${items.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} plays`
                          : t`${plural(total, { one: "# play", other: "# plays" })}`}
                      </span>
                    </>
                  ) : null}
                </div>
                <h2 className="mt-1 text-xl font-black text-white sm:text-2xl">
                  <Trans>{username}'s top <span style={{ color }}>{label}</span> plays</Trans>
                </h2>
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

            <div className="min-h-0 flex-1 overflow-y-auto border-t border-white/[0.07] px-2 pb-3 [scrollbar-gutter:stable] sm:px-4">
              {loading ? (
                <div>
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
                <div>
                  {items.map((play, index) => (
                    <SkillPlayRow
                      key={`${play.beatmapId}:${play.rate}:${play.scoreId ?? play.playedAt ?? index}`}
                      play={play}
                      position={index + 1}
                      axis={axis}
                      label={label}
                      color={color}
                      onOpen={() => openDetail(play)}
                      onPrefetch={() => prefetchLiveMapSearchEntry(play.beatmapId)}
                    />
                  ))}
                </div>
              )}

              {error && items.length > 0 ? (
                <div className="mt-3 text-center text-[11px] text-osu-red-light">
                  {error}
                </div>
              ) : null}

              {!loading && items.length < total ? (
                <div className="flex justify-center py-4">
                  <button
                    type="button"
                    onClick={() => void showMore()}
                    disabled={loadingMore}
                    className="rounded-lg bg-osu-b4 px-5 py-2 text-xs font-semibold text-osu-l2 transition hover:text-white hover:brightness-110 disabled:cursor-wait disabled:opacity-60"
                  >
                    {loadingMore ? t`Loading…` : t`Show more`}
                  </button>
                </div>
              ) : null}
            </div>

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
            rateMod: rateModFor(detail.play.rate, detail.play.rateMod),
            playedAt: detail.play.playedAt,
            source: detail.play.source,
            mods: detail.play.mods ?? null,
            daOd: detail.play.daOd ?? null,
            scoreId: detail.play.scoreId,
            sharePath: skillPlaySharePath(username, detail.play.scoreId, detail.play.keyCount, axis),
            score: detail.play.score,
            skillRatings: detail.play.skillRatings,
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
  axis,
  label,
  color,
  onOpen,
  onPrefetch,
}: {
  play: LivePlayerSkillPlay;
  position: number;
  axis: string;
  label: string;
  color: string;
  onOpen: () => void;
  // Warms the catalog entry ahead of the click; pointing at a row (or tabbing
  // to it) buys more than the request costs, so the modal usually opens whole.
  onPrefetch: () => void;
}) {
  const { t, i18n } = useLingui();
  const locale = useLocale();
  // The list ranks by one skillset component of every play, so a dense LN
  // chart can lead "top Chordjack plays" purely by riding a big overall. When
  // a different skillset actually drove the play, its chip says so; only on
  // MSD axes - the pattern lists already require charts made of the pattern.
  const topSkillsetMeta = !axis.startsWith("pattern:") && play.topSkillset && play.topSkillset !== axis
    ? msdSkillsetMeta(play.keyCount).find((meta) => meta.key === play.topSkillset) ?? null
    : null;
  // The metadata line is plain text split by hairlines: no keymode pill (the
  // header names it once) and no per-row rating label (the title does).
  const meta: { key: string; node: ReactNode; className?: string }[] = [
    { key: "artist", node: play.artist, className: "max-w-44 truncate" },
  ];
  if (topSkillsetMeta) {
    meta.push({
      key: "top",
      node: (
        <span className="font-semibold" style={{ color: topSkillsetMeta.color }} title={t`This play's strongest skillset`}>
          {i18n._(topSkillsetMeta.labelMsg)}
        </span>
      ),
    });
  }
  meta.push({ key: "source", node: play.source === "top" ? t`profile top play` : t`tracked history` });
  if (play.playedAt) {
    meta.push({
      key: "played",
      node: <span title={formatTimeAgoTooltip(play.playedAt, locale)}>{formatTimeAgo(play.playedAt, locale)}</span>,
      className: "max-sm:hidden",
    });
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      onPointerEnter={onPrefetch}
      onFocus={onPrefetch}
      className="group flex w-full min-w-0 cursor-pointer items-center gap-3 border-t border-white/[0.07] px-2 py-2.5 text-left transition-colors first:border-t-0 hover:bg-osu-b4 sm:gap-4 sm:px-3"
      title={t`View map details`}
    >
      <span className="w-5 shrink-0 text-right text-[12px] tabular-nums text-osu-f1">{position}</span>
      <div className="relative h-10 w-16 shrink-0 overflow-hidden rounded-md bg-osu-b3/35 sm:h-11 sm:w-[4.5rem]">
        {play.coverUrl ? (
          <img
            src={play.coverUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            onError={(event) => { event.currentTarget.style.display = "none"; }}
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-osu-l1 group-hover:text-white sm:text-sm">
            {play.title}
            <span className="ml-1.5 text-[11px] font-normal text-osu-f1">[{play.version}]</span>
          </span>
          <span className="flex shrink-0 items-center"><PlayModBadges play={play} size={0.75} /></span>
        </div>
        <div className="mt-1 flex min-w-0 items-center text-[11px] text-osu-f1">
          {meta.map((item, index) => (
            <span key={item.key} className={`flex min-w-0 items-center ${item.className ?? ""}`}>
              {index > 0 ? <span className="mx-2 h-2.5 w-px shrink-0 bg-white/15" aria-hidden="true" /> : null}
              <span className="min-w-0 truncate">{item.node}</span>
            </span>
          ))}
        </div>
      </div>
      <span className="hidden w-14 shrink-0 text-right text-[13px] tabular-nums text-osu-l2 sm:block">
        {play.accuracy != null ? formatAccuracy(play.accuracy) : null}
      </span>
      <span className="hidden w-14 shrink-0 text-right text-[13px] tabular-nums text-osu-f1 sm:block">
        {play.pp != null ? formatPP(play.pp) : null}
      </span>
      <span
        className="w-14 shrink-0 text-right text-lg font-black leading-none tabular-nums sm:w-16 sm:text-xl"
        style={{ color }}
        title={t`${label} rating`}
      >
        {play.rating.toFixed(2)}
      </span>
    </button>
  );
}

function SkillPlaySkeleton() {
  return (
    <div className="flex items-center gap-4 border-t border-white/[0.07] px-3 py-2.5 first:border-t-0">
      <Skeleton className="h-3 w-5" />
      <Skeleton className="h-11 w-[4.5rem] rounded-md" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-2.5 w-1/3" />
      </div>
      <Skeleton className="h-5 w-12" />
    </div>
  );
}
