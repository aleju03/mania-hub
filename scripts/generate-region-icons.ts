// Generates src/lib/regions.generated.ts: the frontend copy of the region
// table (live-backend/src/regions.ts is the source of truth) plus one SVG map
// silhouette per region.
//
// Run with: npm run regions:build-icons
//
// Source data (fetched once, cached in node_modules/.cache/region-icons/):
// - world-atlas@2 countries-50m.json (Natural Earth 1:50m admin-0, TopoJSON)
// - lukes/ISO-3166-Countries-with-Regional-Codes (ISO numeric -> alpha-2)
//
// Each region is drawn with a Lambert azimuthal equal-area projection centered
// on the region's spherical centroid (equal-area keeps Greenland-style mercator
// bloat out of the silhouettes; azimuthal sidesteps antimeridian cuts for
// Russia/Oceania). Overseas territories that Natural Earth folds into a parent
// country polygon (French Guiana into FR, Azores into PT, ...) are excluded by
// per-region geographic windows. Member countries too small to survive icon
// scale are drawn as dots so island regions still read as their map shape.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTINENTS, REGIONS, type RegionDef } from "../live-backend/src/regions.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = join(ROOT, "node_modules", ".cache", "region-icons");
const OUT_FILE = join(ROOT, "src", "lib", "regions.generated.ts");
const PREVIEW_FILE = process.env.REGION_ICON_PREVIEW ?? "";

const WORLD_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json";
const ISO_URL =
  "https://raw.githubusercontent.com/lukes/ISO-3166-Countries-with-Regional-Codes/master/all/all.json";

const VIEW = 24;
const PADDING = 1.5;
// Projected rings smaller than this (bbox diagonal, px) are dropped...
const RING_DROP_PX = 0.5;
// ...unless they are a country's only footprint, then it becomes a dot.
const DOT_RADIUS = 0.42;

// Natural Earth merges some territories into the parent country's polygon.
// Rings whose centroid falls outside every window for a region are excluded.
// Regions not listed keep everything. Boxes are [lonMin, lonMax, latMin, latMax].
const REGION_WINDOWS: Record<string, number[][]> = {
  "R-NAMERICA": [
    [-180, -50, 15, 84],
    [165, 180, 45, 62], // Aleutian islands west of the antimeridian
  ],
  "R-CAMERICA": [[-118, -77, 7, 33]],
  "R-CARIB": [[-86, -58, 10, 28]],
  "R-SAMERICA": [[-95, -25, -57, 14]], // keeps Galápagos, drops Easter Island
  "R-NEUROPE": [[-30, 35, 45, 72]], // lat cap drops Svalbard from NO
  "R-WEUROPE": [[-12, 20, 35, 60]], // drops French Guiana / DOM-TOM from FR
  "R-SEUROPE": [[-11, 36, 34, 47]], // east to Cyprus; drops Canary Islands (ES), Azores/Madeira (PT)
  "R-MIDEAST": [[25, 65, 11, 45]],
  "R-NAFRICA": [[-18, 38, 8, 38]],
  "R-WAFRICA": [[-26, 16, 3, 28]], // drops Saint Helena's south-Atlantic specks
  "R-MAFRICA": [[5, 32, -19, 24]],
  "R-EAFRICA": [[20, 75, -30, 19]],
  "R-SAFRICA": [[10, 40, -36, -15]], // drops Marion Island (ZA)
  "R-CASIA": [[45, 90, 35, 56]],
  "R-SASIA": [[58, 100, -1, 40]],
  "R-EASIA": [[73, 150, 15, 55]],
  "R-SEASIA": [[90, 145, -12, 30]],
  // Far-east Pacific micro-states (French Polynesia, Pitcairn, eastern
  // Kiribati) would stretch the fit until Australia is a blob; cut at ~165°W.
  "R-OCEANIA": [
    [110, 180, -55, 25],
    [-180, -165, -35, 20],
  ],
  // Continents (unions of the subregions above). Same idea as the windows
  // per subregion: crop far-flung specks that would shrink the landmass.
  "R-AFRICA": [
    [-26, 60, 3, 38],
    [5, 60, -36, 3], // the lon floor drops Saint Helena / Ascension (SH)
  ],
  "R-AMERICAS": [
    [-180, -25, -57, 84],
    [165, 180, 45, 62], // Aleutian islands west of the antimeridian
  ],
  // Classic map crop: Russia's mainland ring (centroid deep in Siberia) falls
  // out and RU survives as its Kaliningrad dot; lon 50 keeps the Caucasus in.
  "R-EUROPE": [[-25, 50, 34, 72]],
  "R-ASIA": [[24, 150, -12, 56]], // drops Minami-Tori-shima (JP) far east
};

