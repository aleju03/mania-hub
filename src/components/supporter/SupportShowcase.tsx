import { forwardRef, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { animate, AnimatePresence, motion, useInView, useReducedMotion } from "framer-motion";
import { useLingui } from "@lingui/react/macro";

import { ManiaCard3DPanel } from "../player/maniacard3d/LazyManiaCard3DPanel";
import { SupporterAvatarFrame } from "../player/SupporterAvatarFrame";
import { avatarUrlUserId } from "../ui/Avatar";
import { HoursCard, LnSplitCard, NotesCard, PercentileCard, RatioCard, SessionCard, SkillCard, StreakCard } from "../player/ProfileStatCards";
import { ProfileThemeBackdrop, ProfileThemeSwatch } from "./ProfileThemeBackdrop";
import { SupporterStyledName } from "./SupporterNameStyle";
import { useFittedName } from "./useFittedName";
import { FoilPreview } from "./FoilPreview";
import { GiftTicket3D } from "./GiftTicket3D";
import { CompanionFigure, CompanionThumb } from "./Companion";
import { BinderBook, FoilCard, FrameThumb, SleeveCard, wrapperThumb } from "./LoadoutSlots";
import { useWrapperArtVersion, wrapperArt, wrapperArtPending } from "../packs/wrapperArt";
import { BladeSwatch } from "../packs/BladeSwatch";
import { playBladeRip, warmBladeSounds } from "../packs/packSfx";
import { bladeLook } from "../packs/packBlades";
import type { MessageDescriptor } from "@lingui/core";
import { FRAME_GROUPS, FRAME_NAMES, type FrameEntry } from "./loadout";
import { formatGiftCode } from "./GiftCodePanel";
import { Stagger, StaggerItem, useLowEndDevice, useNearView } from "./SupportMotion";
import { useAuth } from "../../lib/auth-context";
import { isScrolling, queueGpuWork } from "../../lib/gpu-queue";
import { fetchLivePackCardSnapshotDirect, fetchLiveSubmittedCompanions, type LivePackCardSnapshot } from "../../lib/live-backend";
import { BUILT_IN_COMPANIONS, type SupporterCompanion } from "../../lib/supporter-companions";
import { framedAvatarStyle, supporterFrameGeometry, type SupporterAvatarFrameId } from "../../lib/supporter-avatar-frames";
import { SUPPORTER_FOIL_LABELS, SUPPORTER_FOILS, type SupporterFoilId } from "../../lib/supporter-foils";
import { SUPPORTER_NAME_FONT_LABELS, type SupporterNameFontId } from "../../lib/supporter-name-fonts";
import { nameStyleLabel, type SupporterNameStyleId } from "../../lib/supporter-name-styles";
import {
  profileThemeStyle,
  SUPPORTER_PROFILE_THEME_LABELS,
  SUPPORTER_PROFILE_THEMES,
  type SupporterProfileThemeId,
} from "../../lib/supporter-profile-themes";
import {
  SUPPORTER_BINDER_LABELS,
  SUPPORTER_BINDERS,
  SUPPORTER_CARD_SLEEVE_LABELS,
  SUPPORTER_CARD_SLEEVES,
  SUPPORTER_WRAPPER_LABELS,
  SUPPORTER_WRAPPERS,
  SUPPORTER_BLADE_LABELS,
  SUPPORTER_BLADES,
  type SupporterBladeId,
} from "../../lib/supporter-pack-style";
import type { ProfileStatsData } from "../../lib/profile-stats";
import type { SupporterLook } from "../../lib/supporter-card-looks";
import { scaledPx } from "#/lib/ui-scale-values";

/* The live pictures on /support, one per perk: each is the real thing the
   perk draws (the theme's backdrop, the frame's video, the name's shader,
   the card's foil in 3D), worn by the visitor when they are signed in and by
   a stand-in otherwise. Nothing here saves; /supporter is where it is set. */

const FALLBACK_AVATAR = "/images/favicon-256.png";

export function useShowcaseViewer() {
  const { t } = useLingui();
  const viewer = useAuth().viewer;
  return {
    id: viewer?.id ?? null,
    name: viewer?.username ?? t`You`,
    avatar: viewer?.avatarUrl ?? FALLBACK_AVATAR,
  };
}

/* Steps through `count` items every `ms` until the visitor picks one, which
   holds it. A step builds a new look (a backdrop's theme, a name's shader), so
   it waits while the page is being scrolled. */
function useCycle(count: number, ms: number, active: boolean) {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held || reduced || count < 2 || !active) return;
    const timer = window.setInterval(() => {
      if (!isScrolling()) setIndex((n) => (n + 1) % count);
    }, ms);
    return () => window.clearInterval(timer);
  }, [held, reduced, count, ms, active]);
  const pick = (next: number) => {
    setHeld(true);
    setIndex(next);
  };
  return [index, pick] as const;
}

/* --- Theme stage ------------------------------------------------------------- */

/* A theme's living backdrop that changes theme by revealing the next one,
   live, through a soft-edged circle that grows from the middle. Two backdrops
   take turns: the next theme goes on the one underneath, which then grows over
   the other, and the covered one stops drawing. Each keeps its WebGL context
   and the programs it has compiled, so the cycle never builds one again, and
   the revealed theme's animation runs on without a restart. */
const REVEAL_MS = 900;

