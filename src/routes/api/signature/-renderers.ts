// Dynamic-render layouts. The `-` prefix keeps this file out of the route
// tree, the same convention the colocated route tests use.
//
// Everything is built with createElement into satori. Satori has no canvas, so
// anything actually drawn (the radar, the progress arcs) is emitted as an SVG
// string and inlined as a base64 data URL, which is the technique /api/og
// already uses for its card art.

import { ImageResponse } from "@vercel/og";
import { createElement as h } from "react";
import type { ReactElement, ReactNode } from "react";

import { getServerLiveBackendUrl } from "../../../lib/live-backend";
import { bridgeAuthHeaders } from "../../../lib/live-backend-tokens";
import { clamp, loadOgFonts, ogAvatarUrl, ogFontList } from "../../../lib/og-render";
import { getAssetOrigin } from "../../../lib/origin";
import {
  cosmicLaurelDataUrl,
  maniaTierCardElement,
  MANIACARD_H,
  MANIACARD_W,
} from "../../../lib/maniacard-art";
import { computeManiaSkills, getManiaCardTier, MANIA_TIER_STYLES } from "../../../lib/maniacard";
import type { ManiaSkills } from "../../../lib/maniacard";
import { formatDate } from "../../../lib/format";
import { describeGoalEnglish, nf } from "../../../lib/goal-format";
import type { UserGoal } from "../../../lib/goals";
import {
  formatTopShare,
  qualifyingSkillModes,
  radarAnchor,
  radarGeometry,
  radarLabelDy,
  radarPoints,
  ringPolygon,
  RADAR_RINGS,
  skillModeEntries,
} from "../../../lib/skill-axes";
import type { MyDataSkillBreakdown, MyDataSkillMode } from "../../../lib/my-data";
import { getDanImageSrc } from "../../../lib/dan-images";
import { signatureDesign, type SignatureType } from "../../../lib/signature-shared";
import {
  accentHex,
  stylePaintedBackground,
  styleNeedsProfileImage,
  styleUsesImage,
  styleUsesTier,
  type SignatureStyle,
} from "../../../lib/signature-style";
import { avatarSquareDataUrl, backgroundImageDataUrl, beatmapCoverBandDataUrl, type SignatureBackgroundSources } from "./-backgrounds";
import { cosmicStarsDataUrl, signatureArtLayers, tierFlecksDataUrl } from "./-art";
import { getCosmicTierPalette } from "../../../lib/maniacard-cosmic";
import type { ResolvedSignature } from "../../../lib/signature-resolve";
import { buildPpCumulativeDistribution, calculateUserProfileInsights } from "../../../lib/profile-insights";
import type { InsightScoreSnapshot, OsuScore, UserProfileInsights } from "../../../lib/types";
import { MOD_BADGE_FILE_NAMES, MOD_BADGE_TYPE_COLORS } from "../../../components/ui/ModBadge";
import { starRatingColor } from "../../../components/ui/StarRating";

const SURFACE = "#120d15";
const TEXT_DIM = "#9c8fa8";
/* Secondary text reads fine as a muted violet on the flat surface, but over a
   photograph it loses too much contrast even after the legibility cap. On art,
   dim means less white rather than a different colour. */
const TEXT_DIM_ON_ART = "rgba(255,255,255,0.74)";
const ACCENT = "#ff66aa";
const RADAR_LABEL_COLOR = "rgba(255,255,255,0.72)";

export interface SignatureRenderContext {
  request: Request;
  resolved: ResolvedSignature;
  type: SignatureType;
  design: number;
  /** Already normalized against the allowlist by the route. */
  style: SignatureStyle;
}

/* Every render goes through here so a layout cannot forget the font list or
   the exact pixel size its design declared. */
async function renderPng(ctx: SignatureRenderContext, node: ReactElement): Promise<Buffer> {
  const spec = signatureDesign(ctx.type, ctx.design)!;
  const [regularFont, heavyFont] = await loadOgFonts(ctx.request);
  const response = new ImageResponse(node, {
    width: spec.width,
    height: spec.height,
    fonts: ogFontList(regularFont, heavyFont),
  });
  return Buffer.from(await response.arrayBuffer());
}

/* satori does not implement the `inset` shorthand: a div given `inset: 0`
   keeps its auto size, collapses to nothing, and silently paints no pixels.
   Every full-bleed layer here - tier fills, glows, scrims, backgrounds - has to
   spell the four sides out instead. Getting this wrong is invisible in code
   review and invisible in the output, which is exactly how the layered
   backdrops ended up looking flat. */
const FILL = { top: 0, left: 0, right: 0, bottom: 0 } as const;

/* Wide layouts carry their text on the left, tall ones down the middle, so the
   scrim leans the way the words do. Shared by anything bright enough to lose
   white text on it: an arbitrary photograph and a Legendary card front are the
   same problem. */
function scrimGradient(spec: { width: number; height: number }): string {
  return spec.width >= spec.height * 1.6
    ? "linear-gradient(90deg, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.34) 52%, rgba(0,0,0,0.50) 100%)"
    : "linear-gradient(180deg, rgba(0,0,0,0.34) 0%, rgba(0,0,0,0.26) 42%, rgba(0,0,0,0.70) 100%)";
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/* Accent palette entries are all #rrggbb, but "auto" fallbacks come from
   skillset metadata that may already be rgba(). Anything that is not a plain
   hex is handed back untouched rather than mangled into an invalid colour. */
function hexAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const value = parseInt(match[1]!, 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}


// --- shared chrome -----------------------------------------------------

/* The card body. Transparent by default, and that is the whole meaning of the
   "None" background: these are pasted onto an osu! profile that already has a
   colour behind them, so a render that paints its own dark rectangle is a
   patch on the page rather than part of it. Every other background paints an
   opaque layer over this, so nothing else changes.

   SURFACE is still the compositing base an image background fades toward -
   there the picture is the background, and it has to end up opaque. */
function frame(width: number, height: number, children: ReactNode[], background?: string): ReactElement {
  return h(
    "div",
    {
      style: {
        width: `${width}px`,
        height: `${height}px`,
        display: "flex",
        position: "relative",
        overflow: "hidden",
        background: background ?? "transparent",
        fontFamily: '"Torus OG"',
        color: "#ffffff",
      },
    },
    children,
  );
}

/* The player's chosen background, as the bottom layer of any layout.
   `custom` means the player chose what is behind the text, so a layout's own
   decorative fills and glows have to step aside rather than paint over it.

   A scrim always rides on top of an IMAGE, and never on a painted colour. A
   picture is arbitrary (a white anime cover is a normal choice) and the text
   on it is not negotiable; a colour the player picked from a swatch they can
   see is a decision, and dimming it would just be the picker lying. */
async function styleLayers(
  ctx: SignatureRenderContext,
  spec: { width: number; height: number },
  sources: SignatureBackgroundSources,
): Promise<{ layers: ReactNode[]; custom: boolean }> {
  /* Site artwork comes first: it bakes its own base colour in, so it stands on
     its own rather than being a painted layer with a second one over it. */
  const art = await signatureArtLayers(ctx.request, ctx.style, spec.width, spec.height);
  if (art) return { custom: true, layers: art };

  const painted = stylePaintedBackground(ctx.style);
  if (painted) {
    return {
      custom: true,
      layers: [h("div", { key: "bg", style: { position: "absolute", ...FILL, background: painted } })],
    };
  }

  if (!styleUsesImage(ctx.style)) return { layers: [], custom: false };

  const url = await backgroundImageDataUrl(ctx.style, spec.width, spec.height, sources, SURFACE);
  if (!url) return { layers: [], custom: false };

  const scrim = scrimGradient(spec);

  return {
    custom: true,
    layers: [
      h("img", {
        key: "bg",
        src: url,
        width: spec.width,
        height: spec.height,
        style: {
          position: "absolute", top: "0", left: "0",
          width: `${spec.width}px`, height: `${spec.height}px`, objectFit: "cover",
        },
      }),
      h("div", { key: "scrim", style: { position: "absolute", ...FILL, background: scrim } }),
    ],
  };
}

/* `onBright` because the default is faint white, which on a Legendary front is
   white on gold - the mark disappears exactly where the background is
   loudest.

   Null when the player turned it off. Every layout puts the mark in its
   children array unconditionally and lets this decide, so nothing can end up
   with a mark that ignores the setting. */
function wordmark(style: SignatureStyle, right = 16, bottom = 12, onBright = false): ReactNode {
  if (!style.watermark) return null;
  return h("div", {
    key: "mark",
    style: {
      position: "absolute", right: `${right}px`, bottom: `${bottom}px`,
      fontSize: "11px",
      color: onBright ? "rgba(0,0,0,0.34)" : "rgba(255,255,255,0.28)",
      letterSpacing: "0.02em",
    },
  }, "mania-tracker.com");
}

/* The same mark, on the header line. A layout whose bottom-right corner is
   already spoken for - the insights ones end on the top play's pp - would
   otherwise print it straight through the number the image exists to show. */
function headerWordmark(style: SignatureStyle, right = 16, top = 14): ReactNode {
  if (!style.watermark) return null;
  return h("div", {
    key: "mark",
    style: {
      position: "absolute", right: `${right}px`, top: `${top}px`,
      fontSize: "11px",
      color: "rgba(255,255,255,0.28)",
      letterSpacing: "0.02em",
    },
  }, "mania-tracker.com");
}

/* The truthful render for "there is nothing to draw yet" - no open goals, no
   rated plays. It IS stored in R2, because that is a real answer for that
   data version. The route's separate placeholder, for a render that failed,
   is not stored and carries no ETag. */
export async function renderPlate(ctx: SignatureRenderContext, message: string): Promise<Buffer> {
  const spec = signatureDesign(ctx.type, ctx.design)!;
  return renderPng(ctx, frame(spec.width, spec.height, [
    h("div", {
      key: "wash",
      style: {
        position: "absolute", ...FILL,
        background: `radial-gradient(circle at 18% 30%, rgba(255,102,170,0.10) 0%, rgba(255,102,170,0) 60%)`,
      },
    }),
    h("div", {
      key: "body",
      style: {
        display: "flex", flexDirection: "column", justifyContent: "center",
        padding: "0 32px", width: "100%", gap: "8px",
      },
    }, [
      h("div", {
        key: "name",
        style: { fontSize: "15px", fontWeight: 900, color: "#ffffff", letterSpacing: "0.01em" },
      }, clamp(ctx.resolved.username, 24)),
      h("div", { key: "msg", style: { fontSize: "14px", color: TEXT_DIM, lineHeight: 1.35 } }, message),
    ]),
    wordmark(ctx.style),
  ]));
}

function statBlock(label: string, value: string, dim: string, color = "#ffffff"): ReactNode {
  return h("div", {
    key: label,
    style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: "0" },
  }, [
    h("div", {
      key: "v",
      style: { fontSize: "26px", fontWeight: 900, color, lineHeight: 1 },
    }, value),
    h("div", {
      key: "l",
      style: { fontSize: "10px", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: dim },
    }, label),
  ]);
}

function bar(width: number, pct: number, color: string, height = 8): ReactNode {
  const filled = Math.max(0, Math.min(100, pct));
  return h("div", {
    style: {
      display: "flex", width: `${width}px`, height: `${height}px`,
      borderRadius: `${height / 2}px`, background: "rgba(255,255,255,0.10)", overflow: "hidden",
    },
  }, [
    h("div", {
      key: "fill",
      style: { width: `${(filled / 100) * width}px`, height: "100%", background: color, borderRadius: `${height / 2}px` },
    }),
  ]);
}

// --- maniacard ---------------------------------------------------------

interface ProfileSnapshot {
  user?: {
    id?: number;
    username?: string;
    avatar_url?: string;
    country_code?: string;
    cover_url?: string | null;
    statistics?: { global_rank?: number | null; pp?: number | null } | null;
  };
  bestScores?: OsuScore[];
}

