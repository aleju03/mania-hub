import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { getI18n } from "../lib/i18n";
import { getDanImageSrc } from "../lib/dan-images";
import { DanLevelBadge } from "../components/player/DanLevelBadge";
import { creditedDanFor, danCreditOptionsFor, danCreditOffset, type DanCreditClearContext } from "#dan/dan-credit";
import { danLabelFor } from "#dan/chart-classifier";
import { formatDate, formatNumber } from "../lib/format";
import { useLocale } from "../lib/locale-context";
import { ModBadge } from "../components/ui/ModBadge";
import { DAN_SKILLSET_META } from "../lib/skill-axes";
import { pageSeo } from "../lib/seo";
import { track } from "../lib/analytics";
import { useHasHydrated, useNoDans } from "../store";

/* The one place the dan estimate explains itself in full.

   Every number quoted here is either a constant from the estimator (the
   accuracy bars, the quorum, the LN line) or a measurement taken from the
   production corpus in August 2026, which is why the counts are given as
   approximations and dated in the text. Chart names, ladder names and dan
   labels are identifiers and stay untranslated. */

export const Route = createFileRoute("/dan-estimates")({
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: i18n._(msg`How dan levels are estimated`),
      description: i18n._(
        msg`How every osu!mania chart gets a dan level, and how a player's dan is read from the charts they have passed.`,
      ),
      path: "/dan-estimates",
      origin: match.context.origin,
      imageKind: "rankings",
      imageTitle: "How dan levels are estimated",
    });
  },
  component: DanEstimatesPage,
});

// The 4K LN courses are numbered up to 10 and named from 11 up, the way the
// ladder itself reads them.
const LN_4K_LEVEL_NAMES: Record<string, string> = {
  "11": "Yoake",
  "12": "Yuugure",
  "13": "Yoru",
  "14": "Yami",
  "15": "Yume",
  "16": "Yokaze",
  "17": "Yeehee",
};

// Every supported ladder, in the order its community reads it.
// The labels are the ones getDanImageSrc keys its artwork on, so a level with
// no badge on disk simply does not render rather than 404ing.
const LADDERS: Array<{ key: LadderKey; keyCount?: number; family?: "ln"; levels: string[]; levelNames?: Record<string, string> }> = [
  {
    key: "4k-regular",
    levels: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"],
  },
  {
    key: "4k-ln",
    family: "ln",
    levels: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17"],
    levelNames: LN_4K_LEVEL_NAMES,
  },
  {
    key: "7k-regular",
    keyCount: 7,
    levels: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "gamma", "azimuth", "zenith", "stellium"],
  },
  {
    key: "7k-ln",
    keyCount: 7,
    family: "ln",
    levels: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "gamma", "azimuth", "zenith", "stellium"],
  },
  {
    key: "6k-regular",
    keyCount: 6,
    levels: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "terra", "celestial", "mystery", "nihility", "finish"],
  },
  {
    key: "6k-ln",
    keyCount: 6,
    family: "ln",
    levels: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "terra", "celestial", "mystery", "nihility", "finish"],
  },
];

type LadderKey = "4k-regular" | "4k-ln" | "7k-regular" | "7k-ln" | "6k-regular" | "6k-ln";

// Deliberately unranked picks (loved and graveyard), because the ladders are
// read on charts the ranked section never got. Every dan here is the estimate
// the site itself stores for that chart, not a hand-written guess.
// rawDan is the number behind the label, kept because the credit curve scores
// a real accuracy against it: rounding "alpha++" back to a bare alpha would
// have the badge under-read the chart it names.
const CHART_EXAMPLES: Array<{ id: number; map: string; ladder: LadderKey; dan: string; rawDan: number }> = [
  { id: 2675345, map: "Sewerslvt - Cyberia lyr3 [4K Scalpels]", ladder: "4k-regular", dan: "4", rawDan: 4.04 },
  { id: 1561270, map: "Laur - A Lasting Promise [4K EXHAUST]", ladder: "4k-regular", dan: "7", rawDan: 6.93 },
  { id: 1887434, map: "CROOVE - Aquaris [4K Wanderer]", ladder: "4k-regular", dan: "10", rawDan: 10.05 },
  { id: 3729620, map: "jea - Makiba [4K Extra]", ladder: "4k-regular", dan: "alpha++", rawDan: 11.44 },
  { id: 2793593, map: "saikoro - far in the blue sky... [4K 42]", ladder: "4k-regular", dan: "delta+", rawDan: 14.25 },
  { id: 3629313, map: "youman - R.I.P. [4K cacophony 1.1x (297bpm)]", ladder: "4k-ln", dan: "10", rawDan: 10 },
  { id: 1920630, map: "Minami - Kawaki Wo Ameku [7K Lovely]", ladder: "7k-ln", dan: "9+", rawDan: 9.2 },
  { id: 4596114, map: "-45 - G e n g a o z o [7K N G]", ladder: "7k-regular", dan: "gamma+", rawDan: 11.2 },
  { id: 1325722, map: "Kobaryo - Cartoon Candy [CS' 6K Milk Chocolate]", ladder: "6k-regular", dan: "terra+", rawDan: 9.5 },
];

// Measured against the production DB in August 2026 (read-only). The article
// dates them rather than pretending they are live, so a drift of a few hundred
// does not make the page wrong.
// One bar per level of the ladder, counted by the displayed label
// (the tier suffix stripped), not by rounding the raw number: parseDan's bands
// are not integers, so rounding invented a theta nobody holds. Measured against
// the production DB in August 2026, read-only, in one pass so every number on
// the page agrees with the others.
// Level names are the ladder's own, so they are identifiers and stay untranslated.
const RICE_4K_POPULATION: Array<{ level: string; players: number }> = [
  { level: "1", players: 464 },
  { level: "2", players: 890 },
  { level: "3", players: 862 },
  { level: "4", players: 903 },
  { level: "5", players: 1252 },
  { level: "6", players: 1159 },
  { level: "7", players: 846 },
  { level: "8", players: 867 },
  { level: "9", players: 866 },
  { level: "10", players: 1087 },
  { level: "alpha", players: 1062 },
  { level: "beta", players: 1138 },
  { level: "gamma", players: 821 },
  { level: "delta", players: 539 },
  { level: "epsilon", players: 199 },
  { level: "zeta", players: 18 },
  { level: "eta", players: 1 },
];

// Set by hand whenever this page's own text changes: the deploy checkout is
// shallow, so git cannot supply the date at build time.
const LAST_EDITED = "2026-09-29";

