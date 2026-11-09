import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";

import { LiveDfjkKeys } from "./LiveDfjkKeys";
import { LiveSevenKey } from "./LiveSevenKey";
import { startNoteHighway } from "./liveNoteHighway";
import { danBareLabel, getDanImageSrc } from "../../lib/dan-images";
import { fetchLiveSupporterProfileLook } from "../../lib/live-backend";
import { DAN_SKILLSET_META } from "../../lib/skill-axes";
import { isDrawableFrame, subscribeWorkshopFrames, supporterFrameGeometry, supporterFrameSrc, workshopFramesVersion, type FrameDan, type SupporterAvatarFrameId } from "../../lib/supporter-avatar-frames";

/* The frame art over a supporter's avatar. Place it inside a relative box the
   exact size of the avatar; it reaches past that box by the frame's overhang
   (frameOverhangMargins reserves the room). It loops as a transparent WebM
   where the browser can show VP9 alpha, and stays the still PNG on Safari and
   every iOS browser (WebKit drops the alpha), under reduced motion, and during
   SSR. `still` holds it on the PNG anyway (a picker sweeping through frames
   would otherwise start a video decode per frame), as does a still-only frame.
   A frame with a dan window lays the wearer's own dan badge (`userId`) on its
   art; with no one to ask (a signed-out showcase) it shows a sample. */

const SAMPLE_DAN: FrameDan = { key: "4:rc:overall", label: "alpha", family: "rc", keyCount: 4, skillset: null };

/* Bumped when the viewer picks another dan, so every frame showing theirs asks again. */
let danPickVersion = 0;
const danPickListeners = new Set<() => void>();
export function announceFrameDanPicked(): void {
  danPickVersion += 1;
  for (const listener of danPickListeners) listener();
}
function subscribeDanPicks(listener: () => void): () => void {
  danPickListeners.add(listener);
  return () => danPickListeners.delete(listener);
}

function useFrameDan(frame: SupporterAvatarFrameId, userId: number | null | undefined): FrameDan | null {
  const wants = Boolean(supporterFrameGeometry(frame).danWindow);
  const [dan, setDan] = useState<{ userId: number; dan: FrameDan | null } | null>(null);
  const picks = useSyncExternalStore(subscribeDanPicks, () => danPickVersion, () => 0);
  useEffect(() => {
    if (!wants || !userId) return;
    let alive = true;
    void fetchLiveSupporterProfileLook(userId).then((value) => {
      if (alive) setDan({ userId, dan: value.dan });
    });
    return () => {
      alive = false;
    };
  }, [wants, userId, picks]);
  if (!wants) return null;
  if (!userId) return SAMPLE_DAN;
  return dan?.userId === userId ? dan.dan : null;
}

/* The name a name-label frame prints: the one handed in, else the wearer's
   (`userId`), else a sample. Null while theirs is still on its way. */
function useFrameName(frame: SupporterAvatarFrameId, userId: number | null | undefined, name: string | null | undefined): string | null {
  const wants = Boolean(supporterFrameGeometry(frame).nameLabel) && !name;
  const [found, setFound] = useState<{ userId: number; name: string | null } | null>(null);
  useEffect(() => {
    if (!wants || !userId) return;
    let alive = true;
    void fetchLiveSupporterProfileLook(userId).then((value) => {
      if (alive) setFound({ userId, name: value.username });
    });
    return () => {
      alive = false;
    };
  }, [wants, userId]);
  if (name) return name;
  if (!wants) return null;
  if (!userId) return "player";
  return found?.userId === userId ? found.name : null;
}

function canPlayAlphaVideo(): boolean {
  const ua = navigator.userAgent;
  const webKitOnly = /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
  if (webKitOnly) return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  return document.createElement("video").canPlayType('video/webm; codecs="vp9"') !== "";
}

