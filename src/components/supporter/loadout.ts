import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

import { SUPPORTER_AVATAR_FRAMES, type SupporterAvatarFrameId } from "../../lib/supporter-avatar-frames";
import { DEFAULT_SUPPORTER_MOTIF, SUPPORTER_MOTIFS, type SupporterLook, type SupporterMotifId } from "../../lib/supporter-card-looks";
import { DEFAULT_SUPPORTER_FOIL, SUPPORTER_FOILS, type SupporterFoilId } from "../../lib/supporter-foils";
import { SUPPORTER_NAME_FONTS, type SupporterNameFontId } from "../../lib/supporter-name-fonts";
import { SUPPORTER_NAME_STYLES, type SupporterNameStyleId } from "../../lib/supporter-name-styles";
import { SUPPORTER_PROFILE_THEMES, type ProfileThemeOptions, type SupporterProfileThemeId } from "../../lib/supporter-profile-themes";
import { SUPPORTER_BINDERS, SUPPORTER_CARD_SLEEVES, SUPPORTER_WRAPPERS, type SupporterPackStyle } from "../../lib/supporter-pack-style";

/* The /supporter loadout: everything a supporter wears as nine slots, what
   each slot can hold, and how the page reads, swaps and rolls one slot of a
   loadout. Card art and card foil are two slots over one stored look. */

export interface Loadout {
  theme: SupporterProfileThemeId | null;
  /** The theme's own switches (the Note highway's real charts). */
  themeOptions: ProfileThemeOptions;
  frame: SupporterAvatarFrameId | null;
  nameStyle: SupporterNameStyleId | null;
  nameFont: SupporterNameFontId | null;
  look: SupporterLook;
  /** Packs cosmetics: card case, binder and pack wrapper. */
  pack: SupporterPackStyle;
}

export type SlotId = "theme" | "frame" | "nameStyle" | "nameFont" | "motif" | "foil" | "sleeve" | "binder" | "wrapper";

export const SLOT_IDS: readonly SlotId[] = ["theme", "frame", "nameStyle", "nameFont", "foil", "motif", "sleeve", "binder", "wrapper"];

/* The slots that dress the viewer's packs, drawn as their own group. */
export const PACK_SLOT_IDS: readonly SlotId[] = ["sleeve", "binder", "wrapper"];

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
};

export type SlotValue = string | null;

export const DEFAULT_LOOK: SupporterLook = { motif: DEFAULT_SUPPORTER_MOTIF, foil: DEFAULT_SUPPORTER_FOIL };

export function slotValue(loadout: Loadout, slot: SlotId): SlotValue {
  if (slot === "motif") return loadout.look.motif === "none" ? null : loadout.look.motif;
  if (slot === "foil") return loadout.look.foil === "none" ? null : loadout.look.foil;
  if (slot === "sleeve" || slot === "binder" || slot === "wrapper") return loadout.pack[slot];
  return loadout[slot];
}

/* `custom` is the viewer's own image, for when "custom" is put in the art slot. */
export function withSlot(loadout: Loadout, slot: SlotId, value: SlotValue, custom?: { url: string; scale: number; opacity: number } | null): Loadout {
  if (slot === "motif") {
    if (value === "custom") return custom ? { ...loadout, look: { motif: "custom", foil: loadout.look.foil, ...custom } } : loadout;
    if (value === null) return { ...loadout, look: { motif: "none", foil: loadout.look.foil } };
    return { ...loadout, look: { motif: value as SupporterMotifId, foil: loadout.look.foil } };
  }
  if (slot === "foil") return { ...loadout, look: { ...loadout.look, foil: value === null ? "none" : value as SupporterFoilId } };
  if (slot === "sleeve" || slot === "binder" || slot === "wrapper") return { ...loadout, pack: { ...loadout.pack, [slot]: value } as SupporterPackStyle };
  return { ...loadout, [slot]: value } as Loadout;
}

/* What a roll can land on per slot. A roll always lands on something, so no
   "none", and never on the viewer's own image. */
const ROLL_POOLS: Record<SlotId, readonly SlotValue[]> = {
  theme: SUPPORTER_PROFILE_THEMES,
  frame: SUPPORTER_AVATAR_FRAMES,
  nameStyle: SUPPORTER_NAME_STYLES,
  nameFont: SUPPORTER_NAME_FONTS,
  motif: SUPPORTER_MOTIFS.map((motif) => motif.id),
  foil: SUPPORTER_FOILS,
  sleeve: SUPPORTER_CARD_SLEEVES,
  binder: SUPPORTER_BINDERS,
  wrapper: SUPPORTER_WRAPPERS,
};

export function randomSlotValue(slot: SlotId, not?: SlotValue): SlotValue {
  const pool = ROLL_POOLS[slot].filter((value) => value !== not);
  return pool[Math.floor(Math.random() * pool.length)];
}

/* How many different looks the loadout can put together: every slot's
   choices multiplied (an empty slot counts as one, and the Note highway with
   its real charts switched on as one more theme), leaving out the viewer's
   own uploaded image. Grows by itself as the catalogs do. */