function DanEstimatesPage() {
  const { t } = useLingui();
  const locale = useLocale();
  const navigate = useNavigate();
  const hydrated = useHasHydrated();
  const noDans = useNoDans();

  /* This page is worth counting on its own, so it says who it is instead of
     leaving the admin to pick /dan-estimates out of every pageview: the
     analytics tab's event lookup answers "who read the dan explainer" by name.
     Two events, because opening the page and reading it are different things -
     the second only fires once the end of the article has actually been on
     screen, and only once per visit. */
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hydrated || noDans) return;
    track("dan_estimates_view");
  }, [hydrated, noDans]);
  useEffect(() => {
    if (!hydrated || noDans) return;
    const end = endRef.current;
    if (!end || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      track("dan_estimates_read");
    });
    observer.observe(end);
    return () => observer.disconnect();
  }, [hydrated, noDans]);

  useEffect(() => {
    if (!hydrated || !noDans) return;
    void navigate({ to: "/rankings", search: { country: undefined, page: 1 }, replace: true });
  }, [hydrated, navigate, noDans]);

  if (noDans) return null;

  // Ladder names read the same in every table on the page, so they are named
  // once here rather than once per row.
  const ladderName: Record<LadderKey, string> = {
    "4k-regular": t`4K regular`,
    "4k-ln": t`4K LN`,
    "7k-regular": t`7K regular`,
    "7k-ln": t`7K LN`,
    "6k-regular": t`6K regular`,
    "6k-ln": t`6K LN`,
  };

  const accuracyBars: Array<{ ladder: string; bar: string }> = [
    { ladder: ladderName["4k-regular"], bar: "96%" },
    { ladder: ladderName["4k-ln"], bar: t`97%, on ScoreV2 accuracy` },
    { ladder: ladderName["7k-regular"], bar: t`96%, or 95% below 1st dan` },
    { ladder: ladderName["7k-ln"], bar: "95%" },
    { ladder: t`6K regular and LN`, bar: t`96% and 95%` },
  ];

  return (
    <div className="flex-1 bg-osu-b5">
      <article className="mx-auto flex w-full max-w-3xl flex-col gap-9 px-5 py-8 sm:px-6 sm:py-10">
        <header className="space-y-4">
          <h1 className="text-2xl font-black text-white sm:text-3xl">
            <Trans>How dan levels are estimated</Trans>
          </h1>
          <p className="text-[11px] text-osu-f1">
            <Trans>Last edited: {formatDate(LAST_EDITED, "UTC", locale)}</Trans>
          </p>
          <p className="text-[15px] leading-7 text-osu-f1">
            <Trans>
              Every chart gets a dan level, and your dan is worked out from the charts you have passed.
              That is why every estimate is written with a "~" in front of it.
            </Trans>
          </p>
        </header>

        {/* First on the page because it answers the question that brings most
            people here: why the estimate is lower than they expect. */}
        <p className="border-l-2 border-osu-pink-light pl-4 text-[15px] font-bold leading-7 text-white">
          <Trans>
            Automatic tracking began on June 9, 2026. Older scores count if they are still in your osu!
            top plays, and any missing pass with an osu! score link can be added from the Skills tab on
            your profile. Sessions with no score on a ranked, qualified or loved chart are not recorded
            at all.{' '}
            <a
              href="#limitations"
              className="text-osu-pink-light underline underline-offset-2 transition-colors hover:text-white"
            >
              Why that is
            </a>
          </Trans>
        </p>

        <Pipeline />

        <Section id="chart-levels" title={t`1. Every chart gets a dan level`}>
          <P>
            <Trans>
              The site reads each chart's notes and rates them with an engine picked for its keymode.
              The number that comes back is printed in the levels of that keymode's dan ladder.
              Keymodes without a ladder get no dan.
            </Trans>
          </P>
          <div className="space-y-3 py-1">
            {LADDERS.map((ladder) => (
              <div key={ladder.key} className="space-y-1.5">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-osu-f1">{ladderName[ladder.key]}</p>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  {ladder.levels.map((level) => {
                    const src = getDanImageSrc(level, ladder.family, ladder.keyCount);
                    const levelName = `${ladderName[ladder.key]} ${ladder.levelNames?.[level] ?? level}`;
                    return src ? (
                      <img
                        key={level}
                        src={src}
                        alt={levelName}
                        title={levelName}
                        width={30}
                        height={30}
                        className="h-[30px] w-[30px] object-contain"
                      />
                    ) : null;
                  })}
                </div>
              </div>
            ))}
          </div>
          <P>
            <Trans>
              Each level is split into five steps, so a chart can be 7--, 7-, 7, 7+ or 7++, from the
              easy end of 7th dan to the hard end.
            </Trans>
          </P>
          <Table
            head={[t`Chart`, t`Keymode`, t`Estimated dan`]}
            rows={CHART_EXAMPLES.map((row) => [
              <Link
                key={row.id}
                to="/maps"
                // Same escape hatch the other cross-route links into /maps use: the
                // route's search schema is 30+ defaulted keys and a Link only names one.
                search={{ map: row.id } as never}
                className="text-osu-pink-light transition-colors hover:text-white"
              >
                {row.map}
              </Link>,
              ladderName[row.ladder],
              row.dan,
            ])}
          />
          <Details summary={t`Rating engines and LN charts`}>
            <ul className="space-y-2 pl-5">
              <Li>
                <Trans>
                  <B>4K regular</B> uses the Mixed estimator from{' '}
                  <ExternalLink href="https://github.com/LeoBlackMT/osumania_map_analyser">Leo_Black's map analyser</ExternalLink>,
                  which blends{' '}
                  <ExternalLink href="https://github.com/LeoBlackMT/osumania_map_analyser/blob/HEAD/docs/roxy_algorithm.md">Roxy</ExternalLink>,{' '}
                  <ExternalLink href="https://github.com/LeoBlackMT/osumania_map_analyser/blob/HEAD/docs/azusa_algorithm.md">Azusa</ExternalLink>,{' '}
                  <ExternalLink href="https://thebagelofman.github.io/Daniel/">Daniel</ExternalLink> and{' '}
                  <ExternalLink href="https://github.com/sunnyxxy/Star-Rating-Rebirth">Sunny</ExternalLink>.
                </Trans>
              </Li>
              <Li>
                <Trans>
                  <B>4K LN</B> uses the same analyser's LN table, with a small model for the easy charts
                  below where the table starts.
                </Trans>
              </Li>
              <Li>
                <Trans>
                  <B>6K and 7K</B> use a Sunny star rating, mapped through the published 6K and 7K dan
                  tables.
                </Trans>
              </Li>
            </ul>
            <p>
              <Trans>
                A 4K chart is LN when holds make up at least 45% of its notes and those holds still
                need real releases at the rate you played. Holds short enough to play like taps make it
                a regular chart. On 7K the line is 37.5%.
              </Trans>
            </p>
          </Details>
        </Section>

        <Section id="credit" title={t`2. Your passes earn credit by accuracy`}>
          <P>
            <Trans>
              Each ladder has a pass bar, taken from its real dan courses:
            </Trans>
          </P>
          <Table
            head={[t`Ladder`, t`Pass bar`]}
            rows={accuracyBars.map((row) => [row.ladder, row.bar])}
          />
          <P>
            <Trans>
              Reaching the bar gives the chart's full level. Higher accuracy adds a bonus that stays
              small until 99%, and a score under the bar still counts for less, down to about five
              points below it. Accuracy is recalculated from your judgements, so stable and lazer
              scores count the same way.
            </Trans>
          </P>
          <CreditCurveTabs />
          <P>
            <Trans>
              Rates count at the speed you played. Runengon [4K Hard] is 4th dan at 1.0x and about 9th
              under <ModPill mod="DT" />, so a <ModPill mod="DT" /> pass on it counts as 9th, and a
              0.75x pass counts for what the chart is worth at 0.75x. OD works the same way:{' '}
              <ModPill mod="HR" /> and <ModPill mod="DA" /> rate the chart at the OD you played.
            </Trans>
          </P>
          <P>
            <Trans>
              A play under its ladder's minimum OD earns nothing: 5.5 on regular charts, 7 on 4K LN
              and 5 on 7K LN. <ModPill mod="EZ" /> never counts.
            </Trans>
          </P>
          <Details summary={t`Which plays are looked at`}>
            <p>
              <Trans>
                Your osu! top plays, everything recorded while you were tracked, and any score links you
                added, keeping your best play on each chart at each rate. Charts flagged as vibro are
                left out. A rate nobody has rated a chart at yet is worked out the first time your
                estimate needs it, so a play at an unusual rate can take a little while to count.
              </Trans>
            </p>
            <p>
              <Trans>
                On 4K jack charts the bonus above the bar is halved, since very high accuracy is normal
                there.
              </Trans>
            </p>
          </Details>
        </Section>

        <Section id="skills" title={t`3. Passes are sorted into skills`}>
          <P>
            <Trans>
              Each pass goes into the skill its chart asks for most. A chart that is clearly two things
              at once, such as a long tech chart, counts in both.
            </Trans>
          </P>
          <SkillGrid />
          <Details summary={t`How a chart's skill is picked`}>
            <p>
              <Trans>
                4K regular reads the play's MSD skillsets: jack from JackSpeed and Chordjack, tech from
                Technical and Jumpstream, speed from Stream, and stamina from Handstream and Stamina.
                Speed and tech are told apart by how the chart is played, and a chart that could be
                either counts as both.
              </Trans>
            </p>
            <p>
              <Trans>
                6K and 7K use the pattern tags from the chart analysis instead, because MinaCalc does
                not rate Technical on those keymodes. 4K LN follows the four skillsets the 4K LN dan
                course stages are named for.
              </Trans>
            </p>
            <p>
              <Trans>
                A pass that counts in two skills only counts toward the four-pass minimum of the
                stronger one, so it can raise a skill you already have but cannot start one.
              </Trans>
            </p>
          </Details>
        </Section>

        <Section id="your-dan" title={t`4. Your dan is the average of your skills`}>
          <P>
            <Trans>
              Each skill's dan is the average of your best 20 passes in it, by the level each one
              credited. A skill needs at least four passes. Your dan is the average of your skill dans,
              so skills at 10, 9, 7 and 6 give 8.
            </Trans>
          </P>
          <P>
            <Trans>
              Skills with fewer than four passes are left out rather than counted as zero. At the top
              of a ladder the "~" becomes "&gt;", meaning beyond that level.
            </Trans>
          </P>
          <Details summary={t`Other rules`}>
            <ul className="space-y-2 pl-5">
              <Li>
                <Trans>
                  Only your two best rate plays on the same chart count per ladder, rate reuploads
                  included.
                </Trans>
              </Li>
              <Li>
                <Trans>
                  Up to three passes in a skill are left out when they credit more than five levels
                  below the average of your best five in it. The dan window marks them <B>not counted</B>.
                </Trans>
              </Li>
              <Li>
                <Trans>
                  7K LN stays within one level of your General dan, because few hard Tech, Inverse and
                  Release charts exist. Those three still show their own numbers.
                </Trans>
              </Li>
              <Li>
                <Trans>
                  With fewer than two rated skills, your dan is the average of your 20 best passes
                  overall.
                </Trans>
              </Li>
            </ul>
          </Details>
        </Section>

        <Section id="courses" title={t`5. Dan courses and practice charts`}>
          <P>
            <Trans>
              If your plays show a dan course pass, your dan for that side <B>cannot read below that
              course</B>. It only ever raises the number, so the skill rows under it can read lower.
            </Trans>
          </P>
          <P>
            <Trans>
              Your accuracy sets the tier. On a ladder whose courses ask for 96%, a 96% pass on the
              delta course reads <B>delta</B>, 97.5% reads <B>delta+</B> and 98% and up reads{' '}
              <B>delta++</B>. 95% reads <B>delta-</B>, 94% reads <B>delta--</B>, and below that it
              gives nothing.
            </Trans>
          </P>
          <P>
            <Trans>
              Skillset practice charts do the same for one skill. Clearing{' '}
              <Link
                to="/maps"
                search={{ map: 4969890 } as never}
                className="text-osu-pink-light transition-colors hover:text-white"
              >Volcanic ~ Delta ~</Link>{' '}
              at the bar sets your 4K speed dan to <B>delta</B>, without the four passes a skill
              normally needs. Every ladder has them except 6K.
            </Trans>
          </P>
          <p className="text-[17px] font-bold leading-7 text-white">
            <Trans>Clicking your dan badge shows the course that set your estimate, when one did.</Trans>
          </p>
          <Details summary={t`Course packs and allowed mods`}>
            <CourseList />
            <p>
              <Trans>
                A pass has to be on one of these exact difficulties. REFORM's three INTRO courses and
                the 0th to 2nd of Jinjin's LN Phase I are left out, because they sit below the first
                level their ladder measures.
              </Trans>
            </p>
            <p>
              <Trans>
                Easy, No Fail, Random and anything that slows the chart down void a course run. Mirror,
                Hidden, Fade In, Flashlight, Hard Rock, Sudden Death, Perfect and Double Time are fine. A
                pass recorded before mod data was stored does not count.
              </Trans>
            </p>
            <p>
              <Trans>
                Practice charts are matched by their notes and OD, so any upload of the same file
                counts. <ModPill mod="NF" />, <ModPill mod="EZ" />, <ModPill mod="HR" />,{' '}
                <ModPill mod="DA" /> and slowing the chart down void them.
              </Trans>
            </p>
          </Details>
        </Section>

        <Section id="limitations" title={t`Limitations`}>
          <P>
            <Trans>
              The estimate only sees scores the site has. Missing older scores can be added with{' '}
              <B>Add a missing score</B> on the Skills tab of your profile.
            </Trans>
          </P>
          <P>
            <Trans>
              The site notices you are playing from osu!'s feed of new scores, which only lists charts
              with a leaderboard. Once it sees one, it checks your recent plays every few minutes,
              unranked charts included, until 30 minutes pass without a new play.{' '}
              <strong className="text-[17px] font-bold text-white">
                If you only play unranked charts, nothing is recorded automatically.
              </strong>
            </Trans>
          </P>
        </Section>

        <Section title={t`Where players land`}>
          <P>
            <Trans>
              At the time of writing, 12,974 players had a 4K regular dan. This is where they landed:
            </Trans>
          </P>
          <DanDistribution rows={RICE_4K_POPULATION} />
          <DanShareRing rows={RICE_4K_POPULATION} />
        </Section>

        <Section title={t`Where to see it`}>
          <P>
            <Trans>
              Your own estimate is on the Skills tab of your player page. Click any dan badge there to
              see the passes behind it. Everyone else is on the{' '}
              <Link
                to="/rankings"
                search={{ tab: "dan" as const, country: undefined }}
                className="text-osu-pink-light underline underline-offset-2 transition-colors hover:text-white"
              >
                Dan tab of the rankings page
              </Link>
              .
            </Trans>
          </P>
        </Section>

        <div ref={endRef} aria-hidden="true" />
      </article>
    </div>
  );
}

