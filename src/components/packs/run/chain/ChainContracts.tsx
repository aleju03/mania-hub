import { motion } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  CHAIN_CONTRACT_COPY,
  CHAIN_CONTRACTS,
  CHAIN_REEL_INK,
  chainContractState,
  chainReelTile,
  type ChainContract,
  type ChainContractTrack,
} from "#/lib/chain-run";
import { KIT, MARKER } from "./chainKit";

const TIER_RINGS = { easy: 1, medium: 2, hard: 3 } as const;

/* Difficulty as linked rings: one, two or three. */
function TierRings({ count, ink }: { count: number; ink: string }) {
  return (
    <svg width={14 + (count - 1) * 10} height={12} viewBox={`0 0 ${14 + (count - 1) * 10} 12`} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <ellipse key={index} cx={7 + index * 10} cy={6} rx={5.5} ry={4.2} fill="none" stroke={ink} strokeWidth={2} />
      ))}
    </svg>
  );
}

function sameContract(a: ChainContract | null, b: ChainContract): boolean {
  return Boolean(a && a.id === b.id && JSON.stringify(a.prize) === JSON.stringify(b.prize));
}

/* One contract in the shop: the rule, its difficulty, the prize it pays.
   Tapping signs it (again unsigns); the signed one is stamped. */
function ContractCard({
  contract,
  signed,
  narrow,
  disabled,
  delay,
  reducedMotion,
  onSign,
}: {
  contract: ChainContract;
  signed: boolean;
  narrow: boolean;
  disabled: boolean;
  delay: number;
  reducedMotion: boolean;
  onSign: () => void;
}) {
  const { t, i18n } = useLingui();
  const copy = CHAIN_CONTRACT_COPY[contract.id];
  const tier = CHAIN_CONTRACTS.tier[contract.id];
  const tile = chainReelTile(contract.prize, i18n);
  const ink = CHAIN_REEL_INK[contract.prize.id];
  const w = narrow ? 104 : 184;
  const h = narrow ? 150 : 176;
  const n = 12;
  const outline = `M${n} 0 L${w - n} 0 L${w} ${n} L${w} ${h - n} L${w - n} ${h} L${n} ${h} L0 ${h - n} L0 ${n} Z`;
  return (
    <motion.button
      type="button"
      aria-pressed={signed}
      title={signed ? t`Signed: tap to unsign` : t`Sign for the next round`}
      disabled={disabled}
      onClick={onSign}
      className="relative shrink-0 text-left disabled:cursor-default"
      style={{ width: w, height: h }}
      initial={reducedMotion ? false : { y: 30, opacity: 0, rotate: -4 }}
      animate={{ y: signed ? -10 : 0, opacity: 1, rotate: signed ? -2 : 0 }}
      whileHover={disabled || reducedMotion ? undefined : { y: signed ? -12 : -4 }}
      transition={{ type: "spring", stiffness: 420, damping: 24, delay: reducedMotion ? 0 : delay }}
    >
      <svg width={w} height={h} className="absolute inset-0 overflow-visible" aria-hidden="true">
        <path d={outline} fill={KIT.dark} stroke={signed ? KIT.pink : KIT.cream} strokeWidth={signed ? 3 : 2.2} />
        <line x1={12} x2={w - 12} y1={h * 0.58} y2={h * 0.58} stroke="rgba(243,233,216,0.25)" strokeWidth={1.5} strokeDasharray="5 5" />
      </svg>
      <div className={`absolute inset-0 flex flex-col ${narrow ? "p-2.5" : "p-4"}`}>
        <TierRings count={TIER_RINGS[tier]} ink={signed ? KIT.pink : "rgba(243,233,216,0.6)"} />
        <div className="mt-1.5 leading-none text-[#f3e9d8]" style={{ fontFamily: MARKER, fontSize: narrow ? 15 : 22 }}>
          {i18n._(copy.name)}
        </div>
        <div className={`mt-1.5 font-bold leading-snug text-[#f3e9d8]/70 ${narrow ? "text-[10px]" : "text-[13px]"}`}>{i18n._(copy.rule)}</div>
        <div className="mt-auto">
          <div className={`font-black uppercase tracking-[0.2em] text-[#f3e9d8]/45 ${narrow ? "text-[8px]" : "text-[10px]"}`}>
            <Trans>Pays</Trans>
          </div>
          <div className="flex items-baseline gap-1.5 leading-none" title={tile.text}>
            <span style={{ fontFamily: MARKER, color: ink, fontSize: narrow ? 17 : 26 }}>{tile.mark}</span>
            <span className={`truncate font-black ${narrow ? "text-[10px]" : "text-[13px]"}`} style={{ color: ink }}>
              {tile.word}
            </span>
          </div>
        </div>
      </div>
      {signed && (
        <motion.div
          className={`absolute -right-3 bottom-4 rotate-[-10deg] border-[3px] px-2 py-0.5 leading-none ${narrow ? "text-[13px]" : "text-[20px]"}`}
          style={{ fontFamily: MARKER, color: KIT.pink, borderColor: KIT.pink, background: "rgba(18,12,24,0.85)" }}
          initial={reducedMotion ? false : { scale: 2.2, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 600, damping: 18 }}
        >
          <Trans>Signed</Trans>
        </motion.div>
      )}
    </motion.button>
  );
}

