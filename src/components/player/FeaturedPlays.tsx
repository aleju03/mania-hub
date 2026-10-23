import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { Loader2, Search } from "lucide-react";

import { openOnPlainClick } from "./ProfileParts";
import { GradeImg } from "../ui/GradeImg";
import { ModBadge } from "../ui/ModBadge";
import { getDanTierImageSrc } from "#/lib/dan-images";
import { formatAccuracy, formatDate } from "#/lib/format";
import { useBodyScrollLock } from "#/lib/use-body-scroll-lock";
import { useViewerTimeZone } from "#/lib/use-viewer-time-zone";
import {
  PROFILE_PLAY_TITLE_MAX,
  profilePlayHas,
  profilePlayHref,
  type ProfilePlay,
  type ProfilePlayChoice,
  type ProfilePlayMetric,
  type ProfilePlayPick,
  type ProfilePlaySnapshot,
  type ProfilePlaySort,
} from "#/lib/profile-plays";
import { fetchProfilePlayChoices, fetchProfilePlayPreview } from "#/lib/supporter-look-settings";

/* A supporter's own play in place of the newest or oldest top play
   (lib/profile-plays.ts): the same card, under their title, with the number
   they chose to show; and the owner's dialog that picks it. */

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M10.6 2.9l2.5 2.5-7.7 7.7-3.1.6.6-3.1z" />
      <path d="M9.2 4.3l2.5 2.5" />
    </svg>
  );
}

function PlayMetric({ play, show }: { play: ProfilePlaySnapshot; show: ProfilePlayMetric }) {
  const { t } = useLingui();
  if (show === "dan" && play.dan) {
    const image = getDanTierImageSrc(play.dan.label, play.dan.family === "ln" ? "ln" : undefined, play.keyCount || undefined);
    return (
      <div className="flex flex-shrink-0 flex-col items-end">
        {image
          ? <img src={image} alt={play.dan.label} className="h-9 w-auto max-w-none object-contain drop-shadow-[0_2px_6px_rgba(0,0,0,0.5)]" />
          : <div className="text-[28px] font-black leading-none text-osu-orange">{play.dan.label}</div>}
        <div className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">{play.dan.family === "ln" ? t`LN dan` : t`dan`}</div>
      </div>
    );
  }
  const value = show === "msd" ? play.msd : play.pp;
  if (value == null) return null;
  return (
    <div className="flex-shrink-0 text-right">
      <div className={`text-[28px] font-black leading-none tabular-nums ${show === "msd" ? "text-osu-blue" : "text-osu-pink-light"}`}>
        {show === "msd" ? value.toFixed(2) : Math.round(value)}
      </div>
      <div className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">{show === "msd" ? t`MSD` : t`pp`}</div>
    </div>
  );
}

export function FeaturedPlayCard({ entry, link = true, onOpen }: { entry: ProfilePlay; link?: boolean; onOpen?: () => void }) {
  const viewerTimeZone = useViewerTimeZone();
  const { play } = entry;
  const body = (
    <>
      {play.coverUrl && (
        <img
          src={play.coverUrl}
          alt=""
          className="absolute -inset-px h-[calc(100%+2px)] w-[calc(100%+2px)] max-w-none object-cover brightness-[0.38] transition-transform duration-500 group-hover/topplay:scale-[1.03]"
        />
      )}
      <div className="absolute -inset-px bg-gradient-to-r from-black/60 via-black/20 to-black/45" />
      <div className="relative flex h-full items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[9px] font-semibold uppercase tracking-[0.18em] text-osu-pink-light/80">{entry.title}</div>
          <div className="mt-1.5 truncate text-[15px] font-bold text-white">{play.title}</div>
          <div className="truncate text-[10px] text-white/55">{play.artist} [{play.version}]</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <GradeImg grade={play.rank} size={18} />
            {play.mods.map((mod) => <ModBadge key={mod} mod={mod} />)}
            {play.accuracy != null && <span className="text-[10px] tabular-nums text-white/60">{formatAccuracy(play.accuracy)}</span>}
            {play.playedAt && <span className="text-[10px] text-white/45">{formatDate(play.playedAt, viewerTimeZone)}</span>}
          </div>
        </div>
        <PlayMetric play={play} show={entry.show} />
      </div>
    </>
  );
  const frame = "group/topplay relative block h-[120px] overflow-hidden rounded-xl bg-osu-b4 ring-1 ring-inset ring-white/[0.06]";
  return link
    ? <a href={profilePlayHref(play)} target="_blank" rel="noreferrer" onClick={openOnPlainClick(onOpen)} className={`${frame} transition duration-150 hover:ring-osu-pink/40`}>{body}</a>
    : <div className={frame}>{body}</div>;
}

