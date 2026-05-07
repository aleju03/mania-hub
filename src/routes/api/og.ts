import { ImageResponse } from "@vercel/og";
import { createFileRoute } from "@tanstack/react-router";
import { createElement as h } from "react";
import { getCachedUser, getRankings, getCountryMapsFavourites, getScore } from "../../lib/osu";
import { getCountryName, isSupportedCountryCode } from "../../lib/country";
import { getAssetOrigin } from "../../lib/origin";
import { getDisplayedRank, getManiaJudgementCounts, getModAcronyms } from "../../lib/score";
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

async function fetchCountryMapUsers(country: string) {
  const rankings = await getRankings({ data: { type: "performance", page: 1, country } });
  const users = rankings.ranking
    .filter((entry) => entry.user.is_active !== false)
    .slice(0, 50)
    .map((entry) => ({
      id: entry.user.id,
      username: entry.user.username,
      avatar_url: entry.user.avatar_url,
    }));
  if (users.length === 0) throw new Error(`no ranked players for ${country}`);
  return users;
}

/* Maps: full-bleed mosaic of beatmapset covers pulled from the country's
   favourites pool. The pool is country-seeded so the same OG renders
   stable across requests until the underlying cache rebuilds. If we
   have no maps data for the country, fall through to the country
   scoreboard layout. */
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

async function renderMapsOg(request: Request, country: string): Promise<Response> {
  const users = await fetchCountryMapUsers(country);
  // Pull the favourites section: the beatmapsetsPool gives us a wide variety
  // of sets the country actually plays. Warm-cache hit = no osu! API calls.
  const favSection = await getCountryMapsFavourites({ data: { users } });
  const pool = favSection.value.beatmapsetsPool;
  const sets = pool ? Object.values(pool) : [];
  if (sets.length === 0) {
    // No maps data for this country: fall through to the scoreboard layout.
    return renderCountryOg(request, country, `${getCountryName(country) || country} maps`);
  }

  const rng = mulberry32(hashString(country));
  const picked = shuffle(sets, rng).slice(0, MAPS_MOSAIC_COUNT);
  // If the pool is smaller than the grid, repeat (still shuffled) so we
  // always fill the canvas instead of leaving blank cells.
  while (picked.length < MAPS_MOSAIC_COUNT && sets.length > 0) {
    picked.push(...shuffle(sets, rng).slice(0, MAPS_MOSAIC_COUNT - picked.length));
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
                const set = picked[r * MAPS_MOSAIC_COLS + c];
                const cover = set ? pickCover(set.covers) : null;
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
                  `${sets.length} community-picked mania maps`,
                ),
                h("div", { key: "dot", style: { color: "#5a4a52" } }, "/"),
                h(
                  "div",
                  { key: "brand", style: { color: "#7a6b74", letterSpacing: "0.06em" } },
                  "o!mania tracker",
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
   big REPLAY eyebrow + brand. Middle: grade SVG + username + beatmap
   title + diff. Then a thin segmented composition bar visualising the
   judgement distribution, then pp / acc / mods / combo. */
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
            // Top band: REPLAY eyebrow on left, brand mark on right.
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
                h(
                  "div",
                  {
                    key: "brand",
                    style: {
                      marginLeft: "auto",
                      fontSize: "18px",
                      color: "#7a6b74",
                      letterSpacing: "0.06em",
                    },
                  },
                  "o!mania tracker",
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

/* Country layout: a scoreboard preview showing the top 5 of the country's
   current ranking. Used for every page that has a `?country=XX` param
   (home, rankings, top-plays, maps, tracker, snipes). The country name
   is the focal element; the title from the URL appears as a small muted
   caption so each page still reads distinctly. Description/subtitle is
   intentionally not rendered here — it lives in the HTML <meta> so the
   social-card body text shows it once, not duplicated inside the image. */
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
  const showTitle = title && title !== "o!mania tracker";

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
              "o!mania tracker",
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

/* Fallback layout. Used when no country is present and no kind is
   recognised (replay page, preview-tool presets without country). The
   description lives in the HTML <meta> so the social card body text
   carries it — baking it into the image too would just duplicate. */
async function renderDefaultOg(request: Request, url: URL): Promise<Response> {
  const title = clamp(url.searchParams.get("title"), MAX_TITLE_LEN) || "o!mania tracker";
  const showBrand = title !== "o!mania tracker";

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
                  "o!mania tracker",
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
        const countryValid = country && isSupportedCountryCode(country);

        // Player route. Username in URL, data comes from osu! API.
        if (kind === "player") {
          const username = url.searchParams.get("username");
          if (!username) return new Response("Missing username", { status: 400 });
          try {
            return await renderPlayerOg(request, username);
          } catch (err) {
            console.warn("[og] player render failed, falling back", err);
          }
        }

        // Replay route. Needs a scoreId, no country concept.
        if (kind === "replay") {
          const scoreId = Number(url.searchParams.get("scoreId"));
          if (Number.isFinite(scoreId) && scoreId > 0) {
            try {
              return await renderReplayOg(request, scoreId);
            } catch (err) {
              console.warn("[og] replay render failed, falling back", err);
            }
          }
        }

        // Country-specific custom layouts. Pages without a custom image fall
        // through to the country scoreboard fallback below.
        if (countryValid) {
          if (kind === "maps") {
            try {
              return await renderMapsOg(request, country);
            } catch (err) {
              console.warn("[og] maps render failed, falling back", err);
            }
          }

          // No kind (home/rankings) — country scoreboard.
          try {
            return await renderCountryOg(
              request,
              country,
              url.searchParams.get("title") ?? "",
            );
          } catch (err) {
            console.warn("[og] country render failed, falling back", err);
          }
        }

        return renderDefaultOg(request, url);
      },
    },
  },
});