/* The same population as a share of the whole, which the bar chart cannot show:
   bars answer "how many sit at each level", a pie answers "how much of the population
   is each band", and the second question is the one people do in their head off
   the counts above.

   Slices are the bar chart's collapsed columns, with anything under
   PIE_MIN_SHARE folded up into the level below it: eta is 1 player in 12,974,
   which is three hundredths of a degree of arc and cannot be drawn at all, let
   alone read. The fold is named on the slice ("zeta and up") rather than
   quietly dropped.

   Every percentage sits outside the rim, never on the fill: on a slice it would
   collide with the badge and would be white type on a saturated colour, and out
   here it wears the page's own text token. Labels on the thin slices are fanned
   apart to PIE_LABEL_MIN_GAP_DEG and joined back to their own wedge by a stem,
   because the top three levels together are under 6% and their true angles sit
   on top of each other.

   Each level wears its own course badge's colour, sampled off the artwork:
   beta gold, gamma green, delta orange, epsilon pink, zeta sky, alpha the red
   end of its orange. Only the two numbered bands are free choices, since their
   badges are plain type. The hues are the badges'; the lightness of each is not,
   and was solved rather than picked - every slot sits inside the dark-mode
   OKLCH band, clears 3:1 against the page, and the pass moved alpha down and
   beta up specifically because orange beside gold is the one neighbouring pair
   that merges under colour blindness. It lands at dE 7.5 simulated, inside the
   6-8 floor band, which is legal only because colour is not carrying identity
   here: every slice is labelled with its own badge and separated by a
   surface-coloured gap, so the chart reads with the colour taken away entirely.
   Re-run the palette through a CVD check before touching any of these values. */
const PIE_MIN_SHARE = 0.005;
const PIE_RADIUS = 44;
// Surface-coloured gap between neighbouring slices, in viewBox units.
const PIE_GAP = 0.8;
// A slice narrower than this cannot seat its badge, so the badge rides outside
// the rim beside its percentage.
const PIE_INSIDE_MIN_SHARE = 0.07;
const PIE_LABEL_MIN_GAP_DEG = 14;
const PIE_COLORS = ["#9847ca", "#497cfd", "#ce3401", "#b48706", "#04ab62", "#c96805", "#e14076", "#0994ba"];

/** A point on the circle, clockwise from twelve o'clock. */
function polar(deg: number, distance: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: 50 + distance * Math.cos(rad), y: 50 + distance * Math.sin(rad) };
}