export function SupporterAvatarFrame({ frame, still: holdStill = false, round = false, userId, name }: { frame: SupporterAvatarFrameId; still?: boolean; /* drawn round, as lists do */ round?: boolean; userId?: number | null; /* the wearer's name, where the caller has it (saves a name-label frame asking) */ name?: string | null }) {
  const [animate, setAnimate] = useState(false);
  useEffect(() => setAnimate(canPlayAlphaVideo()), []);
  const dan = useFrameDan(frame, userId);
  const label = useFrameName(frame, userId, name);
  const { i18n } = useLingui();
  // a workshop frame draws once its art has arrived with some payload
  useSyncExternalStore(subscribeWorkshopFrames, workshopFramesVersion, () => 0);
  if (!isDrawableFrame(frame)) return null;

  const geometry = supporterFrameGeometry(frame);
  const [left, top, width, height] = geometry.box;
  const style: CSSProperties = {
    left: `${left * 100}%`,
    top: `${top * 100}%`,
    width: `${width * 100}%`,
    height: `${height * 100}%`,
  };
  const className = "pointer-events-none absolute max-w-none select-none";
  const still = supporterFrameSrc(frame, "still", { round });

  const playing = animate && !holdStill;
  if (geometry.nameLabel) return <LiveDesktopIcon name={label} playing={playing} className={className} style={style} />;
  // the DFJK keycaps and the 7K board also answer the viewer's own keys (LiveDfjkKeys, LiveSevenKey)
  const liveKeys = playing && (frame === "dfjk-keys" || frame === "seven-key");
  const wrapped = Boolean(geometry.danWindow) || liveKeys;
  const fill = wrapped ? "absolute inset-0 h-full w-full" : className;
  const fillStyle = wrapped ? undefined : style;
  const art = playing && !geometry.stillOnly ? (
    <video
      key={frame}
      src={supporterFrameSrc(frame, "video")}
      poster={still}
      autoPlay
      loop
      muted
      playsInline
      disablePictureInPicture
      aria-hidden
      className={fill}
      style={fillStyle}
    />
  ) : (
    <img key={frame} src={still} alt="" aria-hidden draggable={false} loading={holdStill ? "lazy" : undefined} className={fill} style={fillStyle} />
  );
  if (liveKeys) {
    // the keys hint sits just under the drawn art, not under the canvas
    const hintTop = `${(((1 + geometry.overhang[3] - top) / height) * 100).toFixed(2)}%`;
    return frame === "seven-key" ? <LiveSevenKey style={style} hintTop={hintTop}>{art}</LiveSevenKey> : <LiveDfjkKeys style={style} hintTop={hintTop}>{art}</LiveDfjkKeys>;
  }
  // Note highway plays live, so its chart never repeats
  if (playing && frame === "note-highway") return <LiveNoteHighway key={frame} className={className} style={style} />;
  if (!geometry.danWindow) return art;

  // the art and the badge move as one, so the art's swing is CSS, not in the video
  const [wx, wy, ww, wh] = geometry.danWindow;
  const pivot = geometry.swingPivot;
  // the plain badge: the tier-marked drawings widen to the right and would not fit the window
  const badge = dan ? getDanImageSrc(danBareLabel(dan.label), dan.family, dan.keyCount) : null;
  return (
    <div
      aria-hidden
      className={`${className} ${playing && pivot ? "frame-swing" : ""}`}
      style={{ ...style, transformOrigin: pivot ? `${pivot[0] * 100}% ${pivot[1] * 100}%` : undefined }}
    >
      {art}
      {badge && (
        <img
          src={badge}
          alt=""
          draggable={false}
          className="absolute object-contain"
          style={{ left: `${wx * 100}%`, top: `${wy * 100}%`, width: `${ww * 100}%`, height: `${wh * 100}%` }}
        />
      )}
      {dan && geometry.danText && <DanCardText dan={dan} rect={geometry.danText} line={frameDanLine(dan, i18n._.bind(i18n))} />}
      {playing && pivot && geometry.sheenCard && (
        // the laminate catches the light only while the card turns, in step with the swing
        <span
          className="frame-sheen absolute"
          style={{
            left: `${geometry.sheenCard[0] * 100}%`,
            top: `${geometry.sheenCard[1] * 100}%`,
            width: `${geometry.sheenCard[2] * 100}%`,
            height: `${geometry.sheenCard[3] * 100}%`,
            borderRadius: `${geometry.sheenCard[4] * 100}% / ${(geometry.sheenCard[4] * geometry.sheenCard[2] / geometry.sheenCard[3]) * 100}%`,
          }}
        />
      )}
    </div>
  );
}

function LiveNoteHighway({ className, style }: { className: string; style: CSSProperties }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => (ref.current ? startNoteHighway(ref.current) : undefined), []);
  return <svg ref={ref} aria-hidden viewBox="0 -28 184 212" className={className} style={style} />;
}

/* The Desktop icon frame's shortcut arrow, an 11 x 11 pixel box at 2.5 units a
   pixel with its corner at (30, 126.5), and the selection dither over it. */
const SHORTCUT_ARROW = ["...#####.", "....####.", ".....###.", "....##.#.", "...##....", "..##.....", "..##....."]
  .flatMap((row, y) => [...row].map((cell, x) => (cell === "#" ? `M${32.5 + x * 2.5},${131.5 + y * 2.5}h2.5v2.5h-2.5z` : "")))
  .join("");
const SHORTCUT_DITHER = Array.from({ length: 18 * 18 }, (_, i) => [i % 18, Math.floor(i / 18)])
  .filter(([x, y]) => (x + y) % 2 === 0)
  .map(([x, y]) => `M${32.5 + x * 1.25},${129 + y * 1.25}h1.25v1.25h-1.25z`)
  .join("");
/* The label is never wider than the avatar; a longer name is squeezed to fit. */
const DESKTOP_LABEL_MAX = 116;

/* The Desktop icon frame, drawn live because its label is the wearer's name:
   a shortcut arrow on the avatar's corner and the name on a plate under it.
   Playing, a rubber band drags across and selects it (the clock is in
   styles.css); at rest it stays selected. The design it follows is
   foundry/designs/desktop-icon. */
