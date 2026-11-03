import { useLingui } from "@lingui/react/macro";
import { Trans } from "@lingui/react/macro";
import { CHAIN_BOSS, CHAIN_BOSS_COPY, type ChainBossId } from "#/lib/chain-run";
import { KIT, MARKER } from "./chainKit";

/* Boss rounds: every third round plays under one twist (CHAIN_BOSS_COPY).
   The HUD wears its tag while it plays; the shop the visit before says
   what is coming. */

const BOSS_RED = "#ff5a5a";

/* A spiked crown, drawn in the kit's stroke. */
export function IconBoss({ size = 22, ink = BOSS_RED }: { size?: number; ink?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0 overflow-visible">
      <g strokeLinejoin="round" strokeLinecap="round">
        <path d="M5 24 L4 10 L11 16 L16 6 L21 16 L28 10 L27 24 Z" fill={KIT.dark} stroke={ink} strokeWidth={2.6} />
        <path d="M6 28 H26" stroke={ink} strokeWidth={2.6} />
        <circle cx={16} cy={18} r={2.2} fill={ink} />
      </g>
    </svg>
  );
}

/* The tag: crown, the twist's name in marker, its rule beside it unless
   `compact`. */
export function BossTag({ boss, compact = false }: { boss: ChainBossId; compact?: boolean }) {
  const { i18n } = useLingui();
  const copy = CHAIN_BOSS_COPY[boss];
  return (
    <div
      className="flex min-w-0 items-center gap-2 rounded-full border-[2.5px] px-2.5 py-1 leading-none"
      style={{ borderColor: BOSS_RED, background: KIT.dark, boxShadow: "0 4px 0 rgba(0,0,0,0.45)" }}
      title={`${copy.name}: ${i18n._(copy.rule)}`}
    >
      <IconBoss size={compact ? 18 : 22} />
      <span className="whitespace-nowrap" style={{ fontFamily: MARKER, color: BOSS_RED, fontSize: compact ? 15 : 19 }}>
        {copy.name}
      </span>
      {!compact && <span className="truncate text-[13px] font-bold text-[#f3e9d8]/80">{i18n._(copy.rule)}</span>}
    </div>
  );
}

/* The shop's notice of the next round's boss. */
export function NextBossNotice({ boss, narrow }: { boss: ChainBossId; narrow: boolean }) {
  const { i18n } = useLingui();
  const copy = CHAIN_BOSS_COPY[boss];
  return (
    <div className={`flex items-center gap-3 rounded-[12px] border-[2.5px] px-3 py-2 ${narrow ? "max-w-[340px]" : "max-w-[520px]"}`} style={{ borderColor: BOSS_RED, background: KIT.dark }}>
      <IconBoss size={narrow ? 24 : 30} />
      <div className="min-w-0 text-left">
        <div className="leading-none" style={{ fontFamily: MARKER, color: BOSS_RED, fontSize: narrow ? 16 : 20 }}>
          <Trans>Next round is a boss: {copy.name}</Trans>
        </div>
        <div className="mt-1 text-[12px] font-bold text-[#f3e9d8]/80">
          {i18n._(copy.rule)} <Trans>Clearing it pays {CHAIN_BOSS.shards} more shards.</Trans>
        </div>
      </div>
    </div>
  );
}
