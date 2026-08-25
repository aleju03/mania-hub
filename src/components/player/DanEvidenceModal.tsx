import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  fetchLivePlayerDanEvidenceDirect,
  loadLiveMapSearchEntry,
  peekLiveMapSearchEntry,
  prefetchLiveMapSearchEntry,
  type LiveMapSearchEntry,
  type LivePlayerDanEvidence,
  type LivePlayerDanEvidencePlay,
} from "../../lib/live-backend";
import { formatAccuracy, formatTimeAgo, formatTimeAgoTooltip } from "../../lib/format";
import { danBareLabel, danTierColor, danTierSuffix, getDanImageSrc } from "../../lib/dan-images";
import { PATTERN_RATING_META } from "../../lib/skill-axes";
import { Skeleton } from "../ui/LoadingSkeleton";
import { ModBadge } from "../ui/ModBadge";
import { MapDetailModal } from "../maps/MapDetailModal";
import { rateModFor, stubEntry } from "./SkillPlaysModal";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";
import { useLocale } from "../../lib/locale-context";

// The dan chip's accent per side; decorative only, identity stays on the text.
const SIDE_COLOR: Record<"rc" | "ln", string> = { rc: "#e0b04c", ln: "#f07474" };

interface DanEvidenceModalProps {
  userId: number;
  username: string;
  keyCount: number;
  side: "rc" | "ln";
  onClose: () => void;
}

