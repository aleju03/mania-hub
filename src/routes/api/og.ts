import { ImageResponse } from "@vercel/og";
import { createFileRoute } from "@tanstack/react-router";
import { createElement as h } from "react";
import type { ReactNode } from "react";
import {
  clamp,
  formatOgAcc,
  formatOgInt,
  getFont,
  getNoteSpriteDataUrl,
  isOgFallbackError,
  loadOgFonts,
  MAX_CONCURRENT_OG_RENDERS,
  ogFontList,
  OgFallbackError,
  ogRenderGate,
  pngResponse,
  scheduleDetached,
} from "../../lib/og-render";
import {
  getCachedUser,
  getRankings,
  getScore,
} from "../../lib/osu";
import { getServerLiveBackendUrl } from "../../lib/live-backend";
import { parsePackCardKey } from "../../lib/pack-collection";
import { getCountryName, isGlobalScope, isSupportedCountryCode } from "../../lib/country";
import { getAssetOrigin } from "../../lib/origin";
import {
  getDisplayedAccuracy,
  getDisplayedRank,
  getDisplayedTotalScore,
  getManiaJudgementCounts,
  getModAcronyms,
} from "../../lib/score";
import { readCurrentAuth } from "../../lib/auth-server";
import { getCachedOgImage, putOgImage } from "../../lib/r2-cache";
import { countryTopPlaysTitle, OG_IMAGE_VERSION } from "../../lib/seo";
import { describeUploadedReplayById, type UploadedReplayDescription } from "../../lib/uploaded-replay-describe";
import { normalizeUploadedReplayId } from "../../lib/uploaded-replay-store";
import { computeManiaSkills, getManiaCardTier, MANIA_TIER_STYLES } from "../../lib/maniacard";
import { honoraryAvatarUrl } from "../../lib/honorary-players";
import type { ManiaCardTier } from "../../lib/maniacard";
import { parseCardMotif } from "../../lib/card-motif";
import { getCosmicTierPalette } from "../../lib/maniacard-cosmic";
import {
  cardMotifDataUrl,
  cosmicBackgroundDataUrl,
  cosmicLaurelDataUrl,
  maniaTierCardElement,
  starDataUrl,
  triangleOverlayDataUrl,
  MANIA_GLYPH_D,
  MANIACARD_FOOTER_H,
  MANIACARD_H,
  MANIACARD_W,
  type ManiaTierCardArt,
} from "../../lib/maniacard-art";
import type { OsuCovers, OsuScore, OsuUser } from "../../lib/types";

const WIDTH = 1200;
const HEIGHT = 630;
const MAX_TITLE_LEN = 38;

// Every OG URL carries v=OG_IMAGE_VERSION, so layout changes always mint new
// URLs; a long shared-cache TTL is safe and keeps daily edge re-misses (a full
// incompressible PNG from origin each time) from recurring per URL.
const OG_CACHE_HEADER = "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800";

// Rasterizing an OG card (Satori + resvg) is the most CPU-heavy work on the
// frontend server, multiple seconds per image. The CDN caches each URL for a day,
// but every miss/revalidation re-renders from scratch. We back that with an R2
// cache keyed by the card identity and server-owned OG version so a miss becomes
// a fast object read. Request query params must not expand R2 key cardinality.

function ogImageResponse(buffer: Buffer): Response {
  return pngResponse(buffer, OG_CACHE_HEADER);
}

function scheduleOgStore(cacheKey: string, buffer: Buffer): void {
  scheduleDetached(putOgImage(cacheKey, buffer));
}

const inFlightOgRenders = new Map<string, Promise<Response>>();

function defaultOgCacheKey(): string {
  return `default:v${OG_IMAGE_VERSION}`;
}

/* The R2 key for the player and maniacard cards is the username, so the shape
   of what may become a key has to be the shape of a real osu! username
   (letters, digits, spaces, `_`, `-`, `[`, `]`, and up to 15 of them) or a bare
   user id. Anything else is refused before the osu! lookup and before any
   render: it could never have resolved to a player anyway, and rejecting it
   here is what stops junk from costing a request an osu! call apiece. Returns
   the lowercased key, or null for a name no osu! account can have. */
const OSU_USERNAME_RE = /^[A-Za-z0-9_[\] -]{1,15}$/;

export function ogUsernameKey(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed || !OSU_USERNAME_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

async function renderAndStoreOg(cacheKey: string, render: () => Promise<Response>): Promise<Response> {
  const inFlight = inFlightOgRenders.get(cacheKey);
  // Every joiner needs its own Response: a body can only be read once.
  if (inFlight) return (await inFlight).clone();

  const attempt = ogRenderGate.run(async () => {
    const response = await render();
    if (!response.ok) return response;
    const buffer = Buffer.from(await response.arrayBuffer());
    scheduleOgStore(cacheKey, buffer);
    return ogImageResponse(buffer);
  }).finally(() => {
    inFlightOgRenders.delete(cacheKey);
  });
  inFlightOgRenders.set(cacheKey, attempt);
  return (await attempt).clone();
}

async function serveOg(request: Request, cacheKey: string, render: () => Promise<Response>): Promise<Response> {
  const cached = await getCachedOgImage(cacheKey);
  if (cached) return ogImageResponse(cached);

  const defaultKey = defaultOgCacheKey();
  if (cacheKey !== defaultKey && ogRenderGate.activeCount >= MAX_CONCURRENT_OG_RENDERS && !inFlightOgRenders.has(cacheKey)) {
    const fallback = await getCachedOgImage(defaultKey);
    if (fallback) return ogImageResponse(fallback);
    // Nothing cached to hand back yet (first request after a version bump).
    // The default card single-flights and waits for a render slot. The gate in
    // renderAndStoreOg keeps this cold-cache path inside the same hard cap.
    return renderAndStoreOg(defaultKey, () => renderDefaultBrandOg(request));
  }

  return renderAndStoreOg(cacheKey, render);
}

/* The `tier` query param, honoured only for dev users. Anyone else gets the
   card's own minted rarity, so a shared OG URL always tells the truth. */
async function readDevTierOverride(url: URL): Promise<ManiaCardTier | null> {
  const raw = url.searchParams.get("tier");
  if (!raw || !(raw in MANIA_TIER_STYLES)) return null;
  try {
    const auth = await readCurrentAuth();
    return auth.canUseDevFeatures ? (raw as ManiaCardTier) : null;
  } catch {
    return null;
  }
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

async function renderMapsOg(request: Request, country: string): Promise<Response> {
  const pool = await fetchMapsOgPoolFromLiveBackend(country);
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
  // "Costa Rica's mania maps" read as maps *made* by Costa Ricans; the page is
  // about what the country plays.
  const title = `Maps played in ${countryName}`;
  // Long country names would otherwise wrap the title onto a second line.
  const titleFontSize = title.length > 30 ? 44 : 54;

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
                      fontSize: `${titleFontSize}px`,
                      fontWeight: 900,
                      lineHeight: "1.0",
                    },
                  },
                  title,
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

/* Judgement breakdown, laid out like the osu! result screen: one column
   per bucket, count on top of a colored label. The thin bar above turns
   the same numbers into a shape readable at thumbnail size (wide yellow
   = clean play, red sliver = the miss that ended the run). Skipped when
   total = 0 (e.g. unsupported score statistics). */
function judgementStrip(judgements: Array<{ label: string; value: number }>) {
  const total = judgements.reduce((s, j) => s + j.value, 0);
  if (total === 0) return null;
  const visible = judgements.filter((j) => j.value > 0);

  return h(
    "div",
    {
      key: "judgements",
      style: {
        display: "flex",
        flexDirection: "column",
        marginTop: "26px",
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
            height: "10px",
            borderRadius: "5px",
            overflow: "hidden",
            background: "rgba(0,0,0,0.45)",
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
              marginLeft: i === 0 ? "0" : "2px",
            },
          }),
        ),
      ),
      h(
        "div",
        {
          key: "cells",
          style: {
            display: "flex",
            flexDirection: "row",
            justifyContent: "space-between",
            marginTop: "16px",
          },
        },
        judgements.map((j) =>
          h(
            "div",
            {
              key: `cell-${j.label}`,
              style: {
                display: "flex",
                flexDirection: "column",
              },
            },
            [
              h(
                "div",
                {
                  key: "v",
                  style: {
                    fontSize: "34px",
                    fontWeight: 900,
                    lineHeight: "1.0",
                    // Empty buckets stay grey so a clean play reads clean:
                    // only the judgements that happened carry color.
                    color: j.value === 0 ? "#6b5a63" : (JUDGEMENT_COLORS[j.label] ?? "#ffffff"),
                  },
                },
                formatOgInt(j.value),
              ),
              h(
                "div",
                {
                  key: "l",
                  style: {
                    marginTop: "6px",
                    fontSize: "15px",
                    letterSpacing: "0.14em",
                    color: "#9d8d97",
                  },
                },
                j.label.toUpperCase(),
              ),
            ],
          ),
        ),
      ),
    ],
  );
}

// Big number over a small caps label: the unit the score-screen stat row
// and the judgement columns are both built from.
function ogStatCell(
  key: string,
  label: string,
  value: string,
  options: { color?: string; size?: number } = {},
) {
  return h(
    "div",
    { key, style: { display: "flex", flexDirection: "column" } },
    [
      h(
        "div",
        {
          key: "v",
          style: {
            fontSize: `${options.size ?? 46}px`,
            fontWeight: 900,
            lineHeight: "1.0",
            color: options.color ?? "#ffffff",
          },
        },
        value,
      ),
      h(
        "div",
        {
          key: "l",
          style: {
            marginTop: "8px",
            fontSize: "15px",
            letterSpacing: "0.14em",
            color: "#9d8d97",
          },
        },
        label,
      ),
    ],
  );
}

// One entry of the replay card's map metadata line. Returns null for empty
// values so the caller can drop it along with its separator.
function metaPart(key: string, text: string): ReactNode {
  if (!text) return null;
  return h("div", { key }, text);
}

function formatOgScoreDate(score: OsuScore): string {
  const raw = score.ended_at || score.created_at;
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return date
    .toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    .toUpperCase();
}

interface ReplayOgCardData {
  cover: string | null;
  title: string;
  artist: string;
  version: string;
  keyCount: number | null;
  stars: number | null;
  mapper: string;
  playerName: string;
  avatarUrl: string;
  avatarUserId?: number;
  countryCode: string;
  modsLabel: string;
  rank: string;
  accuracy: number;
  totalScore: number | null;
  maxCombo: number | null;
  pp: number | null;
  playDate: string;
  judgements: Array<{ label: string; value: number }>;
}

function scoreReplayOgData(score: OsuScore): ReplayOgCardData {
  return {
    cover: pickBeatmapsetCover(score),
    title: score.beatmapset?.title ?? "Unknown beatmap",
    artist: score.beatmapset?.artist ?? "",
    version: score.beatmap?.version ?? "",
    keyCount: score.beatmap?.cs ? Math.round(score.beatmap.cs) : null,
    stars: Number.isFinite(score.beatmap?.difficulty_rating) ? score.beatmap.difficulty_rating : null,
    mapper: score.beatmapset?.creator ?? "",
    playerName: score.user?.username ?? "Unknown player",
    avatarUrl: score.user?.avatar_url ?? "",
    avatarUserId: score.user?.id,
    countryCode: score.user?.country_code ?? "",
    modsLabel: getModAcronyms(score.mods).join(""),
    rank: getDisplayedRank(score),
    // Stable plays are judged on the 300-weighted scale, but osu! reports the
    // 305-weighted (rainbow-MAX) accuracy for them too, so read the same
    // normalized value the replay page shows instead of the raw field.
    accuracy: getDisplayedAccuracy(score),
    totalScore: getDisplayedTotalScore(score),
    maxCombo: score.max_combo ?? score.beatmap?.max_combo ?? null,
    pp: scoreAwardsRankedPp(score) ? score.pp : null,
    playDate: formatOgScoreDate(score),
    judgements: getManiaJudgementCounts(score.statistics),
  };
}

