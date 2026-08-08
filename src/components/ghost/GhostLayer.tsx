import { useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useAuth } from "#/lib/auth-context";
import { getGhostViewerTicket, type GhostViewerTicket } from "#/lib/ghost";
import { DEFAULT_GHOST_VISUAL, ghostSpeechDurationMs, normalizeGhostRoute, type GhostVisual } from "#/lib/ghost-shared";
import { getLiveBackendUrl } from "#/lib/live-backend";
import { useDocumentVisible } from "#/lib/window-activity";

/* Mounted once in the root layout: holds the ghost stream for whatever page the
   visitor is on, and renders the sprite only while the owner is actually here.

   One SSE connection per visible page is the cost of the feature — it is what lets
   the owner appear on a page someone is already sitting on, and it doubles as
   the presence roster the control panel targets people from. It carries its own
   connection budget on the backend. Hidden tabs disconnect so local HTTP/1.1
   cannot run out of browser connection slots; they rejoin when visible again.
   The whole thing goes away with ENABLE_GHOST=false (the stream 404s, this layer
   gives up after a few tries and stays quiet). */

const GhostSprite = lazy(() => import("./GhostSprite").then((module) => ({ default: module.GhostSprite })));

const RECONNECT_DELAYS_MS = [2_000, 6_000, 20_000];
const ROUTE_SETTLE_MS = 250;
/* The control panel frames the real page as its stage. That copy must not join
   the roster or draw a second Ralsei on top of the panel's own marker, so it
   asks for a dead overlay through the URL hash (a hash, not a query param, so
   no route's search validation ever sees it). */
export const GHOST_PREVIEW_HASH = "#ghost-preview";

/* One fetch per full page load, reused across client-side navigations. */
let viewerTicketPromise: Promise<GhostViewerTicket | null> | null = null;

function loadViewerTicket(): Promise<GhostViewerTicket | null> {
  viewerTicketPromise ??= getGhostViewerTicket().catch(() => null);
  return viewerTicketPromise;
}

