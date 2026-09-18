import { skillPlaySharePath } from "../../lib/skill-play-share";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, CircleHelp, X } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  fetchLivePlayerDanEvidenceDirect,
  loadLiveMapSearchEntry,
  peekLiveMapSearchEntry,
  prefetchLiveMapSearchEntry,
  type LiveMapSearchEntry,
  type LivePlayerDanCourseEvidence,
  type LivePlayerDanEvidence,
  type LivePlayerDanEvidencePlay,
  type LivePlayerDanPendingPlay,
  type LivePlayerSkillPlay,
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

// How many more clears one "Load more" click appends to the "all" list.
const MORE_CLEARS_PAGE = 50;

interface DanEvidenceModalProps {
  userId: number;
  username: string;
  keyCount: number;
  side: "rc" | "ln";
  onClose: () => void;
  /* Opening a score card belongs to the profile, which owns the card and knows
     the viewer it is by; the window only hands the run up. A graveyard course
     has no osu! page to link, so this is the only proof it can offer. */
  onOpenCourseScore?: (course: LivePlayerDanCourseEvidence) => void;
}

export function DanEvidenceModal({ userId, username, keyCount, side, onClose, onOpenCourseScore }: DanEvidenceModalProps) {
  const { t, i18n } = useLingui();
  const [evidence, setEvidence] = useState<LivePlayerDanEvidence | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Which row's clears are unfolded, if any. Everything is collapsed on open:
  // the breakdown is a handful of dan numbers, and the plays behind each one
  // are the follow-up question, not the answer.
  const [openSection, setOpenSection] = useState<string | null>(null);
  // The "still analyzing" list takes the breakdown's place while it is open:
  // one modal, one question at a time, and a way back at the top.
  const [pendingOpen, setPendingOpen] = useState(false);
  // The map-detail view for a clicked clear, stacked on top of this list,
  // same pattern as SkillPlaysModal: opens on the click with what the row
  // knows and upgrades in place when the catalog entry lands.
  // `clear` is null for a play still analyzing: it has no dan marks to draw.
  const [detail, setDetail] = useState<
    { play: LivePlayerSkillPlay; clear: LivePlayerDanEvidencePlay | null; entry: LiveMapSearchEntry; status: "ready" | "pending" | "missing" | "error" } | null
  >(null);
  // The "all clears" list opens on the window the average reads; the rest
  // pages in a batch at a time, appended under the first twenty.
  const [moreClears, setMoreClears] = useState<{ loading: boolean; plays: LivePlayerDanEvidencePlay[] }>({ loading: false, plays: [] });
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
    setMoreClears({ loading: false, plays: [] });
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

  const openDetail = (play: LivePlayerSkillPlay, clear: LivePlayerDanEvidencePlay | null) => {
    const cached = peekLiveMapSearchEntry(play.beatmapId);
    if (cached !== undefined) {
      setDetail({ play, clear, entry: cached ?? stubEntry(play), status: cached ? "ready" : "missing" });
      return;
    }
    setDetail({ play, clear, entry: stubEntry(play), status: "pending" });
    loadLiveMapSearchEntry(play.beatmapId)
      .then((entry) => {
        if (!mountedRef.current) return;
        setDetail((current) => (
          current && current.play.beatmapId === play.beatmapId && current.status === "pending"
            ? { play, clear, entry: entry ?? current.entry, status: entry ? "ready" : "missing" }
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

  // The same evidence read, offset past what is already on screen. Only the
  // "all" list pages, so only its slice is kept; a failure re-enables the
  // button and the next click asks for the same page again.
  const loadMoreClears = () => {
    if (!evidence || moreClears.loading) return;
    const offset = evidence.clears.length + moreClears.plays.length;
    setMoreClears((current) => ({ ...current, loading: true }));
    fetchLivePlayerDanEvidenceDirect(userId, keyCount, side, { limit: MORE_CLEARS_PAGE, offset })
      .then((payload) => {
        if (!mountedRef.current) return;
        setMoreClears((current) => ({ loading: false, plays: [...current.plays, ...payload.clears] }));
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setMoreClears((current) => ({ ...current, loading: false }));
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
  // Present only when a verified dan course clear sat above the averaged
  // estimate. The badge never says so - the number is the number - but the
  // window has to explain why the headline outruns the skill rows under it.
  const courseClear = evidence?.courseClear ?? null;
  const courseName = courseClear?.courseName ?? "";
  // The formula rides on the number rather than in a sentence of its own: when
  // the client showed something else (a lazer play displays ScoreV2, and the
  // ladder is judged on stable), naming it is the whole explanation, and the
  // score card behind the link shows the player's own number anyway. Both
  // words are client/formula names, untranslated like the mod acronyms.
  const courseAccuracy = courseClear
    ? formatAccuracy(courseClear.accuracy) + (courseClear.displayedAccuracy != null ? (courseClear.currency === "v2" ? " ScoreV2" : " stable") : "")
    : "";
  const courseBar = courseClear ? formatAccuracy(courseClear.bar) : "";
  const courseUnderBar = courseClear != null && courseClear.accuracy < courseClear.bar;
  // osu! only keeps a score page for a map with a leaderboard. The loved
  // courses have one; the graveyard ones open the site's own card instead.
  //
  // Only a real solo id gets linked. The 2-year archive kept one id column for
  // years and its ids do not resolve: the id on the sample row 404s on osu! in
  // both URL forms, and none of the 2,391 archived course rows carry a solo id
  // at all. Guessing the form there buys a dead link, so anything without one
  // opens the site's own card, which is built from data actually held.
  const courseScoreUrl = (() => {
    if (!courseClear || courseClear.soloScoreId == null) return null;
    const status = courseClear.beatmapStatus;
    if (status !== "loved" && status !== "ranked" && status !== "approved" && status !== "qualified") return null;
    return `https://osu.ppy.sh/scores/${courseClear.soloScoreId}`;
  })();
  const danLabel = dan ? (beyond ? danBareLabel(dan.label) : dan.label) : "";
  const image = dan ? getDanImageSrc(danBareLabel(danLabel), side === "ln" ? "ln" : undefined, keyCount) : null;
  const suffix = dan && !beyond ? danTierSuffix(dan.label) : "";
  const minAccuracyPercent = Math.round((evidence?.minAccuracy ?? 0.92) * 100);
  const barAccuracyPercent = Math.round((evidence?.barAccuracy ?? 0.96) * 100);
  const quorum = evidence?.quorum ?? 4;
  const averageWindow = evidence?.averageWindow ?? 20;

  // The window opens on the breakdown, never on a wall of plays: every row is
  // one dan number, and the clears behind it unfold on the click. The headline
  // estimate leads as the first row and is the average of the skill rows next
  // to it, so "all clears" and "your jack clears" are the same gesture instead
  // of two different-looking surfaces.
  const sections = evidence
    ? [
      {
        id: "all",
        skillsetClear: undefined as LivePlayerDanCourseEvidence | undefined,
        label: t`All clears`,
        color,
        dan: evidence.dan,
        clears: evidence.totalClears,
        weightedClears: evidence.weightedClears ?? Math.min(evidence.totalClears, averageWindow),
        plays: moreClears.plays.length > 0 ? [...evidence.clears, ...moreClears.plays] : evidence.clears,
      },
      ...evidence.skillsets.map((skillset) => {
        const meta = DAN_SKILLSET_META[skillset.id];
        return {
          id: skillset.id,
          skillsetClear: skillset.skillsetClear,
          label: meta ? i18n._(meta.labelMsg) : skillset.id,
          color: meta?.color ?? color,
          dan: skillset.dan,
          clears: skillset.clears,
          weightedClears: skillset.weightedClears ?? Math.min(skillset.clears, averageWindow),
          plays: skillset.plays,
        };
      }),
    ]
    : [];
  // 7K LN's headline follows General rather than averaging the four tiles,
  // because the scene makes almost no release (or inverse) charts near the
  // top and those tiles top out where the maps do. Named here so the caveat
  // under the columns can say which tile the estimate follows.
  const anchorSection = evidence?.anchorSkillset
    ? sections.find((section) => section.id === evidence.anchorSkillset) ?? null
    : null;
  const openedSection = sections.find((section) => section.id === openSection) ?? null;
  // The loading state stands in for the same column strip the loaded window
  // opens on, so nothing jumps when the estimate lands. Only 7K LN has skill
  // buckets on the LN side; every other LN keymode is the one "all" column.
  const skeletonColumns = side === "ln" && keyCount !== 7 ? 1 : 5;
  // A lone column has nothing to sit beside, so it takes the whole row instead
  // of half of one - otherwise the only reading in the window hugs the left
  // edge on phones, where the columns wrap two to a row.
  const columnBasis = (count: number) => (count === 1 ? "basis-full" : "basis-1/2");

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
                  <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-osu-f1">
                    <Trans>{keyCount}K {sideLabel} dan</Trans>
                    {/* The rules used to be spelled out under the title. Everyone has read
                        the article by now, so this is just a quiet way back to it. */}
                    <Link
                      to="/dan-estimates"
                      aria-label={t`How dans are estimated`}
                      title={t`How dans are estimated`}
                      className="text-osu-f1/60 transition-colors hover:text-white"
                    >
                      <CircleHelp size={12} />
                    </Link>
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
                  {courseClear ? (
                    <p className="mt-1.5 max-w-2xl text-[11px] leading-relaxed text-white/70 sm:text-xs">
                      {courseUnderBar ? (
                        <Trans>{courseAccuracy} on {courseName}, under its {courseBar}.</Trans>
                      ) : (
                        <Trans>Cleared {courseName} at {courseAccuracy}.</Trans>
                      )}{' '}
                      {courseScoreUrl ? (
                        <a
                          href={courseScoreUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-osu-pink-light underline underline-offset-2 transition-colors hover:text-white"
                        >
                          <Trans>See the score</Trans>
                        </a>
                      ) : onOpenCourseScore ? (
                        <button
                          type="button"
                          onClick={() => onOpenCourseScore(courseClear)}
                          className="text-osu-pink-light underline underline-offset-2 transition-colors hover:text-white"
                        >
                          <Trans>See the score</Trans>
                        </button>
                      ) : null}
                    </p>
                  ) : null}
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
                ) : loading ? (
                  <Skeleton className="ml-auto h-14 w-14 shrink-0 rounded-full" />
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
                <div className="flex flex-wrap border-b border-osu-b3/20">
                  {Array.from({ length: skeletonColumns }).map((_, index) => (
                    <div
                      key={index}
                      className={`flex min-w-0 ${columnBasis(skeletonColumns)} flex-col items-center gap-1.5 border-l border-osu-b3/15 px-2 py-3 first:border-l-0 sm:basis-0 sm:flex-1`}
                    >
                      <Skeleton className="h-3 w-14" />
                      <Skeleton className="h-12 w-12 rounded-full" />
                      <Skeleton className="h-3.5 w-16" />
                      <Skeleton className="h-2.5 w-12" />
                    </div>
                  ))}
                </div>
              ) : pendingOpen && evidence?.pending && evidence.pending.length > 0 ? (
                <PendingPlaysView evidence={evidence} onBack={() => setPendingOpen(false)} onOpen={(play) => openDetail(play, null)} />
              ) : !evidence || (evidence.clears.length === 0 && !evidence.skillsets.some((skill) => skill.skillsetClear)) ? (
                <div className="px-4 py-14 text-center">
                  <div className="text-sm font-semibold text-osu-l2">
                    {error ? t`Could not load the clears` : t`No qualifying clears yet`}
                  </div>
                  <div className="mt-1 text-xs text-osu-f1">
                    {error ?? t`The estimate appears once ${quorum} clears at ${minAccuracyPercent}%+ accuracy land on rated charts. A ${barAccuracyPercent}%+ pass credits the chart's full level; anything under that credits less.`}
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
                  {/* A profile with nothing rated yet is exactly the one
                      whose plays are all still in line. */}
                  {evidence ? (
                    <div className="mt-4">
                      <PendingPlaysNote evidence={evidence} onOpen={() => setPendingOpen(true)} />
                    </div>
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
                          className={`relative flex min-w-0 ${columnBasis(sections.length)} flex-col items-center gap-1.5 border-l border-osu-b3/15 px-2 py-3 text-center transition-colors first:border-l-0 sm:basis-0 sm:flex-1 ${
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
                              {sectionBeyond ? ">" : section.skillsetClear ? "" : "~"}{sectionLabel}
                            </span>
                          ) : (
                            <span className="text-[11px] leading-none text-osu-f1">
                              <Trans>needs {quorum}</Trans>
                            </span>
                          )}
                          <span className="text-[10px] tabular-nums text-osu-f1">
                            {/* Under the averaging window the count reads as
                                progress toward it: this dan is averaged from
                                fewer plays than it wants. */}
                            {section.skillsetClear ? t`Verified clear` : t`${section.clears} plays`}
                            {!section.skillsetClear && section.weightedClears < averageWindow ? (
                              <span className="ml-1">
                                {t`· ${(Math.floor(section.weightedClears * 10) / 10).toLocaleString("en-US")}/${averageWindow} counted`}
                              </span>
                            ) : null}
                          </span>
                          {open ? (
                            <span className="absolute inset-x-0 bottom-0 h-[2px]" style={{ backgroundColor: section.color }} />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                  {/* Shown only while some column is short of the window, so a
                      filled-out breakdown carries no caveat at all. */}
                  {sections.some((section) => !section.skillsetClear && section.weightedClears < averageWindow) ? (
                    <div className="px-2 pt-2 text-[11px] text-osu-f1">
                      <Trans>
                        Each skillset averages up to {averageWindow} clears. Only your two best rate plays per chart count.
                        With less evidence, it averages what you have and the estimate is still filling in.
                      </Trans>
                    </div>
                  ) : null}
                  {anchorSection && sections.length > 2 ? (
                    <div className="px-2 pt-2 text-[11px] text-osu-f1">
                      <Trans>
                        The estimate stays within one level of your {anchorSection.label} dan,
                        whichever way the other skillsets point.
                      </Trans>
                    </div>
                  ) : null}
                  {/* A pass that ran out of budget publishes what it has; say
                      so here, where the dan is read, not only on the card. */}
                  <PendingPlaysNote evidence={evidence} onOpen={() => setPendingOpen(true)} />
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
                          {/* Only when the clear itself is not in the list
                              under it: a stored play of the practice chart
                              already carries the credential in its own row. */}
                          {openedSection.skillsetClear && !openedSection.plays.some((clear) =>
                            clear.play.beatmapId === openedSection.skillsetClear!.beatmapId) ? (
                            <CredentialRow
                              credential={openedSection.skillsetClear}
                              color={openedSection.color}
                              formatDan={formatDan}
                              onOpen={onOpenCourseScore ? () => onOpenCourseScore(openedSection.skillsetClear!) : undefined}
                            />
                          ) : null}
                          {openedSection.plays.map((clear, index) => (
                            <ClearRow
                              key={`${openedSection.id}:${clear.play.beatmapId}:${clear.play.rate}:${clear.play.scoreId ?? index}`}
                              clear={clear}
                              position={index + 1}
                              color={openedSection.color}
                              formatDan={formatDan}
                              onOpen={() => openDetail(clear.play, clear)}
                              onPrefetch={() => prefetchLiveMapSearchEntry(clear.play.beatmapId)}
                            />
                          ))}
                          {openedSection.clears > openedSection.plays.length ? (
                            openedSection.id === "all" ? (
                              /* Only the "all" list can grow: the skillset
                                 lists already ship every clear their average
                                 reads, and past those the note says so. */
                              <div className="flex items-baseline gap-2 px-2 pt-1.5 text-[10px]">
                                <button
                                  type="button"
                                  onClick={loadMoreClears}
                                  disabled={moreClears.loading}
                                  className="font-semibold text-osu-pink-light transition-colors hover:text-white disabled:text-osu-f1"
                                >
                                  <Trans>Load more</Trans>
                                </button>
                                <span className="text-osu-f1">
                                  <Trans>
                                    and {openedSection.clears - openedSection.plays.length} more below these
                                  </Trans>
                                </span>
                              </div>
                            ) : (
                              <div className="px-2 pt-1.5 text-[10px] text-osu-f1">
                                <Trans>
                                  and {openedSection.clears - openedSection.plays.length} more below these
                                </Trans>
                              </div>
                            )
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
            sharePath: skillPlaySharePath(username, detail.play.scoreId, detail.play.keyCount, detail.play.beatmapId, `dan:${side}`),
            score: detail.play.score,
            skillRatings: detail.play.skillRatings,
            rating: detail.clear?.chartDan ?? 0,
            ratingLabel: t`chart dan`,
            ratingColor: color,
            // A play still analyzing has no dan marks yet: the card says so
            // where the rating would print, the same way an unrated skill
            // play does, and the rail stays empty until it is rated.
            ...(detail.clear ? {
              // The chart's dan and the level this clear credited are the rail's
              // two marks, so the score screen reads them as dan rather than as a
              // generic rating pair.
              dan: {
                chartRating: detail.clear.chartDan,
                chartLabel: detail.clear.chartDanLabel,
                creditedRating: detail.clear.creditedDan,
                creditedLabel: detail.clear.creditedDanLabel,
                accuracy: detail.clear.clearAccuracy,
                family: side,
              },
            } : { ratingExcluded: true, ratingExclusionReason: "pending_calibration" as const }),
          }}
        />
      ) : null}
    </>
  );
}

// The "still analyzing" line. Only the count is the link: it swaps the whole
// breakdown for the list of waiting plays (PendingPlaysView), the way a
// column opens its clears, but one level deeper. Older backends send the
// count alone, and then it stays a plain line.
function PendingPlaysNote({ evidence, onOpen }: { evidence: LivePlayerDanEvidence; onOpen: () => void }) {
  const { t } = useLingui();
  const pendingPlays = evidence.pendingPlays ?? 0;
  if (pendingPlays <= 0) return null;
  const count = evidence.pending && evidence.pending.length > 0
    ? (
      <button
        type="button"
        onClick={onOpen}
        title={t`See which plays are waiting`}
        className="cursor-pointer rounded-sm font-semibold text-osu-l2 transition-colors hover:text-white"
      >
        {t`${pendingPlays} plays`}
      </button>
    )
    : <span>{t`${pendingPlays} plays`}</span>;
  return (
    <div className="px-2 pt-2 text-[11px] text-osu-f1">
      <Trans>{count} still analyzing, so this estimate can still move.</Trans>
    </div>
  );
}

// The waiting plays, in the breakdown's place: a back link where the columns
// were, then one row per play with why it waits.
function PendingPlaysView({
  evidence,
  onBack,
  onOpen,
}: {
  evidence: LivePlayerDanEvidence;
  onBack: () => void;
  onOpen: (play: LivePlayerSkillPlay) => void;
}) {
  const { t } = useLingui();
  const pendingPlays = evidence.pendingPlays ?? 0;
  const pending = evidence.pending ?? [];
  return (
    <div>
      <div className="flex items-center gap-2 px-2 pb-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md py-1 pr-2 text-[11px] font-semibold text-osu-f1 transition-colors hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          <Trans>Back</Trans>
        </button>
        <span className="text-[11px] text-osu-f1">
          <Trans>{pendingPlays} plays still analyzing, so this estimate can still move.</Trans>
        </span>
      </div>
      {pending.map((entry, index) => (
        <PendingRow
          key={`pending:${entry.play.beatmapId}:${entry.play.rate}:${entry.play.scoreId ?? index}`}
          entry={entry}
          position={index + 1}
          onOpen={() => onOpen(entry.play)}
          onPrefetch={() => prefetchLiveMapSearchEntry(entry.play.beatmapId)}
        />
      ))}
      {pending.length < pendingPlays ? (
        <div className="px-2 pt-1 text-[10px] text-osu-f1">{t`Showing the newest ${pending.length}.`}</div>
      ) : null}
    </div>
  );
}

// A play the rating has not reached yet, in the clear rows' grammar minus the
// dan column: the reason it waits sits where the credit would.
function PendingRow({
  entry,
  position,
  onOpen,
  onPrefetch,
}: {
  entry: LivePlayerDanPendingPlay;
  position: number;
  onOpen: () => void;
  onPrefetch: () => void;
}) {
  const { t } = useLingui();
  const locale = useLocale();
  const play = entry.play;
  const rateMod = rateModFor(play.rate, play.rateMod);
  const played = play.playedAt ? formatTimeAgo(play.playedAt, locale) : null;
  const reason = entry.reason === "revision"
    ? t`chart changed on osu!, waiting for a fresh check`
    : entry.reason === "rate_vibro"
      ? t`waiting for a vibro check`
      : t`waiting for the next rating pass`;
  return (
    <button
      type="button"
      onClick={onOpen}
      onPointerEnter={onPrefetch}
      onFocus={onPrefetch}
      className="group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-osu-b4"
      title={`${play.artist} - ${play.title} [${play.version}]${played ? ` · ${played}` : ""} · ${reason} · ${t`view map details`}`}
    >
      <span className="w-4 shrink-0 text-right text-[10px] tabular-nums text-osu-f1">{position}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-semibold text-osu-l1 group-hover:text-white">
          {play.title}
          <span className="ml-1.5 text-[10px] font-normal text-osu-f1">[{play.version}]</span>
        </span>
        {/* A phone has no hover for the title tooltip and no room for a
            reason column, so the reason takes a second line under the chart. */}
        <span className="block truncate text-[10px] text-osu-f1 sm:hidden">{reason}</span>
      </span>
      {rateMod ? <ModBadge mod={rateMod.acronym} rate={rateMod.rate} size={0.75} /> : null}
      <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-osu-l2">
        {play.accuracy != null ? formatAccuracy(play.accuracy) : ""}
      </span>
      <span className="hidden shrink-0 text-right text-[10px] text-osu-f1 sm:block">{reason}</span>
    </button>
  );
}

// The practice-chart credential, in the same row grammar as the clears under
// it: the skillset header already says "Verified clear", so the row only has to
// name the chart and show what it granted. Everything the old panel spelled out
// lives in the tooltip.
function CredentialRow({
  credential,
  color,
  formatDan,
  onOpen,
}: {
  credential: LivePlayerDanCourseEvidence;
  color: string;
  formatDan: (label: string) => string;
  onOpen?: () => void;
}) {
  const { t } = useLingui();
  const currency = credential.displayedAccuracy != null
    ? credential.currency === "v2" ? " (ScoreV2)" : " (stable)"
    : "";
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      className="group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors enabled:cursor-pointer enabled:hover:bg-osu-b4"
      title={`${credential.artist} - ${credential.title} [${credential.version}] · ${
        t`The ${formatDan(credential.level)} chart of this skillset ladder: clearing it sets the level outright, and a higher estimate is kept`
      }${onOpen ? ` · ${t`view the score`}` : ""}`}
    >
      <span className="w-4 shrink-0 text-right text-[10px] leading-none" style={{ color }} aria-hidden>✓</span>
      <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-osu-l1 group-hover:text-white">
        {credential.title}
        <span className="ml-1.5 text-[10px] font-normal text-osu-f1">[{credential.version}]</span>
      </span>
      <span
        className="w-12 shrink-0 text-right text-[11px] tabular-nums text-osu-l2"
        title={t`Accuracy this clear was judged on, against its ${formatAccuracy(credential.bar)} bar` + currency}
      >
        {formatAccuracy(credential.accuracy)}
      </span>
      <span className="w-16 shrink-0 text-right text-[11px] font-black sm:w-20" style={{ color }}>
        {formatDan(credential.label)}
      </span>
    </button>
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
  const rateMod = rateModFor(play.rate, play.rateMod);
  // One line per clear, deliberately unlike the top-plays rows this modal used
  // to borrow: a breakdown row is read as a column of dan credits, so artist,
  // cover art and the played-at line move into the tooltip and only the three
  // numbers that set the estimate keep their own column.
  const played = play.playedAt ? formatTimeAgo(play.playedAt, locale) : null;
  const reduced = clear.creditedDan < clear.chartDan;
  return (
    <button
      type="button"
      onClick={onOpen}
      onPointerEnter={onPrefetch}
      onFocus={onPrefetch}
      className={`group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-osu-b4 ${
        clear.ignoredAsStray ? "opacity-45" : clear.countsTowardDan ? "" : "opacity-60"
      }`}
      title={`${play.artist} - ${play.title} [${play.version}]${played ? ` · ${played}` : ""}${
        clear.credential
          ? ` · ${t`The ${formatDan(clear.credential.level)} chart of this skillset ladder: the clear sets that level, whatever the estimator reads the file as`}`
          : reduced
            ? ` · ${t`Below the full-clear requirement: reduced credit, even if the dan label stays the same`}`
            : clear.creditedDanLabel !== clear.chartDanLabel
              ? ` · ${t`A ${formatDan(clear.chartDanLabel)} chart, credited as ${formatDan(clear.creditedDanLabel)} at this accuracy`}`
              : ""
      } · ${
        clear.ignoredAsStray
          ? t`Not counted: this clear sits more than five levels under the best clears in this list, so it is left out of the average`
          : clear.countsTowardDan
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
      <span
        className="w-12 shrink-0 text-right text-[11px] tabular-nums text-osu-l2"
        title={t`Accuracy this clear was judged on, in the ladder's own scoring`}
      >
        {formatAccuracy(clear.clearAccuracy)}
      </span>
      {clear.creditedDanLabel !== clear.chartDanLabel ? (
        <span className="shrink-0 text-right text-[10px] tabular-nums text-osu-f1">
          {formatDan(clear.chartDanLabel)}
        </span>
      ) : null}
      {/* An ignored clear keeps its row and its number, struck through: the
          player did clear it, it just does not set the level. */}
      {clear.ignoredAsStray ? (
        <span className="shrink-0 text-[10px] text-osu-f1">{t`not counted`}</span>
      ) : null}
      {!clear.ignoredAsStray && clear.averagingWeight != null && clear.averagingWeight < 1 ? (
        <span
          className="shrink-0 text-[10px] tabular-nums text-osu-f1"
          title={clear.averagingWeight === 0
            ? t`Outside this average's best-clear window`
            : t`Influence in this average; Dan credit is unchanged`}
        >
          {clear.averagingWeight === 0 ? t`outside average`
            : clear.averagingWeight < 0.01 ? t`<1% weight`
              : t`${Math.round(clear.averagingWeight * 100)}% weight`}
        </span>
      ) : null}
      <span
        className={`w-16 shrink-0 text-right text-[11px] font-black sm:w-20 ${clear.ignoredAsStray ? "line-through" : ""}`}
        style={{ color }}
      >
        {formatDan(clear.creditedDanLabel)}
      </span>
    </button>
  );
}
