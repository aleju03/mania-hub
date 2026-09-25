import { createFileRoute, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { ArrowDown, Eye, EyeOff, Loader2, MessageCircle, Pin, PinOff, Plug, PlugZap, Users, Volume2, VolumeX, X } from "lucide-react";
import { MASCOT_PREVIEW_HASH } from "../../components/mascot/MascotLayer";
import { MascotAtlasFrame, MascotBubbleBox } from "../../components/mascot/MascotSprite";
import { Avatar } from "../../components/ui/Avatar";
import { useAuth } from "../../lib/auth-context";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { getMascotControlTicket } from "../../lib/mascot";
import { playMascotActionSfx, preloadMascotSfx, setMascotSfxMuted } from "../../lib/mascot-sfx";
import {
  DEFAULT_MASCOT_CHARACTER,
  EMPTY_MASCOT_PRESENCE,
  MASCOT_CHARACTER_LIST,
  directionalMascotFrame,
  findMascotAction,
  findMascotPose,
  fitMascotScale,
  isMascotGait,
  isLoopingMascotPose,
  followMascotCamera,
  mascotCharacter,
  mascotClip,
  mascotClipBounds,
  mascotMoveStep,
  mascotBubbleLift,
  mascotSpeechDurationMs,
  normalizeMascotRoute,
  shouldFlipMascotClip,
  walkClipFor,
  wrapMascotX,
  type MascotAnchor,
  type MascotAudience,
  type MascotCharacter,
  type MascotFacing,
  type MascotPresence,
  type MascotPresenceViewer,
  type MascotReply,
  type MascotVisual,
} from "../../lib/mascot-shared";
import { getLiveBackendUrl } from "../../lib/live-backend";

/* The mascot control room.

   The browser drives the backend directly here, with a short-lived ticket
   instead of the admin token: movement goes out ~15 times a second and a hop
   through the frontend server would put a round trip in front of every step.
   Position is normalized (0..1 across the page width and down the whole
   document), so one stage drives every screen size watching, and the stage is a
   camera over the framed page rather than the whole of it. */

export const Route = createFileRoute("/admin/mascot")({
  head: () => ({
    meta: [
      { title: "Ralsei - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: MascotAdminPage,
});

/* The control panel is a page like any other, so the tab you drive from shows up
   in the roster as a viewer on it. Staging against it frames the panel inside
   itself: a second stage, a second marker, and a second of everything below.
   Nothing automatic aims there, and it never gets a preview. */
const MASCOT_PANEL_ROUTE = "/admin/mascot";
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
/* Below this the page is one column with a thumb stick under the stage instead
   of two columns and a keyboard. Same number as Tailwind's lg, which is where
   the grid stops fitting. */
const MOBILE_QUERY = "(max-width: 1023px)";
/* How much of a phone's screen the stage may take. The rest is the controls,
   and a stage that pushed them under the fold would make the page a scroll
   between looking and doing. */
const MOBILE_STAGE_VH = 50;
/* The stick's travel in CSS pixels, and the two rings inside it: a thumb resting
   near the middle is not a direction, and the rim is the run key. */
const STICK_RADIUS = 46;
const STICK_DEADZONE = 0.22;
const STICK_SPRINT = 0.82;

const KEY_DIRECTIONS: Record<string, MascotFacing> = {
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
  facing: MascotFacing;
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

function MascotAdminPage() {
  const auth = useAuth();
  const base = getLiveBackendUrl();
  const [ticket, setTicket] = useState<string | null>(null);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [routeInput, setRouteInput] = useState("/");
  const [audience, setAudience] = useState<MascotAudience>({ mode: "none" });
  /* Who is being driven. Poses, actions and the size range all come off the
     roster entry, so switching swaps the whole control set below. */
  const [characterId, setCharacterId] = useState<string>(DEFAULT_MASCOT_CHARACTER);
  const character = mascotCharacter(characterId);
  const [pose, setPose] = useState<string>("auto");
  /* What his position is measured against on the far side. Standing in the page
     is the default and the right one when aiming at a person; sticking to the
     screen is what makes a placement mean the same thing to a phone and a
     desktop looking at the same page. */
  const [anchor, setAnchor] = useState<MascotAnchor>("page");
  const [scale, setScale] = useState(mascotCharacter(DEFAULT_MASCOT_CHARACTER).scale.default);
  const [message, setMessage] = useState("");
  const [presence, setPresence] = useState<MascotPresence>(EMPTY_MASCOT_PRESENCE);
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
  /* What the cursor is over on the sprite bar. The tiles carry no words, so
     this line is where the name of the thing about to be clicked lives. */
  const [hint, setHint] = useState<string | null>(null);
  /* Showing him to a whole page is the one control here that cannot be taken
     back, so it asks twice. Armed by the first click, and it lapses on its own
     rather than sitting there waiting to be leaned on. */
  const [armEveryone, setArmEveryone] = useState(false);
  /* The quick "is X here" lookup over the roster. Only signed-in viewers have
     names, so anyone browsing signed out is findable as a count, not by name. */
  const [viewerQuery, setViewerQuery] = useState("");
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
  const [look, setLook] = useState<{ facing: MascotFacing; moving: boolean }>({ facing: "down", moving: false });
  /* On a phone the panel is one column with a thumb stick under the stage: the
     cast, the roster and the conversation are each a tab rather than three
     screens of scrolling, and every control that was a hover is a tap. */
  const mobile = useIsMobileLayout();
  const [tab, setTab] = useState<"chat" | "cast" | "who">("chat");

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
  /* The stick writes here rather than into state: at 60 frames a second a
     rendered stick would be the one part of this page that stutters. */
  const stickRef = useRef({ dx: 0, dy: 0, sprint: false });
  const speechRef = useRef<MascotVisual["speech"]>(null);
  const actionRef = useRef<MascotVisual["action"]>(null);
  const eventIdRef = useRef(1);
  const lastSentRef = useRef(0);
  const dirtyRef = useRef(true);
  /* The route the backend currently holds a session on, which lags the input
     box while you are typing a new one. */
  const activeRouteRef = useRef<string | null>(null);
  /* Control patches still on the wire, and the newest end queued behind them.
     Two fetches can reach the backend in either order, so an end has to wait
     for every patch in flight (a patch that overtook it would quietly recreate
     the session on a screen nobody is driving anymore), and the next patch
     waits for the end so a quick reconnect cannot be killed by a late one. */
  const inflightPatchesRef = useRef<Set<Promise<unknown>>>(new Set());
  const lastEndRef = useRef<Promise<unknown>>(Promise.resolve());
  /* Loop-visible copy of everything the send payload needs, so the rAF loop
     never has to be torn down and rebuilt on a settings change. */
  const settingsRef = useRef({ route: "/", audience, character, pose, scale, anchor, connected, ticket });
  settingsRef.current = { route: normalizeMascotRoute(routeInput) ?? "/", audience, character, pose, scale, anchor, connected, ticket };

  const route = normalizeMascotRoute(routeInput);
  /* Their newest tab that is not the control panel, so testing on yourself
     stages against the page you are actually reading rather than this one. */
  const targetViewer = audience.mode === "user"
    ? presence.viewers.find((viewer) => viewer.userId === audience.userId && viewer.route !== MASCOT_PANEL_ROUTE)
      ?? presence.viewers.find((viewer) => viewer.userId === audience.userId)
      ?? null
    : null;
  /* The roster only names signed-in viewers; everyone else is a count. */
  const routeHere = route ? presence.routes.find((entry) => entry.route === route) ?? null : null;
  /* One tile per person, their open tabs gathered under them, newest arrival
     first. The search only narrows the same grid. */
  const trimmedViewerQuery = viewerQuery.trim();
  const people = new Map<number, MascotPresenceViewer[]>();
  {
    const needle = trimmedViewerQuery.toLowerCase();
    for (const viewer of presence.viewers) {
      if (viewer.userId == null) continue;
      if (needle && !viewer.username?.toLowerCase().includes(needle)) continue;
      const tabs = people.get(viewer.userId);
      if (tabs) tabs.push(viewer);
      else people.set(viewer.userId, [viewer]);
    }
  }
  const ownViewport = useOwnViewport();
  /* Aiming at one person stages against their screen, because then the pixels
     are the point: next to their avatar means next to their avatar. With nobody
     picked there is no single screen to match, so it stages against yours rather
     than reshaping itself around whoever last landed on the page. */
  const viewport = targetViewer?.viewport ?? ownViewport;
  const previewScale = stageWidth > 0 ? stageWidth / viewport.w : 0;
  const canPreview = Boolean(previewRoute) && !previewRoute!.endsWith("/*") && previewRoute !== MASCOT_PANEL_ROUTE;
  /* Without a framed page to measure, the page is just one screen tall. */
  const pageHeightPx = pageHeight > 0 ? Math.max(pageHeight, viewport.h) : viewport.h;
  pageMetricsRef.current = { viewW: viewport.w, viewH: viewport.h, pageH: pageHeightPx };

  useEffect(() => {
    let cancelled = false;
    const mint = async () => {
      try {
        const issued = await getMascotControlTicket();
        if (cancelled) return;
        if (!issued) {
          setTicketError("The live backend is not configured for mascot control.");
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
    cameraRef.current = followMascotCamera(cameraRef.current, targetPx, viewH, pageH);
    marker.style.top = `${(targetPx - cameraRef.current) * scale}px`;
    frameRef.current?.contentWindow?.scrollTo({ top: cameraRef.current, behavior: "instant" });
  }, []);

  useEffect(placeMarker, [placeMarker, anchor, connected, preview, stageWidth, pageHeight, viewport.w, viewport.h]);

  useEffect(() => {
    preloadMascotSfx();
  }, []);

  useEffect(() => {
    if (composing) stageComposerRef.current?.focus({ preventScroll: true });
  }, [composing]);

  useEffect(() => {
    setMascotSfxMuted(!sound);
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
      const response = await fetch(`${base}/api/updates/control?ticket=${encodeURIComponent(current)}`, {
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

  /* Ends one route's session, or with no route every session there is, ordered
     behind whatever control traffic is still in flight. */
  const endSessions = useCallback((route?: string) => {
    const settled = Promise.all([lastEndRef.current, ...inflightPatchesRef.current]);
    lastEndRef.current = settled.then(() => post(route ? { op: "end", route } : { op: "end" }));
  }, [post]);

  const buildVisual = useCallback((): MascotVisual => {
    const state = driveRef.current;
    const settings = settingsRef.current;
    const posed = findMascotPose(settings.character, settings.pose)?.clip ?? null;
    /* A held pose stops the walk cycle, except where the pose is itself a way
       of walking: the dog on stilts takes a stride per step and stands still
       between them, rather than marching on the spot. */
    const striding = posed != null && isMascotGait(settings.character, posed);
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
      endSessions(activeRouteRef.current);
    }
    activeRouteRef.current = settings.route;
    lastSentRef.current = performance.now();
    dirtyRef.current = false;
    /* The payload is what this tick saw; only the fetch waits behind the end. */
    const body = {
      route: settings.route,
      audience: settings.audience,
      ownerUserId: auth.viewer?.id ?? null,
      visual: buildVisual(),
      withViewers: extra?.withViewers === true,
    };
    const request = lastEndRef.current.then(() => post(body));
    inflightPatchesRef.current.add(request);
    void request.then((response) => {
      inflightPatchesRef.current.delete(request);
      if (!response?.ok || extra?.withViewers !== true) return;
      void response.json().then((payload: { presence?: MascotPresence }) => {
        if (payload.presence) setPresence(payload.presence);
      }).catch(() => undefined);
    });
  }, [auth.viewer?.id, buildVisual, endSessions, post]);

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
      /* The stick is another pair of axes, so touch and keys go through the
         same integration: pushed to the rim it is the run key. */
      const stick = stickRef.current;
      dx += stick.dx;
      dy += stick.dy;
      const sprinting = keysRef.current.has("shift") || stick.sprint;
      const moving = dx !== 0 || dy !== 0;
      const state = driveRef.current;
      if (moving) {
        const page = pageMetricsRef.current;
        const step = mascotMoveStep({ dx, dy }, {
          sprinting,
          dt,
          viewWidth: page.viewW,
          // A screen-anchored step covers a screen, not a whole document.
          pageHeight: settingsRef.current.anchor === "screen" ? page.viewH : page.pageH,
        });
        // Sideways he wraps; up and down he stops at the ends of the page.
        const nextX = wrapMascotX(state.x + step.dx);
        const nextY = clamp01(state.y + step.dy);
        /* The longer axis wins the facing, so an analog push that is mostly
           sideways keeps the side view instead of flickering between two clips,
           and a key-held diagonal (both axes equal) still reads as sideways. */
        const facing: MascotFacing = Math.abs(dx) >= Math.abs(dy)
          ? (dx < 0 ? "left" : "right")
          : dy < 0 ? "up" : "down";
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
  const pickCharacter = useCallback((next: MascotCharacter) => {
    const current = settingsRef.current;
    if (next.id === current.character.id) return;
    scaleMemoryRef.current[current.character.id] = current.scale;
    // A pose only survives the switch if the new character has one by that name.
    const keptPose = findMascotPose(next, current.pose) ? current.pose : "auto";
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
        const picked = MASCOT_CHARACTER_LIST[Number(key) - 1];
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
        const response = await fetch(`${base}/api/updates/presence?ticket=${encodeURIComponent(ticket)}`);
        if (!response.ok || cancelled) return;
        const payload = await response.json() as MascotPresence;
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
    const source = new EventSource(`${base}/api/updates/inbox?ticket=${encodeURIComponent(ticket)}`);
    source.addEventListener("reply", (event) => {
      try {
        const reply = JSON.parse((event as MessageEvent).data) as MascotReply;
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
    const viewer = presence.viewers.find((entry) => entry.userId === audience.userId && entry.route !== MASCOT_PANEL_ROUTE);
    const next = viewer ? normalizeMascotRoute(viewer.route) : null;
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
    const timer = window.setTimeout(() => setBubble(null), mascotSpeechDurationMs(bubble.text));
    return () => window.clearTimeout(timer);
  }, [bubble]);

  useEffect(() => {
    if (!armEveryone) return;
    const timer = window.setTimeout(() => setArmEveryone(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [armEveryone]);

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
    setConnected(false);
    settingsRef.current = { ...settingsRef.current, connected: false };
    activeRouteRef.current = null;
    speechRef.current = null;
    actionRef.current = null;
    setBubble(null);
    setPicking(false);
    /* Every session, not just the active route: a retarget whose end was lost
       or raced can have left him behind on a page long since moved off. */
    endSessions();
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
    playMascotActionSfx(kind);
    pushChat({
      key: `a${eventIdRef.current}`,
      kind: "act",
      at: Date.now(),
      route: settingsRef.current.route,
      userId: null,
      name: settingsRef.current.character.name,
      text: findMascotAction(settingsRef.current.character, kind)?.label ?? kind,
    });
  };

  /* Audience and route move together when you pick a person off the roster:
     both have to be in settingsRef before the push, because state set here is
     not readable until the next render. */
  const aim = (next: MascotAudience, nextRoute?: string) => {
    setAudience(next);
    setPicking(false);
    setArmEveryone(false);
    if (nextRoute) setRouteInput(nextRoute);
    settingsRef.current = {
      ...settingsRef.current,
      audience: next,
      route: (nextRoute ? normalizeMascotRoute(nextRoute) : null) ?? settingsRef.current.route,
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

  const poseClip = findMascotPose(character, pose)?.clip ?? null;
  const stageClip = poseClip ?? walkClipFor(character, look.facing);
  const sided = directionalMascotFrame(character, stageClip, look.facing);
  /* Same rule the overlay draws by: a pose animates on its own only if it
     is not a gait, and a gait moves when he does. */
  const animated = useAnimatedFrame(
    character,
    stageClip,
    sided == null && (look.moving || (poseClip != null && isLoopingMascotPose(character, poseClip))),
  );
  const frame = sided ?? animated;
  /* Same on-screen size he has for the viewer, shrunk by whatever the preview is
     shrunk by, and the bubble sits above his head off the same number. It keeps
     a floor so a heavily shrunk stage still shows a readable line. */
  const stageSpriteScale = Math.max(0.75, fitMascotScale(character, scale, viewport.w) * (previewScale || 0.6));
  const bubbleScale = Math.max(0.6, previewScale || 0.6);
  /* The row under the stage is hover-sized text on a desktop and a row of tap
     targets on a phone, where there is no hover to explain a bare icon. */
  const toggleClass = mobile
    ? "inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-osu-b3/60 px-2.5 py-1.5 text-[11px] font-semibold text-osu-f1"
    : "inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-osu-f1 transition-colors hover:text-white";
  /* One column on a phone, so the three panels under the stage take turns
     instead of stacking into a page you have to scroll to talk. */
  const hidden = (owner: "chat" | "cast" | "who") => (mobile && tab !== owner ? "hidden" : "");

  return (
    <div className="mx-auto w-full max-w-[100rem] px-3 py-4 sm:px-4 lg:py-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2 lg:mb-6 lg:gap-3">
        <div>
          <h1 className="text-xl font-bold text-white lg:text-2xl">Ralsei</h1>
          <p className="text-xs text-osu-f1">
            Appear on a page as {character.name}. {mobile ? "The stick walks him" : "WASD moves him"}, everything is live for whoever is in the audience.
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
              list="mascot-live-routes"
              className="min-w-[220px] flex-1 rounded-md bg-osu-b3/60 px-3 py-2 text-sm text-white outline-none placeholder:text-osu-f1/60 max-lg:text-base"
            />
            <datalist id="mascot-live-routes">
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
              style={{
                aspectRatio: `${viewport.w} / ${viewport.h}`,
                /* On a phone the stage is sized off the height it may take and
                   only then clamped by the width, so framing somebody's laptop
                   from a phone still leaves room for the controls under it. */
                width: mobile ? `min(100%, ${((MOBILE_STAGE_VH * viewport.w) / viewport.h).toFixed(2)}vh)` : undefined,
              }}
              className={`relative mx-auto cursor-crosshair overflow-hidden rounded-lg bg-osu-b5 ${mobile ? "" : "w-full"}`}
            >
              {preview && canPreview && previewScale > 0 ? (
                /* The real page at exactly the viewer's viewport size, scaled to
                   fit: one screen of it, laid out as they see it. Walking down
                   scrolls this frame rather than stretching it. The hash keeps
                   the framed copy's own overlay asleep. */
                <iframe
                  key={previewRoute}
                  ref={frameRef}
                  src={`${previewRoute}${MASCOT_PREVIEW_HASH}`}
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
                {composing && !mobile ? (
                  /* Where the bubble is about to be, in the same black box the
                     viewers read it in, so talking happens where you are
                     looking instead of at the bottom of the page. Kept at a
                     readable size rather than scaled down with the preview. */
                  <div
                    className="absolute left-0 w-max -translate-x-1/2"
                    style={{ bottom: mascotBubbleLift(character, stageClip, stageSpriteScale) }}
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
                      bottom: mascotBubbleLift(character, stageClip, stageSpriteScale),
                      transform: `translateX(-50%) scale(${bubbleScale})`,
                      transformOrigin: "bottom center",
                    }}
                  >
                    <MascotBubbleBox>{bubble.text}</MascotBubbleBox>
                  </div>
                ) : null}
                <MascotAtlasFrame
                  character={character}
                  clip={stageClip}
                  frame={frame}
                  scale={stageSpriteScale}
                  flip={shouldFlipMascotClip(character, stageClip, look.facing)}
                />
              </div>
              {!connected ? (
                <div className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-osu-f1">
                  connect to put him on the page
                </div>
              ) : null}
            </div>
            {/* The phone's controls sit under the stage rather than over it:
                aiming at somebody on a phone makes the stage narrow, and a thumb
                parked on it covers the part being aimed at. */}
            {mobile && connected ? (
              <div className="mt-3 flex items-center justify-between gap-3">
                <TouchStick stick={stickRef} />
                <div className="flex min-w-0 flex-1 flex-col items-stretch gap-2">
                  {composing ? (
                    /* The line goes out from here rather than from a box over
                       his head: on a phone the stage is narrow enough that a
                       bubble-shaped composer would be cut off by its own edge. */
                    <div className="flex items-center gap-2">
                      <input
                        ref={stageComposerRef}
                        value={message}
                        onChange={(event) => setMessage(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            say();
                            setComposing(false);
                          }
                          if (event.key === "Escape") setComposing(false);
                        }}
                        maxLength={240}
                        placeholder="say something"
                        aria-label={`Say something as ${character.name}`}
                        className="min-w-0 flex-1 rounded-md bg-osu-b3/60 px-3 py-3 text-base text-white outline-none placeholder:text-osu-f1/60"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          say();
                          setComposing(false);
                        }}
                        disabled={!message.trim()}
                        className="cursor-pointer rounded-md bg-osu-pink/25 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
                      >
                        Say
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setComposing(true)}
                      className="flex cursor-pointer items-center justify-center gap-2 rounded-md bg-osu-pink/25 px-4 py-3 text-sm font-semibold text-white"
                    >
                      <MessageCircle className="h-4 w-4" />
                      Talk
                    </button>
                  )}
                  {bubble ? (
                    <button
                      type="button"
                      onClick={clearSpeech}
                      className="flex cursor-pointer items-center justify-center gap-2 rounded-md bg-osu-b3/60 px-4 py-3 text-sm font-semibold text-osu-f1"
                    >
                      <X className="h-4 w-4" />
                      Clear bubble
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-osu-f1 lg:gap-3">
              <span className={mobile ? "w-full" : undefined}>
                {mobile
                  ? "Drag the stick to walk, push it to the rim to run, tap the stage to place him, Talk to say something"
                  : `WASD to walk, shift to run, 1-${MASCOT_CHARACTER_LIST.length} to swap character, click the stage to place him, enter or T to talk, esc to close it`}
              </span>
              <button
                type="button"
                onClick={() => setPreview((value) => !value)}
                className={toggleClass}
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
                className={toggleClass}
              >
                {anchor === "screen" ? <Pin className="h-3 w-3" /> : <PinOff className="h-3 w-3" />}
                {anchor === "screen" ? "stuck to the screen" : "standing in the page"}
              </button>
              <button
                type="button"
                onClick={() => setSound((value) => !value)}
                title="only mutes this panel, not the audience"
                className={toggleClass}
              >
                {sound ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />}
                {sound ? "sound on" : "muted here"}
              </button>
              <span>
                {canPreview
                  ? `${viewport.w}x${viewport.h}`
                  : previewRoute === MASCOT_PANEL_ROUTE
                    ? "this panel, no preview of itself"
                    : "wildcard route, no preview"}
                {targetViewer ? ` (${targetViewer.username}'s screen)` : " (your screen)"}
              </span>
              <label className={`flex items-center gap-2 ${mobile ? "w-full" : "ml-auto"}`}>
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
                  className={`accent-osu-pink ${mobile ? "h-6 flex-1" : "w-28"}`}
                />
                {scale}x
              </label>
            </div>
          </div>

          {mobile ? (
            <div className="mb-3 grid grid-cols-3 gap-1.5">
              <TabButton active={tab === "chat"} onClick={() => setTab("chat")} label="Talk" />
              <TabButton active={tab === "cast"} onClick={() => setTab("cast")} label="Cast" />
              <TabButton active={tab === "who"} onClick={() => setTab("who")} label={`Who (${presence.totals.viewers})`} />
            </div>
          ) : null}

          {/* Who to be, how he stands, what he does: one bar of sprites rather
              than three rows of names. A pixel character is the one thing that
              reads faster as a picture than as the word for it, and the line
              underneath names whatever is under the cursor, so nothing is
              clicked blind. */}
          <div className={`mb-1 flex flex-wrap items-center gap-x-4 gap-y-2 ${hidden("cast")}`}>
            <div className="flex flex-wrap gap-1.5">
              {MASCOT_CHARACTER_LIST.map((entry) => (
                <CharacterChip
                  key={entry.id}
                  character={entry}
                  active={entry.id === character.id}
                  onClick={() => pickCharacter(entry)}
                  onHint={setHint}
                />
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-osu-f1">pose</span>
              {character.poses.map((entry) => (
                <ClipTile
                  key={entry.kind}
                  character={character}
                  // The walk pose has no clip of its own: it is the absence of
                  // one, so it shows him walking.
                  clip={entry.clip ?? walkClipFor(character, "down")}
                  label={entry.label}
                  caption={mobile}
                  active={pose === entry.kind}
                  onClick={() => {
                    // Clicking the pose he is already holding drops it and puts
                    // him back on the walk cycle.
                    setPose(pose === entry.kind ? "auto" : entry.kind);
                    dirtyRef.current = true;
                  }}
                  onHint={setHint}
                />
              ))}
            </div>

            {/* A character with no one-shot moves shows nothing rather than an
                empty group: the dog's whole act is his poses. Kept apart from
                the poses because these fire once, at the audience, and cannot
                be taken back. */}
            {character.actions.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-osu-f1">fires once</span>
                {character.actions.map((action) => (
                  <ClipTile
                    key={action.kind}
                    character={character}
                    clip={action.clip}
                    label={action.label}
                    caption
                    disabled={!connected}
                    onClick={() => act(action.kind)}
                    onHint={setHint}
                  />
                ))}
              </div>
            ) : null}
          </div>
          <div className={`mb-6 h-4 truncate text-[11px] text-osu-f1 ${hidden("cast")}`}>
            {hint ?? `holding: ${findMascotPose(character, pose)?.label ?? "Walk"}`}
          </div>

          <div className={hidden("who")}>
            <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-2">
              <span className="text-sm font-semibold text-white">{presence.totals.named} signed in</span>
              <span className="text-[11px] text-osu-f1">
                {presence.totals.viewers - presence.totals.named} anon, {presence.totals.viewers} tabs across {presence.totals.routes} pages
              </span>
              <input
                value={viewerQuery}
                onChange={(event) => setViewerQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setViewerQuery("");
                }}
                placeholder="find someone"
                className={`rounded-md bg-osu-b3/60 px-2.5 py-1.5 text-xs text-white outline-none placeholder:text-osu-f1/60 ${mobile ? "w-full" : "ml-auto w-48"}`}
              />
            </div>

            {people.size === 0 ? (
              <div className="py-2 text-xs text-osu-f1">
                {trimmedViewerQuery
                  ? `Nobody signed in matches "${trimmedViewerQuery}".${presence.truncated ? " The roster is cut to the newest arrivals, so a quiet tab could still be out there." : ""}`
                  : "Nobody signed in has a page open right now."}
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-1.5">
                {[...people.values()].map((tabs) => (
                  <PersonTile
                    key={tabs[0].userId}
                    tabs={tabs}
                    targeted={audience.mode === "user" && audience.userId === tabs[0].userId}
                    onAim={(viewer) => aim({ mode: "user", userId: viewer.userId! }, viewer.route)}
                  />
                ))}
              </div>
            )}

            {presence.routes.length > 0 && !trimmedViewerQuery ? (
              <div className="mt-5 border-t border-white/[0.07] pt-3">
                <div className="mb-1.5 text-[11px] font-semibold text-osu-f1">Pages</div>
                <div className="flex flex-col">
                  {(showAllRoutes ? presence.routes : presence.routes.slice(0, ROUTE_ROWS)).map((entry) => {
                    const named = presence.viewers.filter((viewer) => viewer.route === entry.route);
                    const shown = named.slice(0, NAMES_PER_ROUTE);
                    return (
                      <div key={entry.route} className="flex items-center gap-3 rounded px-1 py-1.5 hover:bg-osu-b4/60">
                        <button
                          type="button"
                          onClick={() => setRouteInput(entry.route)}
                          title="stage on this page"
                          className="min-w-0 cursor-pointer truncate text-left text-sm font-semibold text-white transition-colors hover:text-osu-pink-light"
                        >
                          {entry.route}
                        </button>
                        <span className="shrink-0 text-[11px] tabular-nums text-osu-f1">
                          {entry.viewers} open
                          {entry.viewers > entry.named ? `, ${entry.viewers - entry.named} anon` : ""}
                          {entry.narrow > 0 ? `, ${entry.narrow} on phones` : ""}
                          {entry.showing > 0 ? `, ${entry.showing} seeing him` : ""}
                        </span>
                        <div className="ml-auto flex shrink-0 items-center -space-x-1.5">
                          {shown.map((viewer) => (
                            <button
                              key={viewer.id}
                              type="button"
                              onClick={() => aim({ mode: "user", userId: viewer.userId! }, viewer.route)}
                              title={viewer.username ?? undefined}
                              className="cursor-pointer rounded-full ring-2 ring-osu-b5 transition-transform hover:z-10 hover:scale-110"
                            >
                              <Avatar userId={viewer.userId} size={22} />
                            </button>
                          ))}
                          {named.length > shown.length ? (
                            <span className="pl-3 text-[11px] text-osu-f1">+{named.length - shown.length}</span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {presence.routes.length > ROUTE_ROWS ? (
                  <button
                    type="button"
                    onClick={() => setShowAllRoutes((value) => !value)}
                    className="mt-1 cursor-pointer px-1 py-1 text-[11px] font-semibold text-osu-f1 transition-colors hover:text-white"
                  >
                    {showAllRoutes ? "show fewer pages" : `show all ${presence.routes.length} pages`}
                  </button>
                ) : null}
              </div>
            ) : null}
            {presence.truncated ? (
              <div className="mt-2 text-[11px] text-osu-f1">Busiest pages and newest arrivals only; the rest are counted, not listed.</div>
            ) : null}
          </div>
        </div>

        <aside className={`flex h-[30rem] min-w-0 flex-col overflow-hidden rounded-lg bg-osu-b4/60 max-lg:h-[24rem] lg:sticky lg:top-4 lg:h-[calc(100vh-6rem)] ${hidden("chat")}`}>
          <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 text-xs">
            <span className="text-osu-f1">Seen by</span>
            {/* Two clicks, and the second one says how many people it is about
                to put him in front of. */}
            <Segment
              active={audience.mode === "everyone"}
              tone={armEveryone ? "warn" : undefined}
              onClick={() => {
                if (audience.mode === "everyone") return;
                if (!armEveryone) {
                  setArmEveryone(true);
                  return;
                }
                aim({ mode: "everyone" });
              }}
              label={armEveryone
                ? (routeHere ? `Show to all ${routeHere.viewers}?` : "Show to everyone?")
                : "Everyone here"}
            />
            <Segment
              active={audience.mode === "user"}
              onClick={() => {
                setArmEveryone(false);
                setPicking((open) => !open);
              }}
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
                      className="flex cursor-pointer items-baseline gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-osu-b3/60 max-lg:py-2"
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
                className="min-w-0 flex-1 rounded-md bg-osu-b3/60 px-3 py-2 text-sm text-white outline-none placeholder:text-osu-f1/60 max-lg:text-base"
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
            <span className="font-semibold text-osu-pink-light">{line.name ?? "Mascot"}</span>
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

/* One person online. Clicking them aims at their newest tab that is not this
   panel; a second tab gets its own line so it can be picked on purpose. The
   avatar ring is pink while he is on their screen. */
function PersonTile({ tabs, targeted, onAim }: {
  tabs: MascotPresenceViewer[];
  targeted: boolean;
  onAim: (viewer: MascotPresenceViewer) => void;
}) {
  const primary = tabs.find((viewer) => viewer.route !== MASCOT_PANEL_ROUTE) ?? tabs[0];
  const others = tabs.filter((viewer) => viewer !== primary);
  const showing = tabs.some((viewer) => viewer.showing);
  const since = Math.min(...tabs.map((viewer) => viewer.connectedAt));
  return (
    <div className={`flex flex-col rounded-md px-2 py-2 transition-colors ${targeted ? "bg-osu-pink/20" : "bg-osu-b4/60 hover:bg-osu-b4"}`}>
      <button
        type="button"
        onClick={() => onAim(primary)}
        title={primary.viewport ? `${primary.viewport.w}x${primary.viewport.h}` : "unknown viewport"}
        className="flex min-w-0 cursor-pointer items-center gap-2.5 text-left"
      >
        <span className={`shrink-0 rounded-full ring-2 ${showing ? "ring-osu-pink" : "ring-transparent"}`}>
          <Avatar userId={primary.userId} size={40} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold text-white">{primary.username}</span>
          <span className="truncate text-[11px] text-osu-f1">{primary.route}</span>
          <span className="text-[11px] tabular-nums text-osu-f1">{hereFor(since)}</span>
        </span>
      </button>
      {others.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1 pl-[50px]">
          {others.map((viewer) => (
            <button
              key={viewer.id}
              type="button"
              onClick={() => onAim(viewer)}
              className={`max-w-full cursor-pointer truncate rounded px-1.5 py-0.5 text-[11px] font-semibold transition-colors ${
                viewer.showing ? "bg-osu-pink/25 text-osu-pink-light" : "bg-osu-b3/60 text-white hover:bg-osu-b3"
              }`}
            >
              {viewer.route}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function hereFor(since: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - since) / 60_000));
  if (minutes < 1) return "just arrived";
  if (minutes < 60) return `${minutes}m here`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m here`;
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

/* Every sprite control is one square of this size. The roster is drawn at wildly
   different sizes (a 19px dog against a 43px Ralsei, and one pose 220px tall),
   so each clip is fitted to the box rather than drawn at its own scale: here the
   picture is the label, not the size. */
export const MASCOT_TILE = 46;

/* Where to park the frame so the clip's own drawing lands centred in the tile.
   The frame draws itself up and left of its anchor (the feet), which is why the
   anchor has to be taken back out of the offset rather than the box just being
   centred. Whole-number scales only, because a pixel sprite at 1.7x is a smeared
   pixel sprite; a clip too big to fit at 1x takes the exact fraction instead. */
export function fitClipToTile(character: MascotCharacter, clip: string): { scale: number; left: number; top: number } {
  const bounds = mascotClipBounds(character, clip);
  const raw = Math.min(MASCOT_TILE / bounds.w, MASCOT_TILE / bounds.h);
  const scale = raw >= 1 ? Math.floor(raw) : raw;
  return {
    scale,
    left: MASCOT_TILE / 2 - (bounds.w * scale) / 2 + (character.anchor.x - bounds.x) * scale,
    top: MASCOT_TILE / 2 - (bounds.h * scale) / 2 + (character.anchor.y - bounds.y) * scale,
  };
}

/* One clip, drawn at rest inside its square. */
function ClipArt({ character, clip }: { character: MascotCharacter; clip: string }) {
  const fit = fitClipToTile(character, clip);
  return (
    <span className="relative block shrink-0 overflow-hidden" style={{ width: MASCOT_TILE, height: MASCOT_TILE }}>
      <span className="absolute block" style={{ left: fit.left, top: fit.top }}>
        <MascotAtlasFrame character={character} clip={clip} frame={0} scale={fit.scale} />
      </span>
    </span>
  );
}

/* One clip as a button: a pose to hold or a move to fire. A pose is its own
   picture, so it needs no word; the moves carry theirs, because a couple of them
   share a clip (vanish is appear backwards) and firing the wrong one at somebody
   cannot be undone. Either way the line under the bar names what is hovered. */
function ClipTile({ character, clip, label, caption, active = false, disabled = false, onClick, onHint }: {
  character: MascotCharacter;
  clip: string;
  label: string;
  caption?: boolean;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  onHint: (label: string | null) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => onHint(label)}
      onMouseLeave={() => onHint(null)}
      onFocus={() => onHint(label)}
      onBlur={() => onHint(null)}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`flex cursor-pointer flex-col items-center gap-0.5 rounded-md px-1 pb-1 pt-0 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? "bg-osu-pink/25" : "bg-osu-b3/60 hover:bg-osu-b3"
      }`}
    >
      <ClipArt character={character} clip={clip} />
      {caption ? <span className="whitespace-nowrap text-[10px] font-semibold text-osu-f1">{label}</span> : null}
    </button>
  );
}

/* Who to be. The same square with the name beside it, because three of them is a
   cast list rather than a palette. */
function CharacterChip({ character, active, onClick, onHint }: {
  character: MascotCharacter;
  active: boolean;
  onClick: () => void;
  onHint: (label: string | null) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => onHint(character.blurb)}
      onMouseLeave={() => onHint(null)}
      onFocus={() => onHint(character.blurb)}
      onBlur={() => onHint(null)}
      title={character.blurb}
      aria-pressed={active}
      className={`flex cursor-pointer items-center gap-1.5 rounded-md pr-2.5 text-left transition-colors ${
        active ? "bg-osu-pink/25" : "bg-osu-b3/60 hover:bg-osu-b3"
      }`}
    >
      <ClipArt character={character} clip={character.idle} />
      <span className={`text-sm font-semibold ${active ? "text-white" : "text-osu-f1"}`}>{character.name}</span>
    </button>
  );
}

function Segment({ active, label, onClick, tone }: {
  active: boolean;
  label: string;
  onClick: () => void;
  /* "warn" is the armed half of a two-click control: it has to look like a
     different button than the one that was just clicked. */
  tone?: "warn";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer rounded-md px-2.5 py-1 font-semibold transition-colors max-lg:px-3 max-lg:py-1.5 ${
        tone === "warn"
          ? "bg-osu-red/25 text-white"
          : active
            ? "bg-osu-pink/25 text-white"
            : "bg-osu-b3/60 text-osu-f1 hover:text-white"
      }`}
    >
      {label}
    </button>
  );
}

function Notice({ text }: { text: string }) {
  return <div className="mb-3 rounded-md bg-osu-red/15 px-3 py-2 text-xs text-osu-red-light">{text}</div>;
}

/* The phone's WASD: a thumb stick drawn over the stage. It writes into the
   movement loop's ref rather than into state, so walking costs the page nothing,
   and it is analog only in direction: the rim is the run key, the middle is a
   thumb resting rather than a direction. */
function TouchStick({ stick }: { stick: RefObject<{ dx: number; dy: number; sprint: boolean }> }) {
  const padRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<number | null>(null);
  /* Only the knob is rendered, and only while a thumb is on it. */
  const [knob, setKnob] = useState<{ x: number; y: number; sprint: boolean } | null>(null);

  const read = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pad = padRef.current;
    if (!pad) return;
    const box = pad.getBoundingClientRect();
    let dx = event.clientX - (box.left + box.width / 2);
    let dy = event.clientY - (box.top + box.height / 2);
    const length = Math.hypot(dx, dy);
    if (length > STICK_RADIUS) {
      dx = (dx / length) * STICK_RADIUS;
      dy = (dy / length) * STICK_RADIUS;
    }
    const reach = Math.min(1, length / STICK_RADIUS);
    const sprint = reach > STICK_SPRINT;
    stick.current = reach > STICK_DEADZONE
      ? { dx: dx / STICK_RADIUS, dy: dy / STICK_RADIUS, sprint }
      : { dx: 0, dy: 0, sprint: false };
    setKnob({ x: dx, y: dy, sprint });
  };

  const release = () => {
    pointerRef.current = null;
    stick.current = { dx: 0, dy: 0, sprint: false };
    setKnob(null);
  };

  return (
    <div
      ref={padRef}
      /* Everything the pad sees is the pad's: a drag that reached the stage
         would place him wherever the thumb happened to lift. */
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        event.stopPropagation();
        event.preventDefault();
        pointerRef.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        read(event);
      }}
      onPointerMove={(event) => {
        if (pointerRef.current !== event.pointerId) return;
        event.stopPropagation();
        read(event);
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
        release();
      }}
      onPointerCancel={release}
      onLostPointerCapture={release}
      style={{ width: STICK_RADIUS * 2 + 24, height: STICK_RADIUS * 2 + 24 }}
      className="relative shrink-0 touch-none select-none rounded-full border border-white/15 bg-osu-b4/70"
    >
      <div
        style={{ transform: `translate(calc(-50% + ${knob?.x ?? 0}px), calc(-50% + ${knob?.y ?? 0}px))` }}
        className={`absolute left-1/2 top-1/2 h-12 w-12 rounded-full border ${
          knob?.sprint ? "border-osu-pink bg-osu-pink/50" : "border-white/30 bg-white/25"
        }`}
      />
    </div>
  );
}

/* One of the three panels under the stage on a phone. */
function TabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`cursor-pointer rounded-md px-2 py-2 text-xs font-semibold transition-colors ${
        active ? "bg-osu-pink/25 text-white" : "bg-osu-b3/60 text-osu-f1"
      }`}
    >
      {label}
    </button>
  );
}

/* Whether the panel is being driven from a phone. Narrow enough that the two
   columns stop fitting is the same line where a keyboard stops being there. */
function useIsMobileLayout(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(MOBILE_QUERY);
    const read = () => setMobile(query.matches);
    read();
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
  }, []);
  return mobile;
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
function useAnimatedFrame(character: MascotCharacter, clip: string, animating: boolean): number {
  const [frame, setFrame] = useState(0);
  const fps = mascotClip(character, clip).fps;
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
