import { useLingui } from "@lingui/react/macro";

import { ModBadge } from "./ModBadge";
import { NO_MOD_KEY, getModFilterGroup, type ModFilterMode } from "../../lib/mod-filter";

/**
 * One mod's chip in a play list's filter: neutral, required (green), or
 * excluded (red, struck through). Left click cycles forward, right click back.
 * Shared by Best Performance and the Skills tab's plays explorer so the same
 * chip means the same thing wherever a list can be narrowed by mod.
 */
export function ModFilterChip({
  mod,
  mode,
  onClick,
  onContextMenu,
}: {
  mod: string;
  mode: ModFilterMode | undefined;
  onClick: () => void;
  onContextMenu: () => void;
}) {
  const { t } = useLingui();
  const groupMods = getModFilterGroup(mod);
  const label = mod === NO_MOD_KEY
    ? t`NoMod`
    : groupMods
      ? groupMods.join(t` or `)
      : mod;
  const title = mode === "include"
    ? t`Showing only ${label}`
    : mode === "exclude"
      ? t`Hiding ${label}`
      : t`Click to require ${label}`;

  const ringClass = mode === "include"
    ? "border-osu-green-light bg-osu-green/15"
    : mode === "exclude"
      ? "border-osu-red-light bg-osu-red/15"
      : "border-osu-b3/30 bg-osu-b4/50 hover:bg-osu-b3/40";

  const contentDimClass = mode === "exclude" ? "opacity-40 saturate-50" : "";

  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu();
      }}
      title={title}
      aria-label={title}
      className={`relative flex items-center gap-1 rounded-md border px-1.5 py-1 transition-colors cursor-pointer ${ringClass}`}
    >
      <div className={`flex items-center transition-opacity ${contentDimClass}`}>
        {mod === NO_MOD_KEY ? (
          <span className="text-[10px] font-bold text-osu-l2 px-1">{t`NoMod`}</span>
        ) : groupMods ? (
          <div className="flex items-center gap-0.5">
            {groupMods.map((m) => (
              <ModBadge key={m} mod={m} size={0.7} />
            ))}
          </div>
        ) : (
          <ModBadge mod={mod} size={0.8} />
        )}
      </div>
      {mode === "exclude" && (
        <span
          className="pointer-events-none absolute left-1 right-1 top-1/2 h-[2px] -translate-y-1/2 rotate-[-10deg] rounded-full bg-osu-red-light shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

