import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { useLocale } from "../../lib/locale-context";
import { formatDate } from "../../lib/format";
import { ChartTitle, Rating } from "./chart-rows";
import { ReleaseFigure } from "./ReleaseFigure";
import { BracketFigure } from "./BracketFigure";
import { MashOdExplorer } from "./MashOdExplorer";

/*
 * The Prism article's Updates tab: one entry per Prism version, newest first,
 * each change with a diagram and charts measured before and after. The
 * numbers are written in, measured when the version shipped, so they stay
 * what the entry says after later versions move them.
 */

const LINK = "text-white underline decoration-white/30 underline-offset-2 transition-colors hover:decoration-white";

interface UpdateChart {
  beatmapId: number;
  beatmapsetId: number;
  title: string;
  version: string;
  before: number;
  after: number;
}

function ChartChanges({ charts, label }: { charts: UpdateChart[]; label: string }) {
  return (
    <div className="my-5 divide-y divide-white/[0.07] rounded-lg bg-osu-b4/40">
      {charts.map((chart) => (
        <div key={chart.beatmapId} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
          <div className="min-w-0 flex-1"><ChartTitle chart={chart} /></div>
          <div className="flex justify-end gap-3">
            <Rating engine={`v25 ${label}`} value={chart.before.toFixed(1)} />
            <Rating engine={`v26 ${label}`} value={chart.after.toFixed(1)} strong />
          </div>
        </div>
      ))}
    </div>
  );
}

function Change({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h3 className="text-[16px] font-semibold text-white">{title}</h3>
      <div className="mt-3 space-y-4 text-[15px] leading-relaxed text-osu-l2">{children}</div>
    </section>
  );
}

function Figure({ children, caption }: { children: ReactNode; caption?: ReactNode }) {
  return (
    <figure className="my-5">
      <div className="rounded-lg bg-osu-b4/40 p-3">{children}</div>
      {caption ? <figcaption className="mt-2 text-[12px] leading-relaxed text-osu-f1">{caption}</figcaption> : null}
    </figure>
  );
}

const RELEASE_CHARTS: UpdateChart[] = [
  { beatmapId: 737488, beatmapsetId: 333217, title: "Gotou Mai - Funwari Fuwari", version: "[7K] yoshilove's Uryu~", before: 24.6, after: 20.8 },
  { beatmapId: 776949, beatmapsetId: 299333, title: "Yiruma - River Flows in You (LR Mix)", version: "6K Insane", before: 24.3, after: 13.9 },
  { beatmapId: 1113454, beatmapsetId: 524596, title: "Gareth Coker - Restoring the Light, Facing the Dark", version: "[6K] Darkness", before: 24.2, after: 20.3 },
];

const HYBRID_CHARTS: UpdateChart[] = [
  { beatmapId: 568463, beatmapsetId: 246853, title: "bbn - Identic Conflict", version: "[7K] Birdcage", before: 27.7, after: 20.4 },
  { beatmapId: 1742328, beatmapsetId: 831653, title: "kamome sano - starlights feat. TEA", version: "Celestial Radiance // 7K", before: 27.7, after: 24.9 },
];

const MASH_CHARTS: UpdateChart[] = [
  { beatmapId: 863485, beatmapsetId: 396959, title: "Koxx - A Fool Moon Night", version: "[7K] Hard Lv.150", before: 42.6, after: 38.8 },
  { beatmapId: 5136234, beatmapsetId: 2377142, title: "penoreri - oniyuri", version: "[7K] DT", before: 31.6, after: 24.0 },
  { beatmapId: 4447758, beatmapsetId: 2117791, title: "xi vs. Morimori Atsushi - SuddeNDeath", version: "7K Burst", before: 30.1, after: 25.9 },
];

const BRACKET_CHARTS: UpdateChart[] = [
  { beatmapId: 1350621, beatmapsetId: 636543, title: "you - Hold Angel", version: "[7K] Seraph", before: 37.3, after: 31.5 },
  { beatmapId: 646681, beatmapsetId: 272871, title: "D(ABE3) - MANIERA", version: "[7K] Masterpiece", before: 28.6, after: 24.6 },
  { beatmapId: 4105372, beatmapsetId: 1265691, title: "TamaDo - Triumphal Return", version: "Blocko's 7K Victory", before: 49.5, after: 49.5 },
  { beatmapId: 2318148, beatmapsetId: 1080892, title: "Fractal Dreamers - Gardens Under A Spring Sky", version: "[7K] Blocko's Daylight", before: 29.7, after: 29.7 },
];