/* Both background images come off the profile payload: the osu! banner the
   player set, and the cover of the map behind their best play. */
function backgroundSourcesFrom(snapshot: ProfileSnapshot | null): SignatureBackgroundSources {
  const covers = snapshot?.bestScores?.[0]?.beatmapset?.covers;
  return {
    coverUrl: snapshot?.user?.cover_url ?? null,
    mapUrl: covers?.["cover@2x"] ?? covers?.cover ?? null,
  };
}

/* Only the maniacard and insights layouts read the profile for their own
   content, and both already hold the payload by the time they need a
   background. The other three fetch it solely to resolve one, so this stays
   behind the check - a signature styled "None" costs no extra call. It is one
   indexed read on the backend, and it happens once per version like everything
   else on this path. */
async function fetchBackgroundSources(ctx: SignatureRenderContext): Promise<SignatureBackgroundSources> {
  // A custom url needs no profile read at all - the address is already in the
  // style.
  if (!styleNeedsProfileImage(ctx.style)) return {};
  return backgroundSourcesFrom(await fetchProfileSnapshot(ctx.resolved.userId).catch(() => null));
}

/* cached-snapshot, not /snapshot: /snapshot queues a background osu! refresh,
   and an anonymous image fetch from a stranger's browser must not drive osu!
   API spend. It also keeps the pixels consistent with the version they are
   keyed under. */
async function fetchProfileSnapshot(userId: number): Promise<ProfileSnapshot | null> {
  const base = getServerLiveBackendUrl();
  if (!base) return null;
  const response = await fetch(`${base}/api/profiles/${userId}/cached-snapshot`);
  if (!response.ok) return null;
  return (await response.json()) as ProfileSnapshot;
}

/* The card itself, rather than a signature-shaped reading of it: the same
   element tree /api/og rasterizes for a share image and the Discord command
   replies with, so what someone embeds on their profile is the card they see
   on the page.
 *
 * Drawn at the card's own 720x1008 and scaled down, because every coordinate
 * in that tree is absolute against that size - satori has no layout scale, and
 * re-tuning a second copy of those numbers is exactly how the flat card and
 * the real one drift apart.
 *
 * The per-type background and accent do not reach this one. There is nothing
 * for them to act on: the card front is opaque, edge to edge, and the design
 * declares `ownArt` so the page hides those controls instead of offering
 * settings that do nothing. */
async function renderManiacardFront(
  ctx: SignatureRenderContext,
  user: { id?: number; username?: string; avatar_url?: string },
  skills: ManiaSkills,
  tier: ReturnType<typeof getManiaCardTier>,
  avatarUrl: string,
): Promise<Buffer> {
  const spec = signatureDesign(ctx.type, ctx.design)!;
  const [[regularFont, heavyFont], laurelUrl] = await Promise.all([
    loadOgFonts(ctx.request),
    cosmicLaurelDataUrl(ctx.request, tier).catch(() => null),
  ]);
  const response = new ImageResponse(
    maniaTierCardElement({
      username: clamp(user.username || ctx.resolved.username, 20),
      avatarUrl,
      tier,
      skills,
      laurelUrl,
    }),
    { width: MANIACARD_W, height: MANIACARD_H, fonts: ogFontList(regularFont, heavyFont) },
  );
  const { default: sharp } = await import("sharp");
  return sharp(Buffer.from(await response.arrayBuffer()))
    .resize(spec.width, spec.height, { fit: "fill" })
    .png()
    .toBuffer();
}

async function renderManiacard(ctx: SignatureRenderContext): Promise<Buffer> {
  const spec = signatureDesign(ctx.type, ctx.design)!;
  const snapshot = await fetchProfileSnapshot(ctx.resolved.userId);
  const user = snapshot?.user;
  const scores = snapshot?.bestScores ?? [];
  const skills = user
    ? computeManiaSkills(
        scores.map((score) => ({ ...score, statistics: score.statistics ?? {} })),
        { globalPp: user.statistics?.pp },
      )
    : null;
  if (!user || !skills) return renderPlate(ctx, "No ranked mania plays tracked yet.");

  const tier = getManiaCardTier(skills.cardPower);
  const avatarSize = ctx.design === 4 ? 454 : ctx.design === 3 ? 150 : ctx.design === 2 ? 96 : 140;
  const sourceAvatarUrl = ogAvatarUrl(ctx.request, user.avatar_url, user.id);
  /* resvg does not decode GIFs, so handing an animated osu! avatar straight
     to ImageResponse leaves the card's avatar frame blank. Dynamic renders
     are PNGs and cannot preserve the animation; flattening the first frame is
     the useful static representation, and also gives the rasterizer a
     consistently supported input format. Keep the original URL as a fallback
     for archived players whose avatar is a site-local asset. */
  const avatarUrl = await avatarSquareDataUrl(sourceAvatarUrl, avatarSize) ?? sourceAvatarUrl;
  if (ctx.design === 4) return renderManiacardFront(ctx, user, skills, tier, avatarUrl);

  const style = MANIA_TIER_STYLES[tier];
  const background = await styleLayers(ctx, spec, backgroundSourcesFrom(snapshot));
  const tierBacked = !background.custom && styleUsesTier(ctx.style);
  const statColor = accentHex(ctx.style, "rgba(255,255,255,0.88)");
  // The muted violet only works on the flat surface. On a tier front it is a
  // grey smear over gold, same as it would be over a photograph.
  const dim = background.custom || tierBacked ? TEXT_DIM_ON_ART : TEXT_DIM;
  const username = clamp(user.username || ctx.resolved.username, 20);
  /* No rank and no pp on the image. Both move on osu! faster than a cached
     snapshot can follow, so an embed showing them is wrong more often than it
     is right, and it is wrong right next to the profile that states the real
     numbers. Card power is derived from a top-plays set that moves slowly, so
     it can be stood behind. */

  const avatar = (size: number) => h("img", {
    key: "avatar",
    src: avatarUrl,
    width: size,
    height: size,
    style: {
      width: `${size}px`, height: `${size}px`, borderRadius: "18px", objectFit: "cover",
      // The card frames its image; on a bright front an unframed avatar reads
      // as a hole cut in the gradient.
      ...(tierBacked ? { border: "3px solid rgba(255,255,255,0.42)" } : {}),
    },
  });

  /* The tier as coloured text rather than a filled pill. A gold lozenge reads
     as a generic "badge" component from any web page; the tier's own colour on
     bare type reads as this card's tier. alignSelf keeps it to its own width -
     a flex child in a column stretches, and a tier label as wide as the card
     stops looking like a label at all. */
  const tierText = (align: "flex-start" | "center" = "flex-start") => h("div", {
    key: "tier",
    style: {
      display: "flex", alignSelf: align, alignItems: "center",
      fontSize: "13px", fontWeight: 900, letterSpacing: "0.16em",
      textTransform: "uppercase", color: tierTextColor(style),
    },
  }, style.label);

  /* The tier art is a background the player chose, not something every card
     wears. It used to be painted whenever no picture was set, which meant
     "None" still produced a gold wash. Now it draws only when it is the
     selected background, and every other choice carries the tier through the
     label alone. */
  const backdrop = [
    ...background.layers,
    ...(tierBacked ? tierLayers(tier, style, spec) : []),
  ];

  if (ctx.design === 2) {
    return renderPng(ctx, frame(spec.width, spec.height, [
      ...backdrop,
      h("div", {
        key: "row",
        style: { display: "flex", alignItems: "center", gap: "18px", padding: "0 22px", width: "100%" },
      }, [
        avatar(96),
        h("div", { key: "text", style: { display: "flex", flexDirection: "column", gap: "7px", flex: 1, minWidth: "0" } }, [
          h("div", { key: "n", style: { fontSize: "26px", fontWeight: 900, lineHeight: 1 } }, username),
          tierText(),
        ]),
        tierBacked
          ? tierPanel([statBlock("Card power", String(Math.round(skills.cardPower)), dim)], "power", "8px 14px", 12)
          : statBlock("Card power", String(Math.round(skills.cardPower)), dim),
      ]),
      wordmark(ctx.style, 12, 8, tierBacked),
    ]));
  }

  if (ctx.design === 3) {
    return renderPng(ctx, frame(spec.width, spec.height, [
      ...backdrop,
      h("div", {
        key: "col",
        style: {
          display: "flex", flexDirection: "column", alignItems: "center",
          width: "100%", padding: "38px 30px", gap: "18px",
        },
      }, [
        avatar(150),
        // The closest layout to the real card, so on the tier front it takes
        // the card's structure: a name plate, and the numbers on their own
        // plate. Bare white type on a Legendary gradient is the thing that
        // made this look unfinished.
        ...(tierBacked ? [
          tierPanel([
            h("div", { key: "n", style: { fontSize: "32px", fontWeight: 900, textAlign: "center", lineHeight: 1.1 } }, username),
            tierText("center"),
          ], "name", "10px 22px"),
          h("div", { key: "stats", style: { display: "flex", width: "100%", marginTop: "6px" } }, [
            tierPanel([
              h("div", {
                key: "power",
                style: { display: "flex", flexDirection: "column", alignItems: "center", gap: "2px", width: "100%" },
              }, [
                h("div", { key: "v", style: { fontSize: "58px", fontWeight: 900, lineHeight: 1 } }, String(Math.round(skills.cardPower))),
                h("div", {
                  key: "l",
                  style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase", color: dim },
                }, "Card power"),
              ]),
              h("div", {
                key: "rows",
                style: { display: "flex", flexDirection: "column", gap: "12px", marginTop: "16px" },
              }, cardStatRows(skills, 292, statColor)),
            ], "plate", "16px 18px", 18),
          ]),
        ] : [
          h("div", { key: "n", style: { fontSize: "34px", fontWeight: 900, textAlign: "center", lineHeight: 1.1 } }, username),
          tierText("center"),
          h("div", {
            key: "power",
            style: { display: "flex", flexDirection: "column", alignItems: "center", gap: "2px", marginTop: "6px" },
          }, [
            h("div", { key: "v", style: { fontSize: "60px", fontWeight: 900, lineHeight: 1 } }, String(Math.round(skills.cardPower))),
            h("div", {
              key: "l",
              style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase", color: dim },
            }, "Card power"),
          ]),
          h("div", {
            key: "stats",
            style: { display: "flex", flexDirection: "column", gap: "12px", width: "100%", marginTop: "14px" },
          }, cardStatRows(skills, 300, statColor)),
        ]),
      ]),
    ]));
  }

  // Design 1: banner.
  const nameBlock = [
    h("div", { key: "n", style: { fontSize: "38px", fontWeight: 900, lineHeight: 1 } }, username),
    tierText(),
  ];
  const bannerStatRows = cardStatRows(skills, 300, statColor);

  return renderPng(ctx, frame(spec.width, spec.height, [
    ...backdrop,
    h("div", {
      key: "row",
      style: { display: "flex", alignItems: "center", gap: "22px", padding: "0 26px", width: "100%" },
    }, [
      avatar(140),
      /* On the tier background the name and stats sit on the card's own dark
         plates rather than bare on the gradient. It is the difference between
         a card and a rectangle of colour, and it is what lets the front stay
         as bright as the real one instead of being dimmed until the text
         works. Everywhere else they stay bare - a panel over a flat surface is
         a box around nothing. */
      tierBacked
        ? tierPanel(nameBlock, "mid", "10px 16px")
        : h("div", { key: "mid", style: { display: "flex", flexDirection: "column", gap: "10px", width: "300px" } }, nameBlock),
      tierBacked
        ? h("div", { key: "statwrap", style: { display: "flex", flex: 1, justifyContent: "flex-end" } }, [
          tierPanel(
            [h("div", { key: "rows", style: { display: "flex", flexDirection: "column", gap: "9px" } }, bannerStatRows)],
            "stats",
            "12px 16px",
          ),
        ])
        : h("div", {
          key: "stats",
          style: { display: "flex", flexDirection: "column", gap: "10px", flex: 1, minWidth: "0" },
        }, bannerStatRows),
    ]),
    wordmark(ctx.style, 16, 12, tierBacked),
  ]));
}

