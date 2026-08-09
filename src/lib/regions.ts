// Region scopes: named groups of countries (e.g. R-SEASIA = Southeast Asia,
// R-EUROPE = the whole continent) that behave like GLOBAL — synthetic,
// selectable wherever a country is, and resolved by the live backend as a
// read-time filter over member countries. The table itself is generated from
// live-backend/src/regions.ts (the source of truth) together with each
// region's map-silhouette icon path; regenerate with
// `npm run regions:build-icons`.
import { REGION_DEFS, REGION_SHAPES, type RegionDef, type RegionShape } from "./regions.generated";

export type { RegionDef, RegionShape };

const byName = (a: RegionDef, b: RegionDef) => a.name.localeCompare(b.name);

// Oceania has no subregion split, so it lists under Continents only.
export const CONTINENT_OPTIONS: readonly RegionDef[] = REGION_DEFS.filter(
  (region) => region.group === "continent",
).sort(byName);

export const REGION_OPTIONS: readonly RegionDef[] = REGION_DEFS.filter(
  (region) => region.group === "region",
).sort(byName);

const REGION_BY_CODE = new Map<string, RegionDef>(REGION_DEFS.map((region) => [region.code, region]));

export function isRegionScope(code?: string | null): boolean {
  return REGION_BY_CODE.has(code?.trim().toUpperCase() ?? "");
}

export function getRegionDef(code?: string | null): RegionDef | null {
  return REGION_BY_CODE.get(code?.trim().toUpperCase() ?? "") ?? null;
}

export function getRegionShape(code?: string | null): RegionShape | null {
  return REGION_SHAPES[code?.trim().toUpperCase() ?? ""] ?? null;
}
