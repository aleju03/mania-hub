import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { getI18n } from "../lib/i18n";
import { getDanImageSrc } from "../lib/dan-images";
import { formatNumber } from "../lib/format";
import { ModBadge } from "../components/ui/ModBadge";
import { pageSeo } from "../lib/seo";
import { track } from "../lib/analytics";

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
  { key: "6k-regular", keyCount: 6, levels: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] },
  {
    key: "6k-ln",
    keyCount: 6,
    family: "ln",
    levels: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "terra", "celestial", "mystery", "nihility", "finish"],
  },
];

type LadderKey = "4k-regular" | "4k-ln" | "7k-regular" | "7k-ln" | "6k-regular" | "6k-ln";

const CHART_EXAMPLES: Array<{ id: number; map: string; ladder: LadderKey; dan: string }> = [
  { id: 2034201, map: "antiPLUR - Runengon [4K Hard]", ladder: "4k-regular", dan: "4" },
  { id: 2847100, map: "Risshuu feat. Choko - Take [4K Beyond]", ladder: "4k-regular", dan: "7" },
  { id: 2333831, map: "Diceros Bicornis - ReviveR [4K VIVID]", ladder: "4k-regular", dan: "10" },
  { id: 770127, map: "Camellia as \"Bang Riot\" - Blastix Riotz [4K GRAVITY]", ladder: "4k-regular", dan: "gamma" },
  { id: 3616430, map: "Cres. - End Time [4K Every END is a new BEGINNING]", ladder: "4k-ln", dan: "9-" },
  { id: 4001513, map: "Laur - SYSTEM ERROR [7K Obsession: Nyctophilia]", ladder: "7k-regular", dan: "gamma" },
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

function DanEstimatesPage() {
  const { t } = useLingui();

  /* This page is worth counting on its own, so it says who it is instead of
     leaving the admin to pick /dan-estimates out of every pageview: the
     analytics tab's event lookup answers "who read the dan explainer" by name.
     Two events, because opening the page and reading it are different things -
     the second only fires once the end of the article has actually been on
     screen, and only once per visit. */
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    track("dan_estimates_view");
  }, []);
  useEffect(() => {
    const end = endRef.current;
    if (!end || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      track("dan_estimates_read");
    });
    observer.observe(end);
    return () => observer.disconnect();
  }, []);

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

  const accuracyBars: Array<{ ladder: string; bar: string; source: string }> = [
    { ladder: ladderName["4k-regular"], bar: "96%", source: t`DDMythical's Reform dan courses, stable accuracy` },
    { ladder: ladderName["4k-ln"], bar: "97%", source: t`_Underjoy LN dan courses, ScoreV2 accuracy` },
    { ladder: ladderName["7k-regular"], bar: t`96%, or 95% in the Normal Kyu band below 1st dan`, source: t`JinJin dan courses` },
    { ladder: ladderName["7k-ln"], bar: "95%", source: t`JinJin LN dan courses` },
    { ladder: t`6K regular and LN`, bar: t`the same 96% and 95%`, source: t`JinJin's numbers, reused for 6K` },
  ];

  return (
    <div className="flex-1 bg-osu-b5">
      <article className="mx-auto flex w-full max-w-3xl flex-col gap-9 px-5 py-8 sm:px-6 sm:py-10">
        <header className="space-y-4">
          <h1 className="text-2xl font-black text-white sm:text-3xl">
            <Trans>How dan levels are estimated</Trans>
          </h1>
          <p className="text-[15px] leading-7 text-osu-f1">
            <Trans>
              These estimates are not real dan clears. Nobody here has been checked against a dan
              course. Instead, every chart gets a dan level of its own, and your level is read from the
              charts you have already passed. That is why every estimated dan is written with a "~" in
              front of it and why the leaderboard calls itself a rough ordering.
            </Trans>
          </p>
        </header>

        {/* The first thing on the page, because it is the answer to the question
            that brings most people here: why the estimate is lower than they
            expect. Both halves are the same rule seen twice - the estimator can only
            read plays it recorded, and it only records plays from the day
            tracking started, in sessions it noticed. */}
        <div className="space-y-2 border-l-2 border-osu-pink-light pl-4 text-[15px] font-bold leading-7 text-white">
          <p>
            <Trans>
              Tracking only began on June 9, 2026. Anything you played before that date counts only if
              it is still in your osu! top plays, and everything else from back then is invisible to the
              estimate.
            </Trans>
          </p>
          <p>
            <Trans>
              The same goes for any session where you never set a score on a ranked, qualified or loved
              chart: tracking never notices you are playing, so nothing from that session is recorded
              either.{' '}
              <a
                href="#what-the-number-is-not"
                className="text-osu-pink-light underline underline-offset-2 transition-colors hover:text-white"
              >
                Why that is
              </a>
              . If your estimate reads low, that is usually the reason, and the only fix is to play more.
            </Trans>
          </p>
        </div>

        <Section title={t`A quick reminder of what a dan is`}>
          <P>
            <Trans>
              A dan course is a fixed set of charts, played back to back in one sitting, with an
              accuracy bar you have to finish above. Clearing the course awards you that level. Each
              keymode has its own community ladder, run by different people: 4K regular uses
              DDMythical's Reform courses, 4K LN uses the _Underjoy courses, 7K uses the JinJin courses,
              and 6K has two of its own, Arkman's ladder on the regular side and sunnyxxy's on the LN
              side.
            </Trans>
          </P>
          <P>
            <Trans>
              Course charts are unranked, and a clear is checked by the people who run that ladder. None
              of that comes back through the osu! API as a dan level, so yours cannot be looked up. It
              can only be inferred from your plays.
            </Trans>
          </P>
        </Section>

        <Section title={t`Step 1: every chart gets its own dan level`}>
          <P>
            <Trans>
              The estimator downloads the chart file, reads the notes, and runs the pattern through a
              rating engine. Which engine depends on the keymode, because no single one is best at all
              of them:
            </Trans>
          </P>
          <ul className="space-y-2 pl-5 text-[15px] leading-7 text-osu-f1">
            <Li>
              <Trans>
                <B>4K regular</B> goes through the Mixed estimator from{' '}
                <ExternalLink href="https://github.com/LeoBlackMT/osumania_map_analyser">Leo_Black's map analyser</ExternalLink>,
                which blends four difficulty models:{' '}
                <ExternalLink href="https://github.com/LeoBlackMT/osumania_map_analyser/blob/HEAD/docs/roxy_algorithm.md">Roxy</ExternalLink>,{' '}
                <ExternalLink href="https://github.com/LeoBlackMT/osumania_map_analyser/blob/HEAD/docs/azusa_algorithm.md">Azusa</ExternalLink>,{' '}
                <ExternalLink href="https://thebagelofman.github.io/Daniel/">Daniel</ExternalLink> and{' '}
                <ExternalLink href="https://github.com/sunnyxxy/Star-Rating-Rebirth">Sunny</ExternalLink>.
              </Trans>
            </Li>
            <Li>
              <Trans>
                <B>4K LN</B> goes through that same analyser's LN table, with a small supplementary model
                filling in the easy charts that sit below where the table starts.
              </Trans>
            </Li>
            <Li>
              <Trans>
                <B>6K and 7K</B> get a Sunny star rating, mapped through the published 6K and 7K dan
                tables.
              </Trans>
            </Li>
            <Li>
              <Trans>
                <B>Every other keymode</B> gets no dan at all. There is no ladder to map it onto.
              </Trans>
            </Li>
          </ul>
          <P>
            <Trans>
              The engine gives back a continuous number, and the number is what everything else uses.
              The label you see is just that number printed in the ladder's own language. 4K regular
              runs 1st to 10th and then into the greek levels (alpha, beta, gamma and up). 4K LN runs 1
              to 17, numbered up to 10 and named above it: Yoake, Yuugure, Yoru, Yami, Yume, Yokaze,
              Yeehee. 7K runs 0 to 10th and then Gamma, Azimuth, Zenith, Stellium. 6K stops at 9th, and
              its LN ladder carries on through Terra, Celestial, Mystery, Nihility and Finish.
            </Trans>
          </P>
          <div className="space-y-3 py-1">
            {LADDERS.map((ladder) => (
              <div key={ladder.key} className="space-y-1.5">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-osu-f1">{ladderName[ladder.key]}</p>
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
              One dan level is wide, so each is split into five steps. A chart can be 7--, 7-, 7, 7+ or
              7++, from the easiest end of 7th dan to the hardest. Those suffixes are ordering inside a
              level, nothing more.
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
          <P>
            <Trans>
              At the time of writing there were around 138,000 charts with a dan estimate: about 97,000
              4K regular, 22,000 7K regular, 8,500 4K LN, 7,500 7K LN and 3,000 6K regular.
            </Trans>
          </P>
        </Section>

        <Section title={t`Step 2: what makes a chart LN`}>
          <P>
            <Trans>
              A chart counts as an LN chart when hold notes are 45% or more of it, and as a regular
              chart below that. This is the same line the maps pages use to label a chart, so a chart
              cannot feed your LN rating and wear a regular badge at the same time.
            </Trans>
          </P>
          <P>
            <Trans>
              The split matters because the two say nothing about each other. Accuracy on an LN chart is
              earned almost entirely on the holds and the releases, so passing it is not evidence about
              your regular level, and the other way around. You get one dan per side, per keymode, and a
              play only ever testifies for the side its chart belongs to.
            </Trans>
          </P>
        </Section>

        <Section title={t`Step 3: which of your plays count`}>
          <P>
            <Trans>
              The pool is your osu! top plays plus everything recorded while you were tracked,
              deduplicated down to your best play on each chart at each speed. That tracked half only
              exists if you are on your country's roster, which is its top 100 plus anyone who turned
              tracking on themselves, and it starts the day tracking does. Charts flagged as vibro are
              thrown out everywhere, because the rating engines read a mash wall as enormous density
              and rate it absurdly.
            </Trans>
          </P>
          <P>
            <Trans>
              Out of that pool, a play earns credit by where its accuracy sits against the bar the real
              course asks for. Each ladder sets its own bar:
            </Trans>
          </P>
          <Table
            head={[t`Ladder`, t`Pass bar`, t`Where it comes from`]}
            rows={accuracyBars.map((row) => [row.ladder, row.bar, row.source])}
          />
          <P>
            <Trans>
              The accuracy shown by the game is not used. It is worked out again from your judgements,
              the 300s, 200s, 100s and so on. Mania has two ways of adding those up, the stable formula
              and the ScoreV2 one that lazer shows, and each ladder writes its bar in one of them: 4K
              regular in stable, 4K LN in ScoreV2. Since the two print different numbers for the same
              play, recomputing is what makes that play count, or not count, the same on either client.
            </Trans>
          </P>
          <P>
            <Trans>
              A pass right at the bar credits the chart's full level, exactly as passing the course
              would. Accuracy above the bar credits more, and a near miss under it still credits
              something: a play counts as a clear of a lower level, bottoming out one full level down
              at the cutoff. The regular ladders keep crediting to 4 points under the bar. The LN
              ladders stop at 1 point, because accuracy is cheap to hold on long notes, and 4K LN's
              bonus is flattened for the same reason:
            </Trans>
          </P>
          <CreditCurveTabs />
          <P>
            <Trans>
              A sub-bar credit is always at least a step under the chart's own level, so a near miss
              never reads as the full clear. On 4K LN that step is at least three quarters of a
              level.
            </Trans>
          </P>
          <P>
            <Trans>
              Rate mods count, and they count for what the chart is worth at that speed. A pass at 1.0x,
              at <ModPill mod="DT" /> or <ModPill mod="NC" /> (1.5x), at <ModPill mod="HT" /> or{' '}
              <ModPill mod="DC" /> (0.75x), or at any custom lazer rate from 0.5x to 2.0x is credited
              against the chart's dan at that exact rate, with each speed rated separately. Runengon
              [4K Hard] is a 4th dan chart at 1.0x and around 9th dan under <ModPill mod="DT" />, so a{' '}
              <ModPill mod="DT" /> pass on it is credited as 9th, not as 4th. ANiMA
              [Starry's 4K Lv.15] moves from 3rd to about 7th the same way. Slowing a chart down works
              in reverse: a 0.75x pass is worth what the chart is at 0.75x, which is well under its
              normal level. A speed nobody has rated that chart at yet is worked out the first time
              your estimate needs it, so a play at an unusual rate can take a little while to start
              counting.
            </Trans>
          </P>
        </Section>

        <Section title={t`Step 4: your passes are sorted into four skills`}>
          <P>
            <Trans>
              Every qualifying pass lands in one of four skills, and those four are what the estimate is
              built out of. On 4K they are jack, tech, speed and stamina, taken from the play's own MSD
              skillset ratings and normally filed under whichever skillset is strongest on that chart: jack
              (JackSpeed and Chordjack), tech (Technical and Jumpstream), speed (Stream) and stamina
              (Handstream and Stamina).
            </Trans>
          </P>
          <P>
            <Trans>
              Speedjack is the exception. MinaCalc often reads it as Jumpstream even though speedjack is
              jack, so a confident speedjack or chordjack tag from the chart analysis moves that pass to
              jack. It replaces the MSD choice instead of counting in two skills.
            </Trans>
          </P>
          <P>
            <Trans>
              Jumpstream sits with tech on purpose. MinaCalc's Jumpstream fires hard on dense jumptrill,
              which feels a lot more like tech than like speed, so pairing it with Stream put charts like
              Blastix Riotz [GRAVITY] on a tile labelled speed. Checked against a 25 chart pack of real
              gamma speed charts, Stream alone picks all 25 and rejects the jumptrill charts by a wide
              margin.
            </Trans>
          </P>
          <P>
            <Trans>
              6K and 7K cannot use those skillsets, because that engine does not rate Technical at all
              and everything collapses onto Handstream. They use pattern tags from the chart analysis
              instead, so a chart tagged both chordjack and tech backs both skills. On the LN side only
              7K gets a split, into general, tech, inverse and release, because those are the only LN
              subtypes the analyzer separates in any volume. The other LN ladders are read as one skill.
            </Trans>
          </P>
        </Section>

        <Section title={t`Step 5: each skill's dan is the average of your 5 best passes in it`}>
          <P>
            <Trans>
              Take your credited passes in one skill, sort them by the level each one credited, and
              average the top 5. That is your dan in that skill. Nothing is added on top of the
              evidence, and no single pass can set it on its own.
            </Trans>
          </P>
          <div className="space-y-2 border-l-2 border-osu-b3 pl-4 text-[15px] leading-7 text-osu-f1">
            <p>
              <Trans>Say the levels your 4K jack passes credit come out as:</Trans>
            </p>
            <p className="font-bold tabular-nums text-white">
              <span className="text-osu-pink-light">gamma, beta+, beta, alpha++, alpha,</span> 10+, 10, 9++ ...
            </p>
            <p>
              <Trans>
                Your jack dan is the average of the five highlighted passes. The gamma pass does not make
                you gamma on its own: averaged against the four below it, it can pull your dan up a
                fraction of a level, but it cannot set it.
              </Trans>
            </p>
          </div>
          <P>
            <Trans>
              Five is roughly the length of a real course. With exactly four qualifying passes the
              average is over those four; a skill you have fewer than four in gets no dan of its own,
              and a side you have fewer than four on gets no estimate at all rather than a shaky one.
            </Trans>
          </P>
        </Section>

        <Section title={t`Step 6: your dan is the average of your skills`}>
          <P>
            <Trans>
              Your estimate for a side is the plain arithmetic average of the skill dans you have. Skills
              at 10, 9, 7 and 6 make an estimate of 8. If it lands at the very top of a ladder, the badge
              switches from "~" to "&gt;" and reads as <B>beyond</B> that level instead of pinning you to
              it, because the ladder has run out of levels to measure you with.
            </Trans>
          </P>
          <P>
            <Trans>
              It used to be the 4th best pass across all your skills at once, and in practice that was
              just whatever you specialise in. Measured across 12,974 4K regular estimates,
              the old number sat a median of 0.14 levels above the player's single strongest skill, and
              84% of players were within half a level of theirs. It was measuring your best pattern and
              calling that your dan. A real course does not work that way: it makes you clear a mix in
              one sitting. Averaging asks the same question.
            </Trans>
          </P>
          <P>
            <Trans>
              Skills you do not have four passes in are left out of the average rather than counted as
              zero, because a missing skill is nearly always a short play history rather than a hole in
              your playing. Below 25 analysed plays only 18% of 4K players have two skills rated; past
              200 plays every single one does. Players with fewer than two rated skills - 7.6% of the 4K
              regular estimates, at a median of 23 analysed plays - are read off the same average over
              their 5 best passes overall.
            </Trans>
          </P>
          <P>
            <Trans>
              How much this moves you depends on how uneven your skills are, which is the point. The typical
              4K player drops about a level, and the gap between a player's best and worst skill runs a
              median of 1.7 levels and reaches 4.3 at the 90th percentile - that gap is what used to be
              invisible.
            </Trans>
          </P>
        </Section>

        <Section title={t`Extra: clearing a real course overrides all of it`}>
          <P>
            <Trans>
              If your recorded plays show that you passed a dan course, your estimate for that side{' '}
              <B>cannot read below that course</B>, whatever your skills average to. Clear EXTRA-EPSILON
              and you read as epsilon even if your skills average out to delta. The rest of this page
              works a number out from your plays. A course hands you one directly, so it wins.
            </Trans>
          </P>
          <P>
            <Trans>
              It only ever raises the number. Clearing epsilon means you can do epsilon; whether zeta is
              beyond you is still an open question, so if your skills already average higher, the
              average stands. The skill rows underneath are untouched either way, which is why they can
              read lower than the number above them. A course throws a mix at you, so it cannot tell you
              which of your skills got you through it.
            </Trans>
          </P>
          <P>
            <Trans>
              Your accuracy sets the tier. On a ladder whose courses ask for 96%, a bare 96% pass on the
              delta course reads as <B>delta</B>, 97.5% as <B>delta+</B>, and 98% and up as{' '}
              <B>delta++</B>. Come up short and you still get something for it: 95% reads as{' '}
              <B>delta-</B> and 94% as <B>delta--</B>. Below 94% you get nothing. Ladders that ask for a
              different accuracy shift the whole scale with them.
            </Trans>
          </P>
          <P>
            <Trans>
              These are the packs checked, matched by beatmap. A pass has to be on one of these exact
              difficulties. Clearing the same courses from a different upload is still a clear, but that
              upload is not currently checked. More packs can be added.
            </Trans>
          </P>
          <CourseList />
          <P>
            <Trans>
              A few difficulties inside those packs are left out, because they sit below the first level
              their ladder measures: REFORM's three INTRO courses, and the 0th to 2nd of Jinjin's LN
              Phase I. None of this changes how a chart is rated either. The estimator never looks at
              what a map is called or who made it; the list above exists at your end of the calculation,
              not the chart's, and all it does is credit you with a course you actually passed.
            </Trans>
          </P>
          <P>
            <Trans>
              A run only counts if it was really the course. Easy, No Fail and Random disqualify it, and
              so does anything that slows the chart down: Half Time, Daycore, or a custom rate under
              1.0x. Mirror, Hidden, Fade In, Flashlight, Hard Rock, Sudden Death, Perfect and Double
              Time are all fine, because none of them make the course easier. A pass recorded before mod
              data was stored cannot be checked, so it counts for nothing rather than being taken on
              trust.{' '}
              <strong className="text-[17px] font-bold text-white">
                Clicking your dan badge shows the course that set your estimate, when one did.
              </strong>
            </Trans>
          </P>
        </Section>

        <Section id="what-the-number-is-not" title={t`What the number is not`}>
          <P>
            <Trans>
              No ladder recognizes this number, and titles still only come from clearing a real course.
              It also works badly as a ranking. Two players one step apart on the dan leaderboard are
              not really one step apart, and a player who never farms accuracy will land below their
              actual level. The number can also change on its own, because the rating engines and the
              chart analysis get updated, and when a recompute moves a chart up or down a level,
              everyone whose passes rely on that chart moves with it.
            </Trans>
          </P>
          <P>
            <Trans>
              The estimate only sees the recorded pool. Your osu! top plays are always included. Anything
              below them is included only while you are tracked, which happens if you are in
              your country's top 100 or if you turn tracking on yourself, and only from that day onward.
              A player who quit years ago is judged on their top 200 alone, so their estimate comes out
              low.
            </Trans>
          </P>
          <P>
            <Trans>
              Unranked plays are only recorded after tracking picks up your session from your first
              score on a ranked, qualified or loved chart. It then checks your recent plays every few
              minutes until you stop, and everything you play during that time counts, including
              unranked charts.{' '}
              <strong className="text-[17px] font-bold text-white">
                If you only play unranked charts, nothing is recorded until you set a score on a chart
                with a leaderboard.
              </strong>
            </Trans>
          </P>
        </Section>

        <Section title={t`What it looks like across everyone`}>
          <P>
            <Trans>
              At the time of writing there were skill ratings for 14,385 players on 4K, 4,119 on 7K and
              2,879 on 6K. Of the 4K players, 12,974 had enough qualifying passes for a regular dan and
              5,038 for an LN dan. This is where the 4K regular estimates landed:
            </Trans>
          </P>
          <DanDistribution rows={RICE_4K_POPULATION} />
          <DanShareRing rows={RICE_4K_POPULATION} />
        </Section>

        <Section title={t`Where to see it`}>
          <P>
            <Trans>
              Your own estimate is on the Skills tab of your player page. Click any dan badge there to
              see the passes behind it, broken down by skill. The whole population is on the{' '}
              <Link
                to="/rankings"
                search={{ tab: "dan" as const, country: undefined }}
                className="text-osu-pink-light underline underline-offset-2 transition-colors hover:text-white"
              >
                Dan tab of the rankings page
              </Link>
              , per country and per keymode.
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

// A section only takes an id when something on the page links down to it, and
// the scroll margin is there so the heading does not land under the sticky nav.
function Section({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className={`space-y-3${id ? " scroll-mt-20" : ""}`}>
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
   but not their numbers (the LN cutoff is 1 point, and 4K LN's bonus is
   damped), and a single table with prose exceptions undersold exactly the
   ladder people argue about. Values mirror dan-credit.ts. */
function CreditCurveTabs() {
  const { t } = useLingui();
  const [tab, setTab] = useState(0);
  const tabs = [
    {
      label: t`Regular ladders`,
      head: [t`Accuracy (96% ladder)`, t`Credit`],
      rows: [
        ["100%", t`the chart's level +1.5`],
        ["99.5%", t`the chart's level +1.1`],
        ["99%", t`the chart's level +0.7`],
        ["98%", t`the chart's level +0.35`],
        [t`96% (the bar)`, t`the chart's full level`],
        ["95%", t`the chart's level -0.45`],
        ["94%", t`the chart's level -0.63`],
        ["92%", t`the chart's level -1`],
        [t`below 92%`, t`nothing`],
      ],
    },
    {
      label: t`4K LN`,
      head: [t`Accuracy (97% ScoreV2 ladder)`, t`Credit`],
      rows: [
        ["100%", t`the chart's level +0.7`],
        ["99.5%", t`the chart's level +0.53`],
        ["99%", t`the chart's level +0.35`],
        ["98%", t`the chart's level +0.18`],
        [t`97% (the bar)`, t`the chart's full level`],
        ["96.9%", t`the chart's level -0.75`],
        ["96.4%", t`the chart's level -0.75`],
        ["96.2%", t`the chart's level -0.85`],
        ["96%", t`the chart's level -1`],
        [t`below 96%`, t`nothing`],
      ],
    },
    {
      label: t`6K/7K LN`,
      head: [t`Accuracy (95% ladder)`, t`Credit`],
      rows: [
        ["100%", t`the chart's level +1.5`],
        ["99.5%", t`the chart's level +1.18`],
        ["99%", t`the chart's level +0.86`],
        ["98%", t`the chart's level +0.49`],
        ["97%", t`the chart's level +0.28`],
        ["96%", t`the chart's level +0.14`],
        [t`95% (the bar)`, t`the chart's full level`],
        ["94.9%", t`the chart's level -0.33`],
        ["94.5%", t`the chart's level -0.63`],
        ["94%", t`the chart's level -1`],
        [t`below 94%`, t`nothing`],
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
      <Table head={active.head} rows={active.rows} />
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
