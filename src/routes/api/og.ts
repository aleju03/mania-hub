import { ImageResponse } from "@vercel/og";
import { createFileRoute } from "@tanstack/react-router";
import { waitUntil } from "@vercel/functions";
import { createElement as h } from "react";
import type { ReactNode } from "react";
import {
  getCachedUser,
  getRankings,
  getScore,
  readCountryMapsFavouritesFromCache,
  readRankingsPageFromCache,
} from "../../lib/osu";
import { getServerLiveBackendUrl } from "../../lib/live-backend";
import { getCountryName, isGlobalScope, isSupportedCountryCode } from "../../lib/country";
import { getAssetOrigin } from "../../lib/origin";
import { getDisplayedRank, getManiaJudgementCounts, getModAcronyms } from "../../lib/score";
import { getCachedOgImage, putOgImage } from "../../lib/r2-cache";
import { OG_IMAGE_VERSION } from "../../lib/seo";
import { computeManiaSkills, getManiaCardTier, MANIA_TIER_STYLES } from "../../lib/maniacard";
import type { OsuCovers, OsuScore } from "../../lib/types";

const WIDTH = 1200;
const HEIGHT = 630;
const MAX_TITLE_LEN = 38;
const FONT_FETCH_TIMEOUT_MS = 10_000;

const fontCache = new Map<string, Promise<ArrayBuffer>>();

function clamp(value: string | null | undefined, max: number): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}...`;
}

function getFont(request: Request, fileName: string): Promise<ArrayBuffer> {
  const url = new URL(`/fonts/${fileName}`, getAssetOrigin(request)).toString();
  const cached = fontCache.get(url);
  if (cached) return cached;

  const promise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FONT_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Failed to load font ${fileName}: ${response.status}`);
      }
      return response.arrayBuffer();
    } finally {
      clearTimeout(timeout);
    }
  })();

  fontCache.set(url, promise);
  promise.catch(() => fontCache.delete(url));
  return promise;
}

const OG_CACHE_HEADER = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";

// Rasterizing an OG card (Satori + resvg) is the most CPU-heavy work on the
// Vercel side, multiple seconds per image. The CDN caches each URL for a day,
// but every miss/revalidation re-renders from scratch. We back that with an R2
// cache keyed by the card identity and server-owned OG version so a miss becomes
// a fast object read. Request query params must not expand R2 key cardinality.

function ogImageResponse(buffer: Buffer): Response {
  return new Response(buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(buffer.length),
      "Cache-Control": OG_CACHE_HEADER,
    },
  });
}

function scheduleOgStore(cacheKey: string, buffer: Buffer): void {
  const store = putOgImage(cacheKey, buffer);
  try {
    waitUntil(store);
  } catch {
    // Not in a Vercel function context (e.g. local dev). putOgImage swallows
    // its own errors, so letting it run detached is safe.
    void store;
  }
}

async function serveOg(cacheKey: string, render: () => Promise<Response>): Promise<Response> {
  const cached = await getCachedOgImage(cacheKey);
  if (cached) return ogImageResponse(cached);

  const response = await render();
  if (!response.ok) return response;

  const buffer = Buffer.from(await response.arrayBuffer());
  scheduleOgStore(cacheKey, buffer);
  return ogImageResponse(buffer);
}

class OgFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OgFallbackError";
  }
}

function isOgFallbackError(error: unknown): error is OgFallbackError {
  return error instanceof OgFallbackError;
}

async function loadOgFonts(request: Request): Promise<[ArrayBuffer, ArrayBuffer]> {
  return Promise.all([
    getFont(request, "Torus-Regular.otf"),
    getFont(request, "Torus-Heavy.otf"),
  ]);
}

function ogFontList(regularFont: ArrayBuffer, heavyFont: ArrayBuffer) {
  return [
    { name: "Torus OG" as const, data: regularFont, style: "normal" as const, weight: 400 as const },
    { name: "Torus OG" as const, data: heavyFont, style: "normal" as const, weight: 900 as const },
  ];
}

function formatOgInt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return Math.round(value).toLocaleString("en-US");
}

function formatOgAcc(accuracy: number | null | undefined): string {
  if (accuracy == null || !Number.isFinite(accuracy)) return "--";
  // osu! API returns accuracy as 0-1 float for lazer scores and 0-100 for
  // legacy, but the LeanRankingEntry ships it 0-1. OsuScore ships 0-1. Scale
  // to percent.
  const pct = accuracy <= 1 ? accuracy * 100 : accuracy;
  return `${pct.toFixed(2)}%`;
}

// Mirrors src/components/ui/GradeImg.tsx so the OG and the in-app pages
// show identical grade artwork. Returns an absolute URL because Satori
// fetches assets via fetch() and won't resolve relative paths.
const GRADE_FILE: Record<string, string> = {
  XH: "GradeSmall-SS-Silver",
  X: "GradeSmall-SS",
  SH: "GradeSmall-S-Silver",
  S: "GradeSmall-S",
  A: "GradeSmall-A",
  B: "GradeSmall-B",
  C: "GradeSmall-C",
  D: "GradeSmall-D",
  SS: "GradeSmall-SS",
  SSH: "GradeSmall-SS-Silver",
  F: "GradeSmall-F",
};

function gradeImgUrl(request: Request, rank: string): string {
  const file = GRADE_FILE[rank] ?? `GradeSmall-${rank}`;
  return new URL(`/images/badges/score-ranks-v2019/${file}.svg`, getAssetOrigin(request)).toString();
}

// Judgement palette mirrors styles.css osu-* tokens. Used for the
// MAX/300/200/100/50/Miss chips on the replay OG.
const JUDGEMENT_COLORS: Record<string, string> = {
  MAX: "#ffcc22",
  "300": "#66ccff",
  "200": "#b3d944",
  "100": "#88b300",
  "50": "#ff8e5d",
  Miss: "#ed7887",
};

function pickBeatmapsetCover(score: OsuScore): string | null {
  const covers = score.beatmapset?.covers;
  if (!covers) return null;
  return covers["cover@2x"] || covers.cover || covers["card@2x"] || covers.card || null;
}

function beatmapDisplayTitle(score: OsuScore): string {
  const set = score.beatmapset;
  if (!set) return "Unknown beatmap";
  return `${set.artist} - ${set.title}`;
}

function scoreAwardsRankedPp(score: OsuScore): boolean {
  if (score.pp == null || !Number.isFinite(score.pp)) return false;
  if (score.ranked === false) return false;

  const status = score.beatmapset?.status?.toLowerCase();
  return !status || status === "ranked" || status === "approved";
}

// Higher-res raster flags than osu!'s 70×47 PNG. flagcdn.com serves
// width-keyed PNGs (`w640/<lower>.png`) so our polaroid card stays
// crisp at 320px+ render sizes instead of getting blurry.
function flagImageUrl(country: string): string {
  return `https://flagcdn.com/w640/${country.toLowerCase()}.png`;
}

/* Maps: full-bleed mosaic of beatmapset covers pulled from the country's
   favourites pool. The pool is country-seeded so the same OG renders
   stable across requests until the underlying data rebuilds. If we
   have no maps data for the country, fall through to the country
   scoreboard layout.

   The mosaic needs ~18 cover URLs and a pool count, nothing else, and
   both sources below are plain DB reads. The OG route must never
   trigger osu! API work: a cold favourites rebuild is 50 users of
   rate-limited calls, which used to stall this endpoint for minutes. */
const MAPS_MOSAIC_COLS = 6;
const MAPS_MOSAIC_ROWS = 3;
const MAPS_MOSAIC_COUNT = MAPS_MOSAIC_COLS * MAPS_MOSAIC_ROWS;

// Deterministic small-state PRNG. Seeded by country code so mosaics are
// stable per-country until the source data rebuilds.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

type MapsOgPool = { covers: string[]; poolSize: number };

const MAPS_OG_LIVE_FETCH_TIMEOUT_MS = 8_000;

