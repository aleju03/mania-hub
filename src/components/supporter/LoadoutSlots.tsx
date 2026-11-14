import { Fragment, memo, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";

import {
} from "../../lib/supporter-card-looks";
import { SUPPORTER_FOIL_LABELS, SUPPORTER_FOILS, type SupporterFoilId } from "../../lib/supporter-foils";
import {
  FRAMED_AVATAR_RADIUS,
  framedAvatarStyle,
  supporterFrameGeometry,
  workshopFrameName,
  type SupporterAvatarFrameId,
} from "../../lib/supporter-avatar-frames";
import { SUPPORTER_NAME_FONT_LABELS, type SupporterNameFontId } from "../../lib/supporter-name-fonts";
import { baseNameStyle, DEFAULT_SOLID_COLOUR, isSolidNameStyle, TERMINAL_BARE, NAME_OUTLINE_THICKEST, nameOutlineThickness, nameOutlineValue, nameStyleLabel, solidNameColour, solidNameStyle, type SupporterNameStyleId } from "../../lib/supporter-name-styles";
import { SupporterStyledName } from "./SupporterNameStyle";
import { announceFrameDanPicked, frameDanName, SupporterAvatarFrame } from "../player/SupporterAvatarFrame";
import { danBareLabel, getDanImageSrc } from "../../lib/dan-images";
import { DAN_SKILLSET_META } from "../../lib/skill-axes";
import { fetchFrameDanChoices, fetchOwnWorkshopFrames, FRAME_SHELF_MAX, saveFrameDanChoice, saveFrameShelfChoice, type FrameDanChoices } from "../../lib/supporter-look-settings";
import { fetchLiveWorkshopFrames, forgetLiveSupporterLook } from "../../lib/live-backend";
import { registerSubmittedFrames, type SubmittedFrame } from "../../lib/workshop-frames";
import { avatarUrlUserId } from "../ui/Avatar";
import { CheckBadge, LockIcon, PasteIcon, UploadIcon } from "./LoadoutIcons";
import { FoilPreview } from "./FoilPreview";
import { DEFAULT_PACK_ART_STYLE, getCachedPackFrontCanvas } from "../packs/packArt";
import { useWrapperArtVersion, wrapperArtPending } from "../packs/wrapperArt";
import { BladeSwatch } from "../packs/BladeSwatch";
import { SectionArt } from "./SectionArt";
import { playBladeRip, warmBladeSounds } from "../packs/packSfx";
import { bladeLook } from "../packs/packBlades";
import {
  SUPPORTER_BINDER_LABELS,
  SUPPORTER_BINDERS,
  SUPPORTER_BLADE_LABELS,
  SUPPORTER_BLADES,
  SUPPORTER_CARD_SLEEVE_LABELS,
  SUPPORTER_CARD_SLEEVES,
  SUPPORTER_WRAPPER_LABELS,
  SUPPORTER_WRAPPERS,
  type SupporterBinderId,
  type SupporterBladeId,
  type SupporterCardSleeveId,
  type SupporterWrapperId,
} from "../../lib/supporter-pack-style";
import { ProfileThemeSwatch } from "./ProfileThemeBackdrop";
import { supporterRowBackground } from "./SupporterRowBanner";
import { SUPPORTER_PROFILE_THEME_LABELS, SUPPORTER_PROFILE_THEMES, type SupporterProfileThemeId } from "../../lib/supporter-profile-themes";
import {
  FRAME_GROUPS,
  FRAME_NAMES,
  NAME_FONT_GROUPS,
  NAME_STYLE_GROUPS,
  PACK_SECTIONS,
  PROFILE_SECTIONS,
  SECTION_LABELS,
  SLOT_LABELS,
  isSlotSection,
  slotValue,
  type FrameEntry,
  type SupporterSection,
  type Loadout,
  type SlotId,
  type SlotValue,
} from "./loadout";
import { scaledPx } from "#/lib/ui-scale-values";
import { hideBrokenImage } from "../../lib/custom-themes";
import { fetchOwnCustomThemes, type CustomThemeSummary, type OwnCustomThemes } from "../../lib/supporter-custom-themes";

/* The right side of the /supporter loadout: the six slots, each showing what
   it holds, and under them the drawer of the open slot. Pointing at an item
   (or focusing it) tries it on the stage; clicking puts it in the slot. A lock
   keeps its slot out of rolls. Only reports; the page owns the loadout. */

export interface CustomMotif {
  url: string;
  scale: number;
  opacity: number;
}

/* A frame's still around the viewer's avatar, fitted into a square. */
export function FrameThumb({ frame, avatar, size, live = false }: { frame: SupporterAvatarFrameId | null; avatar: string | undefined; size: number; live?: boolean }) {
  // the avatar sits dead centre whatever the frame, sized so the art fits round it: room is
  // kept on both sides for the larger overhang of each pair, so a crown or a flame never
  // pushes the picture off centre
  const [overLeft, overTop, overRight, overBottom] = frame ? supporterFrameGeometry(frame).overhang : [0, 0, 0, 0];
  const scale = size / Math.max(1 + 2 * Math.max(overLeft, overRight), 1 + 2 * Math.max(overTop, overBottom), 1.6);
  const avatarLeft = (size - scale) / 2;
  const avatarTop = (size - scale) / 2;
  return (
    <span className="relative block" style={{ width: scaledPx(size), height: scaledPx(size) }}>
      <span className="absolute" style={{ left: avatarLeft, top: avatarTop, width: scale, height: scale }}>
        <img src={avatar} alt="" className="h-full w-full bg-osu-b3 object-cover" style={framedAvatarStyle(frame) ?? { borderRadius: FRAMED_AVATAR_RADIUS }} />
        {frame && <SupporterAvatarFrame frame={frame} still={!live} userId={avatarUrlUserId(avatar)} />}
      </span>
    </span>
  );
}

/* A foil over a blank card, as the drawer and the slot show it. */
export function FoilCard({ foil, className, still }: { foil: SupporterFoilId; className: string; still?: boolean }) {
  return (
    <span className={`relative block overflow-hidden rounded-[6px] bg-gradient-to-b from-[#3a3d4a] to-[#24262f] ${className}`}>
      <FoilPreview foil={foil} still={still} className="absolute inset-0 h-full w-full" />
    </span>
  );
}

/* --- The viewer's own themes ---------------------------------------------- */

/* Their workshop themes, read once per page and shared by the slot row and
   the theme drawer, so a worn one is named (and pictured) in both. */
let ownThemes: OwnCustomThemes | null = null;
let ownThemesLoading = false;
const ownThemeListeners = new Set<() => void>();
function setOwnThemes(next: OwnCustomThemes | null) {
  ownThemes = next;
  for (const listener of ownThemeListeners) listener();
}
function useOwnThemes(enabled: boolean): OwnCustomThemes | null {
  const value = useSyncExternalStore(
    (listener) => {
      ownThemeListeners.add(listener);
      return () => ownThemeListeners.delete(listener);
    },
    () => ownThemes,
    () => null,
  );
  useEffect(() => {
    if (!enabled || ownThemes || ownThemesLoading) return;
    ownThemesLoading = true;
    fetchOwnCustomThemes().then(setOwnThemes).catch(() => {}).finally(() => {
      ownThemesLoading = false;
    });
  }, [enabled]);
  return value;
}
/* The own theme on, when no built-in is: the page reads a worn own theme back as none. */
function wornOwnTheme(theme: SlotValue | null): CustomThemeSummary | null {
  if (theme || !ownThemes?.worn) return null;
  const worn = ownThemes.worn.themeId;
  return ownThemes.themes.find((entry) => entry.id === worn) ?? null;
}

/* --- Slot rows ----------------------------------------------------------- */

function useSlotName() {
  const { t, i18n } = useLingui();
  return (slot: SlotId, value: SlotValue): string => {
    if (slot === "theme") return value ? i18n._(SUPPORTER_PROFILE_THEME_LABELS[value as SupporterProfileThemeId]) : wornOwnTheme(value)?.name ?? t`Site colours`;
    if (slot === "frame") {
      if (!value) return t`No frame`;
      const made = workshopFrameName(value as SupporterAvatarFrameId);
      if (made) return made;
      const name = FRAME_NAMES.get(value as SupporterAvatarFrameId);
      return name ? `${i18n._(name.label)}${name.variant ? ` ${name.variant}` : ""}` : value;
    }
    if (slot === "nameStyle") return value ? i18n._(nameStyleLabel(value as SupporterNameStyleId)) : t`Plain`;
    if (slot === "nameFont") return value ? i18n._(SUPPORTER_NAME_FONT_LABELS[value as SupporterNameFontId]) : t`Default`;
    if (slot === "motif") return value === "custom" ? t`Your image` : t`No art`;
    if (slot === "sleeve") return value ? i18n._(SUPPORTER_CARD_SLEEVE_LABELS[value as SupporterCardSleeveId]) : t`No sleeve`;
    if (slot === "binder") return value ? i18n._(SUPPORTER_BINDER_LABELS[value as SupporterBinderId]) : t`No binder`;
    if (slot === "wrapper") return value ? i18n._(SUPPORTER_WRAPPER_LABELS[value as SupporterWrapperId]) : t`Standard foil`;
    if (slot === "blade") return value ? i18n._(SUPPORTER_BLADE_LABELS[value as SupporterBladeId]) : t`Standard blade`;
    return value === null ? t`No foil` : i18n._(SUPPORTER_FOIL_LABELS[value as SupporterFoilId]);
  };
}

/* An empty art or foil slot: a struck-through circle, drawn rather than an icon font. */
function NoArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6.2 17.8 17.8 6.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function SlotThumb({ slot, loadout, avatar }: { slot: SlotId; loadout: Loadout; avatar: string | undefined }) {
  useWrapperArtVersion();
  if (slot === "theme") {
    const own = wornOwnTheme(loadout.theme);
    return loadout.theme
      ? <ProfileThemeSwatch key={loadout.theme} theme={loadout.theme} still className="h-12 w-12" />
      : own?.stillUrl ? <img src={own.stillUrl} alt="" onError={hideBrokenImage} className="h-12 w-12 object-cover" draggable={false} />
      : <SiteColours className="h-5 w-5" />;
  }
  if (slot === "frame") return <FrameThumb frame={loadout.frame} avatar={avatar} size={40} />;
  if (slot === "nameStyle") {
    return <SupporterStyledName nameStyle={loadout.nameStyle} nameFont={loadout.nameFont} outline={loadout.nameOutline} name="Aa" className="p-1 -m-1 text-[19px] font-black leading-none text-white" />;
  }
  if (slot === "nameFont") {
    return <span className={`text-[19px] font-bold leading-none text-white ${loadout.nameFont ? `name-font--${loadout.nameFont}` : ""}`}>Aa</span>;
  }
  if (slot === "motif") {
    if (loadout.look.motif !== "custom") return <NoArt className="h-5 w-5" />;
    return <img src={loadout.look.url} alt="" className="h-8 w-8 rounded-sm object-contain" />;
  }
  if (slot === "sleeve") {
    return loadout.pack.sleeve ? <SleeveCard sleeve={loadout.pack.sleeve} className="h-[38px] w-[27px]" /> : <NoArt className="h-5 w-5" />;
  }
  if (slot === "binder") return loadout.pack.binder ? <BinderBook binder={loadout.pack.binder} className="h-[36px] w-[28px]" /> : <NoArt className="h-5 w-5" />;
  if (slot === "wrapper") {
    return loadout.pack.wrapper
      ? <img src={wrapperThumb(loadout.pack.wrapper)} alt="" className="h-[40px] w-[24px] rounded-[3px] object-cover" />
      : <img src={wrapperThumb(null)} alt="" className="h-[40px] w-[24px] rounded-[3px] object-cover" />;
  }
  if (slot === "blade") return <BladeSwatch blade={loadout.pack.blade} className="h-[30px] w-[44px]" />;
  if (loadout.look.foil === "none") return <NoArt className="h-5 w-5" />;
  return <FoilCard foil={loadout.look.foil} still className="h-[40px] w-[29px]" />;
}

/* Each case, empty: a still of the stage's real 3D case, rendered ahead of
   time (150x210, 5:7) so a row of them costs no GPU work. Re-render them with
   foundry's grab-cases (EMPTY=1) if a case's look changes. */
export function SleeveCard({ sleeve, className }: { sleeve: SupporterCardSleeveId; className: string }) {
  return (
    <img
      src={`/images/supporter-perks/case-${sleeve}.webp`}
      alt=""
      aria-hidden
      draggable={false}
      width={150}
      height={210}
      loading="lazy"
      decoding="async"
      className={`block object-contain ${className}`}
    />
  );
}

/* A closed binder in its cover: a still rendered ahead of time from the
   .bnd-cover rules in styles.css (spine, stitching, label plate), since the
   covers' blended grain and shadows are slow to rasterize live, which dropped
   frames when a row of them scrolled into view. Re-render them (3x, 64x84)
   if a cover's CSS changes. */
export function BinderBook({ binder, className }: { binder: SupporterBinderId; className: string }) {
  return (
    <img
      src={`/images/binders/covers/${binder}.webp`}
      alt=""
      aria-hidden
      draggable={false}
      className={`block rounded-[5px] shadow-[0_4px_10px_-4px_rgba(0,0,0,0.7)] ${className}`}
    />
  );
}

/* A small print of a pack in a wrapper (null: the standard foil), drawn once. */
const wrapperThumbs = new Map<string, string>();
export function wrapperThumb(wrapper: SupporterWrapperId | null): string {
  const key = wrapper ?? "standard";
  const cached = wrapperThumbs.get(key);
  if (cached) return cached;
  if (typeof document === "undefined") return "";
  const art = getCachedPackFrontCanvas({ ...DEFAULT_PACK_ART_STYLE, wrapper });
  const canvas = document.createElement("canvas");
  canvas.width = 180;
  canvas.height = 300;
  canvas.getContext("2d")?.drawImage(art, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/jpeg", 0.86);
  // drawn before the wrapper's renders were in: shown for now, drawn again once they are
  if (!wrapperArtPending(wrapper)) wrapperThumbs.set(key, url);
  return url;
}

/* The supporter page's sidebar: every section in one list, grouped like a
   store's categories, each loadout slot showing what it holds (the reels
   included), so the list doubles as the overview of the loadout. Below xl it
   folds into one scrolling row of chips. */
export function SupporterNav({ shown, section, onSection, locks, spinning, trying, avatar, supporter, layout }: {
  /** What the stage shows, so the rows read the same as it. */
  shown: Loadout;
  section: SupporterSection;
  onSection: (section: SupporterSection) => void;
  locks: ReadonlySet<SlotId>;
  spinning: boolean;
  /** The slot an item is being tried on in, so its name reads as a preview. */
  trying: SlotId | null;
  avatar: string | undefined;
  supporter: boolean;
  layout: "column" | "row";
}) {
  const { t, i18n } = useLingui();
  const slotName = useSlotName();
  useOwnThemes(supporter);
  const reduced = useReducedMotion();
  const label = (id: SupporterSection) => i18n._(isSlotSection(id) ? SLOT_LABELS[id] : SECTION_LABELS[id]);
  const groups: { title: string; ids: readonly SupporterSection[] }[] = [
    { title: t`Profile`, ids: PROFILE_SECTIONS },
    { title: t`Packs`, ids: PACK_SECTIONS },
  ];
  const you: SupporterSection[] = ["you", "perks"];
  const workshop = [
    { to: "/workshop" as const, label: t`Overview` },
    { to: "/workshop/frames" as const, label: t`Make a frame` },
    { to: "/workshop/themes/$themeId" as const, params: { themeId: "new" }, label: t`Make a theme` },
    { to: "/workshop/themes" as const, label: t`Your themes` },
  ];

  if (layout === "row") {
    const chip = (id: SupporterSection) => (
      <button
        key={id}
        type="button"
        onClick={() => onSection(id)}
        aria-current={section === id ? "page" : undefined}
        className={`inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full py-1 pl-1.5 pr-3 text-[12px] font-semibold transition-colors ${section === id ? "bg-osu-pink text-white" : "bg-osu-b4 text-osu-l2 hover:bg-osu-b3 hover:text-white"}`}
      >
        <SectionArt section={id} className="h-[22px] w-[27px] shrink-0" />
        {label(id)}
      </button>
    );
    return (
      <nav aria-label={t`Supporter sections`} className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1 [scrollbar-width:none] sm:-mx-5 sm:px-5 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0">
        {[...PROFILE_SECTIONS, ...PACK_SECTIONS].map(chip)}
        <Link to="/workshop" className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-osu-b4 py-1 pl-1.5 pr-3 text-[12px] font-semibold text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-white">
          <SectionArt section="workshop" className="h-[22px] w-[27px] shrink-0" />
          {t`Workshop`}
        </Link>
        {chip(supporter ? "you" : "perks")}
      </nav>
    );
  }

  const heading = (text: string) => <div className="px-2 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-osu-f1 first:pt-0">{text}</div>;
  const plainRow = (id: SupporterSection) => (
    <button
      key={id}
      type="button"
      onClick={() => onSection(id)}
      aria-current={section === id ? "page" : undefined}
      className={`flex w-full cursor-pointer items-center rounded-lg px-2 py-1.5 text-left text-[13px] font-semibold transition-colors ${section === id ? "bg-osu-b4 text-white" : "text-osu-l2 hover:bg-osu-b4/60 hover:text-white"}`}
    >
      {label(id)}
    </button>
  );
  // the profile's two non-slot rows sit among slot rows, so they get a drawn tile too
  const iconRow = (id: SupporterSection, icon: ReactNode) => (
    <button
      key={id}
      type="button"
      onClick={() => onSection(id)}
      aria-current={section === id ? "page" : undefined}
      className={`flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors ${section === id ? "bg-osu-b4" : "hover:bg-osu-b4/60"}`}
    >
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-md bg-osu-b6 text-osu-l2 ${section === id ? "ring-1 ring-osu-pink" : ""}`}>{icon}</span>
      <span className={`truncate text-[13px] font-semibold ${section === id ? "text-white" : "text-osu-l2"}`}>{label(id)}</span>
    </button>
  );

  return (
    <nav aria-label={t`Supporter sections`}>
      {groups.map((group) => (
        <Fragment key={group.title}>
          {heading(group.title)}
          {group.ids.map((id) => {
            if (id === "companion") return iconRow(id, <CompanionGlyph className="h-5 w-5" />);
            if (id === "stats") return iconRow(id, <StatsGlyph className="h-5 w-5" />);
            if (!isSlotSection(id)) return plainRow(id);
            const value = slotValue(shown, id);
            const active = section === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onSection(id)}
                aria-current={active ? "page" : undefined}
                className={`flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors ${active ? "bg-osu-b4" : "hover:bg-osu-b4/60"}`}
              >
                <span className={`relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-md bg-osu-b6 [&>*]:scale-[0.78] ${active ? "ring-1 ring-osu-pink" : ""}`}>
                  <SlotThumb slot={id} loadout={shown} avatar={avatar} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-semibold text-osu-f1">{label(id)}</span>
                  <span className="relative block h-[18px] overflow-hidden">
                    <AnimatePresence initial={false} mode="popLayout">
                      <motion.span
                        key={String(value)}
                        initial={reduced ? false : { y: spinning ? -16 : -8, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        exit={reduced ? undefined : { y: spinning ? 16 : 8, opacity: 0 }}
                        transition={{ duration: spinning ? 0.07 : 0.16, ease: "easeOut" }}
                        className={`block truncate text-[13px] font-semibold leading-[18px] ${trying === id ? "text-osu-pink-light" : "text-white"}`}
                      >
                        {slotName(id, value)}
                      </motion.span>
                    </AnimatePresence>
                  </span>
                </span>
                {locks.has(id) && <LockIcon locked className="h-3.5 w-3.5 shrink-0 text-osu-pink" />}
              </button>
            );
          })}
        </Fragment>
      ))}
      {heading(t`Workshop`)}
      {workshop.map((item) => (
        <Link
          key={item.label}
          to={item.to}
          params={"params" in item ? item.params : undefined}
          className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-[13px] font-semibold text-osu-l2 transition-colors hover:bg-osu-b4/60 hover:text-white"
        >
          {item.label}
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-osu-f1" aria-hidden>
            <path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      ))}
      {heading(t`You`)}
      {you.filter((id) => supporter || id !== "you").map(plainRow)}
    </nav>
  );
}

/* A little figure standing on a base, for the companion row. */
function CompanionGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={className}>
      <circle cx="10" cy="5.6" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.2 15V12a3.8 3.8 0 0 1 7.6 0v3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4 16.4h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/* Four stat cards in a grid, for the profile stats row. */
function StatsGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={className}>
      {[[3, 3], [11, 3], [3, 11], [11, 11]].map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="6" height="6" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      ))}
    </svg>
  );
}

/* The lock beside a slot's heading on the page: a locked slot holds still when the dice roll. */
export function SlotLock({ locked, onToggle }: { locked: boolean; onToggle: () => void }) {
  const { t } = useLingui();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={locked}
      title={locked ? t`Unlock for rolls` : t`Lock for rolls`}
      className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold transition-colors ${locked ? "bg-osu-pink/15 text-osu-pink-light" : "text-osu-f1 hover:bg-osu-b4 hover:text-white"}`}
    >
      <LockIcon locked={locked} className="h-4 w-4" />
      {locked ? t`Locked` : t`Lock for rolls`}
    </button>
  );
}

/* --- Drawer -------------------------------------------------------------- */

const tile = (active: boolean) =>
  `relative flex min-w-0 cursor-pointer flex-col items-center gap-1.5 rounded-lg p-1.5 pb-2 text-[11px] font-semibold transition-colors disabled:cursor-default ${active ? "bg-osu-b3 text-white ring-1 ring-osu-pink" : "bg-osu-b4 text-osu-l2 hover:bg-osu-b3 hover:text-white"}`;

const chip = (active: boolean) =>
  `flex h-7 shrink-0 cursor-pointer items-center justify-center rounded-full px-3 text-[12px] font-semibold transition-colors disabled:cursor-default ${active ? "bg-osu-pink text-white" : "bg-osu-b4 text-osu-l2 hover:bg-osu-b3 hover:text-white"}`;

function Picked({ on }: { on: boolean }) {
  const reduced = useReducedMotion();
  return (
    <AnimatePresence>
      {on && (
        <motion.span
          initial={reduced ? false : { scale: 0 }}
          animate={{ scale: 1 }}
          exit={reduced ? undefined : { scale: 0 }}
          transition={{ type: "spring", stiffness: 600, damping: 22 }}
          className="absolute -right-1.5 -top-1.5 z-10"
        >
          <CheckBadge className="h-[18px] w-[18px]" />
        </motion.span>
      )}
    </AnimatePresence>
  );
}

/* One item: tries itself on while pointed at or focused, goes in the slot on click. */
function Item({ active, disabled, onTry, onPick, className, children, label }: {
  active: boolean;
  disabled?: boolean;
  onTry: (on: boolean) => void;
  onPick: () => void;
  className?: string;
  children: ReactNode;
  label?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      aria-label={label}
      title={label}
      onPointerEnter={(event) => event.pointerType === "mouse" && onTry(true)}
      onPointerLeave={(event) => event.pointerType === "mouse" && onTry(false)}
      onFocus={() => onTry(true)}
      onBlur={() => onTry(false)}
      onClick={onPick}
      className={`${tile(active)} ${className ?? ""}`}
    >
      <Picked on={active} />
      {children}
    </button>
  );
}

/* `scroll`: one row that scrolls sideways on phones, wrapping from sm up. */
function Chips<K extends string>({ value, options, onChange, scroll = false }: { value: K; options: { value: K; label: string; count?: number }[]; onChange: (value: K) => void; scroll?: boolean }) {
  return (
    <div className={`mb-3 flex gap-1.5 ${scroll ? "-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0 [&::-webkit-scrollbar]:hidden" : "flex-wrap"}`}>
      {options.map((option) => (
        <button key={option.value} type="button" onClick={() => onChange(option.value)} aria-pressed={value === option.value} className={chip(value === option.value)}>
          {option.label}
          {option.count != null && <span className={`ml-1.5 tabular-nums ${value === option.value ? "text-white/75" : "text-osu-f1"}`}>{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

const holds = (entry: FrameEntry, frame: SupporterAvatarFrameId | null) =>
  "id" in entry ? entry.id === frame : entry.variants.some((variant) => variant.id === frame);

export interface DrawerProps {
  slot: SlotId;
  /** What the slots hold: the equipped loadout, or a roll waiting to be kept. */
  current: Loadout;
  disabled: boolean;
  avatar: string | undefined;
  username: string;
  custom: CustomMotif | null;
  canUpload: boolean;
  onTry: (slot: SlotId, value: SlotValue | undefined) => void;
  onPick: (slot: SlotId, value: SlotValue) => void;
  onUpload: (file: File) => void;
  /** Opens the viewer's own image to adjust its size and strength. */
  onEditCustom: () => void;
  /** The equipped theme's own switches. */
  onThemeOptions: (options: Loadout["themeOptions"]) => void;
  /** The name's outline: previewed while `commit` is false, worn and saved when true. */
  onNameOutline: (outline: string | null, commit: boolean) => void;
  /** Puts on one of the viewer's own themes, or takes it off with null. */
  onWearOwnTheme: (themeId: number | null) => Promise<void>;
}

/* Memoised: the page re-renders on every hover, and the drawer's props hold still through one. */
export const LoadoutDrawer = memo(function LoadoutDrawer(props: DrawerProps) {
  const reduced = useReducedMotion();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={props.slot}
        initial={reduced ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduced ? undefined : { opacity: 0, y: -4 }}
        transition={{ duration: 0.14 }}
      >
        {props.slot === "theme" ? <ThemeDrawer {...props} />
          : props.slot === "frame" ? <FrameDrawer {...props} />
          : props.slot === "nameStyle" ? <NameStyleDrawer {...props} />
          : props.slot === "nameFont" ? <FontDrawer {...props} />
          : props.slot === "motif" ? <MotifDrawer {...props} />
          : props.slot === "sleeve" ? <SleeveDrawer {...props} />
          : props.slot === "binder" ? <BinderDrawer {...props} />
          : props.slot === "wrapper" ? <WrapperDrawer {...props} />
          : props.slot === "blade" ? <BladeDrawer {...props} />
          : <FoilDrawer {...props} />}
      </motion.div>
    </AnimatePresence>
  );
});

const FRAME_ROWS = 3;
const FRAME_TILE_MIN = 84;
const FRAME_GAP = 8;

/* How many tiles fit across the grid, so a page is always FRAME_ROWS full rows. */
function useColumns(min: number, gap: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(6);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const width = node.clientWidth;
      if (width > 0) setColumns(Math.max(1, Math.floor((width + gap) / (min + gap))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [min, gap]);
  return [ref, columns] as const;
}

/* Every frame in one list, three rows at a time, with no categories: the
   built-in ones in FRAME_GROUPS order, then the workshop's. */

/* The workshop's frames this viewer may wear: the shared list and their own,
   as picker entries named by their makers. */
function useWorkshopFrameEntries(): FrameEntry[] {
  const [made, setMade] = useState<SubmittedFrame[]>([]);
  useEffect(() => {
    let alive = true;
    void Promise.all([fetchLiveWorkshopFrames().catch(() => []), fetchOwnWorkshopFrames().catch(() => [])]).then(([shared, own]) => {
      if (!alive) return;
      const seen = new Set<string>();
      registerSubmittedFrames(own);
      setMade([...own, ...shared].filter((entry) => !seen.has(entry.id) && !!seen.add(entry.id)));
    });
    return () => {
      alive = false;
    };
  }, []);
  // a maker's name is not a catalog string, so it rides as its own message
  return made.map((entry) => ({ id: entry.id, label: { id: `workshop-frame:${entry.id}`, message: entry.name } }));
}

function FrameDrawer({ current, disabled, avatar, onTry, onPick }: DrawerProps) {
  const { t, i18n } = useLingui();
  const frame = current.frame;
  const made = useWorkshopFrameEntries();
  const entries = [...FRAME_GROUPS.flatMap((g) => g.entries), ...made];
  const activeSet = entries.find((entry) => "set" in entry && holds(entry, frame));
  const tryOn = (value: SupporterAvatarFrameId | null) => (on: boolean) => onTry("frame", on ? value : undefined);
  const [gridRef, columns] = useColumns(FRAME_TILE_MIN, FRAME_GAP);
  // "No frame" leads every list
  const perPage = columns * FRAME_ROWS;
  const tiles = entries.length + 1;
  const pages = Math.max(1, Math.ceil(tiles / perPage));
  // until a page is turned, show the one that holds the equipped frame (it moves with the column count)
  const [page, setPage] = useState<number | null>(null);
  const at = entries.findIndex((entry) => holds(entry, frame));
  const shownPage = Math.min(page ?? (at < 0 ? 0 : Math.floor((at + 1) / perPage)), pages - 1);
  const first = shownPage * perPage;

  const tileFor = (entry: FrameEntry) => {
    if ("id" in entry) {
      return (
        <Item key={entry.id} active={frame === entry.id} disabled={disabled} onTry={tryOn(entry.id)} onPick={() => onPick("frame", entry.id)}>
          <FrameThumb frame={entry.id} avatar={avatar} size={68} />
          <span className="w-full truncate text-center">{i18n._(entry.label)}</span>
        </Item>
      );
    }
    const active = entry === activeSet;
    const shown = active ? frame! : entry.variants[entry.shown].id;
    return (
      <Item key={entry.set} active={active} disabled={disabled} onTry={tryOn(shown)} onPick={() => !active && onPick("frame", shown)}>
        <FrameThumb frame={shown} avatar={avatar} size={68} />
        <span className="w-full truncate text-center">{i18n._(entry.label)}</span>
      </Item>
    );
  };

  return (
    <div>
      <div ref={gridRef} className="grid gap-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {first === 0 && (
          <Item active={frame === null} disabled={disabled} onTry={tryOn(null)} onPick={() => onPick("frame", null)}>
            <FrameThumb frame={null} avatar={avatar} size={68} />
            {t`No frame`}
          </Item>
        )}
        {entries.slice(Math.max(0, first - 1), first + perPage - 1).map(tileFor)}
      </div>
      {pages > 1 && (
        <div className="mt-3 flex items-center justify-center gap-3">
          <PageTurn direction={-1} label={t`Previous page`} disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)} />
          <span className="min-w-[4ch] text-center text-[12px] tabular-nums text-osu-f1">{shownPage + 1} / {pages}</span>
          <PageTurn direction={1} label={t`Next page`} disabled={shownPage === pages - 1} onClick={() => setPage(shownPage + 1)} />
        </div>
      )}
      {frame && supporterFrameGeometry(frame).danWindow && <FrameDanPicker avatar={avatar} disabled={disabled} />}
      {frame && supporterFrameGeometry(frame).danShelf && <FrameDanPicker shelf avatar={avatar} disabled={disabled} />}
      {activeSet && "set" in activeSet && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-osu-f1">
          <span className="mr-1">{i18n._(activeSet.chips)}</span>
          {activeSet.variants.map((variant) => (
            <button
              key={variant.id}
              type="button"
              disabled={disabled}
              onPointerEnter={(event) => event.pointerType === "mouse" && onTry("frame", variant.id)}
              onPointerLeave={(event) => event.pointerType === "mouse" && onTry("frame", undefined)}
              onClick={() => onPick("frame", variant.id)}
              aria-pressed={frame === variant.id}
              className={chip(frame === variant.id)}
            >
              {variant.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* Which of the viewer's dans the Dan license shows, picked in three steps:
   the keymode, rice or LN, then the overall dan or one skillset's, each tile
   showing its badge. A pick saves at once. `shelf`: the Trophy shelf's dans
   instead, up to five, each tile numbered with its place on the shelf (they
   stand in the order picked; a second click takes one off). */
function FrameDanPicker({ avatar, disabled, shelf = false }: { avatar: string | undefined; disabled: boolean; shelf?: boolean }) {
  const { t, i18n } = useLingui();
  const [choices, setChoices] = useState<FrameDanChoices | null>(null);
  const [saving, setSaving] = useState(false);
  const [keyCount, setKeyCount] = useState<number | null>(null);
  const [family, setFamily] = useState<"rc" | "ln" | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchFrameDanChoices().then((value) => alive && setChoices(value)).catch(() => alive && setChoices({ options: [], shown: null, shelf: [] }));
    return () => {
      alive = false;
    };
  }, []);
  if (!choices) return null;
  if (choices.options.length === 0) {
    return <p className="mt-3 text-[11px] text-osu-f1">{shelf ? t`The shelf shows your dans once you have one.` : t`The card shows your dan once you have one.`}</p>;
  }
  const shown = choices.options.find((dan) => dan.key === choices.shown) ?? choices.options[0];
  const keyCounts = [...new Set(choices.options.map((dan) => dan.keyCount))];
  const kc = keyCount ?? shown.keyCount;
  const families = (["rc", "ln"] as const).filter((side) => choices.options.some((dan) => dan.keyCount === kc && dan.family === side));
  const fam = family && families.includes(family) ? family : families.includes(shown.family) && kc === shown.keyCount ? shown.family : families[0];
  const tiles = choices.options.filter((dan) => dan.keyCount === kc && dan.family === fam);

  const pickDan = (key: string) => {
    if (saving) return;
    let next: string[] = [];
    if (shelf) {
      // a full shelf takes no more until one comes off; the last one stays
      next = choices.shelf.includes(key) ? choices.shelf.filter((held) => held !== key) : [...choices.shelf, key];
      if (next.length > FRAME_SHELF_MAX || next.length === 0) return;
    } else if (key === choices.shown) return;
    setSaving(true);
    setChoices(shelf ? { ...choices, shelf: next } : { ...choices, shown: key });
    void (shelf ? saveFrameShelfChoice({ data: { shelf: next } }) : saveFrameDanChoice({ data: { dan: key } }))
      .then((value) => {
        setChoices(value);
        const userId = avatarUrlUserId(avatar);
        if (userId) forgetLiveSupporterLook(userId);
        announceFrameDanPicked();
      })
      .catch(() => {})
      .finally(() => setSaving(false));
  };
  return (
    <div className="mt-4 border-t border-white/5 pt-3">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] text-osu-f1">{shelf ? t`On the shelf` : t`Dan`}</span>
        {keyCounts.map((count) => (
          <button key={count} type="button" onClick={() => { setKeyCount(count); setFamily(null); }} aria-pressed={kc === count} className={chip(kc === count)}>
            {count}K
          </button>
        ))}
        {families.length > 1 && <span className="mx-1 h-4 w-px bg-white/10" aria-hidden />}
        {families.length > 1 && families.map((side) => (
          <button key={side} type="button" onClick={() => setFamily(side)} aria-pressed={fam === side} className={chip(fam === side)}>
            {side === "rc" ? t`Rice` : "LN"}
          </button>
        ))}
        {shelf && (
          <span className="ml-auto text-[11px] text-osu-f1">
            {choices.shelf.length >= FRAME_SHELF_MAX ? t`The shelf is full. Take one off to add another.` : t`Up to five, in the order you pick them.`}
          </span>
        )}
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))" }}>
        {tiles.map((dan) => {
          const badge = getDanImageSrc(danBareLabel(dan.label), dan.family, dan.keyCount);
          const skill = dan.skillset ? DAN_SKILLSET_META[dan.skillset] : undefined;
          return (
            <button
              key={dan.key}
              type="button"
              disabled={disabled || saving}
              onClick={() => pickDan(dan.key)}
              aria-pressed={shelf ? choices.shelf.includes(dan.key) : choices.shown === dan.key}
              className={tile(shelf ? choices.shelf.includes(dan.key) : choices.shown === dan.key)}
            >
              {shelf && choices.shelf.includes(dan.key) && (
                <span className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-osu-pink text-[10px] font-bold leading-none text-white">{choices.shelf.indexOf(dan.key) + 1}</span>
              )}
              {badge ? <img src={badge} alt="" className="h-8 w-8 object-contain" /> : <span className="h-8 w-8" />}
              <span className="w-full truncate text-center">{dan.skillset ? (skill ? i18n._(skill.labelMsg) : dan.skillset) : t`Overall`}</span>
              <span className="-mt-1 text-[10px] font-medium text-osu-f1">{frameDanName(dan.label)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PageTurn({ direction, label, disabled, onClick }: { direction: 1 | -1; label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="grid h-8 w-8 cursor-pointer place-items-center rounded-full bg-osu-b4 text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-white disabled:cursor-default disabled:opacity-35 disabled:hover:bg-osu-b4 disabled:hover:text-osu-l2"
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
        <path d={direction === 1 ? "M6 3.5 10.5 8 6 12.5" : "M10 3.5 5.5 8 10 12.5"} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

const NAME_CLASS = "min-w-0 truncate px-2 -mx-2 py-[0.3em] -my-[0.3em] text-[18px] font-black leading-none text-white";

function NameStyleDrawer({ current, disabled, username, onTry, onPick, onNameOutline }: DrawerProps) {
  const { t, i18n } = useLingui();
  const { nameStyle, nameFont, nameOutline } = current;
  // the tile a stored style belongs to (Terminal with a still cursor is Terminal's)
  const picked = nameStyle ? baseNameStyle(nameStyle) : null;
  const [tab, setTab] = useState(() => NAME_STYLE_GROUPS.find((g) => picked && g.styles.includes(picked))?.key ?? NAME_STYLE_GROUPS[0].key);
  const group = NAME_STYLE_GROUPS.find((g) => g.key === tab) ?? NAME_STYLE_GROUPS[0];
  // The tiles show a still of each style's real shader (a grid of live ones
  // would blow the WebGL budget, gl-budget.ts); the one under the pointer, or
  // else the one picked, runs live.
  const [hovered, setHovered] = useState<SupporterNameStyleId | null | undefined>(undefined);
  const tryOn = (value: SupporterNameStyleId | null) => (on: boolean) => {
    setHovered((current) => (on ? value : current === value ? undefined : current));
    onTry("nameStyle", on ? value : undefined);
  };
  const liveStyle = hovered !== undefined ? hovered : nameStyle;

  return (
    <div>
      <Chips value={tab} options={NAME_STYLE_GROUPS.map((g) => ({ value: g.key, label: i18n._(g.title) }))} onChange={setTab} />
      <div className="name-tag-grid grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
        {[null, ...group.styles].map((id) => (
          <Item key={id ?? "plain"} active={picked === id} disabled={disabled} onTry={tryOn(id)} onPick={() => onPick("nameStyle", id)} className="items-stretch">
            <span className="flex h-12 items-center justify-center overflow-hidden rounded-md bg-osu-b6 px-3">
              <SupporterStyledName nameStyle={id} nameFont={nameFont} outline={nameOutline} name={username} live={id !== null && id === liveStyle} still className={NAME_CLASS} />
            </span>
            {id ? i18n._(nameStyleLabel(id)) : t`Plain`}
          </Item>
        ))}
        <SolidColourTile current={nameStyle} nameFont={nameFont} outline={nameOutline} username={username} disabled={disabled} onTry={(value) => onTry("nameStyle", value)} onPick={(value) => onPick("nameStyle", value)} />
      </div>
      {picked === "terminal" && (
        <div className="mt-3 flex items-center gap-3 rounded-lg bg-osu-b4 px-3 py-2.5">
          <button
            type="button"
            role="switch"
            aria-checked={nameStyle !== TERMINAL_BARE}
            aria-label={t`Cursor`}
            disabled={disabled}
            onClick={() => onPick("nameStyle", nameStyle === TERMINAL_BARE ? "terminal" : TERMINAL_BARE)}
            className="relative h-5 w-9 shrink-0 cursor-pointer rounded-full disabled:cursor-default"
          >
            <span className={`absolute inset-0 rounded-full transition-colors ${nameStyle !== TERMINAL_BARE ? "bg-osu-pink" : "bg-osu-b2"}`} />
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-[left] ${nameStyle !== TERMINAL_BARE ? "left-[18px]" : "left-0.5"}`} />
          </button>
          <span className="text-[12.5px] text-osu-f1">{t`Cursor`}</span>
        </div>
      )}
      <NameOutlineSwitch outline={nameOutline} disabled={disabled} onChange={onNameOutline} />
    </div>
  );
}

const DEFAULT_OUTLINE = "ffffff";

/* An outline round the name, with any style and font: a switch, a swatch
   that opens the browser's colour picker (previewing as it moves, saved once
   it closes), and how thick the line is. */
function NameOutlineSwitch({ outline, disabled, onChange }: { outline: string | null; disabled: boolean; onChange: (outline: string | null, commit: boolean) => void }) {
  const { t } = useLingui();
  const [colour, setColour] = useState(() => `#${(outline ?? DEFAULT_OUTLINE).slice(0, 6)}`);
  const [thickness, setThickness] = useState(() => (outline ? nameOutlineThickness(outline) : NAME_OUTLINE_THICKEST));
  useEffect(() => {
    if (!outline) return;
    setColour(`#${outline.slice(0, 6)}`);
    setThickness(nameOutlineThickness(outline));
  }, [outline]);
  const value = (hex: string, level = thickness) => nameOutlineValue(hex.slice(1).toLowerCase(), level);
  const inputRef = useRef<HTMLInputElement>(null);
  const latest = useRef({ onChange, value });
  latest.current = { onChange, value };
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const commit = () => latest.current.onChange(latest.current.value(input.value), true);
    input.addEventListener("change", commit);
    return () => input.removeEventListener("change", commit);
  }, []);
  const on = outline !== null;
  // the swatch sits on the left: the browser opens its colour picker from the
  // swatch's left edge, and at the drawer's right edge it ran off the window
  return (
    <div className="mt-3 rounded-lg bg-osu-b4 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={t`Outline`}
          disabled={disabled}
          onClick={() => onChange(on ? null : value(colour), true)}
          className="relative h-5 w-9 shrink-0 cursor-pointer rounded-full disabled:cursor-default"
        >
          <span className={`absolute inset-0 rounded-full transition-colors ${on ? "bg-osu-pink" : "bg-osu-b2"}`} />
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-[left] ${on ? "left-[18px]" : "left-0.5"}`} />
        </button>
        <label className={`relative h-6 w-6 shrink-0 rounded-full ring-2 ring-white/70 ${disabled ? "opacity-50" : "cursor-pointer"}`} style={{ background: colour }} title={t`Pick a colour`}>
          <input
            ref={inputRef}
            type="color"
            value={colour}
            disabled={disabled}
            aria-label={t`Pick an outline colour`}
            onChange={(event) => {
              setColour(event.target.value);
              onChange(value(event.target.value), false);
            }}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </label>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(on ? null : value(colour), true)}
          className="min-w-0 flex-1 cursor-pointer text-left disabled:cursor-default"
        >
          <span className="block text-[13px] font-semibold text-white">{t`Outline`}</span>
          <span className="block text-[11.5px] text-osu-f1">{t`A line round your name in a colour of your choosing.`}</span>
        </button>
      </div>
      {on && (
        <label className="mt-2.5 flex items-center gap-3">
          <span className="shrink-0 text-[11.5px] font-semibold text-osu-f1">{t`Thickness`}</span>
          <input
            type="range"
            min={1}
            max={NAME_OUTLINE_THICKEST}
            step={1}
            value={thickness}
            disabled={disabled}
            onChange={(event) => {
              const level = Number(event.currentTarget.value);
              setThickness(level);
              onChange(value(colour, level), true);
            }}
            className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-osu-b3/50 accent-osu-pink disabled:cursor-default"
          />
        </label>
      )}
    </div>
  );
}

/* The name in one flat colour of the supporter's choosing. Clicking the tile
   wears the last colour; the swatch opens the browser's colour picker, which
   previews as it moves and saves once it closes. */
function SolidColourTile({ current, nameFont, outline, username, disabled, onTry, onPick }: {
  current: SupporterNameStyleId | null;
  nameFont: SupporterNameFontId | null;
  outline: string | null;
  username: string;
  disabled?: boolean;
  onTry: (value: SupporterNameStyleId | undefined) => void;
  onPick: (value: SupporterNameStyleId) => void;
}) {
  const { t } = useLingui();
  const [colour, setColour] = useState(() => (isSolidNameStyle(current) ? solidNameColour(current) : DEFAULT_SOLID_COLOUR));
  useEffect(() => {
    if (isSolidNameStyle(current)) setColour(solidNameColour(current));
  }, [current]);
  const inputRef = useRef<HTMLInputElement>(null);
  const latest = useRef({ onPick, onTry });
  latest.current = { onPick, onTry };
  // the native "change" fires once the picker closes: that is when it saves
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const commit = () => {
      latest.current.onTry(undefined);
      latest.current.onPick(solidNameStyle(input.value));
    };
    input.addEventListener("change", commit);
    return () => input.removeEventListener("change", commit);
  }, []);
  const style = solidNameStyle(colour);
  return (
    <div className="relative">
      <Item active={isSolidNameStyle(current)} disabled={disabled} onTry={(on) => onTry(on ? style : undefined)} onPick={() => onPick(style)} className="w-full items-stretch">
        <span className="flex h-12 items-center justify-center overflow-hidden rounded-md bg-osu-b6 px-3">
          <SupporterStyledName nameStyle={style} nameFont={nameFont} outline={outline} name={username} className={NAME_CLASS} />
        </span>
        {t`Solid colour`}
      </Item>
      <label className={`absolute bottom-1.5 right-2 h-4 w-4 rounded-full ring-2 ring-white/70 ${disabled ? "" : "cursor-pointer"}`} style={{ background: colour }} title={t`Pick a colour`}>
        <input
          ref={inputRef}
          type="color"
          value={colour}
          disabled={disabled}
          aria-label={t`Pick a colour`}
          onChange={(event) => {
            setColour(event.target.value);
            onTry(solidNameStyle(event.target.value));
          }}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}

function FontDrawer({ current, disabled, username, onTry, onPick }: DrawerProps) {
  const { t, i18n } = useLingui();
  const nameFont = current.nameFont;
  const [tab, setTab] = useState(() => NAME_FONT_GROUPS.find((g) => nameFont && g.fonts.includes(nameFont))?.key ?? NAME_FONT_GROUPS[0].key);
  const group = NAME_FONT_GROUPS.find((g) => g.key === tab) ?? NAME_FONT_GROUPS[0];
  const tryOn = (value: SupporterNameFontId | null) => (on: boolean) => onTry("nameFont", on ? value : undefined);
  return (
    <div>
      <Chips value={tab} options={NAME_FONT_GROUPS.map((g) => ({ value: g.key, label: i18n._(g.title) }))} onChange={setTab} />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
        {[null, ...group.fonts].map((id) => (
          <Item key={id ?? "default"} active={nameFont === id} disabled={disabled} onTry={tryOn(id)} onPick={() => onPick("nameFont", id)} className="items-stretch">
            <span className="flex h-12 items-center justify-center overflow-hidden rounded-md bg-osu-b6 px-3">
              <span className={`truncate px-[0.35em] -mx-[0.35em] py-[0.3em] -my-[0.3em] text-[20px] font-bold leading-none text-white ${id ? `name-font--${id}` : ""}`}>{username}</span>
            </span>
            {id ? i18n._(SUPPORTER_NAME_FONT_LABELS[id]) : t`Default`}
          </Item>
        ))}
      </div>
    </div>
  );
}

/* The first image among clipboard or dropped items, as a file to upload. */
function imageFileOf(items: DataTransferItemList | null | undefined): File | null {
  for (const item of Array.from(items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) return item.getAsFile();
  }
  return null;
}

function MotifDrawer({ current, disabled, custom, canUpload, onTry, onPick, onUpload, onEditCustom }: DrawerProps) {
  const { t } = useLingui();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // The Paste tile's own label: what to do, or why nothing came.
  const [pasteHint, setPasteHint] = useState<"press" | "empty" | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showHint = (hint: "press" | "empty") => {
    setPasteHint(hint);
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setPasteHint(null), 6000);
  };
  useEffect(() => () => clearTimeout(hintTimer.current), []);
  const pasteKey = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform) ? "⌘V" : "Ctrl+V";
  const look = current.look;
  const tryOn = (value: SlotValue) => (on: boolean) => onTry("motif", on ? value : undefined);

  // While the drawer is open, an image pasted anywhere on the page (Ctrl+V) goes up as the card art.
  const latestUpload = useRef(onUpload);
  latestUpload.current = onUpload;
  useEffect(() => {
    if (!canUpload || disabled) return;
    const onPaste = (event: ClipboardEvent) => {
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
      const file = imageFileOf(event.clipboardData?.items);
      if (!file) return;
      event.preventDefault();
      setPasteHint(null);
      latestUpload.current(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [canUpload, disabled]);

  /* The Paste tile reads the clipboard itself where the browser lets a page do
     that; most don't on a click, so the tile then asks for the key, which
     always works while the drawer is open. */
  const pasteFromClipboard = async () => {
    showHint("press");
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((kind) => kind.startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        setPasteHint(null);
        onUpload(new File([blob], `pasted.${type.slice(6)}`, { type }));
        return;
      }
      showHint("empty");
    } catch {
      // not allowed here: the tile keeps asking for the key
    }
  };

  return (
    <div
      className={`rounded-xl transition-shadow ${dragging ? "ring-2 ring-osu-pink/70" : ""}`}
      onDragOver={(event) => {
        if (!canUpload || disabled || !Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        setDragging(false);
        const file = imageFileOf(event.dataTransfer.items);
        if (!canUpload || disabled || !file) return;
        event.preventDefault();
        onUpload(file);
      }}
    >
      <p className="mb-3 text-[12px] text-osu-f1">
        {canUpload
          ? t`An image of your own floats on every copy of your card, in anyone's collection. Paste one with ${pasteKey}, drop it here or upload it.`
          : t`An image of your own floats on every copy of your card, in anyone's collection.`}
      </p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
        <Item active={look.motif === "none"} disabled={disabled} onTry={tryOn(null)} onPick={() => onPick("motif", null)}>
          <span className="grid h-[68px] w-full place-items-center rounded-md bg-osu-b6 text-osu-f1">
            <NoArt className="h-6 w-6" />
          </span>
          {t`No art`}
        </Item>
        {custom && (
          <div className="relative">
            <Item active={look.motif === "custom"} disabled={disabled} onTry={tryOn("custom")} onPick={() => onPick("motif", "custom")} className="w-full">
              <span className="block h-[68px] w-full overflow-hidden rounded-md bg-osu-b6">
                <img src={custom.url} alt="" className="h-full w-full object-cover" />
              </span>
              {t`Your image`}
            </Item>
            <button
              type="button"
              disabled={disabled}
              onClick={onEditCustom}
              aria-label={t`Adjust your image`}
              title={t`Adjust your image`}
              className="absolute bottom-[30px] right-1.5 grid h-7 w-7 cursor-pointer place-items-center rounded-full bg-black/70 text-white shadow transition hover:bg-osu-pink"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
                <path d="m13.5 6.5 4 4" />
              </svg>
            </button>
          </div>
        )}
        {canUpload && (
          <button type="button" disabled={disabled} onClick={() => void pasteFromClipboard()} className={tile(false)}>
            <span className={`grid h-[68px] w-full place-items-center rounded-md border border-dashed transition-colors ${pasteHint === "press" ? "border-osu-pink/70 bg-osu-pink/10" : "border-white/15"}`}>
              {pasteHint === "press"
                ? <kbd className="animate-pulse rounded-md bg-white/10 px-2 py-1 font-sans text-[13px] font-semibold text-white">{pasteKey}</kbd>
                : <PasteIcon className="h-6 w-6" />}
            </span>
            <span className="w-full truncate text-center">{pasteHint === "press" ? t`Press ${pasteKey}` : pasteHint === "empty" ? t`No image copied` : t`Paste image`}</span>
          </button>
        )}
        {canUpload && (
          <button type="button" disabled={disabled} onClick={() => fileRef.current?.click()} className={tile(false)}>
            <span className="grid h-[68px] w-full place-items-center rounded-md border border-dashed border-white/15">
              <UploadIcon className="h-6 w-6" />
            </span>
            {custom ? t`Upload another` : t`Upload image`}
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onUpload(file);
          }}
        />
      </div>
    </div>
  );
}

function FoilDrawer({ current, disabled, onTry, onPick }: DrawerProps) {
  const { t, i18n } = useLingui();
  // Only the foil under the pointer moves, like the theme drawer.
  const [moving, setMoving] = useState<SupporterFoilId | null>(null);
  const tryOn = (value: SupporterFoilId | null) => (on: boolean) => {
    setMoving(on ? value : null);
    onTry("foil", on ? value : undefined);
  };
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
      <Item active={current.look.foil === "none"} disabled={disabled} onTry={tryOn(null)} onPick={() => onPick("foil", null)}>
        <span className="grid aspect-[5/7] w-full place-items-center rounded-[6px] bg-osu-b6 text-osu-f1">
          <NoArt className="h-6 w-6" />
        </span>
        <span className="w-full truncate text-center">{t`No foil`}</span>
      </Item>
      {SUPPORTER_FOILS.map((id) => (
        <Item key={id} active={current.look.foil === id} disabled={disabled} onTry={tryOn(id)} onPick={() => onPick("foil", id)}>
          <FoilCard foil={id} still={moving !== id} className="aspect-[5/7] w-full" />
          <span className="w-full truncate text-center">{i18n._(SUPPORTER_FOIL_LABELS[id])}</span>
        </Item>
      ))}
    </div>
  );
}

function SleeveDrawer({ current, disabled, onTry, onPick }: DrawerProps) {
  const { t, i18n } = useLingui();
  const tryOn = (value: SupporterCardSleeveId | null) => (on: boolean) => onTry("sleeve", on ? value : undefined);
  return (
    <div>
      <p className="mb-3 text-[12px] text-osu-f1">{t`The case your cards sit in whenever you lift one out of your collection or turn one over in a pack. Anyone opening a card from your shelf sees it too.`}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
        <Item active={current.pack.sleeve === null} disabled={disabled} onTry={tryOn(null)} onPick={() => onPick("sleeve", null)}>
          <span className="grid aspect-[5/7] w-full place-items-center rounded-[6px] bg-osu-b6 text-osu-f1">
            <NoArt className="h-6 w-6" />
          </span>
          <span className="w-full truncate text-center">{t`No sleeve`}</span>
        </Item>
        {SUPPORTER_CARD_SLEEVES.map((id) => (
          <Item key={id} active={current.pack.sleeve === id} disabled={disabled} onTry={tryOn(id)} onPick={() => onPick("sleeve", id)}>
            <span className="block w-full px-1.5 pt-1.5"><SleeveCard sleeve={id} className="aspect-[5/7] w-full" /></span>
            <span className="w-full truncate text-center">{i18n._(SUPPORTER_CARD_SLEEVE_LABELS[id])}</span>
          </Item>
        ))}
      </div>
    </div>
  );
}

function BinderDrawer({ current, disabled, onTry, onPick }: DrawerProps) {
  const { t, i18n } = useLingui();
  const tryOn = (value: SupporterBinderId | null) => (on: boolean) => onTry("binder", on ? value : undefined);
  return (
    <div>
      <p className="mb-3 text-[12px] text-osu-f1">{t`Your collection as binder pages, three by three in plastic pockets, for you and anyone visiting your shelf.`}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
        <Item active={current.pack.binder === null} disabled={disabled} onTry={tryOn(null)} onPick={() => onPick("binder", null)}>
          <span className="grid h-[76px] w-full place-items-center rounded-md bg-osu-b6 text-osu-f1">
            <NoArt className="h-6 w-6" />
          </span>
          {t`No binder`}
        </Item>
        {SUPPORTER_BINDERS.map((id) => (
          <Item key={id} active={current.pack.binder === id} disabled={disabled} onTry={tryOn(id)} onPick={() => onPick("binder", id)}>
            <span className="grid h-[76px] w-full place-items-center"><BinderBook binder={id} className="h-[70px] w-[54px]" /></span>
            {i18n._(SUPPORTER_BINDER_LABELS[id])}
          </Item>
        ))}
      </div>
    </div>
  );
}

function WrapperDrawer({ current, disabled, onTry, onPick }: DrawerProps) {
  const { t, i18n } = useLingui();
  useWrapperArtVersion();
  const tryOn = (value: SupporterWrapperId | null) => (on: boolean) => onTry("wrapper", on ? value : undefined);
  return (
    <div>
      <p className="mb-3 text-[12px] text-osu-f1">{t`What your packs are printed on, every pack type alike. The pack's name and terms stay on it.`}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
        <Item active={current.pack.wrapper === null} disabled={disabled} onTry={tryOn(null)} onPick={() => onPick("wrapper", null)}>
          <img src={wrapperThumb(null)} alt="" className="aspect-[3/5] w-full rounded-[5px] object-cover" />
          <span className="w-full truncate text-center">{t`Standard foil`}</span>
        </Item>
        {SUPPORTER_WRAPPERS.map((id) => (
          <Item key={id} active={current.pack.wrapper === id} disabled={disabled} onTry={tryOn(id)} onPick={() => onPick("wrapper", id)}>
            <img src={wrapperThumb(id)} alt="" className="aspect-[3/5] w-full rounded-[5px] object-cover" />
            <span className="w-full truncate text-center">{i18n._(SUPPORTER_WRAPPER_LABELS[id])}</span>
          </Item>
        ))}
      </div>
    </div>
  );
}

function BladeDrawer({ current, disabled, onTry, onPick }: DrawerProps) {
  const { t, i18n } = useLingui();
  // Only the blade under the pointer slashes, like the theme drawer.
  const [moving, setMoving] = useState<SupporterBladeId | null | undefined>(undefined);
  const tryOn = (value: SupporterBladeId | null) => (on: boolean) => {
    if (on) warmBladeSounds(bladeLook(value).sound);
    setMoving(on ? value : undefined);
    onTry("blade", on ? value : undefined);
  };
  // Picking one plays how its pack gives, so the sound is part of the choice.
  const pick = (value: SupporterBladeId | null) => () => {
    playBladeRip(value, bladeLook(value).sound);
    onPick("blade", value);
  };
  return (
    <div>
      <p className="mb-3 text-[12px] text-osu-f1">{t`How your packs open: the slash you cut them with, its sparks and its sound, and what the pack does as it gives.`}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2">
        <Item active={current.pack.blade === null} disabled={disabled} onTry={tryOn(null)} onPick={pick(null)}>
          <BladeSwatch blade={null} live={moving === null} className="h-[64px] w-full rounded-md bg-osu-b6" />
          <span className="w-full truncate text-center">{t`Standard blade`}</span>
        </Item>
        {SUPPORTER_BLADES.map((id) => (
          <Item key={id} active={current.pack.blade === id} disabled={disabled} onTry={tryOn(id)} onPick={pick(id)}>
            <BladeSwatch blade={id} live={moving === id} className="h-[64px] w-full rounded-md bg-osu-b6" />
            <span className="w-full truncate text-center">{i18n._(SUPPORTER_BLADE_LABELS[id])}</span>
          </Item>
        ))}
      </div>
    </div>
  );
}

/* "No theme": the site's own colours, whichever hue the visitor picked, so a wheel rather than any one. */
function SiteColours({ className }: { className: string }) {
  return <span className={`rounded-full ${className}`} style={{ background: "conic-gradient(#ff66ab, #ffcc22, #88b300, #66ccff, #8866ee, #ff66ab)" }} />;
}

/* Angle brackets around a drop of paint: a theme written as code. */
function OwnThemeIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 28 28" className={className} aria-hidden>
      <path d="M8.5 8 3.5 14l5 6M19.5 8l5 6-5 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 9.2c-1.9 2.6-3 4.3-3 5.7a3 3 0 0 0 6 0c0-1.4-1.1-3.1-3-5.7Z" fill="currentColor" opacity=".85" />
    </svg>
  );
}

function ThemeDrawer({ current, disabled, avatar, username, canUpload, onTry, onPick, onThemeOptions, onWearOwnTheme }: DrawerProps) {
  const { t, i18n } = useLingui();
  /* The viewer's own themes (the workshop's), live ones only, next to the
     built-ins so they are put on from the same place. */
  const own = useOwnThemes(canUpload);
  const ownLive = (own?.themes ?? []).filter((theme) => theme.state === "live" && theme.liveRevision != null);
  // a worn own theme leaves no built-in picked (the page reads it back as none)
  const wornOwn = current.theme === null ? own?.worn?.themeId ?? null : null;
  const wearOwn = (themeId: number | null) => {
    void onWearOwnTheme(themeId).then(() => {
      if (ownThemes) setOwnThemes({ ...ownThemes, worn: themeId === null ? null : { themeId, rows: false } });
    });
  };
  /* Only the theme under the pointer moves; the rest hold a still frame. Every
     live swatch is a full shader pass plus a copy off the GPU each frame, and
     twenty of them at once is what made this page crawl. */
  const [moving, setMoving] = useState<SupporterProfileThemeId | null>(null);
  /* A theme goes live only once the pointer rests on it: each one compiles its
     shader and uploads its art twice (the swatch and the stage), and sweeping
     across a row started all of that for every tile passed. */
  const hoverTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  /* Leaving waits too, so moving from one tile to the next goes straight
     to the next theme instead of flashing the picked one in between. */
  const tryOn = (value: SupporterProfileThemeId | null) => (on: boolean) => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      setMoving(on ? value : null);
      onTry("theme", on ? value : undefined);
    }, on ? 120 : 160);
  };
  return (
    <div>
      <p className="mb-3 text-[12px] text-osu-f1">{t`Your whole profile takes on the theme: its colours, and a living backdrop behind the page.`}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2">
        <Item active={current.theme === null && wornOwn === null} disabled={disabled} onTry={tryOn(null)} onPick={() => (wornOwn !== null ? wearOwn(null) : onPick("theme", null))} className="items-stretch">
          <span className="grid aspect-[16/10] w-full place-items-center rounded-md bg-osu-b6">
            <SiteColours className="h-6 w-6" />
          </span>
          {t`Site colours`}
        </Item>
        {SUPPORTER_PROFILE_THEMES.map((id) => (
          <Item key={id} active={current.theme === id} disabled={disabled} onTry={tryOn(id)} onPick={() => onPick("theme", id)} className="items-stretch">
            <ProfileThemeSwatch theme={id} still={moving !== id} className="aspect-[16/10] w-full rounded-md" />
            <span className="w-full truncate text-center">{i18n._(SUPPORTER_PROFILE_THEME_LABELS[id])}</span>
          </Item>
        ))}
        {ownLive.map((theme) => (
          <Item key={`own-${theme.id}`} active={wornOwn === theme.id} disabled={disabled} onTry={() => {}} onPick={() => wearOwn(theme.id)} className="items-stretch">
            {theme.stillUrl ? (
              <img src={theme.stillUrl} alt="" onError={hideBrokenImage} className="aspect-[16/10] w-full rounded-md bg-osu-b6 object-cover" draggable={false} />
            ) : (
              <span className="grid aspect-[16/10] w-full place-items-center rounded-md bg-osu-b6"><OwnThemeIcon className="h-6 w-6 text-osu-pink-light" /></span>
            )}
            <span className="w-full truncate text-center">{theme.name}</span>
          </Item>
        ))}
        <Link to="/workshop/themes" className={`${tile(false)} items-stretch`}>
          <span className="grid aspect-[16/10] w-full place-items-center rounded-md border border-dashed border-white/15 bg-osu-b6">
            <OwnThemeIcon className="h-7 w-7 text-osu-pink-light" />
          </span>
          <span className="w-full truncate text-center">{t`Make your own`}</span>
        </Link>
      </div>
      {current.theme === "highway" && (
        <>
          <ThemeSwitch
            on={!current.themeOptions.stockNotes}
            disabled={disabled}
            onToggle={() => onThemeOptions({ ...current.themeOptions, stockNotes: current.themeOptions.stockNotes ? undefined : true })}
            title={t`My skin's notes`}
            body={t`The highway plays the notes of your replay skin and takes their colour. Off, it keeps its own notes and blue.`}
          />
          <ThemeSwitch
            on={!!current.themeOptions.charts}
            disabled={disabled}
            onToggle={() => onThemeOptions({ ...current.themeOptions, charts: current.themeOptions.charts ? undefined : true })}
            title={t`Play my top plays`}
            body={t`The highway streams a section of your best play in your main keymode, instead of random notes.`}
          />
        </>
      )}
      {current.theme !== null && (
        <ThemeSwitch
          on={!!current.themeOptions.rows}
          disabled={disabled}
          onToggle={() => onThemeOptions({ ...current.themeOptions, rows: current.themeOptions.rows ? undefined : true })}
          title={t`Banner in lists`}
          body={t`A strip of the theme behind your row on rankings and leaderboards.`}
          preview={<RowBannerPreview theme={current.theme} on={!!current.themeOptions.rows} avatar={avatar} username={username} nameStyle={current.nameStyle} nameFont={current.nameFont} nameOutline={current.nameOutline} />}
        />
      )}
      {current.theme !== null && (
        <ThemeSwitch
          on={!!current.themeOptions.hideCover}
          disabled={disabled}
          onToggle={() => onThemeOptions({ ...current.themeOptions, hideCover: current.themeOptions.hideCover ? undefined : true })}
          title={t`Hide my osu! banner`}
          body={t`Only the theme shows behind your profile header, without your osu! banner.`}
        />
      )}
    </div>
  );
}

/* A ranking row as the viewer's own would show it, the theme's strip fading in
   behind its right side when the banner is on. */
function RowBannerPreview({ theme, on, avatar, username, nameStyle, nameFont, nameOutline = null }: {
  nameOutline?: string | null;
  theme: SupporterProfileThemeId;
  on: boolean;
  avatar: string | undefined;
  username: string;
  nameStyle: SupporterNameStyleId | null;
  nameFont: SupporterNameFontId | null;
}) {
  return (
    <span className="relative flex h-11 items-center gap-3 overflow-hidden rounded-lg bg-osu-b5 px-3 text-[12.5px]">
      <span aria-hidden className={`absolute inset-0 transition-opacity duration-300 ${on ? "opacity-100" : "opacity-0"}`} style={supporterRowBackground(theme, "strip")} />
      <span className="relative w-7 shrink-0 font-semibold text-osu-f1">#12</span>
      {avatar ? <img src={avatar} alt="" className="relative h-7 w-7 shrink-0 rounded-full bg-osu-b3 object-cover" /> : <span className="relative h-7 w-7 shrink-0 rounded-full bg-osu-b3" />}
      <SupporterStyledName nameStyle={nameStyle} nameFont={nameFont} outline={nameOutline} name={username} className="relative min-w-0 truncate text-[13.5px] font-semibold text-white" />
      <span className="relative ml-auto shrink-0 font-semibold text-osu-l2">12,345pp</span>
    </span>
  );
}

/* One of a theme's own switches under the theme grid, with a picture of what it does when it has one. */
function ThemeSwitch({ on, disabled, onToggle, title, body, preview }: { on: boolean; disabled: boolean; onToggle: () => void; title: string; body: string; preview?: ReactNode }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onToggle}
      className="mt-3 block w-full cursor-pointer rounded-lg bg-osu-b4 px-3 py-2.5 text-left transition-colors hover:bg-osu-b3 disabled:cursor-default"
    >
      <span className="flex items-center gap-3">
        <span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-osu-pink" : "bg-osu-b2"}`}>
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-[left] ${on ? "left-[18px]" : "left-0.5"}`} />
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-white">{title}</span>
          <span className="block text-[11px] text-osu-f1">{body}</span>
        </span>
      </span>
      {preview ? <span className="mt-2.5 block">{preview}</span> : null}
    </button>
  );
}
