import { useMemo } from "react";
import { useLingui } from "@lingui/react/macro";
import type { PrismExplanation } from "#dan/prism/explain";
import type { PrismPattern } from "#dan/prism/workload";
import { usePrismExplanation } from "./use-prism-explanation";

/*
 * A passage still, twice: the rows as v25 filed them and as v26 does. v26 is
 * Prism's own reading (explain.ts); v25 is the same reading with the old
 * bracket rule put back, which filed any three chord rows that share no key
 * with the row before as Bracket, returning to the first row's keys or not.
 */

const LANE = 30;
const PX_PER_MS = 0.24;
const PAD = 12;
const GAP = 40;
const LABEL_H = 24;
// Same as motion's MOTION_MAX_GAP_MS in prism/workload.ts.
const CLOSE_MS = 250;
const COLOR: Record<PrismPattern, string> = {
  stream: "#f2c899",
  chordstream: "#ffa24a",
  bracket: "#b77cff",
  jack: "#ff5d6c",
  chordjack: "#ff5d6c",
  ln: "#4fd1c5",
  technical: "#9a93a6",
  speed: "#9a93a6",
};

const bits = (mask: number) => { let n = 0; for (let m = mask; m; m &= m - 1) n += 1; return n; };
const highest = (mask: number) => 31 - Math.clz32(mask);
const lowest = (mask: number) => highest(mask & -mask);
const rollsPast = (a: number, b: number) => highest(a) < lowest(b) || lowest(a) > highest(b);

/** Row start times v25 filed as Bracket and v26 does not. */
function v25OnlyBrackets(explanation: PrismExplanation): Set<number> {
  const rows = new Map<number, { mask: number; pattern: PrismPattern }>();
  for (const note of explanation.notes) {
    const row = rows.get(note.start) ?? { mask: 0, pattern: note.pattern };
    row.mask |= 1 << note.lane;
    rows.set(note.start, row);
  }
  const out = new Set<number>();
  let row1 = 0, row2 = 0, row1At = -Infinity;
  for (const time of [...rows.keys()].sort((a, b) => a - b)) {
    const { mask: row, pattern } = rows.get(time)!;
    const close = time - row1At <= CLOSE_MS;
    if (pattern === "chordstream" && close && bits(row) >= 2 && !(row & row1) && bits(row1) >= 2 && bits(row2) >= 2
      && !(row2 & row1) && !rollsPast(row2, row1) && !rollsPast(row1, row) && !(row2 & row)) out.add(time);
    row2 = row1; row1 = row; row1At = time;
  }
  return out;
}

export function BracketFigure({ beatmapId, fromMs, toMs }: { beatmapId: number; fromMs: number; toMs: number }) {
  const { t } = useLingui();
  const { explanation, failed } = usePrismExplanation(beatmapId);
  const changed = useMemo(() => (explanation ? v25OnlyBrackets(explanation) : new Set<number>()), [explanation]);
  if (failed) return null;
  const keys = explanation?.keyCount ?? 7;
  const field = LANE * keys;
  const width = field * 2 + GAP;
  const fieldHeight = (toMs - fromMs) * PX_PER_MS + PAD * 2;
  const height = fieldHeight + LABEL_H;
  if (!explanation) return <div className="mx-auto" style={{ maxWidth: width, aspectRatio: `${width} / ${height}` }} />;

  const from = fromMs - explanation.origin, to = toMs - explanation.origin;
  const yOf = (time: number) => fieldHeight - PAD - (time - from) * PX_PER_MS;
  const notes = explanation.notes.filter((note) => note.start >= from && note.start <= to);

  const drawField = (x0: number, label: string, v25: boolean) => (
    <g>
      <rect x={x0} y={0} width={field} height={fieldHeight} rx={6} fill="#0e0b13" />
      {Array.from({ length: keys - 1 }, (_, i) => (
        <rect key={i} x={x0 + (i + 1) * LANE} y={0} width={1} height={fieldHeight} fill="rgba(255,255,255,0.05)" />
      ))}
      {notes.map((note, i) => {
        const pattern = v25 && changed.has(note.start) ? "bracket" : note.pattern;
        return <rect key={i} x={x0 + note.lane * LANE + 3} y={yOf(note.start) - 7} width={LANE - 6} height={7} rx={2} fill={COLOR[pattern]} />;
      })}
      <text x={x0 + field / 2} y={height - 6} textAnchor="middle" fontSize={12} fill="#b9b1c6">{label}</text>
    </g>
  );

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="mx-auto block w-full"
      style={{ maxWidth: width }}
      role="img"
      aria-label={t`A passage's rows as v25 and v26 file them`}
    >
      {drawField(0, "v25", true)}
      {drawField(field + GAP, "v26", false)}
    </svg>
  );
}
