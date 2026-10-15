import { useEffect, useState, type CSSProperties } from "react";

import { supporterFrameGeometry, supporterFrameSrc, type SupporterAvatarFrameId } from "../../lib/supporter-avatar-frames";

/* The frame art over a supporter's avatar. Place it inside a relative box the
   exact size of the avatar; it reaches past that box by the frame's overhang
   (frameOverhangMargins reserves the room). It loops as a transparent WebM
   where the browser can show VP9 alpha, and stays the still PNG on Safari and
   every iOS browser (WebKit drops the alpha), under reduced motion, and during
   SSR. */

function canPlayAlphaVideo(): boolean {
  const ua = navigator.userAgent;
  const webKitOnly = /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
  if (webKitOnly) return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  return document.createElement("video").canPlayType('video/webm; codecs="vp9"') !== "";
}

export function SupporterAvatarFrame({ frame }: { frame: SupporterAvatarFrameId }) {
  const [animate, setAnimate] = useState(false);
  useEffect(() => setAnimate(canPlayAlphaVideo()), []);

  const [left, top, width, height] = supporterFrameGeometry(frame).box;
  const style: CSSProperties = {
    left: `${left * 100}%`,
    top: `${top * 100}%`,
    width: `${width * 100}%`,
    height: `${height * 100}%`,
  };
  const className = "pointer-events-none absolute max-w-none select-none";
  const still = supporterFrameSrc(frame, "still");

  return animate ? (
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
      className={className}
      style={style}
    />
  ) : (
    <img key={frame} src={still} alt="" aria-hidden draggable={false} className={className} style={style} />
  );
}

/* Margins that make room for a frame's overhang around an avatar `size` wide
   (any CSS length). `allowance` is how much of the overhang above and below
   the surrounding padding can already absorb. */
export function frameOverhangMargins(frame: SupporterAvatarFrameId, size: string, allowance = "0px"): CSSProperties {
  const [left, top, right, bottom] = supporterFrameGeometry(frame).overhang;
  const vertical = (share: number) => `max(0px, calc(${size} * ${share} - ${allowance}))`;
  return {
    marginLeft: `calc(${size} * ${left})`,
    marginRight: `calc(${size} * ${right})`,
    marginTop: vertical(top),
    marginBottom: vertical(bottom),
  };
}