/* The card's own front, not a tint of it. What this used to draw was
   `edgeFill` - the single dark colour the app uses for a card's EDGE - under a
   disc of glow, which is why it read as a plain gradient in the rarity's base
   colour. The front is the tier's full badge gradient with a fleck field over
   it, and for the two cosmic tiers a layered foil instead. Those are the same
   values the 3D card and the DOM card draw from, so nothing here can drift
   from a tier's real look.
 *
 * The scrim is not optional. A Legendary front starts at #fff7ad, and the
 * banner's name and stats are plain white on top - the same problem an
 * arbitrary photograph poses, and the same answer. */
export function tierLayers(
  tier: ReturnType<typeof getManiaCardTier>,
  style: (typeof MANIA_TIER_STYLES)[ReturnType<typeof getManiaCardTier>],
  spec: { width: number; height: number },
): ReactNode[] {
  const cosmic = getCosmicTierPalette(tier);
  const layer = (key: string, background: string) => h("div", {
    key,
    style: { position: "absolute", ...FILL, background },
  });

  const base = cosmic
    // Positions and radii carried over as fractions of the 1000x1400 card
    // texture the palette was tuned against.
    ? [
      layer("base", `linear-gradient(135deg, ${cosmic.base.map(([offset, color]) => `${color} ${offset * 100}%`).join(", ")})`),
      layer("foilA", `radial-gradient(circle at 25% 15%, ${cosmic.foilA[0]} 0%, ${cosmic.foilA[1]} 20%, rgba(0,0,0,0) 62%)`),
      layer("foilB", `radial-gradient(circle at 80% 79%, ${cosmic.foilB[0]} 0%, ${cosmic.foilB[1]} 26%, rgba(0,0,0,0) 58%)`),
      layer("aurora", `linear-gradient(125deg, ${cosmic.aurora[0]} 0%, ${cosmic.aurora[1]} 34%, ${cosmic.aurora[2]} 46%, ${cosmic.aurora[3]} 66%, ${cosmic.aurora[4]} 100%)`),
      h("img", {
        key: "stars",
        src: cosmicStarsDataUrl(spec.width, spec.height, cosmic.stars),
        width: spec.width,
        height: spec.height,
        style: { position: "absolute", top: "0", left: "0", width: `${spec.width}px`, height: `${spec.height}px` },
      }),
    ]
    : [
      layer("base", style.badgeGradient),
      h("img", {
        key: "flecks",
        src: tierFlecksDataUrl(spec.width, spec.height),
        width: spec.width,
        height: spec.height,
        style: { position: "absolute", top: "0", left: "0", width: `${spec.width}px`, height: `${spec.height}px` },
      }),
    ];

  return [
    ...base,
    /* The card's sheen: a highlight off the top-left corner and a shadow into
       the far one. Without it a gradient stretched across a wide banner is a
       flat wash - the card gets away with the same gradient because it is tall
       and lit. */
    layer("sheen", "linear-gradient(118deg, rgba(255,255,255,0.20) 0%, rgba(255,255,255,0) 24%, rgba(0,0,0,0) 46%, rgba(0,0,0,0.30) 100%)"),
    /* A rim in the tier's own bright colour. On the real card this is the
       border, and it is most of what makes a card look like an object rather
       than a rectangle of colour. */
    h("div", {
      key: "rim",
      style: {
        position: "absolute", ...FILL,
        border: `2px solid ${hexAlpha(tierTextColor(style), 0.55)}`,
        borderRadius: "4px",
      },
    }),
  ];
}

/* The dark plates the card puts its name and stats on. They are why the front
   can be bright and the text still legible: the card does not dim its whole
   face, it lays panels on it. Values from drawStats and drawBackTopPlate in
   cardTexture.ts - a soft black fill with a light hairline. */
const TIER_PANEL: Record<string, string> = {
  background: "rgba(0,0,0,0.34)",
  border: "1px solid rgba(255,255,255,0.16)",
};

function tierPanel(children: ReactNode[], key: string, padding: string, radius = 14): ReactNode {
  return h("div", {
    key,
    style: {
      display: "flex", flexDirection: "column", padding, borderRadius: `${radius}px`,
      ...TIER_PANEL,
    },
  }, children);
}

/* The same three stats the in-app card fronts, printed as the same numbers, so
   an embed and the card never disagree. The card itself draws them as bare
   numerals; the bar here is decoration on top of that and is scaled against
   CARD_STAT_SCALE, since these sit on a ~0-1000 range rather than a percent. */
const CARD_STAT_SCALE = 1000;

/* A tier's readable colour is the bright end of its badge gradient - glowColor
   carries an alpha and would print the label half transparent, and edgeFill is
   the dark end. Taking the first stop keeps every tier's text the exact hue
   the card uses, without a second table to keep in step. */
function tierTextColor(style: { badgeGradient: string }): string {
  return /#[0-9a-f]{6}/i.exec(style.badgeGradient)?.[0] ?? "#ffffff";
}

function cardStatRows(skills: ManiaSkills, width: number, color: string): ReactNode[] {
  const rows: Array<{ label: string; value: number }> = [
    { label: "Control", value: skills.fingerControl },
    { label: "Speed", value: skills.speed },
    { label: "Precision", value: skills.accuracy },
  ];
  return rows.map((row) => h("div", {
    key: row.label,
    style: { display: "flex", alignItems: "center", gap: "10px" },
  }, [
    h("div", {
      key: "l",
      style: { width: "76px", fontSize: "11px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "rgba(255,255,255,0.66)", flexShrink: 0 },
    }, row.label),
    bar(Math.max(40, width - 76 - 56), (row.value / CARD_STAT_SCALE) * 100, color),
    h("div", {
      key: "v",
      style: { width: "46px", fontSize: "14px", fontWeight: 900, textAlign: "right", flexShrink: 0 },
    }, String(Math.round(row.value))),
  ]));
}

// --- goals -------------------------------------------------------------

/* The bridge read, not fetchMyGoals from lib/goals.ts: that one is scoped to
   the viewer's cookie and marked private/no-store, and the viewer here is a
   stranger looking at someone's profile. The authority is the token. */
async function fetchGoals(userId: number): Promise<UserGoal[] | null> {
  const base = getServerLiveBackendUrl();
  if (!base) return null;
  const response = await fetch(`${base}/api/goals?userId=${userId}`, { headers: bridgeAuthHeaders() });
  if (!response.ok) return null;
  const body = (await response.json()) as { goals?: UserGoal[] };
  return body.goals ?? [];
}

/* Per-kind readout, mirroring GoalReadout in GoalsPanel. A raw current/target
   pair is wrong for most kinds: accuracy lives in 0-1 (so it rounds to "1 / 1"),
   and a reach-pp goal reads better as the gap than as the pair. */
function goalReadout(goal: UserGoal): string {
  const current = goal.progress?.current ?? null;
  const target = goal.progress?.target ?? goal.targetValue ?? null;
  const pct = goal.progress?.pct ?? 0;
  switch (goal.kind) {
    case "reach_pp": {
      if (current == null || target == null) break;
      const remaining = Math.max(0, target - current);
      return remaining > 0 ? `${nf(remaining)}pp to go` : "done";
    }
    case "reach_rank":
      return current != null ? `now #${nf(current)}` : `${Math.round(pct)}%`;
    case "play_pp":
      if (current != null && current > 0) return `best ${Math.round(current)}pp`;
      return target != null ? `chasing ${Math.round(target)}pp` : `${Math.round(pct)}%`;
    case "play_pp_count":
      if (current == null || target == null) break;
      /* nf() already rounds these to whole plays. trimZeros is for a decimal
         tail and would eat real digits here - it turned "20" into "2". */
      return `${nf(current)} / ${nf(target)} plays`;
    case "accuracy":
      if (current == null) break;
      return `best ${(current * 100).toFixed(2)}%`;
    case "grade":
      if (goal.progress?.currentGrade) return `best ${goal.progress.currentGrade}`;
      break;
    default:
      break;
  }
  return `${Math.round(pct)}%`;
}

export function goalsForDynamicRender(goals: UserGoal[]): UserGoal[] {
  const open = goals
    .filter((goal) => goal.status === "open")
    .sort((a, b) => (b.progress?.pct ?? 0) - (a.progress?.pct ?? 0));
  const completed = goals
    .filter((goal) => goal.status === "completed")
    .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt));
  return [...open, ...completed];
}

export function completedGoalDate(goal: UserGoal, timeZone: string | null): string | null {
  if (goal.status !== "completed" || goal.completedAt == null) return null;
  return formatDate(new Date(goal.completedAt).toISOString(), timeZone ?? "UTC");
}

/* The tick. Drawn as an SVG image rather than a text glyph: satori lays text
   out with the fonts the card loaded, and Torus has no check in it. */
function checkGlyphDataUrl(color: string): string {
  return svgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">`
    + `<path d="M4.5 12.6 L9.8 18 L19.5 6.6" fill="none" stroke="${color}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`
    + `</svg>`,
  );
}

/* A goal is a thing you tick off, so a cleared one is a checked box - a bar
   filled to its end is a progress meter saying nothing but "100". The open
   box is still the progress meter: it fills from the bottom by the same
   percentage, in one small square instead of across the whole row. */
function goalCheckbox(size: number, pct: number, done: boolean, accent: string): ReactNode {
  const radius = Math.round(size * 0.3);
  if (done) {
    const glyph = Math.round(size * 0.68);
    return h("div", {
      key: "box",
      style: {
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        width: `${size}px`, height: `${size}px`, borderRadius: `${radius}px`, background: accent,
      },
    }, [
      // The same near-black tint the mod badges put over their colour, so the
      // tick stays readable on a pale accent as well as a saturated one.
      h("img", { key: "tick", src: checkGlyphDataUrl(modGlyphColor(accent)), width: glyph, height: glyph }),
    ]);
  }
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * size);
  return h("div", {
    key: "box",
    style: {
      display: "flex", position: "relative", overflow: "hidden", flexShrink: 0,
      width: `${size}px`, height: `${size}px`, borderRadius: `${radius}px`,
      border: `2px solid ${hexAlpha(accent, 0.45)}`, background: "rgba(255,255,255,0.05)",
    },
  }, [
    h("div", {
      key: "fill",
      style: { position: "absolute", left: 0, right: 0, bottom: 0, height: `${filled}px`, background: hexAlpha(accent, 0.32) },
    }),
  ]);
}

/* How big a checklist row is drawn.

   Derived from the room each row actually gets - the card's height divided by
   how many goals it is drawing - rather than from which layout it is. The
   tall list reserves space for five goals, and a player with two of them was
   getting five-row type adrift in a card sized for five rows. */
interface GoalRowSize {
  box: number;
  label: number;
  note: number;
  pct: number;
  pctWidth: number;
  gap: number;
  rowGap: number;
  clamp: number;
}

/* Header, footer and the body padding. What is left over is the rows'. */
const GOAL_LIST_CHROME = 76;

const GOAL_ROW_SIZES: Array<GoalRowSize & { minRoom: number }> = [
  { minRoom: 66, box: 30, label: 19, note: 14.5, pct: 22, pctWidth: 56, gap: 15, rowGap: 26, clamp: 50 },
  { minRoom: 50, box: 26, label: 17, note: 13.5, pct: 19, pctWidth: 50, gap: 14, rowGap: 20, clamp: 54 },
  { minRoom: 38, box: 22, label: 15, note: 12.5, pct: 16, pctWidth: 44, gap: 12, rowGap: 16, clamp: 56 },
  { minRoom: 0, box: 18, label: 13, note: 11.5, pct: 14, pctWidth: 38, gap: 10, rowGap: 12, clamp: 52 },
];

