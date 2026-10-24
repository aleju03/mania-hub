import { motion } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  CHAIN_CONTRACT_COPY,
  CHAIN_CONTRACTS,
  CHAIN_REEL_INK,
  chainContractState,
  chainReelTile,
  type ChainContract,
  type ChainContractId,
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

/* Each contract's drawn mark, in ink on the slip (24 grid). */
function ContractIcon({ id, size, ink }: { id: ChainContractId; size: number; ink: string }) {
  const stroke = { fill: "none", stroke: ink, strokeWidth: 2.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {id === "quick" && (
        <>
          <circle cx={12} cy={13.5} r={7.5} {...stroke} />
          <path d="M12 13.5 L15.5 10.5 M10 3 H14 M12 3 V6 M18.5 6.5 L20 5" {...stroke} />
        </>
      )}
      {id === "oneShot" && (
        <>
          <circle cx={12} cy={12} r={8} {...stroke} />
          <circle cx={12} cy={12} r={4} {...stroke} />
          <circle cx={12} cy={12} r={1.2} fill={ink} />
        </>
      )}
      {id === "clean" && (
        <>
          <ellipse cx={8.5} cy={12} rx={5.5} ry={3.6} {...stroke} />
          <ellipse cx={15.5} cy={12} rx={5.5} ry={3.6} {...stroke} />
        </>
      )}
      {id === "overkill" && (
        <path d="M12 3 C14 7 18 8.5 18 14 A6 6 0 0 1 6 14 C6 11 8 9.5 9 7.5 C10 10 11.5 10.5 12 9 C12.5 7 11.5 5 12 3 Z" {...stroke} />
      )}
      {id === "noRedraw" && (
        <>
          <rect x={4} y={6} width={9} height={13} rx={1.5} {...stroke} />
          <rect x={11} y={4} width={9} height={13} rx={1.5} {...stroke} />
          <path d="M3 21 L21 3" {...stroke} />
        </>
      )}
      {id === "fullHouse" &&
        [0, 1, 2].flatMap((col) =>
          [0, 1].map((row) => <rect key={`${col}-${row}`} x={3 + col * 6.5} y={4.5 + row * 8} width={4.8} height={6.8} rx={1} {...stroke} strokeWidth={1.8} />),
        )}
      {id === "perfect" && (
        <>
          <ellipse cx={6} cy={12} rx={4.2} ry={3} {...stroke} strokeWidth={1.9} />
          <ellipse cx={12} cy={12} rx={4.2} ry={3} {...stroke} strokeWidth={1.9} />
          <ellipse cx={18} cy={12} rx={4.2} ry={3} {...stroke} strokeWidth={1.9} />
          <path d="M5 19 H19" {...stroke} strokeWidth={1.6} />
        </>
      )}
    </svg>
  );
}

/* The rendered slips (3d-modelling/overjoy/build_contract_slip.py): cream
   paper pinned with a gold pin (pink once signed), its shadow baked in. */
const SLIP = {
  narrow: { src: "/images/packs/run/contract-slip-narrow-v1.webp", signed: "/images/packs/run/contract-slip-narrow-signed-v1.webp" },
  wide: { src: "/images/packs/run/contract-slip-wide-v1.webp", signed: "/images/packs/run/contract-slip-wide-signed-v1.webp" },
};
const SEAL = "/images/packs/run/contract-seal-v1.webp";

const TILT = [-2.4, 1.6, -1.1];

/* One contract in the shop, as a paper slip pinned to the table: its mark,
   difficulty rings, name and rule, the prize as an ink stamp and a line to
   sign on. Tapping signs it (again unsigns): a pink signature scrawls across
   the line and a seal presses on. */
