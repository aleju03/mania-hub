import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Loader2, X } from "lucide-react";
import {
  loadLiveMapSearchEntry,
  submitLiveMissingScore,
  type LiveMapSearchEntry,
  type LiveScoreSubmissionFailure,
  type LiveScoreSubmissionPlay,
} from "../../lib/live-backend";
import { formatAccuracy, formatPP, formatTimeAgo } from "../../lib/format";
import { getModDisplayList } from "../../lib/score";
import { ModBadge } from "../ui/ModBadge";
import { useLocale } from "../../lib/locale-context";
import type { AppLocale } from "../../lib/locale";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";

/*
 * Adding a missing score to a player, from their profile page.
 *
 * Anyone can do it, for anyone: the pasted link is fetched from the osu! API
 * and only counts if the score really belongs to this player, so the score
 * itself is the proof. What it earns is decided downstream by the same rules
 * a tracked score faces - this dialog promises nothing beyond "it's in".
 *
 * Shaped as a paste bar rather than a form: pasting is the whole interaction,
 * so the field is the dialog until a play lands, and then the play takes the
 * dialog over as its own score panel. That panel is also the receipt - it
 * names the chart the backend actually matched, which is the only way the
 * submitter can tell a wrong link from a right one. Older ones fall to thin
 * rows underneath, since the bar stays open for the next link.
 */

/* Focusing the field is a convenience for a mouse and keyboard: the link is
   already on the clipboard, so the caret is where the next keystroke belongs.
   On a phone the same call throws the on-screen keyboard over half the dialog
   before the visitor has decided to type anything, so a coarse pointer opens
   the bar unfocused and waits to be tapped. */
function focusOnDesktop(input: HTMLInputElement | null): void {
  if (!input || typeof window === "undefined") return;
  if (window.matchMedia?.("(pointer: coarse)").matches) return;
  input.focus();
}

interface AcceptedPlay {
  key: string;
  play: LiveScoreSubmissionPlay;
  alreadyTracked: boolean;
  /* Catalog detail (cover, keymode), fetched after the fact. Null until it
     lands, and for charts the map catalog does not know. */
  entry: LiveMapSearchEntry | null;
}

