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
   site's own corpus in August 2026, which is why the counts are given as
   approximations and dated in the text. Chart names, ladder names and dan
   labels are identifiers and stay untranslated. */

export const Route = createFileRoute("/dan-estimates")({
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: i18n._(msg`How dan levels are estimated`),
      description: i18n._(
        msg`How Mania Tracker gives every osu!mania chart a dan level, and how it reads a player's dan off the charts they have passed.`,
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

// Every ladder the site can badge, in the order its own community reads it.
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
// One bar per level of the ladder, counted by the label the site itself prints
// (the tier suffix stripped), not by rounding the raw number: parseDan's bands
// are not integers, so rounding invented a theta nobody holds. Measured against
// the production DB in August 2026, read-only, in one pass so every number on
// the page agrees with the others.
// Level names are the ladder's own, so they are identifiers and stay untranslated.
const RICE_4K_POPULATION: Array<{ level: string; players: number }> = [
  { level: "1", players: 404 },
  { level: "2", players: 819 },
  { level: "3", players: 632 },
  { level: "4", players: 800 },
  { level: "5", players: 934 },
  { level: "6", players: 1013 },
  { level: "7", players: 912 },
  { level: "8", players: 305 },
  { level: "9", players: 821 },
  { level: "10", players: 1258 },
  { level: "alpha", players: 860 },
  { level: "beta", players: 1097 },
  { level: "gamma", players: 1388 },
  { level: "delta", players: 1067 },
  { level: "epsilon", players: 378 },
  { level: "zeta", players: 103 },
  { level: "eta", players: 9 },
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
              Nothing on this site is a real dan clear. Nobody here has been checked against a dan
              course. What the site does instead is give every chart a dan level of its own, look at the
              charts you have already passed, and read a level off them. That is why every dan on the
              site is written with a "~" in front of it and why the leaderboard calls itself a rough
              ordering.
            </Trans>
          </p>
        </header>

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
              of that comes back through the osu! API as a dan level, so the site cannot look yours up.
              It can only look at your plays.
            </Trans>
          </P>
        </Section>

        <Section title={t`Step 1: every chart gets its own dan level`}>
          <P>
            <Trans>
              The site downloads the chart file, reads the notes, and runs the pattern through a rating
              engine. Which engine depends on the keymode, because no single one is best at all of them:
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
                <B>4K LN</B> goes through that same analyser's LN table, with a small model of our own
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
              The pool is your osu! top plays plus every play the site tracked for you, deduplicated
              down to your best play on each chart at each speed. That tracked half only exists if you
              are on your country's roster, which is its top 100 plus anyone who turned tracking on
              themselves, and it starts the day tracking does. Charts flagged as vibro are thrown out
              everywhere, because the rating engines read a mash wall as enormous density and rate it
              absurdly.
            </Trans>
          </P>
          <P>
            <Trans>
              Out of that pool, a play counts as a clear if it passed at or above the accuracy the real
              course asks for. Each ladder sets its own bar, so the site uses each ladder's:
            </Trans>
          </P>
          <Table
            head={[t`Ladder`, t`Pass bar`, t`Where it comes from`]}
            rows={accuracyBars.map((row) => [row.ladder, row.bar, row.source])}
          />
          <P>
            <Trans>
              The site does not use the accuracy the game showed you. It works it out again from your
              judgements, the 300s, 200s, 100s and so on. Mania has two ways of adding those up, the
              stable formula and the ScoreV2 one that lazer shows, and each ladder writes its bar in one
              of them: 4K regular in stable, 4K LN in ScoreV2. Since the two print different numbers for
              the same play, recomputing is what makes that play count, or not count, the same on either
              client.
            </Trans>
          </P>
          <P>
            <Trans>
              Rate mods count, and they count for what the chart is worth at that speed. A pass at 1.0x,
              at <ModPill mod="DT" /> or <ModPill mod="NC" /> (1.5x) and at <ModPill mod="HT" /> or{' '}
              <ModPill mod="DC" /> (0.75x) are all credited against the chart's dan at that exact rate,
              which the site rates separately. Runengon [4K Hard] is a 4th dan chart at
              1.0x and around 9th dan under <ModPill mod="DT" />, so a <ModPill mod="DT" /> pass on it
              is credited as 9th, not as 4th. ANiMA
              [Starry's 4K Lv.15] moves from 3rd to about 7th the same way. Slowing a chart down works
              in reverse: a 0.75x pass is worth what the chart is at 0.75x, which is well under its
              normal level. Custom lazer rates like 1.15x do not count toward your dan. The site can
              rate a chart at any speed on demand, and the map page does exactly that when you open a
              play set at one, but only 0.75x, 1.0x and 1.5x are stored, and the dan only reads stored
              ones.
            </Trans>
          </P>
        </Section>

        <Section title={t`Step 4: your dan is your 4th best pass`}>
          <P>
            <Trans>
              Take every qualifying pass on one side of one keymode, sort them by the chart's dan level,
              and look at the 4th one down. That is your dan. Nothing is added on top of it, and no
              single pass above it can raise it.
            </Trans>
          </P>
          <div className="space-y-2 border-l-2 border-osu-b3 pl-4 text-[15px] leading-7 text-osu-f1">
            <p>
              <Trans>Say your 4K regular passes at 96% or better land on charts rated:</Trans>
            </p>
            <p className="font-bold tabular-nums text-white">
              gamma, beta+, beta, <span className="text-osu-pink-light">alpha++</span>, alpha, 10+, 10, 9++ ...
            </p>
            <p>
              <Trans>
                Your estimate is alpha++, the 4th one. The gamma pass does not make you gamma: one chart
                can be a lucky run, a chart that happens to suit you, or the one attempt out of fifty
                that stayed above the accuracy bar. Asking for four of them is what keeps a single good
                day from setting your level.
              </Trans>
            </p>
          </div>
          <P>
            <Trans>
              Four is standing in for the length of a real course. If you have fewer than four
              qualifying passes on a side, you get no estimate for it at all rather than a shaky one.
              And if your 4th best pass sits at the very top of a ladder, the badge switches from "~" to
              "&gt;" and reads as <B>beyond</B> that level instead of pinning you to it, because the
              ladder has run out of levels to measure you with.
            </Trans>
          </P>
        </Section>

        <Section title={t`The skill breakdown`}>
          <P>
            <Trans>
              Opening a dan badge on a player's Skills tab shows the same estimate run again over slices
              of the same passes. Your jack dan is the level your jack passes demonstrate, under exactly
              the same rules and the same count of four.
            </Trans>
          </P>
          <P>
            <Trans>
              On 4K the slices come from the play's own MSD skillset ratings, bucketed by whichever
              skillset is strongest on that chart: jack (JackSpeed and Chordjack), tech (Technical and
              Jumpstream), speed (Stream) and stamina (Handstream and Stamina). Jumpstream sits with
              tech on purpose. MinaCalc's Jumpstream fires hard on dense jumptrill, which feels a lot
              more like tech than like speed, so pairing it with Stream put charts like Blastix Riotz
              [GRAVITY] on a tile labelled speed. Checked against a 25 chart pack of real gamma speed
              charts, Stream alone picks all 25 and rejects the jumptrill charts by a wide margin.
            </Trans>
          </P>
          <P>
            <Trans>
              6K and 7K cannot use those skillsets, because that engine does not rate Technical at all
              and everything collapses onto Handstream. They use the site's own chart pattern tags
              instead, so a chart tagged both chordjack and tech backs both dans. On the LN side only 7K
              gets a breakdown, into general, tech, inverse and release, because those are the only LN
              subtypes the analyzer separates in any volume.
            </Trans>
          </P>
        </Section>

        <Section title={t`What the number is not`}>
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
              It also only sees the plays the site has. Your osu! top plays are always included.
              Anything below them is included only if the site tracks you, which happens if you are in
              your country's top 100 or if you turn tracking on yourself, and only from that day onward.
              A player who quit years ago is judged on their top 200 alone, so their estimate comes out
              low.
            </Trans>
          </P>
          <P>
            <Trans>
              Unranked plays are only recorded once the site knows you are playing, which it learns from
              your first score on a ranked, qualified or loved chart. After that it checks your recent
              plays every few minutes until you stop, and everything you play during that time counts,
              including unranked charts.{' '}
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
              At the time of writing the site had skill ratings for 14,229 players on 4K, 4,035 on 7K
              and 2,824 on 6K. Of the 4K players, 12,800 had enough qualifying passes for a regular dan
              and 5,504 for an LN dan. This is where the 4K regular estimates landed:
            </Trans>
          </P>
          <DanDistribution rows={RICE_4K_POPULATION} />
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-white sm:text-xl">{title}</h2>
      {children}
    </section>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className="text-[15px] leading-7 text-osu-f1">{children}</p>;
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
              className={`flex w-full flex-col items-center gap-1 ${column.group ? "cursor-pointer" : "cursor-default"}`}
              title={`${column.key}: ${formatNumber(column.players)}${column.group ? ` · ${hint}` : ""}`}
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
