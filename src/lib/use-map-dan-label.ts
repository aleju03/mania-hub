import { danWholeLabel } from "./dan-images";
import { useWholeMapDans } from "../store";

export type MapDanLabel = (label: string, keyCount: number, side: string | null | undefined) => string;

const asIs: MapDanLabel = (label) => label;

/** How a map's dan label is shown under the "whole dans" map option. */
export function useMapDanLabel(): MapDanLabel {
  return useWholeMapDans() ? danWholeLabel : asIs;
}