function uploadedReplayOgData(description: UploadedReplayDescription): ReplayOgCardData {
  const beatmap = description.beatmap;
  return {
    cover: beatmap?.beatmapsetId
      ? `https://assets.ppy.sh/beatmaps/${beatmap.beatmapsetId}/covers/cover@2x.jpg`
      : null,
    title: beatmap?.title || "Unknown beatmap",
    artist: beatmap?.artist ?? "",
    version: beatmap?.version ?? "",
    keyCount: description.keyCount > 0 ? description.keyCount : null,
    stars: beatmap?.starRating ?? null,
    mapper: beatmap?.creator ?? "",
    playerName: description.playerName || "Unknown player",
    // An .osr names the player but carries no user id or avatar. The guest
    // portrait keeps the result-card layout intact without turning an OG view
    // into a second username lookup against osu!.
    avatarUrl: "https://osu.ppy.sh/images/layout/avatar-guest@2x.png",
    countryCode: "",
    modsLabel: description.mods.join(""),
    rank: description.grade,
    accuracy: description.accuracy,
    totalScore: description.totalScore,
    maxCombo: description.maxCombo,
    pp: null,
    playDate: "",
    judgements: [
      { label: "MAX", value: description.judgements.max },
      { label: "300", value: description.judgements.count300 },
      { label: "200", value: description.judgements.count200 },
      { label: "100", value: description.judgements.count100 },
      { label: "50", value: description.judgements.count50 },
      { label: "Miss", value: description.judgements.miss },
    ],
  };
}

/* Replay: an osu! result screen rebuilt for a 1200x630 embed. Reading
   order top to bottom is the same as the game's: which map, who played
   it, how it went. Bands are plain flex rows inside one absolutely
   positioned content layer, kept apart from the background layers so
   Satori can't mix the two coordinate systems (an older version had an
   offset bug from exactly that).

   Band 1: eyebrow + play date. Band 2: map identity (title, artist,
   difficulty, keys, stars, mapper). Band 3: player and grade, the two
   things a passer-by reads first. Band 4: score / accuracy / combo / pp.
   Band 5: judgement breakdown. */
async function renderReplayOgCard(
  request: Request,
  data: ReplayOgCardData,
  regularFont: ArrayBuffer,
  heavyFont: ArrayBuffer,
): Promise<Response> {
  const {
    cover,
    modsLabel,
    rank: displayedRank,
    accuracy,
    judgements,
    totalScore,
    maxCombo,
    playDate,
  } = data;

  // Difficulty names routinely already carry the key count ("[7K] Dum
  // spiro,"), so only add the keymode chip when it isn't in there.
  const keys = data.keyCount ? `${data.keyCount}K` : "";
  const version = data.version.trim();
  const showKeys = !!keys && !new RegExp(`\\b${keys}\\b`, "i").test(version);
  const metaParts: ReactNode[] = [
    metaPart("artist", clamp(data.artist, 34)),
    metaPart("version", version ? clamp(version, 32) : ""),
    metaPart("keys", showKeys ? keys : ""),
    data.stars != null && Number.isFinite(data.stars)
      ? h(
          "div",
          {
            key: "stars",
            style: { display: "flex", flexDirection: "row", alignItems: "center", gap: "7px" },
          },
          [
            // Torus has no ★ glyph (it rasterizes as tofu), so the star is
            // the same inline svg the other cards use.
            h("img", {
              key: "icon",
              src: starDataUrl("#ffcc22"),
              style: { width: "19px", height: "19px" },
            }),
            h("div", { key: "sr" }, data.stars.toFixed(2)),
          ],
        )
      : null,
    metaPart("mapper", data.mapper ? `mapped by ${clamp(data.mapper, 20)}` : ""),
  ].filter(Boolean);

  const response = new ImageResponse(
    h(
      "div",
      {
        // Outer canvas: background art and content stack via absolute
        // positioning so layout glitches like "content offset by parent
        // flex" can't happen.
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
                opacity: 0.5,
              },
            })
          : null,
        // Two scrims: a vertical one that darkens toward the stats, and a
        // wash that keeps the art from fighting the text anywhere.
        h("div", {
          key: "dim",
          style: {
            position: "absolute",
            top: 0,
            left: 0,
            width: `${WIDTH}px`,
            height: `${HEIGHT}px`,
            background:
              "linear-gradient(180deg, rgba(12,8,11,0.58) 0%, rgba(12,8,11,0.74) 44%, rgba(12,8,11,0.93) 100%)",
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
              "linear-gradient(90deg, rgba(9,5,8,0.66) 0%, rgba(9,5,8,0.10) 42%, rgba(9,5,8,0.10) 62%, rgba(9,5,8,0.62) 100%)",
          },
        }),

        // Content layer: one absolutely-positioned flex column that owns
        // its own padding, decoupled from the background layers.
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
              padding: "44px 60px 46px",
            },
          },
          [
            h(
              "div",
              {
                key: "top",
                style: {
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                },
              },
              [
                h(
                  "div",
                  {
                    key: "eyebrow",
                    style: {
                      fontSize: "22px",
                      fontWeight: 900,
                      letterSpacing: "0.30em",
                      color: "#ff8ec2",
                    },
                  },
                  "REPLAY",
                ),
                playDate
                  ? h(
                      "div",
                      {
                        key: "date",
                        style: {
                          fontSize: "19px",
                          letterSpacing: "0.14em",
                          color: "#9d8d97",
                        },
                      },
                      playDate,
                    )
                  : null,
              ],
            ),

            // Map identity.
            h(
              "div",
              {
                key: "map",
                style: {
                  display: "flex",
                  flexDirection: "column",
                  marginTop: "22px",
                },
              },
              [
                h(
                  "div",
                  {
                    key: "title",
                    style: {
                      fontSize: "48px",
                      fontWeight: 900,
                      // overflow:hidden clips at the line box, so the line
                      // needs room for descenders (g, y, j) or they lose
                      // their tails.
                      lineHeight: "1.22",
                      overflow: "hidden",
                    },
                  },
                  clamp(data.title, 42),
                ),
                h(
                  "div",
                  {
                    key: "meta",
                    style: {
                      display: "flex",
                      flexDirection: "row",
                      alignItems: "center",
                      marginTop: "12px",
                      fontSize: "21px",
                      color: "#c7b8c1",
                    },
                  },
                  metaParts.flatMap((part, i) =>
                    i === 0
                      ? [part]
                      : [
                          h(
                            "div",
                            {
                              key: `sep-${i}`,
                              style: { color: "#6b5a63", padding: "0 12px" },
                            },
                            "·",
                          ),
                          part,
                        ],
                  ),
                ),
              ],
            ),

            // Player and grade: the hero band absorbs the spare vertical
            // room so the card breathes on short titles.
            h(
              "div",
              {
                key: "hero",
                style: {
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flex: "1",
                },
              },
              [
                h(
                  "div",
                  {
                    key: "player",
                    style: {
                      display: "flex",
                      flexDirection: "row",
                      alignItems: "center",
                      gap: "24px",
                      minWidth: "0",
                    },
                  },
                  [
                    h("img", {
                      key: "avatar",
                      src: ogAvatarUrl(request, data.avatarUrl, data.avatarUserId),
                      style: {
                        width: "120px",
                        height: "120px",
                        borderRadius: "26px",
                        objectFit: "cover",
                        flexShrink: 0,
                      },
                    }),
                    h(
                      "div",
                      {
                        key: "who",
                        style: { display: "flex", flexDirection: "column", minWidth: "0" },
                      },
                      [
                        h(
                          "div",
                          {
                            key: "name",
                            style: {
                              fontSize: "62px",
                              fontWeight: 900,
                              // Same as the title: leave descender room so
                              // usernames like "Aleju03" keep the j's tail.
                              lineHeight: "1.22",
                              overflow: "hidden",
                            },
                          },
                          clamp(data.playerName, 20),
                        ),
                        data.countryCode
                          ? h(
                              "div",
                              {
                                key: "country",
                                style: {
                                  display: "flex",
                                  flexDirection: "row",
                                  alignItems: "center",
                                  gap: "10px",
                                  marginTop: "12px",
                                },
                              },
                              [
                                h("img", {
                                  key: "flag",
                                  src: `https://osu.ppy.sh/images/flags/${data.countryCode}.png`,
                                  style: {
                                    width: "32px",
                                    height: "22px",
                                    borderRadius: "3px",
                                    objectFit: "cover",
                                  },
                                }),
                                h(
                                  "div",
                                  {
                                    key: "cname",
                                    style: { fontSize: "20px", color: "#c7b8c1" },
                                  },
                                  getCountryName(data.countryCode) || data.countryCode,
                                ),
                              ],
                            )
                          : null,
                      ],
                    ),
                  ],
                ),
                h(
                  "div",
                  {
                    key: "result",
                    style: {
                      display: "flex",
                      flexDirection: "row",
                      alignItems: "center",
                      gap: "24px",
                      flexShrink: 0,
                    },
                  },
                  [
                    modsLabel
                      ? h(
                          "div",
                          {
                            key: "mods",
                            style: {
                              fontSize: "38px",
                              fontWeight: 900,
                              letterSpacing: "0.04em",
                              color: "#ff8ec2",
                            },
                          },
                          `+${modsLabel}`,
                        )
                      : null,
                    h("img", {
                      key: "grade",
                      src: gradeImgUrl(request, displayedRank),
                      // The grade artwork is 32x16, so keep that ratio.
                      style: { width: "208px", height: "104px", flexShrink: 0 },
                    }),
                  ],
                ),
              ],
            ),

            // Score / accuracy / combo / pp, the result-screen numbers.
            h(
              "div",
              {
                key: "stats",
                style: {
                  display: "flex",
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  marginTop: "12px",
                  paddingTop: "28px",
                  borderTop: "1px solid rgba(255,255,255,0.14)",
                },
              },
              [
                ogStatCell("score", "SCORE", formatOgInt(totalScore)),
                ogStatCell("acc", "ACCURACY", formatOgAcc(accuracy)),
                ogStatCell(
                  "combo",
                  "MAX COMBO",
                  maxCombo != null ? `${formatOgInt(maxCombo)}x` : "--",
                ),
                data.pp != null
                  ? ogStatCell("pp", "PERFORMANCE", `${formatOgInt(data.pp)}pp`, {
                      color: "#ff66aa",
                    })
                  : null,
              ],
            ),

            judgementStrip(judgements),
          ],
        ),
      ],
    ),
    { width: WIDTH, height: HEIGHT, fonts: ogFontList(regularFont, heavyFont) },
  );
  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

async function renderReplayOg(request: Request, scoreId: number): Promise<Response> {
  const [[regularFont, heavyFont], score] = await Promise.all([
    loadOgFonts(request),
    getScore({ data: { scoreId } }),
  ]);
  return renderReplayOgCard(request, scoreReplayOgData(score), regularFont, heavyFont);
}

async function renderUploadedReplayOg(request: Request, uploadId: string): Promise<Response> {
  const [[regularFont, heavyFont], description] = await Promise.all([
    loadOgFonts(request),
    describeUploadedReplayById(uploadId),
  ]);
  if (!description) throw new OgFallbackError(`no uploaded replay for ${uploadId}`);
  return renderReplayOgCard(request, uploadedReplayOgData(description), regularFont, heavyFont);
}

/* Archived players (deleted osu! accounts, seeded into profile_snapshots)
   404 on every osu! API path, so the OG render falls back to the backend's
   cached snapshot: the same row the profile page itself renders from. A
   snapshot is also better than the generic card during an osu! outage, so
   any lookup failure takes this path, not just 404s. */