export function goalRowSize(rows: number, height: number): GoalRowSize {
  const room = Math.max(0, height - GOAL_LIST_CHROME) / Math.max(1, rows);
  return GOAL_ROW_SIZES.find((size) => room >= size.minRoom) ?? GOAL_ROW_SIZES[GOAL_ROW_SIZES.length - 1]!;
}

/* One line of the checklist: box, what the goal is, and what it is at.

   The right end carries the percentage for an open goal and nothing for a
   cleared one - the box has already said "done", and a second "100%" beside
   it is the filled-bar problem again in smaller type. */
function goalRow(
  goal: UserGoal,
  accent: string,
  dim: string,
  timeZone: string | null,
  size: GoalRowSize,
): ReactNode {
  const done = goal.status === "completed";
  const completedDate = completedGoalDate(goal, timeZone);
  const pct = done ? 100 : (goal.progress?.pct ?? 0);
  const note = done
    ? completedDate ?? "Completed"
    : goalReadout(goal);
  return h("div", {
    key: goal.id,
    style: { display: "flex", alignItems: "center", gap: `${size.gap}px`, width: "100%" },
  }, [
    goalCheckbox(size.box, pct, done, accent),
    h("div", {
      key: "l",
      // flexShrink on the label, not the readout: a long map name should be
      // the thing that gives way, never the number the image exists for.
      style: {
        fontSize: `${size.label}px`, fontWeight: 700,
        color: done ? "rgba(255,255,255,0.72)" : "#ffffff",
        overflow: "hidden", flexShrink: 1, minWidth: "0",
      },
    }, clamp(describeGoalEnglish(goal), size.clamp)),
    h("div", {
      key: "r",
      style: {
        display: "flex", alignItems: "baseline", gap: "10px", marginLeft: "auto",
        flexShrink: 0, whiteSpace: "nowrap",
      },
    }, [
      h("div", { key: "n", style: { fontSize: `${size.note}px`, color: dim } }, note),
      done
        ? h("div", { key: "p" })
        : h("div", {
          key: "p",
          style: {
            fontSize: `${size.pct}px`, fontWeight: 900, color: accent,
            width: `${size.pctWidth}px`, display: "flex", justifyContent: "flex-end",
          },
        }, `${Math.round(pct)}%`),
    ]),
  ]);
}

/* The single-goal layout's meter. A ring rather than a row-wide bar, which is
   what the goals page itself draws for a continuous climb. */
function goalRingDataUrl(size: number, stroke: number, pct: number, accent: string): string {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const drawn = (Math.max(0, Math.min(100, pct)) / 100) * circumference;
  const centre = size / 2;
  return svgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<circle cx="${centre}" cy="${centre}" r="${radius}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="${stroke}"/>`
    + `<circle cx="${centre}" cy="${centre}" r="${radius}" fill="none" stroke="${accent}" stroke-width="${stroke}"`
    + ` stroke-linecap="round" stroke-dasharray="${drawn.toFixed(2)} ${(circumference - drawn).toFixed(2)}"`
    + ` transform="rotate(-90 ${centre} ${centre})"/>`
    + `</svg>`,
  );
}

/** The ring with its reading inside: the percentage, or a tick once cleared. */
function goalRing(size: number, pct: number, done: boolean, accent: string): ReactNode {
  return h("div", {
    key: "ring",
    style: {
      display: "flex", position: "relative", flexShrink: 0,
      width: `${size}px`, height: `${size}px`, alignItems: "center", justifyContent: "center",
    },
  }, [
    h("img", {
      key: "arc",
      src: goalRingDataUrl(size, 6, done ? 100 : pct, accent),
      width: size,
      height: size,
      style: { position: "absolute", top: "0", left: "0" },
    }),
    done
      ? h("img", { key: "tick", src: checkGlyphDataUrl(accent), width: Math.round(size * 0.42), height: Math.round(size * 0.42) })
      : h("div", { key: "pct", style: { fontSize: `${Math.round(size * 0.27)}px`, fontWeight: 900, color: "#ffffff" } }, `${Math.round(pct)}%`),
  ]);
}

async function renderGoals(ctx: SignatureRenderContext): Promise<Buffer> {
  const spec = signatureDesign(ctx.type, ctx.design)!;
  const goals = await fetchGoals(ctx.resolved.userId);
  if (goals == null) return renderPlate(ctx, "Goals are unavailable right now.");
  const ordered = goalsForDynamicRender(goals);
  const completed = ordered.filter((goal) => goal.status === "completed");

  if (ordered.length === 0) return renderPlate(ctx, "No goals yet.");

  const background = await styleLayers(ctx, spec, await fetchBackgroundSources(ctx));
  const accent = accentHex(ctx.style, ACCENT);
  const dim = background.custom ? TEXT_DIM_ON_ART : TEXT_DIM;

  const header = h("div", {
    key: "head",
    style: { display: "flex", alignItems: "baseline", gap: "10px" },
  }, [
    h("div", { key: "n", style: { fontSize: "17px", fontWeight: 900 } }, clamp(ctx.resolved.username, 22)),
    h("div", {
      key: "l",
      style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase", color: dim },
    }, "Goals"),
  ]);

  if (ctx.design === 2) {
    const goal = ordered[0]!;
    const done = goal.status === "completed";
    const completedDate = completedGoalDate(goal, ctx.resolved.timeZone);
    const pct = done ? 100 : (goal.progress?.pct ?? 0);
    /* One goal gets the ring the goals page draws for it, not a row-wide bar:
       the reading belongs next to the goal rather than stretched under it. */
    const detail = !done && goal.progress?.detail ? goal.progress.detail : null;
    return renderPng(ctx, frame(spec.width, spec.height, [
      ...background.layers,
      h("div", {
        key: "body",
        style: { display: "flex", alignItems: "center", gap: "18px", padding: "0 26px", width: "100%" },
      }, [
        goalRing(74, pct, done, accent),
        h("div", {
          key: "text",
          style: { display: "flex", flexDirection: "column", gap: "6px", flexShrink: 1, minWidth: "0" },
        }, [
          h("div", {
            key: "l",
            style: { fontSize: "16px", fontWeight: 900, color: "#ffffff", overflow: "hidden" },
          }, clamp(describeGoalEnglish(goal), 38)),
          h("div", {
            key: "n",
            style: { fontSize: "12.5px", color: done ? accent : dim },
          }, done ? (completedDate ? `Completed · ${completedDate}` : "Completed") : goalReadout(goal)),
          detail
            ? h("div", { key: "d", style: { fontSize: "11.5px", color: dim } }, clamp(detail, 54))
            : h("div", { key: "d" }),
        ]),
      ]),
      wordmark(ctx.style, 12, 8),
    ]));
  }

  const limit = ctx.design === 3 ? 5 : 3;
  const shown = ordered.slice(0, limit);
  const rest = ordered.length - shown.length;
  const size = goalRowSize(shown.length, spec.height);

  return renderPng(ctx, frame(spec.width, spec.height, [
    ...background.layers,
    h("div", {
      key: "body",
      style: { display: "flex", flexDirection: "column", gap: "10px", padding: "18px 28px 16px", width: "100%" },
    }, [
      header,
      /* The rows are centred in whatever space is left rather than stacked
         under the header: the design's height is fixed (it is part of the
         cache key), so a player with three goals in the five-row design would
         otherwise get a card that is half empty at the bottom. */
      h("div", {
        key: "rows",
        style: { display: "flex", flexDirection: "column", gap: `${size.rowGap}px`, flex: 1, justifyContent: "center" },
      }, shown.map((goal) => goalRow(goal, accent, dim, ctx.resolved.timeZone, size))),
      h("div", {
        key: "foot",
        style: { display: "flex", gap: "14px", fontSize: "11px", color: dim },
      }, [
        rest > 0 ? h("span", { key: "more" }, `+${rest} more`) : h("span", { key: "more" }),
        completed.length > 0
          ? h("span", { key: "done" }, `${completed.length} of ${ordered.length} done`)
          : h("span", { key: "done" }),
      ]),
    ]),
    wordmark(ctx.style),
  ]));
}

// --- skills and dan ----------------------------------------------------

async function fetchSkills(userId: number): Promise<MyDataSkillBreakdown | null> {
  const base = getServerLiveBackendUrl();
  if (!base) return null;
  const response = await fetch(`${base}/api/profiles/${userId}/skills`);
  if (!response.ok) return null;
  return (await response.json()) as MyDataSkillBreakdown;
}

/* The keymode is per type and lives in the style, so a player can showcase a
   4K radar beside a 7K dan. The legacy per-player column is the fallback for
   rows written before that, and the first qualifying mode is the fallback for
   everyone else - picking a keymode with no rated plays behind it should show
   the one they actually have, not an empty card. */
function pickMode(
  ctx: SignatureRenderContext,
  skills: MyDataSkillBreakdown,
  keyCount = ctx.style.keyCount,
): MyDataSkillMode | null {
  const modes = qualifyingSkillModes(skills);
  if (modes.length === 0) return null;
  const preferred = keyCount ?? ctx.resolved.skillsKeyCount;
  return modes.find((mode) => mode.keyCount === preferred) ?? modes[0]!;
}

function skillsUnavailable(skills: MyDataSkillBreakdown | null): string | null {
  if (!skills) return "Skill ratings are unavailable right now.";
  if (skills.status === "pending") return "The chart analyzer is rating these plays.";
  if (skills.status === "failed") return "Rating failed, it retries automatically.";
  return null;
}

/* The radar is one SVG handed to satori as an <img>: satori has no canvas, and
   its own SVG element support is partial. Geometry comes from lib/skill-axes
   so this draws the same chart the profile page does. */
/* The radar's geometry and its labels are drawn by different machinery on
   purpose. Rings, spokes and the polygon are one SVG handed to satori as an
   <img>, because satori has no canvas and only partial SVG element support.
   The labels are not in there: text inside an embedded SVG is laid out by the
   rasterizer, which never sees the fonts loaded for the card, so it fell back
   to a default face and printed "Chordstream" wider and softer than every
   other word on the image. As satori nodes they use Torus like everything
   else. */
function radarGeometryFor(entries: ReturnType<typeof skillModeEntries>, width: number, height: number) {
  const fontSize = Math.max(9, Math.round(Math.min(width, height) * 0.046));
  /* Side labels run outward from labelR by their full width. The profile
     panel buys that room with a box wider than it is tall; here the box is
     fixed by the design, so the ring shrinks to fit the longest label instead
     of letting "Chordstream" clip at the edge. */
  const longest = entries.reduce((max, entry) => Math.max(max, entry.label.length), 0);
  const labelWidth = Math.ceil(longest * fontSize * 0.58);
  const labelR = Math.max(36, Math.min(width / 2 - labelWidth - 4, height / 2 - fontSize - 6));
  return { fontSize, labelWidth, geo: radarGeometry({ width, height, maxR: labelR * 0.8, labelR }) };
}

/** The axis names, positioned over the radar image as real text nodes. */
function radarLabels(
  entries: ReturnType<typeof skillModeEntries>,
  width: number,
  height: number,
  color: string,
): ReactNode[] {
  const { fontSize, labelWidth, geo } = radarGeometryFor(entries, width, height);
  const max = entries[0]?.value ?? 1;
  return radarPoints(entries, max, geo).map((point) => {
    const anchor = radarAnchor(point.angle);
    // Each label sits in a box of the width the ring already reserved, aligned
    // the way its anchor would have aligned the text.
    const left = anchor === "start" ? point.labelX
      : anchor === "end" ? point.labelX - labelWidth
      : point.labelX - labelWidth / 2;
    return h("div", {
      key: point.entry.key,
      style: {
        position: "absolute",
        left: `${Math.round(left)}px`,
        // radarLabelDy nudges an SVG baseline; here the box is centred on the
        // point and given the same nudge.
        top: `${Math.round(point.labelY + radarLabelDy(point.angle) - fontSize * 0.9)}px`,
        width: `${labelWidth}px`,
        display: "flex",
        justifyContent: anchor === "start" ? "flex-start" : anchor === "end" ? "flex-end" : "center",
        fontSize: `${fontSize}px`,
        fontWeight: 700,
        color,
        whiteSpace: "nowrap",
      },
    }, point.entry.label);
  });
}

