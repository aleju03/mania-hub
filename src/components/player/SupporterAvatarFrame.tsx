import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";

import { danBareLabel, getDanImageSrc } from "../../lib/dan-images";
import { fetchLiveSupporterProfileLook } from "../../lib/live-backend";
import { DAN_SKILLSET_META } from "../../lib/skill-axes";
import { supporterFrameGeometry, supporterFrameSrc, type FrameDan, type SupporterAvatarFrameId } from "../../lib/supporter-avatar-frames";

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

function canPlayAlphaVideo(): boolean {
  const ua = navigator.userAgent;
  const webKitOnly = /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
  if (webKitOnly) return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  return document.createElement("video").canPlayType('video/webm; codecs="vp9"') !== "";
}

export function SupporterAvatarFrame({ frame, still: holdStill = false, round = false, userId }: { frame: SupporterAvatarFrameId; still?: boolean; /* drawn round, as lists do */ round?: boolean; userId?: number | null }) {
  const [animate, setAnimate] = useState(false);
  useEffect(() => setAnimate(canPlayAlphaVideo()), []);
  const dan = useFrameDan(frame, userId);
  const { i18n } = useLingui();

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
  const fill = geometry.danWindow ? "absolute inset-0 h-full w-full" : className;
  const fillStyle = geometry.danWindow ? undefined : style;
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
      style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%`, fontFamily: "Torus, sans-serif" }}
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
