import { forwardRef, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "framer-motion";
import { useLingui } from "@lingui/react/macro";

import { ManiaCard3DPanel } from "../player/maniacard3d/LazyManiaCard3DPanel";
import { SupporterAvatarFrame } from "../player/SupporterAvatarFrame";
import { LnSplitCard, PercentileCard, RatioCard, StreakCard } from "../player/ProfileStatCards";
import { ProfileThemeBackdrop, ProfileThemeSwatch } from "./ProfileThemeBackdrop";
import { SupporterStyledName } from "./SupporterNameStyle";
import { FoilPreview } from "./FoilPreview";
import { GiftTicket3D } from "./GiftTicket3D";
import { BinderBook, FoilCard, FrameThumb, SleeveCard, wrapperThumb } from "./LoadoutSlots";
import { BladeSwatch } from "../packs/BladeSwatch";
import { playBladeRip, warmBladeSounds } from "../packs/packSfx";
import { bladeLook } from "../packs/packBlades";
import { FRAME_NAMES, MOTIF_LABELS } from "./loadout";
import { formatGiftCode } from "./GiftCodePanel";
import { Stagger, StaggerItem, useNearView } from "./SupportMotion";
import { useAuth } from "../../lib/auth-context";
import { fetchLivePackCardSnapshotDirect, fetchLiveSupporterProfileLook, type LivePackCardSnapshot } from "../../lib/live-backend";
import { framedAvatarStyle, supporterFrameGeometry, type SupporterAvatarFrameId } from "../../lib/supporter-avatar-frames";
import { SUPPORTER_FOIL_LABELS, SUPPORTER_FOILS, type SupporterFoilId } from "../../lib/supporter-foils";
import { SUPPORTER_MOTIF_IDS, supporterMotifPath, type SupporterMotifId } from "../../lib/supporter-motif-art";
import { SUPPORTER_NAME_FONT_LABELS, type SupporterNameFontId } from "../../lib/supporter-name-fonts";
import { SUPPORTER_NAME_STYLE_LABELS, type SupporterNameStyleId } from "../../lib/supporter-name-styles";
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
} from "../../lib/supporter-pack-style";
import type { ProfileStatsData } from "../../lib/profile-stats";
import type { SupporterLook } from "../../lib/supporter-card-looks";

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

/* Steps through `count` items every `ms` until the visitor picks one, which holds it. */
function useCycle(count: number, ms: number, active: boolean) {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held || reduced || count < 2 || !active) return;
    const timer = window.setInterval(() => setIndex((n) => (n + 1) % count), ms);
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
   live, through a soft-edged circle that grows from the middle. The revealed
   backdrop stays as it is once it covers the box (the one under it goes), so
   its animation runs on without a restart. */
const REVEAL_MS = 900;