/* The owner's button on either play card: shown while the card is pointed
   at or the button has focus, and always on touch screens, which can't hover.
   (The site's own group-hover variant in styles.css ignores named groups, so
   the card's hover is spelled out.) */
export function FeaturedPlayEditButton({ onClick }: { onClick: () => void }) {
  const { t } = useLingui();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t`Change this play`}
      className="absolute right-2 top-2 z-10 grid h-7 w-7 cursor-pointer place-items-center rounded-md bg-black/40 text-white/70 opacity-0 backdrop-blur-sm transition-[opacity,color,background-color] hover:bg-black/60 hover:text-white focus-visible:opacity-100 [.group\/featured:hover_&]:opacity-100 [@media(hover:none)]:opacity-100"
    >
      <PencilIcon className="h-3.5 w-3.5" />
    </button>
  );
}

const SORT_LABELS: Record<ProfilePlaySort, ReturnType<typeof msg>> = {
  pp: msg`Most pp`,
  recent: msg`Newest`,
  oldest: msg`Oldest`,
  accuracy: msg`Accuracy`,
};

function choiceToSnapshot(choice: ProfilePlayChoice): ProfilePlaySnapshot {
  return { ...choice, beatmapsetId: 0, scoreId: null, rate: 1, msd: null, dan: null };
}

function firstMetric(play: ProfilePlaySnapshot): ProfilePlayMetric | null {
  return (["pp", "msd", "dan"] as const).find((metric) => profilePlayHas(play, metric)) ?? null;
}

/* Picks one slot's play: a title of their own, any play
   the site tracked of the player (searched and sorted), and which number it
   shows. The card above shows the result as it is built. */