export const LOADOUT_COMBINATIONS =
  (SUPPORTER_PROFILE_THEMES.length + 2)
  * (SUPPORTER_AVATAR_FRAMES.length + 1)
  * (SUPPORTER_NAME_STYLES.length + 1)
  * (SUPPORTER_NAME_FONTS.length + 1)
  * (SUPPORTER_FOILS.length + 1)
  * (SUPPORTER_MOTIFS.length + 1)
  * (SUPPORTER_CARD_SLEEVES.length + 1)
  * (SUPPORTER_BINDERS.length + 1)
  * (SUPPORTER_WRAPPERS.length + 1);

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

export const FRAME_GROUPS: { key: string; title: MessageDescriptor; entries: FrameEntry[] }[] = [
  {
    key: "dans",
    title: msg`Dans`,
    entries: [
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
    ],
  },
  {
    key: "mania",
    title: msg`osu!mania`,
    entries: [
      { id: "judgement-pop", label: msg`Judgements` },
      { id: "dfjk-keys", label: msg`DFJK` },
    ],
  },
  {
    key: "retro",
    title: msg`Retro`,
    entries: [
      { id: "classic-window", label: msg`Classic window` },
      { id: "xp-window", label: msg`XP window` },
      { id: "aero-window", label: msg`Aero window` },
      { id: "error-cascade", label: msg`Error cascade` },
      { id: "loading-bar", label: msg`Loading bar` },
      { id: "crt-monitor", label: msg`CRT monitor` },
      { id: "disc-bounce", label: msg`Screensaver` },
      { id: "pixel-hearts", label: msg`Pixel hearts` },
      { id: "old-photo", label: msg`Old photo` },
    ],
  },
  {
    key: "terminal",
    title: msg`Terminal`,
    entries: [
      { id: "term-window", label: msg`Terminal window` },
      { id: "term-rain", label: msg`Matrix rain` },
      { id: "term-boot", label: msg`Boot box` },
      { id: "term-hud", label: msg`Hex HUD` },
    ],
  },
  {
    key: "nature",
    title: msg`Seasons and nature`,
    entries: [
      { id: "sakura", label: msg`Sakura` },
      { id: "wisteria", label: msg`Wisteria` },
      { id: "autumn-maple", label: msg`Autumn maple` },
      { id: "winter-pine", label: msg`Winter pine` },
      { id: "ink-plum", label: msg`Ink plum` },
      { id: "bronze-laurel", label: msg`Bronze laurel` },
      { id: "rain-cloud", label: msg`Rain cloud` },
      { id: "fairy-lights", label: msg`Fairy lights` },
    ],
  },
  {
    key: "cats",
    title: msg`Cats`,
    entries: [
      { id: "cat-parade", label: msg`Cat parade` },
      { id: "makiba-peek", label: msg`Makiba` },
      { id: "neon-ears", label: msg`Neon ears` },
    ],
  },
  {
    key: "effects",
    title: msg`Effects`,
    entries: [{ id: "storm", label: msg`Storm` }],
  },
  {
    key: "shrine",
    title: msg`Shrine and magic`,
    entries: [
      { id: "yinyang-orbs", label: msg`Yin-yang orbs` },
      { id: "reimu-ribbon", label: msg`Shrine ribbon` },
      { id: "hakurei-torii", label: msg`Shrine gate` },
      { id: "spell-card", label: msg`Spell card` },
      { id: "witch-hat", label: msg`Witch hat` },
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
    title: msg`Arcade`,
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
    title: msg`Gacha`,
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
    title: msg`Sketchbook`,
    entries: [
      { id: "pencil-boil", label: msg`Pencil test` },
      { id: "taped-page", label: msg`Taped page` },
      { id: "margin-doodles", label: msg`Margin doodles` },
      { id: "highlighter-loop", label: msg`Highlighter` },
      { id: "crayon-border", label: msg`Crayon` },
    ],
  },
  {
    key: "soul",
    title: msg`Soul`,
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
    title: msg`Wings`,
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
    styles: ["chrome", "molten-gold", "ethereal", "pearl", "galaxy", "heatmap", "note-rain", "plasma", "ink", "caustics", "lava", "dither", "mesh", "aurora", "glitch"],
  },
  { key: "gradients", title: msg`Gradients`, styles: ["holo", "gold", "rainbow", "sunset", "ember", "frost"] },
  { key: "glow", title: msg`Glow and retro`, styles: ["neon", "hit-light", "300g", "pixel", "terminal", "sticker", "plate"] },
];

export const NAME_FONT_GROUPS: { key: string; title: MessageDescriptor; fonts: SupporterNameFontId[] }[] = [
  { key: "game", title: msg`Game and tech`, fonts: ["pixel", "silkscreen", "vt323", "majormono", "orbitron", "audiowide", "michroma", "zendots", "rubikglitch"] },
  { key: "bold", title: msg`Bold`, fonts: ["unbounded", "bungee", "russo", "blackops", "bebas", "monoton"] },
  { key: "fun", title: msg`Fun`, fonts: ["righteous", "bangers", "luckiest", "shrikhand", "creepster"] },
  { key: "hand", title: msg`Handwritten`, fonts: ["marker", "rocksalt", "pacifico", "lobster"] },
  { key: "classic", title: msg`Classic`, fonts: ["cinzel", "playfair", "abril", "unifraktur"] },
];

export const MOTIF_LABELS: Record<SupporterMotifId, MessageDescriptor> = {
  stars: msg`Stars`,
  hearts: msg`Hearts`,
  notes: msg`Notes`,
  petals: msg`Sakura`,
  headphones: msg`Headphones`,
  keys: msg`Keycaps`,
  stellium: msg`Stellium`,
};
