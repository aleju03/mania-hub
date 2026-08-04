import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { playGhostActionSfx, playGhostSpeechSfx, preloadGhostSfx } from "#/lib/ghost-sfx";
import {
  findGhostAction,
  GHOST_ANCHOR,
  GHOST_ATLAS_COLS,
  GHOST_ATLAS_ROWS,
  GHOST_ATLAS_URL,
  GHOST_CLIPS,
  GHOST_FRAME,
  GHOST_REPLY_MAX_LENGTH,
  GHOST_WALK_SPEED,
  directionalGhostFrame,
  fitGhostScale,
  ghostBubbleLift,
  ghostHitboxRect,
  ghostSpeechDurationMs,
  ghostWrapDelta,
  isGhostClip,
  isLoopingGhostPose,
  shouldFlipGhostClip,
  wrapGhostX,
  type GhostClipName,
  type GhostEffect,
  type GhostVisual,
} from "#/lib/ghost-shared";

/* Renders the ghost itself: sprite, speech bubble, action effects.

   Position and frame are written straight to the DOM from one rAF loop reading
   a ref, never through React state — movement arrives ~15 times a second and
   every visitor on the page would otherwise reconcile at that rate. The props
   carry only the discrete things (which line he is saying, which action just
   fired), so a re-render happens when something actually changed. */

/* How fast the sprite chases the position the owner is steering it to: high
   enough to feel driven, low enough to smooth a lossy connection. */
const FOLLOW_RATE = 14;

export interface GhostSpriteProps {
  visualRef: MutableRefObject<GhostVisual>;
  speech: { id: number; text: string } | null;
  action: { id: number; kind: string } | null;
  scale: number;
  /* Lets the visitor answer him. Null while the stream has not identified this
     connection yet, which just leaves him unclickable. */
  onSay: ((text: string) => void) | null;
}

