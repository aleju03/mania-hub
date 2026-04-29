import { ImageResponse } from "@vercel/og";
import { createFileRoute } from "@tanstack/react-router";
import { createElement as h } from "react";
import { getCachedUser, getCachedUserScores, getRankings, getCountryMapsFarmed, getCountrySnipes, getScore } from "../../lib/osu";
import { getCountryName, isSupportedCountryCode } from "../../lib/country";
import { getAssetOrigin } from "../../lib/origin";
import type { MapsFarmedEntry, OsuScore } from "../../lib/types";

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

// Grade pill colors match the in-app GradeImg / rankings palette so the
// OG and the live site feel like the same product.
const GRADE_COLORS: Record<string, { fg: string; bg: string }> = {
  XH: { fg: "#ffffff", bg: "#a8a8a8" },
  X: { fg: "#111111", bg: "#ffd24a" },
  SH: { fg: "#ffffff", bg: "#a8a8a8" },
  S: { fg: "#111111", bg: "#ffd24a" },
  A: { fg: "#111111", bg: "#86d460" },
  B: { fg: "#ffffff", bg: "#4aaaff" },
  C: { fg: "#ffffff", bg: "#c273ff" },
  D: { fg: "#ffffff", bg: "#ff6b6b" },
  F: { fg: "#ffffff", bg: "#555555" },
};

function gradePill(rank: string, size: "sm" | "md" | "lg" = "md") {
  const key = rank === "X" ? "X" : rank === "XH" ? "X" : rank === "SH" ? "S" : rank;
  const color = GRADE_COLORS[key] ?? GRADE_COLORS.F;
  const pad = size === "lg" ? "10px 22px" : size === "md" ? "6px 14px" : "4px 10px";
  const font = size === "lg" ? "42px" : size === "md" ? "26px" : "18px";
  return h(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: pad,
        borderRadius: "8px",
        background: color.bg,
        color: color.fg,
        fontWeight: 900,
        fontSize: font,
        letterSpacing: "0.04em",
      },
    },
    key === "X" && rank === "XH" ? "SS" : key === "X" ? "SS" : key === "SH" ? "S" : key,
  );
}

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

