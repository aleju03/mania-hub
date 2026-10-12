import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { useLingui } from "@lingui/react/macro";

import { Video } from "lucide-react";

import { KNOWN_APPS, MANUAL_ENTRY_APP, REPLAY_IMPORT_APP, knownApp } from "../../lib/companella-integration/shared";
import { useScoreVideo } from "../../lib/score-videos";

// Marks a score row that came from an app import (Companella, Hashi) instead of osu!, with the icon of the
// app that sent it; a row without one predates the field and was Companella. The icon is full colour on a solid
// disc, so it is an <img>, not a mask like the mod glyphs. The small mark copies keep a row from pulling the originals.
// Rows draw their content above a full-row button with pointer events off, so the mark turns them back on for its
// own hover label and, on a Hashi play, its link to /hashi. A play an admin imported from the player's replay
// files carries no mark, and one an admin entered by hand carries a link to its video when it has one.
export function CompanellaMark({ app, video, className = "h-[18px] w-[18px]" }: { app?: string; video?: string; className?: string }) {
  const { t } = useLingui();
  const known = knownApp(app) ?? KNOWN_APPS.companella;
  const { hover, tooltip } = useMarkTip(t`Sent through ${known.name}`);
  const isBridge = app === "mania-bridge";

  if (app === MANUAL_ENTRY_APP) return video ? <VideoMark video={video} className={className} /> : null;
  if (app === REPLAY_IMPORT_APP) return null;

  const image = (
    <img
      src={known.mark}
      alt={t`Sent through ${known.name}`}
      width={48}
      height={48}
      loading="lazy"
      className={`inline-block rounded-full align-middle ${className}`}
    />
  );

  return (
    <>
      {isBridge ? (
        <Link
          to="/hashi"
          onClick={(event) => event.stopPropagation()}
          className="pointer-events-auto relative z-10 inline-flex flex-shrink-0 rounded-full hover:brightness-110"
          {...hover}
        >
          {image}
        </Link>
      ) : (
        <span className="pointer-events-auto relative z-10 inline-flex flex-shrink-0 cursor-default" {...hover}>
          {image}
        </span>
      )}
      {tooltip}
    </>
  );
}

/** The app a play was sent through, as the details line names it, linked to
 *  its about page: none for a play an admin entered or imported from replay files. */
export function sentThrough(app: string | undefined, imported: boolean): { name: string; to: "/hashi" | "/news/companella" } | null {
  if (!imported || app === MANUAL_ENTRY_APP || app === REPLAY_IMPORT_APP) return null;
  if (app === "mania-bridge") return { name: KNOWN_APPS["mania-bridge"].name, to: "/hashi" };
  return { name: (knownApp(app) ?? KNOWN_APPS.companella).name, to: "/news/companella" };
}

// A link to a play's video: the one an admin entered a play from, or a proof
// video an admin attached to an official play.
export function VideoMark({ video, className = "h-[18px] w-[18px]" }: { video: string; className?: string }) {
  const { t } = useLingui();
  const label = t`Watch video`;
  const { hover, tooltip } = useMarkTip(label);
  return (
    <>
      <a
        href={video}
        target="_blank"
        rel="noreferrer"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
        className={`pointer-events-auto relative z-10 inline-flex flex-shrink-0 items-center justify-center rounded-full bg-osu-b3 text-white hover:brightness-110 ${className}`}
        {...hover}
      >
        <Video className="h-[60%] w-[60%]" strokeWidth={2.25} />
      </a>
      {tooltip}
    </>
  );
}

/** The proof video mark of an official play named by any of its ids, for rows drawn in a loop. */
export function ScoreVideoMark({ ids, className }: { ids: Array<number | null | undefined>; className?: string }) {
  const video = useScoreVideo(...ids);
  return video ? <VideoMark video={video} className={className} /> : null;
}

function useMarkTip(label: string) {
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null);
  const showTip = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== "mouse") return;
    const rect = event.currentTarget.getBoundingClientRect();
    setTip({ left: rect.left + rect.width / 2, top: rect.top });
  };
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [tip]);
  const hover = { onPointerEnter: showTip, onPointerLeave: () => setTip(null) };
  const tooltip = tip && typeof document !== "undefined" ? createPortal(
    <div
      className="pointer-events-none fixed z-[60] -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg bg-osu-b3 px-3 py-1.5 text-[12px] font-semibold text-white shadow-xl shadow-black/50"
      style={{ left: tip.left, top: tip.top - 6 }}
    >
      {label}
    </div>,
    document.body,
  ) : null;
  return { hover, tooltip };
}