export function DanEvidenceModal({ userId, username, keyCount, side, onClose }: DanEvidenceModalProps) {
  const { t, i18n } = useLingui();
  const [evidence, setEvidence] = useState<LivePlayerDanEvidence | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // The map-detail view for a clicked clear, stacked on top of this list,
  // same pattern as SkillPlaysModal: opens on the click with what the row
  // knows and upgrades in place when the catalog entry lands.
  const [detail, setDetail] = useState<
    { clear: LivePlayerDanEvidencePlay; entry: LiveMapSearchEntry; status: "ready" | "pending" | "missing" | "error" } | null
  >(null);
  const mountedRef = useRef(true);

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
    setEvidence(null);
    setLoading(true);
    setError(null);
    fetchLivePlayerDanEvidenceDirect(userId, keyCount, side, { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setEvidence(payload);
      })
      .catch((fetchError) => {
        if (controller.signal.aborted) return;
        setError(fetchError instanceof Error ? fetchError.message : t`Could not load the clears behind this estimate.`);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [keyCount, reloadKey, side, userId]);

  const openDetail = (clear: LivePlayerDanEvidencePlay) => {
    const cached = peekLiveMapSearchEntry(clear.play.beatmapId);
    if (cached !== undefined) {
      setDetail({ clear, entry: cached ?? stubEntry(clear.play), status: cached ? "ready" : "missing" });
      return;
    }
    setDetail({ clear, entry: stubEntry(clear.play), status: "pending" });
    loadLiveMapSearchEntry(clear.play.beatmapId)
      .then((entry) => {
        if (!mountedRef.current) return;
        setDetail((current) => (
          current && current.clear.play.beatmapId === clear.play.beatmapId && current.status === "pending"
            ? { clear, entry: entry ?? current.entry, status: entry ? "ready" : "missing" }
            : current
        ));
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setDetail((current) => (
          current && current.clear.play.beatmapId === clear.play.beatmapId && current.status === "pending"
            ? { ...current, status: "error" }
            : current
        ));
      });
  };

  const color = SIDE_COLOR[side];
  const sideLabel = side === "ln" ? t`LN` : t`Regular`;
  // A numbered course reads as a level, not a name, so it needs the word;
  // named ladders already read as one (same rule as the chip).
  const formatDan = (label: string): string => (/^\d/.test(label) ? t`${label} dan` : label);
  const dan = evidence?.dan ?? null;
  // At the ladder's ceiling the level is a floor, not a reading (6K regular
  // ends at 9th), so the headline says "beyond" and drops the tier suffix.
  const beyond = dan?.beyondTable === true;
  const danLabel = dan ? (beyond ? danBareLabel(dan.label) : dan.label) : "";
  const image = dan ? getDanImageSrc(danBareLabel(danLabel), side === "ln" ? "ln" : undefined, keyCount) : null;
  const suffix = dan && !beyond ? danTierSuffix(dan.label) : "";
  const minAccuracyPercent = Math.round((evidence?.minAccuracy ?? 0.96) * 100);
  const quorum = evidence?.quorum ?? 4;

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
            aria-label={t`${username}'s ${sideLabel} dan estimate`}
            className="modal-card-mobile-safe flex max-h-[calc(100dvh-1rem)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-osu-b3/25 bg-osu-b5 shadow-[0_18px_70px_rgba(0,0,0,0.65)] sm:max-h-[calc(100vh-2rem)]"
            onClick={(event) => event.stopPropagation()}
            initial={{ opacity: 0, y: 10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.985 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
          >
            <header className="relative shrink-0 overflow-hidden border-b border-osu-b3/25 bg-osu-b4 px-4 py-4 sm:px-6 sm:py-5">
              <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: color }} />
              <div className="flex items-center gap-4 pr-10">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-osu-f1">
                    <Trans>{keyCount}K {sideLabel} dan</Trans>
                  </div>
                  <h2 className="mt-1 text-xl font-black text-white sm:text-2xl">
                    {dan && beyond ? (
                      <Trans>{username} is beyond <span style={{ color }}>{formatDan(danLabel)}</span></Trans>
                    ) : dan ? (
                      <Trans>{username} is around <span style={{ color }}>{formatDan(danLabel)}</span></Trans>
                    ) : (
                      <Trans>{username}'s {sideLabel} dan estimate</Trans>
                    )}
                  </h2>
                  {beyond ? (
                    <p className="mt-1.5 max-w-2xl text-[11px] leading-relaxed text-white/70 sm:text-xs">
                      <Trans>
                        The {keyCount}K {sideLabel} course ladder ends at {formatDan(danLabel)}, so the analyzer cannot rate
                        anything above it. The real level may be higher.
                      </Trans>
                    </p>
                  ) : null}
                  <p className="mt-1.5 max-w-2xl text-[11px] leading-relaxed text-osu-f1 sm:text-xs">
                    <Trans>
                      A clear is a {minAccuracyPercent}%+ accuracy pass with almost no misses, at 1.0x or DT, on a chart the
                      analyzer gave a dan rating. Passes below full accuracy earn a discounted level, and the estimate is the
                      {" "}{quorum}th best credited clear, so a single outlier can never set it.
                    </Trans>
                  </p>
                </div>
                {image ? (
                  <span className="ml-auto flex shrink-0 items-start gap-[2px] leading-none">
                    <img src={image} alt={formatDan(danLabel)} className="h-14 w-14 object-contain" />
                    {suffix ? (
                      <span className="mt-1 text-[18px] font-bold leading-none" style={{ color: danTierColor(suffix) ?? undefined }}>
                        {suffix}
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={t`Close dan details`}
                className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-white sm:right-4 sm:top-4"
              >
                <X size={16} />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3 [scrollbar-gutter:stable] sm:px-4">
              {loading ? (
                <div className="space-y-1.5">
                  {Array.from({ length: 7 }).map((_, index) => (
                    <div key={index} className="flex items-center gap-3 rounded-xl bg-osu-b4/55 px-3 py-2">
                      <Skeleton className="h-3 w-5" />
                      <Skeleton className="h-12 w-20 rounded-md" />
                      <div className="min-w-0 flex-1 space-y-2">
                        <Skeleton className="h-3.5 w-2/3" />
                        <Skeleton className="h-2.5 w-1/3" />
                      </div>
                      <Skeleton className="h-5 w-12" />
                    </div>
                  ))}
                </div>
              ) : !evidence || evidence.clears.length === 0 ? (
                <div className="px-4 py-14 text-center">
                  <div className="text-sm font-semibold text-osu-l2">
                    {error ? t`Could not load the clears` : t`No qualifying clears yet`}
                  </div>
                  <div className="mt-1 text-xs text-osu-f1">
                    {error ?? t`The estimate appears once ${quorum} clears at ${minAccuracyPercent}%+ accuracy land on rated charts.`}
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
                <>
                  <div className="px-2 pb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-osu-f1">
                    <Trans>The clears behind it</Trans>
                  </div>
                  {!dan ? (
                    <div className="px-2 pb-2 text-[11px] text-osu-l2">
                      <Trans>
                        Not enough qualifying clears for an estimate yet ({evidence.totalClears} of {quorum}).
                      </Trans>
                    </div>
                  ) : null}
                  <div className="space-y-1.5">
                    {evidence.clears.map((clear, index) => (
                      <ClearRow
                        key={`${clear.play.beatmapId}:${clear.play.rate}:${clear.play.scoreId ?? clear.play.playedAt ?? index}`}
                        clear={clear}
                        position={index + 1}
                        color={color}
                        formatDan={formatDan}
                        onOpen={() => openDetail(clear)}
                        onPrefetch={() => prefetchLiveMapSearchEntry(clear.play.beatmapId)}
                      />
                    ))}
                  </div>
                  {evidence.totalClears > evidence.clears.length ? (
                    <div className="px-2 pt-2 text-[10px] text-osu-f1">
                      <Trans>and {evidence.totalClears - evidence.clears.length} more qualifying clears below these</Trans>
                    </div>
                  ) : null}

                  {evidence.skillsets.length > 0 ? (
                    <>
                      <div className="px-2 pb-1 pt-5 text-[10px] font-bold uppercase tracking-[0.16em] text-osu-f1">
                        <Trans>By skillset</Trans>
                      </div>
                      <div className="px-2 pb-2 text-[11px] text-osu-l2">
                        <Trans>The same rule run over only the clears whose charts carry each pattern.</Trans>
                      </div>
                      <div className="space-y-4">
                        {evidence.skillsets.map((skillset) => {
                          const meta = PATTERN_RATING_META.find((entry) => entry.key === skillset.id);
                          const label = meta ? i18n._(meta.labelMsg) : skillset.id;
                          return (
                            <div key={skillset.id}>
                              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-2 pb-1.5">
                                <span className="text-sm font-bold" style={{ color: meta?.color ?? color }}>{label}</span>
                                {skillset.dan ? (
                                  <span className="text-sm font-black text-white">~{formatDan(skillset.dan.label)}</span>
                                ) : (
                                  <span className="text-[11px] text-osu-f1">
                                    <Trans>needs {quorum} clears for an estimate</Trans>
                                  </span>
                                )}
                                <span className="text-[10px] text-osu-f1">
                                  {skillset.clears === 1 ? t`1 clear` : t`${skillset.clears} clears`}
                                </span>
                              </div>
                              <div className="space-y-1.5">
                                {skillset.plays.map((clear, index) => (
                                  <ClearRow
                                    key={`${skillset.id}:${clear.play.beatmapId}:${clear.play.rate}`}
                                    clear={clear}
                                    position={index + 1}
                                    color={meta?.color ?? color}
                                    formatDan={formatDan}
                                    onOpen={() => openDetail(clear)}
                                    onPrefetch={() => prefetchLiveMapSearchEntry(clear.play.beatmapId)}
                                  />
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  ) : null}
                </>
              )}
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
            beatmapId: detail.clear.play.beatmapId,
            username,
            accuracy: detail.clear.play.accuracy,
            pp: detail.clear.play.pp,
            rateMod: rateModFor(detail.clear.play.rate),
            playedAt: detail.clear.play.playedAt,
            source: detail.clear.play.source,
            rating: detail.clear.creditedDan,
            ratingLabel: t`credited dan`,
            ratingColor: color,
          }}
        />
      ) : null}
    </>
  );
}

function ClearRow({
  clear,
  position,
  color,
  formatDan,
  onOpen,
  onPrefetch,
}: {
  clear: LivePlayerDanEvidencePlay;
  position: number;
  color: string;
  formatDan: (label: string) => string;
  onOpen: () => void;
  // Warms the catalog entry ahead of the click, same as the skill plays list.
  onPrefetch: () => void;
}) {
  const { t } = useLingui();
  const locale = useLocale();
  const play = clear.play;
  const rateMod = rateModFor(play.rate);
  return (
    <button
      type="button"
      onClick={onOpen}
      onPointerEnter={onPrefetch}
      onFocus={onPrefetch}
      className={`group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-xl border border-transparent bg-osu-b4/55 px-2 py-2 text-left transition-colors hover:border-osu-b3/30 hover:bg-osu-b4 sm:gap-3 sm:px-3 ${
        clear.countsTowardDan ? "" : "opacity-70"
      }`}
      title={clear.countsTowardDan
        ? t`This clear backs the estimate · view map details`
        : t`Below the credit that sets the estimate · view map details`}
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
          {rateMod ? <ModBadge mod={rateMod.acronym} rate={rateMod.rate} size={0.8} /> : null}
          {play.playedAt ? (
            <span className="hidden sm:inline" title={formatTimeAgoTooltip(play.playedAt, locale)}>{formatTimeAgo(play.playedAt, locale)}</span>
          ) : null}
        </div>
      </div>
      {play.accuracy != null ? (
        <div className="hidden shrink-0 text-right sm:block">
          <div className="text-xs font-semibold tabular-nums text-osu-l2">{formatAccuracy(play.accuracy)}</div>
          <div className="mt-0.5 text-[8px] uppercase tracking-wide text-osu-f1">{t`accuracy`}</div>
        </div>
      ) : null}
      <div className="w-20 shrink-0 text-right sm:w-24">
        <div className="text-sm font-black leading-none sm:text-base" style={{ color }}>{formatDan(clear.chartDanLabel)}</div>
        <div
          className="mt-1 text-[8px] font-semibold uppercase tracking-wide text-osu-f1"
          title={t`Dan credit this clear earned after the accuracy discount`}
        >
          {t`credit ${clear.creditedDan.toFixed(2)}`}
        </div>
      </div>
    </button>
  );
}