async function fetchCountryTopPlayer(country: string) {
  const rankings = await getRankings({ data: { type: "performance", page: 1, country } });
  const topPlayer = rankings.ranking.find((e) => e.user.is_active !== false) ?? rankings.ranking[0];
  if (!topPlayer) throw new Error(`no ranked players for ${country}`);
  return { rankings, topPlayer };
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

/* Top plays: a single hero card. The #1 country player's #1 best play is
   the focal point — cover art fills the canvas, pp number dominates, rest
   is metadata. Shows "the current hottest play" at a glance. */
async function renderTopPlaysOg(request: Request, country: string): Promise<Response> {
  const [regularFont, heavyFont, data] = await Promise.all([
    getFont(request, "Torus-Regular.otf"),
    getFont(request, "Torus-Heavy.otf"),
    fetchCountryTopPlayer(country),
  ]);
  const scores = await getCachedUserScores("best", data.topPlayer.user.id, { limit: 1, offset: 0 });
  if (scores.length === 0) throw new Error("no best scores for top player");
  const score = scores[0];
  const cover = pickBeatmapsetCover(score);
  const countryName = getCountryName(country) || country;
  const flagUrl = `https://osu.ppy.sh/images/flags/${country}.png`;
  const modsLabel = score.mods.map((m) => m.acronym).filter(Boolean).join(" · ");

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
          background: "linear-gradient(135deg, #140f12 0%, #2a1a26 100%)",
          fontFamily: '"Torus OG"',
          color: "#ffffff",
          padding: "56px 64px",
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
                opacity: 0.28,
              },
            })
          : null,
        h("div", {
          key: "dim",
          style: {
            position: "absolute",
            inset: "0",
            background: "linear-gradient(180deg, rgba(15,10,13,0.55) 0%, rgba(15,10,13,0.92) 100%)",
          },
        }),

        // Top eyebrow with flag + country label.
        h(
          "div",
          {
            key: "eyebrow",
            style: {
              position: "relative",
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: "14px",
              color: "#ff99cc",
              fontSize: "24px",
              letterSpacing: "0.04em",
            },
          },
          [
            h("img", {
              key: "flag",
              src: flagUrl,
              style: { width: "38px", height: "26px", borderRadius: "3px", objectFit: "cover" },
            }),
            h("div", { key: "lbl" }, `${countryName} - top mania play`),
          ],
        ),

        // Center hero: big pp value.
        h(
          "div",
          {
            key: "hero",
            style: {
              position: "relative",
              display: "flex",
              flexDirection: "column",
              flex: "1",
              justifyContent: "center",
              marginTop: "20px",
            },
          },
          [
            h(
              "div",
              {
                key: "pp",
                style: {
                  fontSize: "160px",
                  fontWeight: 900,
                  color: "#ff66aa",
                  lineHeight: "0.9",
                  textShadow: "0 8px 40px rgba(255,102,170,0.35)",
                },
              },
              `${formatOgInt(score.pp)}pp`,
            ),
            h(
              "div",
              {
                key: "meta",
                style: {
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: "20px",
                  marginTop: "24px",
                  fontSize: "26px",
                  color: "#e8e3ec",
                },
              },
              [
                gradePill(score.rank, "md"),
                h(
                  "div",
                  {
                    key: "acc",
                    style: { color: "#c7b8c1" },
                  },
                  formatOgAcc(score.accuracy),
                ),
                modsLabel
                  ? h(
                      "div",
                      {
                        key: "mods",
                        style: {
                          color: "#ff99cc",
                          fontWeight: 900,
                          letterSpacing: "0.08em",
                        },
                      },
                      `+ ${modsLabel}`,
                    )
                  : null,
              ],
            ),
          ],
        ),

        // Bottom: beatmap + player line.
        h(
          "div",
          {
            key: "bottom",
            style: {
              position: "relative",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            },
          },
          [
            h(
              "div",
              {
                key: "song",
                style: {
                  fontSize: "34px",
                  fontWeight: 900,
                  lineHeight: "1.1",
                  maxWidth: "1050px",
                  overflow: "hidden",
                },
              },
              beatmapDisplayTitle(score),
            ),
            h(
              "div",
              {
                key: "diff",
                style: {
                  fontSize: "22px",
                  color: "#c7b8c1",
                },
              },
              `[${score.beatmap?.version ?? "?"}]  ${score.beatmap?.cs ? `${Math.round(score.beatmap.cs)}K` : ""}`,
            ),
            h(
              "div",
              {
                key: "player",
                style: {
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: "14px",
                  marginTop: "8px",
                },
              },
              [
                h(
                  "div",
                  {
                    key: "ava-wrap",
                    style: {
                      width: "44px",
                      height: "44px",
                      borderRadius: "10px",
                      overflow: "hidden",
                      display: "flex",
                      border: "1px solid rgba(255,255,255,0.15)",
                    },
                  },
                  h("img", {
                    src: score.user.avatar_url,
                    style: { width: "100%", height: "100%", objectFit: "cover" },
                  }),
                ),
                h(
                  "div",
                  {
                    key: "name",
                    style: {
                      fontSize: "24px",
                      fontWeight: 900,
                    },
                  },
                  score.user.username,
                ),
                h(
                  "div",
                  {
                    key: "sep",
                    style: { color: "#5a4a52", fontSize: "22px" },
                  },
                  "on",
                ),
                h(
                  "div",
                  {
                    key: "site",
                    style: {
                      fontSize: "20px",
                      color: "#7a6b74",
                      letterSpacing: "0.06em",
                      marginLeft: "auto",
                    },
                  },
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

/* Maps: 3 beatmap covers tiled horizontally, representing what the country
   top player is currently farming. Different from top-plays (one big score)
   because here the focus is on the *maps*, not a single popoff. */
async function renderMapsOg(request: Request, country: string): Promise<Response> {
  const [regularFont, heavyFont, users] = await Promise.all([
    getFont(request, "Torus-Regular.otf"),
    getFont(request, "Torus-Heavy.otf"),
    fetchCountryMapUsers(country),
  ]);
  const farmedSection = await getCountryMapsFarmed({ data: { users } });
  const farmedMaps = farmedSection.value.farmed.slice(0, 3);
  if (farmedMaps.length === 0) throw new Error("no maps to show");

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
          background: "linear-gradient(135deg, #140f12 0%, #2a1a26 100%)",
          fontFamily: '"Torus OG"',
          color: "#ffffff",
          padding: "56px 60px",
        },
      },
      [
        h("div", {
          key: "glow",
          style: {
            position: "absolute",
            inset: "0",
            background: "radial-gradient(circle at 50% 20%, rgba(255,102,170,0.14) 0%, rgba(255,102,170,0) 55%)",
          },
        }),

        // Header
        h(
          "div",
          {
            key: "header",
            style: {
              position: "relative",
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: "16px",
              marginBottom: "28px",
            },
          },
          [
            h("img", {
              key: "flag",
              src: flagUrl,
              style: { width: "52px", height: "35px", borderRadius: "4px", objectFit: "cover" },
            }),
            h(
              "div",
              {
                key: "title",
                style: { fontSize: "40px", fontWeight: 900 },
              },
              `${countryName}'s farmed maps`,
            ),
          ],
        ),

        // Grid of 3 map cards.
        h(
          "div",
          {
            key: "grid",
            style: {
              position: "relative",
              display: "flex",
              flexDirection: "row",
              flex: "1",
              gap: "18px",
            },
          },
          farmedMaps.map((map, i) => farmedMapCard(map, i)),
        ),

        h(
          "div",
          {
            key: "footer",
            style: {
              position: "relative",
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: "12px",
              marginTop: "20px",
              fontSize: "20px",
              color: "#7a6b74",
            },
          },
          [
            h(
              "div",
              { key: "by" },
              `${users.length} top players`,
            ),
            h("div", { key: "dot", style: { color: "#5a4a52" } }, "/"),
            h("div", { key: "mark" }, "o!mania tracker"),
          ],
        ),
      ],
    ),
    { width: WIDTH, height: HEIGHT, fonts: ogFontList(regularFont, heavyFont) },
  );
  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

function farmedMapCard(map: MapsFarmedEntry, idx: number) {
  const cover = map.covers["cover@2x"] || map.covers.cover || map.covers["card@2x"] || map.covers.card || null;
  return h(
    "div",
    {
      key: `m-${idx}`,
      style: {
        flex: "1",
        display: "flex",
        flexDirection: "column",
        borderRadius: "14px",
        overflow: "hidden",
        background: "#1a1317",
        border: "1px solid rgba(255,255,255,0.06)",
      },
    },
    [
      h(
        "div",
        {
          key: "art",
          style: {
            width: "100%",
            flex: "1",
            display: "flex",
            position: "relative",
            overflow: "hidden",
            background: "#0b070a",
          },
        },
        cover
          ? h("img", {
              src: cover,
              style: { width: "100%", height: "100%", objectFit: "cover" },
            })
          : null,
      ),
      h(
        "div",
        {
          key: "body",
          style: {
            display: "flex",
            flexDirection: "column",
            padding: "14px 16px",
            gap: "4px",
          },
        },
        [
          h(
            "div",
            {
              key: "t",
              style: {
                fontSize: "18px",
                fontWeight: 900,
                color: "#ffffff",
                lineHeight: "1.15",
                overflow: "hidden",
              },
            },
            map.title,
          ),
          h(
            "div",
            {
              key: "d",
              style: {
                fontSize: "14px",
                color: "#c7b8c1",
                lineHeight: "1.2",
              },
            },
            `${map.playerCount} players / ${formatOgInt(map.avgPp)} avg pp / ${map.difficultyRating.toFixed(2)} stars`,
          ),
        ],
      ),
    ],
  );
}

/* Tracker: a recent-activity feed of the country's top 3 players with
   their #1 best score each. Frames the page as "what's hot right now." */
async function renderTrackerOg(request: Request, country: string): Promise<Response> {
  const [regularFont, heavyFont, data] = await Promise.all([
    getFont(request, "Torus-Regular.otf"),
    getFont(request, "Torus-Heavy.otf"),
    fetchCountryTopPlayer(country),
  ]);

  const topN = data.rankings.ranking
    .filter((e) => e.user.is_active !== false)
    .slice(0, 3);
  // Sequential rather than parallel. osu! API + dev-server loopback combined
  // with Satori's remote image fetches was producing "socket hang up" on
  // parallel fan-out. These are tiny, cached fetches so the added latency
  // is small on warm calls and worth the reliability.
  const bestPerPlayer: Array<{ entry: typeof topN[number]; score: OsuScore } | null> = [];
  for (const entry of topN) {
    try {
      const arr = await getCachedUserScores("best", entry.user.id, { limit: 1, offset: 0 });
      bestPerPlayer.push(arr.length > 0 ? { entry, score: arr[0] } : null);
    } catch {
      bestPerPlayer.push(null);
    }
  }
  const rows = bestPerPlayer.filter((x): x is NonNullable<typeof x> => x != null);
  if (rows.length === 0) throw new Error("no scores for tracker OG");

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
          background: "linear-gradient(135deg, #140f12 0%, #2a1a26 100%)",
          fontFamily: '"Torus OG"',
          color: "#ffffff",
          padding: "56px 60px",
        },
      },
      [
        h("div", {
          key: "glow",
          style: {
            position: "absolute",
            inset: "0",
            background: "radial-gradient(circle at 16% 40%, rgba(255,102,170,0.18) 0%, rgba(255,102,170,0) 55%)",
          },
        }),

        h(
          "div",
          {
            key: "header",
            style: {
              position: "relative",
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: "18px",
              marginBottom: "28px",
            },
          },
          [
            h("img", {
              key: "flag",
              src: flagUrl,
              style: { width: "54px", height: "36px", borderRadius: "4px", objectFit: "cover" },
            }),
            h(
              "div",
              { key: "title", style: { fontSize: "40px", fontWeight: 900 } },
              `live scores - ${countryName}`,
            ),
          ],
        ),

        h(
          "div",
          {
            key: "list",
            style: {
              position: "relative",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              flex: "1",
              justifyContent: "center",
            },
          },
          rows.map((r, i) => trackerRow(r.entry.user, r.score, i)),
        ),
      ],
    ),
    { width: WIDTH, height: HEIGHT, fonts: ogFontList(regularFont, heavyFont) },
  );
  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

