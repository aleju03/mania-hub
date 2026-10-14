import { useLingui } from "@lingui/react/macro";
import { BOSS_COPY, MOD_TINT, type BossId } from "#/lib/pack-run";

/* A final song's mod as an osu! mod icon: the acronym on a pill in the
   colour of its kind. */
export function ModBadge({ boss, size = "md" }: { boss: BossId; size?: "sm" | "md" }) {
  const { i18n } = useLingui();
  const copy = BOSS_COPY[boss];
  const tint = MOD_TINT[copy.kind];
  return (
    <span
      title={`${i18n._(copy.name)}: ${i18n._(copy.text)}`}
      className={`inline-grid shrink-0 place-items-center rounded-full font-black italic leading-none tracking-tight text-black/80 ${
        size === "sm" ? "h-[18px] min-w-[30px] px-1.5 text-[11px]" : "h-[24px] min-w-[40px] px-2 text-[13px]"
      }`}
      style={{ background: tint, boxShadow: `inset 0 -2px 0 rgba(0,0,0,0.22)` }}
    >
      {copy.acronym}
    </span>
  );
}