function radarSvg(entries: ReturnType<typeof skillModeEntries>, width: number, height: number, accent: string): string {
  const { geo } = radarGeometryFor(entries, width, height);
  const max = entries[0]?.value ?? 1;
  const points = radarPoints(entries, max, geo);
  const rings = RADAR_RINGS
    .map((fraction) => `<polygon points="${ringPolygon(entries.length, fraction, geo)}" fill="none" stroke="rgba(255,255,255,0.13)" stroke-width="1"/>`)
    .join("");
  const spokes = points
    .map((point) => `<line x1="${geo.cx}" y1="${geo.cy}" x2="${geo.cx + Math.cos(point.angle) * geo.maxR}" y2="${geo.cy + Math.sin(point.angle) * geo.maxR}" stroke="rgba(255,255,255,0.10)" stroke-width="1"/>`)
    .join("");
  const shape = points.map((point) => `${point.x},${point.y}`).join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `${rings}${spokes}`
    + `<polygon points="${shape}" fill="${accent}" fill-opacity="0.28" stroke="${accent}" stroke-width="2"/>`
    + points.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="2.6" fill="${point.entry.color}"/>`).join("")
    + `</svg>`;
}

async function renderSkills(ctx: SignatureRenderContext): Promise<Buffer> {
  const spec = signatureDesign(ctx.type, ctx.design)!;
  const skills = await fetchSkills(ctx.resolved.userId);
  const unavailable = skillsUnavailable(skills);
  if (unavailable) return renderPlate(ctx, unavailable);
  const mode = pickMode(ctx, skills!);
  if (!mode) return renderPlate(ctx, "None of these plays could be rated yet.");
  const entries = skillModeEntries(mode);
  if (entries.length < 3) return renderPlate(ctx, "Not enough rated plays for a radar yet.");

  /* Auto keeps the top skillset's own colour, which is what the profile panel
     draws. A chosen accent overrides the polygon only - the per-axis dots stay
     their skillset colours, because those encode which axis is which rather
     than being decoration. */
  const accent = accentHex(ctx.style, entries[0]!.color);
  const background = await styleLayers(ctx, spec, await fetchBackgroundSources(ctx));
  const dim = background.custom ? TEXT_DIM_ON_ART : TEXT_DIM;
  const overall = Number(mode.ratings.Overall ?? 0);
  const keyChip = h("div", {
    key: "keys",
    style: {
      display: "flex", padding: "3px 10px", borderRadius: "999px", background: "rgba(255,255,255,0.10)",
      fontSize: "11px", fontWeight: 700, letterSpacing: "0.06em", color: "rgba(255,255,255,0.78)",
    },
  }, `${mode.keyCount}K${mode.provisional ? " · provisional" : ""}`);

  if (ctx.design === 3) {
    return renderPng(ctx, frame(spec.width, spec.height, [
      ...background.layers,
      h("img", {
        key: "radar",
        src: svgDataUrl(radarSvg(entries, spec.width, spec.width, accent)),
        width: spec.width,
        height: spec.width,
        style: { position: "absolute", top: "0", left: "0", width: `${spec.width}px`, height: `${spec.width}px` },
      }),
      // Absolute against the frame, which is the same box the radar image
      // occupies here, so the label coordinates need no offset.
      ...radarLabels(entries, spec.width, spec.width, RADAR_LABEL_COLOR),
      h("div", {
        key: "centre",
        style: {
          position: "absolute", top: "0", left: "0", width: `${spec.width}px`, height: `${spec.height}px`,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1px",
        },
      }, [
        h("div", { key: "v", style: { fontSize: "26px", fontWeight: 900 } }, overall.toFixed(2)),
        h("div", {
          key: "l",
          style: { fontSize: "9px", fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase", color: dim },
        }, "overall"),
      ]),
      h("div", { key: "chip", style: { position: "absolute", left: "12px", top: "12px", display: "flex" } }, [keyChip]),
    ]));
  }

  const axisRows = (count: number, width: number) => entries.slice(0, count).map((entry) => {
    const percentile = mode.percentiles?.[entry.axis];
    return h("div", {
      key: entry.key,
      style: { display: "flex", alignItems: "center", gap: "10px" },
    }, [
      h("div", { key: "l", style: { width: "104px", fontSize: "12px", fontWeight: 700, color: "rgba(255,255,255,0.80)" } }, entry.label),
      bar(width, (entry.value / (entries[0]!.value || 1)) * 100, entry.color, 7),
      h("div", { key: "v", style: { width: "44px", fontSize: "13px", fontWeight: 900, textAlign: "right" } }, entry.value.toFixed(1)),
      h("div", {
        key: "p",
        style: { width: "58px", fontSize: "10px", color: dim, textAlign: "right" },
      }, percentile ? formatTopShare(percentile.value) : ""),
    ]);
  });

  if (ctx.design === 2) {
    return renderPng(ctx, frame(spec.width, spec.height, [
      ...background.layers,
      h("div", {
        key: "body",
        style: { display: "flex", flexDirection: "column", gap: "9px", padding: "18px 24px", width: "100%" },
      }, [
        h("div", { key: "head", style: { display: "flex", alignItems: "center", gap: "10px" } }, [
          h("div", { key: "n", style: { fontSize: "16px", fontWeight: 900 } }, clamp(ctx.resolved.username, 22)),
          keyChip,
          h("div", { key: "o", style: { marginLeft: "auto", fontSize: "16px", fontWeight: 900, color: accent } }, overall.toFixed(2)),
        ]),
        ...axisRows(6, spec.width - 48 - 104 - 44 - 58 - 30),
      ]),
      wordmark(ctx.style, 12, 8),
    ]));
  }

  // Design 1: radar with the top axes beside it. The radar box is wider than
  // tall for the same reason the profile panel's is - side labels need the
  // horizontal room, and the height here is fixed by the design.
  const radarSize = spec.height - 16;
  const radarWidth = Math.round(radarSize * 1.36);
  return renderPng(ctx, frame(spec.width, spec.height, [
    ...background.layers,
    h("div", { key: "row", style: { display: "flex", width: "100%", alignItems: "center", padding: "8px 26px 8px 6px", gap: "12px" } }, [
      // The image and its labels share one positioned box, so the label
      // coordinates are the same ones the geometry was built from.
      h("div", {
        key: "radar",
        style: {
          position: "relative", display: "flex", flexShrink: 0,
          width: `${radarWidth}px`, height: `${radarSize}px`,
        },
      }, [
        h("img", {
          key: "svg",
          src: svgDataUrl(radarSvg(entries, radarWidth, radarSize, accent)),
          width: radarWidth,
          height: radarSize,
          style: { position: "absolute", top: "0", left: "0", width: `${radarWidth}px`, height: `${radarSize}px` },
        }),
        ...radarLabels(entries, radarWidth, radarSize, RADAR_LABEL_COLOR),
      ]),
      h("div", { key: "right", style: { display: "flex", flexDirection: "column", gap: "9px", flex: 1, minWidth: "0" } }, [
        h("div", { key: "head", style: { display: "flex", alignItems: "center", gap: "10px" } }, [
          h("div", { key: "n", style: { fontSize: "18px", fontWeight: 900 } }, clamp(ctx.resolved.username, 20)),
          keyChip,
        ]),
        ...axisRows(4, spec.width - radarWidth - 104 - 44 - 58 - 76),
      ]),
    ]),
    wordmark(ctx.style),
  ]));
}

// --- dan ---------------------------------------------------------------

function formatDanChip(label: string): string {
  return /^\d/.test(label) ? `${label} dan` : label;
}

/* A dan label carries a band suffix (chart-classifier's TIER_VARIANTS: --, -,
   +, ++), so a player sits at "9-" or "8++". The artwork is keyed on the bare
   level, which has no per-band variant, so the suffix has to come off before
   the lookup or every banded player silently loses their emblem. The text
   keeps the full label - the band is real information. */
function danArtworkLabel(label: string): string {
  return label.replace(/(\+\+|--|\+|-)$/, "");
}

async function danEmblemDataUrl(
  request: Request,
  label: string,
  family: "rc" | "ln",
  keyCount: number,
): Promise<string | null> {
  // The artwork lookup takes the LN/rice family, and returns null for a label
  // that keymode has no emblem for - which is why the caller falls back to a
  // text-only badge rather than emitting a broken <img>.
  const src = getDanImageSrc(danArtworkLabel(label), family === "ln" ? "ln" : undefined, keyCount);
  if (!src) return null;
  try {
    const { getAssetOrigin } = await import("../../../lib/origin");
    const response = await fetch(new URL(src, getAssetOrigin(request)).toString());
    if (!response.ok) return null;
    const body = Buffer.from(await response.arrayBuffer());
    if (src.endsWith(".svg")) return `data:image/svg+xml;base64,${body.toString("base64")}`;
    /* The 4K bands above 10th dan - alpha through kappa - ship as .webp while
       every other ladder is .svg, and this used to hand satori webp bytes
       labelled image/png. That decodes as nothing, so exactly the players with
       the rarest badge got a card with a hole where it should be. Re-encoding
       is cheaper than trusting either end to agree on webp. */
    const { default: sharp } = await import("sharp");
    const png = await sharp(body).png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

async function renderDan(ctx: SignatureRenderContext): Promise<Buffer> {
  const spec = signatureDesign(ctx.type, ctx.design)!;
  const skills = await fetchSkills(ctx.resolved.userId);
  const unavailable = skillsUnavailable(skills);
  if (unavailable) return renderPlate(ctx, unavailable);
  /* The two ladders are picked separately. A player's rice and LN dans very
     often sit in different keymodes - 7K rice beside a 4K LN is an ordinary
     thing to have - and one keymode for the whole card made that a choice
     between two true things. lnKeyCount defaults to the rice one, so a card
     that never touches it behaves exactly as before. */
  const riceMode = pickMode(ctx, skills!);
  const lnMode = pickMode(ctx, skills!, ctx.style.lnKeyCount ?? ctx.style.keyCount);
  const sides = [
    { id: "rc", label: "Regular", side: riceMode?.dan?.rc, keyCount: riceMode?.keyCount },
    { id: "ln", label: "LN", side: lnMode?.dan?.ln, keyCount: lnMode?.keyCount },
  ].filter((entry) => entry.side != null && entry.keyCount != null) as Array<{
    id: string; label: string; keyCount: number; side: { rawDan: number; label: string; clears: number };
  }>;
  if (sides.length === 0) return renderPlate(ctx, "Not enough dan-level clears yet.");

  const chosen = ctx.design === 1
    ? sides
    : [sides.reduce((best, entry) => (entry.side.clears > best.side.clears ? entry : best), sides[0]!)];

  const emblemSize = ctx.design === 3 ? 150 : ctx.design === 2 ? 96 : 118;
  const emblems = await Promise.all(chosen.map(async (entry) => ({
    ...entry,
    url: await danEmblemDataUrl(ctx.request, entry.side.label, entry.id === "ln" ? "ln" : "rc", entry.keyCount),
  })));

  const sideBlock = (entry: (typeof emblems)[number], vertical: boolean) => h("div", {
    key: entry.id,
    style: {
      display: "flex", flexDirection: vertical ? "column" : "row", alignItems: "center",
      gap: vertical ? "10px" : "16px", flex: 1, minWidth: "0", justifyContent: "center",
    },
  }, [
    entry.url
      ? h("img", { key: "e", src: entry.url, width: emblemSize, height: emblemSize, style: { width: `${emblemSize}px`, height: `${emblemSize}px`, objectFit: "contain" } })
      : h("div", { key: "e" }),
    h("div", {
      key: "t",
      style: { display: "flex", flexDirection: "column", gap: "3px", alignItems: vertical ? "center" : "flex-start" },
    }, [
      /* The keymode rides on each side rather than in one corner chip: with
         the two ladders now independent, a single chip would be a claim about
         both that is only true of one. */
      h("div", {
        key: "s",
        style: { fontSize: "11px", fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase", color: dim },
      }, `${entry.label} ${entry.keyCount}K`),
      h("div", {
        key: "v",
        // Auto stays white here: a dan level is the headline, and tinting it by
        // default would read as a status colour rather than a choice.
        style: { fontSize: "24px", fontWeight: 900, color: accentHex(ctx.style, "#ffffff") },
      }, `~${formatDanChip(entry.side.label)}`),
    ]),
  ]);

  const background = await styleLayers(ctx, spec, await fetchBackgroundSources(ctx));
  const glow = accentHex(ctx.style, ACCENT);
  const dim = background.custom ? TEXT_DIM_ON_ART : TEXT_DIM;
  const backdrop = [
    ...background.layers,
    // Same rule as the maniacard's tier glow: a soft disc of accent colour
    // reads as lighting on a flat card and as a smudge over a photograph.
    ...(background.custom ? [] : [
      h("div", {
        key: "wash",
        style: {
          position: "absolute", ...FILL,
          background: `radial-gradient(circle at 50% 20%, ${hexAlpha(glow, 0.16)} 0%, ${hexAlpha(glow, 0)} 62%)`,
        },
      }),
    ]),
  ];

  if (ctx.design === 3) {
    return renderPng(ctx, frame(spec.width, spec.height, [
      ...backdrop,
      h("div", {
        key: "body",
        style: { display: "flex", width: "100%", alignItems: "center", justifyContent: "center", padding: "24px" },
      }, [sideBlock(emblems[0]!, true)]),
    ]));
  }

  return renderPng(ctx, frame(spec.width, spec.height, [
    ...backdrop,
    h("div", {
      key: "body",
      style: { display: "flex", width: "100%", alignItems: "center", padding: "0 26px", gap: "20px" },
    }, emblems.map((entry) => sideBlock(entry, false))),
    h("div", {
      key: "name",
      style: { position: "absolute", left: "16px", bottom: "12px", fontSize: "12px", color: dim },
    }, clamp(ctx.resolved.username, 22)),
    wordmark(ctx.style),
  ]));
}

// --- insights ----------------------------------------------------------

/* The profile page's stat panel, as an image: key split, most used mod,
   median BPM, pp range, and the newest top play.
 *
 * The oldest top play is not here on purpose. It is the one reading on that
 * panel that never changes - by definition the play that will still be the
 * oldest next year - so on a surface whose whole promise is "it redraws when
 * your stats change" it is the line that never would.
 *
 * The numbers come from calculateUserProfileInsights over the same cached
 * top-play window the profile page computes them from, so the image and the
 * page cannot disagree about what a player's split or median is. */

/* Keymode colours, matching KeySplitCard. Fixed hues rather than the theme's:
   osu-pink is derived from --theme-hue, so a split painted with it collapses
   onto 4K's blue on a blue theme, and keymode identity has to read the same
   everywhere. */
const KEY_MODE_COLORS: Record<number, string> = {
  4: "#66ccff", 5: "#b3d944", 6: "#aa88ff", 7: "#ff8e5d", 8: "#ffcc22", 9: "#ed7887", 10: "#88b300",
};

/* The cover band's height. One number for both layouts that carry it: it sets
   the card's shape, the size the cover is resized to, and how much room the
   layout above it has left, so the three cannot drift apart. */
const TOP_PLAY_CARD_HEIGHT = 78;

function keyModeColor(keyCount: number): string {
  return KEY_MODE_COLORS[keyCount] ?? "#ffffff";
}

/* Like bar(), but the track is divided rather than filled: each keymode gets
   its share in its own colour. Widths are floored and the last segment takes
   the remainder, so rounding cannot leave a sliver of track showing at the
   end of a split that adds up to 100%. */
function segmentedBar(
  width: number,
  segments: Array<{ pct: number; color: string }>,
  height = 6,
): ReactNode {
  let used = 0;
  const drawn = segments.map((segment, index) => {
    const span = index === segments.length - 1
      ? Math.max(0, width - used)
      : Math.floor((Math.max(0, segment.pct) / 100) * width);
    used += span;
    return { span, color: segment.color };
  });
  return h("div", {
    style: {
      display: "flex", width: `${width}px`, height: `${height}px`,
      borderRadius: `${height / 2}px`, background: "rgba(255,255,255,0.10)", overflow: "hidden",
    },
  }, drawn.map((segment, index) => h("div", {
    key: String(index),
    style: { width: `${segment.span}px`, height: "100%", background: segment.color },
  })));
}

/* One reading. The cells sit in a row divided by hairlines rather than in four
   bordered boxes, which is how the profile page draws them: four boxes would
   be four objects where the page has one. */
function insightCell(
  key: string,
  label: string,
  dim: string,
  value: ReactNode,
  footer: ReactNode,
  width: number,
  first: boolean,
): ReactNode {
  return h("div", {
    key,
    style: {
      display: "flex", flexDirection: "column", width: `${width}px`, minWidth: "0",
      flexShrink: 0, overflow: "hidden",
      ...(first ? {} : { borderLeft: "1px solid rgba(255,255,255,0.12)", paddingLeft: "16px" }),
    },
  }, [
    h("div", {
      key: "l",
      style: { fontSize: "9.5px", fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: dim },
    }, label),
    h("div", { key: "v", style: { display: "flex", marginTop: "9px" } }, [value]),
    h("div", { key: "f", style: { display: "flex", marginTop: "auto", paddingTop: "10px" } }, [footer]),
  ]);
}

function insightMissing(text: string, dim: string): ReactNode {
  return h("div", { key: "none", style: { fontSize: "14px", color: dim } }, text);
}

function keySplitValue(insights: UserProfileInsights): ReactNode {
  if (insights.keySplit.length === 0) return h("div", { key: "v" });
  if (insights.keySplit.length === 1) {
    const only = insights.keySplit[0]!;
    return h("div", {
      key: "v",
      style: { fontSize: "26px", fontWeight: 900, lineHeight: 1, color: keyModeColor(only.keyCount) },
    }, `${only.keyCount}K only`);
  }
  const dominant = insights.keySplit.reduce((top, entry) => Math.max(top, entry.count), 0);
  /* Five or more entries need the same visual hierarchy in less horizontal
     space. Tightening only the secondary readings keeps the dominant mode as
     the headline while leaving every mode visible on one line. */
  const dense = insights.keySplit.length > 4;
  return h("div", {
    key: "v",
    style: { display: "flex", alignItems: "baseline", gap: dense ? "5px" : "9px" },
  }, insights.keySplit.map((entry) => {
    const color = keyModeColor(entry.keyCount);
    const lead = entry.count === dominant;
    return h("div", {
      key: String(entry.keyCount),
      style: { display: "flex", alignItems: "baseline" },
    }, [
      h("div", {
        key: "p",
        style: { fontSize: lead ? (dense ? "25px" : "26px") : (dense ? "16px" : "17px"), fontWeight: 900, lineHeight: 1, color },
      }, String(Math.round((entry.count / insights.sampleSize) * 100))),
      h("div", {
        key: "s",
        style: { fontSize: lead ? (dense ? "12px" : "13px") : (dense ? "10px" : "11px"), fontWeight: 900, lineHeight: 1, color },
      }, "%"),
      h("div", {
        key: "k",
        style: { marginLeft: "3px", fontSize: dense ? "10px" : "11px", fontWeight: 700, color },
      }, `${entry.keyCount}K`),
    ]);
  }));
}

/* Most profiles have at most four keymodes and keep the even four-column
   rhythm. Each additional mode buys the split enough room for one compact
   reading, taken evenly from the three values whose contents are much
   shorter. The cap protects those values if malformed chart data ever yields
   more modes than the ordinary 4K..10K range. */
export function insightCellWidths(totalWidth: number, keyModeCount: number): [number, number, number, number] {
  const evenWidth = Math.floor(totalWidth / 4);
  const maxKeyWidth = Math.floor(totalWidth * 0.45);
  const requestedExtra = Math.max(0, keyModeCount - 4) * 53;
  const keyWidth = evenWidth + Math.min(requestedExtra, Math.max(0, maxKeyWidth - evenWidth));
  const remaining = totalWidth - keyWidth;
  const secondaryWidth = Math.floor(remaining / 3);
  return [keyWidth, secondaryWidth, secondaryWidth, remaining - secondaryWidth * 2];
}

/* The four readings, at the widths they are actually drawn at. Fixed rather
   than flex:1 because the bars inside them need a pixel width - satori has no
   percentage sizing to fall back on. */
function insightCells(
  insights: UserProfileInsights,
  totalWidth: number,
  accent: string,
  dim: string,
): ReactNode[] {
  const [keyWidth, modWidth, bpmWidth, ppWidth] = insightCellWidths(totalWidth, insights.keySplit.length);
  const mod = insights.mostUsedMod;
  const modPct = mod && mod.total > 0 ? Math.round((mod.count / mod.total) * 100) : 0;

  return [
    insightCell(
      "keys",
      "Key split",
      dim,
      keySplitValue(insights),
      insights.keySplit.length > 1
        ? segmentedBar(keyWidth - 22, insights.keySplit.map((entry) => ({
          pct: (entry.count / insights.sampleSize) * 100,
          color: keyModeColor(entry.keyCount),
        })))
        : h("div", { key: "f" }),
      keyWidth,
      true,
    ),
    insightCell(
      "mod",
      "Most used mod",
      dim,
      mod
        ? h("div", { key: "v", style: { fontSize: "26px", fontWeight: 900, lineHeight: 1 } }, mod.label)
        : insightMissing("No mod preference", dim),
      mod
        ? h("div", { key: "f", style: { display: "flex", alignItems: "center", gap: "8px" } }, [
          bar(modWidth - 62, modPct, accent, 4),
          h("div", { key: "p", style: { fontSize: "10px", color: dim } }, `${modPct}%`),
        ])
        : h("div", { key: "f" }),
      modWidth,
      false,
    ),
    insightCell(
      "bpm",
      "Median BPM",
      dim,
      insights.medianBpm != null
        ? h("div", { key: "v", style: { display: "flex", alignItems: "baseline", gap: "5px" } }, [
          h("div", { key: "n", style: { fontSize: "26px", fontWeight: 900, lineHeight: 1 } }, String(Math.round(insights.medianBpm))),
          h("div", { key: "u", style: { fontSize: "11px", fontWeight: 700, color: dim } }, "BPM"),
        ])
        : insightMissing("-", dim),
      insights.bpmRange
        ? h("div", { key: "f", style: { fontSize: "11px", color: dim } },
          `${Math.round(insights.bpmRange.min)} to ${Math.round(insights.bpmRange.max)}`)
        : h("div", { key: "f" }),
      bpmWidth,
      false,
    ),
    insightCell(
      "pp",
      "PP range",
      dim,
      insights.ppRange
        ? h("div", { key: "v", style: { display: "flex", alignItems: "baseline", gap: "5px" } }, [
          h("div", { key: "t", style: { fontSize: "26px", fontWeight: 900, lineHeight: 1, color: accent } }, String(Math.round(insights.ppRange.top))),
          h("div", { key: "s", style: { fontSize: "11px", color: dim } }, "to"),
          h("div", { key: "b", style: { fontSize: "26px", fontWeight: 900, lineHeight: 1 } }, String(Math.round(insights.ppRange.bottom))),
        ])
        : insightMissing("-", dim),
      insights.ppRange
        ? h("div", { key: "f", style: { fontSize: "11px", color: dim } },
          `${nf(insights.ppRange.top - insights.ppRange.bottom)}pp spread`)
        : h("div", { key: "f" }),
      ppWidth,
      false,
    ),
  ];
}

interface RenderModBadge {
  acronym: string;
  color: string;
  shape: string | null;
  glyph: string | null;
}

const recoloredModAssetCache = new Map<string, Promise<string | null>>();

/* Browser badges tint two white SVG masks with CSS. Satori does not reliably
   implement masks, so the dynamic render fetches those same assets once and
   puts the colour into the SVG itself. Keeping them as two image layers also
   preserves the site's exact shield and glyph instead of drawing a second
   approximation for signatures. */
async function recoloredModAsset(request: Request, path: string, color: string): Promise<string | null> {
  const url = new URL(path, getAssetOrigin(request)).toString();
  const key = `${url}|${color}`;
  const cached = recoloredModAssetCache.get(key);
  if (cached) return cached;

  const promise = (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const svg = (await response.text())
        .replaceAll('fill="white"', `fill="${color}"`)
        .replaceAll('stroke="white"', `stroke="${color}"`);
      return svgDataUrl(svg);
    } catch {
      return null;
    }
  })();
  recoloredModAssetCache.set(key, promise);
  promise.then((value) => {
    if (value == null) recoloredModAssetCache.delete(key);
  });
  return promise;
}

function modGlyphColor(color: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return "#17121a";
  const value = parseInt(match[1]!, 16);
  const channel = (shift: number) => Math.round(((value >> shift) & 255) * 0.12).toString(16).padStart(2, "0");
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

async function loadRenderModBadges(request: Request, mods: string[]): Promise<RenderModBadge[]> {
  return Promise.all(mods.map(async (raw) => {
    const acronym = raw.toUpperCase();
    const color = MOD_BADGE_TYPE_COLORS[acronym] ?? "#ff6666";
    const file = MOD_BADGE_FILE_NAMES[acronym];
    const [shape, glyph] = await Promise.all([
      recoloredModAsset(request, "/images/badges/mods/mod-icon.svg", color),
      file
        ? recoloredModAsset(request, `/images/badges/mods/mod-${file}.svg`, modGlyphColor(color))
        : Promise.resolve(null),
    ]);
    return { acronym, color, shape, glyph };
  }));
}

function renderModBadge(badge: RenderModBadge, index: number): ReactNode {
  // The browser badge is 36x24 with a 100:70 mask centred inside it. This is
  // its 0.7x profile-card size, including the small transparent side gutters.
  const width = 25.2;
  const height = 16.8;
  const artWidth = 24;
  const artLeft = (width - artWidth) / 2;
  return h("div", {
    key: `${badge.acronym}-${index}`,
    style: {
      display: "flex", alignItems: "center", justifyContent: "center", position: "relative",
      width: `${width}px`, height: `${height}px`, flexShrink: 0,
      background: badge.shape ? "transparent" : badge.color,
      borderRadius: badge.shape ? "0" : "6px",
    },
  }, [
    badge.shape
      ? h("img", {
        key: "shape", src: badge.shape, width: artWidth, height,
        style: { position: "absolute", top: "0", left: `${artLeft}px`, width: `${artWidth}px`, height: `${height}px` },
      })
      : h("div", { key: "shape" }),
    badge.glyph
      ? h("img", {
        key: "glyph", src: badge.glyph, width: artWidth, height,
        style: { position: "absolute", top: "0", left: `${artLeft}px`, width: `${artWidth}px`, height: `${height}px` },
      })
      : h("div", {
        key: "glyph",
        style: { position: "relative", fontSize: "8px", lineHeight: 1, fontWeight: 900, color: modGlyphColor(badge.color) },
      }, badge.acronym),
  ]);
}

/* The star pill the site draws everywhere a map is named, in satori's terms:
   osu-web's difficulty colour behind the number, with the expert-plus yellow
   text above 6.5* where dark text stops reading. The glyph is a data-url svg
   because satori has no currentColor to tint an icon with.

   Sized to the title it sits beside rather than to the small print under it -
   a pill set at badge size next to 16px type reads as a footnote, and the star
   rating is the second thing anyone looks at on a top play. */
function starPill(stars: number, fontSize: number): ReactNode {
  const text = stars >= 6.5 ? "#ffd966" : "#171a1c";
  const glyph = Math.round(fontSize * 0.95);
  return h("div", {
    key: "stars",
    style: {
      display: "flex", alignItems: "center", gap: "4px", flexShrink: 0,
      padding: `${Math.round(fontSize * 0.3)}px ${Math.round(fontSize * 0.65)}px`,
      borderRadius: "999px",
      background: starRatingColor(stars),
      color: text, fontSize: `${fontSize}px`, fontWeight: 700, lineHeight: 1,
    },
  }, [
    h("img", {
      key: "glyph",
      src: svgDataUrl(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${glyph}" height="${glyph}" viewBox="0 0 24 24">`
        + `<path fill="${text}" d="M12 1.7l3.1 6.9 7.2.8-5.4 5 1.5 7.2L12 17.9l-6.4 3.7 1.5-7.2-5.4-5 7.2-.8L12 1.7z"/>`
        + `</svg>`,
      ),
      width: glyph,
      height: glyph,
      style: { width: `${glyph}px`, height: `${glyph}px` },
    }),
    h("div", { key: "n" }, stars.toFixed(2)),
  ]);
}