function trackerRow(user: { avatar_url: string; username: string }, score: OsuScore, idx: number) {
  // Intentionally no beatmap cover bg here. We tried that and Satori choked
  // on the extra remote image fetches (avatar + cover × 3 rows = too many
  // concurrent loopbacks). Keep tracker lean: flag + avatars only.
  return h(
    "div",
    {
      key: `tr-${idx}`,
      style: {
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: "18px",
        padding: "16px 18px",
        borderRadius: "14px",
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.06)",
      },
    },
    [
      gradePill(score.rank, "md"),
      h(
        "div",
        {
          key: "ava-wrap",
          style: {
            width: "52px",
            height: "52px",
            borderRadius: "10px",
            overflow: "hidden",
            display: "flex",
            border: "1px solid rgba(255,255,255,0.15)",
            flexShrink: 0,
          },
        },
        h("img", {
          src: user.avatar_url,
          style: { width: "100%", height: "100%", objectFit: "cover" },
        }),
      ),
      h(
        "div",
        {
          key: "text",
          style: {
            display: "flex",
            flexDirection: "column",
            flex: "1",
            minWidth: "0",
          },
        },
        [
          h(
            "div",
            {
              key: "line1",
              style: {
                display: "flex",
                flexDirection: "row",
                alignItems: "baseline",
                gap: "10px",
                fontSize: "22px",
                lineHeight: "1.2",
                color: "#e8e3ec",
                overflow: "hidden",
              },
            },
            [
              h(
                "div",
                { key: "u", style: { fontWeight: 900, color: "#ffffff" } },
                user.username,
              ),
              h(
                "div",
                { key: "on", style: { color: "#8a7a82", fontSize: "18px" } },
                "on",
              ),
              h(
                "div",
                { key: "t", style: { overflow: "hidden" } },
                score.beatmapset?.title ?? "Unknown",
              ),
            ],
          ),
          h(
            "div",
            {
              key: "line2",
              style: {
                fontSize: "16px",
                color: "#8a7a82",
                marginTop: "2px",
              },
            },
            `[${score.beatmap?.version ?? "?"}] · ${formatOgAcc(score.accuracy)}`,
          ),
        ],
      ),
      h(
        "div",
        {
          key: "pp",
          style: {
            fontSize: "30px",
            fontWeight: 900,
            color: "#ff66aa",
          },
        },
        `${formatOgInt(score.pp)}pp`,
      ),
    ],
  );
}

