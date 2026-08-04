import { createFileRoute, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Eye, EyeOff, Loader2, MessageSquare, Plug, PlugZap, Users } from "lucide-react";
import { GHOST_PREVIEW_HASH } from "../../components/ghost/GhostLayer";
import { GhostAtlasFrame } from "../../components/ghost/GhostSprite";
import { useAuth } from "../../lib/auth-context";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { getGhostControlTicket } from "../../lib/ghost";
import {
  DEFAULT_GHOST_VISUAL,
  EMPTY_GHOST_PRESENCE,
  GHOST_ACTIONS,
  GHOST_CLIPS,
  GHOST_POSES,
  directionalGhostFrame,
  followGhostCamera,
  ghostMoveStep,
  normalizeGhostRoute,
  shouldFlipGhostClip,
  walkClipFor,
  type GhostAudience,
  type GhostClipName,
  type GhostFacing,
  type GhostPoseKind,
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

const SEND_INTERVAL_MS = 70;
const KEEPALIVE_MS = 4_000;
const PRESENCE_POLL_MS = 3_000;
/* The site can have hundreds of pages open at once, so the roster shows the
   busiest pages and a few names each rather than every connection. */
const ROUTE_ROWS = 8;
const NAMES_PER_ROUTE = 6;
const PICKER_LIMIT = 24;
const REPLY_ROWS = 12;
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

function GhostAdminPage() {
  const auth = useAuth();
  const base = getLiveBackendUrl();
  const [ticket, setTicket] = useState<string | null>(null);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [routeInput, setRouteInput] = useState("/");
  const [audience, setAudience] = useState<GhostAudience>({ mode: "none" });
  const [pose, setPose] = useState<GhostPoseKind>("auto");
  const [scale, setScale] = useState(DEFAULT_GHOST_VISUAL.scale);
  const [message, setMessage] = useState("");
  const [presence, setPresence] = useState<GhostPresence>(EMPTY_GHOST_PRESENCE);
  const [preview, setPreview] = useState(true);
  const [picking, setPicking] = useState(false);
  const [showAllRoutes, setShowAllRoutes] = useState(false);
  const [replies, setReplies] = useState<GhostReply[]>([]);
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
  /* How far down the page the stage is looking, in page pixels. */
  const cameraRef = useRef(0);
  /* Page geometry the movement loop needs every frame, kept off React state. */
  const pageMetricsRef = useRef({ viewW: 1536, viewH: 864, pageH: 864 });
  const driveRef = useRef<DriveState>({ x: DEFAULT_GHOST_VISUAL.x, y: DEFAULT_GHOST_VISUAL.y, facing: "down", moving: false });
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
  const settingsRef = useRef({ route: "/", audience, pose, scale, connected, ticket });
  settingsRef.current = { route: normalizeGhostRoute(routeInput) ?? "/", audience, pose, scale, connected, ticket };

  const route = normalizeGhostRoute(routeInput);
  const targetViewer = audience.mode === "user"
    ? presence.viewers.find((viewer) => viewer.userId === audience.userId) ?? null
    : null;
  /* The roster only names signed-in viewers; everyone else is a count. */
  const routeHere = route ? presence.routes.find((entry) => entry.route === route) ?? null : null;
  /* Whoever is on this page decides the stage shape; without anyone, assume a
     stock laptop so the preview is still representative. */
  const viewport = targetViewer?.viewport ?? routeHere?.viewport ?? { w: 1536, h: 864 };
  const previewScale = stageWidth > 0 ? stageWidth / viewport.w : 0;
  const canPreview = Boolean(previewRoute) && !previewRoute!.endsWith("/*");
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
    const targetPx = driveRef.current.y * pageH;
    cameraRef.current = followGhostCamera(cameraRef.current, targetPx, viewH, pageH);
    marker.style.left = `${driveRef.current.x * 100}%`;
    marker.style.top = `${(targetPx - cameraRef.current) * scale}px`;
    frameRef.current?.contentWindow?.scrollTo({ top: cameraRef.current, behavior: "instant" });
  }, []);

  useEffect(placeMarker, [placeMarker, connected, preview, stageWidth, pageHeight, viewport.w, viewport.h]);

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
    const posed = GHOST_POSES.find((entry) => entry.kind === settings.pose)?.clip ?? null;
    return {
      x: state.x,
      y: state.y,
      clip: posed ?? walkClipFor(state.facing),
      facing: state.facing,
      moving: posed ? false : state.moving,
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
          pageHeight: page.pageH,
        });
        const nextX = clamp01(state.x + step.dx);
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

  useEffect(() => {
    const isTyping = (target: EventTarget | null) => target instanceof HTMLElement
      && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    const down = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (isTyping(event.target)) return;
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
  }, []);

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

  /* What viewers say back, pushed as it happens rather than polled: a reply
     three seconds late reads as being ignored. */
  useEffect(() => {
    if (!base || !ticket || typeof EventSource === "undefined") return;
    const source = new EventSource(`${base}/api/ghost/inbox?ticket=${encodeURIComponent(ticket)}`);
    source.addEventListener("reply", (event) => {
      try {
        const reply = JSON.parse((event as MessageEvent).data) as GhostReply;
        setReplies((current) => [reply, ...current.filter((entry) => entry.id !== reply.id)].slice(0, REPLY_ROWS));
      } catch {
        // A malformed frame is not worth dropping the stream for.
      }
    });
    return () => source.close();
  }, [base, ticket]);

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
    setPicking(false);
    void post({ op: "end", route: current });
  };

  const say = () => {
    const text = message.trim();
    if (!text) return;
    eventIdRef.current += 1;
    speechRef.current = { id: eventIdRef.current, text };
    setMessage("");
    dirtyRef.current = true;
    sendNow();
  };

  const clearSpeech = () => {
    speechRef.current = null;
    dirtyRef.current = true;
    sendNow();
  };

  const act = (kind: string) => {
    eventIdRef.current += 1;
    actionRef.current = { id: eventIdRef.current, kind };
    dirtyRef.current = true;
    sendNow();
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
  };

  const placeAt = (event: MouseEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    if (!stage) return;
    const box = stage.getBoundingClientRect();
    const { pageH, viewW } = pageMetricsRef.current;
    const scale = box.width / viewW;
    driveRef.current = {
      ...driveRef.current,
      x: clamp01((event.clientX - box.left) / box.width),
      // Through the camera: a click near the bottom of a scrolled stage is a
      // point further down the page, not the bottom of it.
      y: clamp01(((event.clientY - box.top) / scale + cameraRef.current) / pageH),
    };
    placeMarker();
    dirtyRef.current = true;
    sendNow();
  };

  const poseClip = GHOST_POSES.find((entry) => entry.kind === pose)?.clip ?? null;
  const stageClip: GhostClipName = poseClip ?? walkClipFor(look.facing);
  const sided = directionalGhostFrame(stageClip, look.facing);
  const animated = useAnimatedFrame(stageClip, sided == null && (look.moving || poseClip != null));
  const frame = sided ?? animated;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Ghost</h1>
          <p className="text-xs text-osu-f1">
            Appear on a page as Ralsei. WASD moves him, everything is live for whoever is in the audience.
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

      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-osu-f1">Seen by</span>
        <Segment active={audience.mode === "everyone"} onClick={() => aim({ mode: "everyone" })} label="Everyone here" />
        <Segment
          active={audience.mode === "user"}
          onClick={() => setPicking((open) => !open)}
          label={targetViewer?.username ? `Only ${targetViewer.username}` : "Only one person"}
        />
        <Segment active={audience.mode === "none"} onClick={() => aim({ mode: "none" })} label="Nobody" />
        <span className="ml-1 text-osu-f1/70">
          {audience.mode === "none"
            /* Staging only shows him back to you if the backend can recognise
               you, which means being signed in, not just admin on localhost. */
            ? (auth.viewer ? "staging: only you see him" : "staging: nobody sees him")
            : `${routeHere?.showing ?? 0} of ${routeHere?.viewers ?? 0} on this page`}
        </span>
      </div>

      {picking ? (
        <div className="mb-4 flex flex-wrap items-center gap-1.5 text-xs">
          {presence.viewers.length === 0 ? (
            /* The roster only names people the backend could verify, so an
               empty list means nobody signed in has a page open. */
            <span className="text-osu-f1/70">Nobody signed in has a page open right now, so there is no one to aim at yet.</span>
          ) : (
            presence.viewers.slice(0, PICKER_LIMIT).map((viewer) => (
              <button
                key={viewer.id}
                type="button"
                onClick={() => aim({ mode: "user", userId: viewer.userId! }, viewer.route)}
                className="cursor-pointer rounded-md bg-osu-b3/60 px-2.5 py-1 font-semibold text-white transition-colors hover:bg-osu-b3"
              >
                {viewer.username}
                <span className="ml-1.5 font-normal text-osu-f1">{viewer.route}</span>
              </button>
            ))
          )}
          {presence.viewers.length > PICKER_LIMIT ? (
            <span className="text-osu-f1/70">+{presence.viewers.length - PICKER_LIMIT} more, newest first</span>
          ) : null}
        </div>
      ) : null}

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
               scrolls this frame rather than stretching it. The hash keeps the
               framed copy's own overlay asleep. */
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
            <GhostAtlasFrame
              clip={stageClip}
              frame={frame}
              /* Same on-screen size he has for the viewer, shrunk by whatever
                 the preview is shrunk by. */
              scale={Math.max(0.75, scale * (previewScale || 0.6))}
              flip={shouldFlipGhostClip(stageClip, look.facing)}
            />
          </div>
          {!connected ? (
            <div className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-osu-f1">
              connect to put him on the page
            </div>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-osu-f1">
          <span>WASD to walk, shift to run, click the stage to place him</span>
          <button
            type="button"
            onClick={() => setPreview((value) => !value)}
            className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-osu-f1 transition-colors hover:text-white"
          >
            {preview ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            {preview ? "hide the page" : "show the page"}
          </button>
          <span>
            {canPreview ? `${viewport.w}x${viewport.h}` : "wildcard route, no preview"}
            {targetViewer ? ` (${targetViewer.username}'s screen)` : routeHere?.viewport ? " (their screen)" : ""}
          </span>
          <label className="ml-auto flex items-center gap-2">
            size
            <input
              type="range"
              min={2}
              max={6}
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

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex min-w-[240px] flex-1 items-center gap-2 rounded-md bg-osu-b3/60 px-3">
          <MessageSquare className="h-4 w-4 shrink-0 text-osu-f1" />
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") say();
            }}
            maxLength={240}
            placeholder="say something"
            className="w-full bg-transparent py-2 text-sm text-white outline-none placeholder:text-osu-f1/60"
          />
        </div>
        <button
          type="button"
          onClick={say}
          disabled={!connected || !message.trim()}
          className="cursor-pointer rounded-md bg-osu-pink/25 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-osu-pink/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Say
        </button>
        <button
          type="button"
          onClick={clearSpeech}
          disabled={!connected}
          className="cursor-pointer rounded-md px-3 py-2 text-xs font-semibold text-osu-f1 transition-colors hover:text-white disabled:opacity-50"
        >
          clear bubble
        </button>
      </div>

      <div className="mb-2 flex flex-wrap gap-2">
        {GHOST_ACTIONS.map((action) => (
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

      <div className="mb-6 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-osu-f1">Pose</span>
        {GHOST_POSES.map((entry) => (
          <Segment
            key={entry.kind}
            active={pose === entry.kind}
            label={entry.label}
            onClick={() => {
              setPose(entry.kind);
              dirtyRef.current = true;
            }}
          />
        ))}
      </div>

      <div className="mb-6">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-osu-f1">
          Replies
          <span className="font-normal text-osu-f1/70">
            click him to answer; nothing here is stored, it is gone on restart
          </span>
        </div>
        {replies.length === 0 ? (
          <div className="text-xs text-osu-f1/70">Nobody has said anything back yet.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {replies.map((reply) => (
              <div key={reply.id} className="flex flex-wrap items-baseline gap-2 rounded-md bg-osu-b4/60 px-3 py-2">
                <button
                  type="button"
                  disabled={reply.userId == null}
                  onClick={() => {
                    if (reply.userId != null) aim({ mode: "user", userId: reply.userId }, reply.route);
                  }}
                  className="cursor-pointer text-xs font-semibold text-white transition-colors hover:text-osu-pink-light disabled:cursor-default disabled:text-osu-f1"
                >
                  {reply.username ?? "anon"}
                </button>
                <span className="text-[11px] text-osu-f1">{reply.route}</span>
                <span className="text-sm text-white">{reply.text}</span>
              </div>
            ))}
          </div>
        )}
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
              /* Only the named viewers are listable, and only a few of them per
                 row: a popular page can hold hundreds. */
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
  );
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
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

/* Stage-only animation: the overlay runs its own rAF loop, this just keeps the
   preview from being a frozen frame. */
function useAnimatedFrame(clip: GhostClipName, animating: boolean): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!animating) {
      setFrame(0);
      return;
    }
    const timer = window.setInterval(() => setFrame((value) => value + 1), 1000 / GHOST_CLIPS[clip].fps);
    return () => window.clearInterval(timer);
  }, [animating, clip]);
  return frame;
}