/* The newest top play, on its own beatmap cover - which is how the profile
   page draws this card, and without it the row is just four lines of text
   where the page has a picture.
 *
 * Dated absolutely rather than as "1d ago": a render is stored under a version
 * derived from the player's data, so nothing re-draws it while only the clock
 * moves, and a relative date baked into the object would sit on a profile
 * saying "1d ago" for a month. */
function topPlayCard(
  snapshot: InsightScoreSnapshot,
  cover: string | null,
  accent: string,
  dim: string,
  width: number,
  height: number,
  /* The OWNER's zone, from their row. Not the viewer's: this image is stored
     once per version and handed to every stranger who loads the osu! profile
     it hangs on, so there is no viewer to be local to. Null falls back to UTC,
     which is what every render printed before the column existed - and which
     dated an evening play in the Americas to the next morning. */
  timeZone: string | null,
  modBadges: RenderModBadge[],
  compact = false,
): ReactNode {
  const date = snapshot.date ? formatDate(snapshot.date, timeZone ?? "UTC") : null;
  /* Clamped to the layout, and nowrap besides. A map title is arbitrary
     length: on the card width it would otherwise wrap onto a second line and
     push the artist and the date off the bottom edge, which is a layout that
     silently loses information rather than one that truncates. */
  const line = { whiteSpace: "nowrap" as const, overflow: "hidden" as const };
  /* The cover is dimmed on the way in, so text on it is legible everywhere.
     This is the page's own left-to-right wash on top of that, which is what
     keeps the words end of the card darker than the artwork end. */
  const onCover = cover != null;
  const label = onCover ? "rgba(255,255,255,0.55)" : dim;
  const secondary = onCover ? TEXT_DIM_ON_ART : dim;

  return h("div", {
    key: "play",
    style: {
      display: "flex", position: "relative", overflow: "hidden",
      width: `${width}px`, height: `${height}px`, borderRadius: "12px",
    },
  }, [
    onCover
      ? h("img", {
        key: "cover",
        src: cover,
        width,
        height,
        style: { position: "absolute", top: "0", left: "0", width: `${width}px`, height: `${height}px` },
      })
      : h("div", { key: "cover" }),
    onCover
      ? h("div", {
        key: "scrim",
        style: {
          position: "absolute", ...FILL,
          background: "linear-gradient(90deg, rgba(0,0,0,0.60) 0%, rgba(0,0,0,0.24) 55%, rgba(0,0,0,0.46) 100%)",
        },
      })
      : h("div", { key: "scrim" }),
    h("div", {
      key: "row",
      style: {
        display: "flex", alignItems: "center", gap: "16px",
        width: "100%", height: "100%", padding: onCover ? "0 16px" : "0",
      },
    }, [
      h("div", { key: "text", style: { display: "flex", flexDirection: "column", gap: "3px", flex: 1, minWidth: "0" } }, [
        h("div", {
          key: "l",
          style: { fontSize: "9.5px", fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: label },
        }, "Newest top play"),
        /* Title and star pill on one line: the pill is what a reader wants
           beside the map's name, and it is the one number this card carried
           nowhere else. The title clamps shorter than it used to, by roughly
           the pill's own width, so the pair still fits the card. */
        h("div", { key: "t", style: { display: "flex", alignItems: "center", gap: "6px", minWidth: "0" } }, [
          h("div", {
            key: "n",
            style: { ...line, fontSize: "16px", fontWeight: 900, lineHeight: 1.15 },
          }, clamp(snapshot.title, compact ? 21 : 38)),
          snapshot.stars != null ? starPill(snapshot.stars, 11) : h("div", { key: "stars" }),
        ]),
        h("div", { key: "a", style: { ...line, fontSize: "11px", color: secondary } },
          clamp(`${snapshot.artist} [${snapshot.version}]`, compact ? 40 : 56)),
        modBadges.length > 0 || date
          ? h("div", { key: "m", style: { display: "flex", alignItems: "center", gap: "4px", height: "18px", color: secondary } }, [
            ...modBadges.map(renderModBadge),
            date ? h("div", {
              key: "date",
              style: { marginLeft: modBadges.length > 0 ? "3px" : "0", fontSize: "10.5px", whiteSpace: "nowrap" },
            }, date) : h("div", { key: "date" }),
          ])
          : h("div", { key: "m" }),
      ]),
      snapshot.pp != null
        ? h("div", { key: "pp", style: { display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0 } }, [
          h("div", { key: "v", style: { fontSize: "30px", fontWeight: 900, lineHeight: 1, color: accent } }, String(Math.round(snapshot.pp))),
          h("div", {
            key: "l",
            style: { marginTop: "3px", fontSize: "10px", fontWeight: 700, letterSpacing: "0.10em", textTransform: "uppercase", color: secondary },
          }, "pp"),
        ])
        : h("div", { key: "pp" }),
    ]),
  ]);
}