function LiveDesktopIcon({ name, playing, className, style }: { name: string | null; playing: boolean; className: string; style: CSSProperties }) {
  const text = useRef<SVGTextElement>(null);
  const [measured, setMeasured] = useState<{ name: string; width: number } | null>(null);
  useEffect(() => {
    const width = name ? text.current?.getComputedTextLength() : 0;
    if (name && width) setMeasured({ name, width });
  }, [name]);
  // until it is measured, a guess from the letter count
  const natural = name ? (measured?.name === name ? measured.width : name.length * 6.6) : 0;
  const width = Math.min(DESKTOP_LABEL_MAX, natural);
  const plate = Math.round(width) + 8;
  const left = Math.round(92 - plate / 2);
  return (
    <svg
      aria-hidden
      viewBox="0 0 184 196"
      className={`${className} ${playing ? "desktop-icon-live" : ""}`}
      style={{ ...style, filter: "drop-shadow(0 1px 1.2px rgb(0 0 0 / 0.5))" }}
    >
      <rect x="30" y="126.5" width="27.5" height="27.5" fill="#000" />
      <rect x="32.5" y="129" width="22.5" height="22.5" fill="#fff" />
      <path d={SHORTCUT_ARROW} fill="#000" />
      <path className="desktop-icon-mark" d={SHORTCUT_DITHER} fill="#000080" />
      {name && (
        <>
          <rect className="desktop-icon-plate" x={left} y="161" width={plate} height="18" fill="#000080" />
          <text
            ref={text}
            x={left + plate / 2}
            y="174.4"
            fontSize="13"
            textAnchor="middle"
            fill="#fff"
            fontFamily='Arial, "Liberation Sans", Helvetica, sans-serif'
            textLength={natural > DESKTOP_LABEL_MAX ? DESKTOP_LABEL_MAX : undefined}
            lengthAdjust="spacingAndGlyphs"
          >
            {name}
          </text>
          <rect className="desktop-icon-mark" x={left + 0.5} y="161.5" width={plate - 1} height="17" fill="none" stroke="#ffff7f" strokeDasharray="1 1" />
        </>
      )}
      <g className="desktop-icon-band" fill="none">
        <rect x="14.5" y="14.5" width="156" height="172" stroke="#fff" vectorEffect="non-scaling-stroke" />
        <rect x="14.5" y="14.5" width="156" height="172" stroke="#000" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
      </g>
    </svg>
  );
}

/* The card's second line: the skillset (or Overall), LN, and the keymode. */
export function frameDanLine(dan: FrameDan, translate: (descriptor: { id: string; message?: string }) => string): string {
  const skill = dan.skillset ? DAN_SKILLSET_META[dan.skillset] : undefined;
  const name = dan.skillset ? (skill ? translate(skill.labelMsg) : dan.skillset) : translate(msg`Overall`);
  return [name, dan.family === "ln" ? "LN" : null, `${dan.keyCount}K`].filter(Boolean).join(" ");
}

/* "gamma++" reads "Gamma++"; numbered dans stay as they are. */
export function frameDanName(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/* The printed lines, in an SVG sized to the card's text area so they scale
   with the frame at every size it shows at. */
function DanCardText({ dan, rect, line }: { dan: FrameDan; rect: readonly [number, number, number, number]; line: string }) {
  const [x, y, w, h] = rect;
  const name = frameDanName(dan.label);
  return (
    <svg
      viewBox="0 0 48.75 24.3"
      className="absolute overflow-visible"
      style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%`, fontFamily: "Tracker Round, sans-serif" }}
    >
      <text x="0" y="9.5" fill="#2b3142" fontSize={name.length > 7 ? 8 : 10} fontWeight={700} textLength={name.length > 9 ? 48 : undefined} lengthAdjust="spacingAndGlyphs">{name}</text>
      <text x="0" y="20.5" fill="#2b3142" fillOpacity={0.8} fontSize={line.length > 14 ? 5.4 : 6.5} fontWeight={600}>{line}</text>
    </svg>
  );
}

/* Margins that make room for a frame's overhang around an avatar `size` wide
   (any CSS length). `allowance` is how much of the overhang above and below
   the surrounding padding can already absorb, `leftAllowance` how much on the
   left (empty page gutter the art may spread into, so the avatar does not
   move for it). */
export function frameOverhangMargins(frame: SupporterAvatarFrameId, size: string, allowance = "0px", leftAllowance = "0px"): CSSProperties {
  const [left, top, right, bottom] = supporterFrameGeometry(frame).overhang;
  const vertical = (share: number) => `max(0px, calc(${size} * ${share} - ${allowance}))`;
  return {
    marginLeft: `max(0px, calc(${size} * ${left} - ${leftAllowance}))`,
    marginRight: `calc(${size} * ${right})`,
    marginTop: vertical(top),
    marginBottom: vertical(bottom),
  };
}