/** The wedge path for one slice, as a filled sector from the centre. */
function sectorPath(fromDeg: number, toDeg: number, radius: number): string {
  const from = polar(fromDeg, radius);
  const to = polar(toDeg, radius);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M 50 50 L ${from.x.toFixed(3)} ${from.y.toFixed(3)} A ${radius} ${radius} 0 ${large} 1 ${to.x.toFixed(3)} ${to.y.toFixed(3)} Z`;
}

function DanShareRing({ rows }: { rows: Array<{ level: string; players: number }> }) {
  const { t } = useLingui();
  const [hovered, setHovered] = useState<string | null>(null);

  const total = rows.reduce((sum, row) => sum + row.players, 0);
  const banded = [
    ...NUMERIC_GROUPS.map(([from, to]) => {
      const band = rows.filter(
        (row) => /^\d+$/.test(row.level) && Number(row.level) >= Number(from) && Number(row.level) <= Number(to),
      );
      return { key: `${from}-${to}`, levels: [from, to], players: band.reduce((sum, row) => sum + row.players, 0) };
    }),
    ...rows.filter((row) => !/^\d+$/.test(row.level)).map((row) => ({ key: row.level, levels: [row.level], players: row.players })),
  ];
  // Fold the tail: walk down from the top while each level is too thin to draw.
  let foldFrom = banded.length;
  while (foldFrom > 1 && banded[foldFrom - 1].players / total < PIE_MIN_SHARE) foldFrom -= 1;
  const folded = banded.slice(foldFrom);
  const slices = [
    ...banded.slice(0, foldFrom).map((band) => ({ ...band, folded: false })),
    ...(folded.length > 0
      ? [{
        key: `${folded[0].key}+`,
        levels: [folded[0].levels[0]],
        players: folded.reduce((sum, band) => sum + band.players, 0),
        folded: true,
      }]
      : []),
  ];

  const share = (players: number) => `${((players / total) * 100).toFixed(1)}%`;

  let cursor = 0;
  const wedges = slices.map((slice, index) => {
    const sweep = (slice.players / total) * 360;
    // Half a gap comes off each end, so the gaps read as even all round. A
    // slice thinner than the gap keeps a hairline rather than inverting.
    const gapDeg = Math.min((PIE_GAP / (2 * Math.PI * PIE_RADIUS)) * 180, sweep / 3);
    const wedge = {
      slice,
      color: PIE_COLORS[index % PIE_COLORS.length],
      path: sectorPath(cursor + gapDeg, cursor + sweep - gapDeg, PIE_RADIUS),
      mid: cursor + sweep / 2,
      labelAngle: cursor + sweep / 2,
      inside: slice.players / total >= PIE_INSIDE_MIN_SHARE,
    };
    cursor += sweep;
    return wedge;
  });

  // Fan the labels apart, working back from the last one so the tail spreads
  // away from twelve o'clock instead of running into the first slice. Every
  // slice takes part, not just the ones whose badge went outside: a wedge can
  // be wide enough to seat its badge and still have its percentage land in the
  // crowd at the top. A wide slice's own angle always wins the Math.min, so
  // this only ever moves the thin end of the ladder.
  for (let index = wedges.length - 2; index >= 0; index -= 1) {
    wedges[index].labelAngle = Math.min(wedges[index].labelAngle, wedges[index + 1].labelAngle - PIE_LABEL_MIN_GAP_DEG);
  }

  return (
    <div className="flex justify-center py-2">
      <svg
        viewBox="-16 -16 132 132"
        className="h-[300px] w-[300px] sm:h-[360px] sm:w-[360px]"
        role="img"
        aria-label={t`Share of players at each dan level`}
      >
        {wedges.map(({ slice, color, path, mid, labelAngle, inside }) => {
          const dim = hovered != null && hovered !== slice.key;
          const badgeSize = inside ? 13 : 11;
          // Seated at 0.70 of the radius, not the centroid: a wedge is widest
          // near its rim, and a badge parked closer in overhangs its own slice.
          const seat = inside ? polar(mid, PIE_RADIUS * 0.7) : polar(labelAngle, PIE_RADIUS + 11);
          const label = inside ? polar(labelAngle, PIE_RADIUS + 8) : polar(labelAngle, PIE_RADIUS + 11);
          // Two badges joined by a rule for a numbered band, the same way the
          // bars below read "1 through 5" rather than as a single level.
          const badges = slice.levels.map((level) => ({ level, src: getDanImageSrc(level) }));
          const ruleWidth = 4;
          const rowWidth = badges.length * badgeSize + (badges.length - 1) * ruleWidth;
          return (
            <g
              key={slice.key}
              opacity={dim ? 0.4 : 1}
              className="transition-opacity duration-150"
              onMouseEnter={() => setHovered(slice.key)}
              onMouseLeave={() => setHovered((current) => (current === slice.key ? null : current))}
            >
              <title>{`${slice.key}: ${formatNumber(slice.players)} ${t`players`} (${share(slice.players)})`}</title>
              <path d={path} fill={color} />
              {!inside ? (
                <line
                  x1={polar(mid, PIE_RADIUS - 1).x}
                  y1={polar(mid, PIE_RADIUS - 1).y}
                  x2={polar(labelAngle, PIE_RADIUS + 5).x}
                  y2={polar(labelAngle, PIE_RADIUS + 5).y}
                  stroke={color}
                  strokeWidth="0.9"
                />
              ) : null}
              <g transform={`translate(${(seat.x - rowWidth / 2).toFixed(2)} ${(seat.y - badgeSize / 2).toFixed(2)})`}>
                {badges.map(({ level, src }, position) => {
                  const x = position * (badgeSize + ruleWidth);
                  return (
                    <g key={level}>
                      {position > 0 ? (
                        <rect x={x - ruleWidth + 0.6} y={badgeSize / 2 - 0.4} width={ruleWidth - 1.2} height="0.8" rx="0.4" className="fill-osu-b1" />
                      ) : null}
                      {src
                        ? <image href={src} x={x} y={0} width={badgeSize} height={badgeSize} />
                        : <text x={x + badgeSize / 2} y={badgeSize / 2 + 2} textAnchor="middle" fontSize="6" className="fill-white font-black">{level}</text>}
                    </g>
                  );
                })}
                {slice.folded ? (
                  <text x={rowWidth - 0.5} y={badgeSize / 2 + 1.5} fontSize="5.5" className="fill-osu-f1 font-black">+</text>
                ) : null}
              </g>
              {/* Percentages ride outside the rim: inside they would sit on the
                  badge, and on the fill they would be white type on a
                  saturated colour. Out here they wear the page's text token. */}
              <text
                x={label.x}
                y={inside ? label.y + 2 : label.y + badgeSize / 2 + 6}
                textAnchor="middle"
                fontSize="5.5"
                className="fill-white font-black tabular-nums"
              >
                {share(slice.players)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* Sections below the fold arrive with a short rise as they come into view.
   SSR-safe on purpose: the server renders everything visible, and the hide is
   only applied after mount to sections still off screen, so crawlers and no-JS
   readers get the plain article and nothing above the fold ever flashes. */
function useScrollReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (element.getBoundingClientRect().top < window.innerHeight) return;
    setHidden(true);
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setHidden(false);
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, hidden };
}

// A section only takes an id when something on the page links down to it, and
// the scroll margin is there so the heading does not land under the sticky nav.
function Section({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  const { ref, hidden } = useScrollReveal<HTMLElement>();
  return (
    <section
      ref={ref}
      id={id}
      className={`space-y-3 transition-[opacity,transform] duration-500 ease-out ${
        hidden ? "translate-y-5 opacity-0" : "translate-y-0 opacity-100"
      }${id ? " scroll-mt-20" : ""}`}
    >
      <h2 className="text-lg font-bold text-white sm:text-xl">{title}</h2>
      {children}
    </section>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className="text-[15px] leading-7 text-osu-f1">{children}</p>;
}

// The registered dan courses, by pack. Kept beside the rule it explains rather
// than fetched, because it is a list of six ladders that changes when somebody
// edits the registry by hand - and when they do, both move together:
// live-backend/src/features/dan-courses.ts is the source of truth for which
// beatmaps count, and this is the reader-facing copy of the same six packs.
// Pack names are the beatmapsets' own titles, so they stay untranslated.
const COURSE_PACKS: Array<{ ladder: string; author: string; scoreV2Note?: true; packs: Array<{ name: string; setId: number }> }> = [
  {
    ladder: "4K regular",
    author: "Thaumiel",
    packs: [
      { name: "Dan ~ REFORM ~ 1st Pack", setId: 1079991 },
      { name: "2nd Pack", setId: 1079998 },
      { name: "FINAL", setId: 1156299 },
    ],
  },
  {
    ladder: "4K LN",
    author: "_underjoy, hypersovae, Lnlism",
    // The one row that needs a caveat: its courses are written for a mod osu!
    // will not file a score under unless you are on lazer.
    scoreV2Note: true,
    packs: [
      { name: "4K LN Dan Courses v2 Level 1", setId: 891143 },
      { name: "Level 2", setId: 891152 },
      { name: "Level 3", setId: 891157 },
      { name: "Extra Level", setId: 891164 },
      { name: "FINAL", setId: 1116467 },
      { name: "16th - Yokaze", setId: 2243057 },
      { name: "17th - Yeehee", setId: 2340696 },
    ],
  },
  {
    ladder: "7K regular",
    author: "Jinjin",
    packs: [
      { name: "Regular Dan Phase I", setId: 450069 },
      { name: "Phase II", setId: 451788 },
      { name: "Phase III", setId: 930218 },
      { name: "Phase IV (Stellium)", setId: 1061136 },
    ],
  },
  {
    ladder: "7K LN",
    author: "Jinjin",
    packs: [
      { name: "LN Dan Phase I", setId: 450649 },
      { name: "Phase II", setId: 895138 },
      { name: "Phase III", setId: 1220647 },
      { name: "Phase IV (Stellium)", setId: 1061136 },
    ],
  },
  {
    ladder: "6K regular",
    author: "Arkman",
    packs: [
      { name: "6K Regular Dan Course Part I", setId: 1118057 },
      { name: "Part II", setId: 1702752 },
      { name: "Part III", setId: 1836285 },
    ],
  },
  {
    ladder: "6K LN",
    author: "[Crz]sunnyxxy",
    packs: [
      { name: "6K LN Dan Course Lower Band", setId: 1204287 },
      { name: "Upper Band", setId: 1234351 },
      { name: "Extra Band", setId: 1255809 },
    ],
  },
];

function CourseList() {
  // Folded away rather than printed: it answers one ladder's objection, and
  // the reader who has not hit that objection does not need the paragraph.
  const [noteOpen, setNoteOpen] = useState(false);
  /* Counted because the note is hidden by default: the number says whether
     anyone finds the ScoreV2 answer at all, which is the case for printing it
     instead. Only the opening counts, and only the first one of a visit, so
     toggling it shut and back open does not read as more readers. */
  const noteCounted = useRef(false);
  const openNote = () => {
    setNoteOpen((open) => {
      if (!open && !noteCounted.current) {
        noteCounted.current = true;
        track("dan_estimates_note");
      }
      return !open;
    });
  };
  return (
    <ul className="space-y-2 text-[15px] leading-7 text-osu-f1">
      {COURSE_PACKS.map((entry) => (
        <li key={entry.ladder}>
          <B>{entry.ladder}</B>
          <span className="text-osu-f2"> &middot; {entry.author}</span>
          {entry.scoreV2Note ? (
            <>
              <span className="text-osu-f2"> &middot; </span>
              <button
                type="button"
                onClick={openNote}
                className="text-osu-f2 underline underline-offset-2 transition-colors hover:text-white"
              >
                {noteOpen ? <Trans>hide the note</Trans> : <Trans>note on this</Trans>}
              </button>
            </>
          ) : null}
          <br />
          {entry.packs.map((pack, index) => (
            <span key={pack.setId + pack.name}>
              {index > 0 ? <span className="text-osu-f2">, </span> : null}
              <ExternalLink href={`https://osu.ppy.sh/beatmapsets/${pack.setId}#mania`}>{pack.name}</ExternalLink>
            </span>
          ))}
          {entry.scoreV2Note && noteOpen ? (
            <p className="mt-1 text-[14px] leading-6 text-osu-f2">
              <Trans>
                The 4K LN courses are meant to be played on ScoreV2. The problem is that osu!stable does
                not submit ScoreV2 scores, and most people are on stable (I think). But you do not need to
                play on ScoreV2 at all. Your ScoreV2 accuracy is worked out from your judgements. If a
                score is old enough that even the judgements are gone, a stable score needs 97.5% instead
                of 97%, because stable's accuracy is more generous and the same score reads about half a
                percent higher on it.
              </Trans>
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-osu-pink-light transition-colors hover:text-white"
    >
      {children}
    </a>
  );
}