/** Label / value line, for the tall layout where four cells in a row would be
    22px wide each. */
function insightLine(key: string, label: string, value: ReactNode, dim: string): ReactNode {
  return h("div", {
    key,
    style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px" },
  }, [
    h("div", {
      key: "l",
      style: { fontSize: "9.5px", fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: dim },
    }, label),
    value,
  ]);
}

/* The profile's cumulative pp colours, as hex. The page names them through CSS
   custom properties, which satori cannot resolve, and osu-pink-light is
   theme-derived anyway - a render has no theme to read. */
const PP_LADDER_COLORS = ["#aa88ff", "#ff99cc", "#ff8e5d", "#ffcc22", "#66ccff", "#b3d944"];

/* The player's portrait beside their name. A rounded square rather than a
   circle: these renders get pasted into an osu! profile, which already draws
   the circular avatar at the top of the page, and a second circle a few
   hundred pixels under it reads as the same element twice. */
function avatarBox(src: string, size: number): ReactNode {
  return h("img", {
    key: "pfp",
    src,
    width: size,
    height: size,
    style: {
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: `${Math.round(size / 3.5)}px`,
      objectFit: "cover",
    },
  });
}

/* Every insights header lays out the same way whether or not the portrait
   loaded, so the name block is its own row and the avatar is prepended when
   there is one. */
function insightsHeader(avatar: ReactNode | null, name: ReactNode[], gap: string): ReactNode {
  return h("div", {
    key: "head",
    style: { display: "flex", alignItems: "center", gap },
  }, [
    ...(avatar ? [avatar] : []),
    h("div", { key: "who", style: { display: "flex", alignItems: "baseline", gap: "10px" } }, name),
  ]);
}

