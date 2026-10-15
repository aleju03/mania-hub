import { memo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useLingui } from "@lingui/react/macro";

import {
  CUSTOM_MOTIF_OPACITY_RANGE,
  CUSTOM_MOTIF_SCALE_RANGE,
  SUPPORTER_MOTIFS,
  type SupporterLook,
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
import { SUPPORTER_MOTIF_SVGS } from "../../lib/supporter-motif-art";
import { SUPPORTER_NAME_FONT_LABELS, type SupporterNameFontId } from "../../lib/supporter-name-fonts";
import { SUPPORTER_NAME_STYLE_LABELS, type SupporterNameStyleId } from "../../lib/supporter-name-styles";
import { SupporterStyledName } from "./SupporterNameStyle";
import { CheckBadge, LockIcon, UploadIcon } from "./LoadoutIcons";
import { FoilPreview } from "./FoilPreview";
import { ProfileThemeSwatch } from "./ProfileThemeBackdrop";
import { SUPPORTER_PROFILE_THEME_LABELS, SUPPORTER_PROFILE_THEMES, type SupporterProfileThemeId } from "../../lib/supporter-profile-themes";
import {
  FRAME_GROUPS,
  FRAME_NAMES,
  MOTIF_LABELS,
  NAME_FONT_GROUPS,
  NAME_STYLE_GROUPS,
  SLOT_IDS,
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

function motifSrc(id: SupporterMotifId): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SUPPORTER_MOTIF_SVGS[id])}`;
}

/* A frame's still around the viewer's avatar, fitted into a square. */
export function FrameThumb({ frame, avatar, size }: { frame: SupporterAvatarFrameId | null; avatar: string | undefined; size: number }) {
  const [left, top, width, height] = frame ? supporterFrameGeometry(frame).box : [0, 0, 1, 1];
  const scale = size / Math.max(width, height, 1.6);
  const avatarLeft = (size - width * scale) / 2 - left * scale;
  const avatarTop = (size - height * scale) / 2 - top * scale;
  return (
    <span className="relative block" style={{ width: size, height: size }}>
      <span className="absolute" style={{ left: avatarLeft, top: avatarTop, width: scale, height: scale }}>
        <img src={avatar} alt="" className="h-full w-full bg-osu-b3 object-cover" style={framedAvatarStyle(frame) ?? { borderRadius: FRAMED_AVATAR_RADIUS }} />
        {frame && (
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
function FoilCard({ foil, className, still }: { foil: SupporterFoilId; className: string; still?: boolean }) {
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
    if (slot === "motif") return value === "custom" ? t`Your image` : i18n._(MOTIF_LABELS[value as SupporterMotifId]);
    return i18n._(SUPPORTER_FOIL_LABELS[value as SupporterFoilId]);
  };
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
    const src = loadout.look.motif === "custom" ? loadout.look.url : motifSrc(loadout.look.motif);
    return <img src={src} alt="" className="h-7 w-7 rounded-sm object-contain" />;
  }
  return <FoilCard foil={loadout.look.foil} still className="h-[40px] w-[29px]" />;
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
          <div key={slot} className={`flex items-stretch rounded-xl transition-colors ${active ? "bg-osu-b4" : "hover:bg-osu-b4/60"}`}>
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
  /** Size and strength of the viewer's own image, as the sliders move. */
  onAdjust: (look: SupporterLook) => void;
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

const NAME_CLASS = "min-w-0 truncate p-2 -m-2 text-[18px] font-black leading-none text-white";

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

function MotifDrawer({ current, disabled, custom, canUpload, onTry, onPick, onUpload, onAdjust }: DrawerProps) {
  const { t, i18n } = useLingui();
  const fileRef = useRef<HTMLInputElement>(null);
  const look = current.look;
  const tryOn = (value: SlotValue) => (on: boolean) => onTry("motif", on ? value : undefined);

  return (
    <div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
        {SUPPORTER_MOTIFS.map((motif) => (
          <Item key={motif.id} active={look.motif === motif.id} disabled={disabled} onTry={tryOn(motif.id)} onPick={() => onPick("motif", motif.id)}>
            <span className="grid h-[68px] w-full place-items-center rounded-md bg-osu-b6">
              <img src={motifSrc(motif.id)} alt="" className="h-11 w-11" />
            </span>
            {i18n._(MOTIF_LABELS[motif.id])}
          </Item>
        ))}
        {custom && (
          <Item active={look.motif === "custom"} disabled={disabled} onTry={tryOn("custom")} onPick={() => onPick("motif", "custom")}>
            <span className="grid h-[68px] w-full place-items-center rounded-md bg-osu-b6">
              <img src={custom.url} alt="" className="h-11 w-11 rounded-sm object-contain" />
            </span>
            {t`Your image`}
          </Item>
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
      {look.motif === "custom" && (
        <div className="mt-4 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-[11px] text-osu-f1">
          <label htmlFor="supporter-motif-size">{t`Size`}</label>
          <input
            id="supporter-motif-size"
            type="range"
            min={CUSTOM_MOTIF_SCALE_RANGE[0]}
            max={CUSTOM_MOTIF_SCALE_RANGE[1]}
            step={0.05}
            value={look.scale ?? 1}
            disabled={disabled}
            onChange={(event) => onAdjust({ ...look, scale: Number(event.target.value) })}
            className="accent-osu-pink"
          />
          <label htmlFor="supporter-motif-strength">{t`Strength`}</label>
          <input
            id="supporter-motif-strength"
            type="range"
            min={CUSTOM_MOTIF_OPACITY_RANGE[0]}
            max={CUSTOM_MOTIF_OPACITY_RANGE[1]}
            step={0.05}
            value={look.opacity ?? 0.85}
            disabled={disabled}
            onChange={(event) => onAdjust({ ...look, opacity: Number(event.target.value) })}
            className="accent-osu-pink"
          />
        </div>
      )}
    </div>
  );
}

function FoilDrawer({ current, disabled, onTry, onPick }: DrawerProps) {
  const { i18n } = useLingui();
  const tryOn = (value: SupporterFoilId) => (on: boolean) => onTry("foil", on ? value : undefined);
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
      {SUPPORTER_FOILS.map((id) => (
        <Item key={id} active={current.look.foil === id} disabled={disabled} onTry={tryOn(id)} onPick={() => onPick("foil", id)}>
          <FoilCard foil={id} className="aspect-[5/7] w-full" />
          <span className="w-full truncate text-center">{i18n._(SUPPORTER_FOIL_LABELS[id])}</span>
        </Item>
      ))}
    </div>
  );
}

/* "No theme": the site's own colours, whichever hue the visitor picked, so a wheel rather than any one. */
function SiteColours({ className }: { className: string }) {
  return <span className={`rounded-full ${className}`} style={{ background: "conic-gradient(#ff66ab, #ffcc22, #88b300, #66ccff, #8866ee, #ff66ab)" }} />;
}

function ThemeDrawer({ current, disabled, onTry, onPick, onThemeOptions }: DrawerProps) {
  const { t, i18n } = useLingui();
  const tryOn = (value: SupporterProfileThemeId | null) => (on: boolean) => onTry("theme", on ? value : undefined);
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
            <ProfileThemeSwatch theme={id} className="aspect-[16/10] w-full rounded-md" />
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