async function fetchCachedProfileUser(key: string): Promise<OsuUser | null> {
  const base = getServerLiveBackendUrl();
  if (!base) return null;
  const response = await fetch(`${base}/api/profiles/${encodeURIComponent(key)}/cached-snapshot`);
  if (!response.ok) return null;
  const snapshot = (await response.json()) as { user?: OsuUser | null };
  return snapshot.user ?? null;
}

/* Satori fetches avatars itself, so a snapshot's site-relative path (archived
   players keep their portrait in public/) has to be absolute. */
function ogAvatarUrl(request: Request, avatarUrl: string | null | undefined, userId?: number): string {
  if (avatarUrl && !/^(https?:)?\/\//i.test(avatarUrl) && !avatarUrl.startsWith("data:")) {
    return new URL(avatarUrl, getAssetOrigin(request)).toString();
  }
  if (avatarUrl) return avatarUrl;
  return userId ? `https://a.ppy.sh/${userId}` : "";
}

async function resolveOgPlayer(request: Request, username: string): Promise<OsuUser> {
  try {
    return await getCachedUser(username);
  } catch (error) {
    const cached = await fetchCachedProfileUser(username);
    if (!cached?.statistics) throw error;
    return { ...cached, avatar_url: ogAvatarUrl(request, cached.avatar_url, cached.id) };
  }
}

/* Player card layout: cover-art ambient background, a big rounded-square
   avatar (osu! site style, not a circle), and a stat stack on the right
   with flag + country, username, global/country rank, PP, acc. */
