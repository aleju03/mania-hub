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
import { formatAccuracy, formatTimeAgo } from "../../lib/format";
import { danBareLabel, danTierColor, danTierSuffix, getDanImageSrc } from "../../lib/dan-images";
import { DAN_SKILLSET_META } from "../../lib/skill-axes";
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
  // Which row's clears are unfolded, if any. Everything is collapsed on open:
  // the breakdown is a handful of dan numbers, and the plays behind each one
  // are the follow-up question, not the answer.
  const [openSection, setOpenSection] = useState<string | null>(null);
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
    setOpenSection(null);
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

  // The window opens on the breakdown, never on a wall of plays: every row is
  // one dan number, and the clears behind it unfold on the click. The headline
  // estimate is just the first row, so "all clears" and "your jack clears" are
  // the same gesture instead of two different-looking surfaces.
  const sections = evidence
    ? [
      { id: "all", label: t`All clears`, color, dan: evidence.dan, clears: evidence.totalClears, plays: evidence.clears },
      ...evidence.skillsets.map((skillset) => {
        const meta = DAN_SKILLSET_META[skillset.id];
        return {
          id: skillset.id,
          label: meta ? i18n._(meta.labelMsg) : skillset.id,
          color: meta?.color ?? color,
          dan: skillset.dan,
          clears: skillset.clears,
          plays: skillset.plays,
        };
      }),
    ]
    : [];
  const openedSection = sections.find((section) => section.id === openSection) ?? null;

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
            className="modal-card-mobile-safe flex max-h-[calc(100dvh-1rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-osu-b3/25 bg-osu-b5 shadow-[0_18px_70px_rgba(0,0,0,0.65)] sm:max-h-[calc(100vh-2rem)]"
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
                      A clear is a {minAccuracyPercent}%+ accuracy pass at 1.0x or DT, on a chart the
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
                <div className="divide-y divide-osu-b3/15">
                  {Array.from({ length: 5 }).map((_, index) => (
                    <div key={index} className="flex items-center gap-3 px-2 py-3">
                      <Skeleton className="h-3 w-3" />
                      <Skeleton className="h-3 w-16" />
                      <Skeleton className="h-5 w-20" />
                      <Skeleton className="ml-auto h-2.5 w-12" />
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
                  {!dan ? (
                    <div className="px-2 pb-2 text-[11px] text-osu-l2">
                      <Trans>
                        Not enough qualifying clears for an estimate yet ({evidence.totalClears} of {quorum}).
                      </Trans>
                    </div>
                  ) : null}
                  {/* The breakdown is the window. Each skill is a column with
                      its course artwork at a size you can actually read, and
                      the clears behind it open underneath the one you pick -
                      so nothing is a list of plays until you ask for one. */}
                  <div className="flex flex-wrap border-b border-osu-b3/20">
                    {sections.map((section) => {
                      const open = openSection === section.id;
                      const sectionBeyond = section.id === "all" && beyond;
                      const bare = section.dan ? danBareLabel(section.dan.label) : null;
                      const sectionLabel = section.dan ? formatDan(sectionBeyond ? bare! : section.dan.label) : null;
                      const sectionImage = bare ? getDanImageSrc(bare, side === "ln" ? "ln" : undefined, keyCount) : null;
                      return (
                        <button
                          key={section.id}
                          type="button"
                          onClick={() => setOpenSection(open ? null : section.id)}
                          aria-expanded={open}
                          title={open ? t`Hide the ${section.label} clears` : t`Show the ${section.label} clears`}
                          className={`relative flex min-w-0 basis-1/2 flex-col items-center gap-1.5 border-l border-osu-b3/15 px-2 py-3 text-center transition-colors first:border-l-0 sm:basis-0 sm:flex-1 ${
                            open ? "bg-osu-b4" : "hover:bg-osu-b4/50"
                          }`}
                        >
                          <span
                            className="max-w-full truncate text-[10px] font-bold uppercase tracking-[0.12em]"
                            style={{ color: section.color }}
                          >
                            {section.label}
                          </span>
                          <span className="flex h-12 items-center justify-center">
                            {sectionImage ? (
                              <img src={sectionImage} alt="" className="h-12 w-12 object-contain" />
                            ) : (
                              <span className="text-2xl font-black leading-none text-osu-b3">-</span>
                            )}
                          </span>
                          {sectionLabel ? (
                            <span className="max-w-full truncate text-sm font-black leading-none text-white">
                              {sectionBeyond ? ">" : "~"}{sectionLabel}
                            </span>
                          ) : (
                            <span className="text-[11px] leading-none text-osu-f1">
                              <Trans>needs {quorum}</Trans>
                            </span>
                          )}
                          <span className="text-[10px] tabular-nums text-osu-f1">
                            {section.clears === 1 ? t`1 clear` : t`${section.clears} clears`}
                          </span>
                          {open ? (
                            <span className="absolute inset-x-0 bottom-0 h-[2px]" style={{ backgroundColor: section.color }} />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                  <AnimatePresence initial={false}>
                    {openedSection ? (
                      <motion.div
                        key={openedSection.id}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.16, ease: "easeOut" }}
                        className="overflow-hidden"
                      >
                        <div className="pt-2">
                          {openedSection.plays.map((clear, index) => (
                            <ClearRow
                              key={`${openedSection.id}:${clear.play.beatmapId}:${clear.play.rate}:${clear.play.scoreId ?? index}`}
                              clear={clear}
                              position={index + 1}
                              color={openedSection.color}
                              formatDan={formatDan}
                              onOpen={() => openDetail(clear)}
                              onPrefetch={() => prefetchLiveMapSearchEntry(clear.play.beatmapId)}
                            />
                          ))}
                          {openedSection.clears > openedSection.plays.length ? (
                            <div className="px-2 pt-1.5 text-[10px] text-osu-f1">
                              <Trans>
                                and {openedSection.clears - openedSection.plays.length} more below these
                              </Trans>
                            </div>
                          ) : null}
                        </div>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
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
  // One line per clear, deliberately unlike the top-plays rows this modal used
  // to borrow: a breakdown row is read as a column of dan credits, so artist,
  // cover art and the played-at line move into the tooltip and only the three
  // numbers that set the estimate keep their own column.
  const played = play.playedAt ? formatTimeAgo(play.playedAt, locale) : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      onPointerEnter={onPrefetch}
      onFocus={onPrefetch}
      className={`group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-osu-b4 ${
        clear.countsTowardDan ? "" : "opacity-60"
      }`}
      title={`${play.artist} - ${play.title} [${play.version}]${played ? ` · ${played}` : ""} · ${
        clear.countsTowardDan
          ? t`This clear backs the estimate`
          : t`Below the credit that sets the estimate`
      } · ${t`view map details`}`}
    >
      <span className="w-4 shrink-0 text-right text-[10px] tabular-nums text-osu-f1">{position}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-osu-l1 group-hover:text-white">
        {play.title}
        <span className="ml-1.5 text-[10px] font-normal text-osu-f1">[{play.version}]</span>
      </span>
      {rateMod ? <ModBadge mod={rateMod.acronym} rate={rateMod.rate} size={0.75} /> : null}
      <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-osu-l2">
        {play.accuracy != null ? formatAccuracy(play.accuracy) : ""}
      </span>
      <span className="w-16 shrink-0 text-right text-[11px] font-black sm:w-20" style={{ color }}>
        {formatDan(clear.chartDanLabel)}
      </span>
      <span
        className="w-9 shrink-0 text-right text-[10px] tabular-nums text-osu-f1"
        title={t`Dan credit this clear earned after the accuracy discount`}
      >
        {clear.creditedDan.toFixed(2)}
      </span>
    </button>
  );
}
