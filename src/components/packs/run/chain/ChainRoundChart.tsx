import { Trans, useLingui } from "@lingui/react/macro";
import { CHAIN_ROUND_CHART, type ChainCard } from "#/lib/chain-run";
import { KIT } from "./chainKit";

/* The chart a round is set on (CHAIN_ROUND_CHART): the HUD wears it while
   the round plays, with the bonus it gives. */

const chip = "whitespace-nowrap rounded-full px-1.5 py-[1px] text-[11px] font-black leading-[14px]";

export function RoundChartTag({ chart, compact = false }: { chart: ChainCard; compact?: boolean }) {
  const { t } = useLingui();
  const info = chart.chart;
  if (!info) return null;
  const fits = `${chart.key}K ${chart.skill}`;
  const stars = info.stars.toFixed(2);
  return (
    <div
      className="flex items-center gap-2.5 rounded-[12px] border-[2.5px] p-1 pr-3 leading-none"
      style={{ borderColor: KIT.cream, background: KIT.dark, boxShadow: "0 4px 0 rgba(0,0,0,0.45)" }}
      title={t`This round is set on ${chart.name} [${info.version}]. ${fits} cards score x${CHAIN_ROUND_CHART.skill}.`}
    >
      <img
        src={chart.avatarUrl}
        alt=""
        draggable={false}
        className="shrink-0 rounded-[8px] object-cover"
        style={{ width: compact ? 44 : 76, height: compact ? 28 : 44, background: "#2a2032" }}
      />
      {/* The box is as wide as the chips, or the title up to 320px, and the
          title truncates past that. */}
      <div>
        {!compact && (
          <div className="min-w-full truncate text-[14px] font-black text-[#f3e9d8]" style={{ width: "min(max-content, 320px)" }}>
            {chart.name} <span style={{ color: KIT.gold }}>[{info.version}]</span>
          </div>
        )}
        <div className={`flex items-center gap-1.5 ${compact ? "" : "mt-1.5"}`}>
          {!compact && (
            <span className={chip} style={{ background: KIT.gold, color: KIT.dark }}>
              <Trans>{stars} stars</Trans>
            </span>
          )}
          <span className={chip} style={{ background: KIT.gold, color: KIT.dark }}>
            {fits}
          </span>
          <span className="whitespace-nowrap text-[12px] font-black" style={{ color: KIT.gold }}>
            x{CHAIN_ROUND_CHART.skill}
          </span>
        </div>
      </div>
    </div>
  );
}