function V26() {
  const { t } = useLingui();
  const locale = useLocale();
  return (
    <article>
      <div className="flex items-baseline gap-3">
        <h2 className="text-2xl font-semibold text-white">Prism v26</h2>
        <span className="text-[13px] text-osu-f1">{formatDate("2026-10-22", "UTC", locale)}</span>
      </div>
      <p className="mt-4 text-[15px] leading-relaxed text-osu-l2">
        <Trans>
          v26 mostly changes LN and Bracket ratings. Overall moved on 331 of the 48,129 6K-8K charts, almost all of them unranked low OD charts.
        </Trans>
      </p>

      <Change title={<Trans>Releases with nothing around them count for less</Trans>}>
        <p>
          <Trans>
            Before v26, letting go of a long note counted the same no matter what the rest of your hand was doing. Now a release counts
            for less when that hand isn't pressing or letting go of anything else around the same time. This mostly lowers slow charts
            made of long holds.
          </Trans>
        </p>
        <Figure caption={<Trans>Funwari Fuwari [7K] yoshilove's Uryu~ at 0:12. The number on each release is how much of its v25 difficulty it still counts for in v26.</Trans>}>
          <ReleaseFigure beatmapId={737488} fromMs={12378} toMs={14878} />
        </Figure>
        <ChartChanges charts={RELEASE_CHARTS} label="LN" />
      </Change>

      <Change title={<Trans>LN on hybrids</Trans>}>
        <p>
          <Trans>
            Charts where only some of the notes are long notes, and slow charts of long holds, were getting LN ratings well above what
            players score on them. Letting go of a long note now counts for less next to pressing one, so these charts go down. Full LN
            charts keep their ratings.
          </Trans>
        </p>
        <ChartChanges charts={HYBRID_CHARTS} label="LN" />
      </Change>

      <Change title={<Trans>Mash nerf</Trans>}>
        <p>
          <Trans>
            On low OD charts the hit windows are wide enough that pressing every key on a steady beat still hits most of the notes. Prism now
            judges that mash against the chart's hit windows, and when a section mashed gets 90% or more while being much easier than
            reading it, the section is rated as the mash.
          </Trans>
        </p>
        <p>
          <Trans>
            A chart where mashing carries most of its hardest parts shows as Unrateable, and plays on it don't count toward skill or dan
            ratings.
          </Trans>
        </p>
        <Figure caption={<Trans>Asgard [lvl 88] at 2:34, an OD 2 chart, played by pressing every key on a steady beat instead of reading the notes. Move the slider to judge the same presses at another OD.</Trans>}>
          <MashOdExplorer beatmapId={3979608} fromMs={154200} toMs={155800} />
        </Figure>
        <ChartChanges charts={MASH_CHARTS} label={t`Overall`} />
        <p>
          <Trans>
            The <Link to="/news/prism" search={{ tab: "visualizer", map: 3979608 }} className={LINK}>Visualizer</Link> marks the sections Prism rates as mashed.
          </Trans>
        </p>
      </Change>

      <Change title={<Trans>Brackets have to come back</Trans>}>
        <p>
          <Trans>
            Prism filed three chord rows in a row as a bracket whenever none shared a key with the one before it, so a roll of three
            split shapes counted too. The third row now has to come back to a key of the first, as in a real bracket, and the rows that
            don't are Chordstream. A hand hitting the same chord again within 250ms, with the other hand playing in between, is a jack.
          </Trans>
        </p>
        <p>
          <Trans>
            Bracket dropped by more than 2 on 1,858 6K-8K charts and went up by more than 1 on 20. No chart's Overall moved by
            more than 0.1.
          </Trans>
        </p>
        <Figure caption={<Trans>MANIERA [7K] Masterpiece at 1:29. Purple rows are Bracket, orange rows are Chordstream.</Trans>}>
          <BracketFigure beatmapId={646681} fromMs={89315} toMs={90949} />
        </Figure>
        <ChartChanges charts={BRACKET_CHARTS} label={t`Bracket`} />
      </Change>


    </article>
  );
}

export function PrismUpdates() {
  return (
    <div>
      <V26 />
    </div>
  );
}
