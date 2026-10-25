import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";

import { getI18n } from "../lib/i18n";
import { useLocale } from "../lib/locale-context";
import { useHasHydrated } from "../store";
import { track } from "../lib/analytics";
import { PageHeader } from "../components/layout/PageHeader";
import { MapDetailModal } from "../components/maps/MapDetailModal";
import { loadLiveMapSearchEntry, type LiveMapSearchEntry } from "../lib/live-backend";
import { pageSeo } from "../lib/seo";
import { ChartTitle, OpenChartContext, Rating } from "../components/prism/chart-rows";
import { PrismUpdates } from "../components/prism/PrismUpdates";

const PrismVisualizer = lazy(() => import("../components/prism/PrismVisualizer"));

/*
 * /news/prism: the Prism announcement. The numbers are each chart's Overall
 * as MinaCalc 0.75.0 and Prism v25 rate it at 1.0x, measured on the day
 * Prism went live; they are written in, not read from the backend, so they
 * stay what the article says after later versions move them.
 */

interface PrismNewsSearch {
  tab?: "visualizer" | "updates";
  map?: number;
  rate?: number;
}

const VISUALIZER_RATES = [0.75, 1, 1.5];

export const Route = createFileRoute("/news_/prism")({
  validateSearch: (search: Record<string, unknown>): PrismNewsSearch => {
    const map = Number(search.map), rate = Number(search.rate);
    return {
      tab: search.tab === "visualizer" || search.tab === "updates" ? search.tab : undefined,
      map: Number.isInteger(map) && map > 0 && map < 100_000_000 ? map : undefined,
      rate: VISUALIZER_RATES.includes(rate) && rate !== 1 ? rate : undefined,
    };
  },
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: i18n._(msg`Prism`),
      description: i18n._(msg`6K, 7K and 8K charts and plays are now rated by Prism, a difficulty calculator made for those keymodes.`),
      path: "/news/prism",
      origin: match.context.origin,
      imageTitle: "Prism",
    });
  },
  component: PrismAnnouncement,
});

const PUBLISHED_AT = "2026-10-17T12:00:00Z";
const LINK = "text-white underline decoration-white/30 underline-offset-2 transition-colors hover:decoration-white";

interface ExampleChart {
  beatmapId: number;
  beatmapsetId: number;
  title: string;
  version: string;
  minaCalc: number;
  prism: number;
  /** Prism's LN number, on a chart it rates LN on. */
  ln?: number;
}

const LN_CHARTS: ExampleChart[] = [
  { beatmapId: 2617975, beatmapsetId: 765642, title: "Mizuki Nana - Exterminate", version: "7k Noodles", minaCalc: 25.1, prism: 38.3, ln: 36.9 },
  { beatmapId: 2672368, beatmapsetId: 1287168, title: "Kim_GodSSI's LN Practice Pack 1", version: "[7K] M2U & NICODE - Stellar", minaCalc: 15.6, prism: 30.0, ln: 29.9 },
  { beatmapId: 963008, beatmapsetId: 448738, title: "Aphex Twin - Avril 14th (webodan's 8-bit GXSCC cover)", version: "[7K] Challenge", minaCalc: 4.9, prism: 18.5, ln: 27.1 },
];

const JUMPTRILL_CHARTS: ExampleChart[] = [
  { beatmapId: 2500146, beatmapsetId: 1200573, title: "Chroma - Sink to the Deep Sea World", version: "[7K] Jumptrill ~>", minaCalc: 43.5, prism: 18.0 },
  { beatmapId: 2500143, beatmapsetId: 1200573, title: "Chroma - Sink to the Deep Sea World", version: "[7K] Jumptrill ~> [1.3x Rate]", minaCalc: 56.1, prism: 30.0 },
  { beatmapId: 5247287, beatmapsetId: 2414862, title: "CNM - Wo Yong Shu Zi CNM", version: "7k//CNM", minaCalc: 39.5, prism: 25.4 },
  { beatmapId: 1344338, beatmapsetId: 633410, title: "Akaza Akari(CV:Mikami Shiori) - Watashi, Shuyaku no Akaza Akari desu", version: "7K (3/4)", minaCalc: 32.1, prism: 14.8 },
  { beatmapId: 5093305, beatmapsetId: 2362647, title: "D-Devils - Dance with the devil", version: "[7K] JT ezzzzz", minaCalc: 30.7, prism: 19.7 },
];

