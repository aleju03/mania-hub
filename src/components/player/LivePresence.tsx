import { useLingui } from "@lingui/react/macro";

import type { CompanellaPresence } from "#/lib/live-backend";
import { ModBadge } from "../ui/ModBadge";

// What a player is doing in osu! right now, from Mania Bridge. The
// profile shows the full line under the name; the rankings show a short tag.

const SPEED_MODS = new Set(["DT", "NC", "HT", "DC"]);

function useStateLabel(presence: CompanellaPresence): string {
  const { t } = useLingui();
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
      return t`Spectating`;
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
export function PresenceLine({ presence }: { presence: CompanellaPresence }) {
  const label = useStateLabel(presence);
  const beatmap = presence.beatmap;
  const mods = presence.mods;
  return (
    <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
      <span className="shrink-0 font-semibold text-osu-green-light">{label}</span>
      {beatmap ? (
        beatmap.id ? (
          <a
            href={`https://osu.ppy.sh/beatmaps/${beatmap.id}`}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 max-w-full truncate font-semibold text-white transition-colors hover:text-osu-pink-light"
          >
            {mapText(beatmap)}
          </a>
        ) : (
          <span className="min-w-0 max-w-full truncate font-semibold text-white">{mapText(beatmap)}</span>
        )
      ) : null}
      {beatmap && mods.length ? (
        <span className="inline-flex shrink-0 items-center gap-0.5">
          {mods.map((mod) => (
            <ModBadge
              key={mod}
              mod={mod}
              size={0.7}
              rate={SPEED_MODS.has(mod) && presence.rate != null ? presence.rate : undefined}
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
