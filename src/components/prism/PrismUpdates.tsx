import { useState, type ReactNode } from "react";
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
const LN = "#4fd1c5";

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

// How far each v25 7K LN rating moved in v26: the scale's knots from 21 up.
const LN_SCALE_CHANGE: Array<[number, number]> = [
  [21.12, 21.06], [24.54, 23.18], [26.71, 24.83], [28.21, 26.42], [29.45, 27.63], [30.59, 29.02],
  [32.27, 30.67], [33.45, 31.98], [35.17, 33.91], [36.72, 35.93], [39.58, 39.43], [43.01, 43.51],
];

function LnScaleChart() {
  const { t } = useLingui();
  const locale = useLocale();
  const [hover, setHover] = useState<number | null>(null);
  const width = 520, height = 220, left = 64, right = 16, top = 16, bottom = 36;
  const xMin = 20, xMax = 45, yMin = -2.5, yMax = 1;
  const x = (v: number) => left + ((v - xMin) / (xMax - xMin)) * (width - left - right);
  const y = (v: number) => top + ((yMax - v) / (yMax - yMin)) * (height - top - bottom);
  const points = LN_SCALE_CHANGE.map(([before, after]) => ({ before, after, change: after - before }));
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.before).toFixed(1)},${y(p.change).toFixed(1)}`).join(" ");
  const fmt = (v: number) => v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const active = hover != null ? points[hover] : null;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="block w-full" role="img" aria-label={t`Change in 7K LN rating by v25 LN rating`} onPointerLeave={() => setHover(null)}>
        {[-2, -1, 0, 1].map((v) => (
          <g key={v}>
            <line x1={left} x2={width - right} y1={y(v)} y2={y(v)} stroke={v === 0 ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.07)"} strokeWidth={1} />
            <text x={left - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill="#8f879c">{v > 0 ? `+${v}` : v}</text>
          </g>
        ))}
        <text
          x={14}
          y={(top + height - bottom) / 2}
          transform={`rotate(-90 14 ${(top + height - bottom) / 2})`}
          textAnchor="middle"
          fontSize={11}
          fill="#8f879c"
        >
          {t`Change in v26`}
        </text>
        {[20, 25, 30, 35, 40, 45].map((v) => (
          <text key={v} x={x(v)} y={height - 14} textAnchor="middle" fontSize={11} fill="#8f879c">{v}</text>
        ))}
        <path d={path} fill="none" stroke={LN} strokeWidth={2} strokeLinejoin="round" />
        {points.map((p, i) => (
          <g key={p.before}>
            <circle cx={x(p.before)} cy={y(p.change)} r={hover === i ? 5 : 4} fill={LN} stroke="#2a2433" strokeWidth={2} />
            <rect
              x={x(p.before) - 14}
              y={top}
              width={28}
              height={height - top - bottom}
              fill="transparent"
              onPointerEnter={() => setHover(i)}
            />
          </g>
        ))}
      </svg>
      {active ? (
        <div
          className="pointer-events-none absolute top-1 rounded-md bg-osu-b5/95 px-2.5 py-1.5 text-[12px] text-osu-l2 shadow"
          style={{ left: `${(x(active.before) / width) * 100}%`, transform: "translateX(-50%)" }}
        >
          <span className="tabular-nums text-white">{fmt(active.before)}</span> → <span className="tabular-nums text-white">{fmt(active.after)}</span>
        </div>
      ) : null}
      <div className="mt-1 text-center text-[11px] text-osu-f1"><Trans>7K LN rating in v25</Trans></div>
    </div>
  );
}

const RELEASE_CHARTS: UpdateChart[] = [
  { beatmapId: 737488, beatmapsetId: 333217, title: "Gotou Mai - Funwari Fuwari", version: "[7K] yoshilove's Uryu~", before: 24.6, after: 17.4 },
  { beatmapId: 776949, beatmapsetId: 299333, title: "Yiruma - River Flows in You (LR Mix)", version: "6K Insane", before: 24.3, after: 17.4 },
  { beatmapId: 1113454, beatmapsetId: 524596, title: "Gareth Coker - Restoring the Light, Facing the Dark", version: "[6K] Darkness", before: 24.2, after: 17.7 },
];

const MASH_CHARTS: UpdateChart[] = [
  { beatmapId: 863485, beatmapsetId: 396959, title: "Koxx - A Fool Moon Night", version: "[7K] Hard Lv.150", before: 42.6, after: 38.8 },
  { beatmapId: 5136234, beatmapsetId: 2377142, title: "penoreri - oniyuri", version: "[7K] DT", before: 31.6, after: 24.0 },
  { beatmapId: 4447758, beatmapsetId: 2117791, title: "xi vs. Morimori Atsushi - SuddeNDeath", version: "7K Burst", before: 30.1, after: 25.9 },
];

const BRACKET_CHARTS: UpdateChart[] = [
  { beatmapId: 1350621, beatmapsetId: 636543, title: "you - Hold Angel", version: "[7K] Seraph", before: 37.3, after: 31.4 },
  { beatmapId: 646681, beatmapsetId: 272871, title: "D(ABE3) - MANIERA", version: "[7K] Masterpiece", before: 28.6, after: 23.8 },
  { beatmapId: 4105372, beatmapsetId: 1265691, title: "TamaDo - Triumphal Return", version: "Blocko's 7K Victory", before: 49.5, after: 49.5 },
  { beatmapId: 2318148, beatmapsetId: 1080892, title: "Fractal Dreamers - Gardens Under A Spring Sky", version: "[7K] Blocko's Daylight", before: 29.7, after: 29.7 },
];

const LN_SCALE_CHARTS: UpdateChart[] = [
  { beatmapId: 2672368, beatmapsetId: 1287168, title: "Kim_GodSSI's LN Practice Pack 1", version: "[7K] M2U & NICODE - Stellar", before: 29.9, after: 28.2 },
  { beatmapId: 2617975, beatmapsetId: 765642, title: "Mizuki Nana - Exterminate", version: "7k Noodles", before: 36.9, after: 36.1 },
  { beatmapId: 5074941, beatmapsetId: 2356548, title: "Kyutatsuki - Sea of Stars", version: "[7K] Interstellar Expedition", before: 47.8, after: 49.3 },
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
          v26 mostly changes 7K LN and Bracket ratings. Overall moved on 331 of the 48,129 6K-8K charts, almost all of them unranked low OD charts.
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
            don't are Chordstream.
          </Trans>
        </p>
        <p>
          <Trans>
            Bracket dropped by more than 2 on 1,957 6K-8K charts and went up on none. No chart's Overall moved by more
            than 0.1.
          </Trans>
        </p>
        <Figure caption={<Trans>MANIERA [7K] Masterpiece at 1:29. Purple rows are Bracket, orange rows are Chordstream.</Trans>}>
          <BracketFigure beatmapId={646681} fromMs={89315} toMs={90949} />
        </Figure>
        <ChartChanges charts={BRACKET_CHARTS} label={t`Bracket`} />
      </Change>

      <Change title={<Trans>7K LN ratings</Trans>}>
        <p>
          <Trans>
            7K LN ratings from the low 20s to the mid 30s read about 1.5 above rice ratings at the same level, going by players with
            scores on both. In v26 those go down by up to 1.9, and ratings past 40 go up by up to 0.5.
          </Trans>
        </p>
        <Figure>
          <LnScaleChart />
        </Figure>
        <ChartChanges charts={LN_SCALE_CHARTS} label="LN" />
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
