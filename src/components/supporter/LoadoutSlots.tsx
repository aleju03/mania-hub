import { Fragment, memo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useLingui } from "@lingui/react/macro";

import {
  SUPPORTER_MOTIFS,
  type SupporterMotifId,
} from "../../lib/supporter-card-looks";
import { SUPPORTER_FOIL_LABELS, SUPPORTER_FOILS, type SupporterFoilId } from "../../lib/supporter-foils";
import {
  FRAMED_AVATAR_RADIUS,
  framedAvatarStyle,
  supporterFrameGeometry,
  supporterFrameSrc,
  type SupporterAvatarFrameId,
} from "../../lib/supporter-avatar-frames";
import { supporterMotifPath } from "../../lib/supporter-motif-art";
import { SUPPORTER_NAME_FONT_LABELS, type SupporterNameFontId } from "../../lib/supporter-name-fonts";
import { SUPPORTER_NAME_STYLE_LABELS, type SupporterNameStyleId } from "../../lib/supporter-name-styles";
import { SupporterStyledName } from "./SupporterNameStyle";
import { SupporterAvatarFrame } from "../player/SupporterAvatarFrame";
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
        {frame && live && <SupporterAvatarFrame frame={frame} />}
        {frame && !live && (
          <img
            src={supporterFrameSrc(frame, "still")}
            alt=""
            loading="lazy"
            className="pointer-events-none absolute max-w-none"
            style={{ left: `${left * 100}%`, top: `${top * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` }}
          />
        )}
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

/* A drawing of each case for the slot and drawer; the stage shows the real
   one, in 3D, around the viewer's card. */
export function SleeveCard({ sleeve, className }: { sleeve: SupporterCardSleeveId; className: string }) {
  const card = "url(#sleeve-card)";
  return (
    <svg viewBox="0 0 60 84" aria-hidden className={className}>
      <defs>
        <linearGradient id="sleeve-card" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4a4e5e" />
          <stop offset="1" stopColor="#262833" />
        </linearGradient>
        <linearGradient id="sleeve-glint" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0.35" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.35" />
          <stop offset="0.62" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {sleeve === "penny" && (
        <>
          <rect x="11" y="14" width="38" height="56" rx="3" fill={card} />
          <path d="M9 10 V70 Q9 72 11 72 H49 Q51 72 51 70 V10" fill="#fff" fillOpacity="0.06" stroke="#fff" strokeOpacity="0.55" strokeWidth="0.8" />
          <rect x="9" y="10" width="42" height="62" fill="url(#sleeve-glint)" />
        </>
      )}
      {sleeve === "toploader" && (
        <>
          <rect x="11" y="14" width="38" height="56" rx="3" fill={card} />
          <rect x="7" y="8" width="46" height="66" rx="3.5" fill="#fff" fillOpacity="0.07" stroke="#fff" strokeOpacity="0.75" strokeWidth="1.4" />
          <rect x="7" y="8" width="46" height="4" rx="2" fill="#fff" fillOpacity="0.28" />
          <rect x="7" y="8" width="46" height="66" rx="3.5" fill="url(#sleeve-glint)" />
        </>
      )}
      {sleeve === "onetouch" && (
        <>
          <rect x="5" y="1.5" width="50" height="81" rx="1.5" fill="#fff" fillOpacity="0.06" stroke="#b9c3ff" strokeOpacity="0.9" strokeWidth="1" />
          <path fillRule="evenodd" d="M6.5 3h47v78h-47zM9 16h3v-3h36v3h3v3.5h-3v49h3v3.5h-3v3H12v-3H9v-3.5h3v-49H9zM26 5.5h8a2.8 2.8 0 0 1 0 5.6h-8a2.8 2.8 0 0 1 0-5.6z" fill="#eef1f8" fillOpacity="0.82" />
          <rect x="12" y="13" width="36" height="62" rx="1.5" fill={card} />
          <circle cx="30" cy="8.3" r="2.2" fill="#e8b64a" stroke="#7a5512" strokeWidth="0.5" />
          <rect x="5" y="1.5" width="50" height="81" rx="1.5" fill="url(#sleeve-glint)" />
        </>
      )}
      {sleeve === "slab" && (
        <>
          <rect x="2" y="1" width="56" height="82" rx="4" fill="#fff" fillOpacity="0.05" stroke="#fff" strokeOpacity="0.55" strokeWidth="1.2" />
          <rect x="8" y="5" width="44" height="74" rx="2.5" fill="#fff" fillOpacity="0.06" stroke="#fff" strokeOpacity="0.8" strokeWidth="1.2" />
          <rect x="11" y="8" width="38" height="12" fill="#ff6aa8" />
          <rect x="12.2" y="9.2" width="35.6" height="9.6" fill="#f6f3ee" />
          <rect x="14" y="11" width="16" height="1.6" rx="0.8" fill="#16141a" opacity="0.75" />
          <rect x="14" y="14" width="11" height="1.4" rx="0.7" fill="#16141a" opacity="0.5" />
          <text x="46.5" y="17.2" textAnchor="end" fontSize="6" fontWeight="700" fill="#16141a" fontFamily="Arial, sans-serif">10</text>
          <rect x="12" y="24" width="36" height="51" rx="1.5" fill="#dfe6ee" fillOpacity="0.25" />
          <rect x="14" y="26" width="32" height="47" rx="2" fill={card} />
          {[[5.5, 4.5], [54.5, 4.5], [5.5, 79.5], [54.5, 79.5]].map(([cx, cy]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2" fill="#c9ccd2" stroke="#6d7077" strokeWidth="0.6" />
          ))}
          <rect x="2" y="1" width="56" height="82" rx="4" fill="url(#sleeve-glint)" />
        </>
      )}
    </svg>
  );
}