export function FeaturedPlayDialog({ slotLabel, current, onSave, onReset, onClose }: {
  /** What the slot shows when left alone ("Newest Top Play"). */
  slotLabel: string;
  current: ProfilePlay | null;
  onSave: (pick: ProfilePlayPick) => Promise<void>;
  onReset: (() => Promise<void>) | null;
  onClose: () => void;
}) {
  const { t, i18n } = useLingui();
  useBodyScrollLock(true);
  const [title, setTitle] = useState(current?.title ?? "");
  const [play, setPlay] = useState<ProfilePlaySnapshot | null>(current?.play ?? null);
  const [show, setShow] = useState<ProfilePlayMetric | null>(current?.show ?? null);
  const [rating, setRating] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProfilePlaySort>("pp");
  const [choices, setChoices] = useState<ProfilePlayChoice[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // A new search or sort starts the list over; typing settles first.
  useEffect(() => {
    const id = ++request.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      fetchProfilePlayChoices({ data: { query, sort, offset: 0 } })
        .then((page) => {
          if (id !== request.current) return;
          setChoices(page.plays);
          setMore(page.more);
        })
        .catch(() => {
          if (id === request.current) setError(t`Your plays didn't load. Try again.`);
        })
        .finally(() => {
          if (id === request.current) setLoading(false);
        });
    }, query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [query, sort, t]);

  const loadMore = () => {
    const id = request.current;
    setLoading(true);
    fetchProfilePlayChoices({ data: { query, sort, offset: choices.length } })
      .then((page) => {
        if (id !== request.current) return;
        setChoices((list) => [...list, ...page.plays]);
        setMore(page.more);
      })
      .finally(() => {
        if (id === request.current) setLoading(false);
      });
  };

  const choose = (choice: ProfilePlayChoice) => {
    const draft = choiceToSnapshot(choice);
    setPlay(draft);
    setShow(firstMetric(draft));
    setRating(true);
    setError(null);
    // MSD and dan at the rate it was played, which a DT play has to work out.
    fetchProfilePlayPreview({ data: { beatmapId: choice.beatmapId, day: choice.day } })
      .then((full) => {
        if (!full) return;
        setPlay((shown) => (shown?.beatmapId === full.beatmapId && shown.day === full.day ? full : shown));
        setShow((picked) => (picked && profilePlayHas(full, picked) ? picked : firstMetric(full)));
      })
      .finally(() => setRating(false));
  };

  const cleanTitle = title.replace(/\s+/g, " ").trim();
  const ready = play && show && cleanTitle && profilePlayHas(play, show) && !rating;
  const save = () => {
    if (!ready || !play || !show) return;
    setSaving(true);
    setError(null);
    onSave({ title: cleanTitle, beatmapId: play.beatmapId, day: play.day, show })
      .then(onClose)
      .catch(() => setError(t`That didn't save. Try again.`))
      .finally(() => setSaving(false));
  };
  const reset = () => {
    if (!onReset) return;
    setSaving(true);
    onReset().then(onClose).catch(() => setError(t`That didn't save. Try again.`)).finally(() => setSaving(false));
  };

  const metricLabel: Record<ProfilePlayMetric, string> = { pp: t`pp`, msd: t`MSD`, dan: t`Dan` };
  const isPicked = (choice: ProfilePlayChoice) => play?.beatmapId === choice.beatmapId && play.day === choice.day;

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[140] flex justify-center overflow-y-auto bg-black/75 p-3 sm:p-6 sm:backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t`Pick a play`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.16, ease: "easeOut" }} className="my-auto flex w-full max-w-[640px] flex-col rounded-2xl border border-osu-b3/30 bg-osu-b5 p-4 sm:p-5">
        <h2 className="text-[15px] font-bold text-white">{t`Pick a play`}</h2>
        <p className="mt-1 text-[12px] text-osu-f1">{t`Any play the site tracked of you, under a title of your own, in place of your ${slotLabel}.`}</p>

        <div className="mt-4">
          {play && show ? (
            <FeaturedPlayCard entry={{ title: cleanTitle || t`Your title`, show, play }} link={false} />
          ) : (
            <div className="grid h-[120px] place-items-center rounded-xl border border-dashed border-osu-b3/50 text-[12px] text-osu-f1">
              {play ? t`This play has no pp, MSD or dan to show.` : t`Pick a play below.`}
            </div>
          )}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="block">
            <span className="text-[11px] font-semibold text-osu-l2">{t`Title`}</span>
            <input
              value={title}
              maxLength={PROFILE_PLAY_TITLE_MAX}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t`Best play`}
              className="mt-1 w-full rounded-lg border border-osu-b3/40 bg-osu-b6 px-3 py-2 text-[13px] text-white outline-none placeholder:text-osu-f1/60 focus:border-osu-pink/60"
            />
          </label>
          <div>
            <span className="text-[11px] font-semibold text-osu-l2">{t`Show`}</span>
            <div className="mt-1 flex rounded-lg bg-osu-b6 p-0.5" role="radiogroup" aria-label={t`Show`}>
              {(["pp", "msd", "dan"] as const).map((metric) => {
                const available = play ? profilePlayHas(play, metric) : false;
                return (
                  <button
                    key={metric}
                    type="button"
                    role="radio"
                    aria-checked={show === metric}
                    disabled={!available}
                    onClick={() => setShow(metric)}
                    title={!available && play ? (metric === "pp" ? t`No pp on this play` : t`Not rated at this rate`) : undefined}
                    className={`min-w-[52px] cursor-pointer rounded-md px-3 py-1.5 text-[12px] font-bold transition-colors disabled:cursor-default disabled:opacity-30 ${show === metric ? "bg-osu-pink text-white" : "text-osu-l2 hover:text-white"}`}
                  >
                    {rating && metric !== "pp" ? <Loader2 className="mx-auto h-3.5 w-3.5 animate-spin" /> : metricLabel[metric]}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-osu-f1" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t`Search your plays`}
              className="w-full rounded-lg border border-osu-b3/40 bg-osu-b6 py-2 pl-8 pr-3 text-[12.5px] text-white outline-none placeholder:text-osu-f1/60 focus:border-osu-pink/60"
            />
          </div>
          <div className="flex rounded-lg bg-osu-b6 p-0.5">
            {(Object.keys(SORT_LABELS) as ProfilePlaySort[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setSort(key)}
                className={`cursor-pointer rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${sort === key ? "bg-osu-b3 text-white" : "text-osu-f1 hover:text-white"}`}
              >
                {i18n._(SORT_LABELS[key])}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-2 h-[300px] overflow-y-auto rounded-lg bg-osu-b6/60 p-1 [scrollbar-width:thin]">
          {choices.map((choice) => (
            <button
              key={`${choice.day}:${choice.beatmapId}`}
              type="button"
              onClick={() => choose(choice)}
              className={`flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors ${isPicked(choice) ? "bg-osu-pink/15" : "hover:bg-osu-b3/40"}`}
            >
              <span className="h-9 w-14 shrink-0 overflow-hidden rounded bg-osu-b4">
                {choice.coverUrl && <img src={choice.coverUrl} alt="" loading="lazy" className="h-full w-full object-cover" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-semibold text-white">{choice.title}</span>
                <span className="block truncate text-[10.5px] text-osu-f1">[{choice.version}]</span>
              </span>
              {/* Fixed columns, so the grade and mods line up row to row. */}
              <span className="flex w-[56px] shrink-0 justify-end gap-1">
                {choice.mods.slice(0, 2).map((mod) => <ModBadge key={mod} mod={mod} size={0.72} />)}
              </span>
              {/* The grade art is twice as wide as tall: 34 wide stands as tall as the mods. */}
              <span className="flex w-9 shrink-0 justify-center"><GradeImg grade={choice.rank} size={34} /></span>
              <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-osu-l2">{choice.accuracy != null ? formatAccuracy(choice.accuracy) : ""}</span>
              <span className="w-12 shrink-0 text-right text-[11px] font-bold tabular-nums text-osu-pink-light">{choice.pp ? `${Math.round(choice.pp)}pp` : ""}</span>
              <span className="hidden w-[74px] shrink-0 text-right text-[10.5px] text-osu-f1 sm:block">{choice.day}</span>
            </button>
          ))}
          {loading && <div className="grid h-12 place-items-center"><Loader2 className="h-4 w-4 animate-spin text-osu-pink" /></div>}
          {!loading && choices.length === 0 && (
            <div className="grid h-full place-items-center text-[12px] text-osu-f1">{query ? t`No plays match that.` : t`No tracked plays yet.`}</div>
          )}
          {!loading && more && (
            <button type="button" onClick={loadMore} className="mt-1 w-full cursor-pointer rounded-md py-2 text-[11.5px] font-semibold text-osu-f1 transition-colors hover:bg-osu-b3/40 hover:text-white">
              {t`Show more`}
            </button>
          )}
        </div>

        {error && <p className="mt-3 text-[12px] text-osu-red-light">{error}</p>}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {onReset && (
            <button type="button" onClick={reset} disabled={saving} className="mr-auto cursor-pointer text-[11.5px] text-osu-f1 transition-colors hover:text-white disabled:opacity-50">
              {t`Back to my ${slotLabel}`}
            </button>
          )}
          <button type="button" onClick={onClose} className="cursor-pointer rounded-lg px-3.5 py-2 text-[12.5px] font-bold text-osu-l2 transition-colors hover:bg-osu-b3/40 hover:text-white">
            {t`Cancel`}
          </button>
          <button
            type="button"
            disabled={!ready || saving}
            onClick={save}
            className="cursor-pointer rounded-lg bg-osu-pink px-4 py-2 text-[12.5px] font-bold text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-40"
          >
            {saving ? t`Saving...` : t`Put it on my profile`}
          </button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