export function GhostSprite({ visualRef, speech, action, scale, onSay }: GhostSpriteProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const spriteRef = useRef<HTMLDivElement>(null);
  const hitboxRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  /* The action currently playing, which ends on its own clip length rather
     than waiting for the owner to send anything else. */
  const [playing, setPlaying] = useState<{ id: number; kind: string; startedAt: number } | null>(null);
  const [saying, setSaying] = useState(speech);
  /* The visitor's own reply box, and the echo of what they last sent. */
  const [answering, setAnswering] = useState(false);
  const [answered, setAnswered] = useState<{ id: number; text: string } | null>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === "undefined" ? 1536 : window.innerWidth));

  useEffect(() => {
    const read = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);

  /* He only mounts while the owner is actually on the page, so warming the
     samples here costs nothing on an ordinary visit. */
  useEffect(() => {
    preloadGhostSfx();
  }, []);

  useEffect(() => {
    if (!action || !findGhostAction(action.kind)) return;
    setPlaying({ ...action, startedAt: performance.now() });
    playGhostActionSfx(action.kind);
  }, [action]);

  useEffect(() => {
    setSaying(speech);
    if (!speech) return;
    const timer = window.setTimeout(() => setSaying(null), ghostSpeechDurationMs(speech.text));
    return () => window.clearTimeout(timer);
  }, [speech]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const sprite = spriteRef.current;
    const hitbox = hitboxRef.current;
    if (!container || !sprite || !hitbox) return;

    let raf = 0;
    let last = performance.now();
    /* Start where the owner already is instead of sliding in from the middle. */
    let x = visualRef.current.x;
    let y = visualRef.current.y;
    /* Page size, read on a timer rather than every frame: touching
       scrollHeight forces layout, and it only changes when content does. */
    let page = { w: window.innerWidth, h: window.innerHeight };
    let measuredAt = 0;
    let anchored: GhostVisual["anchor"] = visualRef.current.anchor;
    /* How fast he is actually travelling, which is what sets the leg speed:
       a sprint has to look like one without another field on the wire. */
    let rate = 0;
    let phase = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const next = visualRef.current;

      /* What the position is measured against. Anchored to the screen he is
         placed in the window and rides it, which is the only way one placement
         can mean the same thing to a phone and a desktop reading the same page;
         anchored to the page he is placed in the document and scrolls with it.
         Both are read on a timer rather than every frame, because scrollHeight
         forces layout and only changes when the content does. */
      if (now - measuredAt > 500 || next.anchor !== anchored) {
        measuredAt = now;
        anchored = next.anchor;
        const root = document.documentElement;
        page = next.anchor === "screen"
          ? { w: window.innerWidth, h: window.innerHeight }
          : { w: root.clientWidth, h: Math.max(root.scrollHeight, window.innerHeight) };
        container.style.position = next.anchor === "screen" ? "fixed" : "absolute";
      }

      const follow = 1 - Math.exp(-FOLLOW_RATE * dt);
      /* Chased the short way round, so walking off the right edge crosses to
         the left rather than sliding back over everything in between. */
      const movedX = ghostWrapDelta(x, next.x) * follow;
      const movedY = (next.y - y) * follow;
      x = wrapGhostX(x + movedX);
      y += movedY;
      /* Real distance travelled, in screen widths per second: the same unit the
         walk and sprint speeds are expressed in, so the comparison below holds
         whichever way he is going and however long the page is. */
      const movedPx = Math.hypot(movedX * page.w, movedY * page.h);
      const travelled = dt > 0 ? movedPx / window.innerWidth / dt : 0;
      rate += (travelled - rate) * Math.min(1, dt * 8);
      container.style.transform = `translate3d(${(x * page.w).toFixed(1)}px, ${(y * page.h).toFixed(1)}px, 0)`;

      const active = playingRef.current;
      const spec = active ? findGhostAction(active.kind) : null;
      const clipName = resolveClip(spec?.clip ?? next.clip);
      const clip = GHOST_CLIPS[clipName];
      let frame = 0;
      if (active && spec) {
        const index = Math.floor(((now - active.startedAt) / 1000) * clip.fps);
        if (index >= clip.frames * (spec.loops ?? 1)) {
          if (playingRef.current?.id === active.id) setPlaying(null);
        } else {
          frame = index % clip.frames;
          if (spec.reverse) frame = clip.frames - 1 - frame;
        }
      } else if (directionalGhostFrame(clipName, next.facing) != null) {
        // Two drawings, one per side: the frame is the direction, not the time.
        frame = directionalGhostFrame(clipName, next.facing)!;
      } else if (next.moving || isLoopingGhostPose(clipName)) {
        /* Legs keep up with the actual pace: nominal at a walk, faster at a
           run, so a sprint reads as one. Poses just run at their own rate. */
        const pace = next.moving ? Math.min(2, Math.max(0.7, rate / GHOST_WALK_SPEED)) : 1;
        phase += dt * clip.fps * pace;
        frame = Math.floor(phase) % clip.frames;
      } else {
        phase = 0;
      }

      /* The owner picks one size for everyone, in sprite pixels. Each viewer
         caps it against their own width so he is a character on a phone rather
         than most of the screen. */
      const spriteScale = fitGhostScale(next.scale, window.innerWidth);
      const flip = shouldFlipGhostClip(clipName, next.facing);
      sprite.style.width = `${GHOST_FRAME.w * spriteScale}px`;
      sprite.style.height = `${GHOST_FRAME.h * spriteScale}px`;
      sprite.style.backgroundSize = `${GHOST_FRAME.w * GHOST_ATLAS_COLS * spriteScale}px ${GHOST_FRAME.h * GHOST_ATLAS_ROWS * spriteScale}px`;
      sprite.style.backgroundPosition = `${-frame * GHOST_FRAME.w * spriteScale}px ${-clip.row * GHOST_FRAME.h * spriteScale}px`;
      /* Read right to left: park the anchor (his feet) on the container origin,
         then mirror about it, so facing left never shifts where he stands. */
      sprite.style.transform = `${flip ? "scaleX(-1) " : ""}translate(${-GHOST_ANCHOR.x * spriteScale}px, ${-GHOST_ANCHOR.y * spriteScale}px)`;
      /* The bubble hangs off whatever clip is drawn this frame, so a pose that
         changes his height moves it with him rather than at the next render. */
      if (bubbleRef.current) bubbleRef.current.style.bottom = `${ghostBubbleLift(clipName, spriteScale)}px`;
      const hitboxRect = ghostHitboxRect(clipName, spriteScale, flip);
      hitbox.style.left = `${hitboxRect.x}px`;
      hitbox.style.top = `${hitboxRect.y}px`;
      hitbox.style.width = `${hitboxRect.w}px`;
      hitbox.style.height = `${hitboxRect.h}px`;
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [visualRef]);

  const spec = playing ? findGhostAction(playing.kind) : null;
  /* The bubble and the shadow hang off the drawn size, so they need the same
     cap the loop draws him at, re-read when the window changes (a phone turned
     on its side is a different screen). */
  const drawScale = fitGhostScale(scale, viewportWidth);
  /* Where the bubble starts out. The loop takes it over on the next frame, off
     whatever clip is actually drawn. */
  const lift = ghostBubbleLift(resolveClip(spec?.clip ?? visualRef.current.clip), drawScale);
  return (
    <>
      {spec?.effect ? <GhostEffectLayer key={playing?.id} effect={spec.effect} /> : null}
      {spec?.caption ? <GhostCaption key={`caption-${playing?.id}`} text={spec.caption} /> : null}
      {/* Absolute, not fixed: he stands in the page, so he stays next to
          whatever he was put beside while the visitor scrolls. */}
      <div ref={containerRef} className="pointer-events-none absolute left-0 top-0 z-[200] will-change-transform">
        <div className="relative">
          {saying ? <GhostBubble key={saying.id} containerRef={bubbleRef} text={saying.text} lift={lift} /> : null}
          {answering && onSay ? (
            <GhostReplyBox
              onClose={() => setAnswering(false)}
              onSend={(text) => {
                onSay(text);
                setAnswered({ id: Date.now(), text });
                setAnswering(false);
              }}
            />
          ) : null}
          {answered ? <GhostAnsweredBubble key={answered.id} text={answered.text} onDone={() => setAnswered(null)} /> : null}
          {/* Grounds him on the page instead of leaving him floating. */}
          <div
            aria-hidden
            className="absolute rounded-[50%] bg-black/35 blur-[2px]"
            style={{ width: 16 * drawScale, height: 4 * drawScale, left: -8 * drawScale, top: -3 * drawScale }}
          />
          {/* origin-top-left is load-bearing: the flip has to mirror about the
              container origin, not about the frame's own centre. */}
          <div
            ref={spriteRef}
            role={onSay ? undefined : "img"}
            aria-label={onSay ? undefined : "Ralsei"}
            aria-hidden={onSay ? true : undefined}
            className="pointer-events-none absolute origin-top-left [image-rendering:pixelated]"
            style={{ backgroundImage: `url(${GHOST_ATLAS_URL})`, backgroundRepeat: "no-repeat" }}
          />
          {/* The atlas frame is mostly transparent padding. Keep interaction on
              a separate rectangle matching the current clip's visible pixels
              so Ralsei cannot be clicked from hundreds of pixels above him. */}
          <button
            ref={hitboxRef}
            type="button"
            disabled={!onSay}
            tabIndex={onSay ? 0 : -1}
            aria-label="Say something to Ralsei"
            aria-hidden={onSay ? undefined : true}
            onClick={onSay ? () => setAnswering((open) => !open) : undefined}
            className={`absolute appearance-none border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-300 ${
              onSay ? "pointer-events-auto cursor-pointer" : "pointer-events-none"
            }`}
          />
        </div>
      </div>
    </>
  );
}

