import { lazy, Suspense, useEffect, useState } from "react";

import { useAuth } from "../../lib/auth-context";
import { fetchSupporterWelcome, markSupporterWelcomeSeen } from "../../lib/supporter-look-settings";
import { rememberViewerSupporter } from "../../lib/viewer-supporter";

/* The site's one-time thank-you to a supporter, on whatever page they open
   first after time was bought for them. Mounted once in the root layout. It
   asks the backend once per tab session; the backend says whether it is due
   and records when it was seen, so it shows once per payment across devices.
   ?welcome-preview plays it without recording anything. The animation itself
   loads only when it is due. A claimed gift code asks again straight away
   (requestSupporterWelcome), and the friend's version names who gave it. */

const SupporterWelcomeOverlay = lazy(() => import("./SupporterWelcomeOverlay").then((m) => ({ default: m.SupporterWelcomeOverlay })));

const CHECKED_KEY = "mania-hub-supporter-welcome-checked";
const RECHECK_EVENT = "mania-hub:supporter-welcome";
const SETTLE_MS = 900;

/** Ask again now, past the once-per-session check: time was just bought on this tab. */
export function requestSupporterWelcome() {
  window.dispatchEvent(new Event(RECHECK_EVENT));
}

export function SupporterWelcome() {
  const viewer = useAuth().viewer;
  const [show, setShow] = useState<{ expiresAt: number | null; giftFrom: string | null } | null>(null);
  const [recheck, setRecheck] = useState(0);
  useEffect(() => {
    const onRecheck = () => setRecheck((n) => n + 1);
    window.addEventListener(RECHECK_EVENT, onRecheck);
    return () => window.removeEventListener(RECHECK_EVENT, onRecheck);
  }, []);

  const viewerId = viewer?.id;
  useEffect(() => {
    if (!viewerId) return;
    const preview = new URLSearchParams(window.location.search).has("welcome-preview");
    const key = `${CHECKED_KEY}:${viewerId}`;
    if (!preview && !recheck) {
      try {
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, "1");
      } catch {
        // storage blocked: check anyway, the backend still only says yes once
      }
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let open: (() => void) | null = null;
    fetchSupporterWelcome()
      .then((state) => {
        rememberViewerSupporter(viewerId, state.expiresAt);
        if (!alive || (!state.due && !preview)) return;
        // let the page settle first, and wait for the tab to be looked at
        open = () => {
          if (document.visibilityState !== "visible") return;
          if (open) document.removeEventListener("visibilitychange", open);
          timer = setTimeout(() => {
            if (!alive) return;
            setShow({ expiresAt: state.expiresAt, giftFrom: state.giftFrom });
            if (!preview) void markSupporterWelcomeSeen().catch(() => undefined);
          }, SETTLE_MS);
        };
        document.addEventListener("visibilitychange", open);
        open();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      if (open) document.removeEventListener("visibilitychange", open);
    };
  }, [viewerId, recheck]);

  if (!show || !viewer) return null;
  return (
    <Suspense fallback={null}>
      <SupporterWelcomeOverlay username={viewer.username} expiresAt={show.expiresAt} giftFrom={show.giftFrom} onDone={() => setShow(null)} />
    </Suspense>
  );
}