export function AddScoreModal({
  userId,
  username,
  onClose,
  onSubmitted,
}: {
  userId: number;
  username: string;
  onClose: () => void;
  /** A score was newly stored (not an already-tracked resubmission). */
  onSubmitted?: () => void;
}) {
  const { t } = useLingui();
  const locale = useLocale();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<AcceptedPlay[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);

  useBodyScrollLock(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    focusOnDesktop(inputRef.current);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const failureMessage = (reason: LiveScoreSubmissionFailure, owner?: string | null): string => {
    switch (reason) {
      case "invalid_link":
        return t`That doesn't look like an osu! score link.`;
      case "score_not_found":
        return t`No score found at that link.`;
      case "not_mania":
        return t`That score isn't an osu!mania score.`;
      case "not_owned":
        return owner
          ? t`That score belongs to a different player (${owner}).`
          : t`That score belongs to a different player.`;
      case "not_passed":
        return t`That score is a fail, so it can't count.`;
      case "player_untracked":
        return t`This player's country isn't tracked yet.`;
      case "player_not_found":
        return t`This player can't receive scores.`;
      case "osu_unavailable":
        return t`osu! didn't answer. Try again in a minute.`;
      case "rate_limited":
        return t`Too many submissions right now. Try again later.`;
      case "failed":
        return t`Could not send that. Try again.`;
    }
  };

  const send = async (raw: string) => {
    const value = raw.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await submitLiveMissingScore(userId, value);
      if (!mountedRef.current) return;
      if (!result.ok) {
        setError(failureMessage(result.reason, result.owner));
        return;
      }
      setLink("");
      const key = `${result.play.scoreId}:${Date.now()}`;
      setAccepted((current) => [
        { key, play: result.play, alreadyTracked: result.alreadyTracked, entry: null },
        ...current.filter((item) => item.play.scoreId !== result.play.scoreId),
      ]);
      if (!result.alreadyTracked) onSubmitted?.();
      if (result.play.beatmapId != null) void fillEntry(key, result.play.beatmapId);
    } catch {
      if (mountedRef.current) setError(t`Could not send that. Try again.`);
    } finally {
      if (mountedRef.current) {
        setBusy(false);
        focusOnDesktop(inputRef.current);
      }
    }
  };

  /* The submission answers with the score, not the chart, so the cover art and
     the keymode come from the map catalog afterwards. A miss leaves the panel
     on what the score itself carried. */
  const fillEntry = async (key: string, beatmapId: number) => {
    try {
      const entry = await loadLiveMapSearchEntry(beatmapId);
      if (!mountedRef.current || !entry) return;
      setAccepted((current) => current.map((item) => (item.key === key ? { ...item, entry } : item)));
    } catch {
      /* the panel reads fine without it */
    }
  };

  const [latest, ...older] = accepted;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-black/80 py-3 pl-3 pr-[calc(0.75rem+var(--modal-scrollbar-compensation,0px))] backdrop-blur-sm sm:py-4 sm:pl-4 sm:pr-[calc(1rem+var(--modal-scrollbar-compensation,0px))]"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.16 }}
      >
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={t`Add a missing score`}
          layout
          className="modal-card-mobile-safe relative my-auto w-full max-w-xl overflow-hidden rounded-2xl border border-osu-b3/25 bg-osu-b5 shadow-[0_18px_70px_rgba(0,0,0,0.65)]"
          initial={{ opacity: 0, y: 10, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.985 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >
          {/* Over the art once a play owns the top of the dialog; before that
              the dialog is one row, so it rides the end of that row instead of
              landing on top of the paste button. */}
          {latest ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={t`Close`}
              className="absolute right-2.5 top-2.5 z-20 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-black/45 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/65 hover:text-white"
            >
              <X size={16} />
            </button>
          ) : null}

          <AnimatePresence mode="popLayout" initial={false}>
            {latest ? <ScorePanel key={latest.key} item={latest} locale={locale} /> : null}
          </AnimatePresence>

          {older.length > 0 ? (
            <div className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
              {older.map((item) => (
                <AcceptedRow key={item.key} item={item} />
              ))}
            </div>
          ) : null}

          {error ? (
            <p className="border-t border-white/[0.06] px-4 pt-2.5 text-[11.5px] text-osu-red-light sm:px-5">{error}</p>
          ) : null}

          <form
            className={`relative flex items-center gap-3 px-4 sm:px-5 ${latest || error ? "py-3" : "py-4"} ${
              latest && !error ? "border-t border-white/[0.06]" : ""
            }`}
            onSubmit={(event) => {
              event.preventDefault();
              void send(link);
            }}
          >
            {busy ? (
              <motion.span
                aria-hidden="true"
                className="absolute inset-x-0 top-0 h-px bg-osu-pink"
                initial={{ scaleX: 0, transformOrigin: "0% 50%" }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 2.4, ease: "easeOut" }}
              />
            ) : null}
            <img
              src={`https://a.ppy.sh/${userId}`}
              alt=""
              className="h-8 w-8 shrink-0 rounded-full bg-osu-b4 object-cover"
              onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
            />
            <input
              ref={inputRef}
              type="text"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              onPaste={(event) => {
                // Pasting a score link is the whole interaction, so a paste
                // sends it instead of waiting for a second click.
                const text = event.clipboardData.getData("text");
                if (!text.trim()) return;
                event.preventDefault();
                setLink(text.trim());
                void send(text);
              }}
              placeholder={t`paste a score link for ${username}`}
              spellCheck={false}
              autoComplete="off"
              aria-label={t`osu! score link`}
              className="min-w-0 flex-1 bg-transparent text-[14px] text-osu-l1 outline-none placeholder:text-osu-f1"
            />
            {link.trim() || busy ? (
              <button
                type="submit"
                disabled={busy}
                aria-label={t`Add score`}
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-osu-pink text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-60"
              >
                {busy
                  ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  : <ArrowRight className="h-4 w-4" aria-hidden="true" />}
              </button>
            ) : null}
            {latest ? null : (
              <button
                type="button"
                onClick={onClose}
                aria-label={t`Close`}
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border-l border-white/[0.07] pl-2 text-osu-f1 transition-colors hover:text-white"
              >
                <X size={16} />
              </button>
            )}
          </form>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

/* The play that just landed, as the panel the dialog is built around: its own
   cover art behind it, its accuracy at the size the number deserves. */
function ScorePanel({ item, locale }: { item: AcceptedPlay; locale: AppLocale }) {
  const { t } = useLingui();
  const { play, entry, alreadyTracked } = item;
  const cover = entry?.covers?.["cover@2x"]
    ?? entry?.covers?.cover
    ?? (entry?.beatmapsetId ? `https://assets.ppy.sh/beatmaps/${entry.beatmapsetId}/covers/cover@2x.jpg` : null);
  const title = play.title ?? entry?.title ?? t`Unknown chart`;
  const version = play.version ?? entry?.version ?? null;
  const mods = getModDisplayList(play.mods);
  return (
    <motion.a
      // Server-verified URL: the two osu! id spaces overlap, so a link built
      // from a bare id can open a stranger's play.
      href={play.scoreUrl ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative block h-36 overflow-hidden sm:h-40"
      initial={{ opacity: 0, y: -14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -14 }}
      transition={{ duration: 0.24, ease: "easeOut" }}
    >
      {cover ? (
        <img
          src={cover}
          alt=""
          className="absolute inset-0 h-full w-full scale-105 object-cover transition-transform duration-500 group-hover:scale-110"
          onError={(event) => { event.currentTarget.style.display = "none"; }}
        />
      ) : null}
      {/* Everything sits on the bottom edge, so the scrim is vertical: opaque
          under the type, thin enough at the top to leave the art readable. */}
      <div className="absolute inset-0 bg-gradient-to-t from-osu-b5 via-osu-b5/80 to-osu-b5/25" />
      {/* One-shot wash on arrival, so a paste lands somewhere visible. */}
      <motion.span
        className="pointer-events-none absolute inset-0 bg-osu-pink/25"
        aria-hidden="true"
        initial={{ opacity: 1 }}
        animate={{ opacity: 0 }}
        transition={{ duration: 1, ease: "easeOut" }}
      />
      <div className="relative flex h-full items-end justify-between gap-4 px-4 pb-4 pt-10 sm:px-5 sm:pb-5">
        <div className="min-w-0">
          {play.accuracy != null ? (
            <div className="text-[38px] font-black leading-none tabular-nums text-white sm:text-[44px]">
              {formatAccuracy(play.accuracy)}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-osu-l2">
            {/* The mods are part of what the submitter is checking the link
                against, so they sit with the score, not the chart. */}
            {mods.length > 0 ? (
              <span className="flex items-center gap-0.5">
                {mods.map((mod, index) => (
                  <ModBadge key={`${mod.acronym}-${index}`} mod={mod.acronym} rate={mod.rate} size={0.62} />
                ))}
              </span>
            ) : null}
            {play.pp != null ? <span className="font-bold text-osu-pink-light">{formatPP(play.pp, locale)}</span> : null}
            {entry?.keyCount ? <span className="font-bold text-osu-yellow">{entry.keyCount}K</span> : null}
            {play.endedAt ? <span className="text-osu-f1">{formatTimeAgo(play.endedAt, locale)}</span> : null}
          </div>
        </div>
        <div className="min-w-0 max-w-[55%] text-right">
          <div className="truncate text-[15px] font-bold text-white">{title}</div>
          {version ? <div className="truncate text-[11px] text-osu-f1">[{version}]</div> : null}
          <div className={`mt-1.5 text-[10px] font-bold uppercase tracking-[0.16em] ${alreadyTracked ? "text-osu-f1" : "text-osu-green-light"}`}>
            {alreadyTracked ? t`already tracked` : t`added`}
          </div>
        </div>
      </div>
    </motion.a>
  );
}

/* A play the next paste pushed off the panel. */
function AcceptedRow({ item }: { item: AcceptedPlay }) {
  const { t } = useLingui();
  const { play, entry, alreadyTracked } = item;
  const title = play.title ?? entry?.title ?? t`Unknown chart`;
  const version = play.version ?? entry?.version ?? null;
  const mods = getModDisplayList(play.mods);
  return (
    <motion.a
      href={play.scoreUrl ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-baseline gap-2.5 px-4 py-2.5 transition-colors hover:bg-osu-b4/60 sm:px-5"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      transition={{ duration: 0.22, ease: "easeOut" }}
    >
      <span className="truncate text-[12.5px] font-semibold text-osu-l1">{title}</span>
      {version ? <span className="hidden shrink-0 truncate text-[11px] text-osu-f1 sm:inline">[{version}]</span> : null}
      {mods.length > 0 ? (
        <span className="ml-auto flex shrink-0 items-center gap-0.5 self-center">
          {mods.map((mod, index) => (
            <ModBadge key={`${mod.acronym}-${index}`} mod={mod.acronym} rate={mod.rate} size={0.5} />
          ))}
        </span>
      ) : null}
      <span className={`shrink-0 text-[11px] tabular-nums text-osu-f1 ${mods.length > 0 ? "" : "ml-auto"}`}>
        {play.accuracy != null ? formatAccuracy(play.accuracy) : null}
      </span>
      <span className={`shrink-0 text-[10px] font-bold uppercase tracking-[0.14em] ${alreadyTracked ? "text-osu-f1" : "text-osu-green-light"}`}>
        {alreadyTracked ? t`already tracked` : t`added`}
      </span>
    </motion.a>
  );
}
