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
import { computeManiaSkills, getManiaCardTier, MANIA_TIER_STYLES } from "../../../lib/maniacard";
import type { ManiaSkills } from "../../../lib/maniacard";
import { describeGoal, nf, trimZeros } from "../../../lib/goal-format";
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
import { backgroundImageDataUrl, type SignatureBackgroundSources } from "./-backgrounds";
import { cosmicStarsDataUrl, signatureArtLayers, tierFlecksDataUrl } from "./-art";
import { getCosmicTierPalette } from "../../../lib/maniacard-cosmic";
import type { ResolvedSignature } from "../../../lib/signature-resolve";
import type { OsuScore } from "../../../lib/types";

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
        background: background ?? SURFACE,
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
   loudest. */
function wordmark(right = 16, bottom = 12, onBright = false): ReactNode {
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
    wordmark(),
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

interface ManiacardSnapshot {
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
function backgroundSourcesFrom(snapshot: ManiacardSnapshot | null): SignatureBackgroundSources {
  const covers = snapshot?.bestScores?.[0]?.beatmapset?.covers;
  return {
    coverUrl: snapshot?.user?.cover_url ?? null,
    mapUrl: covers?.["cover@2x"] ?? covers?.cover ?? null,
  };
}

/* Only the maniacard layouts read the profile for their own content. The other
   three fetch it solely to resolve a background, so this stays behind the
   check - a signature styled "None" costs no extra call. It is one indexed
   read on the backend, and it happens once per version like everything else on
   this path. */
async function fetchBackgroundSources(ctx: SignatureRenderContext): Promise<SignatureBackgroundSources> {
  // A custom url needs no profile read at all - the address is already in the
  // style.
  if (!styleNeedsProfileImage(ctx.style)) return {};
  return backgroundSourcesFrom(await fetchManiacard(ctx.resolved.userId).catch(() => null));
}

/* cached-snapshot, not /snapshot: /snapshot queues a background osu! refresh,
   and an anonymous image fetch from a stranger's browser must not drive osu!
   API spend. It also keeps the pixels consistent with the version they are
   keyed under. */
async function fetchManiacard(userId: number): Promise<ManiacardSnapshot | null> {
  const base = getServerLiveBackendUrl();
  if (!base) return null;
  const response = await fetch(`${base}/api/profiles/${userId}/cached-snapshot`);
  if (!response.ok) return null;
  return (await response.json()) as ManiacardSnapshot;
}

async function renderManiacard(ctx: SignatureRenderContext): Promise<Buffer> {
  const spec = signatureDesign(ctx.type, ctx.design)!;
  const snapshot = await fetchManiacard(ctx.resolved.userId);
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
  const style = MANIA_TIER_STYLES[tier];
  const background = await styleLayers(ctx, spec, backgroundSourcesFrom(snapshot));
  const tierBacked = !background.custom && styleUsesTier(ctx.style);
  const statColor = accentHex(ctx.style, "rgba(255,255,255,0.88)");
  // The muted violet only works on the flat surface. On a tier front it is a
  // grey smear over gold, same as it would be over a photograph.
  const dim = background.custom || tierBacked ? TEXT_DIM_ON_ART : TEXT_DIM;
  const username = clamp(user.username || ctx.resolved.username, 20);
  const avatarUrl = ogAvatarUrl(ctx.request, user.avatar_url, user.id);
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
      wordmark(12, 8, tierBacked),
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
    wordmark(16, 12, tierBacked),
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
      return `${trimZeros(nf(current))} / ${trimZeros(nf(target))}`;
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

function goalRow(goal: UserGoal, width: number, accent: string, dim: string, compact = false): ReactNode {
  const pct = goal.progress?.pct ?? 0;
  const value = goalReadout(goal);
  return h("div", {
    key: goal.id,
    style: { display: "flex", flexDirection: "column", gap: compact ? "4px" : "6px", width: `${width}px` },
  }, [
    h("div", { key: "top", style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "12px" } }, [
      h("div", {
        key: "l",
        // flexShrink on the label, not the value: a long map name should be
        // the thing that gives way, never the number the image exists for.
        style: { fontSize: compact ? "13px" : "15px", fontWeight: 700, color: "#ffffff", overflow: "hidden", flexShrink: 1, minWidth: "0" },
      }, clamp(describeGoal(goal), compact ? 46 : 54)),
      h("div", {
        key: "v",
        style: { fontSize: compact ? "12px" : "13px", color: dim, whiteSpace: "nowrap", flexShrink: 0 },
      }, value),
    ]),
    bar(width, pct, accent, compact ? 6 : 8),
  ]);
}

async function renderGoals(ctx: SignatureRenderContext): Promise<Buffer> {
  const spec = signatureDesign(ctx.type, ctx.design)!;
  const goals = await fetchGoals(ctx.resolved.userId);
  if (goals == null) return renderPlate(ctx, "Goals are unavailable right now.");
  const open = goals
    .filter((goal) => goal.status === "open")
    .sort((a, b) => (b.progress?.pct ?? 0) - (a.progress?.pct ?? 0));
  const completed = goals.filter((goal) => goal.status === "completed").length;

  if (open.length === 0) {
    return renderPlate(ctx, completed > 0 ? `No open goals. ${completed} completed.` : "No open goals.");
  }

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
    const goal = open[0]!;
    const pct = goal.progress?.pct ?? 0;
    return renderPng(ctx, frame(spec.width, spec.height, [
      ...background.layers,
      h("div", {
        key: "body",
        style: { display: "flex", flexDirection: "column", justifyContent: "center", gap: "12px", padding: "0 26px", width: "100%" },
      }, [
        h("div", { key: "top", style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } }, [
          h("div", { key: "l", style: { fontSize: "16px", fontWeight: 700, overflow: "hidden" } }, clamp(describeGoal(goal), 40)),
          h("div", { key: "p", style: { fontSize: "24px", fontWeight: 900, color: accent } }, `${Math.round(pct)}%`),
        ]),
        bar(spec.width - 52, pct, accent, 10),
        goal.progress?.detail
          ? h("div", { key: "d", style: { fontSize: "12px", color: dim } }, clamp(goal.progress.detail, 60))
          : h("div", { key: "d" }),
      ]),
      wordmark(12, 8),
    ]));
  }

  const limit = ctx.design === 3 ? 5 : 3;
  const shown = open.slice(0, limit);
  const rest = open.length - shown.length;
  const rowWidth = spec.width - 56;

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
        style: { display: "flex", flexDirection: "column", gap: "12px", flex: 1, justifyContent: "center" },
      }, shown.map((goal) => goalRow(goal, rowWidth, accent, dim, ctx.design === 3))),
      h("div", {
        key: "foot",
        style: { display: "flex", gap: "14px", fontSize: "11px", color: dim },
      }, [
        rest > 0 ? h("span", { key: "more" }, `+${rest} more`) : h("span", { key: "more" }),
        completed > 0 ? h("span", { key: "done" }, `${completed} completed`) : h("span", { key: "done" }),
      ]),
    ]),
    wordmark(),
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
      wordmark(12, 8),
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
    wordmark(),
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
    { id: "rc", label: "Rice", side: riceMode?.dan?.rc, keyCount: riceMode?.keyCount },
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
      h("div", { key: "c", style: { fontSize: "11px", color: dim } }, `${entry.side.clears} clears`),
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
    wordmark(),
  ]));
}

// --- dispatch ----------------------------------------------------------

export async function renderSignature(ctx: SignatureRenderContext): Promise<Buffer> {
  switch (ctx.type) {
    case "maniacard": return renderManiacard(ctx);
    case "goals": return renderGoals(ctx);
    case "skills": return renderSkills(ctx);
    case "dan": return renderDan(ctx);
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