// The mod badges read inline in a sentence, so they need the wrapper a bare
// ModBadge does not carry: baseline alignment and a hair of side spacing.
function ModPill({ mod }: { mod: string }) {
  return (
    <span className="mx-[0.15em] inline-flex translate-y-[0.28em]">
      <ModBadge mod={mod} size={0.85} />
    </span>
  );
}

function B({ children }: { children: ReactNode }) {
  return <strong className="font-bold text-white">{children}</strong>;
}

function Li({ children }: { children: ReactNode }) {
  return <li className="list-disc marker:text-osu-b3">{children}</li>;
}

// The long tail of each section: rules a reader only looks for when their own
// estimate surprises them, folded under a hairline so the page reads short.
function Details({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group border-t border-white/[0.07] pt-3">
      <summary className="cursor-pointer list-none text-[13px] font-bold text-osu-f1 transition-colors hover:text-white [&::-webkit-details-marker]:hidden">
        <span className="mr-1.5 inline-block text-osu-f2 transition-transform group-open:rotate-90">&rsaquo;</span>
        {summary}
      </summary>
      <div className="mt-3 space-y-3 text-[14px] leading-6 text-osu-f1">{children}</div>
    </details>
  );
}

/* The whole article in one row, worked through one real chart: the page's
   sections in order, each column a link down to its section. The chart level
   and the credit are computed with the estimator's own functions, so the
   figures cannot drift from what the site does. */
const PIPELINE_CHART = CHART_EXAMPLES.find((chart) => chart.id === 3729620)!;
const PIPELINE_ACCURACY = 0.98;
const PIPELINE_SKILLS: Array<{ id: string; dan: number }> = [
  { id: "jack", dan: 12 },
  { id: "tech", dan: 11 },
  { id: "speed", dan: 10 },
  { id: "stamina", dan: 11 },
];

function Pipeline() {
  const { t, i18n } = useLingui();
  const credited = creditedDanFor(PIPELINE_CHART.rawDan, PIPELINE_ACCURACY, 0.96, "rc", 4);
  const creditedLabel = credited == null ? PIPELINE_CHART.dan : danLabelFor(credited, "rc", 4);
  const average = PIPELINE_SKILLS.reduce((sum, skill) => sum + skill.dan, 0) / PIPELINE_SKILLS.length;
  const badge = (label: string, size: "sm" | "md" = "md", approximate = false) => (
    <DanLevelBadge label={label} keyCount={4} side="rc" size={size} approximate={approximate} formatLabel={(value) => value} />
  );
  const steps: Array<{ href: string; label: string; visual: ReactNode; caption: string }> = [
    {
      href: "#chart-levels",
      label: t`Chart`,
      visual: badge(PIPELINE_CHART.dan),
      caption: PIPELINE_CHART.map,
    },
    {
      href: "#credit",
      label: t`Your pass`,
      visual: (
        <span className="flex items-center gap-3">
          <span className="text-2xl font-bold tabular-nums text-white">98%</span>
          <svg viewBox="0 0 24 12" aria-hidden="true" className="-mr-2 h-3 w-6 shrink-0 text-osu-f1">
            <path d="M1 6h21M17 1.5 22 6l-5 4.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {badge(creditedLabel)}
        </span>
      ),
      caption: t`credited by accuracy against a 96% bar`,
    },
    {
      href: "#skills",
      label: t`Skills`,
      visual: (
        <span className="grid grid-cols-[auto_auto] items-center gap-x-3 gap-y-1">
          {PIPELINE_SKILLS.map((skill) => {
            const meta = DAN_SKILLSET_META[skill.id];
            return (
              <span key={skill.id} className="contents">
                <span className="text-[12px] font-bold" style={{ color: meta.color }}>{i18n._(meta.labelMsg)}</span>
                {badge(danLabelFor(skill.dan, "rc", 4), "sm")}
              </span>
            );
          })}
        </span>
      ),
      caption: t`each the average of your best 20 passes in it`,
    },
    {
      href: "#your-dan",
      label: t`Your dan`,
      visual: badge(danLabelFor(average, "rc", 4), "md", true),
      caption: t`the average of your skills`,
    },
  ];
  return (
    <ol className="grid grid-cols-2 gap-x-6 gap-y-6 border-y border-white/[0.07] py-5 sm:grid-cols-4">
      {steps.map((step, index) => (
        <li key={step.href}>
          <a href={step.href} className="group flex h-full flex-col">
            <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-osu-f1">
              {index + 1}. {step.label}
            </span>
            <span className="mt-3 flex min-h-[64px] items-center">{step.visual}</span>
            <span className="mt-2 text-[12px] leading-5 text-osu-f1 transition-colors group-hover:text-white">{step.caption}</span>
          </a>
        </li>
      ))}
    </ol>
  );
}