const ThemeStage = forwardRef<HTMLDivElement, { theme: SupporterProfileThemeId; className?: string; children: ReactNode }>(function ThemeStage({ theme, className = "", children }, ref) {
  const reduced = useReducedMotion();
  // the second backdrop is only made for the first change
  const [slots, setSlots] = useState<[SupporterProfileThemeId, SupporterProfileThemeId | null]>(() => [theme, null]);
  const [front, setFront] = useState(0);
  const [reveal, setReveal] = useState(0);
  const [revealing, setRevealing] = useState(false);
  const layers = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const shown = slots[front] ?? theme;

  useEffect(() => {
    if (theme === shown) return;
    const next = reduced ? front : 1 - front;
    setSlots((current) => (next === 0 ? [theme, current[1]] : [current[0], theme]));
    if (reduced) return;
    setFront(next);
    setRevealing(true);
    setReveal((n) => n + 1);
  }, [theme]); // eslint-disable-line react-hooks/exhaustive-deps

  // grows the front one over the other, once it is in the page
  useEffect(() => {
    const layer = layers[front].current;
    if (!reveal || !layer) return;
    const controls = animate(layer, { "--reveal": ["0%", "135%"], scale: [1.06, 1] } as never, { duration: REVEAL_MS / 1000, ease: [0.45, 0, 0.2, 1] });
    const settle = window.setTimeout(() => setRevealing(false), REVEAL_MS + 100);
    return () => {
      controls.stop();
      window.clearTimeout(settle);
    };
  }, [reveal]); // eslint-disable-line react-hooks/exhaustive-deps

  const mask = "radial-gradient(circle at 50% 55%, #000 calc(var(--reveal) - 18%), transparent var(--reveal))";
  return (
    <div ref={ref} className={`relative isolate overflow-hidden bg-osu-b6 ${className}`} style={profileThemeStyle(shown)}>
      {slots.map((slot, index) => {
        if (!slot) return null;
        const onTop = index === front;
        // the one underneath only shows while the other grows over it
        const hidden = !onTop && !revealing;
        return (
          <div
            key={index}
            ref={layers[index]}
            aria-hidden
            className={`pointer-events-none absolute inset-0 ${hidden ? "hidden" : ""}`}
            style={{ zIndex: onTop ? -9 : -10, ...(onTop && revealing ? { "--reveal": "0%", maskImage: mask, WebkitMaskImage: mask } : {}) } as CSSProperties}
          >
            <ProfileThemeBackdrop theme={slot} maxPixels={420_000} className="absolute inset-0" />
          </div>
        );
      })}
      <div className="relative h-full">{children}</div>
    </div>
  );
});

/* --- Hero ------------------------------------------------------------------ */

interface HeroLook {
  theme: SupporterProfileThemeId;
  frame: SupporterAvatarFrameId;
  nameStyle: SupporterNameStyleId;
  nameFont: SupporterNameFontId | null;
}

/* Looks whose theme, frame and name belong together at a glance (each was
   judged on a capture of this stage, not picked from the lists). */
const HERO_LOOKS: HeroLook[] = [
  { theme: "maple", frame: "autumn-maple", nameStyle: "ember", nameFont: "cinzel" },
  { theme: "aero", frame: "aero-bubble", nameStyle: "aero", nameFont: "righteous" },
  { theme: "cosmos", frame: "stellium-orbit", nameStyle: "galaxy", nameFont: "orbitron" },
  { theme: "fireflies", frame: "fairy-lights", nameStyle: "gold", nameFont: "lobster" },
  { theme: "vaporwave", frame: "xp-window", nameStyle: "holo", nameFont: "audiowide" },
  { theme: "sakura", frame: "sakura", nameStyle: "solid-ffd6e7", nameFont: "playfair" },
  { theme: "terminal", frame: "term-window", nameStyle: "terminal", nameFont: "vt323" },
];

/* [top, sides, bottom] in avatar widths: the most any hero frame reaches past the avatar. */
const HERO_ROOM = HERO_LOOKS.reduce(
  ([top, sides, bottom], { frame }) => {
    const [left, up, right, down] = supporterFrameGeometry(frame).overhang;
    return [Math.max(top, up), Math.max(sides, left, right), Math.max(bottom, down)];
  },
  [0, 0, 0],
);

