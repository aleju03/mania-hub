import { Trans, useLingui } from "@lingui/react/macro";
import { MANIA_TIER_STYLES, type ManiaCardTier } from "#/lib/maniacard";
import { formatNumber } from "#/lib/format";
import type { LivePackCommunityTotals } from "#/lib/live-backend";
import { HeadingSkeleton, NoteSkeleton, Section, SectionHeading, SkeletonBlock, StatSkeleton } from "./chrome";
import { CountingNumber } from "./CountingNumber";

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

/* Counted rather than swapped: the totals a pull moves are advanced off the
   live pull stream, so these change under the reader. tabular-nums is what
   keeps the count from shuffling the digits sideways while it runs. */
function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1">{label}</div>
      <CountingNumber
        value={value}
        className="mt-1 block text-3xl font-black leading-none text-white tabular-nums sm:text-4xl"
      />
      {hint ? <div className="mt-1 text-[11px] text-osu-f1 tabular-nums">{hint}</div> : null}
    </div>
  );
}

export function CommunityStatsSkeleton() {
  return (
    <div className="space-y-10">
      <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
        {/* Only the last stat carries a hint, and a grid row is as tall as its
            tallest cell, so that one line has to be reserved here too. */}
        {[0, 1, 2, 3].map((index) => <StatSkeleton key={index} withHint={index === 3} />)}
      </div>
      {/* The rarity table belongs to this header. Leaving it out of the
          skeleton pushed the record boards a section's worth down the page the
          moment the numbers landed. Each label is reserved at the width its
          tier's name takes, so the run wraps where the real one does. */}
      <div>
        <HeadingSkeleton />
        <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-2">
          {TIER_ORDER.map((tier) => (
            <div key={tier} className="flex h-[23px] items-center gap-1.5">
              {/* Six pixels a character is what the 11px labels measure, and
                  w-11 is the six-figure count next to them: near enough that
                  the run wraps onto the second line where the real one does. */}
              <SkeletonBlock className="h-2.5" style={{ width: MANIA_TIER_STYLES[tier].label.length * 6 }} />
              <SkeletonBlock className="h-3 w-11" />
            </div>
          ))}
        </div>
        <NoteSkeleton width="w-72" className="mt-3" />
      </div>
    </div>
  );
}

export function CommunityStatsHeader({ totals }: { totals: LivePackCommunityTotals }) {
  const { t } = useLingui();
  const tiers = TIER_ORDER.map((tier) => ({ tier, copies: totals.tierCopies[tier] ?? 0 })).filter(
    (entry) => entry.copies > 0,
  );
  const unrated = totals.tierCopies.unrated ?? 0;

  return (
    <div className="space-y-10">
      <Section>
        <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
          <Stat label={t`packs opened`} value={totals.packsOpened} />
          {/* Every copy anyone holds, duplicates counted. Not "minted": that is
              collectible-trade jargon for making a copy, which reads here as a
              mapper's name and tells nobody what the number is. */}
          <Stat label={t`cards collected`} value={totals.cardsMinted} />
          <Stat label={t`collectors`} value={totals.collectors} />
          <Stat
            label={t`players carded`}
            value={totals.playersCarded}
            hint={totals.poolTotal > 0 ? t`of ${formatNumber(totals.poolTotal)} pullable` : undefined}
          />
        </div>
      </Section>

      {tiers.length > 0 && (
        <Section>
          <SectionHeading><Trans>copies in circulation</Trans></SectionHeading>
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
                <span className="text-[11px] font-semibold text-osu-f1"><Trans>Unrated</Trans></span>
                <span translate="no" className="text-[15px] font-bold text-white tabular-nums">
                  {formatNumber(unrated)}
                </span>
              </div>
            )}
          </div>
          <div className="mt-3 text-[11px] text-osu-f1">
            <Trans>
              <span translate="no" className="font-bold text-white tabular-nums">
                {formatNumber(totals.oneOfAKind)}
              </span>{" "}
              players sit in exactly one collection.
            </Trans>{" "}
            <Trans>
              <span translate="no" className="font-bold text-white tabular-nums">
                {formatNumber(totals.cardsRecycled)}
              </span>{" "}
              copies have been recycled.
            </Trans>
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
