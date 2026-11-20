import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef } from "react";

import { LOOP_SECONDS, WORKSHOP_SIZE, type Assets, type Layer, type Pixels } from "../../../lib/frame-editor/doc";
import { composite } from "../../../lib/frame-editor/render";

import { frameOverhangMargins, SupporterAvatarFrame } from "../../player/SupporterAvatarFrame";
import { framedAvatarStyle, registerWorkshopFrames, WORKSHOP_FRAME_TEMPLATE, type SupporterAvatarFrameId } from "../../../lib/supporter-avatar-frames";
import { StatusDot } from "../themes/EditorChrome";

/* The frame on the viewer's own avatar, drawn by the same code profiles and
   lists use, at the sizes the site shows it: profile, card and list. Fed the
   editor's 384px export (and round export) as blob URLs. */

export const PREVIEW_ID = "u0" as const;
const { size: T, avatar: A, inset: I } = WORKSHOP_FRAME_TEMPLATE;

export type Overhang = [number, number, number, number];

/* How far the art reaches past the avatar, in avatar widths, as the upload measures it. */
export function measureOverhang(canvas: HTMLCanvasElement): Overhang {
  const size = canvas.width;
  const scale = size / T;
  const inset = I * scale;
  const avatar = A * scale;
  const data = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, size, size).data;
  let x0 = size, y0 = size, x1 = -1, y1 = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (data[(y * size + x) * 4 + 3] < 16) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return [0, 0, 0, 0];
  const reach = (n: number) => Math.max(0, n) / avatar;
  return [reach(inset - x0), reach(inset - y0), reach(x1 + 1 - (inset + avatar)), reach(y1 + 1 - (inset + avatar))];
}

export function FramePreview({ still, round, video, overhang, avatar, clear, motion }: {
  still: string | null;
  round: string | null;
  video: string | null;
  overhang: Overhang;
  avatar: string | undefined;
  clear: { square: number | null; round: number | null };
  /* the square board, when something in it moves: the previews play its loop live */
  motion: { layers: Layer[]; pixels: Pixels; assets: Assets } | null;
}) {
  const { t } = useLingui();
  // one loop renders the frame at its upload size; every moving preview copies from it
  const targets = useRef(new Set<HTMLCanvasElement>());
  const latest = useRef(motion);
  latest.current = motion;
  const moving = !!motion;
  useEffect(() => {
    if (!moving) return;
    const source = document.createElement("canvas");
    source.width = source.height = WORKSHOP_SIZE;
    const ctx = source.getContext("2d")!;
    let frame = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const current = latest.current;
      if (!current || document.hidden) return;
      ctx.clearRect(0, 0, WORKSHOP_SIZE, WORKSHOP_SIZE);
      composite(ctx, current.layers, { pixels: current.pixels, assets: current.assets, size: WORKSHOP_SIZE, time: ((now / 1000) / LOOP_SECONDS) % 1 });
      for (const target of targets.current) {
        const out = target.getContext("2d")!;
        out.clearRect(0, 0, target.width, target.height);
        out.drawImage(source, 0, 0, target.width, target.height);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [moving]);
  const register = useCallback((canvas: HTMLCanvasElement | null, previous: { current: HTMLCanvasElement | null }) => {
    if (previous.current) targets.current.delete(previous.current);
    previous.current = canvas;
    if (canvas) targets.current.add(canvas);
  }, []);
  useEffect(() => {
    if (still) registerWorkshopFrames({ [PREVIEW_ID]: { name: "", still, video, round, roundVideo: null, overhang } });
  }, [still, round, video, overhang]);
  const tone = (value: number | null) => (value === null ? "busy" : value < 0.6 ? "bad" : value < 0.7 ? "warn" : "good");
  return (
    <div className="shrink-0 border-b border-white/[0.06] p-3">
      {still ? (
        <div className="grid grid-cols-2 gap-2">
          {(["dark", "light"] as const).map((backdrop) => (
            <div key={backdrop} className={`flex flex-col items-center justify-center gap-3 rounded-lg py-4 ${backdrop === "dark" ? "bg-osu-b5" : "bg-[#d9dce6]"}`}>
              <FramedAvatar avatar={avatar} size={84} register={moving ? register : null} />
              <div className="flex items-end gap-3">
                <FramedAvatar avatar={avatar} size={48} register={moving ? register : null} />
                <FramedAvatar avatar={avatar} size={28} round />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="py-6 text-center text-[11.5px] text-osu-f1">{t`Draw something to see it on your avatar.`}</p>
      )}
      <div className="mt-2.5 grid gap-1 text-[11.5px] text-osu-l2">
        <span className="flex items-center gap-2">
          <StatusDot tone={tone(clear.square)} />
          {clear.square === null ? t`Square: empty` : t`Square: ${Math.round(clear.square * 100)}% of the avatar clear`}
        </span>
        <span className="flex items-center gap-2">
          <StatusDot tone={clear.round === null ? "busy" : tone(clear.round)} />
          {clear.round === null ? t`Round: none, lists keep the avatar square` : t`Round: ${Math.round(clear.round * 100)}% of the avatar clear`}
        </span>
        {(clear.square !== null && clear.square < 0.6) || (clear.round !== null && clear.round < 0.6) ? (
          <span className="text-rose-300">{t`Keep at least 60% of the avatar see-through.`}</span>
        ) : null}
      </div>
    </div>
  );
}

/* The viewer's avatar wearing the frame. With `register`, the frame is a canvas the
   preview's loop draws into, at the same box the site draws the frame's art in;
   round ones stay still, as lists keep them. */
function FramedAvatar({ avatar, size, round = false, register = null }: { avatar: string | undefined; size: number; round?: boolean; register?: ((canvas: HTMLCanvasElement | null, previous: { current: HTMLCanvasElement | null }) => void) | null }) {
  const frame = PREVIEW_ID as SupporterAvatarFrameId;
  const previous = useRef<HTMLCanvasElement | null>(null);
  // a stable ref callback, so the canvas stays registered across renders and leaves on unmount
  const attach = useCallback((canvas: HTMLCanvasElement | null) => register?.(canvas, previous), [register]);
  const box = `${(-I / A) * 100}%`;
  const span = `${(T / A) * 100}%`;
  return (
    <div className="relative shrink-0" style={frameOverhangMargins(frame, `${size}px`)}>
      <div className="overflow-hidden bg-osu-b3" style={{ width: size, height: size, ...framedAvatarStyle(frame, { round }) }}>
        {avatar ? <img src={avatar} alt="" className="h-full w-full object-cover" /> : null}
      </div>
      {register && !round ? (
        <canvas
          ref={attach}
          width={Math.round((size * T) / A) * 2}
          height={Math.round((size * T) / A) * 2}
          aria-hidden
          className="pointer-events-none absolute max-w-none"
          style={{ left: box, top: box, width: span, height: span }}
        />
      ) : (
        <SupporterAvatarFrame frame={frame} still round={round} />
      )}
    </div>
  );
}
