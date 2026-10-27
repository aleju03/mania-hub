import { Fragment, memo, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";

import {
  SUPPORTER_MOTIFS,
  type SupporterMotifId,
} from "../../lib/supporter-card-looks";
import { SUPPORTER_FOIL_LABELS, SUPPORTER_FOILS, type SupporterFoilId } from "../../lib/supporter-foils";
import {
  FRAMED_AVATAR_RADIUS,
  framedAvatarStyle,
  supporterFrameGeometry,
  type SupporterAvatarFrameId,
} from "../../lib/supporter-avatar-frames";
import { supporterMotifPath } from "../../lib/supporter-motif-art";
import { SUPPORTER_NAME_FONT_LABELS, type SupporterNameFontId } from "../../lib/supporter-name-fonts";
import { SUPPORTER_NAME_STYLE_LABELS, type SupporterNameStyleId } from "../../lib/supporter-name-styles";
import { SupporterStyledName } from "./SupporterNameStyle";
import { announceFrameDanPicked, frameDanName, SupporterAvatarFrame } from "../player/SupporterAvatarFrame";
import { danBareLabel, getDanImageSrc } from "../../lib/dan-images";
import { DAN_SKILLSET_META } from "../../lib/skill-axes";
import { fetchFrameDanChoices, saveFrameDanChoice, type FrameDanChoices } from "../../lib/supporter-look-settings";
import { forgetLiveSupporterLook } from "../../lib/live-backend";
import { avatarUrlUserId } from "../ui/Avatar";
import { CheckBadge, LockIcon, UploadIcon } from "./LoadoutIcons";
import { FoilPreview } from "./FoilPreview";
import { DEFAULT_PACK_ART_STYLE, getCachedPackFrontCanvas } from "../packs/packArt";
import { BladeSwatch } from "../packs/BladeSwatch";
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
import { SUPPORTER_PROFILE_THEME_LABELS, SUPPORTER_PROFILE_THEMES, type SupporterProfileThemeId } from "../../lib/supporter-profile-themes";
import {
  FRAME_GROUPS,
  FRAME_NAMES,
  MOTIF_LABELS,
  NAME_FONT_GROUPS,
  NAME_STYLE_GROUPS,
  SLOT_IDS,
  PACK_SLOT_IDS,
  SLOT_LABELS,
  slotValue,
  type FrameEntry,
  type Loadout,
  type SlotId,
  type SlotValue,
} from "./loadout";

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
  const [left, top, width, height] = frame ? supporterFrameGeometry(frame).box : [0, 0, 1, 1];
  // fit the art and the avatar together: a frame's canvas need not contain the avatar (a hat sits above it)
  const minX = Math.min(left, 0), minY = Math.min(top, 0);
  const spanX = Math.max(left + width, 1) - minX, spanY = Math.max(top + height, 1) - minY;
  const scale = size / Math.max(spanX, spanY, 1.6);
  const avatarLeft = (size - spanX * scale) / 2 - minX * scale;
  const avatarTop = (size - spanY * scale) / 2 - minY * scale;
  return (
    <span className="relative block" style={{ width: size, height: size }}>
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

/* --- Slot rows ----------------------------------------------------------- */

function useSlotName() {
  const { t, i18n } = useLingui();
  return (slot: SlotId, value: SlotValue): string => {
    if (slot === "theme") return value ? i18n._(SUPPORTER_PROFILE_THEME_LABELS[value as SupporterProfileThemeId]) : t`Site colours`;
    if (slot === "frame") {
      if (!value) return t`No frame`;
      const name = FRAME_NAMES.get(value as SupporterAvatarFrameId);
      return name ? `${i18n._(name.label)}${name.variant ? ` ${name.variant}` : ""}` : value;
    }
    if (slot === "nameStyle") return value ? i18n._(SUPPORTER_NAME_STYLE_LABELS[value as SupporterNameStyleId]) : t`Plain`;
    if (slot === "nameFont") return value ? i18n._(SUPPORTER_NAME_FONT_LABELS[value as SupporterNameFontId]) : t`Default`;
    if (slot === "motif") return value === null ? t`No art` : value === "custom" ? t`Your image` : i18n._(MOTIF_LABELS[value as SupporterMotifId]);
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
  if (slot === "theme") {
    return loadout.theme
      ? <ProfileThemeSwatch key={loadout.theme} theme={loadout.theme} still className="h-12 w-12" />
      : <SiteColours className="h-5 w-5" />;
  }
  if (slot === "frame") return <FrameThumb frame={loadout.frame} avatar={avatar} size={40} />;
  if (slot === "nameStyle") {
    return <SupporterStyledName nameStyle={loadout.nameStyle} nameFont={loadout.nameFont} name="Aa" className="p-1 -m-1 text-[19px] font-black leading-none text-white" />;
  }
  if (slot === "nameFont") {
    return <span className={`text-[19px] font-bold leading-none text-white ${loadout.nameFont ? `name-font--${loadout.nameFont}` : ""}`}>Aa</span>;
  }
  if (slot === "motif") {
    if (loadout.look.motif === "none") return <NoArt className="h-5 w-5" />;
    const src = loadout.look.motif === "custom" ? loadout.look.url : supporterMotifPath(loadout.look.motif);
    return <img src={src} alt="" className="h-8 w-8 rounded-sm object-contain" />;
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
  wrapperThumbs.set(key, url);
  return url;
}

export function LoadoutSlots({ shown, open, onOpen, locks, onToggleLock, spinning, trying, avatar }: {
  /** What the stage shows, so the slots read the same as it, reels included. */
  shown: Loadout;
  open: SlotId;
  onOpen: (slot: SlotId) => void;
  locks: ReadonlySet<SlotId>;
  onToggleLock: (slot: SlotId) => void;
  spinning: boolean;
  /** The slot an item is being tried on in, so its name reads as a preview. */
  trying: SlotId | null;
  avatar: string | undefined;
}) {
  const { t, i18n } = useLingui();
  const slotName = useSlotName();
  const reduced = useReducedMotion();

  return (
    <div className="space-y-1">
      {SLOT_IDS.map((slot) => {
        const value = slotValue(shown, slot);
        const locked = locks.has(slot);
        const active = open === slot;
        return (
          <Fragment key={slot}>
          {slot === PACK_SLOT_IDS[0] && (
            <div className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-osu-f1">{t`Packs`}</div>
          )}
          <div className={`flex items-stretch rounded-xl transition-colors ${active ? "bg-osu-b4" : "hover:bg-osu-b4/60"}`}>
            <button
              type="button"
              onClick={() => onOpen(slot)}
              aria-expanded={active}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2 pl-2 pr-1 text-left"
            >
              <span className={`relative grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-osu-b6 ${active ? "ring-1 ring-osu-pink" : ""}`}>
                <SlotThumb slot={slot} loadout={shown} avatar={avatar} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-osu-f1">{i18n._(SLOT_LABELS[slot])}</span>
                <span className="relative block h-[20px] overflow-hidden">
                  <AnimatePresence initial={false} mode="popLayout">
                    <motion.span
                      key={String(value)}
                      initial={reduced ? false : { y: spinning ? -18 : -10, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      exit={reduced ? undefined : { y: spinning ? 18 : 10, opacity: 0 }}
                      transition={{ duration: spinning ? 0.07 : 0.16, ease: "easeOut" }}
                      className={`block truncate text-[15px] font-semibold leading-[20px] ${trying === slot ? "text-osu-pink-light" : "text-white"}`}
                    >
                      {slotName(slot, value)}
                    </motion.span>
                  </AnimatePresence>
                </span>
              </span>
              <svg viewBox="0 0 16 16" className={`h-4 w-4 shrink-0 text-osu-f1 transition-transform ${active ? "rotate-90 text-white" : ""}`} aria-hidden>
                <path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => onToggleLock(slot)}
              aria-pressed={locked}
              aria-label={locked ? t`Unlock for rolls` : t`Lock for rolls`}
              title={locked ? t`Unlock for rolls` : t`Lock for rolls`}
              className={`grid w-10 shrink-0 cursor-pointer place-items-center rounded-r-xl transition-colors ${locked ? "text-osu-pink" : "text-osu-f1/60 hover:text-white"}`}
            >
              <LockIcon locked={locked} className="h-[18px] w-[18px]" />
            </button>
          </div>
          </Fragment>
        );
      })}
    </div>
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

const ALL_FRAMES = "all";
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

/* Every frame, three rows at a time; the theme chips narrow it down. */
function FrameDrawer({ current, disabled, avatar, onTry, onPick }: DrawerProps) {
  const { t, i18n } = useLingui();
  const frame = current.frame;
  const [tab, setTab] = useState(ALL_FRAMES);
  const entries = tab === ALL_FRAMES ? FRAME_GROUPS.flatMap((g) => g.entries) : (FRAME_GROUPS.find((g) => g.key === tab) ?? FRAME_GROUPS[0]).entries;
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
  const pick = (key: string) => {
    setTab(key);
    setPage(0);
  };

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
      <Chips
        value={tab}
        options={[
          { value: ALL_FRAMES, label: t`All`, count: FRAME_GROUPS.reduce((sum, g) => sum + g.entries.length, 0) },
          ...FRAME_GROUPS.map((g) => ({ value: g.key, label: i18n._(g.title), count: g.entries.length })),
        ]}
        onChange={pick}
        scroll
      />
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
   showing its badge. A pick saves at once. */
function FrameDanPicker({ avatar, disabled }: { avatar: string | undefined; disabled: boolean }) {
  const { t, i18n } = useLingui();
  const [choices, setChoices] = useState<FrameDanChoices | null>(null);
  const [saving, setSaving] = useState(false);
  const [keyCount, setKeyCount] = useState<number | null>(null);
  const [family, setFamily] = useState<"rc" | "ln" | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchFrameDanChoices().then((value) => alive && setChoices(value)).catch(() => alive && setChoices({ options: [], shown: null }));
    return () => {
      alive = false;
    };
  }, []);
  if (!choices) return null;
  if (choices.options.length === 0) {
    return <p className="mt-3 text-[11px] text-osu-f1">{t`The card shows your dan once you have one.`}</p>;
  }
  const shown = choices.options.find((dan) => dan.key === choices.shown) ?? choices.options[0];
  const keyCounts = [...new Set(choices.options.map((dan) => dan.keyCount))];
  const kc = keyCount ?? shown.keyCount;
  const families = (["rc", "ln"] as const).filter((side) => choices.options.some((dan) => dan.keyCount === kc && dan.family === side));
  const fam = family && families.includes(family) ? family : families.includes(shown.family) && kc === shown.keyCount ? shown.family : families[0];
  const tiles = choices.options.filter((dan) => dan.keyCount === kc && dan.family === fam);

  const pickDan = (key: string) => {
    if (saving || key === choices.shown) return;
    setSaving(true);
    setChoices({ ...choices, shown: key });
    void saveFrameDanChoice({ data: { dan: key } })
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
        <span className="mr-1 text-[11px] text-osu-f1">{t`Dan`}</span>
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
              aria-pressed={choices.shown === dan.key}
              className={tile(choices.shown === dan.key)}
            >
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

function NameStyleDrawer({ current, disabled, username, onTry, onPick }: DrawerProps) {
  const { t, i18n } = useLingui();
  const { nameStyle, nameFont } = current;
  const [tab, setTab] = useState(() => NAME_STYLE_GROUPS.find((g) => nameStyle && g.styles.includes(nameStyle))?.key ?? NAME_STYLE_GROUPS[0].key);
  const group = NAME_STYLE_GROUPS.find((g) => g.key === tab) ?? NAME_STYLE_GROUPS[0];
  const tryOn = (value: SupporterNameStyleId | null) => (on: boolean) => onTry("nameStyle", on ? value : undefined);

  return (
    <div>
      <Chips value={tab} options={NAME_STYLE_GROUPS.map((g) => ({ value: g.key, label: i18n._(g.title) }))} onChange={setTab} />
      <div className="name-tag-grid grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
        {[null, ...group.styles].map((id) => (
          <Item key={id ?? "plain"} active={nameStyle === id} disabled={disabled} onTry={tryOn(id)} onPick={() => onPick("nameStyle", id)} className="items-stretch">
            <span className="flex h-12 items-center justify-center overflow-hidden rounded-md bg-osu-b6 px-3">
              <SupporterStyledName nameStyle={id} nameFont={nameFont} name={username} className={NAME_CLASS} />
            </span>
            {id ? i18n._(SUPPORTER_NAME_STYLE_LABELS[id]) : t`Plain`}
          </Item>
        ))}
      </div>
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
              <span className={`truncate text-[20px] font-bold leading-none text-white ${id ? `name-font--${id}` : ""}`}>{username}</span>
            </span>
            {id ? i18n._(SUPPORTER_NAME_FONT_LABELS[id]) : t`Default`}
          </Item>
        ))}
      </div>
    </div>
  );
}

function MotifDrawer({ current, disabled, custom, canUpload, onTry, onPick, onUpload, onEditCustom }: DrawerProps) {
  const { t, i18n } = useLingui();
  const fileRef = useRef<HTMLInputElement>(null);
  const look = current.look;
  const tryOn = (value: SlotValue) => (on: boolean) => onTry("motif", on ? value : undefined);

  return (
    <div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
        <Item active={look.motif === "none"} disabled={disabled} onTry={tryOn(null)} onPick={() => onPick("motif", null)}>
          <span className="grid h-[68px] w-full place-items-center rounded-md bg-osu-b6 text-osu-f1">
            <NoArt className="h-6 w-6" />
          </span>
          {t`No art`}
        </Item>
        {SUPPORTER_MOTIFS.map((motif) => (
          <Item key={motif.id} active={look.motif === motif.id} disabled={disabled} onTry={tryOn(motif.id)} onPick={() => onPick("motif", motif.id)}>
            <span className="grid h-[68px] w-full place-items-center rounded-md bg-osu-b6">
              <img src={supporterMotifPath(motif.id)} alt="" className="h-14 w-14 object-contain" />
            </span>
            {i18n._(MOTIF_LABELS[motif.id])}
          </Item>
        ))}
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

function ThemeDrawer({ current, disabled, onTry, onPick, onThemeOptions }: DrawerProps) {
  const { t, i18n } = useLingui();
  /* Only the theme under the pointer moves; the rest hold a still frame. Every
     live swatch is a full shader pass plus a copy off the GPU each frame, and
     twenty of them at once is what made this page crawl. */
  const [moving, setMoving] = useState<SupporterProfileThemeId | null>(null);
  const tryOn = (value: SupporterProfileThemeId | null) => (on: boolean) => {
    setMoving(on ? value : null);
    onTry("theme", on ? value : undefined);
  };
  return (
    <div>
      <p className="mb-3 text-[12px] text-osu-f1">{t`Your whole profile takes on the theme: its colours, and a living backdrop behind the page.`}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2">
        <Item active={current.theme === null} disabled={disabled} onTry={tryOn(null)} onPick={() => onPick("theme", null)} className="items-stretch">
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
        <Link to="/supporter/themes" className={`${tile(false)} items-stretch`}>
          <span className="grid aspect-[16/10] w-full place-items-center rounded-md border border-dashed border-white/15 bg-osu-b6">
            <OwnThemeIcon className="h-7 w-7 text-osu-pink-light" />
          </span>
          <span className="w-full truncate text-center">{t`Make your own`}</span>
        </Link>
      </div>
      {current.theme === "highway" && (
        <button
          type="button"
          role="switch"
          aria-checked={!!current.themeOptions.charts}
          disabled={disabled}
          onClick={() => onThemeOptions({ ...current.themeOptions, charts: current.themeOptions.charts ? undefined : true })}
          className="mt-3 flex w-full cursor-pointer items-center gap-3 rounded-lg bg-osu-b4 px-3 py-2.5 text-left transition-colors hover:bg-osu-b3 disabled:cursor-default"
        >
          <span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${current.themeOptions.charts ? "bg-osu-pink" : "bg-osu-b2"}`}>
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-[left] ${current.themeOptions.charts ? "left-[18px]" : "left-0.5"}`} />
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold text-white">{t`Play my top plays`}</span>
            <span className="block text-[11px] text-osu-f1">{t`The highway streams a section of your best play in your main keymode, instead of random notes.`}</span>
          </span>
        </button>
      )}
      {current.theme !== null && (
        <button
          type="button"
          role="switch"
          aria-checked={!!current.themeOptions.rows}
          disabled={disabled}
          onClick={() => onThemeOptions({ ...current.themeOptions, rows: current.themeOptions.rows ? undefined : true })}
          className="mt-3 flex w-full cursor-pointer items-center gap-3 rounded-lg bg-osu-b4 px-3 py-2.5 text-left transition-colors hover:bg-osu-b3 disabled:cursor-default"
        >
          <span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${current.themeOptions.rows ? "bg-osu-pink" : "bg-osu-b2"}`}>
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-[left] ${current.themeOptions.rows ? "left-[18px]" : "left-0.5"}`} />
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold text-white">{t`Banner in lists`}</span>
            <span className="block text-[11px] text-osu-f1">{t`A strip of the theme behind your row on rankings and leaderboards.`}</span>
          </span>
        </button>
      )}
    </div>
  );
}