function resolveClip(name: string): GhostClipName {
  return isGhostClip(name) ? name : "idle";
}

/* One atlas frame, for surfaces that place him themselves (the control panel's
   stage). Same anchor rules as the overlay, so what the owner aims at is where
   he lands on the visitor's screen. */
export function GhostAtlasFrame({
  clip,
  frame,
  scale,
  flip = false,
}: {
  clip: GhostClipName;
  frame: number;
  scale: number;
  flip?: boolean;
}) {
  const definition = GHOST_CLIPS[clip];
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute origin-top-left [image-rendering:pixelated]"
      style={{
        width: GHOST_FRAME.w * scale,
        height: GHOST_FRAME.h * scale,
        backgroundImage: `url(${GHOST_ATLAS_URL})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${GHOST_FRAME.w * GHOST_ATLAS_COLS * scale}px ${GHOST_FRAME.h * GHOST_ATLAS_ROWS * scale}px`,
        backgroundPosition: `${-(frame % definition.frames) * GHOST_FRAME.w * scale}px ${-definition.row * GHOST_FRAME.h * scale}px`,
        transform: `${flip ? "scaleX(-1) " : ""}translate(${-GHOST_ANCHOR.x * scale}px, ${-GHOST_ANCHOR.y * scale}px)`,
      }}
    />
  );
}

const TYPE_MS_PER_CHAR = 32;

function GhostBubble({ text, lift, containerRef }: {
  text: string;
  lift: number;
  /* The draw loop keeps this in step with the clip he is in; the lift above is
     only where it starts. */
  containerRef: MutableRefObject<HTMLDivElement | null>;
}) {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    setShown(0);
    let raf = 0;
    const startedAt = performance.now();
    const step = (now: number) => {
      const characters = Math.min(text.length, Math.floor((now - startedAt) / TYPE_MS_PER_CHAR));
      setShown(characters);
      if (characters < text.length) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text]);

  useEffect(() => {
    if (shown > 0) playGhostSpeechSfx(text[shown - 1] ?? "");
  }, [shown, text]);

  return (
    <div ref={containerRef} className="absolute left-1/2 w-max max-w-[min(320px,70vw)] -translate-x-1/2" style={{ bottom: lift }}>
      <GhostBubbleBox>
        {text.slice(0, shown)}
        <span className="opacity-0">{text.slice(shown)}</span>
      </GhostBubbleBox>
    </div>
  );
}