const ThemeStage = forwardRef<HTMLDivElement, { theme: SupporterProfileThemeId; className?: string; children: ReactNode }>(function ThemeStage({ theme, className = "", children }, ref) {
  const reduced = useReducedMotion();
  const [layers, setLayers] = useState<{ id: number; theme: SupporterProfileThemeId }[]>(() => [{ id: 0, theme }]);
  const top = layers[layers.length - 1];
  useEffect(() => {
    if (theme === top.theme) return;
    const id = performance.now();
    setLayers((current) => (reduced ? [{ id, theme }] : [...current.slice(-1), { id, theme }]));
    if (reduced) return;
    const settle = window.setTimeout(() => setLayers((current) => current.filter((layer) => layer.id >= id)), REVEAL_MS + 100);
    return () => window.clearTimeout(settle);
  }, [theme]); // eslint-disable-line react-hooks/exhaustive-deps

  const mask = "radial-gradient(circle at 50% 55%, #000 calc(var(--reveal) - 18%), transparent var(--reveal))";
  return (
    <div ref={ref} className={`relative isolate overflow-hidden bg-osu-b6 ${className}`} style={profileThemeStyle(top.theme)}>
      {layers.map((layer, index) => (
        <motion.div
          key={layer.id}
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ zIndex: index - 10, ...(layer.id === 0 ? {} : { maskImage: mask, WebkitMaskImage: mask }) } as CSSProperties}
          initial={layer.id === 0 ? false : ({ "--reveal": "0%", scale: 1.06 } as never)}
          animate={{ "--reveal": "135%", scale: 1 } as never}
          transition={{ duration: REVEAL_MS / 1000, ease: [0.45, 0, 0.2, 1] }}
        >
          <ProfileThemeBackdrop theme={layer.theme} maxPixels={420_000} className="absolute inset-0" />
        </motion.div>
      ))}
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

const HERO_LOOKS: HeroLook[] = [
  { theme: "cosmos", frame: "stellium-orbit", nameStyle: "galaxy", nameFont: "orbitron" },
  { theme: "sakura", frame: "sakura", nameStyle: "pearl", nameFont: "pacifico" },
  { theme: "terminal", frame: "term-window", nameStyle: "terminal", nameFont: "vt323" },
  { theme: "synthwave", frame: "neon-ears", nameStyle: "neon", nameFont: "monoton" },
  { theme: "aurora", frame: "halo-cyan", nameStyle: "aurora", nameFont: null },
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
            <motion.div key={look.frame} {...fade} className="relative" style={{ width: size, height: size }}>
              <img src={you.avatar} alt="" className="h-full w-full max-w-none rounded-2xl bg-osu-b3 object-cover" style={framedAvatarStyle(look.frame)} />
              <SupporterAvatarFrame frame={look.frame} still={!near} />
            </motion.div>
          </AnimatePresence>
        </div>
        <AnimatePresence mode="wait">
          <motion.div key={`${look.nameStyle}|${look.nameFont}`} {...fade} className="mt-2 flex max-w-full justify-center">
            <SupporterStyledName
              nameStyle={look.nameStyle}
              nameFont={look.nameFont}
              name={you.name}
              live={near}
              className="max-w-full truncate px-2 py-[0.3em] -my-[0.3em] text-[34px] font-black leading-none text-white sm:text-[44px]"
            />
          </motion.div>
        </AnimatePresence>
      </button>
      <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 bg-black/35 px-4 py-2.5 text-[11px] font-semibold text-white/80">
        <span>{i18n._(SUPPORTER_PROFILE_THEME_LABELS[look.theme])}</span>
        <span aria-hidden className="h-2.5 w-px bg-white/30" />
        <span>{frameName ? `${i18n._(frameName.label)}${frameName.variant ? ` ${frameName.variant}` : ""}` : look.frame}</span>
        <span aria-hidden className="h-2.5 w-px bg-white/30" />
        <span>
          {i18n._(SUPPORTER_NAME_STYLE_LABELS[look.nameStyle])}
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

const SHOWN_FRAMES: SupporterAvatarFrameId[] = [
  "wings-pink-3", "witch-hat", "term-window", "sakura",
  "ln-hold-9", "five-star-pull", "crt-monitor", "halo-pink",
];

export function FramesShowcase() {
  const { i18n } = useLingui();
  const you = useShowcaseViewer();
  const [ref, near] = useNearView<HTMLDivElement>();
  return (
    <div ref={ref}>
    <Stagger className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-4">
      {SHOWN_FRAMES.map((frame) => {
        const name = FRAME_NAMES.get(frame);
        return (
          <StaggerItem key={frame} className="flex flex-col items-center">
            <FrameThumb frame={frame} avatar={you.avatar} size={118} live={near} />
            <div className="mt-1 text-center text-[11px] text-osu-f1">
              {name ? `${i18n._(name.label)}${name.variant ? ` ${name.variant}` : ""}` : frame}
            </div>
          </StaggerItem>
        );
      })}
    </Stagger>
    </div>
  );
}

/* --- Names --------------------------------------------------------------------- */

const SHOWN_NAMES: [SupporterNameStyleId, SupporterNameFontId | null][] = [
  ["holo", null],
  ["neon", "monoton"],
  ["glitch", "rubikglitch"],
  ["molten-gold", "cinzel"],
  ["pixel", "silkscreen"],
  ["note-rain", "bungee"],
  ["ink", "marker"],
];

export function NamesShowcase() {
  const { i18n } = useLingui();
  const you = useShowcaseViewer();
  const [ref, near] = useNearView<HTMLDivElement>();
  return (
    <div ref={ref}>
    <Stagger className="divide-y divide-white/[0.07]">
      {SHOWN_NAMES.map(([style, font]) => (
        <StaggerItem key={style} lift={false} className="flex items-center justify-between gap-4 py-2.5">
          <SupporterStyledName nameStyle={style} nameFont={font} name={you.name} live={near} className="min-w-0 truncate px-2 -mx-2 py-[0.3em] -my-[0.3em] text-[26px] font-black leading-none text-white sm:text-[30px]" />
          <span className="shrink-0 text-right text-[11px] text-osu-f1">
            {i18n._(SUPPORTER_NAME_STYLE_LABELS[style])}
            {font ? `, ${i18n._(SUPPORTER_NAME_FONT_LABELS[font])}` : ""}
          </span>
        </StaggerItem>
      ))}
    </Stagger>
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
  // The art stays put: new art repaints every texture on the 3D card, a new foil only swaps two shader values.
  const [motif, setMotif] = useState<SupporterMotifId>("stars");
  const look = useMemo<SupporterLook>(() => ({ motif, foil }), [motif, foil]);

  return (
    <div ref={ref} className="grid items-center gap-5 sm:grid-cols-[minmax(0,270px)_minmax(0,1fr)]">
      <div className="mx-auto w-full max-w-[270px]">
        {card ? (
          <ManiaCard3DPanel user={card.user} scores={card.scores} loading={false} isOwnProfile supporterLookOverride={look} showTierProgress={false} />
        ) : card === undefined ? (
          <div className="aspect-[5/7] animate-pulse rounded-xl bg-osu-b6" />
        ) : (
          <CardHand foil={foil} motif={motif} />
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
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-white/[0.07] pt-4">
          {SUPPORTER_MOTIF_IDS.map((id) => (
            <motion.button
              key={id}
              type="button"
              onClick={() => setMotif(id)}
              aria-pressed={id === motif}
              title={i18n._(MOTIF_LABELS[id])}
              whileHover={{ scale: 1.15, rotate: -6 }}
              whileTap={{ scale: 0.9 }}
              className="cursor-pointer"
            >
              <img src={supporterMotifPath(id)} alt={i18n._(MOTIF_LABELS[id])} className={`h-9 w-9 object-contain transition-opacity ${id === motif ? "opacity-100" : "opacity-45"}`} />
            </motion.button>
          ))}
        </div>
      </div>
    </div>
  );
}

function CardHand({ foil, motif }: { foil: SupporterFoilId; motif: SupporterMotifId }) {
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
          {i === 2 && <img src={supporterMotifPath(motif)} alt="" className="pointer-events-none absolute inset-0 m-auto h-[46%] w-[66%] object-contain opacity-80" />}
        </motion.div>
      ))}
    </div>
  );
}

/* --- Packs ----------------------------------------------------------------------- */

export function PacksShowcase() {
  const { t, i18n } = useLingui();
  const [wrappers, setWrappers] = useState<string[] | null>(null);
  // Drawn on a canvas, so only after mount.
  useEffect(() => setWrappers(SUPPORTER_WRAPPERS.map((id) => wrapperThumb(id))), []);
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
          {SUPPORTER_WRAPPERS.map((id, i) => (
            <StaggerItem key={id}>
              {wrappers ? (
                <img src={wrappers[i]} alt="" className="mx-auto h-[84px] w-[50px] rounded-[3px] object-cover" />
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
              <button type="button" onPointerEnter={() => warmBladeSounds(bladeLook(id).sound)} onClick={() => playBladeRip(id, bladeLook(id).sound)} className="block w-full cursor-pointer" aria-label={i18n._(SUPPORTER_BLADE_LABELS[id])}>
                <BladeSwatch blade={id} live className="h-[84px] w-full rounded-md bg-osu-b6" />
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
};

export function StatsShowcase() {
  const { t } = useLingui();
  const viewerId = useAuth().viewer?.id ?? null;
  const [own, setOwn] = useState<Required<ProfileStatsData> | null>(null);
  useEffect(() => {
    if (!viewerId) return;
    let alive = true;
    void fetchLiveSupporterProfileLook(viewerId).then((look) => {
      const data = look.profileStatsData;
      if (alive && data.ratio && data.lnSplit && data.streak && data.percentile) setOwn(data as Required<ProfileStatsData>);
    });
    return () => {
      alive = false;
    };
  }, [viewerId]);
  const data = own ?? SAMPLE_STATS;
  return (
    <div>
      <Stagger className="grid grid-cols-1 gap-px overflow-hidden rounded-xl sm:grid-cols-2 lg:grid-cols-4">
        <StaggerItem lift={false} className="grid"><RatioCard ratio={data.ratio} /></StaggerItem>
        <StaggerItem lift={false} className="grid"><LnSplitCard lnSplit={data.lnSplit} /></StaggerItem>
        <StaggerItem lift={false} className="grid"><StreakCard streak={data.streak} /></StaggerItem>
        <StaggerItem lift={false} className="grid"><PercentileCard percentile={data.percentile} /></StaggerItem>
      </Stagger>
      <p className="mt-2 text-[11px] text-osu-f1">{own ? t`Your numbers.` : t`Example numbers.`}</p>
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
          <div className="text-[15px] text-[#dbdee1]">{t`new pb`}</div>
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
            <img src="/images/icons/supporter-heart.svg" alt="" className="h-4 w-4 brightness-0 invert" />
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