export function GhostLayer() {
  /* The id alone, not the viewer object: a fresh root context every minute
     hands back an equal-but-new object, which would reconnect the stream. */
  const viewerId = useAuth().viewer?.id ?? null;
  const documentVisible = useDocumentVisible();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const currentRoute = normalizeGhostRoute(pathname);
  const [route, setRoute] = useState<string | null>(currentRoute);

  /* Movement lands here every tick; only the discrete bits below re-render. */
  const visualRef = useRef<GhostVisual>({ ...DEFAULT_GHOST_VISUAL });
  const [present, setPresent] = useState(false);
  const [speech, setSpeech] = useState<GhostVisual["speech"]>(null);
  const [action, setAction] = useState<GhostVisual["action"]>(null);
  const [scale, setScale] = useState(DEFAULT_GHOST_VISUAL.scale);
  const [character, setCharacter] = useState(DEFAULT_GHOST_VISUAL.character);
  /* The connection id doubles as the capability to answer him: it is only ever
     sent down this stream, and the backend only accepts it while this same
     connection is being shown a ghost. */
  const [connectionId, setConnectionId] = useState<string | null>(null);
  /* What this visitor has already been shown. A line and an action stay on the
     session until the owner replaces them, which is what lets someone arriving
     late still see them - but the stream also closes with a hidden tab, and the
     state frame that reseeds it on return would otherwise type out a bubble
     they had already read and watched disappear. Keyed by content as well as
     id, because a reloaded control panel starts numbering from one again. */
  const shownSpeechRef = useRef<{ key: string; at: number } | null>(null);
  const shownActionRef = useRef<string | null>(null);

  /* A navigation mid-flight would otherwise reconnect once per intermediate
     route; settle first, then move the stream. */
  useEffect(() => {
    const next = normalizeGhostRoute(pathname);
    const timer = window.setTimeout(() => setRoute(next), ROUTE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  useEffect(() => {
    const base = getLiveBackendUrl();
    if (!base || !route || route !== currentRoute || !documentVisible || typeof EventSource === "undefined") return;
    if (window.location.hash === GHOST_PREVIEW_HASH) return;

    let source: EventSource | null = null;
    let retry = 0;
    let retryTimer = 0;
    let cancelled = false;

    const clear = () => {
      setPresent(false);
      setSpeech(null);
      setAction(null);
      setConnectionId(null);
    };

    const connect = async () => {
      const ticket = viewerId ? await loadViewerTicket() : null;
      if (cancelled) return;
      const query = new URLSearchParams({ route });
      if (ticket && ticket.userId === viewerId) {
        query.set("uid", String(ticket.userId));
        query.set("name", ticket.username);
        query.set("exp", String(ticket.expiresAt));
        query.set("sig", ticket.signature);
      }
      query.set("vw", String(window.innerWidth));
      query.set("vh", String(window.innerHeight));

      /* Deliberately bland on the wire: what a curious visitor sees in devtools
         says "updates", giving away neither surveillance vibes nor that a
         character overlay exists before it is actually shown. */
      source = new EventSource(`${base}/api/updates/stream?${query.toString()}`);
      source.addEventListener("hello", (event) => {
        retry = 0;
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { id?: string };
          setConnectionId(payload.id ?? null);
        } catch {
          setConnectionId(null);
        }
      });
      source.addEventListener("update", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { present: boolean; visual?: GhostVisual };
          if (!payload.present || !payload.visual) {
            clear();
            return;
          }
          const visual = payload.visual;
          visualRef.current = visual;
          /* Every setState here bails out when nothing changed, so steady
             movement re-renders nothing: the sprite reads the ref instead.
             Content is compared alongside the id because a reloaded control
             panel starts numbering again from one. */
          setPresent(true);
          setScale(visual.scale);
          setCharacter(visual.character ?? DEFAULT_GHOST_VISUAL.character);

          /* A line this visitor already sat through is not replayed. One they
             were part way through when the tab went away still finishes: the
             bubble is on its own clock, so the only thing being suppressed is
             a rerun of one that had already timed out. */
          const line = visual.speech;
          let saying = line;
          if (line) {
            const key = `${line.id}:${line.text}`;
            const shown = shownSpeechRef.current;
            if (shown?.key !== key) shownSpeechRef.current = { key, at: Date.now() };
            else if (Date.now() - shown.at >= ghostSpeechDurationMs(line.text)) saying = null;
          }
          setSpeech((current) => (current?.id === saying?.id && current?.text === saying?.text ? current : saying));

          /* Actions are one-shots, so a second delivery of the same one is only
             ever the session being replayed, never the owner firing again: the
             panel gives every press its own id. */
          const fired = visual.action;
          const firedKey = fired ? `${fired.id}:${fired.kind}` : null;
          const playing = firedKey && shownActionRef.current === firedKey ? null : fired;
          shownActionRef.current = firedKey;
          setAction((current) => (current?.id === playing?.id && current?.kind === playing?.kind ? current : playing));
        } catch {
          // A malformed frame is not worth tearing the connection down for.
        }
      });
      source.addEventListener("error", () => {
        /* EventSource retries a dropped connection on its own; only a closed
           one (404, 503, disabled feature) needs handling, and then only a few
           times before leaving the visitor alone. */
        if (source?.readyState !== EventSource.CLOSED || cancelled) return;
        source.close();
        source = null;
        clear();
        const delay = RECONNECT_DELAYS_MS[retry];
        if (delay == null) return;
        retry += 1;
        retryTimer = window.setTimeout(() => void connect(), delay);
      });
    };

    void connect();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      source?.close();
      clear();
    };
  }, [currentRoute, documentVisible, route, viewerId]);

  /* The next stream is intentionally debounced, but the previous route's
     sprite must disappear in the same render that observes navigation. */
  if (!present || route !== currentRoute) return null;
  return (
    <Suspense fallback={null}>
      <GhostSprite
        visualRef={visualRef}
        character={character}
        speech={speech}
        action={action}
        scale={scale}
        onSay={connectionId ? (text) => sendGhostReply(connectionId, text) : null}
      />
    </Suspense>
  );
}

/* Fire and forget: a refused reply (rate limited, or he just left) is not worth
   interrupting the visitor over. */
function sendGhostReply(connectionId: string, text: string): void {
  const base = getLiveBackendUrl();
  if (!base) return;
  void fetch(`${base}/api/updates/say`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: connectionId, text }),
  }).catch(() => undefined);
}