/* The box a line sits in, without any placement of its own. Exported so the
   control panel's stage can draw the same bubble the page draws instead of
   leaving the owner to guess at what everyone else is reading. */
export function GhostBubbleBox({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="rounded-md border-2 border-white bg-black px-3 py-2 text-left text-[13px] font-semibold leading-snug text-white">
        {children}
      </div>
      <div className="mx-auto h-0 w-0 border-x-[7px] border-t-[8px] border-x-transparent border-t-white" />
    </>
  );
}

/* Answering him. The box is deliberately small and unstyled beyond the same
   black-and-white box his own lines use: it is a whisper to whoever is driving,
   not a chat feature. */
function GhostReplyBox({ onSend, onClose }: { onSend: (text: string) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="pointer-events-auto absolute left-1/2 w-max -translate-x-1/2" style={{ top: 16 }}>
      <div className="flex items-center gap-2 rounded-md border-2 border-white bg-black px-2 py-1.5">
        <input
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            if (event.key !== "Enter") return;
            const trimmed = text.trim();
            if (trimmed) onSend(trimmed);
          }}
          onBlur={() => {
            if (!text.trim()) onClose();
          }}
          maxLength={GHOST_REPLY_MAX_LENGTH}
          placeholder="say something back"
          aria-label="Say something to Ralsei"
          className="w-[min(240px,55vw)] bg-transparent text-[13px] font-semibold text-white outline-none placeholder:text-white/40"
        />
        <button
          type="button"
          onClick={() => {
            const trimmed = text.trim();
            if (trimmed) onSend(trimmed);
          }}
          className="cursor-pointer text-[11px] font-bold text-white/70 transition-colors hover:text-white"
        >
          send
        </button>
      </div>
    </div>
  );
}

function GhostAnsweredBubble({ text, onDone }: { text: string; onDone: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, 3_000);
    return () => window.clearTimeout(timer);
  }, [onDone]);
  return (
    <div className="absolute left-1/2 w-max max-w-[min(280px,60vw)] -translate-x-1/2" style={{ top: 16 }}>
      <div className="rounded-md border-2 border-white/40 bg-black/80 px-2.5 py-1.5 text-[12px] font-semibold text-white/80">
        {text}
      </div>
    </div>
  );
}

function GhostCaption({ text }: { text: string }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-10 z-[201] flex justify-center px-4">
      <div className="ghost-caption rounded-md border-2 border-white bg-black px-4 py-2 text-[13px] font-semibold text-white">
        {text}
      </div>
    </div>
  );
}

const EFFECT_GLYPHS: Record<"sparkles" | "hearts" | "notes", string[]> = {
  sparkles: ["✦", "✧", "★"],
  hearts: ["♥", "♡"],
  notes: ["♪", "♫"],
};

function GhostEffectLayer({ effect }: { effect: Exclude<GhostEffect, null> }) {
  const particles = useMemo(() => {
    if (effect === "shake" || effect === "dark") return [];
    const glyphs = EFFECT_GLYPHS[effect];
    return Array.from({ length: 18 }, (_, index) => ({
      id: index,
      glyph: glyphs[index % glyphs.length],
      left: Math.random() * 100,
      delay: Math.random() * 900,
      duration: 1600 + Math.random() * 1200,
      size: 14 + Math.random() * 16,
    }));
  }, [effect]);

  useEffect(() => {
    if (effect !== "shake") return;
    const root = document.documentElement;
    root.classList.add("ghost-shake");
    const timer = window.setTimeout(() => root.classList.remove("ghost-shake"), 600);
    return () => {
      window.clearTimeout(timer);
      root.classList.remove("ghost-shake");
    };
  }, [effect]);

  if (effect === "shake") return null;
  if (effect === "dark") return <div className="ghost-dark pointer-events-none fixed inset-0 z-[199] bg-[#160d24]" />;

  const tint = effect === "hearts" ? "text-[#ff5fb0]" : effect === "notes" ? "text-[#8ef0c0]" : "text-[#c9ffdf]";
  return (
    <div className="pointer-events-none fixed inset-0 z-[199] overflow-hidden">
      {particles.map((particle) => (
        <span
          key={particle.id}
          className={`ghost-float absolute bottom-0 ${tint}`}
          style={{
            left: `${particle.left}%`,
            fontSize: particle.size,
            animationDelay: `${particle.delay}ms`,
            animationDuration: `${particle.duration}ms`,
          }}
        >
          {particle.glyph}
        </span>
      ))}
    </div>
  );
}
