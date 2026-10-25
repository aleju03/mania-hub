import { useLingui } from "@lingui/react/macro";
import { usePrismExplanation } from "./use-prism-explanation";

/*
 * A few seconds of a real chart, still, laid out like the playfield (time
 * runs up). Every hold's release carries the share of its v25 cost it keeps
 * in v26, so the cheaper ones stand out against the ones that stay full.
 */

const LANE = 56;
const PX_PER_MS = 0.18;
const PAD = 14;
const TAP = "#e8e4ef";
const HOLD = "#4fd1c5";

export function ReleaseFigure({ beatmapId, fromMs, toMs }: { beatmapId: number; fromMs: number; toMs: number }) {
  const { t } = useLingui();
  const { explanation, failed } = usePrismExplanation(beatmapId);
  if (failed) return null;
  const keys = explanation?.keyCount ?? 7;
  const width = LANE * keys;
  const height = (toMs - fromMs) * PX_PER_MS + PAD * 2;
  if (!explanation) return <div className="mx-auto rounded-md bg-[#0e0b13]" style={{ maxWidth: width, aspectRatio: `${width} / ${height}` }} />;

  const from = fromMs - explanation.origin, to = toMs - explanation.origin;
  const yOf = (time: number) => height - PAD - (time - from) * PX_PER_MS;
  const notes = explanation.notes.filter((note) => note.end >= from && note.start <= to);
  const releases = explanation.releases.filter((release) => release.time >= from && release.time <= to);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="mx-auto block w-full rounded-md bg-[#0e0b13]"
      style={{ maxWidth: width }}
      role="img"
      aria-label={t`Each release in a passage, labelled with the share of its v25 cost it keeps in v26`}
    >
      <defs>
        <clipPath id="release-figure-field"><rect x={0} y={0} width={width} height={height} /></clipPath>
      </defs>
      {Array.from({ length: keys - 1 }, (_, i) => (
        <rect key={i} x={(i + 1) * LANE} y={0} width={1} height={height} fill="rgba(255,255,255,0.05)" />
      ))}
      <g clipPath="url(#release-figure-field)">
        {notes.map((note, i) => {
          const x = note.lane * LANE + 6, w = LANE - 12;
          const y = yOf(note.start);
          if (note.end <= note.start) return <rect key={i} x={x} y={y - 9} width={w} height={9} rx={2.5} fill={TAP} />;
          const yEnd = yOf(note.end);
          return (
            <g key={i}>
              <rect x={x + 9} y={yEnd} width={w - 18} height={y - yEnd} fill={HOLD} opacity={0.3} />
              <rect x={x} y={y - 9} width={w} height={9} rx={2.5} fill={HOLD} />
            </g>
          );
        })}
        {releases.map((release, i) => {
          const cx = release.lane * LANE + LANE / 2;
          const y = yOf(release.time);
          const cheaper = release.factor < 0.95;
          return (
            <g key={i}>
              <rect x={release.lane * LANE + 6} y={y - 1.5} width={LANE - 12} height={3} rx={1.5} fill={cheaper ? "#ffffff" : "rgba(255,255,255,0.45)"} />
              <rect x={cx - 19} y={y - 21} width={38} height={16} rx={8} fill={cheaper ? "#ffffff" : "rgba(14,11,19,0.9)"} />
              <text
                x={cx}
                y={y - 9}
                textAnchor="middle"
                fontSize={11}
                fontWeight={700}
                fill={cheaper ? "#0e0b13" : "#8f879c"}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {Math.round(release.factor * 100)}%
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
