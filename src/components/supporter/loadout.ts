import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

import { SUPPORTER_AVATAR_FRAMES, type SupporterAvatarFrameId } from "../../lib/supporter-avatar-frames";
import type { SupporterLook } from "../../lib/supporter-card-looks";
import { DEFAULT_SUPPORTER_FOIL, SUPPORTER_FOILS, type SupporterFoilId } from "../../lib/supporter-foils";
import { SUPPORTER_NAME_FONTS, type SupporterNameFontId } from "../../lib/supporter-name-fonts";
import { SUPPORTER_NAME_STYLES, type SupporterNameStyleId } from "../../lib/supporter-name-styles";
import { SUPPORTER_PROFILE_THEMES, type ProfileThemeOptions, type SupporterProfileThemeId } from "../../lib/supporter-profile-themes";
import { SUPPORTER_BINDERS, SUPPORTER_BLADES, SUPPORTER_CARD_SLEEVES, SUPPORTER_WRAPPERS, type SupporterPackStyle } from "../../lib/supporter-pack-style";

/* The /supporter loadout: everything a supporter wears as ten slots, what
   each slot can hold, and how the page reads, swaps and rolls one slot of a
   loadout. Card art and card foil are two slots over one stored look. */

export interface Loadout {
  theme: SupporterProfileThemeId | null;
  /** The theme's own switches (the Note highway's real charts). */
  themeOptions: ProfileThemeOptions;
  frame: SupporterAvatarFrameId | null;
  nameStyle: SupporterNameStyleId | null;
  nameFont: SupporterNameFontId | null;
  /** The outline round the name, six hex digits; null for none. Not a slot: a switch under the name styles. */
  nameOutline: string | null;
  look: SupporterLook;
  /** Packs cosmetics: card case, binder, pack wrapper and opening blade. */
  pack: SupporterPackStyle;
}

export type SlotId = "theme" | "frame" | "nameStyle" | "nameFont" | "motif" | "foil" | "sleeve" | "binder" | "wrapper" | "blade";

export const SLOT_IDS: readonly SlotId[] = ["theme", "frame", "nameStyle", "nameFont", "foil", "motif", "sleeve", "binder", "wrapper", "blade"];

/* The slots that dress the viewer's packs, drawn as their own group. */
export const PACK_SLOT_IDS: readonly SlotId[] = ["sleeve", "binder", "wrapper", "blade"];

/* What the supporter page's sidebar opens: a loadout slot, or one of the
   page's other sections. Kept in the URL (?s=), so each can be linked to. */
export type SupporterSection = SlotId | "companion" | "stats" | "you" | "perks";

export const PROFILE_SECTIONS: readonly SupporterSection[] = ["theme", "frame", "nameStyle", "nameFont", "companion", "stats"];
export const PACK_SECTIONS: readonly SupporterSection[] = ["foil", "motif", "sleeve", "binder", "wrapper", "blade"];
const SECTION_IDS: readonly SupporterSection[] = [...PROFILE_SECTIONS, ...PACK_SECTIONS, "you", "perks"];

export function isSupporterSection(value: unknown): value is SupporterSection {
  return typeof value === "string" && (SECTION_IDS as readonly string[]).includes(value);
}

export function isSlotSection(section: SupporterSection): section is SlotId {
  return (SLOT_IDS as readonly string[]).includes(section);
}

export const SECTION_LABELS: Record<Exclude<SupporterSection, SlotId>, MessageDescriptor> = {
  companion: msg`Stand`,
  stats: msg`Profile stats`,
  you: msg`Rank and gifts`,
  perks: msg`What supporting gets you`,
};

export const SLOT_LABELS: Record<SlotId, MessageDescriptor> = {
  theme: msg`Profile theme`,
  frame: msg`Avatar frame`,
  nameStyle: msg`Name style`,
  nameFont: msg`Font`,
  motif: msg`Card art`,
  foil: msg`Card foil`,
  sleeve: msg`Card sleeve`,
  binder: msg`Binder`,
  wrapper: msg`Pack wrapper`,
  blade: msg`Pack opening`,
};

export type SlotValue = string | null;