export function HeroStage() {
  const { i18n } = useLingui();
  const reduced = useReducedMotion();
  const you = useShowcaseViewer();
  const [ref, near] = useNearView<HTMLDivElement>();
  const [index, pick] = useCycle(HERO_LOOKS.length, 4200, near);
  const look = HERO_LOOKS[index];
  const nameBoxRef = useFittedName([you.name, look.nameStyle, look.nameFont]);
  const frameName = FRAME_NAMES.get(look.frame);
  const fade = reduced ? undefined : { initial: { opacity: 0, scale: 0.94 }, animate: { opacity: 1, scale: 1 }, exit: { opacity: 0 }, transition: { duration: 0.35 } };
  const size = 112;

  return (
    <ThemeStage ref={ref} theme={look.theme} className="rounded-2xl">
      <button
        type="button"
        onClick={() => pick((index + 1) % HERO_LOOKS.length)}
        className="flex min-h-[330px] w-full cursor-pointer flex-col items-center justify-center px-4 py-6"
      >
        <div className="shrink-0" style={{ padding: `${HERO_ROOM[0] * size}px ${HERO_ROOM[1] * size}px ${HERO_ROOM[2] * size}px` }}>
          <AnimatePresence mode="wait">
            <motion.div key={look.frame} {...fade} className="relative" style={{ width: scaledPx(size), height: scaledPx(size) }}>
              <img src={you.avatar} alt="" className="h-full w-full max-w-none rounded-2xl bg-osu-b3 object-cover" style={framedAvatarStyle(look.frame)} />
              <SupporterAvatarFrame frame={look.frame} still={!near} userId={avatarUrlUserId(you.avatar)} />
            </motion.div>
          </AnimatePresence>
        </div>
        <AnimatePresence mode="wait">
          <motion.div key={`${look.nameStyle}|${look.nameFont}`} {...fade} className="mt-2 w-full max-w-full">
            <div ref={nameBoxRef} className="flex w-full justify-center">
              <SupporterStyledName
                nameStyle={look.nameStyle}
                nameFont={look.nameFont}
                name={you.name}
                live={near}
                className="max-w-full truncate px-2 py-[0.3em] -my-[0.3em] text-[length:calc(34px*var(--name-scale,1))] font-black leading-none text-white sm:text-[length:calc(44px*var(--name-scale,1))]"
              />
            </div>
          </motion.div>
        </AnimatePresence>
      </button>
      <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 bg-black/35 px-4 py-2.5 text-[11px] font-semibold text-white/80">
        <span>{i18n._(SUPPORTER_PROFILE_THEME_LABELS[look.theme])}</span>
        <span aria-hidden className="h-2.5 w-px bg-white/30" />
        <span>{frameName ? `${i18n._(frameName.label)}${frameName.variant ? ` ${frameName.variant}` : ""}` : look.frame}</span>
        <span aria-hidden className="h-2.5 w-px bg-white/30" />
        <span>
          {i18n._(nameStyleLabel(look.nameStyle))}
          {look.nameFont ? `, ${i18n._(SUPPORTER_NAME_FONT_LABELS[look.nameFont])}` : ""}
        </span>
      </div>
    </ThemeStage>
  );
}

/* --- Profile themes ---------------------------------------------------------- */

export function ThemesShowcase() {
  const { i18n } = useLingui();
  const you = useShowcaseViewer();
  const reduced = useReducedMotion();
  const [ref, near] = useNearView<HTMLDivElement>();
  const [index, pick] = useCycle(SUPPORTER_PROFILE_THEMES.length, 3600, near);
  const theme = SUPPORTER_PROFILE_THEMES[index];
  return (
    <div>
      <ThemeStage ref={ref} theme={theme} className="h-[260px] rounded-xl sm:h-[300px]">
        <div className="absolute inset-x-0 bottom-0 flex items-end gap-4 bg-gradient-to-t from-black/55 to-transparent px-5 pb-5 pt-16">
          <motion.img
            key={`avatar-${theme}`}
            src={you.avatar}
            alt=""
            className="h-16 w-16 rounded-xl bg-osu-b3 object-cover sm:h-20 sm:w-20"
            initial={reduced ? false : { scale: 0.8, rotate: -8 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 13, delay: 0.3 }}
          />
          <div className="min-w-0 pb-1">
            <div className="truncate text-[24px] font-black leading-tight text-white sm:text-[30px]">{you.name}</div>
            <motion.div
              key={`label-${theme}`}
              className="text-[13px] font-semibold text-osu-pink-light"
              initial={reduced ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 380, damping: 20, delay: 0.35 }}
            >
              {i18n._(SUPPORTER_PROFILE_THEME_LABELS[theme])}
            </motion.div>
          </div>
        </div>
      </ThemeStage>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {SUPPORTER_PROFILE_THEMES.map((id, i) => (
          <button
            key={id}
            type="button"
            onClick={() => pick(i)}
            aria-label={i18n._(SUPPORTER_PROFILE_THEME_LABELS[id])}
            aria-pressed={i === index}
            title={i18n._(SUPPORTER_PROFILE_THEME_LABELS[id])}
            className={`cursor-pointer overflow-hidden rounded-md transition ${i === index ? "ring-2 ring-white" : "opacity-70 hover:opacity-100"}`}
          >
            <ProfileThemeSwatch theme={id} still className="block h-9 w-14" />
          </button>
        ))}
      </div>
    </div>
  );
}

/* --- Avatar frames ------------------------------------------------------------ */

/* Every frame, a page of eight at a time. A set (wings in three layers, LN
   holds, dan skips) is one tile with its variants as chips under it, as in the
   picker. The first pages are hand-picked, the strongest first and never the
   same idea twice; the rest follow in the picker's order. */
const PICKED_FRAME_PAGES: SupporterAvatarFrameId[][] = [
  ["crown", "spell-card", "crt-monitor", "wings-pink-3", "sakura", "ssr-card", "paint-canvas", "hakurei-torii"],
  ["term-window", "wash-ring", "step-pad", "light-wings-3", "autumn-maple", "ln-hold-9", "reimu-ribbon", "old-photo"],
  ["scratch-deck", "zenith-orbit", "time-stop-knives", "rail-pass", "wings-gold-3", "knob-lasers", "margin-doodles", "scarlet-moon"],
  ["winter-pine", "five-star-pull", "dan-skip-5-gamma", "delta-crest", "wings-feather-3", "ice-fairy", "aero-window", "witch-hat"],
];

interface FrameTile {
  key: string;
  label: MessageDescriptor;
  variants: { id: SupporterAvatarFrameId; label: string }[];
  /* The variant the tile opens on. */
  start: number;
}

