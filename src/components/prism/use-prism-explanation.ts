import { useEffect, useState } from "react";
import { explainPrism, type PrismExplanation } from "#dan/prism/explain";
import { parseManiaBeatmap } from "#dan/beatmap-parser";
import { getBeatmapFile } from "../../lib/osu";

/** The osu! judgement (0 = MAX ... 5 = miss) of a press this far off its note, at an OD. */
export function judgementOf(offset: number, od: number): number {
  const windows = [16, 64 - 3 * od, 97 - 3 * od, 127 - 3 * od, 151 - 3 * od];
  const index = windows.findIndex((w) => offset <= w);
  return index < 0 ? 5 : index;
}

/** A chart read by explainPrism at 1.0x, loaded in the browser. */
export function usePrismExplanation(beatmapId: number): { explanation: PrismExplanation | null; failed: boolean } {
  const [explanation, setExplanation] = useState<PrismExplanation | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getBeatmapFile({ data: { beatmapId } })
      .then((result) => {
        if (cancelled) return;
        const e = explainPrism(parseManiaBeatmap(result.content));
        if (e) setExplanation(e); else setFailed(true);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [beatmapId]);
  return { explanation, failed };
}