// The skills each ladder is split into, mirroring the backend's
// danSkillsetBuckets. 6K LN has no split and is averaged as one.
const SKILL_LADDERS: Array<{ ladder: string; skills: string[] }> = [
  { ladder: "4K regular", skills: ["jack", "tech", "speed", "stamina"] },
  { ladder: "4K LN", skills: ["lnhybrid", "lntechnical", "lnwalls", "lnspeed"] },
  { ladder: "6K/7K regular", skills: ["jack", "tech", "speed", "stream"] },
  { ladder: "7K LN", skills: ["lngeneral", "lntech", "lninverse", "lnrelease"] },
  { ladder: "6K LN", skills: [] },
];

function SkillGrid() {
  const { t, i18n } = useLingui();
  return (
    <div className="py-1">
      {SKILL_LADDERS.map((row) => (
        <div
          key={row.ladder}
          className="grid grid-cols-[96px_1fr] items-center gap-3 border-t border-white/[0.07] py-2.5 first:border-t-0 sm:grid-cols-[120px_1fr]"
        >
          <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-osu-f1">{row.ladder}</span>
          {row.skills.length > 0 ? (
            <span className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
              {row.skills.map((id) => {
                const meta = DAN_SKILLSET_META[id];
                return (
                  <span key={id} className="flex items-center gap-2 text-[15px] font-bold text-white">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: meta.color }} />
                    {i18n._(meta.labelMsg)}
                  </span>
                );
              })}
            </span>
          ) : (
            <span className="text-[15px] text-osu-f1">{t`one skill, no split`}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/* One series over the ladder itself, so it is one hue and the x axis is the dan
   artwork. The numbered levels collapse into two columns by default: they are
   two thirds of the population and flatten the greek tail otherwise. Clicking
   either one opens all ten, and the columns animate between the two states so
   the change reads as the same chart rearranging. */
const NUMERIC_GROUPS: Array<[string, string]> = [["1", "5"], ["6", "10"]];

function DanDistribution({ rows }: { rows: Array<{ level: string; players: number }> }) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const columns: Array<{ key: string; players: number; levels: string[]; group: boolean }> = expanded
    ? rows.map((row) => ({ key: row.level, players: row.players, levels: [row.level], group: /^\d+$/.test(row.level) }))
    : [
        ...NUMERIC_GROUPS.map(([from, to]) => {
          const band = rows.filter(
            (row) => /^\d+$/.test(row.level) && Number(row.level) >= Number(from) && Number(row.level) <= Number(to),
          );
          return {
            key: `${from}-${to}`,
            players: band.reduce((sum, row) => sum + row.players, 0),
            levels: [from, to],
            group: true,
          };
        }),
        ...rows
          .filter((row) => !/^\d+$/.test(row.level))
          .map((row) => ({ key: row.level, players: row.players, levels: [row.level], group: false })),
      ];
  const max = Math.max(...columns.map((column) => column.players), 1);
  const hint = expanded ? t`Click to group the numbered levels` : t`Click to open the numbered levels`;
  /* The top of the ladder is one person, and everybody who reads this page
     already knows which one. Guarded on the count so it disappears by itself
     the day a second player gets there. */
  const loneEta = (column: { key: string; players: number }) => column.key === "eta" && column.players === 1;

  /* The joke only lands if the browser actually showed the tooltip, which it
     does after about half a second of hover, so the dwell is the event rather
     than the pointer entering. Once per visit, and hover-only on purpose: a
     touch device never renders a title at all, so there is nothing there to
     have found. */
  const saragiTimer = useRef<number | null>(null);
  const saragiCounted = useRef(false);
  const clearSaragiTimer = () => {
    if (saragiTimer.current === null) return;
    window.clearTimeout(saragiTimer.current);
    saragiTimer.current = null;
  };
  useEffect(() => clearSaragiTimer, []);
  const startSaragiTimer = () => {
    if (saragiCounted.current || saragiTimer.current !== null) return;
    saragiTimer.current = window.setTimeout(() => {
      saragiTimer.current = null;
      saragiCounted.current = true;
      track("dan_estimates_saragi");
    }, 700);
  };

  return (
    <motion.div layout className="flex items-end gap-[2px] py-2 sm:gap-1">
      <AnimatePresence initial={false} mode="popLayout">
        {columns.map((column) => (
          <motion.div
            key={column.key}
            layout
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ type: "spring", stiffness: 340, damping: 34, mass: 0.6 }}
            className="flex min-w-0 flex-1 flex-col items-center gap-1"
          >
            <button
              type="button"
              onClick={column.group ? () => setExpanded((value) => !value) : undefined}
              onMouseEnter={loneEta(column) ? startSaragiTimer : undefined}
              onMouseLeave={loneEta(column) ? clearSaragiTimer : undefined}
              className={`flex w-full flex-col items-center gap-1 ${column.group ? "cursor-pointer" : "cursor-default"}`}
              title={loneEta(column) ? t`Yes, this is saragi` : `${column.key}: ${formatNumber(column.players)}${column.group ? ` · ${hint}` : ""}`}
            >
              <span className="hidden text-[10px] font-bold tabular-nums text-white sm:block">
                {formatNumber(column.players)}
              </span>
              <span className="flex h-[140px] w-full items-end sm:h-[180px]">
                <motion.span
                  layout
                  className="block w-full rounded-t-[3px] bg-osu-pink"
                  initial={false}
                  animate={{ height: `${Math.max(1.5, (column.players / max) * 100)}%` }}
                  transition={{ type: "spring", stiffness: 260, damping: 30 }}
                />
              </span>
              {/* A grouped column shows both ends of its range, joined by a rule so
                  it reads as "1 through 5" rather than as two separate levels. */}
              <span className="flex items-center justify-center gap-[2px]">
                {column.levels.map((level, index) => {
                  const src = getDanImageSrc(level);
                  return (
                    <span key={level} className="flex items-center gap-[2px]">
                      {index > 0 ? <span className="h-[1.5px] w-2 rounded-full bg-osu-b3 sm:w-2.5" /> : null}
                      {src ? (
                        <img src={src} alt={level} className="h-[18px] w-[18px] object-contain sm:h-[26px] sm:w-[26px]" />
                      ) : (
                        <span className="text-[10px] text-osu-f1">{level}</span>
                      )}
                    </span>
                  );
                })}
              </span>
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </motion.div>
  );
}

/* One credit table per ladder family, tabbed: the three curves share a shape
   but not their numbers (the 6K/7K LN cutoff is 1 point, and 4K LN has anchor
   tables of its own), and a single table with prose exceptions undersold
   exactly the ladder people argue about. Values mirror dan-credit.ts. */
function CreditCurveTabs() {
  const { t } = useLingui();
  const [tab, setTab] = useState(0);
  /* The old wording promised the recalculated number was what the same hits
     show on stable. That only holds on rice: stable gives a hold one judgement
     covering the press and the release, lazer gives it two, so on charts with
     long notes the two clients are not scoring the same objects and no formula
     over the judgement counts can bridge that. Measured on replays judged both
     ways, the recalculated accuracy runs a few hundredths of a point above
     stable's below 35% LN and about 0.3 points above it beyond that. */
  const stableFormulaNote = t`Lazer scores are recalculated from their judgements, so the accuracy used here may be higher than the displayed value. For example, a 95.5% play could count as a 96% clear. On charts with a lot of long notes the recalculation is only close to what stable would show, because the two clients judge holds differently. The Classic mod makes no difference.`;
  const tabs: Array<{
    label: string;
    ladder: { key: string; bar: number; side: "rc" | "ln"; keyCount: number; example: number; jackCurve?: boolean };
    head: string[];
    note: string;
    rows: string[][];
  }> = [
    {
      label: t`Regular 4K/6K/7K`,
      ladder: { key: "4k-regular", bar: 0.96, side: "rc" as const, keyCount: 4, example: 3729620, jackCurve: true },
      /* The third column is the 4K jack tile's bonus (DAN_CREDIT_JACK_BONUS_SCALE):
         half of the shared one above the bar, the same below it. */
      head: [t`Stable-formula acc (96%)`, t`Credit`, t`4K jack`],
      rows: [
        ["100%", t`the chart's level +1.5`, t`the chart's level +0.75`],
        ["99.5%", t`the chart's level +1.1`, t`the chart's level +0.55`],
        ["99%", t`the chart's level +0.7`, t`the chart's level +0.35`],
        ["98.7%", t`the chart's level +0.2`, t`the chart's level +0.1`],
        ["98%", t`the chart's level +0.12`, t`the chart's level +0.06`],
        ["97.5%", t`the chart's level +0.06`, t`the chart's level +0.03`],
        ["96-97%", t`the chart's full level`, t`the chart's full level`],
        ["95.5%", t`the chart's level -0.25`, t`the chart's level -0.25`],
        ["95%", t`the chart's level -0.51`, t`the chart's level -0.51`],
        ["94%", t`the chart's level -0.76`, t`the chart's level -0.76`],
        ["92%", t`the chart's level -1.25`, t`the chart's level -1.25`],
        ["91%", t`the chart's level -1.5`, t`the chart's level -1.5`],
        [t`below 91%`, t`nothing`, t`nothing`],
      ],
      note: stableFormulaNote,
    },
    {
      label: t`4K LN`,
      ladder: { key: "4k-ln", bar: 0.97, side: "ln" as const, keyCount: 4, example: 3629313 },
      head: [t`ScoreV2 acc (97%)`, t`Credit`],
      note: t`Stable scores are recalculated with ScoreV2 from their judgements, so the accuracy used here may be lower than the displayed value.`,
      rows: [
        ["99.7-100%", t`the chart's level +0.7`],
        ["99.5%", t`the chart's level +0.5`],
        ["99%", t`the chart's level +0.3`],
        ["98.5%", t`the chart's level +0.15`],
        ["97-98%", t`the chart's full level`],
        ["96.5%", t`the chart's level -0.25`],
        ["96%", t`the chart's level -0.51`],
        ["95%", t`the chart's level -0.76`],
        ["94%", t`the chart's level -1`],
        ["93%", t`the chart's level -1.25`],
        ["92%", t`the chart's level -1.5`],
        ["91%", t`the chart's level -1.75`],
        [t`below 91%`, t`nothing`],
      ],
    },
    {
      label: t`6K/7K LN`,
      ladder: { key: "6k7k-ln", bar: 0.95, side: "ln" as const, keyCount: 7, example: 1920630 },
      head: [t`Stable-formula acc (95%)`, t`Credit`],
      note: stableFormulaNote,
      rows: [
        ["100%", t`the chart's level +1.5`],
        ["99.5%", t`the chart's level +1.18`],
        ["99%", t`the chart's level +0.86`],
        ["98%", t`the chart's level +0.16`],
        ["97%", t`the chart's level +0.07`],
        ["95-96.25%", t`the chart's full level`],
        ["94.9%", t`the chart's level -0.13`],
        ["94.5%", t`the chart's level -0.63`],
        ["94%", t`the chart's level -1.25`],
        ["93%", t`the chart's level -1.5`],
        ["92%", t`the chart's level -1.75`],
        [t`below 92%`, t`nothing`],
      ],
    },
  ];
  const active = tabs[tab];
  return (
    <div className="space-y-3">
      <div role="tablist" className="flex gap-1 border-b border-osu-b3/50">
        {tabs.map((entry, index) => (
          <button
            key={entry.label}
            type="button"
            role="tab"
            aria-selected={index === tab}
            onClick={() => setTab(index)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-[13px] font-bold transition-colors sm:text-sm ${
              index === tab ? "border-white text-white" : "border-transparent text-osu-f2 hover:text-osu-f1"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <CreditCurvePlot
        key={active.ladder.key}
        ladder={active.ladder.key}
        bar={active.ladder.bar}
        side={active.ladder.side}
        keyCount={active.ladder.keyCount}
        jackCurve={active.ladder.jackCurve}
        example={CHART_EXAMPLES.find((chart) => chart.id === active.ladder.example)}
      />
      <Details summary={t`The credit as a table`}>
        <Table head={active.head} rows={active.rows} />
        <p className="text-[12px] leading-5 text-osu-f1">{active.note}</p>
        <p className="text-[12px] leading-5 text-osu-f1">
          <Trans>These numbers are subject to change.</Trans>
        </p>
      </Details>
    </div>
  );
}

/* The credit curve, scrubbable. The table under it lists the anchor points the
   curve is built from, which reads as a set of thresholds: people kept asking
   whether an accuracy that falls between two rows credits nothing. Every point
   here is danCreditOffset itself rather than a redrawn approximation, so the
   ramp out of the flat zone is visibly continuous and the cliffs (the near-bar
   cap under the bar, no credit at all past the window) sit where they really
   are. */
const CURVE_HEIGHT = 190;
const CURVE_PAD = { top: 16, right: 16, bottom: 26, left: 46 };
const CURVE_SAMPLES = 180;
// A short strip left of the credit window, so "nothing at all" is a place on
// the plot rather than something implied by where the line stops.
const CURVE_DEAD_STRIP = 0.08;

function formatAccuracy(accuracy: number): string {
  return `${(accuracy * 100).toFixed(2)}%`;
}

/* Two decimals everywhere except the first tenth of a level, where they would
   print a real bonus as +0.00 - which is the exact misreading this plot is
   here to clear up. */
function formatCreditOffset(offset: number): string {
  const magnitude = Math.abs(offset);
  const body = magnitude < 0.1 ? magnitude.toFixed(3).replace(/0$/, "") : magnitude.toFixed(2);
  return `${offset < 0 ? "-" : "+"}${body}`;
}

function CreditCurvePlot({ ladder, bar, side, keyCount, jackCurve, example }: {
  ladder: string;
  bar: number;
  side: "rc" | "ln";
  keyCount: number;
  /** Also draw the 4K jack tile's damped bonus above the bar, dashed. */
  jackCurve?: boolean;
  example?: (typeof CHART_EXAMPLES)[number];
}) {
  const { t } = useLingui();
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [accuracy, setAccuracy] = useState(bar);
  const draggingRef = useRef(false);
  /* Once per visit, like the page's other events: the question is how many
     readers scrub the curve at all, not how far they drag it. The ladder rides
     along because the tab someone reaches for is the interesting half. */
  const scrubCounted = useRef(false);
  const scrub = (next: number) => {
    if (!scrubCounted.current) {
      scrubCounted.current = true;
      track("dan_estimates_curve", { ladder });
    }
    setAccuracy(next);
  };

  useEffect(() => setAccuracy(bar), [bar]);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const update = () => setWidth(el.getBoundingClientRect().width || 640);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The whole ladder-aware bundle, not just the window: 4K LN's curve has
  // anchor tables of its own, and a plot built from the shared ones would draw
  // a line nothing is credited against.
  const options = danCreditOptionsFor(side, keyCount);
  const offsetAt = (value: number) => danCreditOffset(value, bar, options);
  const lo = bar - options.belowBarWindow!;
  const xLo = lo - (1 - lo) * CURVE_DEAD_STRIP;
  const yHi = offsetAt(1) ?? 1.5;
  const yLo = offsetAt(lo) ?? -1.25;

  const plotW = Math.max(160, width - CURVE_PAD.left - CURVE_PAD.right);
  const plotH = CURVE_HEIGHT - CURVE_PAD.top - CURVE_PAD.bottom;
  const x = (value: number) => CURVE_PAD.left + ((value - xLo) / (1 - xLo)) * plotW;
  const y = (offset: number) => CURVE_PAD.top + ((yHi - offset) / (yHi - yLo || 1)) * plotH;

  // Split at the bar: LN's near-bar cap makes the credit jump there, and one
  // polyline would draw that cliff as a slope through values nothing scores.
  const sample = (from: number, to: number, at = offsetAt) => {
    const points: string[] = [];
    for (let i = 0; i <= CURVE_SAMPLES; i += 1) {
      const value = from + ((to - from) * i) / CURVE_SAMPLES;
      const offset = at(value);
      if (offset == null) continue;
      points.push(`${x(value).toFixed(2)},${y(offset).toFixed(2)}`);
    }
    return points.join(" ");
  };
  // The jack tile's bonus, drawn under the shared line so the gap between the
  // two is the halving itself; below the bar the two coincide and it is not
  // drawn twice.
  const jackOptions: DanCreditClearContext = { primaryTile: "jack" };
  const jackOffsetAt = (value: number) => danCreditOffset(value, bar, danCreditOptionsFor(side, keyCount, jackOptions));
  const jackAboveBarPoints = jackCurve ? sample(bar, 1, jackOffsetAt) : null;
  const jackTop = jackCurve ? jackOffsetAt(1) : null;
  const hasBarCliff = (options.nearBarCap ?? 0) > 0;
  const belowBarPoints = sample(lo, hasBarCliff ? bar - 1e-6 : bar);
  const aboveBarPoints = sample(bar, 1);
  // The near-bar cap makes the credit jump at the bar rather than meet it, so
  // the two halves end at different heights. Left as a bare gap it reads as a
  // drawing bug; the open/closed pair with a dashed riser between them is how
  // a step discontinuity is written, and says which side the bar belongs to.
  const barEdgeOffset = offsetAt(bar - 1e-6);

  const held = offsetAt(accuracy);
  /* The offset alone is an abstraction. Run it through one chart the page has
     already put a level on, and the badge is the answer in the units people
     actually argue in: the same accuracy that reads "+0.7" moves this chart's
     badge up a level in front of them. */
  const creditedDan = example == null ? null : creditedDanFor(example.rawDan, accuracy, bar, side, keyCount);
  const creditedLabel = creditedDan == null ? null : danLabelFor(creditedDan, side, keyCount);
  const creditLabel = held == null
    ? t`nothing`
    : held === 0
      ? t`the chart's full level`
      : t`the chart's level ${formatCreditOffset(held)}`;

  const accuracyFor = (clientX: number) => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return accuracy;
    const withinPlot = (clientX - rect.left - CURVE_PAD.left) / plotW;
    return xLo + Math.max(0, Math.min(1, withinPlot)) * (1 - xLo);
  };
  const nudge = (points: number) => {
    scrub(Math.max(xLo, Math.min(1, accuracy + points / 100)));
  };
  const onKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") nudge(event.shiftKey ? -0.01 : -0.1);
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") nudge(event.shiftKey ? 0.01 : 0.1);
    else if (event.key === "Home") scrub(xLo);
    else if (event.key === "End") scrub(1);
    else return;
    event.preventDefault();
  };

  return (
    <div ref={hostRef} className="space-y-2">
      {/* A grid rather than a wrapping flex row, and every cell placed: the
          readout's text changes length as the curve is scrubbed, and on a
          360px phone that flipped the row between one line and two, moving the
          plot 44px down mid-drag - under the finger holding it. Two fixed rows
          on a phone, one on a wider screen, and the credit label is a single
          truncating line so its own length can never add a third. */}
      <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 sm:grid-cols-[auto_1fr_auto] sm:gap-x-4">
        <span className="col-start-1 row-start-1 text-2xl font-bold tabular-nums text-white">{formatAccuracy(accuracy)}</span>
        <span className="col-start-1 row-start-2 min-w-0 truncate text-[15px] font-bold text-osu-f1 sm:col-start-2 sm:row-start-1 sm:text-lg">
          {creditLabel}
        </span>
        {example && (
          <span className="col-start-2 row-start-1 row-span-2 flex min-h-9 items-center justify-end sm:col-start-3 sm:row-span-1">
            {creditedLabel == null
              ? <span className="text-lg font-bold text-osu-f1">{t`nothing`}</span>
              : <DanLevelBadge label={creditedLabel} keyCount={keyCount} side={side} formatLabel={(value) => value} />}
          </span>
        )}
      </div>
      {example && (
        <p className="text-[12px] leading-5 text-osu-f1">
          <Trans>On {example.map}, rated {example.dan}</Trans>
        </p>
      )}
      <svg
        width={width}
        height={CURVE_HEIGHT}
        className="block w-full touch-none select-none outline-none"
        role="slider"
        tabIndex={0}
        aria-label={t`Accuracy`}
        aria-valuemin={Number((xLo * 100).toFixed(2))}
        aria-valuemax={100}
        aria-valuenow={Number((accuracy * 100).toFixed(2))}
        aria-valuetext={`${formatAccuracy(accuracy)}, ${creditLabel}`}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          draggingRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          scrub(accuracyFor(event.clientX));
        }}
        onPointerMove={(event) => {
          if (event.pointerType !== "mouse" && !draggingRef.current) return;
          scrub(accuracyFor(event.clientX));
        }}
        onPointerUp={() => { draggingRef.current = false; }}
        onPointerCancel={() => { draggingRef.current = false; }}
      >
        <line x1={CURVE_PAD.left} x2={CURVE_PAD.left + plotW} y1={y(0)} y2={y(0)} className="stroke-osu-b3" strokeDasharray="3 4" />
        <line x1={x(bar)} x2={x(bar)} y1={CURVE_PAD.top} y2={CURVE_PAD.top + plotH} className="stroke-osu-b3" strokeDasharray="3 4" />
        {[yHi, 0, yLo].map((offset) => (
          <text key={offset} x={CURVE_PAD.left - 8} y={y(offset) + 4} textAnchor="end" className="fill-osu-f1 text-[11px] tabular-nums">
            {offset === 0 ? "0" : formatCreditOffset(offset)}
          </text>
        ))}
        <text x={x(xLo)} y={CURVE_HEIGHT - 8} textAnchor="start" className="fill-osu-f1 text-[11px]">{t`nothing`}</text>
        <text x={x(bar)} y={CURVE_HEIGHT - 8} textAnchor="middle" className="fill-osu-f1 text-[11px] tabular-nums">{`${(bar * 100).toFixed(0)}%`}</text>
        <text x={x(1)} y={CURVE_HEIGHT - 8} textAnchor="end" className="fill-osu-f1 text-[11px] tabular-nums">100%</text>
        <polyline points={belowBarPoints} fill="none" strokeWidth={2} strokeLinecap="round" className="stroke-osu-blue" />
        <polyline points={aboveBarPoints} fill="none" strokeWidth={2} strokeLinecap="round" className="stroke-osu-blue" />
        {jackAboveBarPoints && jackTop != null && (
          <>
            <polyline points={jackAboveBarPoints} fill="none" strokeWidth={2} strokeLinecap="round" strokeDasharray="4 4" className="stroke-osu-blue/50" />
            <text x={x(1)} y={y(jackTop) + 24} textAnchor="end" className="fill-osu-f2 text-[11px]">{t`4K jack`}</text>
          </>
        )}
        {hasBarCliff && barEdgeOffset != null && (
          <>
            <line
              x1={x(bar)}
              x2={x(bar)}
              y1={y(barEdgeOffset)}
              y2={y(0)}
              strokeWidth={2}
              strokeDasharray="2 4"
              className="stroke-osu-blue/45"
            />
            <circle cx={x(bar)} cy={y(barEdgeOffset)} r={4} strokeWidth={2} className="fill-osu-b6 stroke-osu-blue" />
            <circle cx={x(bar)} cy={y(0)} r={3.5} className="fill-osu-blue" />
          </>
        )}
        <line x1={x(accuracy)} x2={x(accuracy)} y1={CURVE_PAD.top} y2={CURVE_PAD.top + plotH} className="stroke-osu-f1/60" />
        {held != null && (
          <circle cx={x(accuracy)} cy={y(held)} r={5} strokeWidth={2} className="fill-osu-blue stroke-osu-b6" />
        )}
      </svg>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] border-collapse text-left text-[13px] sm:text-sm">
        <thead>
          <tr className="border-b border-osu-b3/50">
            {head.map((cell) => (
              <th key={cell} className="py-2 pr-4 font-bold text-white last:pr-0">{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-osu-b3/25">
              {row.map((cell, index) => (
                <td key={index} className="py-2 pr-4 align-top leading-6 text-osu-f1 last:pr-0">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