/* The shop's three contracts for the next round. */
export function ShopContracts({
  contracts,
  signed,
  nextRound,
  narrow,
  busy,
  delay,
  reducedMotion,
  onSign,
}: {
  contracts: ChainContract[];
  signed: ChainContract | null;
  nextRound: number;
  narrow: boolean;
  busy: boolean;
  delay: number;
  reducedMotion: boolean;
  onSign: (index: number) => void;
}) {
  if (!contracts.length) return null;
  return (
    <div className="flex flex-col items-center">
      <div className="leading-none text-[#f3e9d8]" style={{ fontFamily: MARKER, fontSize: narrow ? 17 : 24 }}>
        <Trans>Contracts</Trans>
      </div>
      <div className={`mt-1 text-center font-bold text-[#f3e9d8]/55 ${narrow ? "text-[11px]" : "text-[13px]"}`}>
        <Trans>Sign one for round {nextRound}. Meet it and it pays on the clear.</Trans>
      </div>
      <div className={`mt-4 flex justify-center ${narrow ? "gap-2" : "gap-5"}`}>
        {contracts.map((contract, index) => (
          <ContractCard
            key={`${contract.id}-${index}`}
            contract={contract}
            signed={sameContract(signed, contract)}
            narrow={narrow}
            disabled={busy}
            delay={delay + index * 0.06}
            reducedMotion={reducedMotion}
            onSign={() => onSign(index)}
          />
        ))}
      </div>
    </div>
  );
}

/* The signed contract on the table during its round: name, its reading so
   far, and whether it still holds. */
export function ContractTracker({
  contract,
  track,
  roundScore,
  target,
  narrow,
}: {
  contract: ChainContract;
  track: ChainContractTrack;
  roundScore: number;
  target: number;
  narrow: boolean;
}) {
  const { i18n } = useLingui();
  const reading = chainContractState(contract.id, track, roundScore, target);
  const tile = chainReelTile(contract.prize, i18n);
  const ink = reading.state === "lost" ? "rgba(243,233,216,0.35)" : reading.state === "met" ? KIT.gold : KIT.cream;
  return (
    <div className={`flex items-center gap-2.5 leading-none ${reading.state === "lost" ? "opacity-60" : ""}`} title={i18n._(CHAIN_CONTRACT_COPY[contract.id].rule)}>
      <TierRings count={TIER_RINGS[CHAIN_CONTRACTS.tier[contract.id]]} ink={ink} />
      <span className={reading.state === "lost" ? "line-through" : ""} style={{ fontFamily: MARKER, color: ink, fontSize: narrow ? 14 : 18 }}>
        {i18n._(CHAIN_CONTRACT_COPY[contract.id].name)}
      </span>
      {reading.progress && (
        <span className="tabular-nums" style={{ fontFamily: MARKER, color: ink, fontSize: narrow ? 13 : 16 }}>
          {reading.progress}
        </span>
      )}
      <span className={`font-black ${narrow ? "text-[10px]" : "text-[12px]"}`} style={{ color: CHAIN_REEL_INK[contract.prize.id] }}>
        {tile.mark} {tile.word}
      </span>
    </div>
  );
}
