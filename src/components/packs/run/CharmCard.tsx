import { AnimatePresence, motion } from "framer-motion";
import { useLingui } from "@lingui/react/macro";
import { CHARM_BY_ID, CHARM_COPY, RARITY_TINT, type RunCharm } from "#/lib/pack-run";
import { CharmArt } from "./charmArt";
import { SHOP_FEEL } from "./shopFeel";
import type { ShardFloat } from "./shopMotion";
import { Shards } from "./Shards";

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
  titled = true,
}: {
  id: string;
  charm?: RunCharm;
  pulse?: number;
  size?: number;
  /* The native title tooltip; off where the caller shows the rule itself. */
  titled?: boolean;
}) {
  const { i18n } = useLingui();
  const def = CHARM_BY_ID.get(id);
  const copy = CHARM_COPY[id];
  const value = charm ? charmValueLine(charm) : null;
  return (
    <span
      key={pulse}
      title={titled ? (copy ? `${i18n._(copy.name)}: ${i18n._(copy.text)}` : id) : undefined}
      className={`relative inline-grid shrink-0 place-items-center ${pulse > 0 ? "run-sticker-hop" : ""}`}
      style={{ width: size, height: size }}
    >
      <CharmArt id={id} rarity={def?.rarity ?? "common"} size={size} />
      {value && (
        <span
          className={`absolute -bottom-2 left-1/2 -translate-x-1/2 rounded bg-osu-b5 px-1.5 font-bold leading-tight text-white tabular-nums ${
            size >= 90 ? "text-[15px]" : "text-[12px]"
          }`}
        >
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

/* A charm's name in its rarity's colour over its rule, for the rail's
   popover and the shop's cards. */
export function CharmRule({ id, className = "", textClassName = "text-[12px]" }: { id: string; className?: string; textClassName?: string }) {
  const { i18n } = useLingui();
  const copy = CHARM_COPY[id];
  const def = CHARM_BY_ID.get(id);
  return (
    <div className={className}>
      <div className="text-[14px] font-bold leading-tight" style={{ color: RARITY_TINT[def?.rarity ?? "common"] }}>
        {copy ? i18n._(copy.name) : id}
      </div>
      {copy && <div className={`mt-1 leading-snug text-white/85 ${textClassName}`}>{i18n._(copy.text)}</div>}
    </div>
  );
}

/* "+N" / "-N" shard amounts rising off where shards changed hands. Positions
   are in the parent's box, which must be positioned. */
export function ShardFloatLayer({ floats }: { floats: ShardFloat[] }) {
  return (
    <AnimatePresence>
      {floats.map((float) => (
        <motion.span
          key={float.key}
          className={`pointer-events-none absolute z-[80] inline-flex items-center -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-lg bg-black/75 px-2.5 py-0.5 text-[20px] font-black tabular-nums ${
            float.value >= 0 ? "text-[#ffd36a]" : "text-white"
          }`}
          style={{ left: float.x, top: float.y }}
          initial={{ opacity: 0, y: 6, scale: 0.6 }}
          animate={{
            opacity: [0, 1, 1, 0],
            y: [6, -SHOP_FEEL.float.risePx * 0.55, -SHOP_FEEL.float.risePx * 0.8, -SHOP_FEEL.float.risePx],
            scale: [0.6, 1.15, 1, 1],
          }}
          transition={{ duration: SHOP_FEEL.float.durationMs / 1000, times: [0, 0.15, 0.72, 1], ease: "easeOut" }}
        >
          {float.value >= 0 ? "+" : "-"}
          <Shards value={Math.abs(float.value)} />
        </motion.span>
      ))}
    </AnimatePresence>
  );
}