const ROLL_CHARTS: ExampleChart[] = [
  { beatmapId: 1527715, beatmapsetId: 641316, title: "fourfolium - STEP by STEP UP", version: "[6K] Cinnamon Burst!!", minaCalc: 45.5, prism: 30.7 },
  { beatmapId: 1538156, beatmapsetId: 728576, title: "Unknown artist - reflec streamz", version: "[6K] ABSOLUTE STREAM", minaCalc: 34.3, prism: 19.8 },
];

const CHORD_SPAM_CHARTS: ExampleChart[] = [
  { beatmapId: 5863316, beatmapsetId: 2615349, title: "DJ Mars - Lemon Tree", version: "7K IMPOSSIBLE 0.7x (100bpm)", minaCalc: 32.9, prism: 21.7 },
];

// Sea of Stars [7K] Interstellar Expedition, each engine's skillsets as the
// map page showed them (MinaCalc's Technical is not shown on 6K-8K).
const SKILLSET_CHART = { beatmapId: 5074941, beatmapsetId: 2356548, title: "Kyutatsuki - Sea of Stars", version: "[7K] Interstellar Expedition" };
const MINACALC_SKILLSETS: Array<[MessageDescriptor, number]> = [
  [msg`Overall`, 46.0], [msg`Stream`, 33.2], [msg`Jumpstream`, 31.9], [msg`Handstream`, 45.1], [msg`Stamina`, 45.3], [msg`Jackspeed`, 17.5], [msg`Chordjack`, 25.4],
];
const PRISM_SKILLSETS: Array<[MessageDescriptor, number]> = [
  [msg`Overall`, 49.4], [msg`Chordstream`, 49.4], [msg`Bracket`, 43.1], [msg`Jack`, 36.0], [msg`Technical`, 48.2], [msg`Delay`, 47.3], [msg`LN`, 47.8],
];