// Geometries Natural Earth ships with a junk numeric id.
const NAME_TO_ALPHA2: Record<string, string> = {
  Kosovo: "XK",
  "N. Cyprus": "CY",
  Somaliland: "SO",
};

type Ring = number[][]; // [lon, lat][]

interface Topology {
  transform: { scale: [number, number]; translate: [number, number] };
  arcs: number[][][];
  objects: {
    countries: {
      geometries: Array<{
        type: string;
        id?: string;
        arcs: unknown[];
        properties?: { name?: string };
      }>;
    };
  };
}

async function fetchCached(url: string, file: string): Promise<unknown> {
  const path = join(CACHE_DIR, file);
  if (!existsSync(path)) {
    process.stdout.write(`fetching ${url}\n`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch failed ${res.status}: ${url}`);
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function decodeArcs(topo: Topology): Ring[] {
  const { scale, translate } = topo.transform;
  return topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
    });
  });
}

function assembleRing(arcIndexes: number[], arcs: Ring[]): Ring {
  const ring: Ring = [];
  for (const index of arcIndexes) {
    const arc = index >= 0 ? arcs[index] : arcs[~index].slice().reverse();
    // Consecutive arcs share their join point; skip the duplicate.
    ring.push(...(ring.length ? arc.slice(1) : arc));
  }
  return ring;
}

function countryRings(topo: Topology, numericToAlpha2: Map<string, string>): Map<string, Ring[]> {
  const arcs = decodeArcs(topo);
  const byAlpha2 = new Map<string, Ring[]>();

  for (const geometry of topo.objects.countries.geometries) {
    const name = geometry.properties?.name ?? "";
    let alpha2 = NAME_TO_ALPHA2[name];
    if (!alpha2 && geometry.id) {
      alpha2 = numericToAlpha2.get(String(Number(geometry.id))) ?? "";
    }
    if (!alpha2) continue;

    const polygons: number[][][] =
      geometry.type === "Polygon"
        ? [geometry.arcs as number[][]]
        : geometry.type === "MultiPolygon"
          ? (geometry.arcs as number[][][])
          : [];
    const rings = byAlpha2.get(alpha2) ?? [];
    for (const polygon of polygons) {
      // polygon[0] is the outer ring, the rest are holes; both are kept and
      // rendered with fill-rule evenodd.
      for (const arcIndexes of polygon) rings.push(assembleRing(arcIndexes, arcs));
    }
    byAlpha2.set(alpha2, rings);
  }
  return byAlpha2;
}

function ringCentroidLonLat(ring: Ring): [number, number] {
  let lon = 0;
  let lat = 0;
  for (const [x, y] of ring) {
    lon += x;
    lat += y;
  }
  return [lon / ring.length, lat / ring.length];
}

function inWindow(region: string, ring: Ring): boolean {
  const boxes = REGION_WINDOWS[region];
  if (!boxes) return true;
  const [lon, lat] = ringCentroidLonLat(ring);
  return boxes.some(
    ([lonMin, lonMax, latMin, latMax]) =>
      lon >= lonMin && lon <= lonMax && lat >= latMin && lat <= latMax,
  );
}

/** Unit-sphere mean of all vertices — wrap-safe center for the projection. */
function sphericalCentroid(rings: Ring[]): [number, number] {
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      const λ = (lon * Math.PI) / 180;
      const φ = (lat * Math.PI) / 180;
      sx += Math.cos(φ) * Math.cos(λ);
      sy += Math.cos(φ) * Math.sin(λ);
      sz += Math.sin(φ);
    }
  }
  const lon = (Math.atan2(sy, sx) * 180) / Math.PI;
  const lat = (Math.atan2(sz, Math.hypot(sx, sy)) * 180) / Math.PI;
  return [lon, lat];
}

function projectRing(ring: Ring, lon0: number, lat0: number): number[][] {
  const λ0 = (lon0 * Math.PI) / 180;
  const φ0 = (lat0 * Math.PI) / 180;
  return ring.map(([lon, lat]) => {
    const λ = (lon * Math.PI) / 180 - λ0;
    const φ = (lat * Math.PI) / 180;
    const denom = 1 + Math.sin(φ0) * Math.sin(φ) + Math.cos(φ0) * Math.cos(φ) * Math.cos(λ);
    const k = Math.sqrt(2 / Math.max(denom, 1e-9));
    return [
      k * Math.cos(φ) * Math.sin(λ),
      -k * (Math.cos(φ0) * Math.sin(φ) - Math.sin(φ0) * Math.cos(φ) * Math.cos(λ)),
    ];
  });
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// Douglas-Peucker: icon-scale rendering needs nothing near 1:50m fidelity.
const SIMPLIFY_TOLERANCE = 0.14;

function simplifyRing(ring: number[][]): number[][] {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, ring.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    const [x1, y1] = ring[first];
    const [x2, y2] = ring[last];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const norm = Math.hypot(dx, dy);
    let maxDist = -1;
    let maxIndex = -1;
    for (let i = first + 1; i < last; i += 1) {
      const [px, py] = ring[i];
      const dist = norm === 0
        ? Math.hypot(px - x1, py - y1)
        : Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / norm;
      if (dist > maxDist) {
        maxDist = dist;
        maxIndex = i;
      }
    }
    if (maxDist > SIMPLIFY_TOLERANCE && maxIndex > 0) {
      keep[maxIndex] = 1;
      stack.push([first, maxIndex], [maxIndex, last]);
    }
  }
  return ring.filter((_, i) => keep[i] === 1);
}

function ringToPath(ring: number[][]): string {
  const points: string[] = [];
  let lastX = NaN;
  let lastY = NaN;
  for (const [x, y] of simplifyRing(ring)) {
    const rx = round1(x);
    const ry = round1(y);
    if (rx === lastX && ry === lastY) continue;
    points.push(`${points.length ? "L" : "M"}${rx} ${ry}`);
    lastX = rx;
    lastY = ry;
  }
  if (points.length < 3) return "";
  return `${points.join("")}Z`;
}

function dotPath(x: number, y: number): string {
  const r = DOT_RADIUS;
  const cx = round1(x);
  const cy = round1(y - r);
  return `M${cx} ${cy}a${r} ${r} 0 1 1 -0.01 0Z`;
}

function buildRegionShape(
  code: string,
  members: readonly string[],
  ringsByCountry: Map<string, Ring[]>,
): { viewBox: string; path: string } | null {
  const perCountry = members
    .map((country) => ({
      country,
      rings: (ringsByCountry.get(country) ?? []).filter((ring) => inWindow(code, ring)),
    }))
    .filter((entry) => entry.rings.length > 0);
  if (perCountry.length === 0) return null;

  const allRings = perCountry.flatMap((entry) => entry.rings);
  const [lon0, lat0] = sphericalCentroid(allRings);
  const projected = perCountry.map((entry) => ({
    country: entry.country,
    rings: entry.rings.map((ring) => projectRing(ring, lon0, lat0)),
  }));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { rings } of projected) {
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const inner = VIEW - PADDING * 2;
  const scale = inner / Math.max(maxX - minX, maxY - minY);
  const offsetX = PADDING + (inner - (maxX - minX) * scale) / 2;
  const offsetY = PADDING + (inner - (maxY - minY) * scale) / 2;
  const toView = ([x, y]: number[]): number[] => [
    (x - minX) * scale + offsetX,
    (y - minY) * scale + offsetY,
  ];

  const pieces: string[] = [];
  for (const { rings } of projected) {
    let drewAny = false;
    let largest: { ring: number[][]; diagonal: number } | null = null;
    for (const ring of rings) {
      const view = ring.map(toView);
      let bMinX = Infinity;
      let bMinY = Infinity;
      let bMaxX = -Infinity;
      let bMaxY = -Infinity;
      for (const [x, y] of view) {
        if (x < bMinX) bMinX = x;
        if (x > bMaxX) bMaxX = x;
        if (y < bMinY) bMinY = y;
        if (y > bMaxY) bMaxY = y;
      }
      const diagonal = Math.hypot(bMaxX - bMinX, bMaxY - bMinY);
      if (!largest || diagonal > largest.diagonal) largest = { ring: view, diagonal };
      if (diagonal < RING_DROP_PX) continue;
      const path = ringToPath(view);
      if (path) {
        pieces.push(path);
        drewAny = true;
      }
    }
    if (!drewAny && largest) {
      // The country's whole footprint is sub-pixel: keep it as a dot so every
      // member still shows up (Singapore, Malta, most of the Caribbean).
      const [cx, cy] = ringCentroidLonLat(largest.ring);
      pieces.push(dotPath(cx, cy));
    }
  }
  if (pieces.length === 0) return null;
  return { viewBox: `0 0 ${VIEW} ${VIEW}`, path: pieces.join("") };
}

async function main(): Promise<void> {
  const [world, isoRows] = await Promise.all([
    fetchCached(WORLD_URL, "countries-50m.json") as Promise<Topology>,
    fetchCached(ISO_URL, "iso-3166-all.json") as Promise<
      Array<{ "alpha-2": string; "country-code": string }>
    >,
  ]);
  const numericToAlpha2 = new Map(
    isoRows.map((row) => [String(Number(row["country-code"])), row["alpha-2"]]),
  );

  const ringsByCountry = countryRings(world, numericToAlpha2);
  // Oceania sits in both tables; its continent entry wins so the picker lists
  // it once, under Continents.
  const continentCodes = new Set(CONTINENTS.map((continent) => continent.code));
  const allDefs: Array<{ def: RegionDef; group: "continent" | "region" }> = [
    ...CONTINENTS.map((def) => ({ def, group: "continent" as const })),
    ...REGIONS.filter((def) => !continentCodes.has(def.code)).map((def) => ({ def, group: "region" as const })),
  ];
  const shapes: Record<string, { viewBox: string; path: string }> = {};
  const missing: string[] = [];
  for (const { def } of allDefs) {
    const shape = buildRegionShape(def.code, def.countries, ringsByCountry);
    if (!shape) {
      missing.push(def.code);
      continue;
    }
    shapes[def.code] = shape;
    process.stdout.write(`${def.code.padEnd(12)} path ${shape.path.length} chars\n`);
  }
  if (missing.length) {
    throw new Error(`no geometry produced for: ${missing.join(", ")}`);
  }

  const banner =
    "// Generated by scripts/generate-region-icons.ts — do not edit by hand.\n" +
    "// Region membership comes from live-backend/src/regions.ts (the source of\n" +
    "// truth); silhouettes from Natural Earth 1:50m geometry.\n" +
    "// Regenerate with: npm run regions:build-icons\n";
  const defs = allDefs.map(({ def, group }) => ({
    code: def.code,
    name: def.name,
    group,
    countries: [...def.countries],
  }));
  const body =
    `${banner}\nexport interface RegionDef {\n  code: string;\n  name: string;\n  group: "continent" | "region";\n  countries: readonly string[];\n}\n\n` +
    `export interface RegionShape {\n  viewBox: string;\n  path: string;\n}\n\n` +
    `export const REGION_DEFS: readonly RegionDef[] = ${JSON.stringify(defs, null, 2)};\n\n` +
    `export const REGION_SHAPES: Record<string, RegionShape> = ${JSON.stringify(shapes, null, 2)};\n`;
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, body);
  process.stdout.write(`wrote ${OUT_FILE}\n`);

  if (PREVIEW_FILE) {
    const cells = allDefs.map(({ def }) => {
      const shape = shapes[def.code];
      const svg = (size: number) =>
        `<svg width="${size}" height="${size}" viewBox="${shape.viewBox}"><path d="${shape.path}" fill="currentColor" fill-rule="evenodd"/></svg>`;
      return `<div class="cell"><div class="icons">${svg(96)}${svg(40)}${svg(20)}</div><div class="label">${def.name}<span>${def.code}</span></div></div>`;
    }).join("\n");
    const html = `<!doctype html><meta charset="utf-8"><title>Region icons</title>
<style>
  body { background: #0b0b10; color: #cdd3e0; font: 13px system-ui; margin: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
  .cell { background: #14141c; border: 1px solid #23232f; border-radius: 12px; padding: 14px; }
  .icons { display: flex; align-items: center; gap: 14px; color: #8b93f8; }
  .label { margin-top: 10px; } .label span { color: #565d6e; margin-left: 8px; }
</style>
<div class="grid">${cells}</div>`;
    writeFileSync(PREVIEW_FILE, html);
    process.stdout.write(`wrote ${PREVIEW_FILE}\n`);
  }
}

await main();
