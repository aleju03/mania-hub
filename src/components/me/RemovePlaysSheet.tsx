import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, X } from "lucide-react";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";
import { playHoldConfirmedSound, startHoldToConfirmSound } from "../../lib/ui-sounds";
import type { MyDataTrackedPlay } from "../../lib/my-data";

const HOLD_MS = 1200;

export type RemovePlaysSheetKind = "some" | "all" | "stop";

function coverOf(play: MyDataTrackedPlay): string | null {
  const covers = play.beatmapset?.covers;
  if (covers?.list) return covers.list;
  if (covers?.cover) return covers.cover;
  const setId = play.beatmapset?.id ?? play.beatmap?.beatmapset_id;
  return setId ? `https://assets.ppy.sh/beatmaps/${setId}/covers/list.jpg` : null;
}

/*
 * The second confirmation is the hold itself: the fill runs for HOLD_MS while
 * the button is pressed and drains when it is let go, so nothing is removed by
 * a stray click or a double tap through the sheet. Space and Enter hold too.
 */
export function HoldToConfirm({ label, busyLabel, busy, onConfirm }: {
  label: string;
  busyLabel: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const [holding, setHolding] = useState(false);
  const timerRef = useRef<number | null>(null);
  const stopSoundRef = useRef<(() => void) | null>(null);
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;

  // A timer, not the fill's transitionend: reduced-motion settings can drop
  // the transition, and the hold must still complete.
  const stop = useCallback(() => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    stopSoundRef.current?.();
    stopSoundRef.current = null;
    setHolding(false);
  }, []);
  const start = useCallback(() => {
    if (busy || timerRef.current != null) return;
    setHolding(true);
    stopSoundRef.current = startHoldToConfirmSound(HOLD_MS);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      stopSoundRef.current = null;
      setHolding(false);
      playHoldConfirmedSound();
      navigator.vibrate?.(15);
      onConfirmRef.current();
    }, HOLD_MS);
  }, [busy]);
  useEffect(() => () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    stopSoundRef.current?.();
  }, []);

  return (
    <button
      type="button"
      disabled={busy}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        start();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) {
          event.preventDefault();
          start();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") stop();
      }}
      onBlur={stop}
      className="relative h-12 w-full touch-none select-none overflow-hidden rounded-xl bg-osu-red-light/15 text-[13px] font-bold text-osu-red-light cursor-pointer hover:brightness-110 disabled:cursor-default"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 bg-osu-red-light/45"
        style={{
          width: holding || busy ? "100%" : "0%",
          transition: holding ? `width ${HOLD_MS}ms linear` : busy ? "none" : "width 220ms ease-out",
        }}
      />
      <span className={`relative inline-flex items-center gap-2 ${holding || busy ? "text-white" : ""}`}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {busy ? busyLabel : label}
      </span>
    </button>
  );
}