function ContractCard({
  contract,
  index,
  signed,
  narrow,
  disabled,
  delay,
  reducedMotion,
  onSign,
}: {
  contract: ChainContract;
  index: number;
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
  // The prize's ink, deepened so it prints on cream.
  const stamp = `color-mix(in srgb, ${CHAIN_REEL_INK[contract.prize.id]} 52%, ${KIT.dark})`;
  const w = narrow ? 108 : 184;
  const h = narrow ? 182 : 208;
  const ink = KIT.dark;
  const tilt = TILT[index % TILT.length];
  const lineY = h - (narrow ? 22 : 26);
  return (
    <motion.button
      type="button"
      aria-pressed={signed}
      title={signed ? t`Signed: tap to unsign` : t`Sign for the next round`}
      disabled={disabled}
      onClick={onSign}
      className="relative shrink-0 text-left disabled:cursor-default"
      style={{ width: w, height: h }}
      initial={reducedMotion ? false : { y: 30, opacity: 0, rotate: tilt - 6 }}
      animate={{ y: signed ? -10 : 0, opacity: 1, rotate: signed ? tilt * 0.4 : tilt }}
      whileHover={disabled || reducedMotion ? undefined : { y: signed ? -12 : -5, rotate: tilt * 0.6 }}
      transition={{ type: "spring", stiffness: 420, damping: 24, delay: reducedMotion ? 0 : delay }}
    >
      <img
        src={signed ? SLIP[narrow ? "narrow" : "wide"].signed : SLIP[narrow ? "narrow" : "wide"].src}
        width={w}
        height={h}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="pointer-events-none absolute inset-0 select-none"
      />
      <svg width={w} height={h} className="absolute inset-0 overflow-visible" aria-hidden="true">
        {/* The line to sign on, short of the dog-eared corner. */}
        <path d={`M${narrow ? 11 : 15} ${lineY} H${w - (narrow ? 20 : 26)}`} stroke="rgba(18,12,24,0.45)" strokeWidth={1.4} />
        <text x={narrow ? 11 : 15} y={lineY - 4} fontFamily="var(--font-sans)" fontWeight={900} fontSize={narrow ? 9 : 11} fill="rgba(18,12,24,0.45)">
          x
        </text>
        {signed && (
          <motion.path
            d={`M${narrow ? 22 : 30} ${lineY - 3} c 5 -9, 8 5, 13 -3 s 7 -7, 10 1 s 8 -4, 13 -5 s 5 6, ${narrow ? 12 : 26} -2`}
            fill="none"
            stroke={KIT.pink}
            strokeWidth={narrow ? 2.4 : 3}
            strokeLinecap="round"
            initial={reducedMotion ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.45, ease: "easeOut" }}
          />
        )}
      </svg>
      <div className={`absolute inset-x-0 top-0 flex flex-col ${narrow ? "px-3 pt-[27px]" : "px-[18px] pt-[30px]"}`} style={{ bottom: h - lineY + (narrow ? 12 : 16) }}>
        <div className="flex items-start justify-between">
          <ContractIcon id={contract.id} size={narrow ? 22 : 28} ink={ink} />
          <TierRings count={TIER_RINGS[tier]} ink="rgba(18,12,24,0.55)" />
        </div>
        <div className="mt-1 leading-none" style={{ fontFamily: MARKER, fontSize: narrow ? 14 : 21, color: ink }}>
          {i18n._(copy.name)}
        </div>
        <div className={`mt-1 font-bold leading-snug ${narrow ? "text-[10px]" : "text-[12.5px]"}`} style={{ color: "rgba(18,12,24,0.68)" }}>
          {i18n._(copy.rule)}
        </div>
        {/* The prize, stamped. */}
        <div
          className={`mt-auto self-start rounded-[6px] border-2 leading-none ${narrow ? "px-1.5 py-1" : "px-2 py-1.5"}`}
          style={{ borderColor: stamp, color: stamp, transform: `rotate(${-tilt * 1.6 - 3}deg)` }}
          title={tile.text}
        >
          <div className={`font-black uppercase tracking-[0.18em] ${narrow ? "text-[7px]" : "text-[9px]"}`} style={{ opacity: 0.8 }}>
            <Trans>Pays</Trans>
          </div>
          <div className="mt-0.5 flex items-baseline gap-1">
            <span style={{ fontFamily: MARKER, fontSize: narrow ? 15 : 22 }}>{tile.mark}</span>
            <span className={`truncate font-black ${narrow ? "text-[9px]" : "text-[12px]"}`}>{tile.word}</span>
          </div>
        </div>
      </div>
      {signed && (
        <motion.img
          src={SEAL}
          alt={t`Signed`}
          draggable={false}
          className="pointer-events-none absolute select-none"
          style={{ right: narrow ? -12 : -14, bottom: narrow ? 2 : 4, width: narrow ? 46 : 60, height: narrow ? 46 : 60 }}
          initial={reducedMotion ? false : { scale: 2.2, opacity: 0, rotate: -30 }}
          animate={{ scale: 1, opacity: 1, rotate: -8 }}
          transition={{ type: "spring", stiffness: 600, damping: 16, delay: reducedMotion ? 0 : 0.3 }}
        />
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
      <div className={`mt-5 flex justify-center ${narrow ? "gap-1.5" : "gap-6"}`}>
        {contracts.map((contract, index) => (
          <ContractCard
            key={`${contract.id}-${index}`}
            contract={contract}
            index={index}
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