export const DEFAULT_LOOK: SupporterLook = { motif: "none", foil: DEFAULT_SUPPORTER_FOIL };

export function slotValue(loadout: Loadout, slot: SlotId): SlotValue {
  if (slot === "motif") return loadout.look.motif === "none" ? null : loadout.look.motif;
  if (slot === "foil") return loadout.look.foil === "none" ? null : loadout.look.foil;
  if (slot === "sleeve" || slot === "binder" || slot === "wrapper" || slot === "blade") return loadout.pack[slot];
  return loadout[slot];
}

/* `custom` is the viewer's own image, for when "custom" is put in the art slot. */
export function withSlot(loadout: Loadout, slot: SlotId, value: SlotValue, custom?: { url: string; scale: number; opacity: number } | null): Loadout {
  if (slot === "motif") {
    if (value === "custom") return custom ? { ...loadout, look: { motif: "custom", foil: loadout.look.foil, ...custom } } : loadout;
    return { ...loadout, look: { motif: "none", foil: loadout.look.foil } };
  }
  if (slot === "foil") return { ...loadout, look: { ...loadout.look, foil: value === null ? "none" : value as SupporterFoilId } };
  if (slot === "sleeve" || slot === "binder" || slot === "wrapper" || slot === "blade") return { ...loadout, pack: { ...loadout.pack, [slot]: value } as SupporterPackStyle };
  if (slot === "theme" && value !== loadout.theme) {
    // dim and blur are set for one theme's picture, so another starts clear
    const { dim: _dim, blur: _blur, ...rest } = loadout.themeOptions;
    return { ...loadout, theme: value, themeOptions: rest } as Loadout;
  }
  return { ...loadout, [slot]: value } as Loadout;
}

/* What a roll can land on per slot. A roll always lands on something, so no
   "none", and never on the viewer's own image; card art, which is only that
   image now, is left out of rolls. */
const ROLL_POOLS: Record<SlotId, readonly SlotValue[]> = {
  theme: SUPPORTER_PROFILE_THEMES,
  frame: SUPPORTER_AVATAR_FRAMES,
  nameStyle: SUPPORTER_NAME_STYLES,
  nameFont: SUPPORTER_NAME_FONTS,
  motif: [],
  foil: SUPPORTER_FOILS,
  sleeve: SUPPORTER_CARD_SLEEVES,
  binder: SUPPORTER_BINDERS,
  wrapper: SUPPORTER_WRAPPERS,
  blade: SUPPORTER_BLADES,
};

/* Whether a roll spins the slot at all. */
export function isRolledSlot(slot: SlotId): boolean {
  return ROLL_POOLS[slot].length > 0;
}

export function randomSlotValue(slot: SlotId, not?: SlotValue): SlotValue {
  const pool = ROLL_POOLS[slot].filter((value) => value !== not);
  return pool[Math.floor(Math.random() * pool.length)];
}

/* How many different looks the loadout can put together: every slot's
   choices multiplied (an empty slot counts as one, and the Note highway with
   its real charts or its own notes switched on counts as three more themes), leaving out the viewer's
   own uploaded image (the only card art). Grows by itself as the catalogs do. */
export const LOADOUT_COMBINATIONS =
  (SUPPORTER_PROFILE_THEMES.length + 4)
  * (SUPPORTER_AVATAR_FRAMES.length + 1)
  * (SUPPORTER_NAME_STYLES.length + 1)
  * (SUPPORTER_NAME_FONTS.length + 1)
  * (SUPPORTER_FOILS.length + 1)
  * (SUPPORTER_CARD_SLEEVES.length + 1)
  * (SUPPORTER_BINDERS.length + 1)
  * (SUPPORTER_WRAPPERS.length + 1)
  * (SUPPORTER_BLADES.length + 1);

export function sameLook(a: SupporterLook, b: SupporterLook): boolean {
  return a.motif === b.motif && a.foil === b.foil && a.url === b.url && a.scale === b.scale && a.opacity === b.opacity;
}

/* Frames, grouped by theme. A set (wing layers, dan skips, the 7K orbit and
   4K LN tiers) is one tile, with its variants as chips once it is picked. */