const SHOWN_FRAME_PAGES: FrameTile[][] = (() => {
  const entries = FRAME_GROUPS.flatMap((group) => group.entries);
  const ids = (entry: FrameEntry) => ("id" in entry ? [entry.id] : entry.variants.map((variant) => variant.id));
  const used = new Set<FrameEntry>();
  const tile = (entry: FrameEntry, picked?: SupporterAvatarFrameId): FrameTile =>
    "id" in entry
      ? { key: entry.id, label: entry.label, variants: [{ id: entry.id, label: "" }], start: 0 }
      : { key: entry.set, label: entry.label, variants: entry.variants, start: Math.max(0, picked ? ids(entry).indexOf(picked) : entry.shown) };
  const pages = PICKED_FRAME_PAGES.map((page) =>
    page.flatMap((frame) => {
      const entry = entries.find((candidate) => ids(candidate).includes(frame));
      if (!entry || used.has(entry)) return [];
      used.add(entry);
      return [tile(entry, frame)];
    }),
  );
  const rest = entries.filter((entry) => !used.has(entry)).map((entry) => tile(entry));
  for (let at = 0; at < rest.length; at += 8) pages.push(rest.slice(at, at + 8));
  return pages;
})();

/* Eight frame videos at once are a lot for a weak machine: there only the one
   under the pointer plays. */