function ChartComparison({ charts }: { charts: ExampleChart[] }) {
  return (
    <div className="my-6 divide-y divide-white/[0.07] rounded-lg bg-osu-b4/40">
      {charts.map((chart) => (
        <div key={chart.beatmapId} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
          <div className="min-w-0 flex-1"><ChartTitle chart={chart} /></div>
          <div className="flex justify-end gap-3">
            <Rating engine="MinaCalc" value={chart.minaCalc.toFixed(1)} />
            <Rating engine="Prism" value={chart.prism.toFixed(1)} strong />
            {chart.ln != null ? <Rating engine="Prism LN" value={chart.ln.toFixed(1)} strong /> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function SkillsetList({ engine, values, strong }: { engine: string; values: Array<[MessageDescriptor, number]>; strong?: boolean }) {
  const { i18n } = useLingui();
  return (
    <div className="min-w-0 flex-1">
      <div className="pb-1 text-[11px] text-osu-f1">{engine}</div>
      {values.map(([name, value]) => (
        <div key={name.id} className="flex items-baseline justify-between gap-3 py-0.5 text-[14px]">
          <span className={strong ? "text-white" : "text-osu-f1"}>{i18n._(name)}</span>
          <span className={strong ? "font-semibold tabular-nums text-white" : "tabular-nums text-osu-f1"}>{value.toFixed(1)}</span>
        </div>
      ))}
    </div>
  );
}

function SkillsetComparison() {
  return (
    <div className="my-6 rounded-lg bg-osu-b4/40">
      <div className="px-3 py-2.5"><ChartTitle chart={SKILLSET_CHART} /></div>
      <div className="flex gap-8 border-t border-white/[0.07] px-3 py-3">
        <SkillsetList engine="MinaCalc" values={MINACALC_SKILLSETS} />
        <SkillsetList engine="Prism" values={PRISM_SKILLSETS} strong />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-[17px] font-semibold text-white">{title}</h2>
      <div className="mt-3 space-y-4 text-[15px] leading-relaxed text-osu-l2">{children}</div>
    </section>
  );
}

function PrismTabs({ tab }: { tab: PrismNewsSearch["tab"] }) {
  const tabs: Array<{ value: PrismNewsSearch["tab"]; label: ReactNode }> = [
    { value: undefined, label: <Trans>Article</Trans> },
    { value: "updates", label: <Trans>Updates</Trans> },
    { value: "visualizer", label: <Trans>Visualizer</Trans> },
  ];
  return (
    <div className="flex justify-center border-b border-osu-b3/25 px-4 sm:px-5">
      {tabs.map((item) => (
        <Link
          key={item.value ?? "article"}
          to="/news/prism"
          search={{ tab: item.value }}
          className={`relative shrink-0 whitespace-nowrap px-4 py-3 text-[12px] font-semibold transition-colors duration-[120ms] ${tab === item.value ? "text-white" : "text-osu-f1 hover:text-osu-l2"}`}
        >
          {item.label}
          {tab === item.value ? (
            <motion.span
              layoutId="prism-news-tab-indicator"
              className="absolute inset-x-2.5 bottom-0 h-[2px] rounded-full bg-osu-h1"
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
            />
          ) : null}
        </Link>
      ))}
    </div>
  );
}

function PrismAnnouncement() {
  const search = Route.useSearch();
  const tab = search.tab;
  const navigate = useNavigate({ from: "/news/prism" });
  const locale = useLocale();
  const [detail, setDetail] = useState<LiveMapSearchEntry | null>(null);
  const hydrated = useHasHydrated();
  // Opened, and read once the end of the article has been on screen (the dan explainer's pair).
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (hydrated) track("prism_news_view");
  }, [hydrated]);
  useEffect(() => {
    const end = endRef.current;
    if (!hydrated || !end || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      track("prism_news_read");
    });
    observer.observe(end);
    return () => observer.disconnect();
  }, [hydrated]);
  const openChart = (beatmapId: number) => {
    loadLiveMapSearchEntry(beatmapId).then((entry) => { if (entry) setDetail(entry); }).catch(() => {});
  };
  const published = new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(PUBLISHED_AT));

  return (
    <OpenChartContext.Provider value={openChart}>
      <div className="flex-1">
        <PageHeader iconSrc="/images/icons/prism.svg" title="Prism" />
        <div className="bg-osu-b5 min-h-[80vh]">
          <PrismTabs tab={tab} />
          {tab === "visualizer" ? (
            <div className="mx-auto max-w-5xl px-4 pt-5 pb-8 sm:px-5 sm:pb-12">
              {hydrated ? (
                <Suspense fallback={null}>
                  <PrismVisualizer
                    beatmapId={search.map ?? null}
                    rate={search.rate ?? 1}
                    onChange={({ beatmapId, rate }) => void navigate({
                      search: { tab: "visualizer", map: beatmapId ?? undefined, rate: rate === 1 ? undefined : rate },
                      replace: true,
                    })}
                  />
                </Suspense>
              ) : null}
            </div>
          ) : tab === "updates" ? (
            <div className="mx-auto max-w-2xl px-4 pt-4 pb-8 sm:px-5 sm:pb-12">
              <PrismUpdates />
            </div>
          ) : (
          <article className="mx-auto max-w-2xl px-4 pt-4 pb-8 sm:px-5 sm:pb-12">
            <div className="text-[12px] text-osu-f1">{published}</div>
            <h1 className="mt-2 flex items-center gap-3 text-2xl font-semibold leading-tight text-white sm:text-3xl">
              <img src="/images/prism-v2.svg" alt="" width={32} height={32} className="h-8 w-8 shrink-0" />
              <Trans>6K, 7K and 8K are now rated by Prism</Trans>
            </h1>

            <div className="mt-6 space-y-4 border-t border-white/[0.07] pt-6 text-[15px] leading-relaxed text-osu-l2">
              <p>
                <Trans>
                  Prism is a difficulty calculator made for 6K, 7K and 8K. It now rates every chart and play on those keymodes
                  instead of MinaCalc, which still rates 4K, 5K and 9K and up.
                </Trans>
              </p>
              <p>
                <Trans>
                  MinaCalc was made for 4K. On 6K to 8K it rated charts with the same skillsets it uses on 4K, without Technical, and gave no chart an LN number.
                </Trans>
              </p>
            </div>

            <Section title={<Trans>Skillsets</Trans>}>
              <p>
                <Trans>
                  Prism rates Chordstream, Bracket, Jack, Technical and Delay, and LN on charts with enough holds.
                </Trans>
              </p>
            </Section>
            <SkillsetComparison />

            <Section title={<Trans>LN charts</Trans>}>
              <p>
                <Trans>
                  1,632 ranked and loved 6K-8K charts now have an LN number, and LN charts are the ones whose ratings moved the
                  most.
                </Trans>
              </p>
              <p>
                <Trans>
                  A chart gets an LN number when at least 37.5% of its notes are holds on 7K (45% on 6K and 8K), or when a hold runs
                  through most of the chart while the other fingers keep pressing under it. A chart whose holds you can tap and let
                  go in time gets none. A chart with 30 seconds or more of LN sections is rated LN on those sections.
                </Trans>
              </p>
              <p>
                <Trans>
                  Pressing while other fingers of the same hand are holding costs more the more fingers are held and the longer they
                  hold, and letting go of a long hold costs too.
                </Trans>
              </p>
            </Section>
            <ChartComparison charts={LN_CHARTS} />

            <Section title={<Trans>Joke charts</Trans>}>
              <p>
                <Trans>
                  MinaCalc rated jumptrill charts much harder than they are to play.
                </Trans>
              </p>
            </Section>
            <ChartComparison charts={JUMPTRILL_CHARTS} />
            <p className="text-[15px] leading-relaxed text-osu-l2">
              <Trans>
                Rolls this fast get played as chords, and Prism rates them as chords.
              </Trans>
            </p>
            <ChartComparison charts={ROLL_CHARTS} />
            <p className="text-[15px] leading-relaxed text-osu-l2">
              <Trans>
                Charts that only repeat the same full chord rate closer to a jack now.
              </Trans>
            </p>
            <ChartComparison charts={CHORD_SPAM_CHARTS} />

            <Section title={<Trans context="article heading">Accuracy</Trans>}>
              <p>
                <Trans>
                  Plays are rated on ScoreV2 accuracy, the accuracy osu!lazer shows, instead of Etterna's Wife3. Wife3 takes a lot
                  for misses and broken holds, so about a quarter of 7K LN plays between 93% and 95% fell under its cutoff and
                  didn't count. Plays above 90% count now.
                </Trans>
              </p>
              <p>
                <Trans>
                  Prism also reads the chart's OD. Wider hit windows make a chart easier to score on, so the same notes rate lower at
                  a low OD, and more so on LN charts.
                </Trans>
              </p>
            </Section>

            <Section title={<Trans>Your ratings</Trans>}>
              <p>
                <Trans>
                  Your 6K, 7K and 8K skill ratings are being recalculated with Prism. Until a player's are, they don't show on
                  those keymodes' leaderboards.
                </Trans>
              </p>
              <p>
                <Trans>
                  69% of ranked and loved 6K-8K charts moved by less than 2. You can see any chart's numbers in <Link to="/maps" search={{} as never} className={LINK}>Maps</Link>.
                </Trans>
              </p>
              <p>
                <Trans>
                  If a chart's rating looks wrong to you, send it through <Link to="/report" search={{ from: "/news/prism" }} className={LINK}>Report a bug</Link>.
                </Trans>
              </p>
            </Section>
            <div ref={endRef} />
          </article>
          )}
        </div>
        {detail ? <MapDetailModal entry={detail} onClose={() => setDetail(null)} /> : null}
      </div>
    </OpenChartContext.Provider>
  );
}