async function renderPlayerOg(request: Request, rawUsername: string): Promise<Response> {
  const username = rawUsername.trim().slice(0, 64);
  const [regularFont, heavyFont, user] = await Promise.all([
    getFont(request, "Torus-Regular.otf"),
    getFont(request, "Torus-Heavy.otf"),
    resolveOgPlayer(request, username),
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
  const avatarUrl = ogAvatarUrl(request, user.avatar_url, user.id);
  const laurelUrl = await cosmicLaurelDataUrl(request, tier);

  const response = new ImageResponse(
    maniaTierCardElement({ username: user.username || "Unknown", avatarUrl, tier, skills, laurelUrl }),
    {
      width: MANIACARD_W,
      height: MANIACARD_H,
      fonts: ogFontList(regularFont, heavyFont),
    },
  );

  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

// ---------------------------------------------------------------------------
// Pulled card: the /pull/{owner}/{card} permalink embed. Same card art as the
// maniacard OG but rendered from the minted skills snapshot stored on the
// owner's collection row, with a "pulled by" footer.
// ---------------------------------------------------------------------------

interface SharedPackCardPayload {
  owner?: { userId?: number; username?: string };
  card?: {
    userId?: number;
    username?: string;
    avatarUrl?: string;
    tier?: string | null;
    /* Badge text given to this one holding, which the card art prints instead
       of the tier's name. The share image has to draw the same card the page
       does, or the preview says GOAT for a card that reads something else. */
    customLabel?: string | null;
    /* And the background art it floats, for the same reason. */
    motif?: unknown;
    skills?: {
      fingerControl?: number;
      speed?: number;
      accuracy?: number;
      starAvg?: number;
      cardPower?: number;
    } | null;
  };
}

async function renderPulledCardOg(
  request: Request,
  ownerId: number,
  cardKey: string,
  /* Dev-only: render this pull's art at another rarity so the admin OG preview
     can show every tier without hunting for a real pull of each one. */
  tierOverride?: ManiaCardTier,
): Promise<Response> {
  const base = getServerLiveBackendUrl();
  if (!base) throw new OgFallbackError("live backend not configured");

  const [[regularFont, heavyFont], payloadResponse] = await Promise.all([
    loadOgFonts(request),
    fetch(`${base}/api/packs/pulled-card/${ownerId}/${encodeURIComponent(cardKey)}`),
  ]);
  if (payloadResponse.status === 404) throw new OgFallbackError(`no pulled card ${ownerId}/${cardKey}`);
  if (!payloadResponse.ok) throw new OgFallbackError(`pulled card ${payloadResponse.status}`);
  const payload = (await payloadResponse.json()) as SharedPackCardPayload;
  const card = payload.card;
  const skills = card?.skills;
  if (
    !card ||
    !skills ||
    ![skills.fingerControl, skills.speed, skills.accuracy, skills.starAvg].every((value) => Number.isFinite(Number(value)))
  ) {
    throw new OgFallbackError(`pulled card ${ownerId}/${cardKey} has no minted skills`);
  }

  const tier: ManiaCardTier =
    tierOverride ??
    (card.tier && card.tier in MANIA_TIER_STYLES
      ? (card.tier as ManiaCardTier)
      : getManiaCardTier(Number(skills.cardPower) || 0));
  const style = MANIA_TIER_STYLES[tier];
  const art: ManiaTierCardArt = {
    username: card.username || "Unknown",
    // Same archived-portrait override the in-app card draws, so the share
    // image is not the only place a deleted account still reads as a guest.
    avatarUrl: ogAvatarUrl(request, honoraryAvatarUrl(card.userId) ?? card.avatarUrl, card.userId),
    tier,
    label: card.customLabel,
    skills: {
      fingerControl: Number(skills.fingerControl),
      speed: Number(skills.speed),
      accuracy: Number(skills.accuracy),
      starAvg: Number(skills.starAvg),
    },
    laurelUrl: await cosmicLaurelDataUrl(request, tier),
  };
  /* Re-parsed rather than trusted: this payload crossed a network hop, and the
     numbers drive how large each copy is drawn. A motif whose image cannot be
     fetched simply leaves the tier's own pattern in place. */
  const motif = parseCardMotif(card.motif);
  const inlinedMotif = motif ? await cardMotifDataUrl(motif) : null;
  if (motif && inlinedMotif) {
    art.motif = motif;
    art.motifUrl = inlinedMotif.dataUrl;
    art.motifAspect = inlinedMotif.aspect;
  }
  const ownerName = payload.owner?.username || "a collector";

  const response = new ImageResponse(
    h(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#120d15",
          fontFamily: '"Torus OG"',
        },
      },
      [
        maniaTierCardElement(art),
        h(
          "div",
          {
            key: "footer",
            style: {
              width: "100%",
              height: `${MANIACARD_FOOTER_H}px`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#120d15",
              borderTop: `3px solid ${style.glowColor}`,
            },
          },
          [
            h("div", { key: "by", style: { display: "flex", fontSize: "27px", color: "rgba(255,255,255,0.55)" } }, "Pulled by"),
            h("div", { key: "owner", style: { display: "flex", fontSize: "30px", fontWeight: 900, color: "#ffffff", marginLeft: "12px" } }, ownerName),
          ],
        ),
      ],
    ),
    {
      width: MANIACARD_W,
      height: MANIACARD_H + MANIACARD_FOOTER_H,
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

/* Palette for the default card. The rest of the OG layouts inline
   these hex values; they only get names here because the playfield
   helper below needs them in a few places. */
const OG_PINK = "#ff66aa";
const OG_MUTED = "#a89cb4";

// Surfaces named on the default card, in chip reading order. Not a
// ranking, and not the full site map — just enough for someone seeing
// the link preview to know what they'd be clicking into.
const DEFAULT_OG_FEATURES = [
  "rankings",
  "live tracker",
  "top plays",
  "maps",
  "replays",
];

// One chip is filled instead of outlined so the row has a focal point
// and the card carries the accent colour below the fold of the title.
function featureChip(label: string, key: string, accent = false) {
  return h(
    "div",
    {
      key,
      style: {
        display: "flex",
        alignItems: "center",
        padding: "9px 16px",
        marginRight: "10px",
        marginTop: "10px",
        background: accent ? OG_PINK : "rgba(255,255,255,0.06)",
        border: `1px solid ${accent ? OG_PINK : "rgba(255,255,255,0.12)"}`,
        borderRadius: "999px",
        color: accent ? "#1a1317" : "#cfc6d8",
        fontSize: "20px",
        fontWeight: 900,
        letterSpacing: "0.05em",
      },
    },
    label,
  );
}

type ColumnNote = { y: number; ln?: number; accent?: boolean };

// Note colours by lane, the way a 4K skin usually reads: pale outer
// lanes, blue inner lanes. `accent` overrides both with the site pink
// so a couple of notes carry the brand colour.
const NOTE_STYLES = {
  pale: { solid: "#f3ece4", soft: "rgba(243,236,228,0.30)", trail: "rgba(243,236,228,0.11)" },
  blue: { solid: "#8ecbff", soft: "rgba(142,203,255,0.32)", trail: "rgba(142,203,255,0.15)" },
  pink: { solid: OG_PINK, soft: "rgba(255,102,170,0.42)", trail: "rgba(255,102,170,0.20)" },
};

/* A stylised mania playfield: n columns of notes falling toward a lit
   receptor line, with one lane caught mid-hit. Drawn with plain rects
   (not skin sprites) so the palette stays on-brand and the render has
   no asset dependency.

   The motion trails behind each note are what sell it as a play in
   progress rather than a static chart diagram, so they scale with note
   size instead of being a fixed length. */
function maniaColumns(props: {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  columns: ColumnNote[][];
  colWidth: number;
  gap: number;
  receptorY: number;
  noteHeight: number;
  // Lane index that just got hit: it gets column lighting, a flash on
  // the receptor and a burst of sparks.
  hitColumn?: number;
  opacity?: number;
}) {
  const {
    key, left, top, width, height, columns, colWidth, gap,
    receptorY, noteHeight, hitColumn, opacity = 1,
  } = props;
  const bandWidth = columns.length * colWidth + (columns.length - 1) * gap;
  const padLeft = Math.round((width - bandWidth) / 2);
  const trailHeight = Math.round(noteHeight * 4.2);

  const cols = columns.map((notes, ci) => {
    const inner = ci > 0 && ci < columns.length - 1;
    const lane = inner ? NOTE_STYLES.blue : NOTE_STYLES.pale;
    const colLeft = padLeft + ci * (colWidth + gap);
    const children: ReactNode[] = [];

    for (const [ni, note] of notes.entries()) {
      const style = note.accent ? NOTE_STYLES.pink : lane;
      if (note.ln) {
        children.push(
          h("div", {
            key: `ln-${ci}-${ni}`,
            style: {
              position: "absolute",
              left: `${Math.round(colWidth * 0.16)}px`,
              top: `${note.y - note.ln}px`,
              width: `${Math.round(colWidth * 0.68)}px`,
              // Like the trails, the body runs under the head so its
              // rounded end doesn't show as a seam above the note.
              height: `${note.ln + noteHeight}px`,
              borderTopLeftRadius: "6px",
              borderTopRightRadius: "6px",
              background: style.soft,
            },
          }),
        );
      } else {
        // Only tap notes get a trail; a held note's body already reads
        // as length, and stacking the two just looks smeared.
        children.push(
          h("div", {
            key: `tr-${ci}-${ni}`,
            style: {
              position: "absolute",
              left: `${Math.round(colWidth * 0.2)}px`,
              // Runs past the note's top edge so the note covers the
              // trail's end; stopping at note.y leaves the rounded
              // bottom poking out as a cup shape.
              top: `${note.y - trailHeight}px`,
              width: `${Math.round(colWidth * 0.6)}px`,
              height: `${trailHeight + noteHeight}px`,
              borderTopLeftRadius: `${Math.round(colWidth * 0.3)}px`,
              borderTopRightRadius: `${Math.round(colWidth * 0.3)}px`,
              background: `linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0) 46%, ${style.trail} 100%)`,
            },
          }),
        );
      }
      children.push(
        h("div", {
          key: `n-${ci}-${ni}`,
          style: {
            position: "absolute",
            left: "0px",
            top: `${note.y}px`,
            width: `${colWidth}px`,
            height: `${noteHeight}px`,
            borderRadius: "7px",
            background: style.solid,
          },
        }),
      );
    }

    // Hit lighting: the struck lane glows from the receptor upward.
    if (ci === hitColumn) {
      children.unshift(
        h("div", {
          key: `lit-${ci}`,
          style: {
            position: "absolute",
            left: "0px",
            top: `${receptorY - 260}px`,
            width: `${colWidth}px`,
            height: "260px",
            background: "linear-gradient(to bottom, rgba(255,102,170,0) 0%, rgba(255,102,170,0.38) 100%)",
          },
        }),
      );
    }

    return h(
      "div",
      {
        key: `col-${ci}`,
        style: {
          position: "absolute",
          left: `${colLeft}px`,
          top: "0px",
          width: `${colWidth}px`,
          height: `${height}px`,
          display: "flex",
          background: inner ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.03)",
        },
      },
      children,
    );
  });

  const hitLeft = hitColumn == null ? 0 : padLeft + hitColumn * (colWidth + gap);
  const hitCentre = hitLeft + colWidth / 2;
  // Sparks thrown off the hit, biased upward the way an explosion frame
  // reads at a single instant.
  const sparks: Array<{ dx: number; dy: number; r: number; a: number }> = [
    { dx: -0.72, dy: -46, r: 7, a: 0.85 },
    { dx: 0.66, dy: -62, r: 5, a: 0.7 },
    { dx: -0.34, dy: -96, r: 4, a: 0.5 },
    { dx: 0.9, dy: -18, r: 6, a: 0.6 },
    { dx: -1.02, dy: -12, r: 5, a: 0.45 },
    { dx: 0.28, dy: -130, r: 3, a: 0.35 },
  ];

  return h(
    "div",
    {
      key,
      style: {
        position: "absolute",
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        display: "flex",
        overflow: "hidden",
        opacity,
      },
    },
    [
      ...cols,
      // Receptor glow, then the lit judgement line itself.
      h("div", {
        key: "glow",
        style: {
          position: "absolute",
          left: `${padLeft - 20}px`,
          top: `${receptorY - 170}px`,
          width: `${bandWidth + 40}px`,
          height: "180px",
          background: "linear-gradient(to bottom, rgba(255,102,170,0) 0%, rgba(255,102,170,0.24) 100%)",
        },
      }),
      h("div", {
        key: "receptor",
        style: {
          position: "absolute",
          left: `${padLeft}px`,
          top: `${receptorY}px`,
          width: `${bandWidth}px`,
          height: "5px",
          background: OG_PINK,
        },
      }),
      hitColumn == null
        ? null
        : h("div", {
            key: "burst",
            style: {
              position: "absolute",
              left: `${Math.round(hitCentre - colWidth * 1.15)}px`,
              top: `${receptorY - 84}px`,
              width: `${Math.round(colWidth * 2.3)}px`,
              height: "168px",
              borderRadius: "50%",
              background:
                "radial-gradient(closest-side, rgba(255,255,255,0.55) 0%, rgba(255,102,170,0.45) 38%, rgba(255,102,170,0) 100%)",
            },
          }),
      hitColumn == null
        ? null
        : h("div", {
            key: "flash",
            style: {
              position: "absolute",
              left: `${hitLeft}px`,
              top: `${receptorY - 6}px`,
              width: `${colWidth}px`,
              height: "12px",
              borderRadius: "6px",
              background: "#ffffff",
            },
          }),
      ...(hitColumn == null
        ? []
        : sparks.map((s, i) =>
            h("div", {
              key: `spark-${i}`,
              style: {
                position: "absolute",
                left: `${Math.round(hitCentre + s.dx * colWidth * 0.5 - s.r)}px`,
                top: `${receptorY + s.dy - s.r}px`,
                width: `${s.r * 2}px`,
                height: `${s.r * 2}px`,
                borderRadius: "50%",
                background: "#ffb3d5",
                opacity: s.a,
              },
            }),
          )),
      // Notes fade in at the top rather than getting sliced by the
      // canvas edge, which reads as depth instead of a crop.
      h("div", {
        key: "fade-top",
        style: {
          position: "absolute",
          left: "0px",
          top: "0px",
          width: `${width}px`,
          height: "150px",
          background: `linear-gradient(to bottom, ${SURFACE_COLOR} 0%, rgba(26,22,32,0) 100%)`,
        },
      }),
      // Everything past the judgement line fades out, so the eye stops
      // at the receptor instead of running off the canvas.
      h("div", {
        key: "fade",
        style: {
          position: "absolute",
          left: "0px",
          top: `${receptorY + 8}px`,
          width: `${width}px`,
          height: `${height - receptorY - 8}px`,
          background: "linear-gradient(to bottom, rgba(26,22,32,0.55) 0%, rgba(26,22,32,1) 70%)",
        },
      }),
    ],
  );
}

/* Default layout: shown when nobody has selected a country (bare
   site URL). Brand lockup on the left, a stylised 4K playfield
   bleeding off the right edge. Deliberately not the scrapbook
   language of the country/player cards: this one is the front door,
   so it names the site and its surfaces instead of showing whoever
   happens to be ranked today. It also takes no upstream data, so the
   most-shared card of the site never waits on the osu! API.

   Bump OG_IMAGE_VERSION in src/lib/seo.ts when this layout changes.
*/
async function renderDefaultBrandOg(request: Request): Promise<Response> {
  const [regularFont, heavyFont] = await loadOgFonts(request);

  // Lane 3 is caught exactly on the receptor, which is what the burst,
  // flash and MAX judgement below are reacting to.
  const FIELD_LEFT = 716;
  const FIELD_WIDTH = 484;
  const COL_WIDTH = 96;
  const COL_GAP = 8;
  const RECEPTOR_Y = 500;
  const HIT_COLUMN = 2;
  const bandWidth = 4 * COL_WIDTH + 3 * COL_GAP;
  const bandLeft = FIELD_LEFT + Math.round((FIELD_WIDTH - bandWidth) / 2);
  const hitCentre = bandLeft + HIT_COLUMN * (COL_WIDTH + COL_GAP) + COL_WIDTH / 2;

  // Reads as a real pattern rather than scattered blocks: a roll down
  // the lanes up top, a chord, then a hold and the note being hit.
  const columns: ColumnNote[][] = [
    [{ y: -20 }, { y: 150 }, { y: 268 }, { y: 396 }],
    [{ y: 60 }, { y: 208 }, { y: 340, ln: 88 }],
    [{ y: 24 }, { y: 118 }, { y: 268 }, { y: RECEPTOR_Y - 13 }],
    [{ y: 88 }, { y: 208 }, { y: 470, ln: 120, accent: true }],
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
        // Two washes, warm on the lockup side and cool under the
        // playfield, so the surface isn't a flat sheet of charcoal.
        h("div", {
          key: "wash",
          style: {
            position: "absolute",
            inset: "0",
            background:
              "radial-gradient(circle at 22% 38%, rgba(255,102,170,0.16) 0%, rgba(255,102,170,0) 55%)",
          },
        }),
        h("div", {
          key: "wash-cool",
          style: {
            position: "absolute",
            inset: "0",
            background:
              "radial-gradient(circle at 82% 88%, rgba(142,203,255,0.14) 0%, rgba(142,203,255,0) 52%)",
          },
        }),
        maniaColumns({
          key: "field",
          left: FIELD_LEFT,
          top: 0,
          width: FIELD_WIDTH,
          height: HEIGHT,
          columns,
          colWidth: COL_WIDTH,
          gap: COL_GAP,
          receptorY: RECEPTOR_Y,
          noteHeight: 26,
          hitColumn: HIT_COLUMN,
        }),
        // The judgement for the note being hit, popped next to the
        // burst at in-game scale instead of as a caption over the card.
        h(
          "div",
          {
            key: "judgement",
            style: {
              position: "absolute",
              left: `${Math.round(hitCentre - 80)}px`,
              top: `${RECEPTOR_Y - 116}px`,
              width: "160px",
              display: "flex",
              justifyContent: "center",
              fontSize: "34px",
              fontWeight: 900,
              letterSpacing: "0.2em",
              color: JUDGEMENT_COLORS.MAX,
            },
          },
          "MAX",
        ),
        // Soft separator so the playfield band reads as a panel.
        h("div", {
          key: "edge",
          style: {
            position: "absolute",
            left: `${FIELD_LEFT}px`,
            top: "0px",
            width: "1px",
            height: `${HEIGHT}px`,
            background: "rgba(255,255,255,0.10)",
          },
        }),
        h(
          "div",
          {
            key: "lockup",
            style: {
              position: "absolute",
              left: "80px",
              top: "86px",
              width: "600px",
              display: "flex",
              flexDirection: "column",
            },
          },
          [
            h(
              "div",
              {
                key: "eyebrow",
                style: { display: "flex", alignItems: "center" },
              },
              [
                h("img", {
                  key: "logo",
                  src: new URL("/logo512.png", getAssetOrigin(request)).toString(),
                  style: { width: "54px", height: "54px", borderRadius: "50%" },
                }),
                h(
                  "div",
                  {
                    key: "text",
                    style: {
                      display: "flex",
                      marginLeft: "16px",
                      fontSize: "22px",
                      fontWeight: 900,
                      letterSpacing: "0.26em",
                      color: OG_PINK,
                    },
                  },
                  "OSU!MANIA",
                ),
              ],
            ),
            h(
              "div",
              {
                key: "title",
                style: {
                  display: "flex",
                  marginTop: "16px",
                  fontSize: "92px",
                  fontWeight: 900,
                  lineHeight: "1.0",
                  letterSpacing: "-0.01em",
                  // Satori supports background-clip: text, so the
                  // wordmark can carry the accent instead of sitting
                  // flat white next to a colourful playfield.
                  backgroundImage: "linear-gradient(115deg, #ffffff 34%, #ff9ecd 100%)",
                  backgroundClip: "text",
                  WebkitBackgroundClip: "text",
                  color: "transparent",
                },
              },
              "Mania Tracker",
            ),
            h(
              "div",
              {
                key: "sub",
                style: {
                  display: "flex",
                  marginTop: "20px",
                  fontSize: "27px",
                  color: OG_MUTED,
                  lineHeight: "1.25",
                  maxWidth: "560px",
                },
              },
              "Live scores, rankings and map tools for the mania community.",
            ),
            h(
              "div",
              {
                key: "chips",
                style: { display: "flex", flexWrap: "wrap", marginTop: "16px", maxWidth: "530px" },
              },
              DEFAULT_OG_FEATURES.map((f, i) =>
                featureChip(f, `chip-${i}`, f === "live tracker"),
              ),
            ),
            h(
              "div",
              {
                key: "domain",
                style: {
                  display: "flex",
                  marginTop: "26px",
                  fontSize: "21px",
                  fontWeight: 900,
                  letterSpacing: "0.12em",
                  color: "#6f6579",
                },
              },
              "MANIA-TRACKER.COM",
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
        // card stack. Sub-line echoes the app's own "you could gain"
        // header copy.
        sticker({
          key: "title",
          text: "farm helper",
          subText: "PP YOU COULD GAIN",
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

/* Maps search layout: the global catalog's search tab. A paper search
   bar with a typed query and caret, three result-row cards with real
   cover thumbnails (title/artist stay abstract bars — no fake beatmap
   names), and the search tab's filter chips as small stickers. Cover
   art comes from the same maps snapshot pool the other cards use;
   missing pool just means dark thumbnail blocks. */
function magnifierDataUrl(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="40" cy="40" r="26" fill="none" stroke="${color}" stroke-width="11"/><line x1="60" y1="60" x2="88" y2="88" stroke="${color}" stroke-width="13" stroke-linecap="round"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function searchResultRow(props: {
  cover: string | null;
  titleBarWidth: number;
  subBarWidth: number;
  stars: string;
  keymode: string;
  keymodeColor: string;
  rotate: number;
  top: number;
  left: number;
  key: string;
}) {
  const { cover, titleBarWidth, subBarWidth, stars, keymode, keymodeColor, rotate, top, left, key } = props;
  return h(
    "div",
    {
      key,
      style: {
        position: "absolute",
        top: `${top}px`,
        left: `${left}px`,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        width: "660px",
        padding: "16px 22px",
        background: "#f3ece4",
        boxSizing: "border-box",
        transform: `rotate(${rotate}deg)`,
        gap: "20px",
      },
    },
    [
      h(
        "div",
        {
          key: "thumb",
          style: {
            display: "flex",
            width: "128px",
            height: "72px",
            background: PHOTO_BG_COLOR,
            overflow: "hidden",
            flexShrink: 0,
          },
        },
        cover
          ? h("img", {
              src: cover,
              style: { width: "128px", height: "72px", objectFit: "cover" },
            })
          : null,
      ),
      // Abstract title + artist bars, farm-helper style: honest
      // placeholders instead of invented beatmap names.
      h(
        "div",
        {
          key: "bars",
          style: {
            display: "flex",
            flexDirection: "column",
            flex: "1",
            gap: "12px",
          },
        },
        [
          h("div", {
            key: "title",
            style: { display: "flex", width: `${titleBarWidth}px`, height: "16px", borderRadius: "8px", background: "#cfc4b8" },
          }),
          h("div", {
            key: "sub",
            style: { display: "flex", width: `${subBarWidth}px`, height: "12px", borderRadius: "6px", background: "#ddd3c8" },
          }),
        ],
      ),
      h(
        "div",
        {
          key: "stars",
          style: {
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: "6px",
            flexShrink: 0,
          },
        },
        [
          h("img", { key: "icon", src: starDataUrl("#b3830f"), style: { width: "22px", height: "22px" } }),
          h("div", { key: "num", style: { fontSize: "24px", fontWeight: 900, color: "#1a1317" } }, stars),
        ],
      ),
      h(
        "div",
        {
          key: "keys",
          style: {
            display: "flex",
            padding: "5px 12px",
            background: keymodeColor,
            color: "#1a1317",
            fontSize: "22px",
            fontWeight: 900,
            lineHeight: "1.0",
            flexShrink: 0,
          },
        },
        keymode,
      ),
    ],
  );
}

async function renderMapsSearchOg(request: Request): Promise<Response> {
  const [regularFont, heavyFont] = await loadOgFonts(request);

  // The real top results for "chordjack 4k" (playcount sort): covers and star
  // ratings are the genuine maps, so the example search holds up to scrutiny.
  // The bars still stand in for title/artist, farm-helper style.
  const rows = [
    // davay rasskazhem (ily Frenchcore Remix) [4K] d-_-b
    { cover: "https://assets.ppy.sh/beatmaps/2087660/covers/cover@2x.jpg", stars: "5.47", keymode: "4K", keymodeColor: "#66ccff", titleBarWidth: 260, subBarWidth: 170, rotate: -1.0, top: 178, left: 440 },
    // tp na ame [4K] krip kripochek
    { cover: "https://assets.ppy.sh/beatmaps/2004998/covers/cover@2x.jpg", stars: "5.26", keymode: "4K", keymodeColor: "#66ccff", titleBarWidth: 220, subBarWidth: 190, rotate: 0.9, top: 316, left: 470 },
    // 166 - Suzuya Homerarete Nobiru Type Nandesu. [4K] Hydria's Insane
    { cover: "https://assets.ppy.sh/beatmaps/717834/covers/cover@2x.jpg", stars: "4.04", keymode: "4K", keymodeColor: "#66ccff", titleBarWidth: 280, subBarWidth: 150, rotate: -0.7, top: 454, left: 450 },
  ];

  // Filter-chip stickers on the left rail: the real search filters.
  const chips = [
    { text: "4K", background: "#66ccff", top: 250, left: 96, rotate: -5 },
    { text: "7K", background: "#c98bff", top: 252, left: 196, rotate: 4 },
    { text: "ranked", background: "#f3ece4", top: 330, left: 110, rotate: -3 },
    { text: "loved", background: "#ff99cc", top: 402, left: 150, rotate: 5 },
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
        // Search bar: paper card with magnifier, typed query, and caret.
        h(
          "div",
          {
            key: "searchbar",
            style: {
              position: "absolute",
              top: "48px",
              left: "440px",
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              width: "680px",
              padding: "20px 26px",
              background: "#f3ece4",
              boxSizing: "border-box",
              transform: "rotate(-1.2deg)",
              gap: "18px",
            },
          },
          [
            h("img", { key: "mag", src: magnifierDataUrl("#1a1317"), style: { width: "38px", height: "38px" } }),
            h(
              "div",
              { key: "query", style: { fontSize: "36px", fontWeight: 900, color: "#1a1317", lineHeight: "1.0" } },
              "chordjack 4k",
            ),
            h("div", {
              key: "caret",
              style: { display: "flex", width: "6px", height: "40px", background: "#ff66aa" },
            }),
          ],
        ),

        ...rows.map((row, i) =>
          searchResultRow({
            key: `row-${i}`,
            cover: row.cover,
            titleBarWidth: row.titleBarWidth,
            subBarWidth: row.subBarWidth,
            stars: row.stars,
            keymode: row.keymode,
            keymodeColor: row.keymodeColor,
            rotate: row.rotate,
            top: row.top,
            left: row.left,
          }),
        ),

        ...chips.map((chip, i) =>
          sticker({
            key: `chip-${i}`,
            text: chip.text,
            fontSize: 26,
            background: chip.background,
            color: "#1a1317",
            paddingX: 14,
            paddingY: 10,
            rotate: chip.rotate,
            top: chip.top,
            left: chip.left,
          }),
        ),

        // Title sticker, top-left.
        sticker({
          key: "title",
          text: "map search",
          subText: "EVERY RANKED MANIA MAP",
          fontSize: 58,
          background: "#ff66aa",
          color: "#1a1317",
          paddingX: 26,
          paddingY: 18,
          rotate: -3,
          top: 60,
          left: 60,
        }),

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
          left: 74,
        }),
      ],
    ),
    { width: WIDTH, height: HEIGHT, fonts: ogFontList(regularFont, heavyFont) },
  );
  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

/* Maps collections layout: three stacks of cover cards, one per pattern
   collection, labelled with real pattern archetypes and star buckets
   (the collections tab's actual grouping). Each stack is two tilted
   backing covers under a captioned polaroid, so it reads as "sets of
   maps" at a glance. */
function collectionStack(props: {
  covers: Array<string | null>;
  label: string;
  bucket: string;
  badge?: string;
  badgeColor?: string;
  top: number;
  left: number;
  key: string;
}) {
  const { covers, label, bucket, badge, badgeColor, top, left, key } = props;
  const backSize = 210;
  const backHeight = Math.round(backSize * 0.56);
  const back = (cover: string | null, dx: number, dy: number, rotate: number, backKey: string) =>
    h(
      "div",
      {
        key: backKey,
        style: {
          position: "absolute",
          top: `${top + dy}px`,
          left: `${left + dx}px`,
          display: "flex",
          width: `${backSize + 20}px`,
          height: `${backHeight + 20}px`,
          padding: "10px",
          background: POLAROID_FRAME_COLOR,
          boxSizing: "border-box",
          transform: `rotate(${rotate}deg)`,
        },
      },
      h(
        "div",
        { style: { display: "flex", width: `${backSize}px`, height: `${backHeight}px`, background: PHOTO_BG_COLOR, overflow: "hidden" } },
        cover
          ? h("img", { src: cover, style: { width: `${backSize}px`, height: `${backHeight}px`, objectFit: "cover" } })
          : null,
      ),
    );

  return [
    back(covers[1] ?? null, -26, 26, -7, `${key}-b1`),
    back(covers[2] ?? null, 60, 40, 6, `${key}-b2`),
    polaroid({
      key: `${key}-front`,
      imgSrc: covers[0] ?? "",
      variant: "flag",
      caption: label,
      subCaption: bucket,
      captionFontSize: 30,
      size: 250,
      rotate: -1.5,
      top,
      left,
      badge,
      badgeColor,
    }),
  ];
}

async function renderMapsCollectionsOg(request: Request): Promise<Response> {
  const [regularFont, heavyFont] = await loadOgFonts(request);

  // Three real collections (pattern x keymode x dan bucket), each stack built
  // from actual member covers of that collection, so the card's example
  // groupings hold up to scrutiny.
  const stacks = [
    {
      // Jumpstream · 4K · 7-8 dan
      label: "jumpstream",
      bucket: "4K · 7-8 dan",
      covers: [
        "https://assets.ppy.sh/beatmaps/420394/covers/cover@2x.jpg",
        "https://assets.ppy.sh/beatmaps/2203988/covers/cover@2x.jpg",
        "https://assets.ppy.sh/beatmaps/1629872/covers/cover@2x.jpg",
      ],
      top: 200,
      left: 96,
    },
    {
      // Chordjack · 4K · 9-10 dan
      label: "chordjack",
      bucket: "4K · 9-10 dan",
      covers: [
        "https://assets.ppy.sh/beatmaps/1108344/covers/cover@2x.jpg",
        "https://assets.ppy.sh/beatmaps/2024519/covers/cover@2x.jpg",
        "https://assets.ppy.sh/beatmaps/500905/covers/cover@2x.jpg",
      ],
      top: 168,
      left: 470,
      badge: "40 maps",
      badgeColor: "#ff66aa",
    },
    {
      // LN · 7K · 7-8 dan
      label: "long notes",
      bucket: "7K · 7-8 dan",
      covers: [
        "https://assets.ppy.sh/beatmaps/1192129/covers/cover@2x.jpg",
        "https://assets.ppy.sh/beatmaps/1052801/covers/cover@2x.jpg",
        "https://assets.ppy.sh/beatmaps/686472/covers/cover@2x.jpg",
      ],
      top: 212,
      left: 844,
    },
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
        ...stacks.flatMap((stack, i) =>
          collectionStack({
            key: `stack-${i}`,
            covers: stack.covers,
            label: stack.label,
            bucket: stack.bucket,
            badge: stack.badge,
            badgeColor: stack.badgeColor,
            top: stack.top,
            left: stack.left,
          }),
        ),

        sticker({
          key: "title",
          text: "collections",
          subText: "MANIA MAPS BY PATTERN AND DAN",
          fontSize: 58,
          background: "#ff66aa",
          color: "#1a1317",
          paddingX: 26,
          paddingY: 18,
          rotate: -3,
          top: 44,
          left: 60,
        }),

        sticker({
          key: "brand",
          text: "Mania Tracker",
          fontSize: 16,
          background: "#f3ece4",
          color: "#1a1317",
          paddingX: 10,
          paddingY: 6,
          rotate: 2,
          top: 566,
          left: 1006,
        }),
      ],
    ),
    { width: WIDTH, height: HEIGHT, fonts: ogFontList(regularFont, heavyFont) },
  );
  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

/* Card packs layout: a hand of five mini maniacards fanned out, one per
   rarity tier, using the real tier gradients + triangle texture from
   the in-app card (that colour ramp IS the tier identity). The player
   slot on each card is a "?" — you don't know who you'll pull until
   you tear the pack open. */
/* Badge tile + mania glyph baked into one padded SVG. Satori can clip image
   contents strangely inside rotated cards; the extra transparent margin gives
   that clipping room so the rounded badge corners and real glyph survive. */
function packBadgeDataUrl(): string {
  const scale = (52 / 1080).toFixed(5);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">` +
    `<rect x="21.5" y="21.5" width="85" height="85" rx="20" fill="#000000" fill-opacity="0.22" stroke="#ffffff" stroke-opacity="0.34" stroke-width="3"/>` +
    `<g transform="translate(38,38) scale(${scale}) translate(40,40) matrix(1,0,0,-1,0,860)"><path d="${MANIA_GLYPH_D}" fill="#ffffff"/></g>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function packBadge(key: string) {
  return h("img", {
    key,
    src: packBadgeDataUrl(),
    style: { position: "absolute", top: "8px", left: "8px", width: "64px", height: "64px" },
  });
}

function packCard(props: {
  tier: ManiaCardTier;
  rotate: number;
  top: number;
  left: number;
  key: string;
}) {
  const { tier, rotate, top, left, key } = props;
  const style = MANIA_TIER_STYLES[tier];
  const cosmic = getCosmicTierPalette(tier);
  const W = 220;
  const H = 312;
  // Keep images as direct children of the rotated card. Nested images drift
  // under Satori transforms, while direct images stay anchored.
  return h(
    "div",
    {
      key,
      style: {
        position: "absolute",
        top: `${top}px`,
        left: `${left}px`,
        display: "flex",
        width: `${W}px`,
        height: `${H}px`,
        borderRadius: "16px",
        border: "3px solid rgba(255,255,255,0.30)",
        boxSizing: "border-box",
        background: cosmic ? "#000000" : style.badgeGradient,
        overflow: "hidden",
        transform: `rotate(${rotate}deg)`,
        boxShadow: `0 0 34px ${style.glowColor}`,
      },
    },
    [
      // Same swap the full card makes: the cosmic tiers get their starfield
      // front instead of the tier gradient and its triangle flecks.
      h("img", {
        key: "tris",
        src: cosmic ? cosmicBackgroundDataUrl(cosmic) : triangleOverlayDataUrl(W, H),
        style: { position: "absolute", top: "0", left: "0", width: `${W}px`, height: `${H}px` },
      }),
      // Mini mode badge + blank name plate, echoing the full card's header.
      packBadge("badge"),
      h("div", {
        key: "plate",
        style: {
          position: "absolute",
          top: "29px",
          left: "74px",
          width: "124px",
          height: "22px",
          borderRadius: "7px",
          background: "rgba(0,0,0,0.32)",
        },
      }),
      // Mystery player slot.
      h(
        "div",
        {
          key: "slot",
          style: {
            position: "absolute",
            top: "78px",
            left: "30px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "160px",
            height: "150px",
            borderRadius: "12px",
            background: "rgba(0,0,0,0.28)",
            border: "3px solid rgba(255,255,255,0.16)",
            boxSizing: "border-box",
          },
        },
        h(
          "div",
          { style: { fontSize: "84px", fontWeight: 900, color: "rgba(255,255,255,0.55)", lineHeight: "1.0" } },
          "?",
        ),
      ),
      // No tier labels: naming the top card gives away a rarity the packs
      // page never spoils before you open one. The ramp is carried by the
      // colours alone.
    ],
  );
}

async function renderPacksOg(request: Request): Promise<Response> {
  const [regularFont, heavyFont] = await loadOgFonts(request);

  // Rarity ramp fanned left to right (five of the ten tiers, in
  // order), unlabelled: the colours carry the ramp and nothing names the
  // rarity on top. Tilts stay within ~7deg: Satori offsets images inside
  // rotated subtrees proportionally to the angle, so steeper fans smear
  // the badge art off the cards.
  const fan: Array<{ tier: ManiaCardTier; rotate: number; top: number; left: number }> = [
    { tier: "common", rotate: -7, top: 200, left: 548 },
    { tier: "rare", rotate: -3.5, top: 176, left: 654 },
    { tier: "legendary", rotate: 0, top: 164, left: 760 },
    { tier: "ascendant", rotate: 3.5, top: 176, left: 866 },
    { tier: "worldClass", rotate: 7, top: 200, left: 950 },
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
        ...fan.map((slot, i) =>
          packCard({
            key: `card-${i}`,
            tier: slot.tier,
            rotate: slot.rotate,
            top: slot.top,
            left: slot.left,
          }),
        ),

        // Pack sizes differ per pack type, so the sticker stays a title:
        // no count, and no rarity legend under it.
        sticker({
          key: "title",
          text: "card packs",
          fontSize: 72,
          background: "#ff66aa",
          color: "#1a1317",
          paddingX: 30,
          paddingY: 22,
          rotate: -2,
          // Dropping the subtitle shortens the sticker by 24px; half that
          // keeps the title on the centre line it sat on before.
          top: 248,
          left: 70,
        }),

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
          left: 74,
        }),
      ],
    ),
    { width: WIDTH, height: HEIGHT, fonts: ogFontList(regularFont, heavyFont) },
  );
  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

/* Skins layout: the falling-note rain from the skins page frozen
   mid-fall. The scatter reuses the sprites ManiaRain drops, at mixed
   sizes and opacities for depth, two of them stretched into long notes
   (rounded body trailing above the head, ManiaRain's LN shape), plus a
   few colour-matched streaks so the fall still reads in a still. */
interface SkinsOgNote {
  img: string; // file name under /images/notes, without extension
  x: number; // centre of the note head on the canvas
  y: number;
  size: number; // head box; bars draw at ManiaRain's 1.4w x 0.3h of this
  rotate?: number;
  opacity: number;
  lnHeight?: number; // long note: body extends this far above the head
  trail?: string; // motion streak colour fading in above the head
}

// Listed back-to-front: faint background notes first so brighter
// foreground notes overlap them, stickers draw over everything.
const SKINS_OG_NOTES: SkinsOgNote[] = [
  { img: "circle-pink", x: 726, y: 96, size: 28, rotate: 40, opacity: 0.25 },
  { img: "circle-green", x: 516, y: 306, size: 26, rotate: -20, opacity: 0.2 },
  { img: "circle-blue", x: 1084, y: 614, size: 24, rotate: 10, opacity: 0.3 },
  { img: "circle-white", x: 68, y: 352, size: 26, rotate: -12, opacity: 0.25 },
  { img: "circle-white", x: 486, y: 478, size: 34, rotate: -35, opacity: 0.35 },
  { img: "circle-gray", x: 146, y: 472, size: 42, rotate: 22, opacity: 0.4 },
  { img: "circle-navy", x: 972, y: 306, size: 40, rotate: 15, opacity: 0.45 },
  { img: "arrow-down-gray", x: 298, y: 170, size: 44, rotate: 10, opacity: 0.45 },
  { img: "circle-white", x: 1146, y: 196, size: 42, rotate: -32, opacity: 0.5 },
  { img: "circle-violet", x: 66, y: 204, size: 38, rotate: -25, opacity: 0.5 },
  { img: "bar-blue", x: 588, y: 586, size: 52, rotate: 6, opacity: 0.5 },
  { img: "bar-gray", x: 556, y: 138, size: 58, rotate: -12, opacity: 0.55 },
  { img: "arrow-left-gray", x: 394, y: 64, size: 50, rotate: 20, opacity: 0.6 },
  { img: "circle-blue-light", x: 648, y: 54, size: 46, rotate: 30, opacity: 0.6 },
  { img: "bar-blue", x: 668, y: 568, size: 62, opacity: 0.62, lnHeight: 150 },
  { img: "arrow-right-green", x: 838, y: 252, size: 54, rotate: -10, opacity: 0.65 },
  { img: "circle-blue", x: 338, y: 516, size: 54, rotate: 18, opacity: 0.7 },
  { img: "circle-purple", x: 1122, y: 514, size: 54, rotate: 38, opacity: 0.7 },
  { img: "bar-red", x: 1158, y: 342, size: 68, rotate: -6, opacity: 0.75 },
  { img: "bar-yellow", x: 1032, y: 84, size: 88, rotate: 7, opacity: 0.8 },
  { img: "circle-green", x: 924, y: 556, size: 58, rotate: 24, opacity: 0.85, trail: "rgba(166,228,120,0.3)" },
  { img: "circle-pink", x: 176, y: 96, size: 64, rotate: -15, opacity: 0.9, trail: "rgba(255,131,192,0.3)" },
  { img: "circle-blue", x: 872, y: 138, size: 74, rotate: -18, opacity: 0.9, trail: "rgba(102,186,255,0.3)" },
  { img: "arrow-up-pink", x: 748, y: 338, size: 78, rotate: 12, opacity: 0.95, trail: "rgba(255,131,192,0.3)" },
  { img: "circle-pink-glow", x: 1048, y: 442, size: 92, opacity: 0.95, lnHeight: 230 },
];

function skinsFallingNote(src: string, note: SkinsOgNote, key: string): ReactNode[] {
  const isBar = note.img.startsWith("bar");
  const headW = isBar ? note.size * 1.4 : note.size;
  const headH = isBar ? note.size * 0.3 : note.size;
  const parts: ReactNode[] = [];

  if (note.trail) {
    // Wide, short, and ending under the head centre so it reads as motion
    // blur; a narrow line reads as a string the note hangs from instead.
    const trailW = Math.round(note.size * 0.5);
    const trailH = Math.round(note.size * 1.8);
    parts.push(
      h("div", {
        key: `${key}-trail`,
        style: {
          position: "absolute",
          left: `${Math.round(note.x - trailW / 2)}px`,
          top: `${Math.round(note.y - trailH)}px`,
          width: `${trailW}px`,
          height: `${trailH}px`,
          borderRadius: `${trailW / 2}px`,
          background: `linear-gradient(to bottom, rgba(0,0,0,0) 0%, ${note.trail} 100%)`,
          opacity: note.opacity,
        },
      }),
    );
  }

  if (note.lnHeight) {
    // The body's flat bottom ends at the head centre, so the opaque
    // middle of the head sprite covers the seam (ManiaRain punches the
    // head out of the body instead, which Satori can't do).
    const bodyW = Math.round(note.size * 0.5);
    parts.push(
      h("div", {
        key: `${key}-body`,
        style: {
          position: "absolute",
          left: `${Math.round(note.x - bodyW / 2)}px`,
          top: `${Math.round(note.y - note.lnHeight)}px`,
          width: `${bodyW}px`,
          height: `${note.lnHeight}px`,
          borderTopLeftRadius: `${bodyW / 2}px`,
          borderTopRightRadius: `${bodyW / 2}px`,
          background: "rgba(255,255,255,0.3)",
          opacity: note.opacity,
        },
      }),
    );
  }

  parts.push(
    h("img", {
      key: `${key}-head`,
      src,
      style: {
        position: "absolute",
        left: `${Math.round(note.x - headW / 2)}px`,
        top: `${Math.round(note.y - headH / 2)}px`,
        width: `${Math.round(headW)}px`,
        height: `${Math.round(headH)}px`,
        opacity: note.opacity,
        ...(note.rotate ? { transform: `rotate(${note.rotate}deg)` } : {}),
      },
    }),
  );

  return parts;
}

async function renderSkinsOg(request: Request): Promise<Response> {
  const [regularFont, heavyFont] = await loadOgFonts(request);
  const origin = getAssetOrigin(request);

  // Sequential on purpose: the dev server serving this route also serves
  // the sprites, and a parallel burst is what broke satori's own loading.
  const sprites = new Map<string, string>();
  for (const img of new Set(SKINS_OG_NOTES.map((note) => note.img))) {
    sprites.set(img, await getNoteSpriteDataUrl(origin, img));
  }

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
        ...SKINS_OG_NOTES.flatMap((note, i) =>
          skinsFallingNote(sprites.get(note.img) ?? "", note, `note-${i}`),
        ),

        sticker({
          key: "title",
          text: "skins",
          subText: "PREVIEWS FROM EACH SKIN'S OWN NOTES",
          fontSize: 72,
          background: "#ff66aa",
          color: "#1a1317",
          paddingX: 30,
          paddingY: 22,
          rotate: -2,
          top: 236,
          left: 70,
        }),

        sticker({
          key: "how",
          text: "browse, download, or publish an .osk",
          fontSize: 24,
          background: "#f3ece4",
          color: "#1a1317",
          paddingX: 14,
          paddingY: 10,
          rotate: 2,
          top: 404,
          left: 96,
        }),

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
          left: 74,
        }),
      ],
    ),
    { width: WIDTH, height: HEIGHT, fonts: ogFontList(regularFont, heavyFont) },
  );
  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

/* BBCode editor layout: the tool is a visual editor, not a text field
   you type tags into, so the card leads with the editor window — a
   formatting toolbar over a paper page of already-styled content — and
   keeps the markup off to the side as dimmed output under a Copy
   button. The two corner stickers name which half is yours. */
const BB_ICON_STROKE = "#d9d3e2";

function bbIconUrl(inner: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ` +
    `stroke="${BB_ICON_STROKE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

const BB_LINK_ICON = bbIconUrl(
  `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>` +
    `<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`,
);
const BB_IMAGE_ICON = bbIconUrl(
  `<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/>` +
    `<path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>`,
);

/* Toolbar key: a 36px square with either a letter glyph or an icon in it. */
function bbToolButton(key: string, child: ReactNode) {
  return h(
    "div",
    {
      key,
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "36px",
        height: "36px",
        borderRadius: "8px",
        background: "rgba(255,255,255,0.06)",
        flexShrink: 0,
      },
    },
    child,
  );
}

function bbGlyphButton(key: string, glyph: string, extra: Record<string, string> = {}) {
  return bbToolButton(
    key,
    h(
      "div",
      {
        key: "g",
        style: {
          fontSize: "20px",
          fontWeight: 900,
          color: "#e8e3ec",
          lineHeight: "1.0",
          ...extra,
        },
      },
      glyph,
    ),
  );
}

function bbIconButton(key: string, src: string) {
  return bbToolButton(key, h("img", { key: "i", src, style: { width: "20px", height: "20px" } }));
}

function bbToolDivider(key: string) {
  return h("div", {
    key,
    style: { display: "flex", width: "1px", height: "22px", background: "rgba(255,255,255,0.16)", flexShrink: 0 },
  });
}

/* One line of generated markup in the output strip. Dimmed on purpose:
   it's what the editor hands you, not something you sit and type. */
function bbcodeLine(key: string, tokens: Array<{ text: string; muted?: boolean }>) {
  return h(
    "div",
    { key, style: { display: "flex", flexDirection: "row" } },
    tokens.map((token, i) =>
      h(
        "div",
        {
          key: `t-${i}`,
          style: {
            fontSize: "18px",
            fontWeight: token.muted ? 400 : 900,
            color: token.muted ? "#736d80" : "#b7b1c2",
            lineHeight: "1.0",
            whiteSpace: "pre",
          },
        },
        token.text,
      ),
    ),
  );
}

async function renderBBCodeOg(request: Request): Promise<Response> {
  const [regularFont, heavyFont] = await loadOgFonts(request);

  const PINK = "#ff66aa";
  const PAPER = "#f3ece4";
  const INK = "#1a1317";

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
        // Editor window: toolbar over the page you're styling.
        h(
          "div",
          {
            key: "editor",
            style: {
              position: "absolute",
              top: "208px",
              left: "76px",
              display: "flex",
              flexDirection: "column",
              width: "630px",
              height: "340px",
              background: PHOTO_BG_COLOR,
              border: "1px solid rgba(255,255,255,0.10)",
              borderRadius: "12px",
              boxSizing: "border-box",
              overflow: "hidden",
              transform: "rotate(-1.4deg)",
            },
          },
          [
            // Formatting toolbar: the buttons are the whole point.
            h(
              "div",
              {
                key: "toolbar",
                style: {
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: "8px",
                  padding: "13px 16px",
                  borderBottom: "1px solid rgba(255,255,255,0.10)",
                },
              },
              [
                bbGlyphButton("b", "B"),
                bbGlyphButton("i", "I", { fontStyle: "italic", transform: "skewX(-12deg)" }),
                bbGlyphButton("u", "U", { textDecoration: "underline" }),
                bbGlyphButton("s", "S", { textDecoration: "line-through" }),
                bbToolDivider("d1"),
                bbToolButton(
                  "color",
                  h("div", {
                    key: "swatch",
                    style: { display: "flex", width: "18px", height: "18px", borderRadius: "9px", background: PINK },
                  }),
                ),
                bbIconButton("link", BB_LINK_ICON),
                bbIconButton("image", BB_IMAGE_ICON),
                bbToolDivider("d2"),
                bbGlyphButton("h", "H"),
                // Mode toggle, sitting where it sits in the real editor.
                h(
                  "div",
                  {
                    key: "modes",
                    style: { display: "flex", flexDirection: "row", alignItems: "center", gap: "6px", marginLeft: "auto" },
                  },
                  [
                    h(
                      "div",
                      {
                        key: "visual",
                        style: {
                          display: "flex",
                          padding: "7px 12px",
                          borderRadius: "7px",
                          background: PINK,
                          color: INK,
                          fontSize: "15px",
                          fontWeight: 900,
                          lineHeight: "1.0",
                          letterSpacing: "0.04em",
                        },
                      },
                      "VISUAL",
                    ),
                    h(
                      "div",
                      {
                        key: "source",
                        style: {
                          display: "flex",
                          padding: "7px 12px",
                          borderRadius: "7px",
                          color: "rgba(255,255,255,0.42)",
                          fontSize: "15px",
                          fontWeight: 900,
                          lineHeight: "1.0",
                          letterSpacing: "0.04em",
                        },
                      },
                      "BBCODE",
                    ),
                  ],
                ),
              ],
            ),

            // The page itself: already styled, no tags in sight.
            h(
              "div",
              {
                key: "page",
                style: {
                  display: "flex",
                  flexDirection: "column",
                  flex: "1",
                  background: PAPER,
                  padding: "26px 28px",
                  gap: "18px",
                },
              },
              [
                h(
                  "div",
                  { key: "p1", style: { fontSize: "30px", fontWeight: 900, color: INK, lineHeight: "1.0" } },
                  "about me",
                ),
                // Body copy as bars: the card is about the tool, not about
                // whatever sentence a profile happens to have on it.
                h("div", {
                  key: "p2",
                  style: { display: "flex", width: "420px", height: "12px", borderRadius: "6px", background: "#d6cabb" },
                }),
                h("div", {
                  key: "p3",
                  style: { display: "flex", width: "300px", height: "12px", borderRadius: "6px", background: "#d6cabb" },
                }),
                // Image placeholder standing in for a maniacard, centred the
                // way a profile image usually is.
                h("div", {
                  key: "p4",
                  style: {
                    display: "flex",
                    alignSelf: "center",
                    width: "250px",
                    height: "74px",
                    borderRadius: "6px",
                    background: "#cfc4b8",
                  },
                }),
                h("div", {
                  key: "p5",
                  style: { display: "flex", width: "360px", height: "12px", borderRadius: "6px", background: "#d6cabb" },
                }),
              ],
            ),
          ],
        ),

        // Output strip: the markup the editor produced, plus the copy button.
        h(
          "div",
          {
            key: "output",
            style: {
              position: "absolute",
              top: "244px",
              left: "744px",
              display: "flex",
              flexDirection: "column",
              width: "382px",
              height: "270px",
              padding: "26px 24px",
              background: PHOTO_BG_COLOR,
              border: "1px solid rgba(255,255,255,0.10)",
              borderRadius: "12px",
              boxSizing: "border-box",
              transform: "rotate(1.4deg)",
              gap: "18px",
            },
          },
          [
            bbcodeLine("l1", [
              { text: "[b]", muted: true },
              { text: "about me" },
              { text: "[/b]", muted: true },
            ]),
            bbcodeLine("l2", [{ text: "[centre]", muted: true }]),
            bbcodeLine("l3", [
              { text: "  [img]", muted: true },
              { text: "maniacard.png" },
              { text: "[/img]", muted: true },
            ]),
            bbcodeLine("l4", [{ text: "[/centre]", muted: true }]),
            h(
              "div",
              {
                key: "copy",
                style: {
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  marginTop: "auto",
                  padding: "13px 18px",
                  borderRadius: "9px",
                  background: PINK,
                  color: INK,
                  fontSize: "22px",
                  fontWeight: 900,
                  lineHeight: "1.0",
                },
              },
              "Copy BBCode",
            ),
          ],
        ),

        // One label, on the half you never touch.
        sticker({
          key: "tags",
          text: "paste into your me! page",
          fontSize: 22,
          background: "#ff99cc",
          color: INK,
          paddingX: 12,
          paddingY: 8,
          rotate: 2,
          top: 212,
          left: 762,
        }),

        sticker({
          key: "title",
          text: "bbcode editor",
          subText: "OSU! PROFILE EDITOR",
          fontSize: 64,
          background: PINK,
          color: INK,
          paddingX: 28,
          paddingY: 20,
          rotate: -3,
          top: 42,
          left: 60,
        }),

        sticker({
          key: "brand",
          text: "Mania Tracker",
          fontSize: 16,
          background: PAPER,
          color: INK,
          paddingX: 10,
          paddingY: 6,
          rotate: 2,
          top: 570,
          left: 1006,
        }),
      ],
    ),
    { width: WIDTH, height: HEIGHT, fonts: ogFontList(regularFont, heavyFont) },
  );
  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

/* Discord (maniabot) layout: a Discord-style chat panel — someone runs
   a slash command, maniabot answers with an embed — next to a blurple
   title sticker and a few real command chips. The panel stays untilted
   so it reads as an app window, not a scrapbook card. */
const DISCORD_BLURPLE = "#5865F2";
const DISCORD_SURFACE = "#313338";
const DISCORD_EMBED = "#2b2d31";
const DISCORD_MUTED = "#4e5058";

function discordUserRow(key: string, command: string) {
  return h(
    "div",
    { key, style: { display: "flex", flexDirection: "row", gap: "16px" } },
    [
      h("div", {
        key: "avatar",
        style: { display: "flex", width: "44px", height: "44px", borderRadius: "22px", background: DISCORD_MUTED, flexShrink: 0 },
      }),
      h(
        "div",
        { key: "body", style: { display: "flex", flexDirection: "column", gap: "10px", paddingTop: "4px" } },
        [
          h("div", {
            key: "name",
            style: { display: "flex", width: "110px", height: "12px", borderRadius: "6px", background: DISCORD_MUTED },
          }),
          h(
            "div",
            {
              key: "cmd",
              style: {
                display: "flex",
                padding: "6px 12px",
                borderRadius: "6px",
                background: "rgba(88,101,242,0.30)",
                color: "#c9cdfb",
                fontSize: "24px",
                fontWeight: 900,
                lineHeight: "1.0",
              },
            },
            command,
          ),
        ],
      ),
    ],
  );
}

async function renderDiscordOg(request: Request): Promise<Response> {
  const [regularFont, heavyFont] = await loadOgFonts(request);
  const botAvatarUrl = new URL("/images/discord/bot-avatar.png", getAssetOrigin(request)).toString();

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
        // Chat panel.
        h(
          "div",
          {
            key: "chat",
            style: {
              position: "absolute",
              top: "64px",
              left: "510px",
              display: "flex",
              flexDirection: "column",
              width: "620px",
              height: "502px",
              padding: "28px 30px",
              borderRadius: "14px",
              background: DISCORD_SURFACE,
              boxSizing: "border-box",
              gap: "24px",
            },
          },
          [
            discordUserRow("user1", "/recent"),

            // maniabot reply with embed.
            h(
              "div",
              { key: "bot", style: { display: "flex", flexDirection: "row", gap: "16px" } },
              [
                h("img", {
                  key: "avatar",
                  src: botAvatarUrl,
                  style: { width: "44px", height: "44px", borderRadius: "22px", flexShrink: 0 },
                }),
                h(
                  "div",
                  { key: "body", style: { display: "flex", flexDirection: "column", gap: "10px", paddingTop: "2px" } },
                  [
                    h(
                      "div",
                      { key: "name", style: { display: "flex", flexDirection: "row", alignItems: "center", gap: "8px" } },
                      [
                        h("div", { key: "n", style: { fontSize: "22px", fontWeight: 900, color: "#ffffff", lineHeight: "1.0" } }, "maniabot"),
                        h(
                          "div",
                          {
                            key: "badge",
                            style: {
                              display: "flex",
                              padding: "3px 7px",
                              borderRadius: "4px",
                              background: DISCORD_BLURPLE,
                              color: "#ffffff",
                              fontSize: "13px",
                              fontWeight: 900,
                              lineHeight: "1.0",
                              letterSpacing: "0.04em",
                            },
                          },
                          "APP",
                        ),
                      ],
                    ),
                    h(
                      "div",
                      {
                        key: "embed",
                        style: {
                          display: "flex",
                          flexDirection: "row",
                          borderRadius: "8px",
                          overflow: "hidden",
                          background: DISCORD_EMBED,
                        },
                      },
                      [
                        h("div", { key: "bar", style: { display: "flex", width: "5px", background: "#ff66aa", flexShrink: 0 } }),
                        h(
                          "div",
                          { key: "content", style: { display: "flex", flexDirection: "column", padding: "18px 22px", gap: "14px", width: "440px" } },
                          [
                            h("div", {
                              key: "title",
                              style: { display: "flex", width: "240px", height: "14px", borderRadius: "7px", background: DISCORD_MUTED },
                            }),
                            h(
                              "div",
                              { key: "stats", style: { display: "flex", flexDirection: "row", alignItems: "center", gap: "16px" } },
                              [
                                h("img", { key: "grade", src: gradeImgUrl(request, "S"), style: { width: "64px", height: "32px" } }),
                                h("div", { key: "pp", style: { fontSize: "30px", fontWeight: 900, color: "#ff66aa", lineHeight: "1.0" } }, "264pp"),
                                h("div", { key: "acc", style: { fontSize: "22px", color: "#b5bac1", lineHeight: "1.0" } }, "98.12%"),
                              ],
                            ),
                            h("div", {
                              key: "body1",
                              style: { display: "flex", width: "330px", height: "10px", borderRadius: "5px", background: "#3f4147" },
                            }),
                            h("div", {
                              key: "body2",
                              style: { display: "flex", width: "260px", height: "10px", borderRadius: "5px", background: "#3f4147" },
                            }),
                          ],
                        ),
                      ],
                    ),
                  ],
                ),
              ],
            ),

            discordUserRow("user2", "/farm"),

            // Message input bar pinned to the panel's bottom.
            h(
              "div",
              {
                key: "input",
                style: {
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                  marginTop: "auto",
                  padding: "12px 16px",
                  borderRadius: "10px",
                  background: "#383a40",
                  gap: "14px",
                },
              },
              [
                h("div", {
                  key: "plus",
                  style: { display: "flex", width: "26px", height: "26px", borderRadius: "13px", background: DISCORD_MUTED, flexShrink: 0 },
                }),
                h("div", {
                  key: "ph",
                  style: { display: "flex", width: "190px", height: "12px", borderRadius: "6px", background: DISCORD_MUTED },
                }),
              ],
            ),
          ],
        ),

        // Blurple title sticker.
        sticker({
          key: "title",
          text: "maniabot",
          subText: "MANIA HUB FOR DISCORD",
          fontSize: 72,
          background: DISCORD_BLURPLE,
          color: "#ffffff",
          paddingX: 30,
          paddingY: 22,
          rotate: -2,
          top: 150,
          left: 70,
        }),

        // Real slash-command chips.
        sticker({
          key: "cmd1",
          text: "/maniacard",
          fontSize: 24,
          background: "#f3ece4",
          color: DISCORD_BLURPLE,
          paddingX: 14,
          paddingY: 10,
          rotate: -4,
          top: 330,
          left: 90,
        }),
        sticker({
          key: "cmd2",
          text: "/rankings",
          fontSize: 24,
          background: "#f3ece4",
          color: DISCORD_BLURPLE,
          paddingX: 14,
          paddingY: 10,
          rotate: 3,
          top: 392,
          left: 170,
        }),
        sticker({
          key: "cmd3",
          text: "/snipes",
          fontSize: 24,
          background: "#f3ece4",
          color: DISCORD_BLURPLE,
          paddingX: 14,
          paddingY: 10,
          rotate: -2,
          top: 456,
          left: 104,
        }),

        sticker({
          key: "brand",
          text: "Mania Tracker",
          fontSize: 16,
          background: "#f3ece4",
          color: "#1a1317",
          paddingX: 10,
          paddingY: 6,
          rotate: -2,
          top: 574,
          left: 74,
        }),
      ],
    ),
    { width: WIDTH, height: HEIGHT, fonts: ogFontList(regularFont, heavyFont) },
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
          const username = ogUsernameKey(url.searchParams.get("username"));
          if (!username) return new Response("Missing username", { status: 400 });
          try {
            return await serveOg(
              request,
              `player:${username}:v${version}`,
              () => renderPlayerOg(request, username),
            );
          } catch (err) {
            console.warn("[og] player render failed, falling back", err);
          }
        }

        // Maniacard route. Username in URL; skills computed from the player's
        // top plays via the live backend, rendered as a tier card.
        if (kind === "maniacard") {
          const username = ogUsernameKey(url.searchParams.get("username"));
          if (!username) return new Response("Missing username", { status: 400 });
          try {
            return await serveOg(
              request,
              `maniacard:${username}:v${version}`,
              () => renderManiacardOg(request, username),
            );
          } catch (err) {
            if (!isOgFallbackError(err)) console.warn("[og] maniacard render failed, falling back", err);
          }
        }

        // Pull permalink route: owner + card ids, art from the stored mint.
        if (kind === "pull") {
          const ownerId = Number(url.searchParams.get("owner"));
          // A card key, so a collector's several cards of one player each get
          // their own image rather than sharing the highest tier's.
          const cardKey = parsePackCardKey(url.searchParams.get("card") ?? "") ? String(url.searchParams.get("card")) : "";
          if (Number.isInteger(ownerId) && ownerId > 0 && cardKey) {
            try {
              // `tier` re-skins a real pull at another rarity for the admin OG
              // preview. Dev-only so nobody can pass a common pull off as a
              // GOAT, and never cached — nothing on the site links to it.
              const tierOverride = await readDevTierOverride(url);
              if (tierOverride) {
                const preview = await renderPulledCardOg(request, ownerId, cardKey, tierOverride);
                preview.headers.set("Cache-Control", "private, no-store");
                return preview;
              }
              return await serveOg(
                request,
                // The key's own colon would read as another field of the cache
                // key, so it travels as a dash here.
                `pull:${ownerId}:${cardKey.replace(":", "-")}:v${version}`,
                () => renderPulledCardOg(request, ownerId, cardKey),
              );
            } catch (err) {
              if (!isOgFallbackError(err)) console.warn("[og] pull render failed, falling back", err);
            }
          }
        }

        // Dan emblem thumbnail for the /dan command (rasterizes an svg emblem).
        if (kind === "dan-emblem") {
          const label = (url.searchParams.get("label") ?? "").trim().toLowerCase().slice(0, 8);
          const family = (url.searchParams.get("family") ?? "").trim().toLowerCase().slice(0, 16);
          if (label) {
            try {
              return await serveOg(
                request,
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
                request,
                `replay:${scoreId}:v${version}`,
                () => renderReplayOg(request, scoreId),
              );
            } catch (err) {
              console.warn("[og] replay render failed, falling back", err);
            }
          }
        }

        // A manually uploaded .osr has no guaranteed public score id. Its
        // persisted description still has everything needed for the replay
        // result card, and the random upload id gives that card a stable key.
        if (kind === "uploaded-replay") {
          const uploadId = normalizeUploadedReplayId(url.searchParams.get("uploadId"));
          if (uploadId) {
            try {
              return await serveOg(
                request,
                `uploaded-replay:${uploadId}:v${version}`,
                () => renderUploadedReplayOg(request, uploadId),
              );
            } catch (err) {
              if (!isOgFallbackError(err)) console.warn("[og] uploaded replay render failed, falling back", err);
            }
          }
        }

        // Farm helper route. Global tool, no country concept; one static
        // branded card shared by every share of the page.
        if (kind === "farm-helper") {
          try {
            return await serveOg(request, `farm-helper:v${version}`, () => renderFarmHelperOg(request));
          } catch (err) {
            console.warn("[og] farm-helper render failed, falling back", err);
          }
        }

        // Static tool cards: global surfaces with no inputs, one shared
        // image per kind per version.
        const staticKindRenderers: Record<string, (request: Request) => Promise<Response>> = {
          "maps-search": renderMapsSearchOg,
          "maps-collections": renderMapsCollectionsOg,
          packs: renderPacksOg,
          skins: renderSkinsOg,
          bbcode: renderBBCodeOg,
          discord: renderDiscordOg,
        };
        const staticRender = kind ? staticKindRenderers[kind] : undefined;
        if (kind && staticRender) {
          try {
            return await serveOg(request, `${kind}:v${version}`, () => staticRender(request));
          } catch (err) {
            console.warn(`[og] ${kind} render failed, falling back`, err);
          }
        }

        // Country-specific custom layouts. Pages without a custom image fall
        // through to the country scoreboard fallback below.
        if (countryValid) {
          if (kind === "maps") {
            try {
              return await serveOg(request, `maps:${country}:v${version}`, () => renderMapsOg(request, country));
            } catch (err) {
              if (!isOgFallbackError(err)) {
                console.warn("[og] maps render failed, falling back", err);
              }
            }
          }

          if (kind === "home") {
            try {
              return await serveOg(request, `home:${country}:v${version}`, () => renderHomeOg(request, country));
            } catch (err) {
              console.warn("[og] home render failed, falling back", err);
            }
          }

          if (kind === "rankings") {
            try {
              return await serveOg(request, `rankings:${country}:v${version}`, () => renderRankingsOg(request, country));
            } catch (err) {
              console.warn("[og] rankings render failed, falling back", err);
            }
          }

          // No recognized kind — generic country scoreboard fallback. The
          // rendered title is part of the card, so it would join the R2 key,
          // and a caller-chosen title is then a caller-chosen key: every
          // `?title=<random>` was a guaranteed miss, a multi-second render and
          // a new R2 object. Only the one title the site sends for this card is
          // rendered (see countryTopPlaysTitle); anything else gets the
          // untitled country card. Two keys per country, whatever is asked for.
          const requestedTitle = clamp(url.searchParams.get("title") ?? "", MAX_TITLE_LEN);
          const knownTitle = clamp(countryTopPlaysTitle(getCountryName(country) || country), MAX_TITLE_LEN);
          const fallbackTitle = requestedTitle === knownTitle ? requestedTitle : "";
          const fallbackTitleKey = fallbackTitle ? "top-plays" : "none";
          try {
            return await serveOg(
              request,
              `country:${country}:${fallbackTitleKey}:v${version}`,
              () => renderCountryOg(request, country, fallbackTitle),
            );
          } catch (err) {
            console.warn("[og] country render failed, falling back", err);
          }
        }

        // Default branded layout — used when nothing else matched
        // (no country, no recognised kind). Falls back to the
        // title-only minimal layout on error.
        try {
          return await serveOg(request, `default:v${version}`, () => renderDefaultBrandOg(request));
        } catch (err) {
          console.warn("[og] default brand render failed, falling back", err);
        }
        return renderDefaultOg(request, url);
      },
    },
  },
});
