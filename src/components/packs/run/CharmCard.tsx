import { useLingui } from "@lingui/react/macro";
import { CHARM_BY_ID, CHARM_COPY, RARITY_TINT, type RunCharm } from "#/lib/pack-run";
import { CharmArt } from "./charmArt";

/* The running number a scaling charm carries, as the line under its name. */
function charmValueLine(charm: RunCharm): string | null {
  if (charm.value === undefined) return null;
  if (charm.id === "snowball") return `+${charm.value}`;
  if (charm.id === "freshPaint") return `+${charm.value}`;
  if (charm.id === "ascension" || charm.id === "archivist") return `x${Math.round(charm.value * 100) / 100}`;
  if (charm.id === "hotStreak") return String(charm.value);
  return null;
}

/* A charm as its sticker. Each time `pulse` bumps (the charm fired in a
   tally) it hops and wobbles. */
export function CharmKey({
  id,
  charm,
  pulse = 0,
  size = 36,
}: {
  id: string;
  charm?: RunCharm;
  pulse?: number;
  size?: number;
}) {
  const { i18n } = useLingui();
  const def = CHARM_BY_ID.get(id);
  const copy = CHARM_COPY[id];
  const value = charm ? charmValueLine(charm) : null;
  return (
    <span
      key={pulse}
      title={copy ? `${i18n._(copy.name)}: ${i18n._(copy.text)}` : id}
      className={`relative inline-grid shrink-0 place-items-center ${pulse > 0 ? "run-sticker-hop" : ""}`}
      style={{ width: size, height: size }}
    >
      <CharmArt id={id} rarity={def?.rarity ?? "common"} size={size} />
      {value && (
        <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded bg-osu-b5 px-1 text-[11px] font-bold leading-tight text-white tabular-nums">
          {value}
        </span>
      )}
    </span>
  );
}

/* An empty charm slot: the outline of a sticker not yet stuck on. */
export function EmptyKey({ size = 36 }: { size?: number }) {
  return (
    <span aria-hidden="true" className="grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <span className="block rounded-full border-2 border-dashed border-white/15" style={{ width: size * 0.78, height: size * 0.78 }} />
    </span>
  );
}

/* A charm as a row: its key, the name and the rule, and whatever the caller
   puts at the end (sell, buy). */
export function CharmRow({
  id,
  charm,
  pulse = 0,
  trailing,
}: {
  id: string;
  charm?: RunCharm;
  pulse?: number;
  trailing?: React.ReactNode;
}) {
  const { i18n } = useLingui();
  const copy = CHARM_COPY[id];
  const def = CHARM_BY_ID.get(id);
  const tint = RARITY_TINT[def?.rarity ?? "common"];
  return (
    <div className="flex items-center gap-3 py-2.5">
      <CharmKey id={id} charm={charm} pulse={pulse} size={52} />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-bold" style={{ color: tint }}>
          {copy ? i18n._(copy.name) : id}
        </div>
        <div className="text-[12px] leading-snug text-osu-f1">{copy ? i18n._(copy.text) : ""}</div>
      </div>
      {trailing && <div className="flex shrink-0 items-center gap-1">{trailing}</div>}
    </div>
  );
}
