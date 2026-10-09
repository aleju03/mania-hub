import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";

import type { CompanellaPresence } from "#/lib/live-backend";
import { ModBadge } from "../ui/ModBadge";

// What a player is doing in osu! right now, from Hashi. The
// profile shows the full line under the name, the rankings a short tag, and
// the home card a dot that shows the full line on hover or tap.

// The speed each rate mod plays at unless lazer sets a custom one. Only a
// custom speed gets its number on the badge.
const DEFAULT_RATES: Record<string, number> = { DT: 1.5, NC: 1.5, HT: 0.75, DC: 0.75 };

function useStateLabel(presence: CompanellaPresence): string {
  const { t } = useLingui();
  // The player's own replay needs no name on their own line.
  const name = presence.player?.username;
  const player = name && name.toLowerCase() !== presence.username.toLowerCase() ? name : null;
  const mode = presence.ruleset === "osu" ? "osu!" : presence.ruleset === "taiko" ? "osu!taiko" : presence.ruleset === "fruits" ? "osu!catch" : null;
  switch (presence.state) {
    case "menu":
      return t`In the main menu`;
    case "song_select":
      return t`In song select`;
    case "playing":
      return mode ? t`Playing ${mode}` : t`Playing`;
    case "results":
      return t`On the results screen`;
    case "editing":
      return t`Editing`;
    case "spectating":
      return player ? t`Spectating ${player}` : t`Spectating`;
    case "watching_replay":
      return player ? t`Watching ${player}'s replay` : t`Watching a replay`;
    case "multiplayer":
      return t`In multiplayer`;
    default:
      return t`In osu!`;
  }
}

function mapText(beatmap: NonNullable<CompanellaPresence["beatmap"]>): string {
  const name = [beatmap.artist, beatmap.title].filter(Boolean).join(" - ");
  return beatmap.version ? `${name} [${beatmap.version}]` : name;
}

/** The profile line: state, the map (linked when osu! has it) and the mods. */
export function PresenceLine({ presence, className = "mt-2.5", wrap = false }: { presence: CompanellaPresence; className?: string; wrap?: boolean }) {
  const label = useStateLabel(presence);
  const fit = wrap ? "break-words" : "truncate";
  const beatmap = presence.beatmap;
  const mods = presence.mods;
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] ${className}`}>
      <span className="shrink-0 font-semibold text-osu-green-light">{label}</span>
      {beatmap ? (
        beatmap.id ? (
          <a
            href={`https://osu.ppy.sh/beatmaps/${beatmap.id}`}
            target="_blank"
            rel="noreferrer"
            className={`min-w-0 max-w-full ${fit} font-semibold text-white transition-colors hover:text-osu-pink-light`}
          >
            {mapText(beatmap)}
          </a>
        ) : (
          <span className={`min-w-0 max-w-full ${fit} font-semibold text-white`}>{mapText(beatmap)}</span>
        )
      ) : null}
      {beatmap && mods.length ? (
        <span className="inline-flex shrink-0 items-center gap-0.5">
          {mods.map((mod) => (
            <ModBadge
              key={mod}
              mod={mod}
              size={0.7}
              rate={mod in DEFAULT_RATES && presence.rate != null && presence.rate !== DEFAULT_RATES[mod] ? presence.rate : undefined}
            />
          ))}
        </span>
      ) : null}
    </div>
  );
}

/** The rankings tag: a dot and the state, with the map's title on hover. */
export function PresenceTag({ presence, className = "" }: { presence: CompanellaPresence; className?: string }) {
  const label = useStateLabel(presence);
  const title = presence.beatmap ? `${label} ${mapText(presence.beatmap)}` : label;
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 text-[11px] text-osu-green-light ${className}`} title={title}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-osu-green" />
      <span className="truncate">
        {label}
        {presence.beatmap?.title ? <span className="text-osu-f1"> {presence.beatmap.title}</span> : null}
      </span>
    </span>
  );
}

/** The home card's dot, pulsing during a play, with the full line on hover or tap. */
export function PresenceDot({ presence }: { presence: CompanellaPresence }) {
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null);
  const tapped = useRef(false);
  const tipRef = useRef<HTMLDivElement>(null);
  // Centred over the dot, then pulled back inside the viewport.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!tip || !el) return;
    const margin = 8;
    const width = el.offsetWidth;
    el.style.left = `${Math.max(margin, Math.min(tip.left - width / 2, window.innerWidth - width - margin))}px`;
    el.style.visibility = "visible";
  }, [tip]);
  const place = (target: Element) => {
    const rect = target.getBoundingClientRect();
    setTip({ left: rect.left + rect.width / 2, top: rect.top });
  };
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("pointerdown", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("pointerdown", hide);
    };
  }, [tip]);

  const tooltip = tip && typeof document !== "undefined" ? createPortal(
    <div
      ref={tipRef}
      className="pointer-events-none fixed z-[60] w-max max-w-[min(calc(100vw-16px),420px)] -translate-y-full rounded-lg bg-osu-b3 px-3 py-1.5 shadow-xl shadow-black/50"
      style={{ left: 0, top: tip.top - 6, visibility: "hidden" }}
    >
      <PresenceLine presence={presence} className="" wrap />
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <span
        className="relative inline-flex h-4 w-4 shrink-0 cursor-default items-center justify-center"
        onPointerEnter={(event: ReactPointerEvent<HTMLElement>) => {
          if (event.pointerType === "mouse") place(event.currentTarget);
        }}
        onPointerLeave={(event: ReactPointerEvent<HTMLElement>) => {
          if (event.pointerType === "mouse") setTip(null);
        }}
        // A tap toggles the line instead of opening the row's profile; a
        // mouse click keeps the hover line up.
        onPointerDown={(event: ReactPointerEvent<HTMLElement>) => {
          event.stopPropagation();
          tapped.current = event.pointerType !== "mouse";
        }}
        onClick={(event: ReactMouseEvent<HTMLElement>) => {
          event.stopPropagation();
          if (tapped.current && tip) setTip(null);
          else place(event.currentTarget);
        }}
      >
        {presence.state === "playing" ? (
          <span className="absolute h-2 w-2 rounded-full bg-osu-green opacity-60 motion-safe:animate-ping" />
        ) : null}
        <span className="relative h-2 w-2 rounded-full bg-osu-green" />
      </span>
      {tooltip}
    </>
  );
}