export type FrameEntry =
  | { id: SupporterAvatarFrameId; label: MessageDescriptor }
  | { set: string; label: MessageDescriptor; chips: MessageDescriptor; variants: { id: SupporterAvatarFrameId; label: string }[]; shown: number };

const wings = (set: string, label: MessageDescriptor): FrameEntry => ({
  set,
  label,
  chips: msg`Layers`,
  variants: [1, 2, 3].map((tier) => ({ id: `${set}-${tier}` as SupporterAvatarFrameId, label: String(tier) })),
  shown: 1,
});

export const FRAME_GROUPS: { key: string; entries: FrameEntry[] }[] = [
  {
    key: "mania",
    entries: [
      { id: "judgement-pop", label: msg`Judgements` },
      { id: "dfjk-keys", label: msg`DFJK` },
      { id: "note-highway", label: msg`Note highway` },
      { id: "chordjack-pile", label: msg`Chordjack` },
      { id: "stair-roll", label: msg`Stair roll` },
      { id: "sv-gimmick", label: msg`SV gimmick` },
      { id: "percy-check", label: msg`Percy check` },
      {
        set: "hit-error",
        label: msg`Hit error meter`,
        chips: msg`Acc`,
        variants: [
          { id: "hit-error", label: "Good" },
          { id: "hit-error-bad", label: "Bad" },
          { id: "hit-error-reverse", label: "Reverse" },
        ],
        shown: 0,
      },
      { id: "combo-break", label: msg`Combo break` },
      { id: "results-grade", label: msg`Results grade` },
      { id: "clutch-hp", label: msg`Clutch HP` },
      { id: "skill-radar", label: msg`Skillset radar` },
      { id: "seven-key", label: msg`7K board` },
      { id: "kappa-signal", label: msg`Kappa signal` },
      { id: "delta-crest", label: msg`Delta crest` },
      {
        set: "dan-skip",
        label: msg`Dan skip`,
        chips: msg`Skip`,
        variants: [
          { id: "dan-skip-1-eta", label: "1st to Eta" },
          { id: "dan-skip-5-gamma", label: "5th to Gamma" },
          { id: "dan-skip-10-alpha", label: "10th to Alpha" },
          { id: "dan-skip-alpha-kappa", label: "Alpha to Kappa" },
        ],
        shown: 2,
      },
      {
        set: "7k-orbit",
        label: msg`7K orbit`,
        chips: msg`Tier`,
        variants: [
          { id: "gamma-orbit", label: "Gamma" },
          { id: "azimuth-orbit", label: "Azimuth" },
          { id: "zenith-orbit", label: "Zenith" },
          { id: "stellium-orbit", label: "Stellium" },
        ],
        shown: 2,
      },
      {
        set: "ln-hold",
        label: msg`LN hold`,
        chips: msg`Tier`,
        variants: [1, 5, 9, 13, 17].map((n) => ({ id: `ln-hold-${n}` as SupporterAvatarFrameId, label: `LN ${n}` })),
        shown: 4,
      },
      { id: "hanging-stellium", label: msg`Stellium charm` },
      { id: "course-run", label: msg`Course run` },
      { id: "stage-four-fail", label: msg`Stage 4 fail` },
      { id: "pass-stamp", label: msg`Pass stamp` },
      { id: "greek-circle", label: msg`Greek circle` },
      { id: "trophy-shelf", label: msg`Trophy shelf` },
      { id: "dan-license", label: msg`Dan license` },
    ],
  },
  {
    key: "retro",
    entries: [
      { id: "classic-window", label: msg`Classic window` },
      { id: "xp-window", label: msg`XP window` },
      { id: "aero-window", label: msg`Aero window` },
      { id: "aero-bubble", label: msg`Aero bubble` },
      { id: "desktop-icon", label: msg`Desktop icon` },
      { id: "paint-canvas", label: msg`Paint canvas` },
      { id: "paperclip", label: msg`Paperclip` },
      { id: "error-cascade", label: msg`Error cascade` },
      { id: "blue-screen", label: msg`Blue screen` },
      { id: "loading-bar", label: msg`Loading bar` },
      { id: "crt-monitor", label: msg`CRT monitor` },
      {
        set: "disc-bounce",
        label: msg`Screensaver`,
        chips: msg`Keys`,
        variants: [
          { id: "disc-bounce", label: "4K" },
          { id: "disc-bounce-7k", label: "7K" },
        ],
        shown: 0,
      },
      { id: "pipes", label: msg`Pipes` },
      { id: "pixel-hearts", label: msg`Pixel hearts` },
      { id: "old-photo", label: msg`Old photo` },
      { id: "viewfinder", label: msg`Viewfinder` },
    ],
  },
  {
    key: "terminal",
    entries: [
      { id: "term-window", label: msg`Terminal window` },
      { id: "term-rain", label: msg`Matrix rain` },
      { id: "term-boot", label: msg`Boot box` },
      { id: "term-hud", label: msg`Hex HUD` },
    ],
  },
  {
    key: "nature",
    entries: [
      { id: "sakura", label: msg`Sakura` },
      { id: "wisteria", label: msg`Wisteria` },
      { id: "autumn-maple", label: msg`Autumn maple` },
      { id: "winter-pine", label: msg`Winter pine` },
      { id: "ink-plum", label: msg`Ink plum` },
      { id: "bronze-laurel", label: msg`Bronze laurel` },
      { id: "rain-cloud", label: msg`Rain cloud` },
      { id: "fairy-lights", label: msg`Fairy lights` },
      { id: "fish-tank", label: msg`Fish tank` },
    ],
  },
  {
    key: "cats",
    entries: [
      { id: "cat-parade", label: msg`Cat parade` },
      { id: "makiba-peek", label: msg`Makiba` },
      { id: "makiba-chubby", label: msg`Chubby Makiba` },
      { id: "neon-ears", label: msg`Neon ears` },
    ],
  },
  {
    key: "crowns",
    entries: [{ id: "crown", label: msg`Crown` }, { id: "crown-sketch", label: msg`Sketch crown` }, { id: "crown-sketch-gold", label: msg`Gold sketch crown` }],
  },
  {
    // a dan is a martial-arts grade first
    key: "dojo",
    entries: [{ id: "black-belt", label: msg`Black belt` }],
  },
  {
    key: "shrine",
    entries: [
      { id: "yinyang-orbs", label: msg`Yin-yang orbs` },
      { id: "reimu-ribbon", label: msg`Shrine ribbon` },
      { id: "hakurei-torii", label: msg`Shrine gate` },
      { id: "spell-card", label: msg`Spell card` },
      { id: "witch-hat", label: msg`Green hat` },
      { id: "stardust", label: msg`Stardust` },
      { id: "witch-broom", label: msg`Witch hat and broom` },
      { id: "ice-fairy", label: msg`Ice fairy` },
      { id: "scarlet-moon", label: msg`Scarlet moon` },
      { id: "rainbow-crystal-wings", label: msg`Crystal wings` },
      { id: "time-stop-knives", label: msg`Time-stop knives` },
    ],
  },
  {
    key: "arcade",
    entries: [
      { id: "wash-ring", label: msg`Touch ring` },
      { id: "knob-lasers", label: msg`Knob lasers` },
      { id: "scratch-deck", label: msg`Turntable` },
      { id: "step-pad", label: msg`Dance pad` },
      { id: "judge-line", label: msg`Judgement line` },
    ],
  },
  {
    key: "gacha",
    entries: [
      { id: "halo-cyan", label: msg`Halo` },
      { id: "halo-pink", label: msg`Pink halo` },
      { id: "five-star-pull", label: msg`Five-star pull` },
      { id: "ssr-card", label: msg`SSR card` },
      { id: "pity-counter", label: msg`Pity counter` },
      { id: "rail-pass", label: msg`Rail pass` },
    ],
  },
  {
    key: "sketchbook",
    entries: [
      { id: "pencil-boil", label: msg`Pencil test` },
      { id: "taped-page", label: msg`Taped page` },
      { id: "margin-doodles", label: msg`Margin doodles` },
      { id: "highlighter-loop", label: msg`Highlighter` },
      { id: "crayon-border", label: msg`Crayon` },
      { id: "focus-lines", label: msg`Focus lines` },
    ],
  },
  {
    key: "fire",
    entries: [
      { id: "flames", label: msg`Flames` },
      { id: "flames-blue", label: msg`Blue flames` },
      { id: "lightning", label: msg`Lightning` },
    ],
  },
  {
    key: "stage",
    entries: [
      { id: "spectrum-bars", label: msg`Spectrum bars` },
      { id: "sheet-music", label: msg`Sheet music` },
      { id: "jewel-case", label: msg`Jewel case` },
      { id: "stage-curtains", label: msg`Stage curtains` },
    ],
  },
  {
    key: "gothic",
    entries: [
      { id: "thorns", label: msg`Thorns` },
      { id: "chains", label: msg`Chains` },
    ],
  },
  {
    // for a profile that wants a frame and no joke
    key: "plain",
    entries: [
      { id: "slim-ring", label: msg`Slim ring` },
      { id: "double-line", label: msg`Double line` },
    ],
  },
  {
    key: "soul",
    entries: [
      { id: "bullet-board", label: msg`Bullet board` },
      { id: "dialogue-box", label: msg`Dialogue box` },
      { id: "battle-buttons", label: msg`Battle menu` },
      { id: "save-star", label: msg`Save point` },
      { id: "soul-shatter", label: msg`Soul shatter` },
      { id: "hp-bar", label: msg`HP bar` },
      { id: "susies-idea", label: msg`Bright idea` },
    ],
  },
  {
    key: "wings",
    entries: [
      wings("light-wings", msg`Light wings`),
      wings("ai-wings", msg`Angel wings`),
      wings("wings-feather", msg`Feather wings`),
      wings("wings-swept", msg`Swept wings`),
      wings("wings-soft", msg`Soft wings`),
      wings("wings-pink", msg`Pink wings`),
      wings("wings-gold", msg`Gold wings`),
    ],
  },
];