/* A closed binder in its cover (the .binder-cover-* rules in styles.css),
   with a spine and a label. */
export function BinderBook({ binder, className }: { binder: SupporterBinderId; className: string }) {
  return (
    <span className={`bnd-cover bnd--${binder} relative block overflow-hidden rounded-[5px] ${className}`}>
      {/* the spine's hinge, the stitching in the cover's thread, and a label plate */}
      <span className="absolute inset-y-0 left-[15%] w-[3px] bg-black/35 shadow-[1px_0_0_rgba(255,255,255,0.12)]" />
      <span className="absolute inset-[4px] left-[calc(15%+6px)] rounded-[3px] border border-dashed opacity-80" style={{ borderColor: "var(--stitch)" }} />
      <span className="absolute left-[38%] right-[16%] top-[20%] h-[13%] rounded-[2px] bg-black/30 shadow-[inset_0_1px_2px_rgba(0,0,0,0.5)]" />
    </span>
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

function Chips<K extends string>({ value, options, onChange }: { value: K; options: { value: K; label: string }[]; onChange: (value: K) => void }) {
  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button key={option.value} type="button" onClick={() => onChange(option.value)} aria-pressed={value === option.value} className={chip(value === option.value)}>
          {option.label}
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

function FrameDrawer({ current, disabled, avatar, onTry, onPick }: DrawerProps) {
  const { t, i18n } = useLingui();
  const frame = current.frame;
  const [tab, setTab] = useState(() => (frame && FRAME_NAMES.get(frame)?.group) || FRAME_GROUPS[0].key);
  const group = FRAME_GROUPS.find((g) => g.key === tab) ?? FRAME_GROUPS[0];
  const activeSet = group.entries.find((entry) => "set" in entry && holds(entry, frame));
  const tryOn = (value: SupporterAvatarFrameId | null) => (on: boolean) => onTry("frame", on ? value : undefined);

  return (
    <div>
      <Chips value={tab} options={FRAME_GROUPS.map((g) => ({ value: g.key, label: i18n._(g.title) }))} onChange={setTab} />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
        <Item active={frame === null} disabled={disabled} onTry={tryOn(null)} onPick={() => onPick("frame", null)}>
          <FrameThumb frame={null} avatar={avatar} size={68} />
          {t`No frame`}
        </Item>
        {group.entries.map((entry) => {
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
        })}
      </div>
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
      </div>
      {current.theme === "highway" && (
        <button
          type="button"
          role="switch"
          aria-checked={!!current.themeOptions.charts}
          disabled={disabled}
          onClick={() => onThemeOptions(current.themeOptions.charts ? {} : { charts: true })}
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
    </div>
  );
}