/* Snipes: "X sniped Y on {map}" card. Shows the most recent #1 takeover
   in the country. Tightly scoped to the page purpose. */
async function renderSnipesOg(request: Request, country: string): Promise<Response> {
  const [regularFont, heavyFont, snipes] = await Promise.all([
    getFont(request, "Torus-Regular.otf"),
    getFont(request, "Torus-Heavy.otf"),
    getCountrySnipes({ data: { country } }),
  ]);

  const event = snipes.events?.[0];
  if (!event) throw new Error("no snipe events");

  const cover = event.beatmapset?.cover_url || null;
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
          background: "linear-gradient(135deg, #140f12 0%, #2a1a26 100%)",
          fontFamily: '"Torus OG"',
          color: "#ffffff",
          padding: "56px 64px",
        },
      },
      [
        cover
          ? h("img", {
              key: "cover",
              src: cover,
              style: {
                position: "absolute",
                inset: "0",
                width: "100%",
                height: "100%",
                objectFit: "cover",
                opacity: 0.2,
              },
            })
          : null,
        h("div", {
          key: "dim",
          style: {
            position: "absolute",
            inset: "0",
            background: "linear-gradient(90deg, rgba(15,10,13,0.88) 0%, rgba(15,10,13,0.55) 100%)",
          },
        }),

        // Eyebrow
        h(
          "div",
          {
            key: "eyebrow",
            style: {
              position: "relative",
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: "12px",
              color: "#ff99cc",
              fontSize: "22px",
              letterSpacing: "0.06em",
            },
          },
          [
            h("img", {
              key: "f",
              src: flagUrl,
              style: { width: "32px", height: "22px", borderRadius: "3px", objectFit: "cover" },
            }),
            h("div", { key: "l" }, `${countryName} - latest snipe`),
          ],
        ),

        // Main: sniper vs victim on a map.
        h(
          "div",
          {
            key: "body",
            style: {
              position: "relative",
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: "40px",
              flex: "1",
              marginTop: "18px",
            },
          },
          [
            h(
              "div",
              {
                key: "sniper",
                style: {
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: "14px",
                  flexShrink: 0,
                },
              },
              [
                h(
                  "div",
                  {
                    key: "ava-s",
                    style: {
                      width: "200px",
                      height: "200px",
                      borderRadius: "24px",
                      overflow: "hidden",
                      display: "flex",
                      border: "4px solid #ff66aa",
                      background: "#1a1317",
                      boxShadow: "0 0 36px rgba(255,102,170,0.45)",
                    },
                  },
                  h("img", {
                    src: event.sniper.avatar_url,
                    style: { width: "100%", height: "100%", objectFit: "cover" },
                  }),
                ),
                h(
                  "div",
                  {
                    key: "name-s",
                    style: { fontSize: "26px", fontWeight: 900 },
                  },
                  event.sniper.username,
                ),
                h(
                  "div",
                  { key: "tag-s", style: { fontSize: "15px", color: "#ff99cc", letterSpacing: "0.1em" } },
                  "SNIPER",
                ),
              ],
            ),

            // Arrow + verb.
            h(
              "div",
              {
                key: "vs",
                style: {
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "4px",
                },
              },
              [
                h(
                  "div",
                  {
                    key: "arr",
                    style: { fontSize: "54px", color: "#ff66aa", lineHeight: "1" },
                  },
                  "→",
                ),
                h(
                  "div",
                  {
                    key: "verb",
                    style: {
                      fontSize: "20px",
                      color: "#c7b8c1",
                      letterSpacing: "0.14em",
                    },
                  },
                  "SNIPED",
                ),
              ],
            ),

            h(
              "div",
              {
                key: "victim",
                style: {
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: "14px",
                  flexShrink: 0,
                },
              },
              [
                h(
                  "div",
                  {
                    key: "ava-v",
                    style: {
                      width: "160px",
                      height: "160px",
                      borderRadius: "20px",
                      overflow: "hidden",
                      display: "flex",
                      border: "3px solid rgba(255,255,255,0.25)",
                      background: "#1a1317",
                      filter: "grayscale(0.6)",
                    },
                  },
                  h("img", {
                    src: event.victim.avatar_url,
                    style: { width: "100%", height: "100%", objectFit: "cover" },
                  }),
                ),
                h(
                  "div",
                  {
                    key: "name-v",
                    style: { fontSize: "22px", fontWeight: 900, color: "#c7b8c1" },
                  },
                  event.victim.username,
                ),
                h(
                  "div",
                  { key: "tag-v", style: { fontSize: "14px", color: "#8a7a82", letterSpacing: "0.1em" } },
                  "VICTIM",
                ),
              ],
            ),

            // Right column: beatmap info.
            h(
              "div",
              {
                key: "map",
                style: {
                  display: "flex",
                  flexDirection: "column",
                  flex: "1",
                  minWidth: "0",
                  marginLeft: "14px",
                },
              },
              [
                h(
                  "div",
                  {
                    key: "t",
                    style: {
                      fontSize: "28px",
                      fontWeight: 900,
                      lineHeight: "1.1",
                      marginBottom: "6px",
                      overflow: "hidden",
                    },
                  },
                  `${event.beatmapset.artist} - ${event.beatmapset.title}`,
                ),
                h(
                  "div",
                  {
                    key: "d",
                    style: { fontSize: "20px", color: "#c7b8c1" },
                  },
                  `[${event.beatmap.version}]  ${Math.round(event.beatmap.cs)}K`,
                ),
                event.pp != null
                  ? h(
                      "div",
                      {
                        key: "pp",
                        style: {
                          fontSize: "32px",
                          fontWeight: 900,
                          color: "#ff66aa",
                          marginTop: "14px",
                        },
                      },
                      `${formatOgInt(event.pp)}pp`,
                    )
                  : null,
              ],
            ),
          ],
        ),

        h(
          "div",
          {
            key: "brand",
            style: {
              position: "relative",
              fontSize: "18px",
              color: "#7a6b74",
              letterSpacing: "0.06em",
              marginTop: "auto",
            },
          },
          "o!mania tracker",
        ),
      ],
    ),
    { width: WIDTH, height: HEIGHT, fonts: ogFontList(regularFont, heavyFont) },
  );
  response.headers.set("Cache-Control", OG_CACHE_HEADER);
  return response;
}