/** Floats over the feed while plays are picked; hidden when nothing is. */
export function RemovalPill({ count, onRemove, onClear }: { count: number; onRemove: () => void; onClear: () => void }) {
  const { t } = useLingui();
  return (
    <AnimatePresence>
      {count > 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.16, ease: "easeOut" }}
          className="fixed inset-x-0 bottom-5 z-40 flex justify-center px-3 pointer-events-none"
        >
          <div translate="no" className="pointer-events-auto flex items-center gap-1 rounded-full bg-osu-b3 py-1.5 pl-4 pr-1.5 shadow-lg shadow-black/40">
            <span className="pr-2 text-[13px] font-semibold tabular-nums text-white">
              {t`${plural(count, { one: "# play", other: "# plays" })}`}
            </span>
            <button
              type="button"
              onClick={onRemove}
              className="rounded-full bg-osu-red-light/20 px-3.5 py-1.5 text-[12.5px] font-bold text-osu-red-light cursor-pointer hover:brightness-110"
            >
              {t`Remove`}
            </button>
            <button
              type="button"
              onClick={onClear}
              aria-label={t`Clear selection`}
              className="flex h-8 w-8 items-center justify-center rounded-full text-osu-l2 cursor-pointer hover:bg-osu-b4 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/*
 * One sheet per action, built around what is leaving: the covers and the
 * count. Stopping tracking asks keep-or-remove here, before anything runs,
 * so it never chains a second dialog.
 */
export function RemovePlaysSheet({
  kind,
  plays,
  count,
  busy,
  error,
  onRemove,
  onStopTracking,
  onClose,
}: {
  kind: RemovePlaysSheetKind;
  /** The picked plays, or a few from the feed to show for "all" and "stop". */
  plays: MyDataTrackedPlay[];
  count: number;
  busy: boolean;
  error: string | null;
  onRemove: () => void;
  onStopTracking: (removePlays: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [removeOnStop, setRemoveOnStop] = useState(false);
  useBodyScrollLock(true);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const covers = plays.map(coverOf).filter((cover): cover is string => !!cover).slice(0, 3);
  const titles = plays.map((play) => play.beatmapset?.title).filter((title): title is string => !!title);
  const namesLine = kind === "some"
    ? titles.length > 2 ? `${titles.slice(0, 2).join(" · ")} · +${count - 2}` : titles.join(" · ")
    : null;
  const stopping = kind === "stop";
  const heading = stopping
    ? t`Stop tracking`
    : kind === "all"
      ? t`${plural(count, { one: "# tracked play", other: "# tracked plays" })}`
      : t`${plural(count, { one: "# play", other: "# plays" })}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-3 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={heading}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="relative w-full max-w-sm rounded-2xl bg-osu-b5 p-5"
      >
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label={t`Close`}
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-osu-f1 cursor-pointer hover:bg-osu-b4 hover:text-white disabled:opacity-40"
        >
          <X className="h-4 w-4" />
        </button>

        <div translate="no" className="flex items-center gap-3.5 pr-8">
          {covers.length > 0 && !stopping ? (
            <div className="flex shrink-0">
              {covers.map((cover, index) => (
                <img
                  key={`${cover}-${index}`}
                  src={cover}
                  alt=""
                  className={`h-12 w-12 rounded-lg object-cover ring-2 ring-osu-b5 ${index > 0 ? "-ml-6" : ""}`}
                  style={{ zIndex: covers.length - index }}
                />
              ))}
            </div>
          ) : null}
          <div className="min-w-0">
            <div className="text-[22px] font-bold leading-tight tabular-nums text-white">{heading}</div>
            {namesLine ? <div className="mt-0.5 truncate text-[12px] text-osu-f1">{namesLine}</div> : null}
          </div>
        </div>

        <p className="mt-3 text-[12.5px] leading-5 text-osu-f1">
          {stopping
            ? t`New plays stop being recorded.`
            : t`They're removed from your tracked plays, recent plays and activity on this site.`}
        </p>

        {stopping && count > 0 ? (
          <div className="mt-4 grid grid-cols-2 gap-1 rounded-xl bg-osu-b4 p-1" role="radiogroup">
            {[
              { value: false, label: t`Keep my plays` },
              { value: true, label: t`Remove my ${plural(count, { one: "# play", other: "# plays" })}` },
            ].map((option) => (
              <button
                key={String(option.value)}
                type="button"
                role="radio"
                aria-checked={removeOnStop === option.value}
                disabled={busy}
                onClick={() => setRemoveOnStop(option.value)}
                className={`rounded-lg px-2 py-2 text-[12px] font-semibold tabular-nums cursor-pointer transition-colors ${
                  removeOnStop === option.value
                    ? option.value ? "bg-osu-red-light/20 text-osu-red-light" : "bg-osu-b3 text-white"
                    : "text-osu-f1 hover:text-white"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="mt-4">
          <HoldToConfirm
            label={stopping ? t`Hold to stop tracking` : t`Hold to remove`}
            busyLabel={stopping ? t`Stopping…` : t`Removing…`}
            busy={busy}
            onConfirm={() => (stopping ? onStopTracking(removeOnStop) : onRemove())}
          />
        </div>
        {error ? <div className="mt-2.5 text-center text-[12px] text-osu-red-light">{error}</div> : null}
      </motion.div>
    </div>
  );
}