export function FramesShowcase() {
  const { t, i18n } = useLingui();
  const you = useShowcaseViewer();
  const [ref, near] = useNearView<HTMLDivElement>();
  const lowEnd = useLowEndDevice();
  const [hovered, setHovered] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  /* The variant picked on a set's tile, by tile key. */
  const [variant, setVariant] = useState<Record<string, number>>({});
  const pages = SHOWN_FRAME_PAGES.length;
  const turn = (by: number) => {
    setHovered(null);
    setPage((current) => (current + by + pages) % pages);
  };
  return (
    <div ref={ref}>
      {/* Every tile and the grid itself keep one height (room for two rows of
          chips, and for eight tiles on a short last page), so the page buttons
          never move under the pointer. */}
      <Stagger key={page} className="grid min-h-[776px] grid-cols-2 content-start gap-x-3 gap-y-4 sm:min-h-[380px] sm:grid-cols-4">
        {SHOWN_FRAME_PAGES[page].map((entry) => {
          const at = variant[entry.key] ?? entry.start;
          const frame = entry.variants[at].id;
          return (
            <StaggerItem key={entry.key} className="flex h-[182px] flex-col items-center" onPointerEnter={() => setHovered(entry.key)} onPointerLeave={() => setHovered(null)}>
              <FrameThumb frame={frame} avatar={you.avatar} size={118} live={near && (!lowEnd || hovered === entry.key)} />
              <div className="mt-1 text-center text-[11px] text-osu-f1">{i18n._(entry.label)}</div>
              {entry.variants.length > 1 && (
                <div className="mt-1 flex flex-wrap justify-center gap-1">
                  {entry.variants.map((option, index) => (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={index === at}
                      onClick={() => setVariant((current) => ({ ...current, [entry.key]: index }))}
                      className={`min-w-5 cursor-pointer rounded px-1 text-[10px] leading-4 tabular-nums transition ${index === at ? "bg-osu-l2 text-osu-b6" : "bg-osu-b4 text-osu-f1 hover:text-white"}`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
            </StaggerItem>
          );
        })}
      </Stagger>
      <div className="mt-4 flex items-center justify-center gap-3">
        <PageButton direction={-1} label={t`Previous frames`} onClick={() => turn(-1)} />
        <span className="min-w-[3ch] text-center text-[12px] tabular-nums text-osu-f1">{page + 1} / {pages}</span>
        <PageButton direction={1} label={t`More frames`} onClick={() => turn(1)} />
      </div>
    </div>
  );
}

function PageButton({ direction, label, onClick }: { direction: 1 | -1; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid h-8 w-8 cursor-pointer place-items-center rounded-full bg-osu-b4 text-osu-l2 transition hover:bg-osu-b3 hover:text-white"
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
        <path d={direction === 1 ? "M6 3.5 10.5 8 6 12.5" : "M10 3.5 5.5 8 10 12.5"} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/* --- Names --------------------------------------------------------------------- */

const SHOWN_NAMES: [SupporterNameStyleId, SupporterNameFontId | null][] = [
  ["inferno", null],
  ["holo", "unbounded"],
  ["neon", "monoton"],
  ["aero", "fredoka"],
  ["sticker", "luckiest"],
  ["long-note", "russo"],
  ["terminal", "monocraft"],
];

/* Each shader name is its own WebGL context; on a weak machine the rows keep
   their CSS look and only the one under the pointer runs live. */
export function NamesShowcase() {
  const { i18n } = useLingui();
  const you = useShowcaseViewer();
  const [ref, near] = useNearView<HTMLDivElement>();
  const lowEnd = useLowEndDevice();
  const [hovered, setHovered] = useState<SupporterNameStyleId | null>(null);
  return (
    <div ref={ref}>
    <Stagger className="divide-y divide-white/[0.07]">
      {SHOWN_NAMES.map(([style, font]) => (
        <StaggerItem key={style} lift={false} className="flex items-center justify-between gap-4 py-2.5" onPointerEnter={() => setHovered(style)} onPointerLeave={() => setHovered(null)}>
          <SupporterStyledName nameStyle={style} nameFont={font} name={you.name} live={near && (!lowEnd || hovered === style)} className="min-w-0 truncate px-2 -mx-2 py-[0.3em] -my-[0.3em] text-[26px] font-black leading-none text-white sm:text-[30px]" />
          <span className="shrink-0 text-right text-[11px] text-osu-f1">
            {i18n._(nameStyleLabel(style))}
            {font ? `, ${i18n._(SUPPORTER_NAME_FONT_LABELS[font])}` : ""}
          </span>
        </StaggerItem>
      ))}
    </Stagger>
    </div>
  );
}

/* --- Companions ------------------------------------------------------------------ */

/* Submitted ones shown after the site's own, newest first. */
const SHOWN_SUBMITTED = 8;
/* The site's own, the keycap tucked in after the paperclip rather than at an end. */
export const SHOWCASE_COMPANIONS = BUILT_IN_COMPANIONS.filter((entry) => entry.kind === "model").flatMap((entry) =>
  entry.id === "paperclip" ? [entry, ...BUILT_IN_COMPANIONS.filter((other) => other.kind === "keycap")] : [entry]);

/* One companion standing on a stretch of the profile's rail, live (drag a
   model to turn it), and the rest as stills to tap through: the site's own,
   then a few that supporters sent in. Nothing cycles on its own, since every
   model is its own download. */
export function CompanionsShowcase() {
  const { t, i18n } = useLingui();
  const [ref, near] = useNearView<HTMLDivElement>();
  const [submitted, setSubmitted] = useState<SupporterCompanion[]>([]);
  const [picked, setPicked] = useState(0);
  useEffect(() => {
    if (!near) return;
    let alive = true;
    fetchLiveSubmittedCompanions()
      .then((list) => {
        if (alive) setSubmitted(list.slice(0, SHOWN_SUBMITTED).map((entry) => ({ submitted: entry })));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [near]);
  const all = useMemo<SupporterCompanion[]>(() => [...SHOWCASE_COMPANIONS.map((entry) => ({ builtIn: entry })), ...submitted], [submitted]);
  const shown = all[Math.min(picked, all.length - 1)];
  const label = (companion: SupporterCompanion) => ("builtIn" in companion ? i18n._(companion.builtIn.name) : companion.submitted.name);
  const credit = "builtIn" in shown ? shown.builtIn.credit : null;
  const keycap = "builtIn" in shown && shown.builtIn.kind === "keycap";
  return (
    <div ref={ref} className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] sm:items-center">
      <div className="relative h-[230px] overflow-hidden rounded-xl bg-osu-b6 sm:h-[260px]">
        <div className="absolute inset-x-0 bottom-0 h-[30%] border-t border-white/[0.08] bg-white/[0.035]" />
        <div className={`absolute bottom-[30%] left-1/2 translate-y-2 -translate-x-1/2 ${keycap ? "h-32 w-[4.5rem]" : "h-36 w-28"}`}>
          {!keycap && <span className="pointer-events-none absolute inset-x-6 bottom-0 h-3 rounded-full bg-black/35 blur-md" />}
          {near && <CompanionFigure companion={shown} />}
        </div>
        <div className="absolute inset-x-0 bottom-0 flex h-[30%] flex-col items-center justify-center px-3 text-center">
          <div className="truncate text-[14px] font-semibold text-white">{label(shown)}</div>
          {credit ? (
            <a href={credit.url} target="_blank" rel="noreferrer" className="text-[11px] text-osu-f1 hover:text-white">
              {credit.basedOn ? t`Based on a model by ${credit.author}` : t`Model by ${credit.author}`}
            </a>
          ) : "submitted" in shown ? (
            <div className="truncate text-[11px] text-osu-f1">{t`Sent in by ${shown.submitted.submittedBy.username}`}</div>
          ) : null}
        </div>
      </div>
      <div>
        <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-6">
          {all.map((companion, i) => (
            <button
              key={"builtIn" in companion ? companion.builtIn.id : companion.submitted.id}
              type="button"
              onClick={() => setPicked(i)}
              aria-label={label(companion)}
              aria-pressed={companion === shown}
              title={label(companion)}
              className={`grid aspect-square cursor-pointer place-items-center rounded-lg bg-osu-b5 p-1 transition ${companion === shown ? "ring-2 ring-white" : "opacity-75 hover:opacity-100"}`}
            >
              <CompanionThumb companion={companion} className="h-full w-full" />
            </button>
          ))}
        </div>
        <p className="mt-3 text-[12px] text-osu-f1">{t`Or upload one yourself (a 3D model, an image or a GIF) from your supporter page.`}</p>
      </div>
    </div>
  );
}

/* --- Card ---------------------------------------------------------------------- */

const NO_SCORES: [] = [];

function useViewerCard() {
  const viewer = useAuth().viewer;
  const [card, setCard] = useState<LivePackCardSnapshot | null | undefined>(viewer ? undefined : null);
  useEffect(() => {
    if (!viewer) return;
    let alive = true;
    fetchLivePackCardSnapshotDirect(String(viewer.id))
      .then((next) => alive && setCard(next))
      .catch(() => alive && setCard(null));
    return () => {
      alive = false;
    };
  }, [viewer?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => {
    if (!card) return card;
    return {
      user: { ...card.user, statistics: { global_rank: card.user.statistics.global_rank, pp: card.user.statistics.pp ?? undefined } },
      scores: card.bestScores ?? NO_SCORES,
    };
  }, [card]);
}

/* The signed-in visitor's own card in 3D, or a hand of plain cards for anyone else. */
export function CardShowcase() {
  const { i18n } = useLingui();
  const card = useViewerCard();
  const [ref, near] = useNearView<HTMLDivElement>();
  const [index, pick] = useCycle(SUPPORTER_FOILS.length, 3200, near);
  const foil = SUPPORTER_FOILS[index];
  const look = useMemo<SupporterLook>(() => ({ motif: "none", foil }), [foil]);

  return (
    <div ref={ref} className="grid items-center gap-5 sm:grid-cols-[minmax(0,270px)_minmax(0,1fr)]">
      <div className="mx-auto w-full max-w-[270px]">
        {card ? (
          <ManiaCard3DPanel user={card.user} scores={card.scores} loading={false} isOwnProfile supporterLookOverride={look} showTierProgress={false} />
        ) : card === undefined ? (
          <div className="aspect-[5/7] animate-pulse rounded-xl bg-osu-b6" />
        ) : (
          <CardHand foil={foil} />
        )}
      </div>
      <div>
        <Stagger className="grid grid-cols-4 gap-2">
          {SUPPORTER_FOILS.map((id, i) => (
            <StaggerItem key={id}>
            <button
              type="button"
              onClick={() => pick(i)}
              aria-pressed={i === index}
              className={`w-full cursor-pointer rounded-lg p-1.5 text-center transition ${i === index ? "bg-white/[0.08]" : "hover:bg-white/[0.04]"}`}
            >
              <FoilCard foil={id} still={i !== index} className="mx-auto h-[56px] w-[40px]" />
              <span className={`mt-1 block truncate text-[11px] ${i === index ? "text-white" : "text-osu-f1"}`}>{i18n._(SUPPORTER_FOIL_LABELS[id])}</span>
            </button>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </div>
  );
}

function CardHand({ foil }: { foil: SupporterFoilId }) {
  const reduced = useReducedMotion();
  const sides: SupporterFoilId[] = [SUPPORTER_FOILS[(SUPPORTER_FOILS.indexOf(foil) + 3) % SUPPORTER_FOILS.length], SUPPORTER_FOILS[(SUPPORTER_FOILS.indexOf(foil) + 5) % SUPPORTER_FOILS.length]];
  return (
    <div className="relative mx-auto h-[300px] w-[270px]">
      {[{ id: sides[0], rotate: -11, x: -58 }, { id: sides[1], rotate: 11, x: 58 }, { id: foil, rotate: 0, x: 0 }].map(({ id, rotate, x }, i) => (
        <motion.div
          key={i}
          className="absolute left-1/2 top-4 -ml-[89px] h-[250px] w-[178px] origin-bottom"
          style={{ zIndex: i === 2 ? 2 : 1 }}
          initial={reduced ? false : { x: 0, rotate: 0, y: 40, opacity: 0 }}
          whileInView={{ x, rotate, y: 0, opacity: 1 }}
          whileHover={{ y: -14 }}
          viewport={{ once: true, margin: "0px 0px -15% 0px" }}
          transition={{ type: "spring", stiffness: 200, damping: 16, delay: i === 2 ? 0 : 0.25 }}
        >
          <FoilCard foil={id} still={i !== 2} className="h-full w-full shadow-[0_12px_30px_rgba(0,0,0,0.45)]" />
        </motion.div>
      ))}
    </div>
  );
}

/* --- Packs ----------------------------------------------------------------------- */

/* An opening's slash on loop: the live swatch (BladeSwatch) recorded on black
   at 116x84 (2x), one 1.7 s cycle (foundry's grab-blades), and played with screen
   blending so its light adds onto the tile the way the WebGL does. A short
   video starts at once; four live WebGL swatches each waited their turn for a
   context. Encoded at CRF 10: at a low bitrate the dark glow breaks into
   blocks. Reduced motion keeps the drawn still. Kept under /videos/, which
   the service worker leaves alone (Safari plays video only with ranges). */
function BladeLoop({ blade, className }: { blade: SupporterBladeId; className: string }) {
  const [moving, setMoving] = useState<boolean | null>(null);
  // a phone holds an off-screen video back until it scrolls in, so the still
  // shows until its loop is actually playing rather than an empty tile
  const [playing, setPlaying] = useState(false);
  useEffect(() => setMoving(!window.matchMedia("(prefers-reduced-motion: reduce)").matches), []);
  if (moving === false) return <BladeSwatch blade={blade} className={className} />;
  return (
    <span className={`relative isolate block overflow-hidden ${className}`}>
      {!playing && <BladeSwatch blade={blade} className="absolute inset-0 h-full w-full" />}
      {moving && (
        <video
          onPlaying={() => setPlaying(true)}
          src={`/videos/blades/${blade}-v3.mp4`}
          autoPlay
          loop
          muted
          playsInline
          disablePictureInPicture
          aria-hidden
          className="absolute inset-0 h-full w-full object-cover mix-blend-screen"
        />
      )}
    </span>
  );
}

export function PacksShowcase() {
  const { t, i18n } = useLingui();
  const [wrappers, setWrappers] = useState<Partial<Record<string, string>>>({});
  const wrapperArtVersion = useWrapperArtVersion();
  /* Thumbs drawn with their renders in: final, so a later render arriving doesn't queue them again. */
  const finished = useRef(new Set<string>());
  // Each is a whole pack drawn on a canvas, one per quiet moment (gpu-queue.ts),
  // and none while the page scrolls. Waiting for the section to come near
  // left them blank for seconds on a phone, where a reader keeps nudging the
  // page; started with the page, they are in long before anyone scrolls this
  // far (six draws, ~50ms each on a slow phone). Every wrapper's renders
  // start loading at once, so most thumbs are drawn once, already with them.
  useEffect(() => {
    for (const id of SUPPORTER_WRAPPERS) wrapperArt(id);
    const cancels = SUPPORTER_WRAPPERS.filter((id) => !finished.current.has(id)).map((id) => queueGpuWork(() => {
      const thumb = wrapperThumb(id);
      if (!wrapperArtPending(id)) finished.current.add(id);
      setWrappers((current) => ({ ...current, [id]: thumb }));
    }));
    return () => cancels.forEach((cancel) => cancel());
  }, [wrapperArtVersion]);
  const group = "min-w-0";
  const heading = "mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-osu-f1";
  const label = "mt-1.5 truncate text-center text-[11px] text-osu-l2";
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className={group}>
        <div className={heading}>{t`Cases`}</div>
        <Stagger className="grid grid-cols-4 gap-2">
          {SUPPORTER_CARD_SLEEVES.map((id) => (
            <StaggerItem key={id}>
              <SleeveCard sleeve={id} className="mx-auto h-[84px] w-[60px]" />
              <div className={label}>{i18n._(SUPPORTER_CARD_SLEEVE_LABELS[id])}</div>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
      <div className={group}>
        <div className={heading}>{t`Binders`}</div>
        <Stagger className="grid grid-cols-4 gap-2">
          {SUPPORTER_BINDERS.map((id) => (
            <StaggerItem key={id}>
              <BinderBook binder={id} className="mx-auto h-[84px] w-[64px]" />
              <div className={label}>{i18n._(SUPPORTER_BINDER_LABELS[id])}</div>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
      <div className={group}>
        <div className={heading}>{t`Wrappers`}</div>
        <Stagger className="grid grid-cols-4 gap-2">
          {SUPPORTER_WRAPPERS.map((id) => (
            <StaggerItem key={id}>
              {wrappers[id] ? (
                <img src={wrappers[id]} alt="" className="mx-auto h-[84px] w-[50px] rounded-[3px] object-cover" />
              ) : (
                <div className="mx-auto h-[84px] w-[50px] rounded-[3px] bg-osu-b6" />
              )}
              <div className={label}>{i18n._(SUPPORTER_WRAPPER_LABELS[id])}</div>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
      <div className={group}>
        <div className={heading}>{t`Openings`}</div>
        <Stagger className="grid grid-cols-4 gap-2">
          {SUPPORTER_BLADES.map((id) => (
            <StaggerItem key={id}>
              {/* a tap plays how the pack gives */}
              <button
                type="button"
                onPointerEnter={() => warmBladeSounds(bladeLook(id).sound)}
                onClick={() => playBladeRip(id, bladeLook(id).sound)}
                className="block w-full cursor-pointer"
                aria-label={i18n._(SUPPORTER_BLADE_LABELS[id])}
              >
                <BladeLoop blade={id} className="h-[84px] w-full rounded-md bg-osu-b6" />
              </button>
              <div className={label}>{i18n._(SUPPORTER_BLADE_LABELS[id])}</div>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </div>
  );
}

/* --- Profile stats ------------------------------------------------------------- */

const SAMPLE_STATS: Required<ProfileStatsData> = {
  ratio: { perfect: 48_210, great: 9_118 },
  lnSplit: { ln: 1_288, rice: 3_402 },
  streak: { longest: 41, current: 6 },
  percentile: { rank: 812, players: 24_310 },
  session: { minutes: 287, plays: 96, startedAt: "2026-09-12T19:40:00.000Z" },
  notes: { hit: 14_230_000, plays: 18_402 },
  hours: [52, 31, 18, 9, 4, 2, 1, 2, 4, 6, 9, 12, 15, 18, 22, 31, 44, 58, 71, 86, 98, 104, 93, 74],
};
const SAMPLE_SKILL = { label: "Jumpstream", color: "#6f87d8", value: 26.4, keyCount: 4, runnerUp: { label: "Stamina", value: 25.1 } };

/* The eight cards on example numbers for everyone: a visitor's own would
   cost a profile request per page view, for a preview. */
export function StatsShowcase() {
  const { t } = useLingui();
  const data = SAMPLE_STATS;
  return (
    <div>
      <Stagger className="grid grid-cols-1 gap-px overflow-hidden rounded-xl sm:grid-cols-2 lg:grid-cols-4">
        <StaggerItem lift={false} className="grid"><RatioCard ratio={data.ratio} /></StaggerItem>
        <StaggerItem lift={false} className="grid"><LnSplitCard lnSplit={data.lnSplit} /></StaggerItem>
        <StaggerItem lift={false} className="grid"><StreakCard streak={data.streak} /></StaggerItem>
        <StaggerItem lift={false} className="grid"><PercentileCard percentile={data.percentile} /></StaggerItem>
        <StaggerItem lift={false} className="grid"><SessionCard session={data.session} /></StaggerItem>
        <StaggerItem lift={false} className="grid"><NotesCard notes={data.notes} /></StaggerItem>
        <StaggerItem lift={false} className="grid"><SkillCard userId={null} sample={SAMPLE_SKILL} /></StaggerItem>
        <StaggerItem lift={false} className="grid"><HoursCard hours={data.hours} /></StaggerItem>
      </Stagger>
      <p className="mt-2 text-[11px] text-osu-f1">{t`Example numbers.`}</p>
    </div>
  );
}

/* --- Share links ----------------------------------------------------------------- */

/* A chat message with a shared clip in it: a few seconds of a real export,
   muted and looping. */
export function ClipShowcase() {
  const { t } = useLingui();
  const you = useShowcaseViewer();
  const reduced = useReducedMotion();
  return (
    <div className="overflow-hidden rounded-xl bg-[#313338] p-4 font-[system-ui]">
      <motion.div
        className="flex gap-3"
        initial={reduced ? false : { opacity: 0, y: 50 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "0px 0px -15% 0px" }}
        transition={{ type: "spring", stiffness: 300, damping: 24, delay: 0.2 }}
      >
        <img src={you.avatar} alt="" className="h-10 w-10 shrink-0 rounded-full bg-osu-b3 object-cover" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-semibold text-white">{you.name}</span>
            <span className="text-[12px] text-[#949ba4]">{t`Today at 21:14`}</span>
          </div>
          <div className="text-[15px] text-[#00a8fc]">mania-tracker.com/c/k3f9a2qd</div>
          <video
            src="/images/support/share-clip.mp4"
            poster="/images/support/share-clip.jpg"
            autoPlay={!reduced}
            muted
            loop
            playsInline
            preload="metadata"
            className="mt-1.5 block aspect-[1590/720] w-full max-w-[520px] rounded-lg bg-black"
          />
        </div>
      </motion.div>
    </div>
  );
}

/* --- Gift ------------------------------------------------------------------------- */

export function GiftShowcase() {
  return <GiftTicket3D fallback={<GiftTicketFlat />} />;
}

/* The ticket drawn flat, where WebGL is missing. */
function GiftTicketFlat() {
  const { t } = useLingui();
  const reduced = useReducedMotion();
  return (
    <motion.div
      className="group relative mx-auto flex max-w-[520px] text-white [filter:drop-shadow(0_14px_28px_rgba(0,0,0,0.45))]"
      initial={reduced ? false : { opacity: 0, scale: 0.8, rotate: -6, y: 30 }}
      whileInView={{ opacity: 1, scale: 1, rotate: -1.5, y: 0 }}
      whileHover={{ rotate: 0, scale: 1.03 }}
      viewport={{ once: true, margin: "0px 0px -15% 0px" }}
      transition={{ type: "spring", stiffness: 240, damping: 14 }}
    >
      {/* The ticket: punched where it meets the stub, a fine guilloche of
          stripes under the print, and a glint that crosses it on hover. */}
      <div className="gift-ticket relative min-w-0 flex-1 overflow-hidden rounded-l-2xl bg-[linear-gradient(135deg,#ff7ab6_0%,#ff4f9a_45%,#c2357a_100%)] px-6 py-5">
        <div className="absolute inset-0 bg-[repeating-linear-gradient(115deg,rgba(255,255,255,0.07)_0_2px,transparent_2px_9px)]" />
        <div className="gift-ticket-glint absolute inset-y-0 -left-1/2 w-1/3 bg-gradient-to-r from-transparent via-white/35 to-transparent" />
        <div className="relative">
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-white/80">
            <img src="/images/icons/supporter-gem.svg" alt="" className="h-4 w-4 brightness-0 invert" />
            {t`Gift`}
          </div>
          <div className="mt-1 text-[20px] font-black leading-tight sm:text-[22px]">{t`One week of supporter`}</div>
          <ScrambleCode code="K7QDM2XP" />
        </div>
      </div>
      {/* The tear line, with a notch bitten out at each end. */}
      <div className="relative w-0">
        <span className="absolute -left-[10px] -top-[10px] z-10 h-5 w-5 rounded-full bg-osu-b5" />
        <span className="absolute -bottom-[10px] -left-[10px] z-10 h-5 w-5 rounded-full bg-osu-b5" />
        <span className="absolute inset-y-3 -left-px border-l-2 border-dotted border-white/50" />
      </div>
      {/* The stub, printed on holo foil. */}
      <div className="relative w-[96px] shrink-0 overflow-hidden rounded-r-2xl bg-[#2a2440] sm:w-[112px]">
        <FoilPreview foil="holo" className="absolute inset-0 h-full w-full" />
        <div className="relative flex h-full flex-col items-center justify-center text-center">
          <div className="text-[44px] font-black leading-none tabular-nums [text-shadow:0_2px_8px_rgba(0,0,0,0.35)]">7</div>
          <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.18em] text-white/90">{t`days`}</div>
        </div>
      </div>
    </motion.div>
  );
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/* A gift code whose characters spin like reels and land one by one, the first
   time it scrolls into view. */
function ScrambleCode({ code }: { code: string }) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -15% 0px" });
  const [shown, setShown] = useState(code);
  const [landed, setLanded] = useState(code.length);
  useEffect(() => {
    if (!inView || reduced) return;
    const start = performance.now();
    const timer = window.setInterval(() => {
      const count = Math.max(0, Math.floor((performance.now() - start - 250) / 110));
      setLanded(count);
      setShown(Array.from(code, (ch, i) => (i < count ? ch : CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)])).join(""));
      if (count >= code.length) window.clearInterval(timer);
    }, 45);
    return () => window.clearInterval(timer);
  }, [inView, reduced, code]);
  const half = code.length / 2;
  return (
    <div ref={ref} className="mt-3 flex items-center gap-1" aria-label={formatGiftCode(code)}>
      {Array.from(shown, (ch, i) => (
        <span key={i} className="contents">
          {i === half && <span className="mx-0.5 h-[3px] w-2.5 rounded-full bg-white/70" />}
          <motion.span
            className="inline-flex h-10 w-[30px] items-center justify-center rounded-md bg-black/25 font-mono text-[22px] font-bold sm:h-11 sm:w-[34px] sm:text-[24px]"
            animate={i < landed ? { scale: [1.25, 1], backgroundColor: ["rgba(255,255,255,0.45)", "rgba(0,0,0,0.25)"] } : undefined}
            transition={{ duration: 0.35 }}
          >
            {ch}
          </motion.span>
        </span>
      ))}
    </div>
  );
}