/* Replay: specific score card. URL carries scoreId. Render: beatmap cover
   as ambient bg, then player avatar + grade + pp + acc + mods, like a
   stylized score result screen. */
async function renderReplayOg(request: Request, scoreId: number): Promise<Response> {
  const [regularFont, heavyFont, score] = await Promise.all([
    getFont(request, "Torus-Regular.otf"),
    getFont(request, "Torus-Heavy.otf"),
    getScore({ data: { scoreId } }),
  ]);

  const cover = pickBeatmapsetCover(score);
  const modsLabel = score.mods.map((m) => m.acronym).filter(Boolean).join(" · ");

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
          background: "linear-gradient(135deg, #140f12 0%, #2a1a26 100%)",
          fontFamily: '"Torus OG"',
          color: "#ffffff",
          padding: "56px 64px",
        },
      },
      [
        cover
          ? h("img", {
              key: "cover",
              src: cover,
              style: {
                position: "absolute",
                inset: "0",
                width: "100%",
                height: "100%",
                objectFit: "cover",
                opacity: 0.3,
              },
            })
          : null,
        h("div", {
          key: "dim",
          style: {
            position: "absolute",
            inset: "0",
            background: "linear-gradient(180deg, rgba(15,10,13,0.55) 0%, rgba(15,10,13,0.92) 100%)",
          },
        }),

        h(
          "div",
          {
            key: "eyebrow",
            style: {
              position: "relative",
              fontSize: "22px",
              color: "#ff99cc",
              letterSpacing: "0.1em",
              marginBottom: "16px",
            },
          },
          "REPLAY",
        ),

        h(
          "div",
          {
            key: "hero",
            style: {
              position: "relative",
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: "32px",
              flex: "1",
            },
          },
          [
            gradePill(score.rank, "lg"),
            h(
              "div",
              {
                key: "info",
                style: {
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
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
                      fontSize: "54px",
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
                  beatmapDisplayTitle(score),
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
                  `[${score.beatmap?.version ?? "?"}]  ${score.beatmap?.cs ? `${Math.round(score.beatmap.cs)}K` : ""}`,
                ),
              ],
            ),
          ],
        ),

        h(
          "div",
          {
            key: "stats",
            style: {
              position: "relative",
              display: "flex",
              flexDirection: "row",
              alignItems: "baseline",
              gap: "34px",
              marginTop: "auto",
            },
          },
          [
            h(
              "div",
              {
                key: "pp",
                style: { fontSize: "72px", fontWeight: 900, color: "#ff66aa", lineHeight: "1" },
              },
              `${formatOgInt(score.pp)}pp`,
            ),
            h(
              "div",
              {
                key: "acc",
                style: { fontSize: "28px", color: "#c7b8c1" },
              },
              formatOgAcc(score.accuracy),
            ),
            modsLabel
              ? h(
                  "div",
                  {
                    key: "mods",
                    style: {
                      fontSize: "24px",
                      color: "#ff99cc",
                      fontWeight: 900,
                      letterSpacing: "0.08em",
                    },
                  },
                  `+ ${modsLabel}`,
                )
              : null,
            h(
              "div",
              {
                key: "brand",
                style: {
                  fontSize: "18px",
                  color: "#7a6b74",
                  letterSpacing: "0.06em",
                  marginLeft: "auto",
                },
              },
              "o!mania tracker",
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

        // Country-specific kinds: each page has its own layout; the
        // country param is required.
        if (countryValid) {
          if (kind === "top-plays") {
            try {
              return await renderTopPlaysOg(request, country);
            } catch (err) {
              console.warn("[og] top-plays render failed, falling back", err);
            }
          }
          if (kind === "maps") {
            try {
              return await renderMapsOg(request, country);
            } catch (err) {
              console.warn("[og] maps render failed, falling back", err);
            }
          }
          if (kind === "tracker") {
            try {
              return await renderTrackerOg(request, country);
            } catch (err) {
              console.warn("[og] tracker render failed, falling back", err);
            }
          }
          if (kind === "snipes") {
            try {
              return await renderSnipesOg(request, country);
            } catch (err) {
              console.warn("[og] snipes render failed, falling back", err);
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
