import { MANIA_TIER_STYLES, type ManiaCardTier } from "#/lib/maniacard";
import { formatNumber } from "#/lib/format";
import type { LivePackCommunityTotals } from "#/lib/live-backend";
import { Section, SectionHeading, StatSkeleton } from "./chrome";

/* The size of the game, in the numbers people actually ask for, plus the
   rarity table underneath. No captions explaining what a pack is: anyone
   reading this has opened one. */

const TIER_ORDER: ManiaCardTier[] = [
  "goat",
  "eternal",
  "worldClass",
  "ascendant",
  "mythic",
  "legendary",
  "ultraRare",
  "superRare",
  "elite",
  "rare",
  "common",
];

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1">{label}</div>
      <div translate="no" className="mt-1 text-3xl font-black leading-none text-white tabular-nums sm:text-4xl">
        {value}
      </div>
      {hint ? <div className="mt-1 text-[11px] text-osu-f1 tabular-nums">{hint}</div> : null}
    </div>
  );
}

export function CommunityStatsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
      {[0, 1, 2, 3].map((index) => <StatSkeleton key={index} />)}
    </div>
  );
}

export function CommunityStatsHeader({ totals }: { totals: LivePackCommunityTotals }) {
  const tiers = TIER_ORDER.map((tier) => ({ tier, copies: totals.tierCopies[tier] ?? 0 })).filter(
    (entry) => entry.copies > 0,
  );
  const unrated = totals.tierCopies.unrated ?? 0;

  return (
    <div className="space-y-10">
      <Section>
        <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
          <Stat label="packs opened" value={formatNumber(totals.packsOpened)} />
          <Stat label="cards minted" value={formatNumber(totals.cardsMinted)} />
          <Stat label="collectors" value={formatNumber(totals.collectors)} />
          <Stat
            label="players carded"
            value={formatNumber(totals.playersCarded)}
            hint={totals.poolTotal > 0 ? `of ${formatNumber(totals.poolTotal)} pullable` : undefined}
          />
        </div>
      </Section>

      {tiers.length > 0 && (
        <Section>
          <SectionHeading>copies in circulation</SectionHeading>
          <div className="mt-2.5 flex flex-wrap items-baseline gap-x-5 gap-y-2">
            {tiers.map(({ tier, copies }) => (
              <div key={tier} className="flex items-baseline gap-1.5">
                <span className="text-[11px] font-semibold" style={{ color: `rgb(${tierRgb(tier)})` }}>
                  {MANIA_TIER_STYLES[tier].label}
                </span>
                <span translate="no" className="text-[15px] font-bold text-white tabular-nums">
                  {formatNumber(copies)}
                </span>
              </div>
            ))}
            {unrated > 0 && (
              <div className="flex items-baseline gap-1.5">
                <span className="text-[11px] font-semibold text-osu-f1">Unrated</span>
                <span translate="no" className="text-[15px] font-bold text-white tabular-nums">
                  {formatNumber(unrated)}
                </span>
              </div>
            )}
          </div>
          <div className="mt-3 text-[11px] text-osu-f1">
            <span translate="no" className="font-bold text-white tabular-nums">
              {formatNumber(totals.oneOfAKind)}
            </span>{" "}
            players sit in exactly one collection.{" "}
            <span translate="no" className="font-bold text-white tabular-nums">
              {formatNumber(totals.cardsRecycled)}
            </span>{" "}
            copies have been recycled.
          </div>
        </Section>
      )}
    </div>
  );
}

/* The vivid rgb triplet of a tier's palette, pulled off its badge halo the way
   the collection's filter chips do, so a tier reads as itself rather than as a
   row of white text. */
function tierRgb(tier: ManiaCardTier): string {
  const match = MANIA_TIER_STYLES[tier].badgeHalo.match(/([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  return match ? `${match[1]}, ${match[2]}, ${match[3]}` : "148, 163, 184";
}