// Primary source: the server's stored maps snapshot. One paged read of
// a maps tab gives covers + total; the backend keeps these fresh on its own
// refresh schedule for every tracked country. The maps OG reads favourites;
// the farm helper OG reads farmed.
async function fetchMapsOgPoolFromLiveBackend(
  country: string,
  tab: "favourites" | "farmed" = "favourites",
): Promise<MapsOgPool | null> {
  const base = getServerLiveBackendUrl();
  if (!base) return null;
  const query = new URLSearchParams({
    country,
    tab,
    pageSize: String(MAPS_MOSAIC_COUNT * 2),
    // Read-only: don't activate/warm a country just because its OG rendered.
    observe: "1",
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAPS_OG_LIVE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/api/snapshots/maps-page?${query.toString()}`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const snapshot = (await response.json()) as {
      value: { total: number; items: Array<{ covers?: OsuCovers }> } | null;
    };
    const items = snapshot.value?.items ?? [];
    const covers = items
      .map((item) => (item.covers ? pickCover(item.covers) : null))
      .filter((cover): cover is string => !!cover);
    if (covers.length === 0) return null;
    return { covers, poolSize: snapshot.value?.total ?? covers.length };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Turso fallback (server unconfigured/down or country untracked there):
// recover the last roster we cached for this country, then look up the
// favourites blob stored under that exact roster key. Both reads allow stale
// entries and never rebuild.
async function fetchMapsOgPoolFromTurso(country: string): Promise<MapsOgPool | null> {
  const rankings = await readRankingsPageFromCache("performance", 1, country);
  if (!rankings) return null;
  const users = rankings.ranking
    .filter((entry) => entry.user.is_active !== false)
    .slice(0, 50)
    .map((entry) => ({
      id: entry.user.id,
      username: entry.user.username,
      avatar_url: entry.user.avatar_url,
    }));
  if (users.length === 0) return null;
  const favSection = await readCountryMapsFavouritesFromCache(users);
  const pool = favSection?.beatmapsetsPool;
  const sets = pool ? Object.values(pool) : [];
  const covers = sets
    .map((set) => pickCover(set.covers))
    .filter((cover): cover is string => !!cover);
  if (covers.length === 0) return null;
  return { covers, poolSize: sets.length };
}

async function renderMapsOg(request: Request, country: string): Promise<Response> {
  const pool =
    (await fetchMapsOgPoolFromLiveBackend(country)) ??
    (await fetchMapsOgPoolFromTurso(country));
  if (!pool) {
    // No maps data for this country: fall through to the scoreboard layout
    // without storing that fallback under the maps-specific R2 key.
    throw new OgFallbackError(`no maps data for ${country}`);
  }

  const rng = mulberry32(hashString(country));
  const picked = shuffle(pool.covers, rng).slice(0, MAPS_MOSAIC_COUNT);
  // If the pool is smaller than the grid, repeat (still shuffled) so we
  // always fill the canvas instead of leaving blank cells.
  while (picked.length < MAPS_MOSAIC_COUNT && pool.covers.length > 0) {
    picked.push(...shuffle(pool.covers, rng).slice(0, MAPS_MOSAIC_COUNT - picked.length));
  }

  const [regularFont, heavyFont] = await loadOgFonts(request);

  const countryName = getCountryName(country) || country;
  const flagUrl = `https://osu.ppy.sh/images/flags/${country}.png`;

  const response = new ImageResponse(
    h(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          position: "relative",
          overflow: "hidden",
          background: "#0b070a",
          fontFamily: '"Torus OG"',
          color: "#ffffff",
        },
      },
      [
        // Mosaic grid: explicit pixel dims so Satori's flex impl
        // doesn't collapse the rows/cells.
        h(
          "div",
          {
            key: "grid",
            style: {
              position: "absolute",
              inset: "0",
              display: "flex",
              flexDirection: "column",
              width: `${WIDTH}px`,
              height: `${HEIGHT}px`,
            },
          },
          Array.from({ length: MAPS_MOSAIC_ROWS }, (_, r) =>
            h(
              "div",
              {
                key: `row-${r}`,
                style: {
                  display: "flex",
                  flexDirection: "row",
                  width: `${WIDTH}px`,
                  height: `${HEIGHT / MAPS_MOSAIC_ROWS}px`,
                },
              },
              Array.from({ length: MAPS_MOSAIC_COLS }, (_, c) => {
                const cover = picked[r * MAPS_MOSAIC_COLS + c] ?? null;
                return h(
                  "div",
                  {
                    key: `cell-${r}-${c}`,
                    style: {
                      display: "flex",
                      width: `${WIDTH / MAPS_MOSAIC_COLS}px`,
                      height: `${HEIGHT / MAPS_MOSAIC_ROWS}px`,
                      overflow: "hidden",
                      background: "#1a1317",
                    },
                  },
                  cover
                    ? h("img", {
                        src: cover,
                        style: {
                          width: `${WIDTH / MAPS_MOSAIC_COLS}px`,
                          height: `${HEIGHT / MAPS_MOSAIC_ROWS}px`,
                          objectFit: "cover",
                        },
                      })
                    : null,
                );
              }),
            ),
          ),
        ),

        // Bottom gradient overlay carrying the title, flag, and brand.
        h(
          "div",
          {
            key: "overlay",
            style: {
              position: "absolute",
              left: "0",
              right: "0",
              bottom: "0",
              display: "flex",
              flexDirection: "column",
              padding: "120px 60px 40px",
              background:
                "linear-gradient(180deg, rgba(11,7,10,0) 0%, rgba(11,7,10,0.65) 50%, rgba(11,7,10,0.95) 100%)",
            },
          },
          [
            h(
              "div",
              {
                key: "title-row",
                style: {
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: "18px",
                },
              },
              [
                h("img", {
                  key: "flag",
                  src: flagUrl,
                  style: {
                    width: "56px",
                    height: "38px",
                    borderRadius: "4px",
                    objectFit: "cover",
                    border: "1px solid rgba(255,255,255,0.15)",
                  },
                }),
                h(
                  "div",
                  {
                    key: "title",
                    style: {
                      fontSize: "54px",
                      fontWeight: 900,
                      lineHeight: "1.0",
                    },
                  },
                  `${countryName}'s mania maps`,
                ),
              ],
            ),
            h(
              "div",
              {
                key: "sub",
                style: {
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: "12px",
                  marginTop: "10px",
                  fontSize: "20px",
                  color: "#c7b8c1",
                },
              },
              [
                h(
                  "div",
                  { key: "pool" },
                  `${pool.poolSize} community-picked mania maps`,
                ),
                h("div", { key: "dot", style: { color: "#5a4a52" } }, "/"),
                h(
                  "div",
                  { key: "brand", style: { color: "#7a6b74", letterSpacing: "0.06em" } },
                  "Mania Tracker",
                ),
              ],
            ),
          ],
        ),
      ],
    ),
    { width: WIDTH, height: HEIGHT, fonts: ogFontList(regularFont, heavyFont) },
  );
  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

function pickCover(covers: OsuCovers): string | null {
  return covers["cover@2x"] || covers.cover || covers["card@2x"] || covers.card || null;
}

// Single thin bar split into proportional colored segments — one per
// judgement bucket. Wide MAX = clean play; a sliver of red = a miss.
// Tiny labels under each segment carry the actual count. Skipped when
// total = 0 (e.g. unsupported score statistics).
function judgementCompositionBar(judgements: Array<{ label: string; value: number }>) {
  const total = judgements.reduce((s, j) => s + j.value, 0);
  if (total === 0) return null;
  const visible = judgements.filter((j) => j.value > 0);

  return h(
    "div",
    {
      key: "comp",
      style: {
        display: "flex",
        flexDirection: "column",
        marginTop: "10px",
      },
    },
    [
      h(
        "div",
        {
          key: "bar",
          style: {
            display: "flex",
            flexDirection: "row",
            width: "100%",
            height: "14px",
            borderRadius: "7px",
            overflow: "hidden",
            background: "rgba(0,0,0,0.4)",
          },
        },
        visible.map((j, i) =>
          h("div", {
            key: `seg-${j.label}`,
            style: {
              display: "flex",
              flexGrow: j.value,
              flexShrink: 0,
              flexBasis: "0",
              background: JUDGEMENT_COLORS[j.label] ?? "#c7b8c1",
              // Keep a hairline gap between segments so colors don't bleed
              // into each other when adjacent values differ wildly.
              marginLeft: i === 0 ? "0" : "1px",
            },
          }),
        ),
      ),
      h(
        "div",
        {
          key: "labels",
          style: {
            display: "flex",
            flexDirection: "row",
            marginTop: "8px",
            fontSize: "15px",
            color: "#c7b8c1",
            gap: "18px",
          },
        },
        judgements.map((j) =>
          h(
            "div",
            {
              key: `lbl-${j.label}`,
              style: {
                display: "flex",
                flexDirection: "row",
                alignItems: "baseline",
                gap: "6px",
              },
            },
            [
              h(
                "div",
                {
                  key: "v",
                  style: {
                    fontWeight: 900,
                    color: JUDGEMENT_COLORS[j.label] ?? "#ffffff",
                  },
                },
                formatOgInt(j.value),
              ),
              h(
                "div",
                {
                  key: "l",
                  style: {
                    color: "#7a6b74",
                    letterSpacing: "0.08em",
                    fontSize: "12px",
                  },
                },
                j.label,
              ),
            ],
          ),
        ),
      ),
    ],
  );
}

/* Replay: score result card. Layout split into vertical bands so
   Satori can't get confused by mixing position:absolute children with
   flex layout (a previous version had an offset bug from that). Top:
   big REPLAY eyebrow. Middle: grade SVG + username + beatmap title +
   diff. Then a thin segmented composition bar visualising the judgement
   distribution, then pp / acc / mods / combo. */
async function renderReplayOg(request: Request, scoreId: number): Promise<Response> {
  const [regularFont, heavyFont, score] = await Promise.all([
    getFont(request, "Torus-Regular.otf"),
    getFont(request, "Torus-Heavy.otf"),
    getScore({ data: { scoreId } }),
  ]);

  const cover = pickBeatmapsetCover(score);
  const modsLabel = getModAcronyms(score.mods).join(" · ");
  const displayedRank = getDisplayedRank(score);
  const judgements = getManiaJudgementCounts(score.statistics);
  const keys = score.beatmap?.cs ? `${Math.round(score.beatmap.cs)}K` : "";
  const versionLine = `[${score.beatmap?.version ?? "?"}]${keys ? `  ${keys}` : ""}`;
  const maxCombo = score.max_combo ?? score.beatmap?.max_combo ?? null;
  const showPp = scoreAwardsRankedPp(score);

  const response = new ImageResponse(
    h(
      "div",
      {
        // Outer canvas: plain block, no flex, no padding. Background art and
        // content stack via absolute positioning so layout glitches like
        // "content offset by parent flex" can't happen.
        style: {
          width: `${WIDTH}px`,
          height: `${HEIGHT}px`,
          display: "flex",
          position: "relative",
          overflow: "hidden",
          background: "linear-gradient(135deg, #140f12 0%, #2a1a26 100%)",
          fontFamily: '"Torus OG"',
          color: "#ffffff",
        },
      },
      [
        cover
          ? h("img", {
              key: "cover",
              src: cover,
              style: {
                position: "absolute",
                top: 0,
                left: 0,
                width: `${WIDTH}px`,
                height: `${HEIGHT}px`,
                objectFit: "cover",
                objectPosition: "center center",
                opacity: 0.44,
              },
            })
          : null,
        h("div", {
          key: "dim",
          style: {
            position: "absolute",
            top: 0,
            left: 0,
            width: `${WIDTH}px`,
            height: `${HEIGHT}px`,
            background:
              "linear-gradient(180deg, rgba(15,10,13,0.36) 0%, rgba(15,10,13,0.68) 58%, rgba(15,10,13,0.94) 100%)",
          },
        }),
        h("div", {
          key: "side-vignette",
          style: {
            position: "absolute",
            top: 0,
            left: 0,
            width: `${WIDTH}px`,
            height: `${HEIGHT}px`,
            background:
              "linear-gradient(90deg, rgba(9,5,8,0.82) 0%, rgba(9,5,8,0.36) 34%, rgba(9,5,8,0.30) 66%, rgba(9,5,8,0.78) 100%)",
          },
        }),

        // Content layer: a single absolutely-positioned flex column that
        // owns its own padding. Decoupled from the bg layer entirely.
        h(
          "div",
          {
            key: "content",
            style: {
              position: "absolute",
              top: 0,
              left: 0,
              width: `${WIDTH}px`,
              height: `${HEIGHT}px`,
              display: "flex",
              flexDirection: "column",
              padding: "42px 64px 52px",
            },
          },
          [
            // Top band: REPLAY eyebrow.
            h(
              "div",
              {
                key: "top",
                style: {
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                },
              },
              [
                h(
                  "div",
                  {
                    key: "eyebrow",
                    style: {
                      fontSize: "44px",
                      color: "#ff99cc",
                      letterSpacing: "0.16em",
                      fontWeight: 900,
                      lineHeight: "1.0",
                    },
                  },
                  "REPLAY",
                ),
              ],
            ),

            // Middle band: real grade SVG + player + beatmap.
            h(
              "div",
              {
                key: "hero",
                style: {
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: "36px",
                  flex: "1",
                  marginTop: "6px",
                },
              },
              [
                h("img", {
                  key: "grade",
                  src: gradeImgUrl(request, displayedRank),
                  // The SVG has a 32x16 aspect ratio. Render it at 2x scale
                  // so the result feels weighty next to the 56px username.
                  style: {
                    width: "200px",
                    height: "100px",
                    flexShrink: 0,
                  },
                }),
                h(
                  "div",
                  {
                    key: "info",
                    style: {
                      display: "flex",
                      flexDirection: "column",
                      gap: "10px",
                      flex: "1",
                      minWidth: "0",
                    },
                  },
                  [
                    h(
                      "div",
                      {
                        key: "name",
                        style: {
                          fontSize: "56px",
                          fontWeight: 900,
                          lineHeight: "1.0",
                        },
                      },
                      score.user.username,
                    ),
                    h(
                      "div",
                      {
                        key: "song",
                        style: {
                          fontSize: "26px",
                          color: "#e8e3ec",
                          lineHeight: "1.2",
                          overflow: "hidden",
                        },
                      },
                      clamp(beatmapDisplayTitle(score), 60),
                    ),
                    h(
                      "div",
                      {
                        key: "diff",
                        style: {
                          fontSize: "20px",
                          color: "#c7b8c1",
                        },
                      },
                      versionLine,
                    ),
                  ],
                ),
              ],
            ),

            // Score-composition bar: thin segmented strip where each
            // segment's width is proportional to its judgement count.
            // Reads as a visual fingerprint of the score: a wide MAX
            // segment = clean play, visible miss segment = heartbreak.
            judgementCompositionBar(judgements),

            // Bottom band: pp / acc / mods / combo.
            h(
              "div",
              {
                key: "stats",
                style: {
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "baseline",
                  gap: "30px",
                  marginTop: "22px",
                },
              },
              [
                showPp
                  ? h(
                      "div",
                      {
                        key: "pp",
                        style: { fontSize: "68px", fontWeight: 900, color: "#ff66aa", lineHeight: "1" },
                      },
                      `${formatOgInt(score.pp)}pp`,
                    )
                  : null,
                h(
                  "div",
                  {
                    key: "acc",
                    style: { fontSize: "26px", color: "#e8e3ec" },
                  },
                  formatOgAcc(score.accuracy),
                ),
                maxCombo != null
                  ? h(
                      "div",
                      {
                        key: "combo",
                        style: { fontSize: "22px", color: "#c7b8c1" },
                      },
                      `${formatOgInt(maxCombo)}x`,
                    )
                  : null,
                modsLabel
                  ? h(
                      "div",
                      {
                        key: "mods",
                        style: {
                          fontSize: "22px",
                          color: "#ff99cc",
                          fontWeight: 900,
                          letterSpacing: "0.08em",
                          marginLeft: "auto",
                        },
                      },
                      `+ ${modsLabel}`,
                    )
                  : null,
              ],
            ),
          ],
        ),
      ],
    ),
    { width: WIDTH, height: HEIGHT, fonts: ogFontList(regularFont, heavyFont) },
  );
  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

/* Player card layout: cover-art ambient background, a big rounded-square
   avatar (osu! site style, not a circle), and a stat stack on the right
   with flag + country, username, global/country rank, PP, acc. */
async function renderPlayerOg(request: Request, rawUsername: string): Promise<Response> {
  const username = rawUsername.trim().slice(0, 64);
  const [regularFont, heavyFont, user] = await Promise.all([
    getFont(request, "Torus-Regular.otf"),
    getFont(request, "Torus-Heavy.otf"),
    getCachedUser(username),
  ]);

  const stats = user.statistics;
  const country = user.country?.name || getCountryName(user.country_code) || user.country_code;
  const cover = user.cover?.custom_url || user.cover?.url || user.cover_url || null;
  const flagUrl = `https://osu.ppy.sh/images/flags/${user.country_code}.png`;
  const globalRank = stats.global_rank;
  const countryRank = stats.country_rank;

  const response = new ImageResponse(
    h(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          overflow: "hidden",
          background: "linear-gradient(135deg, #140f12 0%, #2a1a26 100%)",
          fontFamily: '"Torus OG"',
          color: "#ffffff",
        },
      },
      [
        cover
          ? h("img", {
              key: "cover",
              src: cover,
              style: {
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
                opacity: 0.22,
              },
            })
          : null,
        // Side-to-side dim overlay so the cover stays ambient but text wins.
        h("div", {
          key: "dim",
          style: {
            position: "absolute",
            inset: "0",
            background:
              "linear-gradient(90deg, rgba(15,10,13,0.92) 0%, rgba(15,10,13,0.65) 55%, rgba(15,10,13,0.88) 100%)",
          },
        }),
        // Pink accent anchored behind the avatar.
        h("div", {
          key: "glow",
          style: {
            position: "absolute",
            inset: "0",
            background:
              "radial-gradient(circle at 22% 52%, rgba(255, 102, 170, 0.22) 0%, rgba(255, 102, 170, 0) 48%)",
          },
        }),

        h(
          "div",
          {
            key: "content",
            style: {
              position: "relative",
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: "56px",
              width: "100%",
              height: "100%",
              padding: "60px 64px",
            },
          },
          [
            // Avatar: rounded-rect, pink border + soft shadow to match the
            // in-app avatar treatment. Uses <img> so Satori rasterizes the
            // remote CDN asset.
            h(
              "div",
              {
                key: "avatar",
                style: {
                  width: "320px",
                  height: "320px",
                  flexShrink: 0,
                  borderRadius: "44px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "4px solid #ff66aa",
                  boxSizing: "border-box",
                  boxShadow: "0 0 48px rgba(255, 102, 170, 0.35)",
                  background: "#1a1317",
                },
              },
              h("img", {
                src: user.avatar_url,
                style: {
                  width: "312px",
                  height: "312px",
                  borderRadius: "40px",
                  objectFit: "cover",
                },
              }),
            ),

            // Right-side stat stack.
            h(
              "div",
              {
                key: "stats",
                style: {
                  display: "flex",
                  flexDirection: "column",
                  flex: "1",
                  minWidth: "0",
                },
              },
              [
                // Flag + country.
                h(
                  "div",
                  {
                    key: "country",
                    style: {
                      display: "flex",
                      flexDirection: "row",
                      alignItems: "center",
                      gap: "14px",
                      color: "#c7b8c1",
                      fontSize: "26px",
                      marginBottom: "16px",
                    },
                  },
                  [
                    h("img", {
                      key: "flag",
                      src: flagUrl,
                      style: {
                        width: "40px",
                        height: "27px",
                        borderRadius: "3px",
                        objectFit: "cover",
                      },
                    }),
                    h("div", { key: "cname" }, country),
                  ],
                ),

                // Username - big and proudly Torus Heavy.
                h(
                  "div",
                  {
                    key: "name",
                    style: {
                      fontSize: "92px",
                      fontWeight: 900,
                      lineHeight: "1.0",
                      marginBottom: "28px",
                      maxWidth: "620px",
                      overflow: "hidden",
                    },
                  },
                  user.username,
                ),

                // Rank row.
                h(
                  "div",
                  {
                    key: "ranks",
                    style: {
                      display: "flex",
                      flexDirection: "row",
                      alignItems: "baseline",
                      gap: "18px",
                      fontSize: "30px",
                      color: "#e8e3ec",
                      marginBottom: "30px",
                    },
                  },
                  [
                    h(
                      "div",
                      { key: "g" },
                      globalRank != null ? `#${formatOgInt(globalRank)} global` : "unranked",
                    ),
                    countryRank != null
                      ? h(
                          "div",
                          {
                            key: "sep",
                            style: { color: "#5a4a52" },
                          },
                          "/",
                        )
                      : null,
                    countryRank != null
                      ? h(
                          "div",
                          {
                            key: "c",
                            style: { color: "#ff99cc" },
                          },
                          `#${formatOgInt(countryRank)} ${user.country_code}`,
                        )
                      : null,
                  ],
                ),

                // PP + accuracy + playcount.
                h(
                  "div",
                  {
                    key: "nums",
                    style: {
                      display: "flex",
                      flexDirection: "row",
                      alignItems: "baseline",
                      gap: "28px",
                    },
                  },
                  [
                    h(
                      "div",
                      {
                        key: "pp",
                        style: {
                          fontSize: "68px",
                          fontWeight: 900,
                          color: "#ff66aa",
                          lineHeight: "1",
                        },
                      },
                      `${formatOgInt(stats.pp)}pp`,
                    ),
                    h(
                      "div",
                      {
                        key: "acc",
                        style: {
                          fontSize: "28px",
                          color: "#c7b8c1",
                        },
                      },
                      `${stats.hit_accuracy.toFixed(2)}% acc`,
                    ),
                    h(
                      "div",
                      {
                        key: "plays",
                        style: {
                          fontSize: "28px",
                          color: "#7a6b74",
                        },
                      },
                      `${formatOgInt(stats.play_count)} plays`,
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
      ],
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      fonts: ogFontList(regularFont, heavyFont),
    },
  );

  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

// ---------------------------------------------------------------------------
// Maniacard: a player's skill-tier card, rendered flat for social sharing and
// for the Discord /maniacard command. Reuses the same skill engine and tier
// palette as the in-app 3D card so the numbers and colours match exactly.
// ---------------------------------------------------------------------------

interface ManiacardSnapshot {
  user: {
    id?: number;
    username?: string;
    avatar_url?: string;
    country_code?: string;
    statistics?: { global_rank?: number | null; pp?: number | null } | null;
  };
  bestScores?: OsuScore[];
}

async function fetchManiacardSnapshot(base: string, key: string): Promise<ManiacardSnapshot | null> {
  const response = await fetch(`${base}/api/profiles/${encodeURIComponent(key)}/snapshot`);
  if (response.status === 404) return null;
  if (!response.ok) throw new OgFallbackError(`maniacard snapshot ${response.status}`);
  return (await response.json()) as ManiacardSnapshot;
}

const MANIA_GLYPH_D =
  "M500 48q-21 0-35 15t-15 35v504q0 21 15 36t35 14 36-14 14-36v-504q0-21-14-35t-36-15z m-110 192v220q0 21-14 36t-36 14-35-14-15-36v-220q0-21 15-35t35-15 36 15 14 35z m320 0v220q0 21-14 36t-36 14-35-14-15-36v-220q0-21 15-35t35-15 36 15 14 35z m-210 500q-106 0-197-53-88-52-140-140-53-91-53-197t53-197q52-88 140-140 91-53 197-53t197 53q88 52 140 140 53 91 53 197t-53 197q-52 88-140 140-91 53-197 53z m0 80q97 0 182-36t150-102q64-62 101-148t37-184-36-182-102-150q-62-64-148-101t-184-37-182 36-150 102q-64 62-101 149t-37 183 37 182 101 150q62 64 149 101t183 37v0z";

// The mania glyph is authored y-up (the in-app canvas flips it), so flip it for
// svg's y-down space. Inlined as a data url since Satori rasterizes svg images.
function maniaGlyphDataUrl(): string {
  // Baseline sits at 0.86 of the glyph height (matches the in-app card); pad the
  // viewBox so the flipped glyph is centred and never clips.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-40 -40 1080 1080"><g transform="matrix(1,0,0,-1,0,860)"><path d="${MANIA_GLYPH_D}" fill="#ffffff"/></g></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function starDataUrl(fill: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 4 L62 38 L98 38 L69 60 L80 96 L50 74 L20 96 L31 60 L2 38 L38 38 Z" fill="${fill}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// Floating osu-style triangles: a jittered grid so positions never line up,
// varied sizes, up or down but never tilted, overlapping into soft facets.
// Baked as explicit paths so resvg rasterizes it reliably as an img.
function triangleOverlayDataUrl(w: number, height: number): string {
  const sx = w / 1000;
  const sy = height / 1400;
  const rand = (n: number) => {
    const v = Math.sin(n) * 43758.5453123;
    return v - Math.floor(v);
  };
  const poly = (pts: Array<[number, number]>, fill: string) =>
    `<path d="${pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")} Z" fill="${fill}"/>`;
  let paths = "";
  for (let row = 0; row < 6; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const i = row * 11 + col;
      if (rand(i * 19.17 + 4.2) < 0.4) continue;
      const cx = (col * 200 + 100 + (rand(i * 43.91 + 8.5) - 0.5) * 130) * sx;
      const cy = (row * 233 + 117 + (rand(i * 29.37 + 12.4) - 0.5) * 130) * sy;
      const side = (230 + rand(i * 13.81 + 2.7) * 300) * sx;
      const hgt = side * 0.866;
      const up = rand(i * 7.3 + 3.1) > 0.5;
      const pts: Array<[number, number]> = up
        ? [[cx, cy - (hgt * 2) / 3], [cx + side / 2, cy + hgt / 3], [cx - side / 2, cy + hgt / 3]]
        : [[cx, cy + (hgt * 2) / 3], [cx + side / 2, cy - hgt / 3], [cx - side / 2, cy - hgt / 3]];
      // Fewer, larger, low-contrast facets (subtle like the reference). Dark
      // ones stay extra faint since dark-on-light reads strongly; ~50/50
      // light/dark so the pale top and dark bottom each show some.
      const dark = rand(i * 3.11 + 6.9) > 0.5;
      const a = dark ? 0.035 + rand(i * 5.21 + 1.3) * 0.04 : 0.05 + rand(i * 5.21 + 1.3) * 0.06;
      paths += poly(pts, dark ? `rgba(0,0,0,${a.toFixed(3)})` : `rgba(255,255,255,${a.toFixed(3)})`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}">${paths}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// Portrait trading card matching the in-app maniacard front: the tier gradient
// is the body (that colour IS the tier's identity, not decoration), with the
// mania glyph badge, username plate, tier label, big avatar, the three skill
// values as plain stats and the star-rating row.
async function renderManiacardOg(request: Request, rawUsername: string): Promise<Response> {
  const username = rawUsername.trim().slice(0, 64);
  const base = getServerLiveBackendUrl();
  if (!base) throw new OgFallbackError("live backend not configured");

  const [[regularFont, heavyFont], snapshot] = await Promise.all([
    loadOgFonts(request),
    fetchManiacardSnapshot(base, username),
  ]);
  if (!snapshot?.user) throw new OgFallbackError(`no profile for ${username}`);

  const user = snapshot.user;
  const scores = snapshot.bestScores ?? [];
  const skills = computeManiaSkills(
    scores.map((score) => ({ ...score, statistics: score.statistics ?? {} })),
    { globalPp: user.statistics?.pp },
  );
  if (!skills) throw new OgFallbackError(`no card for ${username}`);

  const tier = getManiaCardTier(skills.cardPower);
  const style = MANIA_TIER_STYLES[tier];
  const avatarUrl = user.avatar_url || (user.id ? `https://a.ppy.sh/${user.id}` : "");

  const statRows: Array<[string, number]> = [
    ["Control", skills.fingerControl],
    ["Speed", skills.speed],
    ["Precision", skills.accuracy],
  ];
  // Same star logic as the in-app card: ceil(starAvg) segments, full/half/empty.
  const segCount = Math.min(10, Math.max(1, Math.ceil(skills.starAvg)));
  const starUrls = Array.from({ length: segCount }, (_, i) => {
    const remaining = skills.starAvg - i;
    const fill = remaining >= 1 ? "#fcd34d" : remaining >= 0.5 ? "rgba(252,211,77,0.55)" : "rgba(252,211,77,0.22)";
    return starDataUrl(fill);
  });

  const CARD_W = 720;
  const CARD_H = 1008;
  const textShadow = "0 2px 5px rgba(0,0,0,0.55)";

  const response = new ImageResponse(
    h(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          position: "relative",
          display: "flex",
          overflow: "hidden",
          background: style.badgeGradient,
          fontFamily: '"Torus OG"',
          color: "#ffffff",
        },
      },
      [
        // osu triangle texture over the tier gradient.
        h("img", {
          key: "tris",
          src: triangleOverlayDataUrl(CARD_W, CARD_H),
          style: { position: "absolute", top: "0", left: "0", width: "100%", height: "100%" },
        }),
        // Mode badge (top-left).
        h(
          "div",
          {
            key: "badge",
            style: {
              position: "absolute",
              left: "28px",
              top: "28px",
              width: "96px",
              height: "96px",
              borderRadius: "22px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(0,0,0,0.20)",
              border: "2px solid rgba(255,255,255,0.34)",
              boxShadow: `0 0 28px ${style.glowColor}`,
            },
          },
          h("img", { src: maniaGlyphDataUrl(), style: { width: "66px", height: "66px" } }),
        ),
        // Username plate (top-center).
        h(
          "div",
          {
            key: "plate",
            style: {
              position: "absolute",
              left: "176px",
              top: "54px",
              width: "458px",
              height: "76px",
              borderRadius: "18px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(0,0,0,0.34)",
              overflow: "hidden",
            },
          },
          h(
            "div",
            { style: { fontSize: "40px", fontWeight: 900, color: "#ffffff", textShadow, whiteSpace: "nowrap" } },
            user.username || "Unknown",
          ),
        ),
        // Tier label (right).
        h(
          "div",
          {
            key: "tier",
            style: {
              position: "absolute",
              right: "34px",
              top: "152px",
              display: "flex",
              fontSize: "42px",
              fontWeight: 900,
              color: "#ffffff",
              textShadow: `0 0 22px ${style.glowColor}, 0 2px 5px rgba(0,0,0,0.6)`,
            },
          },
          style.label,
        ),
        // Avatar.
        h(
          "div",
          {
            key: "avatar",
            style: {
              position: "absolute",
              left: "133px",
              top: "202px",
              width: "454px",
              height: "454px",
              borderRadius: "26px",
              display: "flex",
              border: "6px solid rgba(255,255,255,0.18)",
              boxSizing: "border-box",
              overflow: "hidden",
            },
          },
          h("img", { src: avatarUrl, style: { width: "100%", height: "100%", objectFit: "cover" } }),
        ),
        // Stats box.
        h(
          "div",
          {
            key: "stats",
            style: {
              position: "absolute",
              left: "148px",
              top: "678px",
              width: "424px",
              height: "180px",
              borderRadius: "24px",
              background: "rgba(0,0,0,0.32)",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              padding: "0 38px",
            },
          },
          statRows.map(([label, value], i) =>
            h(
              "div",
              {
                key: `stat-${i}`,
                style: {
                  display: "flex",
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  marginBottom: i < statRows.length - 1 ? "10px" : "0",
                },
              },
              [
                h("div", { key: "l", style: { fontSize: "30px", fontWeight: 700, color: "rgba(255,255,255,0.85)", textShadow } }, label),
                h("div", { key: "v", style: { fontSize: "40px", fontWeight: 900, color: "#ffffff", textShadow } }, formatOgInt(value)),
              ],
            ),
          ),
        ),
        // Star rating row.
        h(
          "div",
          {
            key: "starwrap",
            style: {
              position: "absolute",
              left: "0",
              bottom: "46px",
              width: `${CARD_W}px`,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            },
          },
          [
            h(
              "div",
              { key: "stars", style: { display: "flex", flexDirection: "row" } },
              starUrls.map((src, i) =>
                h("img", { key: `s-${i}`, src, style: { width: "46px", height: "46px", marginLeft: i ? "6px" : "0" } }),
              ),
            ),
            h(
              "div",
              { key: "avg", style: { display: "flex", flexDirection: "row", alignItems: "center", marginTop: "10px" } },
              [
                h("img", { key: "as", src: starDataUrl("#fcd34d"), style: { width: "24px", height: "24px", marginRight: "8px" } }),
                h("div", { key: "an", style: { fontSize: "28px", fontWeight: 900, color: "rgba(255,255,255,0.82)", textShadow } }, skills.starAvg.toFixed(2)),
              ],
            ),
          ],
        ),
      ],
    ),
    {
      width: CARD_W,
      height: CARD_H,
      fonts: ogFontList(regularFont, heavyFont),
    },
  );

  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

// ---------------------------------------------------------------------------
// Dan emblem: a single rasterized dan logo, used as the /dan command thumbnail.
// Discord cannot render the SVG emblems, so this route fetches the asset and
// re-emits it as a PNG over a soft family-tinted tile. (webp emblems are linked
// directly by the bot and never reach here.)
// ---------------------------------------------------------------------------

const DAN_FAMILY_ACCENT: Record<string, string> = {
  stream: "#7dd3fc",
  jack: "#fca5a5",
  handstream: "#c4b5fd",
  stamina: "#6ee7b7",
  chordjack: "#fcd34d",
  tech: "#f0abfc",
  ln: "#5eead4",
  dan: "#fdba74",
};

function danEmblemAssetPath(label: string, family: string): string | null {
  if (family === "ln" && /^(1[0-6]|[1-9])$/.test(label)) return `/images/dans/ln/${label}.svg`;
  if (/^([1-9]|10)$/.test(label)) return `/images/dans/reform/${label}.svg`;
  return null;
}

async function renderDanEmblemOg(request: Request, label: string, family: string): Promise<Response> {
  const assetPath = danEmblemAssetPath(label, family);
  if (!assetPath) throw new OgFallbackError(`no svg dan emblem for ${family}/${label}`);

  const assetUrl = new URL(assetPath, getAssetOrigin(request)).toString();
  const assetResponse = await fetch(assetUrl);
  if (!assetResponse.ok) throw new OgFallbackError(`dan emblem ${assetResponse.status}`);
  const data = Buffer.from(await assetResponse.arrayBuffer()).toString("base64");
  const dataUrl = `data:image/svg+xml;base64,${data}`;
  const accent = DAN_FAMILY_ACCENT[family] ?? "#ff66aa";

  const response = new ImageResponse(
    h(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #140f12 0%, #241019 100%)",
        },
      },
      [
        h("div", {
          key: "glow",
          style: {
            position: "absolute",
            inset: "0",
            background: `radial-gradient(circle at 50% 46%, ${accent}40 0%, rgba(0,0,0,0) 62%)`,
          },
        }),
        h("img", {
          key: "emblem",
          src: dataUrl,
          style: { width: "384px", height: "384px", objectFit: "contain" },
        }),
      ],
    ),
    { width: 512, height: 512 },
  );

  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

/* Polaroid card primitive used by both home and rankings OGs. Renders an
   image inside a flat off-white frame with a small caption strip below.
   No gradients/shadows/glows — just the frame, the photo, and the
   caption — so the card reads as a paper print on a flat surface. The
   caller positions and rotates each card to scatter it across the
   canvas. */
type PolaroidProps = {
  imgSrc: string;
  caption?: string;
  subCaption?: string;
  captionFontSize?: number;
  size: number;
  rotate: number;
  top: number;
  left: number;
  badge?: string;
  badgeColor?: string;
  variant?: "photo" | "flag";
  key: string;
};

function polaroid(props: PolaroidProps) {
  const {
    imgSrc,
    caption,
    subCaption,
    captionFontSize = 22,
    size,
    rotate,
    top,
    left,
    badge,
    badgeColor,
    variant = "photo",
    key,
  } = props;
  const frameWidth = size + 28;
  const captionHeight = caption
    ? subCaption
      ? captionFontSize + 40
      : captionFontSize + 24
    : 28;
  const photoHeight = variant === "flag" ? Math.round(size * 0.66) : size;
  const frameHeight = 14 + photoHeight + 14 + captionHeight;
  return h(
    "div",
    {
      key,
      style: {
        position: "absolute",
        top: `${top}px`,
        left: `${left}px`,
        display: "flex",
        flexDirection: "column",
        width: `${frameWidth}px`,
        height: `${frameHeight}px`,
        padding: "14px 14px 0",
        background: "#f3ece4",
        boxSizing: "border-box",
        transform: `rotate(${rotate}deg)`,
      },
    },
    [
      h(
        "div",
        {
          key: "frame",
          style: {
            position: "relative",
            display: "flex",
            width: `${size}px`,
            height: `${photoHeight}px`,
            background: "#1a1317",
            overflow: "hidden",
          },
        },
        [
          h("img", {
            key: "img",
            src: imgSrc,
            style: {
              width: `${size}px`,
              height: `${photoHeight}px`,
              objectFit: "cover",
            },
          }),
          badge
            ? h(
                "div",
                {
                  key: "badge",
                  style: {
                    position: "absolute",
                    top: "10px",
                    left: "10px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "4px 10px",
                    background: badgeColor ?? "#ff66aa",
                    color: "#1a1317",
                    fontSize: "20px",
                    fontWeight: 900,
                    letterSpacing: "0.04em",
                  },
                },
                badge,
              )
            : null,
        ],
      ),
      caption
        ? h(
            "div",
            {
              key: "cap",
              style: {
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                width: `${size}px`,
                paddingTop: "10px",
              },
            },
            [
              h(
                "div",
                {
                  key: "main",
                  style: {
                    fontSize: `${captionFontSize}px`,
                    fontWeight: 900,
                    color: "#1a1317",
                    lineHeight: "1.0",
                    overflow: "hidden",
                    maxWidth: `${size}px`,
                  },
                },
                caption,
              ),
              subCaption
                ? h(
                    "div",
                    {
                      key: "sub",
                      style: {
                        fontSize: "16px",
                        fontWeight: 900,
                        color: "#7a6b74",
                        lineHeight: "1.0",
                        marginTop: "4px",
                      },
                    },
                    subCaption,
                  )
                : null,
            ],
          )
        : null,
    ],
  );
}

/* Dimmed avatar backdrop. Renders the country's tail-end ranked
   players as small frameless tinted avatars scattered across the
   canvas so the focal polaroids on top read as "the country's mania
   scene" rather than just 8 isolated faces. Positions/rotations are
   deterministic per-country via mulberry32 so the same country renders
   the same backdrop until the upstream rankings shift.

   The scatter is generated on a coarse grid then jittered: it
   guarantees full coverage without piling cards on each other, while
   still feeling hand-placed. */
// Linear-interpolate two #rrggbb hex colours. Used to pre-bake "dimmed"
// frame colours into solid hex so the polaroid frame stays fully
// opaque and occludes cards behind it. (Using CSS opacity on the whole
// card would let stacked cards bleed through each other.)
function lerpHex(from: string, to: string, t: number): string {
  const fr = parseInt(from.slice(1, 3), 16);
  const fg = parseInt(from.slice(3, 5), 16);
  const fb = parseInt(from.slice(5, 7), 16);
  const tr = parseInt(to.slice(1, 3), 16);
  const tg = parseInt(to.slice(3, 5), 16);
  const tb = parseInt(to.slice(5, 7), 16);
  const r = Math.round(fr + (tr - fr) * t);
  const g = Math.round(fg + (tg - fg) * t);
  const b = Math.round(fb + (tb - fb) * t);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

const SURFACE_COLOR = "#1a1620";
const POLAROID_FRAME_COLOR = "#f3ece4";
const PHOTO_BG_COLOR = "#1a1317";

function backdropAvatars(
  country: string,
  avatars: Array<{ url: string }>,
): ReactNode[] {
  if (avatars.length === 0) return [];
  // Dense grid so coverage stays even (no large empty patches), with
  // moderate jitter so the result still reads as scattered. Cards CAN
  // overlap — that's part of the pile-of-polaroids feel — but we
  // pre-bake the frame's dimming into a solid hex colour so each card
  // fully occludes anything behind it (no bleed-through from CSS
  // alpha-blending stacked translucent cards).
  const cols = 11;
  const rows = 5;
  const cellW = WIDTH / cols;
  const cellH = HEIGHT / rows;
  const rng = mulberry32(hashString(country));
  const cells: ReactNode[] = [];
  let cursor = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const avatar = avatars[cursor % avatars.length];
      cursor++;
      // Size varies — smaller = further away, larger = closer.
      const photoSize = 56 + Math.floor(rng() * 56);
      const cardW = photoSize + 28;
      const cardH = photoSize + 14 + 28;
      // Moderate jitter (~55% of cell) keeps coverage even while
      // breaking the grid and letting cards overlap their neighbours.
      const jitterX = (rng() - 0.5) * cellW * 0.55;
      const jitterY = (rng() - 0.5) * cellH * 0.55;
      const left = c * cellW + (cellW - cardW) / 2 + jitterX;
      const top = r * cellH + (cellH - cardH) / 2 + jitterY;
      const rotate = (rng() - 0.5) * 22;
      // "Depth" drives both size (already done) and brightness here.
      // Lower depth = further back = frame fades toward the surface
      // colour, avatar fades toward photo-bg. Higher depth = closer
      // to foreground.
      const depth = 0.18 + rng() * 0.6;
      const frameColor = lerpHex(SURFACE_COLOR, POLAROID_FRAME_COLOR, depth);
      // Avatar opacity is applied inside the frame, on top of the dark
      // photo bg. That blends toward the photo bg (still inside the
      // card), never toward whatever's behind the frame.
      const avatarOpacity = depth;
      cells.push(
        h(
          "div",
          {
            key: `bg-${r}-${c}`,
            style: {
              position: "absolute",
              top: `${top}px`,
              left: `${left}px`,
              width: `${cardW}px`,
              height: `${cardH}px`,
              padding: "14px 14px 0",
              background: frameColor,
              boxSizing: "border-box",
              transform: `rotate(${rotate.toFixed(2)}deg)`,
              display: "flex",
            },
          },
          h(
            "div",
            {
              key: "frame",
              style: {
                display: "flex",
                width: `${photoSize}px`,
                height: `${photoSize}px`,
                background: PHOTO_BG_COLOR,
                overflow: "hidden",
              },
            },
            h("img", {
              src: avatar.url,
              style: {
                width: `${photoSize}px`,
                height: `${photoSize}px`,
                objectFit: "cover",
                opacity: avatarOpacity,
              },
            }),
          ),
        ),
      );
    }
  }
  return cells;
}

/* Sticker primitive: a flat solid-colour rectangle of text. No image,
   no caption — used for "Costa Rica", "rankings", "the mania scene" etc.
   Stuck onto the scrapbook surface alongside the polaroids with the
   same tilt mechanic so it sits in the same plane as the photo cards. */
type StickerProps = {
  text: string;
  subText?: string;
  fontSize: number;
  background: string;
  color: string;
  paddingX: number;
  paddingY: number;
  rotate: number;
  top: number;
  left: number;
  key: string;
};

function sticker(props: StickerProps) {
  const {
    text,
    subText,
    fontSize,
    background,
    color,
    paddingX,
    paddingY,
    rotate,
    top,
    left,
    key,
  } = props;
  return h(
    "div",
    {
      key,
      style: {
        position: "absolute",
        top: `${top}px`,
        left: `${left}px`,
        display: "flex",
        flexDirection: "column",
        padding: `${paddingY}px ${paddingX}px`,
        background,
        color,
        transform: `rotate(${rotate}deg)`,
      },
    },
    [
      h(
        "div",
        {
          key: "t",
          style: {
            fontSize: `${fontSize}px`,
            fontWeight: 900,
            lineHeight: "1.0",
            letterSpacing: "0.01em",
          },
        },
        text,
      ),
      subText
        ? h(
            "div",
            {
              key: "s",
              style: {
                fontSize: `${Math.round(fontSize * 0.22)}px`,
                fontWeight: 900,
                lineHeight: "1.0",
                marginTop: "8px",
                letterSpacing: "0.18em",
                opacity: 0.75,
              },
            },
            subText,
          )
        : null,
    ],
  );
}

/* Home layout: scrapbook scatter. The country's top players' avatars
   are pinned to the canvas as polaroids at varying tilts. A flag
   polaroid and a country/title sticker sit in the centre band so the
   identity reads without dominating. Flat #15131a paper-on-table
   surface; no gradients, glows, or radial decorations. */
async function renderHomeOg(request: Request, country: string): Promise<Response> {
  const [regularFont, heavyFont, rankings] = await Promise.all([
    getFont(request, "Torus-Regular.otf"),
    getFont(request, "Torus-Heavy.otf"),
    getRankings({ data: { type: "performance", page: 1, country } }),
  ]);

  const players = rankings.ranking.slice(0, 8);
  // Backdrop pulls from positions 8..50 — the rest of the country's
  // ranked roster — so the foreground polaroids and the dimmed
  // background never show the same avatar twice.
  const backdropPlayers = rankings.ranking
    .slice(8, 50)
    .map((entry) => ({ url: entry.user.avatar_url }));
  const countryName = getCountryName(country) || country;
  const flagUrl = flagImageUrl(country);

  // Hand-tuned scatter so the centre band stays open for the country
  // sticker and the corners get filled by polaroids. Coordinates are
  // top/left of each card's bounding box pre-rotation — Satori applies
  // the rotate transform around the card's centre.
  const playerSlots: Array<{
    top: number;
    left: number;
    rotate: number;
    size: number;
  }> = [
    { top: 30, left: 30, rotate: -7, size: 150 },
    { top: 12, left: 230, rotate: 4, size: 130 },
    { top: 56, left: 980, rotate: 6, size: 150 },
    { top: 22, left: 800, rotate: -5, size: 130 },
    { top: 380, left: 60, rotate: 5, size: 140 },
    { top: 410, left: 260, rotate: -4, size: 120 },
    { top: 380, left: 880, rotate: -6, size: 140 },
    { top: 420, left: 1060, rotate: 7, size: 120 },
  ];

  const polaroids = players.map((entry, i) => {
    const slot = playerSlots[i];
    if (!slot) return null;
    return polaroid({
      key: `p-${i}`,
      imgSrc: entry.user.avatar_url,
      caption: entry.user.username,
      size: slot.size,
      rotate: slot.rotate,
      top: slot.top,
      left: slot.left,
    });
  });

  const response = new ImageResponse(
    h(
      "div",
      {
        style: {
          width: `${WIDTH}px`,
          height: `${HEIGHT}px`,
          display: "flex",
          position: "relative",
          overflow: "hidden",
          background: "#1a1620",
          fontFamily: '"Torus OG"',
          color: "#ffffff",
        },
      },
      [
        // Dimmed avatar backdrop — the rest of the country's ranked
        // roster, scattered behind the foreground polaroids.
        ...backdropAvatars(country, backdropPlayers),

        ...polaroids,

        // Flag polaroid as the focal centrepiece — country name doubles
        // as its caption so flag and label live on the same card. Larger
        // and more upright than the surrounding scatter so the eye lands
        // here first.
        polaroid({
          key: "flag-card",
          imgSrc: flagUrl,
          variant: "flag",
          caption: countryName,
          captionFontSize: 56,
          size: 320,
          rotate: -2,
          top: 130,
          left: 440,
        }),

        // Brand sticker — small, taped at the bottom-centre, tilted.
        sticker({
          key: "brand",
          text: "Mania Tracker",
          fontSize: 22,
          background: "#f3ece4",
          color: "#1a1317",
          paddingX: 14,
          paddingY: 10,
          rotate: -3,
          top: 568,
          left: 510,
        }),
      ],
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      fonts: ogFontList(regularFont, heavyFont),
    },
  );

  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

/* Rankings layout: same scrapbook language, tighter composition. Top 3
   players' polaroids fanned out across the centre, each stamped with
   their rank and PP. The country flag polaroid + a "rankings" sticker
   complete the identity. */
async function renderRankingsOg(
  request: Request,
  country: string,
): Promise<Response> {
  const [regularFont, heavyFont, rankings] = await Promise.all([
    getFont(request, "Torus-Regular.otf"),
    getFont(request, "Torus-Heavy.otf"),
    getRankings({ data: { type: "performance", page: 1, country } }),
  ]);

  const top3 = rankings.ranking.slice(0, 3);
  // Backdrop pulls from positions 3..50 — everyone else in the country's
  // ranked roster — so dimmed extras don't duplicate the fanned three.
  const backdropPlayers = rankings.ranking
    .slice(3, 50)
    .map((entry) => ({ url: entry.user.avatar_url }));
  const countryName = getCountryName(country) || country;
  const flagUrl = flagImageUrl(country);

  // Centre card (#1) is the largest and sits on top. #2 leans left,
  // #3 leans right — fanned-deck feel. PP as the sub-caption, rank as
  // a corner stamp on the photo. Render order matters: Satori uses DOM
  // order for stacking (z-index isn't supported), so #1 must be last
  // among the three cards to land on top of #2 and #3.
  const slots = [
    { rank: 2, entry: top3[1] ?? null, size: 230, rotate: -8, top: 145, left: 130 },
    { rank: 3, entry: top3[2] ?? null, size: 220, rotate: 9, top: 160, left: 830 },
    { rank: 1, entry: top3[0] ?? null, size: 280, rotate: 3, top: 110, left: 470 },
  ];

  const cards = slots
    .filter((s) => s.entry !== null)
    .map((s) =>
      polaroid({
        key: `r-${s.rank}`,
        imgSrc: s.entry!.user.avatar_url,
        caption: s.entry!.user.username,
        subCaption: `${formatOgInt(s.entry!.pp)}pp`,
        size: s.size,
        rotate: s.rotate,
        top: s.top,
        left: s.left,
        badge: `#${s.rank}`,
        badgeColor: s.rank === 1 ? "#ff66aa" : "#f3ece4",
      }),
    );

  const response = new ImageResponse(
    h(
      "div",
      {
        style: {
          width: `${WIDTH}px`,
          height: `${HEIGHT}px`,
          display: "flex",
          position: "relative",
          overflow: "hidden",
          background: "#1a1620",
          fontFamily: '"Torus OG"',
          color: "#ffffff",
        },
      },
      [
        // Dimmed avatar backdrop — the rest of the country's ranked
        // roster, scattered behind the fanned polaroids.
        ...backdropAvatars(country, backdropPlayers),

        // Flag polaroid pinned bottom-left.
        polaroid({
          key: "flag",
          imgSrc: flagUrl,
          variant: "flag",
          size: 170,
          rotate: -6,
          top: 460,
          left: 70,
        }),

        ...cards,

        // "rankings" sticker, top-left corner, tilted.
        sticker({
          key: "label",
          text: "rankings",
          fontSize: 56,
          background: "#ff66aa",
          color: "#1a1317",
          paddingX: 22,
          paddingY: 14,
          rotate: -4,
          top: 30,
          left: 60,
        }),

        // Country sticker bottom-right, tilted opposite for balance.
        sticker({
          key: "country",
          text: countryName,
          fontSize: 52,
          background: "#f3ece4",
          color: "#1a1317",
          paddingX: 22,
          paddingY: 14,
          rotate: 4,
          top: 510,
          left: 720,
        }),

        // Tiny brand mark, taped corner.
        sticker({
          key: "brand",
          text: "Mania Tracker",
          fontSize: 16,
          background: "#1a1317",
          color: "#7a6b74",
          paddingX: 10,
          paddingY: 6,
          rotate: -2,
          top: 50,
          left: 1010,
        }),
      ],
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      fonts: ogFontList(regularFont, heavyFont),
    },
  );

  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

/* Country layout: a scoreboard preview showing the top 5 of the country's
   current ranking. Generic fallback for any page that bakes
   `?country=XX` into its og:image URL without specifying a `kind`. The
   country name is the focal element; the title from the URL appears as
   a small muted caption so each page still reads distinctly.
   Description/subtitle is intentionally not rendered here — it lives in
   the HTML <meta> so the social-card body text shows it once, not
   duplicated inside the image. */
async function renderCountryOg(
  request: Request,
  country: string,
  rawTitle: string,
): Promise<Response> {
  const [regularFont, heavyFont, rankings] = await Promise.all([
    getFont(request, "Torus-Regular.otf"),
    getFont(request, "Torus-Heavy.otf"),
    getRankings({ data: { type: "performance", page: 1, country } }),
  ]);

  const top5 = rankings.ranking.slice(0, 5);
  const countryName = getCountryName(country) || country;
  const flagUrl = `https://osu.ppy.sh/images/flags/${country}.png`;

  const title = clamp(rawTitle, MAX_TITLE_LEN);
  // Skip showing the title when it's just the site name (home page), so
  // we don't duplicate the brand mark that sits at the bottom already.
  const showTitle = title && title !== "Mania Tracker";

  const response = new ImageResponse(
    h(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "row",
          position: "relative",
          overflow: "hidden",
          background: "linear-gradient(135deg, #140f12 0%, #2a1a26 100%)",
          fontFamily: '"Torus OG"',
          color: "#ffffff",
        },
      },
      [
        h("div", {
          key: "glow",
          style: {
            position: "absolute",
            inset: "0",
            background:
              "radial-gradient(circle at 16% 48%, rgba(255, 102, 170, 0.22) 0%, rgba(255, 102, 170, 0) 50%)",
          },
        }),

        // Left column: flag + country name + small title caption + brand mark.
        h(
          "div",
          {
            key: "left",
            style: {
              position: "relative",
              display: "flex",
              flexDirection: "column",
              width: "520px",
              height: "100%",
              padding: "60px 40px 60px 60px",
              justifyContent: "space-between",
            },
          },
          [
            h(
              "div",
              {
                key: "top",
                style: { display: "flex", flexDirection: "column" },
              },
              [
                h("img", {
                  key: "flag",
                  src: flagUrl,
                  style: {
                    width: "200px",
                    height: "134px",
                    borderRadius: "6px",
                    objectFit: "cover",
                    border: "1px solid rgba(255,255,255,0.08)",
                    boxShadow: "0 10px 36px rgba(0,0,0,0.45)",
                    marginBottom: "28px",
                  },
                }),
                h(
                  "div",
                  {
                    key: "country",
                    style: {
                      fontSize: "78px",
                      fontWeight: 900,
                      lineHeight: "1.0",
                      marginBottom: showTitle ? "16px" : "0",
                    },
                  },
                  countryName,
                ),
                showTitle
                  ? h(
                      "div",
                      {
                        key: "title",
                        style: {
                          fontSize: "24px",
                          color: "#c7b8c1",
                          lineHeight: "1.2",
                        },
                      },
                      title,
                    )
                  : null,
              ],
            ),
            h(
              "div",
              {
                key: "brand",
                style: {
                  fontSize: "20px",
                  color: "#7a6b74",
                  letterSpacing: "0.06em",
                },
              },
              "Mania Tracker",
            ),
          ],
        ),

        // Right column: scoreboard.
        h(
          "div",
          {
            key: "right",
            style: {
              position: "relative",
              display: "flex",
              flexDirection: "column",
              width: "680px",
              height: "100%",
              padding: "60px 60px 60px 20px",
              justifyContent: "center",
              gap: "10px",
            },
          },
          top5.length > 0
            ? top5.map((entry, idx) => scoreboardRow(entry, idx))
            : [
                h(
                  "div",
                  {
                    key: "empty",
                    style: {
                      color: "#7a6b74",
                      fontSize: "22px",
                    },
                  },
                  "no ranked mania players found",
                ),
              ],
        ),
      ],
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      fonts: ogFontList(regularFont, heavyFont),
    },
  );

  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

function scoreboardRow(
  entry: { user: { avatar_url: string; username: string }; pp: number; global_rank: number },
  idx: number,
) {
  const rank = idx + 1;
  return h(
    "div",
    {
      key: `row-${idx}`,
      style: {
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: "18px",
        padding: "12px 18px",
        borderRadius: "12px",
        background: rank === 1 ? "rgba(255,102,170,0.09)" : "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.05)",
        height: "78px",
      },
    },
    [
      h(
        "div",
        {
          key: "pos",
          style: {
            fontSize: "28px",
            fontWeight: 900,
            color: rank === 1 ? "#ff66aa" : "#8a7a82",
            width: "46px",
            textAlign: "right",
          },
        },
        `#${rank}`,
      ),
      h(
        "div",
        {
          key: "avatar",
          style: {
            width: "48px",
            height: "48px",
            borderRadius: "10px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#1a1317",
            border: "1px solid rgba(255,255,255,0.08)",
            boxSizing: "border-box",
            flexShrink: 0,
          },
        },
        h("img", {
          src: entry.user.avatar_url,
          style: {
            width: "46px",
            height: "46px",
            borderRadius: "9px",
            objectFit: "cover",
          },
        }),
      ),
      h(
        "div",
        {
          key: "name",
          style: {
            flex: "1",
            fontSize: "26px",
            fontWeight: 900,
            color: "#ffffff",
            overflow: "hidden",
            minWidth: "0",
          },
        },
        entry.user.username,
      ),
      h(
        "div",
        {
          key: "pp",
          style: {
            fontSize: "24px",
            fontWeight: 900,
            color: rank === 1 ? "#ff66aa" : "#e8e3ec",
          },
        },
        `${Math.round(entry.pp).toLocaleString("en-US")}pp`,
      ),
    ],
  );
}

/* Bare flag sticker: a country flag rendered as a tilted card on the
   surface. No polaroid frame — that's reserved for the focal flag on
   the country pages, where the flag IS the hero. On the default
   layout we want flags to feel like decorative stickers/stamps, not
   hero cards, so we drop the white frame and just render the flag
   image with a thin border to keep the edges crisp. */
function flagSticker(props: {
  country: string;
  width: number;
  rotate: number;
  top: number;
  left: number;
  key: string;
}) {
  const { country, width, rotate, top, left, key } = props;
  // Flags are rendered at 3:2 (matching flagcdn.com's source aspect).
  const height = Math.round(width * 0.66);
  return h(
    "div",
    {
      key,
      style: {
        position: "absolute",
        top: `${top}px`,
        left: `${left}px`,
        display: "flex",
        width: `${width}px`,
        height: `${height}px`,
        transform: `rotate(${rotate}deg)`,
        overflow: "hidden",
      },
    },
    h("img", {
      src: flagImageUrl(country),
      style: {
        width: `${width}px`,
        height: `${height}px`,
        objectFit: "cover",
      },
    }),
  );
}

/* Grade sticker: a stylised badge floating on the surface, no
   polaroid frame, no caption. The grade SVG is rendered at the
   requested size and tilted just like the polaroid cards so it sits
   in the same plane. Used in the default layout to nod at osu!mania
   scoring without competing with the polaroid avatar/flag cards. */
function gradeSticker(props: {
  grade: keyof typeof GRADE_FILE;
  width: number;
  rotate: number;
  top: number;
  left: number;
  request: Request;
  key: string;
}) {
  const { grade, width, rotate, top, left, request, key } = props;
  // The score-ranks-v2019 SVGs are 32x16 (2:1).
  const height = Math.round(width * 0.5);
  return h(
    "div",
    {
      key,
      style: {
        position: "absolute",
        top: `${top}px`,
        left: `${left}px`,
        display: "flex",
        width: `${width}px`,
        height: `${height}px`,
        transform: `rotate(${rotate}deg)`,
      },
    },
    h("img", {
      src: gradeImgUrl(request, grade),
      style: { width: `${width}px`, height: `${height}px` },
    }),
  );
}

/* Default layout: shown when nobody has selected a country (bare site
   URL). Same polaroid scrapbook language as the country pages, but
   instead of one country flag we scatter a curated set of mania-active
   countries' flags as polaroids and dot the canvas with grade badge
   stickers. The backdrop pulls the global mania top 50 avatars (one
   getRankings call with no country filter), so the page still feels
   populated by real players. The focal centre is a pink
   "Mania Tracker" sticker. */
async function renderDefaultPolaroidOg(request: Request): Promise<Response> {
  // Curated list of countries with active mania scenes / visually
  // distinctive flags. Costa Rica leads (project's home scene). The
  // rest is a mix of historic mania-strong countries and visually
  // distinct flags so the scatter reads as "around the world." Order
  // isn't a ranking — it's the position in the foreground scatter
  // (see FLAG_SLOTS below).
  const FEATURED_COUNTRIES = [
    "CR", "KR", "JP", "US", "BR", "FI", "PL",
    "RU", "DE", "FR", "CN", "TW", "AU", "MX",
  ];

  // Hand-tuned scatter for the foreground flag stickers. 14 slots,
  // sizes in the 100-130px range (flags are 3:2 so they're wider
  // than they are tall). The centre band stays open for the
  // "Mania Tracker" focal sticker.
  const FLAG_SLOTS: Array<{
    top: number;
    left: number;
    rotate: number;
    width: number;
  }> = [
    { top: 30, left: 40, rotate: -7, width: 130 },
    { top: 50, left: 230, rotate: 5, width: 115 },
    { top: 22, left: 410, rotate: -3, width: 110 },
    { top: 40, left: 740, rotate: 4, width: 110 },
    { top: 26, left: 920, rotate: -5, width: 120 },
    { top: 44, left: 1080, rotate: 6, width: 100 },
    { top: 250, left: 24, rotate: 6, width: 110 },
    { top: 260, left: 1090, rotate: -5, width: 110 },
    { top: 460, left: 40, rotate: 4, width: 130 },
    { top: 478, left: 230, rotate: -6, width: 115 },
    { top: 490, left: 410, rotate: 5, width: 110 },
    { top: 478, left: 740, rotate: -4, width: 110 },
    { top: 462, left: 920, rotate: 6, width: 120 },
    { top: 480, left: 1080, rotate: -7, width: 100 },
  ];

  // Grade badge stickers scattered across the canvas. Picked
  // positions tucked between flag polaroids so they read as decorative
  // badges, not as part of the polaroid grid.
  const GRADE_SLOTS: Array<{
    grade: keyof typeof GRADE_FILE;
    width: number;
    rotate: number;
    top: number;
    left: number;
  }> = [
    { grade: "SS", width: 150, rotate: -10, top: 158, left: 200 },
    { grade: "S", width: 120, rotate: 8, top: 178, left: 940 },
    { grade: "A", width: 110, rotate: -6, top: 360, left: 200 },
    { grade: "B", width: 100, rotate: 7, top: 374, left: 940 },
  ];

  const [regularFont, heavyFont, rankings] = await Promise.all([
    getFont(request, "Torus-Regular.otf"),
    getFont(request, "Torus-Heavy.otf"),
    // Global mania performance top 50 for the dim backdrop.
    getRankings({ data: { type: "performance", page: 1 } }),
  ]);

  const backdropPlayers = rankings.ranking
    .slice(0, 50)
    .map((entry) => ({ url: entry.user.avatar_url }));

  const flagCards = FEATURED_COUNTRIES.map((cc, i) => {
    const slot = FLAG_SLOTS[i];
    if (!slot) return null;
    return flagSticker({
      key: `flag-${cc}`,
      country: cc,
      width: slot.width,
      rotate: slot.rotate,
      top: slot.top,
      left: slot.left,
    });
  });

  const gradeBadges = GRADE_SLOTS.map((s, i) =>
    gradeSticker({
      key: `grade-${i}`,
      grade: s.grade,
      width: s.width,
      rotate: s.rotate,
      top: s.top,
      left: s.left,
      request,
    }),
  );

  const response = new ImageResponse(
    h(
      "div",
      {
        style: {
          width: `${WIDTH}px`,
          height: `${HEIGHT}px`,
          display: "flex",
          position: "relative",
          overflow: "hidden",
          background: SURFACE_COLOR,
          fontFamily: '"Torus OG"',
          color: "#ffffff",
        },
      },
      [
        // Dimmed avatar backdrop — global mania top 50, scattered
        // behind the foreground cards.
        ...backdropAvatars("__default__", backdropPlayers),

        // Foreground scatter: flag polaroids first, then grade
        // stickers on top, then the focal sticker last so it dominates.
        ...flagCards,
        ...gradeBadges,

        // Centre focal sticker: large pink "Mania Tracker" with a
        // small product line. Plays the role the flag polaroid does on
        // the country pages.
        sticker({
          key: "title",
          text: "Mania Tracker",
          subText: "RANKS / SCORES / MAPS / REPLAYS",
          fontSize: 80,
          background: "#ff66aa",
          color: "#1a1317",
          paddingX: 32,
          paddingY: 24,
          rotate: -2,
          top: 240,
          left: 280,
        }),
      ],
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      fonts: ogFontList(regularFont, heavyFont),
    },
  );

  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

/* Farm helper layout: deliberately quieter than the scrapbook cards.
   Flat surface, no avatar backdrop, no scatter. Left: the pink
   "farm helper" title sticker. Right: a tidy stack of three paper
   cards, one per recommendation reason (missing / improve / old pb in
   the app's accent colours), each with an illustrative pp gain and an
   abstract title bar standing in for the map name. Reads as "this tool
   hands you a short list of maps", which is exactly what it does.
   Behind it all sits a heavily dimmed mosaic of actual farmed-map cover
   art (the maps snapshot's farmed tab), so the surface has texture
   without competing with the foreground. The backdrop is optional: with
   no farmed data the card renders on the flat surface. */
function farmHelperRecCard(props: {
  reason: string;
  reasonColor: string;
  gain: string;
  barWidth: number;
  rotate: number;
  top: number;
  left: number;
  key: string;
}) {
  const { reason, reasonColor, gain, barWidth, rotate, top, left, key } = props;
  return h(
    "div",
    {
      key,
      style: {
        position: "absolute",
        top: `${top}px`,
        left: `${left}px`,
        display: "flex",
        flexDirection: "column",
        width: "480px",
        padding: "24px 28px",
        background: "#f3ece4",
        boxSizing: "border-box",
        transform: `rotate(${rotate}deg)`,
        gap: "16px",
      },
    },
    [
      h(
        "div",
        {
          key: "row",
          style: {
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
          },
        },
        [
          h(
            "div",
            {
              key: "chip",
              style: {
                display: "flex",
                padding: "8px 14px",
                background: reasonColor,
                color: "#1a1317",
                fontSize: "28px",
                fontWeight: 900,
                lineHeight: "1.0",
              },
            },
            reason,
          ),
          h(
            "div",
            {
              key: "gain",
              style: {
                marginLeft: "auto",
                fontSize: "44px",
                fontWeight: 900,
                color: "#1a1317",
                lineHeight: "1.0",
              },
            },
            gain,
          ),
        ],
      ),
      // Abstract map-title bar: a placeholder shape instead of a fake
      // beatmap name.
      h("div", {
        key: "bar",
        style: {
          display: "flex",
          width: `${barWidth}px`,
          height: "14px",
          borderRadius: "7px",
          background: "#cfc4b8",
        },
      }),
    ],
  );
}

async function renderFarmHelperOg(request: Request): Promise<Response> {
  // Farmed-map covers for the backdrop. The tool itself is global, but
  // farmed data is per-country; CR (the project's home scene) seeds the
  // texture. Purely decorative, so a missing pool just means no backdrop.
  const [[regularFont, heavyFont], pool] = await Promise.all([
    loadOgFonts(request),
    fetchMapsOgPoolFromLiveBackend("CR", "farmed"),
  ]);

  let mosaic: ReactNode = null;
  if (pool && pool.covers.length > 0) {
    const rng = mulberry32(hashString("farm-helper"));
    const picked = shuffle(pool.covers, rng).slice(0, MAPS_MOSAIC_COUNT);
    while (picked.length < MAPS_MOSAIC_COUNT && pool.covers.length > 0) {
      picked.push(...shuffle(pool.covers, rng).slice(0, MAPS_MOSAIC_COUNT - picked.length));
    }
    mosaic = h(
      "div",
      {
        key: "mosaic",
        style: {
          position: "absolute",
          inset: "0",
          display: "flex",
          flexDirection: "column",
          width: `${WIDTH}px`,
          height: `${HEIGHT}px`,
        },
      },
      Array.from({ length: MAPS_MOSAIC_ROWS }, (_, r) =>
        h(
          "div",
          {
            key: `row-${r}`,
            style: {
              display: "flex",
              flexDirection: "row",
              width: `${WIDTH}px`,
              height: `${HEIGHT / MAPS_MOSAIC_ROWS}px`,
            },
          },
          Array.from({ length: MAPS_MOSAIC_COLS }, (_, c) => {
            const cover = picked[r * MAPS_MOSAIC_COLS + c] ?? null;
            return h(
              "div",
              {
                key: `cell-${r}-${c}`,
                style: {
                  display: "flex",
                  width: `${WIDTH / MAPS_MOSAIC_COLS}px`,
                  height: `${HEIGHT / MAPS_MOSAIC_ROWS}px`,
                  overflow: "hidden",
                },
              },
              cover
                ? h("img", {
                    src: cover,
                    style: {
                      width: `${WIDTH / MAPS_MOSAIC_COLS}px`,
                      height: `${HEIGHT / MAPS_MOSAIC_ROWS}px`,
                      objectFit: "cover",
                      // Low opacity over the dark surface keeps the art
                      // as texture, not content.
                      opacity: 0.12,
                    },
                  })
                : null,
            );
          }),
        ),
      ),
    );
  }

  // Reason colours mirror REASON_META in src/routes/farm-helper.tsx
  // (osu-blue, osu-green-light, osu-yellow).
  const recs = [
    { reason: "missing", reasonColor: "#66ccff", gain: "+41pp", barWidth: 300, rotate: -1.4, top: 105, left: 660 },
    { reason: "improve", reasonColor: "#b3d944", gain: "+24pp", barWidth: 250, rotate: 1.2, top: 253, left: 642 },
    { reason: "old pb", reasonColor: "#ffcc22", gain: "+18pp", barWidth: 330, rotate: -0.8, top: 401, left: 668 },
  ];

  const response = new ImageResponse(
    h(
      "div",
      {
        style: {
          width: `${WIDTH}px`,
          height: `${HEIGHT}px`,
          display: "flex",
          position: "relative",
          overflow: "hidden",
          background: SURFACE_COLOR,
          fontFamily: '"Torus OG"',
          color: "#ffffff",
        },
      },
      [
        // Dimmed farmed-map cover mosaic (when available).
        mosaic,

        // Title sticker on the left, vertically centred against the
        // card stack. Sub-line echoes the app's own "+Npp on the table"
        // header copy.
        sticker({
          key: "title",
          text: "farm helper",
          subText: "PP ON THE TABLE",
          fontSize: 76,
          background: "#ff66aa",
          color: "#1a1317",
          paddingX: 32,
          paddingY: 24,
          rotate: -2,
          top: 238,
          left: 80,
        }),

        // The recommendation stack.
        ...recs.map((rec, i) =>
          farmHelperRecCard({
            key: `rec-${i}`,
            reason: rec.reason,
            reasonColor: rec.reasonColor,
            gain: rec.gain,
            barWidth: rec.barWidth,
            rotate: rec.rotate,
            top: rec.top,
            left: rec.left,
          }),
        ),

        // Small brand mark, bottom-left corner.
        sticker({
          key: "brand",
          text: "Mania Tracker",
          fontSize: 16,
          background: "#f3ece4",
          color: "#1a1317",
          paddingX: 10,
          paddingY: 6,
          rotate: -2,
          top: 560,
          left: 84,
        }),
      ],
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      fonts: ogFontList(regularFont, heavyFont),
    },
  );

  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

/* Title-only fallback. Used as a last resort if the polaroid default
   render fails, and for any odd preview-tool presets that pass a raw
   title without a country. The description lives in the HTML <meta>
   so the social card body text carries it — baking it into the image
   too would just duplicate. */
async function renderDefaultOg(request: Request, url: URL): Promise<Response> {
  const title = clamp(url.searchParams.get("title"), MAX_TITLE_LEN) || "Mania Tracker";
  const showBrand = title !== "Mania Tracker";

  const [regularFont, heavyFont] = await loadOgFonts(request);

  const response = new ImageResponse(
    h(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          position: "relative",
          overflow: "hidden",
          background: "linear-gradient(135deg, #140f12 0%, #2a1a26 100%)",
          padding: "80px",
          fontFamily: '"Torus OG"',
          color: "#ffffff",
        },
      },
      [
        h("div", {
          key: "glow",
          style: {
            position: "absolute",
            inset: "0",
            background:
              "radial-gradient(circle at 22% 50%, rgba(255, 102, 170, 0.18) 0%, rgba(255, 102, 170, 0) 55%)",
          },
        }),
        h(
          "div",
          {
            key: "content",
            style: {
              position: "relative",
              display: "flex",
              flexDirection: "column",
            },
          },
          [
            showBrand
              ? h(
                  "div",
                  {
                    key: "mark",
                    style: {
                      fontSize: "28px",
                      color: "#ff99cc",
                      marginBottom: "22px",
                      letterSpacing: "0.04em",
                    },
                  },
                  "Mania Tracker",
                )
              : null,
            h(
              "div",
              {
                key: "title",
                style: {
                  fontSize: "88px",
                  fontWeight: 900,
                  lineHeight: "0.98",
                  maxWidth: "1000px",
                },
              },
              title,
            ),
          ],
        ),
      ],
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      fonts: ogFontList(regularFont, heavyFont),
    },
  );

  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

export const Route = createFileRoute("/api/og")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const kind = url.searchParams.get("kind");
        const rawCountry = url.searchParams.get("country");
        const country = rawCountry?.trim().toUpperCase();
        // Global is not a real country, so it has no flag/scoreboard OG layout;
        // let it fall through to the default branded card.
        const countryValid = country && isSupportedCountryCode(country) && !isGlobalScope(country);
        const version = OG_IMAGE_VERSION;

        // Player route. Username in URL, data comes from osu! API.
        if (kind === "player") {
          const username = url.searchParams.get("username");
          if (!username) return new Response("Missing username", { status: 400 });
          try {
            return await serveOg(
              `player:${username.trim().toLowerCase()}:v${version}`,
              () => renderPlayerOg(request, username),
            );
          } catch (err) {
            console.warn("[og] player render failed, falling back", err);
          }
        }

        // Maniacard route. Username in URL; skills computed from the player's
        // top plays via the live backend, rendered as a tier card.
        if (kind === "maniacard") {
          const username = url.searchParams.get("username");
          if (!username) return new Response("Missing username", { status: 400 });
          try {
            return await serveOg(
              `maniacard:${username.trim().toLowerCase()}:v${version}`,
              () => renderManiacardOg(request, username),
            );
          } catch (err) {
            if (!isOgFallbackError(err)) console.warn("[og] maniacard render failed, falling back", err);
          }
        }

        // Dan emblem thumbnail for the /dan command (rasterizes an svg emblem).
        if (kind === "dan-emblem") {
          const label = (url.searchParams.get("label") ?? "").trim().toLowerCase().slice(0, 8);
          const family = (url.searchParams.get("family") ?? "").trim().toLowerCase().slice(0, 16);
          if (label) {
            try {
              return await serveOg(
                `dan-emblem:${family}:${label}:v${version}`,
                () => renderDanEmblemOg(request, label, family),
              );
            } catch (err) {
              if (!isOgFallbackError(err)) console.warn("[og] dan-emblem render failed, falling back", err);
            }
          }
        }

        // Replay route. Needs a scoreId, no country concept.
        if (kind === "replay") {
          const scoreId = Number(url.searchParams.get("scoreId"));
          if (Number.isFinite(scoreId) && scoreId > 0) {
            try {
              return await serveOg(
                `replay:${scoreId}:v${version}`,
                () => renderReplayOg(request, scoreId),
              );
            } catch (err) {
              console.warn("[og] replay render failed, falling back", err);
            }
          }
        }

        // Farm helper route. Global tool, no country concept; one static
        // branded card shared by every share of the page.
        if (kind === "farm-helper") {
          try {
            return await serveOg(`farm-helper:v${version}`, () => renderFarmHelperOg(request));
          } catch (err) {
            console.warn("[og] farm-helper render failed, falling back", err);
          }
        }

        // Country-specific custom layouts. Pages without a custom image fall
        // through to the country scoreboard fallback below.
        if (countryValid) {
          if (kind === "maps") {
            try {
              return await serveOg(`maps:${country}:v${version}`, () => renderMapsOg(request, country));
            } catch (err) {
              if (!isOgFallbackError(err)) {
                console.warn("[og] maps render failed, falling back", err);
              }
            }
          }

          if (kind === "home") {
            try {
              return await serveOg(`home:${country}:v${version}`, () => renderHomeOg(request, country));
            } catch (err) {
              console.warn("[og] home render failed, falling back", err);
            }
          }

          if (kind === "rankings") {
            try {
              return await serveOg(`rankings:${country}:v${version}`, () => renderRankingsOg(request, country));
            } catch (err) {
              console.warn("[og] rankings render failed, falling back", err);
            }
          }

          // No recognized kind — generic country scoreboard fallback.
          const fallbackTitle = url.searchParams.get("title") ?? "";
          try {
            return await renderCountryOg(request, country, fallbackTitle);
          } catch (err) {
            console.warn("[og] country render failed, falling back", err);
          }
        }

        // Default polaroid layout — used when nothing else matched
        // (no country, no recognised kind). Falls back to the
        // title-only minimal layout on error.
        try {
          return await serveOg(`default:v${version}`, () => renderDefaultPolaroidOg(request));
        } catch (err) {
          console.warn("[og] default polaroid render failed, falling back", err);
        }
        return renderDefaultOg(request, url);
      },
    },
  },
});
