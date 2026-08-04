import { createFileRoute, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { ArrowDown, Eye, EyeOff, Loader2, Pin, PinOff, Plug, PlugZap, Users, Volume2, VolumeX, X } from "lucide-react";
import { GHOST_PREVIEW_HASH } from "../../components/ghost/GhostLayer";
import { GhostAtlasFrame, GhostBubbleBox } from "../../components/ghost/GhostSprite";
import { useAuth } from "../../lib/auth-context";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { getGhostControlTicket } from "../../lib/ghost";
import { playGhostActionSfx, preloadGhostSfx, setGhostSfxMuted } from "../../lib/ghost-sfx";
import {
  DEFAULT_GHOST_CHARACTER,
  EMPTY_GHOST_PRESENCE,
  GHOST_CHARACTER_LIST,
  directionalGhostFrame,
  findGhostAction,
  findGhostPose,
  fitGhostScale,
  isGhostGait,
  isLoopingGhostPose,
  followGhostCamera,
  ghostCharacter,
  ghostClip,
  ghostClipBounds,
  ghostMoveStep,
  ghostBubbleLift,
  ghostSpeechDurationMs,
  normalizeGhostRoute,
  shouldFlipGhostClip,
  walkClipFor,
  wrapGhostX,
  type GhostAnchor,
  type GhostAudience,
  type GhostCharacter,
  type GhostFacing,
  type GhostPresence,
  type GhostReply,
  type GhostVisual,
} from "../../lib/ghost-shared";
import { getLiveBackendUrl } from "../../lib/live-backend";

/* The ghost control room.

   The browser drives the backend directly here, with a short-lived ticket
   instead of the admin token: movement goes out ~15 times a second and a hop
   through the frontend server would put a round trip in front of every step.
   Position is normalized (0..1 across the page width and down the whole
   document), so one stage drives every screen size watching, and the stage is a
   camera over the framed page rather than the whole of it. */

export const Route = createFileRoute("/admin/ghost")({
  head: () => ({
    meta: [
      { title: "Ghost - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: GhostAdminPage,
});

/* The control panel is a page like any other, so the tab you drive from shows up
   in the roster as a viewer on it. Staging against it frames the panel inside
   itself: a second stage, a second marker, and a second of everything below.
   Nothing automatic aims there, and it never gets a preview. */
const GHOST_PANEL_ROUTE = "/admin/ghost";
const SEND_INTERVAL_MS = 70;
const KEEPALIVE_MS = 4_000;
const PRESENCE_POLL_MS = 3_000;
/* The site can have hundreds of pages open at once, so the roster shows the
   busiest pages and a few names each rather than every connection. */
const ROUTE_ROWS = 8;
const NAMES_PER_ROUTE = 6;
const PICKER_LIMIT = 24;
/* The transcript is a chat window now, so it keeps far more than fits on screen
   and scrolls; it is still memory-only and dies with the tab. */
const CHAT_ROWS = 200;
/* Anything closer to the bottom than this counts as reading the newest line, so
   a new message scrolls into view instead of interrupting a scroll back. */
const STICK_PX = 48;
/* Twitch-style name colours: a stable colour per person makes a fast-moving log
   readable without reading the names. Picked to sit on the dark panel. */
const NAME_COLORS = ["#ff7ab8", "#7cc4ff", "#8ce99a", "#ffd479", "#c9a4ff", "#ff9b72", "#6fdccd", "#f7a8a8"];
/* The backend drops a session after ten idle minutes; re-mint well before the
   ticket itself lapses. */
const TICKET_REFRESH_MS = 40 * 60_000;

const KEY_DIRECTIONS: Record<string, GhostFacing> = {
  w: "up",
  a: "left",
  s: "down",
  d: "right",
  arrowup: "up",
  arrowleft: "left",
  arrowdown: "down",
  arrowright: "right",
};

interface DriveState {
  x: number;
  y: number;
  facing: GhostFacing;
  moving: boolean;
}

/* One line of the log, whichever side it came from: what he said, what a viewer
   said back, and the actions in between so the conversation still makes sense
   when half of it was a wave. */
interface ChatLine {
  key: string;
  kind: "reply" | "said" | "act";
  at: number;
  route: string;
  userId: number | null;
  name: string | null;
  text: string;
}

function GhostAdminPage() {
  const auth = useAuth();
  const base = getLiveBackendUrl();
  const [ticket, setTicket] = useState<string | null>(null);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [routeInput, setRouteInput] = useState("/");
  const [audience, setAudience] = useState<GhostAudience>({ mode: "none" });
  /* Who is being driven. Poses, actions and the size range all come off the
     roster entry, so switching swaps the whole control set below. */
  const [characterId, setCharacterId] = useState<string>(DEFAULT_GHOST_CHARACTER);
  const character = ghostCharacter(characterId);
  const [pose, setPose] = useState<string>("auto");
  /* What his position is measured against on the far side. Standing in the page
     is the default and the right one when aiming at a person; sticking to the
     screen is what makes a placement mean the same thing to a phone and a
     desktop looking at the same page. */
  const [anchor, setAnchor] = useState<GhostAnchor>("page");
  const [scale, setScale] = useState(ghostCharacter(DEFAULT_GHOST_CHARACTER).scale.default);
  const [message, setMessage] = useState("");
  const [presence, setPresence] = useState<GhostPresence>(EMPTY_GHOST_PRESENCE);
  const [preview, setPreview] = useState(true);
  /* Local only: whether the panel plays back what it fires. The audience hears
     it either way. */
  const [sound, setSound] = useState(true);
  const [picking, setPicking] = useState(false);
  /* Whether the panel walks him onto whatever page the target opens next. */
  const [follow, setFollow] = useState(true);
  /* Talking on the stage rather than down in the chat panel: the box opens over
     his head, where you are already looking. */
  const [composing, setComposing] = useState(false);
  const [showAllRoutes, setShowAllRoutes] = useState(false);
  const [chat, setChat] = useState<ChatLine[]>([]);
  /* Whether the log is parked at the newest line. Ref for the scroll handler,
     state for the button that offers to go back down. */
  const [atBottom, setAtBottom] = useState(true);
  /* The line currently over his head, so the stage can draw the same bubble the
     page draws; the send loop reads the ref, not this. */
  const [bubble, setBubble] = useState<{ id: number; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* The stage frames the real page at the viewer's own viewport size and scales
     it down to fit, so aiming next to someone's avatar means the same pixels on
     their screen. Measured rather than assumed. */
  const [stageWidth, setStageWidth] = useState(0);
  const [pageHeight, setPageHeight] = useState(0);
  /* Lags the route box: reloading the framed page on every keystroke would
     fetch a page per letter typed. */
  const [previewRoute, setPreviewRoute] = useState<string | null>("/");
  /* Only the parts of the drive state that change what is rendered: position
     moves through a ref so walking does not re-render the page 60 times a
     second. */
  const [look, setLook] = useState<{ facing: GhostFacing; moving: boolean }>({ facing: "down", moving: false });

  const stageRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLInputElement>(null);
  const stageComposerRef = useRef<HTMLInputElement>(null);
  const stuckRef = useRef(true);
  /* How far down the page the stage is looking, in page pixels. */
  const cameraRef = useRef(0);
  /* Page geometry the movement loop needs every frame, kept off React state. */
  const pageMetricsRef = useRef({ viewW: 1536, viewH: 864, pageH: 864 });
  const driveRef = useRef<DriveState>({ x: 0.5, y: 0.72, facing: "down", moving: false });
  /* The size each character was last driven at, so switching back to one does
     not undo the size it was tuned to. */
  const scaleMemoryRef = useRef<Record<string, number>>({});
  const keysRef = useRef(new Set<string>());
  const speechRef = useRef<GhostVisual["speech"]>(null);
  const actionRef = useRef<GhostVisual["action"]>(null);
  const eventIdRef = useRef(1);
  const lastSentRef = useRef(0);
  const dirtyRef = useRef(true);
  /* The route the backend currently holds a session on, which lags the input
     box while you are typing a new one. */
  const activeRouteRef = useRef<string | null>(null);
  /* Loop-visible copy of everything the send payload needs, so the rAF loop
     never has to be torn down and rebuilt on a settings change. */
  const settingsRef = useRef({ route: "/", audience, character, pose, scale, anchor, connected, ticket });
  settingsRef.current = { route: normalizeGhostRoute(routeInput) ?? "/", audience, character, pose, scale, anchor, connected, ticket };

  const route = normalizeGhostRoute(routeInput);
  /* Their newest tab that is not the control panel, so testing on yourself
     stages against the page you are actually reading rather than this one. */
  const targetViewer = audience.mode === "user"
    ? presence.viewers.find((viewer) => viewer.userId === audience.userId && viewer.route !== GHOST_PANEL_ROUTE)
      ?? presence.viewers.find((viewer) => viewer.userId === audience.userId)
      ?? null
    : null;
  /* The roster only names signed-in viewers; everyone else is a count. */
  const routeHere = route ? presence.routes.find((entry) => entry.route === route) ?? null : null;
  const ownViewport = useOwnViewport();
  /* Aiming at one person stages against their screen, because then the pixels
     are the point: next to their avatar means next to their avatar. With nobody
     picked there is no single screen to match, so it stages against yours rather
     than reshaping itself around whoever last landed on the page. */
  const viewport = targetViewer?.viewport ?? ownViewport;
  const previewScale = stageWidth > 0 ? stageWidth / viewport.w : 0;
  const canPreview = Boolean(previewRoute) && !previewRoute!.endsWith("/*") && previewRoute !== GHOST_PANEL_ROUTE;
  /* Without a framed page to measure, the page is just one screen tall. */
  const pageHeightPx = pageHeight > 0 ? Math.max(pageHeight, viewport.h) : viewport.h;
  pageMetricsRef.current = { viewW: viewport.w, viewH: viewport.h, pageH: pageHeightPx };

  useEffect(() => {
    let cancelled = false;
    const mint = async () => {
      try {
        const issued = await getGhostControlTicket();
        if (cancelled) return;
        if (!issued) {
          setTicketError("The live backend is not configured for ghost control.");
          return;
        }
        setTicket(issued.ticket);
        setTicketError(null);
      } catch (cause) {
        if (!cancelled) setTicketError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void mint();
    const timer = window.setInterval(() => void mint(), TICKET_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  /* Places the marker and moves the camera with him. The camera is the framed
     page's own scroll position, in page pixels: the frame stays one screen tall
     (anything else would make the page lay itself out in a viewport nobody
     has), and it scrolls exactly like the viewer would scroll it. */
  const placeMarker = useCallback(() => {
    const marker = markerRef.current;
    const stage = stageRef.current;
    if (!marker || !stage) return;
    const { pageH, viewH, viewW } = pageMetricsRef.current;
    const scale = stage.clientWidth / viewW;
    marker.style.left = `${driveRef.current.x * 100}%`;
    /* Anchored to the screen there is no camera to move: he is somewhere on the
       viewer's window, and what is behind him is wherever they happen to have
       scrolled to, which the panel cannot know. The frame keeps showing
       whatever it was showing. */
    if (settingsRef.current.anchor === "screen") {
      marker.style.top = `${driveRef.current.y * viewH * scale}px`;
      return;
    }
    const targetPx = driveRef.current.y * pageH;
    cameraRef.current = followGhostCamera(cameraRef.current, targetPx, viewH, pageH);
    marker.style.top = `${(targetPx - cameraRef.current) * scale}px`;
    frameRef.current?.contentWindow?.scrollTo({ top: cameraRef.current, behavior: "instant" });
  }, []);

  useEffect(placeMarker, [placeMarker, anchor, connected, preview, stageWidth, pageHeight, viewport.w, viewport.h]);

  useEffect(() => {
    preloadGhostSfx();
  }, []);

  useEffect(() => {
    if (composing) stageComposerRef.current?.focus({ preventScroll: true });
  }, [composing]);

  useEffect(() => {
    setGhostSfxMuted(!sound);
  }, [sound]);

  useEffect(() => {
    const timer = window.setTimeout(() => setPreviewRoute(route), 500);
    return () => window.clearTimeout(timer);
  }, [route]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setStageWidth(stage.clientWidth));
    observer.observe(stage);
    setStageWidth(stage.clientWidth);
    return () => observer.disconnect();
  }, []);

  /* How tall the framed page actually is. It grows as the page's own data
     lands, so it is polled rather than read once on load. Same-origin, so the
     document is readable; anything else falls back to one screen. */
  useEffect(() => {
    if (!preview || !canPreview) {
      setPageHeight(0);
      return;
    }
    const read = () => {
      try {
        const doc = frameRef.current?.contentDocument;
        const height = doc?.documentElement?.scrollHeight ?? 0;
        if (height > 0) setPageHeight(height);
      } catch {
        // Cross-origin somehow: stage against a single screen instead.
      }
    };
    read();
    const timer = window.setInterval(read, 1_000);
    return () => window.clearInterval(timer);
  }, [preview, canPreview, previewRoute]);

  const post = useCallback(async (body: Record<string, unknown>): Promise<Response | null> => {
    const current = settingsRef.current.ticket;
    if (!base || !current) return null;
    try {
      const response = await fetch(`${base}/api/ghost/control?ticket=${encodeURIComponent(current)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      setError(response.ok ? null : `Control failed (${response.status}).`);
      return response;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, [base]);

  const buildVisual = useCallback((): GhostVisual => {
    const state = driveRef.current;
    const settings = settingsRef.current;
    const posed = findGhostPose(settings.character, settings.pose)?.clip ?? null;
    /* A held pose stops the walk cycle, except where the pose is itself a way
       of walking: the dog on stilts takes a stride per step and stands still
       between them, rather than marching on the spot. */
    const striding = posed != null && isGhostGait(settings.character, posed);
    return {
      x: state.x,
      y: state.y,
      anchor: settings.anchor,
      character: settings.character.id,
      clip: posed ?? walkClipFor(settings.character, state.facing),
      facing: state.facing,
      moving: posed && !striding ? false : state.moving,
      scale: settings.scale,
      speech: speechRef.current,
      action: actionRef.current,
    };
  }, []);

  const sendNow = useCallback((extra?: { withViewers?: boolean }) => {
    const settings = settingsRef.current;
    if (!settings.connected) return;
    /* Retargeting to another page has to close the old session, otherwise he
       stays behind on it until it idles out and there are two of him. */
    if (activeRouteRef.current && activeRouteRef.current !== settings.route) {
      void post({ op: "end", route: activeRouteRef.current });
    }
    activeRouteRef.current = settings.route;
    lastSentRef.current = performance.now();
    dirtyRef.current = false;
    void post({
      route: settings.route,
      audience: settings.audience,
      ownerUserId: auth.viewer?.id ?? null,
      visual: buildVisual(),
      withViewers: extra?.withViewers === true,
    }).then((response) => {
      if (!response?.ok || extra?.withViewers !== true) return;
      void response.json().then((payload: { presence?: GhostPresence }) => {
        if (payload.presence) setPresence(payload.presence);
      }).catch(() => undefined);
    });
  }, [auth.viewer?.id, buildVisual, post]);

  /* One loop owns movement: it integrates whatever keys are held, keeps the
     stage in sync, and pushes at a fixed rate rather than per keystroke. */
  useEffect(() => {
    if (!connected) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      let dx = 0;
      let dy = 0;
      for (const key of keysRef.current) {
        const direction = KEY_DIRECTIONS[key];
        if (direction === "left") dx -= 1;
        if (direction === "right") dx += 1;
        if (direction === "up") dy -= 1;
        if (direction === "down") dy += 1;
      }
      const moving = dx !== 0 || dy !== 0;
      const state = driveRef.current;
      if (moving) {
        const page = pageMetricsRef.current;
        const step = ghostMoveStep({ dx, dy }, {
          sprinting: keysRef.current.has("shift"),
          dt,
          viewWidth: page.viewW,
          // A screen-anchored step covers a screen, not a whole document.
          pageHeight: settingsRef.current.anchor === "screen" ? page.viewH : page.pageH,
        });
        // Sideways he wraps; up and down he stops at the ends of the page.
        const nextX = wrapGhostX(state.x + step.dx);
        const nextY = clamp01(state.y + step.dy);
        /* Horizontal input wins the facing, so a diagonal keeps the side view
           instead of flickering between two clips. */
        const facing: GhostFacing = dx !== 0 ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
        driveRef.current = { x: nextX, y: nextY, facing, moving: true };
        placeMarker();
        if (state.facing !== facing || !state.moving) setLook({ facing, moving: true });
        dirtyRef.current = true;
      } else if (state.moving) {
        driveRef.current = { ...state, moving: false };
        setLook({ facing: state.facing, moving: false });
        dirtyRef.current = true;
      }

      const sinceSend = now - lastSentRef.current;
      if ((dirtyRef.current && sinceSend >= SEND_INTERVAL_MS) || sinceSend >= KEEPALIVE_MS) sendNow();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [connected, sendNow]);

  /* Swapping who is on the page. Everything character-shaped moves together and
     lands in settingsRef before the push, because state set here is not
     readable until the next render and the tick goes out now. */
  const pickCharacter = useCallback((next: GhostCharacter) => {
    const current = settingsRef.current;
    if (next.id === current.character.id) return;
    scaleMemoryRef.current[current.character.id] = current.scale;
    // A pose only survives the switch if the new character has one by that name.
    const keptPose = findGhostPose(next, current.pose) ? current.pose : "auto";
    const nextScale = scaleMemoryRef.current[next.id] ?? next.scale.default;
    setCharacterId(next.id);
    setPose(keptPose);
    setScale(nextScale);
    settingsRef.current = { ...current, character: next, pose: keptPose, scale: nextScale };
    dirtyRef.current = true;
    sendNow();
  }, [sendNow]);

  useEffect(() => {
    const isTyping = (target: EventTarget | null) => target instanceof HTMLElement
      && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    /* Buttons and links keep their own keyboard behaviour: enter on a focused
       Cheer button should still cheer. */
    const isControl = (target: EventTarget | null) => target instanceof HTMLElement
      && target.closest("button, a, [role=button]") != null;
    const down = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (isTyping(event.target)) return;
      /* Chat the way a game does it: enter or T drops you into the box from
         anywhere on the stage, and sending puts you back on the keys. */
      if ((key === "enter" || key === "t") && !isControl(event.target)) {
        event.preventDefault();
        /* Opens the box on the stage, not the one in the chat panel: that one
           lives at the bottom of a long page, and the browser drags the caret
           into view on the first keystroke however the focus was set. */
        setComposing(true);
        return;
      }
      /* Number keys swap character, in the order the picker shows them. */
      if (key >= "1" && key <= "9") {
        const picked = GHOST_CHARACTER_LIST[Number(key) - 1];
        if (picked) {
          event.preventDefault();
          pickCharacter(picked);
        }
        return;
      }
      // Shift is the run key, so it is tracked alongside the direction keys.
      if (!KEY_DIRECTIONS[key] && key !== "shift") return;
      event.preventDefault();
      keysRef.current.add(key);
    };
    const up = (event: KeyboardEvent) => {
      keysRef.current.delete(event.key.toLowerCase());
    };
    const blur = () => keysRef.current.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [pickCharacter]);

  /* Presence is the point of the roster: who is on which page right now, and
     which of them can currently see him. */
  useEffect(() => {
    if (!base || !ticket) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`${base}/api/ghost/presence?ticket=${encodeURIComponent(ticket)}`);
        if (!response.ok || cancelled) return;
        const payload = await response.json() as GhostPresence;
        if (!cancelled && payload.routes) setPresence(payload);
      } catch {
        // A missed poll just means a stale roster for three seconds.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), PRESENCE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [base, ticket]);

  /* Appends to the log, keyed so the backlog the inbox replays on reconnect
     lands on top of the copies already there instead of doubling them. */
  const pushChat = useCallback((line: ChatLine) => {
    setChat((current) => [...current.filter((entry) => entry.key !== line.key), line].slice(-CHAT_ROWS));
  }, []);

  /* What viewers say back, pushed as it happens rather than polled: a reply
     three seconds late reads as being ignored. */
  useEffect(() => {
    if (!base || !ticket || typeof EventSource === "undefined") return;
    const source = new EventSource(`${base}/api/ghost/inbox?ticket=${encodeURIComponent(ticket)}`);
    source.addEventListener("reply", (event) => {
      try {
        const reply = JSON.parse((event as MessageEvent).data) as GhostReply;
        pushChat({
          key: `r${reply.id}`,
          kind: "reply",
          at: reply.at,
          route: reply.route,
          userId: reply.userId,
          name: reply.username,
          text: reply.text,
        });
      } catch {
        // A malformed frame is not worth dropping the stream for.
      }
    });
    return () => source.close();
  }, [base, pushChat, ticket]);

  /* Follows the newest line unless you have scrolled up to read something. */
  useEffect(() => {
    if (!stuckRef.current) return;
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [chat]);

  const trackScroll = useCallback(() => {
    const log = logRef.current;
    if (!log) return;
    const stuck = log.scrollHeight - log.scrollTop - log.clientHeight < STICK_PX;
    stuckRef.current = stuck;
    setAtBottom(stuck);
  }, []);

  /* Following someone. The roster is the only account of where they went, so he
     moves on the poll rather than on anything they send, which puts him on their
     new page within a few seconds of them opening it. settingsRef is written
     alongside the input box because state set here is not readable until the
     next render, and the push happens now. */
  useEffect(() => {
    if (!follow || audience.mode !== "user") return;
    // Never onto the panel: following yourself would land him inside it.
    const viewer = presence.viewers.find((entry) => entry.userId === audience.userId && entry.route !== GHOST_PANEL_ROUTE);
    const next = viewer ? normalizeGhostRoute(viewer.route) : null;
    if (!next || next === settingsRef.current.route) return;
    setRouteInput(next);
    settingsRef.current = { ...settingsRef.current, route: next };
    dirtyRef.current = true;
    sendNow();
  }, [audience, follow, presence, sendNow]);

  /* A bubble fades on the viewer's side after a length-based delay, so the copy
     on the stage runs the same clock. What went out on the wire stays until it
     is cleared, which is what a viewer arriving later gets shown. */
  useEffect(() => {
    if (!bubble) return;
    const timer = window.setTimeout(() => setBubble(null), ghostSpeechDurationMs(bubble.text));
    return () => window.clearTimeout(timer);
  }, [bubble]);

  const jumpToNewest = useCallback(() => {
    const log = logRef.current;
    if (!log) return;
    log.scrollTop = log.scrollHeight;
    stuckRef.current = true;
    setAtBottom(true);
  }, []);

  const connect = () => {
    if (!route) {
      setError("That is not a route this site serves.");
      return;
    }
    setConnected(true);
    settingsRef.current = { ...settingsRef.current, connected: true, route };
    dirtyRef.current = true;
    sendNow({ withViewers: true });
  };

  const disconnect = () => {
    const current = activeRouteRef.current ?? settingsRef.current.route;
    setConnected(false);
    settingsRef.current = { ...settingsRef.current, connected: false };
    activeRouteRef.current = null;
    speechRef.current = null;
    actionRef.current = null;
    setBubble(null);
    setPicking(false);
    void post({ op: "end", route: current });
  };

  const say = () => {
    const text = message.trim();
    // Nothing to send when he is not on a page: it would only log a line here
    // and leave the audience wondering what they missed.
    if (!text || !settingsRef.current.connected) return;
    eventIdRef.current += 1;
    speechRef.current = { id: eventIdRef.current, text };
    setBubble({ id: eventIdRef.current, text });
    setMessage("");
    dirtyRef.current = true;
    sendNow();
    pushChat({
      key: `s${eventIdRef.current}`,
      kind: "said",
      at: Date.now(),
      route: settingsRef.current.route,
      userId: null,
      // Whoever was on the page at the time, so the log still reads correctly
      // after a switch.
      name: settingsRef.current.character.name,
      text,
    });
  };

  const clearSpeech = () => {
    speechRef.current = null;
    setBubble(null);
    dirtyRef.current = true;
    sendNow();
  };

  const act = (kind: string) => {
    eventIdRef.current += 1;
    actionRef.current = { id: eventIdRef.current, kind };
    dirtyRef.current = true;
    sendNow();
    /* The same cue the audience gets, so firing one is not guesswork. */
    playGhostActionSfx(kind);
    pushChat({
      key: `a${eventIdRef.current}`,
      kind: "act",
      at: Date.now(),
      route: settingsRef.current.route,
      userId: null,
      name: settingsRef.current.character.name,
      text: findGhostAction(settingsRef.current.character, kind)?.label ?? kind,
    });
  };

  /* Audience and route move together when you pick a person off the roster:
     both have to be in settingsRef before the push, because state set here is
     not readable until the next render. */
  const aim = (next: GhostAudience, nextRoute?: string) => {
    setAudience(next);
    setPicking(false);
    if (nextRoute) setRouteInput(nextRoute);
    settingsRef.current = {
      ...settingsRef.current,
      audience: next,
      route: (nextRoute ? normalizeGhostRoute(nextRoute) : null) ?? settingsRef.current.route,
    };
    dirtyRef.current = true;
    sendNow();
    /* Aiming at someone is almost always the first half of answering them. */
    if (next.mode === "user") composerRef.current?.focus({ preventScroll: true });
  };

  const placeAt = (event: MouseEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    if (!stage) return;
    const box = stage.getBoundingClientRect();
    const { pageH, viewW } = pageMetricsRef.current;
    const scale = box.width / viewW;
    const offsetY = event.clientY - box.top;
    driveRef.current = {
      ...driveRef.current,
      x: clamp01((event.clientX - box.left) / box.width),
      y: settingsRef.current.anchor === "screen"
        // The stage is exactly one screen tall, so the click is the fraction.
        ? clamp01(offsetY / box.height)
        // Through the camera: a click near the bottom of a scrolled stage is a
        // point further down the page, not the bottom of it.
        : clamp01((offsetY / scale + cameraRef.current) / pageH),
    };
    placeMarker();
    dirtyRef.current = true;
    sendNow();
  };

  const poseClip = findGhostPose(character, pose)?.clip ?? null;
  const stageClip = poseClip ?? walkClipFor(character, look.facing);
  const sided = directionalGhostFrame(character, stageClip, look.facing);
  /* Same rule the overlay draws by: a pose animates on its own only if it
     is not a gait, and a gait moves when he does. */
  const animated = useAnimatedFrame(
    character,
    stageClip,
    sided == null && (look.moving || (poseClip != null && isLoopingGhostPose(character, poseClip))),
  );
  const frame = sided ?? animated;
  /* Same on-screen size he has for the viewer, shrunk by whatever the preview is
     shrunk by, and the bubble sits above his head off the same number. It keeps
     a floor so a heavily shrunk stage still shows a readable line. */
  const stageSpriteScale = Math.max(0.75, fitGhostScale(character, scale, viewport.w) * (previewScale || 0.6));
  const bubbleScale = Math.max(0.6, previewScale || 0.6);

  return (
    <div className="mx-auto w-full max-w-[100rem] px-4 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Ghost</h1>
          <p className="text-xs text-osu-f1">
            Appear on a page as {character.name}. WASD moves him, everything is live for whoever is in the audience.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-semibold ${connected ? "bg-osu-pink/20 text-osu-pink-light" : "bg-osu-b3/60 text-osu-f1"}`}>
            {connected ? <PlugZap className="h-3.5 w-3.5" /> : <Plug className="h-3.5 w-3.5" />}
            {connected ? "connected" : "off"}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-md bg-osu-b3/60 px-2 py-1 text-osu-f1">
            <Users className="h-3.5 w-3.5" />
            {presence.totals.viewers} on site
          </span>
        </div>
      </div>

      {ticketError ? <Notice text={ticketError} /> : null}
      {error ? <Notice text={error} /> : null}

      {/* Stage on the left, the conversation pinned down the right: talking is
          the part you do constantly, so it keeps its own column instead of
          sitting under three rows of controls. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <input
              value={routeInput}
              onChange={(event) => setRouteInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !connected) connect();
              }}
              placeholder="/player/jakads"
              list="ghost-live-routes"
              className="min-w-[220px] flex-1 rounded-md bg-osu-b3/60 px-3 py-2 text-sm text-white outline-none placeholder:text-osu-f1/60"
            />
            <datalist id="ghost-live-routes">
              {presence.routes.map((entry) => <option key={entry.route} value={entry.route} />)}
            </datalist>
            <button
              type="button"
              onClick={connected ? disconnect : connect}
              disabled={!ticket}
              className={`cursor-pointer rounded-md px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${connected ? "bg-osu-b3/70 text-white hover:bg-osu-b3" : "bg-osu-pink/25 text-white hover:bg-osu-pink/40"}`}
            >
              {connected ? "Disconnect" : "Connect"}
            </button>
            {!ticket && !ticketError ? <Loader2 className="h-4 w-4 animate-spin text-osu-f1" /> : null}
          </div>

          <div className="mb-4">
            <div
              ref={stageRef}
              onClick={placeAt}
              style={{ aspectRatio: `${viewport.w} / ${viewport.h}` }}
              className="relative w-full cursor-crosshair overflow-hidden rounded-lg bg-osu-b5"
            >
              {preview && canPreview && previewScale > 0 ? (
                /* The real page at exactly the viewer's viewport size, scaled to
                   fit: one screen of it, laid out as they see it. Walking down
                   scrolls this frame rather than stretching it. The hash keeps
                   the framed copy's own overlay asleep. */
                <iframe
                  key={previewRoute}
                  ref={frameRef}
                  src={`${previewRoute}${GHOST_PREVIEW_HASH}`}
                  title="Page preview"
                  tabIndex={-1}
                  scrolling="no"
                  className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
                  style={{ width: viewport.w, height: viewport.h, transform: `scale(${previewScale})` }}
                />
              ) : (
                <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:40px_40px]" />
              )}
              <div ref={markerRef} className="absolute">
                {composing ? (
                  /* Where the bubble is about to be, in the same black box the
                     viewers read it in, so talking happens where you are
                     looking instead of at the bottom of the page. Kept at a
                     readable size rather than scaled down with the preview. */
                  <div
                    className="absolute left-0 w-max -translate-x-1/2"
                    style={{ bottom: ghostBubbleLift(character, stageClip, stageSpriteScale) }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="rounded-md border-2 border-white bg-black px-2 py-1.5">
                      <input
                        ref={stageComposerRef}
                        value={message}
                        onChange={(event) => setMessage(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            say();
                            setComposing(false);
                          }
                          // Keeps the draft: reopening picks up where it left off.
                          if (event.key === "Escape") setComposing(false);
                        }}
                        onBlur={() => {
                          if (!message.trim()) setComposing(false);
                        }}
                        maxLength={240}
                        placeholder="say something"
                        aria-label={`Say something as ${character.name}`}
                        className="w-[min(240px,40vw)] bg-transparent text-[13px] font-semibold text-white outline-none placeholder:text-white/40"
                      />
                    </div>
                    <div className="mx-auto h-0 w-0 border-x-[7px] border-t-[8px] border-x-transparent border-t-white" />
                  </div>
                ) : bubble ? (
                  /* What the audience is reading right now, over his head where
                     they see it, so the owner can tell whether a line landed and
                     what it is covering up. */
                  <div
                    className="absolute left-0 w-max max-w-[320px]"
                    style={{
                      bottom: ghostBubbleLift(character, stageClip, stageSpriteScale),
                      transform: `translateX(-50%) scale(${bubbleScale})`,
                      transformOrigin: "bottom center",
                    }}
                  >
                    <GhostBubbleBox>{bubble.text}</GhostBubbleBox>
                  </div>
                ) : null}
                <GhostAtlasFrame
                  character={character}
                  clip={stageClip}
                  frame={frame}
                  scale={stageSpriteScale}
                  flip={shouldFlipGhostClip(character, stageClip, look.facing)}
                />
              </div>
              {!connected ? (
                <div className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-osu-f1">
                  connect to put him on the page
                </div>
              ) : null}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-osu-f1">
              <span>WASD to walk, shift to run, 1-{GHOST_CHARACTER_LIST.length} to swap character, click the stage to place him, enter or T to talk, esc to close it</span>
              <button
                type="button"
                onClick={() => setPreview((value) => !value)}
                className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-osu-f1 transition-colors hover:text-white"
              >
                {preview ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                {preview ? "hide the page" : "show the page"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAnchor((value) => (value === "page" ? "screen" : "page"));
                  dirtyRef.current = true;
                }}
                title="page: he stands in the document and scrolls with it. screen: same spot for everyone, whatever their layout"
                className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-osu-f1 transition-colors hover:text-white"
              >
                {anchor === "screen" ? <Pin className="h-3 w-3" /> : <PinOff className="h-3 w-3" />}
                {anchor === "screen" ? "stuck to the screen" : "standing in the page"}
              </button>
              <button
                type="button"
                onClick={() => setSound((value) => !value)}
                title="only mutes this panel, not the audience"
                className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-osu-f1 transition-colors hover:text-white"
              >
                {sound ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />}
                {sound ? "sound on" : "muted here"}
              </button>
              <span>
                {canPreview
                  ? `${viewport.w}x${viewport.h}`
                  : previewRoute === GHOST_PANEL_ROUTE
                    ? "this panel, no preview of itself"
                    : "wildcard route, no preview"}
                {targetViewer ? ` (${targetViewer.username}'s screen)` : " (your screen)"}
              </span>
              <label className="ml-auto flex items-center gap-2">
                size
                <input
                  type="range"
                  /* Per character: the dog needs a bigger number than Ralsei to
                     stand the same height, because the number is sprite pixels. */
                  min={character.scale.min}
                  max={character.scale.max}
                  step={0.5}
                  value={scale}
                  onChange={(event) => {
                    setScale(Number(event.target.value));
                    dirtyRef.current = true;
                  }}
                  className="w-28 accent-osu-pink"
                />
                {scale}x
              </label>
            </div>
          </div>

          {/* Who to be. Each one draws itself rather than being named in a
              dropdown: the sprite is the thing being picked, and the poses and
              actions underneath change with it. */}
          <div className="mb-3 flex flex-wrap gap-2">
            {GHOST_CHARACTER_LIST.map((entry, index) => (
              <CharacterCard
                key={entry.id}
                character={entry}
                index={index}
                active={entry.id === character.id}
                onClick={() => pickCharacter(entry)}
              />
            ))}
          </div>

          {/* A character with no one-shot moves shows no row rather than an
              empty one: the dog's whole act is its poses. */}
          {character.actions.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-2">
              {character.actions.map((action) => (
                <button
                  key={action.kind}
                  type="button"
                  onClick={() => act(action.kind)}
                  disabled={!connected}
                  className="cursor-pointer rounded-md bg-osu-b3/60 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-osu-b3 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="mb-6 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-osu-f1">Pose</span>
            {character.poses.map((entry) => (
              <Segment
                key={entry.kind}
                active={pose === entry.kind}
                label={entry.label}
                onClick={() => {
                  // Clicking the pose he is already holding drops it and puts
                  // him back on the walk cycle.
                  setPose(pose === entry.kind ? "auto" : entry.kind);
                  dirtyRef.current = true;
                }}
              />
            ))}
          </div>

          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-osu-f1">
              Who is where
              <span className="font-normal text-osu-f1/70">
                {presence.totals.viewers} open across {presence.totals.routes} pages, {presence.totals.named} signed in
              </span>
            </div>
            {presence.routes.length === 0 ? (
              <div className="text-xs text-osu-f1/70">Nobody has a page open right now.</div>
            ) : (
              <div className="flex flex-col gap-1">
                {(showAllRoutes ? presence.routes : presence.routes.slice(0, ROUTE_ROWS)).map((entry) => {
                  /* Only the named viewers are listable, and only a few of them
                     per row: a popular page can hold hundreds. */
                  const named = presence.viewers.filter((viewer) => viewer.route === entry.route);
                  const shown = named.slice(0, NAMES_PER_ROUTE);
                  return (
                    <div key={entry.route} className="flex flex-wrap items-center gap-2 rounded-md bg-osu-b4/60 px-3 py-2">
                      <button
                        type="button"
                        onClick={() => setRouteInput(entry.route)}
                        className="cursor-pointer text-sm font-semibold text-white transition-colors hover:text-osu-pink-light"
                      >
                        {entry.route}
                      </button>
                      <span className="text-[11px] text-osu-f1">
                        {entry.viewers} open
                        {entry.narrow > 0 ? `, ${entry.narrow} on phones` : ""}
                        {entry.showing > 0 ? `, ${entry.showing} seeing him` : ""}
                      </span>
                      <div className="ml-auto flex flex-wrap items-center gap-1.5">
                        {shown.map((viewer) => (
                          <button
                            key={viewer.id}
                            type="button"
                            onClick={() => {
                              if (viewer.userId != null) aim({ mode: "user", userId: viewer.userId }, viewer.route);
                            }}
                            title={viewer.viewport ? `${viewer.viewport.w}x${viewer.viewport.h}` : "unknown viewport"}
                            className={`cursor-pointer rounded px-1.5 py-0.5 text-[11px] font-semibold transition-colors ${
                              viewer.showing ? "bg-osu-pink/25 text-osu-pink-light" : "bg-osu-b3/60 text-white hover:bg-osu-b3"
                            }`}
                          >
                            {viewer.username}
                          </button>
                        ))}
                        {named.length > shown.length ? (
                          <span className="text-[11px] text-osu-f1">+{named.length - shown.length} signed in</span>
                        ) : null}
                        {entry.viewers > entry.named ? (
                          <span className="text-[11px] text-osu-f1/60">{entry.viewers - entry.named} anon</span>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
                {presence.routes.length > ROUTE_ROWS ? (
                  <button
                    type="button"
                    onClick={() => setShowAllRoutes((value) => !value)}
                    className="cursor-pointer self-start px-1 py-1 text-[11px] font-semibold text-osu-f1 transition-colors hover:text-white"
                  >
                    {showAllRoutes ? "show fewer pages" : `show all ${presence.routes.length} pages`}
                  </button>
                ) : null}
                {presence.truncated ? (
                  <div className="text-[11px] text-osu-f1/60">Busiest pages and newest arrivals only; the rest are counted, not listed.</div>
                ) : null}
              </div>
            )}
          </div>
        </div>

        <aside className="flex h-[30rem] min-w-0 flex-col overflow-hidden rounded-lg bg-osu-b4/60 lg:sticky lg:top-4 lg:h-[calc(100vh-6rem)]">
          <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 text-xs">
            <span className="text-osu-f1">Seen by</span>
            <Segment active={audience.mode === "everyone"} onClick={() => aim({ mode: "everyone" })} label="Everyone here" />
            <Segment
              active={audience.mode === "user"}
              onClick={() => setPicking((open) => !open)}
              label={targetViewer?.username ? `Only ${targetViewer.username}` : "Only one person"}
            />
            <Segment active={audience.mode === "none"} onClick={() => aim({ mode: "none" })} label="Nobody" />
            {audience.mode === "user" ? (
              <Segment
                active={follow}
                onClick={() => setFollow((value) => !value)}
                label={follow ? "following" : "follow"}
              />
            ) : null}
            <span className="w-full text-osu-f1/70">
              {audience.mode === "none"
                /* Staging only shows him back to you if the backend can recognise
                   you, which means being signed in, not just admin on localhost. */
                ? (auth.viewer ? "staging: only you see him" : "staging: nobody sees him")
                : `${routeHere?.showing ?? 0} of ${routeHere?.viewers ?? 0} on this page`}
              {/* One placement cannot land in the same place for a phone and a
                  desktop unless it is anchored to the screen. */}
              {audience.mode !== "user" && anchor === "page" && routeHere && routeHere.narrow > 0 && routeHere.narrow < routeHere.viewers
                ? `, ${routeHere.narrow} of them on phones seeing him somewhere else`
                : ""}
            </span>
          </div>

          {picking ? (
            <div className="max-h-44 shrink-0 overflow-y-auto px-3 pb-2 text-xs">
              {presence.viewers.length === 0 ? (
                /* The roster only names people the backend could verify, so an
                   empty list means nobody signed in has a page open. */
                <span className="text-osu-f1/70">Nobody signed in has a page open right now, so there is no one to aim at yet.</span>
              ) : (
                <div className="flex flex-col">
                  {presence.viewers.slice(0, PICKER_LIMIT).map((viewer) => (
                    <button
                      key={viewer.id}
                      type="button"
                      onClick={() => aim({ mode: "user", userId: viewer.userId! }, viewer.route)}
                      className="flex cursor-pointer items-baseline gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-osu-b3/60"
                    >
                      <span className="font-semibold text-white">{viewer.username}</span>
                      <span className="truncate text-[11px] text-osu-f1">{viewer.route}</span>
                    </button>
                  ))}
                  {presence.viewers.length > PICKER_LIMIT ? (
                    <span className="px-1 py-1 text-osu-f1/70">+{presence.viewers.length - PICKER_LIMIT} more, newest first</span>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          {/* The log itself: newest at the bottom like any chat, both sides in
              one column so a reply reads against what it answers. */}
          <div className="relative min-h-0 flex-1">
            <div ref={logRef} onScroll={trackScroll} className="h-full overflow-y-auto px-3 py-1">
              {chat.length === 0 ? (
                <p className="py-2 text-xs text-osu-f1/70">
                  Nothing said yet. Viewers click him to answer, and nothing here survives a restart.
                </p>
              ) : (
                chat.map((line) => (
                  <ChatRow
                    key={line.key}
                    line={line}
                    activeRoute={route}
                    onAim={(userId, target) => aim({ mode: "user", userId }, target)}
                  />
                ))
              )}
            </div>
            {!atBottom ? (
              <button
                type="button"
                onClick={jumpToNewest}
                className="absolute bottom-2 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-1 rounded-full bg-osu-pink/80 px-3 py-1 text-[11px] font-semibold text-white"
              >
                <ArrowDown className="h-3 w-3" />
                newest
              </button>
            ) : null}
          </div>

          <div className="px-3 py-2">
            {bubble ? (
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-osu-f1">
                <span className="truncate">on screen: {bubble.text}</span>
                <button
                  type="button"
                  onClick={clearSpeech}
                  title="clear the bubble"
                  className="cursor-pointer text-osu-f1 transition-colors hover:text-white"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <input
                ref={composerRef}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  /* Both keys hand the keyboard back to the stage, which is
                     where WASD works again: enter sends first, escape drops
                     what was typed. */
                  if (event.key === "Enter") {
                    say();
                    composerRef.current?.blur();
                  }
                  if (event.key === "Escape") composerRef.current?.blur();
                }}
                maxLength={240}
                placeholder={targetViewer ? `say something to ${targetViewer.username}` : "say something"}
                className="min-w-0 flex-1 rounded-md bg-osu-b3/60 px-3 py-2 text-sm text-white outline-none placeholder:text-osu-f1/60"
              />
              <button
                type="button"
                onClick={say}
                disabled={!connected || !message.trim()}
                className="cursor-pointer rounded-md bg-osu-pink/25 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-osu-pink/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Say
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/* One log line. Flat rows rather than cards: at chat speed the boxes are what
   you end up reading instead of the words. */
function ChatRow({ line, activeRoute, onAim }: {
  line: ChatLine;
  activeRoute: string | null;
  onAim: (userId: number, route: string) => void;
}) {
  const time = new Date(line.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const elsewhere = line.route !== activeRoute;
  return (
    <div className="px-1 py-[3px] text-sm leading-snug">
      <span className="mr-1.5 text-[11px] tabular-nums text-osu-f1/50">{time}</span>
      {line.kind === "act" ? (
        <span className="text-osu-f1">* {line.text}</span>
      ) : (
        <>
          {line.kind === "said" ? (
            <span className="font-semibold text-osu-pink-light">{line.name ?? "Ghost"}</span>
          ) : (
            <button
              type="button"
              disabled={line.userId == null}
              onClick={() => {
                if (line.userId != null) onAim(line.userId, line.route);
              }}
              title={line.userId != null ? "aim at them and answer" : "not signed in"}
              style={{ color: line.userId != null ? nameColor(line.name ?? "") : undefined }}
              className="cursor-pointer font-semibold hover:underline disabled:cursor-default disabled:text-osu-f1"
            >
              {line.name ?? "anon"}
            </button>
          )}
          {elsewhere ? <span className="ml-1.5 text-[11px] text-osu-f1/60">{line.route}</span> : null}
          <span className="text-osu-f1/60">: </span>
          <span className="text-white">{line.text}</span>
        </>
      )}
    </div>
  );
}

/* Same person, same colour, every session. */
function nameColor(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return NAME_COLORS[hash % NAME_COLORS.length];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/* One entry in the picker: the character drawn at its own idle, its name, and
   the number key that selects it. Sprites are scaled towards a common height so
   a 19px dog and a 43px Ralsei are both worth looking at here, which is the one
   place their real sizes are not the point. */
const CARD_ART_HEIGHT = 34;

/* Whole numbers only: a pixel sprite at 1.7x is a smeared pixel sprite. */
function cardScale(character: GhostCharacter): number {
  return Math.max(1, Math.round(CARD_ART_HEIGHT / ghostClipBounds(character, character.idle).h));
}

/* Every card is the size of the biggest drawing on the roster, so the row is
   one line of even boxes and nobody's hat pokes out of the top. */
const CARD_BOX = {
  w: Math.max(...GHOST_CHARACTER_LIST.map((entry) => ghostClipBounds(entry, entry.idle).w * cardScale(entry))),
  h: Math.max(...GHOST_CHARACTER_LIST.map((entry) => ghostClipBounds(entry, entry.idle).h * cardScale(entry))),
};

function CharacterCard({ character, index, active, onClick }: {
  character: GhostCharacter;
  index: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={character.blurb}
      aria-pressed={active}
      className={`flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
        active ? "bg-osu-pink/25" : "bg-osu-b3/60 hover:bg-osu-b3"
      }`}
    >
      <span className="relative block" style={{ width: CARD_BOX.w, height: CARD_BOX.h }}>
        {/* The frame draws itself up and left of its own anchor, so the anchor
            is parked where the feet belong: bottom centre of the box. */}
        <span className="absolute bottom-0 left-1/2 block">
          <GhostAtlasFrame character={character} clip={character.idle} frame={0} scale={cardScale(character)} />
        </span>
      </span>
      <span className="flex flex-col">
        <span className={`text-sm font-semibold ${active ? "text-white" : "text-osu-f1"}`}>{character.name}</span>
        <span className="text-[10px] text-osu-f1/60">{index + 1}</span>
      </span>
    </button>
  );
}

function Segment({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer rounded-md px-2.5 py-1 font-semibold transition-colors ${
        active ? "bg-osu-pink/25 text-white" : "bg-osu-b3/60 text-osu-f1 hover:text-white"
      }`}
    >
      {label}
    </button>
  );
}

function Notice({ text }: { text: string }) {
  return <div className="mb-3 rounded-md bg-osu-red/15 px-3 py-2 text-xs text-osu-red-light">{text}</div>;
}

/* This browser's own window, which is what the stage is shaped like whenever it
   is not shaped like one specific person's. */
function useOwnViewport(): { w: number; h: number } {
  const [size, setSize] = useState({ w: 1536, h: 864 });
  useEffect(() => {
    const read = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);
  return size;
}

/* Stage-only animation: the overlay runs its own rAF loop, this just keeps the
   preview from being a frozen frame. */
function useAnimatedFrame(character: GhostCharacter, clip: string, animating: boolean): number {
  const [frame, setFrame] = useState(0);
  const fps = ghostClip(character, clip).fps;
  useEffect(() => {
    if (!animating) {
      setFrame(0);
      return;
    }
    const timer = window.setInterval(() => setFrame((value) => value + 1), 1000 / fps);
    return () => window.clearInterval(timer);
  }, [animating, fps]);
  return frame;
}