/* A frame's name as the slot shows it: the tile's label, plus the variant for a set. */
export const FRAME_NAMES = new Map<SupporterAvatarFrameId, { label: MessageDescriptor; variant?: string; group: string }>(
  FRAME_GROUPS.flatMap((group) =>
    group.entries.flatMap((entry) =>
      "id" in entry
        ? [[entry.id, { label: entry.label, group: group.key }] as const]
        : entry.variants.map((variant) => [variant.id, { label: entry.label, variant: variant.label, group: group.key }] as const),
    ),
  ),
);

export const NAME_STYLE_GROUPS: { key: string; title: MessageDescriptor; styles: SupporterNameStyleId[] }[] = [
  {
    key: "effects",
    title: msg`Effects`,
    styles: ["chrome", "molten-gold", "ethereal", "pearl", "galaxy", "heatmap", "note-rain", "plasma", "ink", "caustics", "lava", "inferno", "hellfire", "dither", "mesh", "aurora", "glitch"],
  },
  { key: "gradients", title: msg`Gradients`, styles: ["holo", "gold", "rainbow", "sunset", "ember", "frost", "aero"] },
  { key: "glow", title: msg`Glow and retro`, styles: ["neon", "hit-light", "300g", "pixel", "terminal", "sticker", "karaoke", "wireframe"] },
  { key: "labels", title: msg`Labels`, styles: ["plate", "label-tape", "highlighter", "long-note"] },
];

/* Every name font in picker order: pixel and tech, heavy, cartoon, handwritten, then classic serifs. */
export const NAME_FONT_ORDER: SupporterNameFontId[] = [
  "pixel", "silkscreen", "vt323", "majormono", "orbitron", "audiowide", "michroma", "zendots", "rubikglitch", "pixelify", "jersey", "doto", "tektur", "monocraft", "pixeloperator", "pixelheavy", "unbounded", "bungee", "russo", "blackops", "bebas", "monoton", "delagothic", "rubikmono", "climatecrisis", "righteous", "bangers", "luckiest", "shrikhand", "creepster", "fredoka", "bagel", "rampart", "marker", "rocksalt", "pacifico", "lobster", "caveat", "sedgwick", "yellowtail", "greatvibes", "cinzel", "playfair", "abril", "unifraktur", "bodoni", "limelight", "uncial",
];