/* A fixed-size image cannot scroll, and the ladder is as long as the player's
   own pp spread - 12 rungs for someone whose top play is a thousand pp above
   their worst. Thinning takes every other rung rather than cutting the bottom
   off, so the ladder still spans the whole range and only its resolution
   drops. Halving the rungs is exactly what doubling the step would do. */
function fitPpLadder<T>(rows: T[], max: number): T[] {
  let fitted = rows;
  while (fitted.length > max) fitted = fitted.filter((_, index) => index % 2 === 0);
  return fitted;
}

async function renderInsightsPpLadder(
  ctx: SignatureRenderContext,
  scores: OsuScore[],
  insights: UserProfileInsights,
  background: Awaited<ReturnType<typeof styleLayers>>,
  accent: string,
  dim: string,
  avatar: ReactNode | null,
): Promise<Buffer> {
  const spec = signatureDesign(ctx.type, ctx.design)!;
  const ladder = fitPpLadder(buildPpCumulativeDistribution(scores), 9);
  if (ladder.length === 0) return renderPlate(ctx, "No ranked mania plays tracked yet.");

  const inner = spec.width - 48;
  const labelWidth = 46;
  const countWidth = 62;
  const barWidth = inner - labelWidth - countWidth - 20;
  const total = ladder[0]!.total;
  /* Scaled against the largest rung rather than against the total. The bottom
     rung is every play by definition, so a bar drawn as a share of the total
     would leave the top of the ladder as a row of slivers. */
  const widest = ladder.reduce((max, row) => Math.max(max, row.count), 1);

  return renderPng(ctx, frame(spec.width, spec.height, [
    ...background.layers,
    h("div", {
      key: "body",
      style: { display: "flex", flexDirection: "column", gap: "10px", padding: "18px 24px 14px", width: "100%" },
    }, [
      insightsHeader(avatar, [
        h("div", { key: "n", style: { fontSize: "17px", fontWeight: 900 } }, clamp(ctx.resolved.username, 20)),
        h("div", {
          key: "l",
          style: { fontSize: "10px", fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: dim },
        }, "PP distribution"),
      ], "9px"),
      insights.ppRange
        ? h("div", { key: "range", style: { display: "flex", alignItems: "baseline", gap: "6px" } }, [
          h("div", { key: "t", style: { fontSize: "22px", fontWeight: 900, lineHeight: 1, color: accent } }, String(Math.round(insights.ppRange.top))),
          h("div", { key: "s", style: { fontSize: "11px", color: dim } }, "to"),
          h("div", { key: "b", style: { fontSize: "22px", fontWeight: 900, lineHeight: 1 } }, String(Math.round(insights.ppRange.bottom))),
          h("div", { key: "u", style: { fontSize: "11px", color: dim } }, "pp"),
        ])
        : h("div", { key: "range" }),
      h("div", {
        key: "rows",
        style: { display: "flex", flexDirection: "column", gap: "7px", flex: 1, justifyContent: "center" },
      }, ladder.map((row, index) => h("div", {
        key: String(row.threshold),
        style: { display: "flex", alignItems: "center", gap: "10px" },
      }, [
        h("div", {
          key: "l",
          style: { width: `${labelWidth}px`, fontSize: "12px", fontWeight: 700, color: "rgba(255,255,255,0.82)", flexShrink: 0 },
        }, `${row.threshold}+`),
        /* Auto keeps the profile's own ladder of colours, which is what makes
           the chart read as a gradient down the range rather than as one
           block. A chosen accent paints every rung, because a player who
           picked a colour picked it for the whole picture. */
        bar(barWidth, (row.count / widest) * 100, accentHex(ctx.style, PP_LADDER_COLORS[index % PP_LADDER_COLORS.length]!), 7),
        h("div", {
          key: "c",
          style: { display: "flex", alignItems: "baseline", justifyContent: "flex-end", gap: "5px", width: `${countWidth}px`, flexShrink: 0 },
        }, [
          h("div", { key: "n", style: { fontSize: "13px", fontWeight: 900 } }, String(row.count)),
          h("div", { key: "p", style: { fontSize: "10px", color: dim } },
            `${Math.round((row.count / total) * 100)}%`),
        ]),
      ]))),
    ]),
    wordmark(ctx.style),
  ]));
}

async function renderInsights(ctx: SignatureRenderContext): Promise<Buffer> {
  const spec = signatureDesign(ctx.type, ctx.design)!;
  const snapshot = await fetchProfileSnapshot(ctx.resolved.userId);
  const insights = calculateUserProfileInsights(snapshot?.bestScores ?? []);
  if (insights.sampleSize === 0) return renderPlate(ctx, "No ranked mania plays tracked yet.");

  /* Sized per layout because there is no scaling here: the portrait is drawn
     at the pixels it is fetched at, and each of these headers has a different
     amount of height to give it. The strip carries no name, so it fetches
     nothing. */
  const avatarSize = ctx.design === 1 ? 28 : ctx.design === 3 ? 26 : ctx.design === 4 ? 24 : 0;
  const [background, avatarSrc] = await Promise.all([
    styleLayers(ctx, spec, backgroundSourcesFrom(snapshot)),
    avatarSize
      ? avatarSquareDataUrl(snapshot?.user?.avatar_url ?? `https://a.ppy.sh/${ctx.resolved.userId}`, avatarSize)
      : null,
  ]);
  const avatar = avatarSrc ? avatarBox(avatarSrc, avatarSize) : null;
  const accent = accentHex(ctx.style, ACCENT);
  const dim = background.custom ? TEXT_DIM_ON_ART : TEXT_DIM;
  if (ctx.design === 4) {
    // Mania only, the same filter calculateUserProfileInsights opens with - a
    // stored top-play window can carry other rulesets, and a std play in the
    // ladder would put a rung under plays this render never counted.
    const mania = (snapshot?.bestScores ?? []).filter((score) => score.beatmap?.mode === "mania");
    return renderInsightsPpLadder(ctx, mania, insights, background, accent, dim, avatar);
  }

  const play = insights.newestTopPlay;
  const inner = spec.width - (ctx.design === 3 ? 48 : 56);
  /* Design 2 carries no top play, so it pays for no cover: this is a fetch and
     a sharp pass, cheap once per version and pointless every time. */
  const [cover, modBadges] = await Promise.all([
    play && ctx.design !== 2
      ? beatmapCoverBandDataUrl(play.coverUrl, inner, TOP_PLAY_CARD_HEIGHT)
      : Promise.resolve(null),
    play && ctx.design !== 2 ? loadRenderModBadges(ctx.request, play.mods) : Promise.resolve([]),
  ]);

  if (ctx.design === 2) {
    // Stats only, at a strip height. No name on this one: it is the layout for
    // a player who wants the readings and nothing else, and it is going on the
    // profile that already says whose it is.
    return renderPng(ctx, frame(spec.width, spec.height, [
      ...background.layers,
      h("div", {
        key: "body",
        style: { display: "flex", alignItems: "stretch", padding: "18px 28px", width: "100%" },
      }, insightCells(insights, inner, accent, dim)),
      wordmark(ctx.style, 12, 8),
    ]));
  }

  if (ctx.design === 3) {
    const modPct = insights.mostUsedMod && insights.mostUsedMod.total > 0
      ? Math.round((insights.mostUsedMod.count / insights.mostUsedMod.total) * 100)
      : 0;
    return renderPng(ctx, frame(spec.width, spec.height, [
      ...background.layers,
      h("div", {
        key: "body",
        style: { display: "flex", flexDirection: "column", gap: "12px", padding: "20px 24px 16px", width: "100%" },
      }, [
        insightsHeader(avatar, [
          h("div", { key: "n", style: { fontSize: "17px", fontWeight: 900 } }, clamp(ctx.resolved.username, 18)),
          h("div", {
            key: "l",
            style: { fontSize: "10px", fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: dim },
          }, "Profile stats"),
        ], "9px"),
        h("div", { key: "keys", style: { display: "flex", flexDirection: "column", gap: "9px" } }, [
          keySplitValue(insights),
          insights.keySplit.length > 1
            ? segmentedBar(inner, insights.keySplit.map((entry) => ({
              pct: (entry.count / insights.sampleSize) * 100,
              color: keyModeColor(entry.keyCount),
            })))
            : h("div", { key: "bar" }),
        ]),
        h("div", { key: "lines", style: { display: "flex", flexDirection: "column", gap: "8px" } }, [
          insightLine("mod", "Most used mod", h("div", {
            key: "v",
            style: { display: "flex", alignItems: "baseline", gap: "6px" },
          }, [
            h("div", { key: "n", style: { fontSize: "17px", fontWeight: 900 } }, insights.mostUsedMod?.label ?? "-"),
            insights.mostUsedMod
              ? h("div", { key: "p", style: { fontSize: "11px", color: dim } }, `${modPct}%`)
              : h("div", { key: "p" }),
          ]), dim),
          insightLine("bpm", "Median BPM", h("div", {
            key: "v",
            style: { fontSize: "17px", fontWeight: 900 },
          }, insights.medianBpm != null ? String(Math.round(insights.medianBpm)) : "-"), dim),
          insightLine("pp", "PP range", h("div", {
            key: "v",
            style: { display: "flex", alignItems: "baseline", gap: "5px" },
          }, insights.ppRange ? [
            h("div", { key: "t", style: { fontSize: "17px", fontWeight: 900, color: accent } }, String(Math.round(insights.ppRange.top))),
            h("div", { key: "s", style: { fontSize: "11px", color: dim } }, "to"),
            h("div", { key: "b", style: { fontSize: "17px", fontWeight: 900 } }, String(Math.round(insights.ppRange.bottom))),
          ] : [h("div", { key: "t", style: { fontSize: "17px", fontWeight: 900 } }, "-")]), dim),
        ]),
        play
          ? h("div", { key: "playwrap", style: { display: "flex", marginTop: "auto" } }, [
            topPlayCard(play, cover, accent, dim, inner, TOP_PLAY_CARD_HEIGHT, ctx.resolved.timeZone, modBadges, true),
          ])
          : h("div", { key: "playwrap" }),
      ]),
      headerWordmark(ctx.style),
    ]));
  }

  // Design 1: the four readings over the newest top play, which is the profile
  // panel's own arrangement minus the row this render leaves out.
  return renderPng(ctx, frame(spec.width, spec.height, [
    ...background.layers,
    h("div", {
      key: "body",
      style: { display: "flex", flexDirection: "column", gap: "14px", padding: "16px 28px 14px", width: "100%" },
    }, [
      insightsHeader(avatar, [
        h("div", { key: "n", style: { fontSize: "17px", fontWeight: 900 } }, clamp(ctx.resolved.username, 24)),
        h("div", {
          key: "l",
          style: { fontSize: "10px", fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: dim },
        }, "Profile stats"),
      ], "10px"),
      h("div", { key: "cells", style: { display: "flex", alignItems: "stretch", height: "62px" } },
        insightCells(insights, inner, accent, dim)),
      play
        ? h("div", { key: "playwrap", style: { display: "flex", marginTop: "auto" } }, [
          topPlayCard(play, cover, accent, dim, inner, TOP_PLAY_CARD_HEIGHT, ctx.resolved.timeZone, modBadges),
        ])
        : h("div", { key: "playwrap" }),
    ]),
    headerWordmark(ctx.style),
  ]));
}

// --- dispatch ----------------------------------------------------------

export async function renderSignature(ctx: SignatureRenderContext): Promise<Buffer> {
  switch (ctx.type) {
    case "maniacard": return renderManiacard(ctx);
    case "goals": return renderGoals(ctx);
    case "skills": return renderSkills(ctx);
    case "dan": return renderDan(ctx);
    case "insights": return renderInsights(ctx);
  }
}

/* A last-resort image for a render that FAILED (backend down mid-render, a
   satori throw). Deliberately tiny and text-free, and the route must never
   store it or give it an ETag: under a stable URL a stuck error image is a
   broken profile for as long as it is cached. */
export function placeholderPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
}
