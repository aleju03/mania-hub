import { useEffect, useRef, type MutableRefObject, type ReactNode } from "react";
import type { PageFlip } from "page-flip";

export interface FlipBookApi {
  flipNext: () => void;
  flipPrev: () => void;
  /* Jump with the turn animation; large jumps still play a single flip. */
  flipTo: (pageIndex: number) => void;
  getCurrentPageIndex: () => number;
  getOrientation: () => "portrait" | "landscape";
}

interface FlipBookProps {
  /* Base page size; the book stretches between the min/max bounds keeping
     this aspect. */
  pageWidth: number;
  pageHeight: number;
  minPageWidth: number;
  maxPageWidth: number;
  onPageChange?: (pageIndex: number) => void;
  onOrientationChange?: (orientation: "portrait" | "landscape") => void;
  /* Fires once the engine has laid the book out, so the owner can swap a
     static stand-in for the live book without a blank frame. */
  onReady?: () => void;
  apiRef?: MutableRefObject<FlipBookApi | null>;
  className?: string;
  /* Every page must be a direct child rendered with data-album-page. The
     page list must stay stable for the life of the mount; key the whole
     FlipBook to rebuild the book when the page set changes. */
  children: ReactNode;
}

/* Thin React wrapper over the StPageFlip engine. The engine re-parents the
   React-rendered page elements into its own DOM; on teardown the pages are
   moved back into the React-owned staging element so a StrictMode remount
   (or HMR) finds them again and React never touches a node it lost. */
export function FlipBook({
  pageWidth,
  pageHeight,
  minPageWidth,
  maxPageWidth,
  onPageChange,
  onOrientationChange,
  onReady,
  apiRef,
  className = "",
  children,
}: FlipBookProps) {
  const stagingRef = useRef<HTMLDivElement | null>(null);
  const bookHostRef = useRef<HTMLDivElement | null>(null);
  const onPageChangeRef = useRef(onPageChange);
  const onOrientationChangeRef = useRef(onOrientationChange);
  const onReadyRef = useRef(onReady);
  onPageChangeRef.current = onPageChange;
  onOrientationChangeRef.current = onOrientationChange;
  onReadyRef.current = onReady;

  useEffect(() => {
    const staging = stagingRef.current;
    const bookHost = bookHostRef.current;
    if (!staging || !bookHost) return;
    const pages = Array.from(staging.querySelectorAll<HTMLElement>("[data-album-page]"));
    if (pages.length === 0) return;

    let cancelled = false;
    let pageFlip: PageFlip | null = null;
    const ratio = pageHeight / pageWidth;

    /* The engine's flipNext/flipPrev aim a synthetic click at a corner and
       run it through the same corner test disableFlipByClick imposes on real
       clicks -- but the points are computed wrong whenever the book rect has
       an offset. flipPrev forgets rect.left entirely, and in portrait
       rect.left is -pageWidth (the spread's unseen left half hangs
       off-screen), so the point lands mid-book and the call silently no-ops:
       back arrow, ArrowLeft and swipe-back were all dead on phones. Both
       also aim y at 1 instead of rect.top + 1, which misses whenever the
       page is letterboxed. Recreate them with corrected coordinates and
       patch the instance so the engine's own paths heal too.

       Flips that land while an animation is still mid-flight are queued (one
       deep) instead of passed through: the engine would snap the running
       animation to its final frame first, which reads as the next page's
       content popping in with no transition. */
    let queuedFlip: (() => void) | null = null;
    const flipNextFixed = (corner?: "top" | "bottom") => {
      if (!pageFlip) return;
      if (pageFlip.getState() === "flipping") {
        queuedFlip = () => flipNextFixed(corner);
        return;
      }
      const rect = pageFlip.getRender().getRect();
      pageFlip.getFlipController().flip({
        x: rect.left + rect.pageWidth * 2 - 10,
        y: corner === "bottom" ? rect.top + rect.height - 2 : rect.top + 1,
      });
    };
    const flipPrevFixed = (corner?: "top" | "bottom") => {
      if (!pageFlip) return;
      if (pageFlip.getState() === "flipping") {
        queuedFlip = () => flipPrevFixed(corner);
        return;
      }
      const rect = pageFlip.getRender().getRect();
      pageFlip.getFlipController().flip({
        x: rect.left + 10,
        y: corner === "bottom" ? rect.top + rect.height - 2 : rect.top + 1,
      });
    };

    /* The engine flips on corner CLICKS even with disableFlipByClick (that
       setting only guards non-corner points), so a card sitting in a page
       corner would flip the page instead of opening. Interactive targets
       are fenced off from the mouse handlers entirely; page chrome stays
       draggable. (Touch never reaches the engine's handlers at all -- the
       pipeline below owns it.) */
    const blockMouseGrab = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("button, a")) {
        event.stopPropagation();
      }
    };
    bookHost.addEventListener("mousedown", blockMouseGrab, true);

    /* The engine's own touch handling can't carry the album: it drops any
       touch that starts on a button or link (album pages are wall-to-wall
       slot buttons, and its guard only checks the direct target, so a touch
       on a card's <img> IS handled while one on the button's padding isn't
       -- double- or un-handled at random), and it only arms the drag-fold
       250ms into a touch, so grabbing a page never felt like the desktop
       mouse drag. Own the touch pipeline instead: capture-phase listeners
       keep every touch away from the engine's handlers and drive its public
       fold API directly.

       The rules: a mostly-horizontal drag grabs the page immediately and the
       fold follows the finger (page scroll stays free until then; vertical
       drags never grab). Releasing lets the engine settle it -- past the
       spine completes, short of it falls back like real paper -- except a
       flick toward the turn, which completes from anywhere. Touches that
       never grab (wrong-direction region, taps, mid-animation) fall back to
       swipe detection on release; plain taps click through to the slots. */
    let touchState: {
      x0: number;
      y0: number;
      t0: number;
      lastX: number;
      lastY: number;
      folding: boolean;
      samples: Array<{ x: number; t: number }>;
    } | null = null;
    let blockRect: DOMRect | null = null;

    const blockPos = (clientX: number, clientY: number) => {
      const rect = blockRect ?? pageFlip?.getUI().getDistElement().getBoundingClientRect();
      return rect ? { x: clientX - rect.left, y: clientY - rect.top } : { x: clientX, y: clientY };
    };

    const abandonTouch = () => {
      if (touchState?.folding && pageFlip) {
        pageFlip.userStop(blockPos(touchState.lastX, touchState.lastY), false);
      }
      touchState = null;
      blockRect = null;
    };

    const onTouchStart = (event: TouchEvent) => {
      if (!pageFlip) return;
      if (touchState || event.touches.length > 1) {
        event.stopPropagation();
        abandonTouch();
        return;
      }
      const touch = event.changedTouches[0];
      if (!touch) return;
      touchState = {
        x0: touch.clientX,
        y0: touch.clientY,
        t0: Date.now(),
        lastX: touch.clientX,
        lastY: touch.clientY,
        folding: false,
        samples: [],
      };
      event.stopPropagation();
    };

    const tryGrabPage = (state: NonNullable<typeof touchState>, deltaX: number) => {
      if (!pageFlip || pageFlip.getState() === "flipping") return;
      const rect = pageFlip.getRender().getRect();
      const distRect = pageFlip.getUI().getDistElement().getBoundingClientRect();
      const bookX = state.x0 - distRect.left - rect.left;
      /* The engine derives the fold direction from where the page is
         grabbed (its getDirectionByPoint): the leading fifth/half of the
         spread folds back, the rest folds forward. Only grab when the drag
         direction agrees, else the fold would fight the finger; disagreeing
         drags still flip via the release swipe. */
      const back =
        pageFlip.getOrientation() === "portrait"
          ? bookX - rect.pageWidth <= rect.width / 5
          : bookX < rect.width / 2;
      if (back !== deltaX > 0) return;
      const index = pageFlip.getCurrentPageIndex();
      if (back ? index < 1 : index >= pageFlip.getPageCount() - 1) return;
      blockRect = distRect;
      state.folding = true;
      pageFlip.startUserTouch(blockPos(state.x0, state.y0));
      /* Seed the fold at the grab point so the direction the engine picks
         matches the region just validated; the finger's live position takes
         over on the next move. */
      pageFlip.userMove(blockPos(state.x0 + (deltaX > 0 ? 6 : -6), state.y0), true);
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!pageFlip || !touchState) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      touchState.lastX = touch.clientX;
      touchState.lastY = touch.clientY;
      touchState.samples.push({ x: touch.clientX, t: Date.now() });
      if (touchState.samples.length > 4) touchState.samples.shift();
      if (!touchState.folding) {
        const deltaX = touch.clientX - touchState.x0;
        const deltaY = touch.clientY - touchState.y0;
        if (Math.abs(deltaX) > 10 && Math.abs(deltaX) > Math.abs(deltaY)) {
          tryGrabPage(touchState, deltaX);
        }
      }
      if (touchState.folding) {
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        pageFlip.userMove(blockPos(touch.clientX, touch.clientY), true);
      }
    };

    const onTouchEnd = (event: TouchEvent) => {
      const state = touchState;
      touchState = null;
      const touch = event.changedTouches[0];
      if (!pageFlip || !state || !touch) {
        blockRect = null;
        return;
      }
      event.stopPropagation();
      const deltaX = touch.clientX - state.x0;
      const deltaY = touch.clientY - state.y0;
      const elapsed = Date.now() - state.t0;
      if (state.folding) {
        const sample = state.samples[0];
        const now = Date.now();
        const velocityX = sample && now > sample.t ? (touch.clientX - sample.x) / (now - sample.t) : 0;
        const direction = pageFlip.getRender().getDirection();
        const flick = direction === 0 ? velocityX < -0.3 : direction === 1 ? velocityX > 0.3 : false;
        if (flick) {
          /* Pull the corner just past the spine before releasing, so the
             engine's settle rule (past the spine completes) finishes the
             turn from wherever the flick let go. */
          const rect = pageFlip.getRender().getRect();
          const pos = {
            x: rect.left + rect.width / 2 + (direction === 0 ? -4 : 4),
            y: blockPos(touch.clientX, touch.clientY).y,
          };
          pageFlip.userMove(pos, true);
          pageFlip.userStop(pos, false);
        } else {
          pageFlip.userStop(blockPos(touch.clientX, touch.clientY), false);
        }
      } else if (
        (elapsed < 250 && Math.abs(deltaX) >= 30 && Math.abs(deltaY) < 60) ||
        (Math.abs(deltaX) >= 60 && Math.abs(deltaX) > 2 * Math.abs(deltaY))
      ) {
        const hostRect = bookHost.getBoundingClientRect();
        const corner = state.y0 - hostRect.top >= hostRect.height / 2 ? "bottom" : "top";
        if (deltaX > 0) flipPrevFixed(corner);
        else flipNextFixed(corner);
      }
      blockRect = null;
    };

    const onTouchCancel = () => {
      abandonTouch();
    };

    bookHost.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    bookHost.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    bookHost.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
    bookHost.addEventListener("touchcancel", onTouchCancel, { capture: true, passive: true });

    void import("page-flip").then(({ PageFlip: PageFlipCtor }) => {
      if (cancelled) return;
      /* Touch devices skip the page shadows: they're gradient layers whose
         clip-path is rebuilt on every animation frame, the biggest repaint
         cost of a flip on phones. */
      const noHover = window.matchMedia("(hover: none)").matches;
      pageFlip = new PageFlipCtor(bookHost, {
        width: pageWidth,
        height: pageHeight,
        size: "stretch",
        minWidth: minPageWidth,
        maxWidth: maxPageWidth,
        minHeight: Math.round(minPageWidth * ratio),
        maxHeight: Math.round(maxPageWidth * ratio),
        showCover: true,
        drawShadow: !noHover,
        maxShadowOpacity: 0.55,
        flippingTime: 700,
        mobileScrollSupport: true,
        /* Dragging a page follows the pointer for a natural turn; a plain
           click still reaches the slot buttons instead of flipping, and
           corners stay flat until actually grabbed. */
        disableFlipByClick: true,
        clickEventForward: true,
        showPageCorners: false,
      });
      pageFlip.loadFromHTML(pages);
      pageFlip.flipNext = flipNextFixed;
      pageFlip.flipPrev = flipPrevFixed;
      pageFlip.on("flip", (event) => {
        if (typeof event.data === "number") onPageChangeRef.current?.(event.data);
      });
      pageFlip.on("changeOrientation", (event) => {
        if (event.data === "portrait" || event.data === "landscape") {
          onOrientationChangeRef.current?.(event.data);
        }
      });
      /* Run the one queued flip when the book settles; deferred a tick so it
         starts outside the engine's own state-change callstack. */
      pageFlip.on("changeState", (event) => {
        if (event.data !== "read" || !queuedFlip) return;
        const flip = queuedFlip;
        queuedFlip = null;
        setTimeout(() => {
          if (!cancelled) flip();
        }, 0);
      });
      if (apiRef) {
        apiRef.current = {
          flipNext: () => flipNextFixed(),
          flipPrev: () => flipPrevFixed(),
          /* Not the engine's flip(page): that routes backward jumps through
             its broken flipPrev. Same spread bookkeeping, fixed flips. */
          flipTo: (pageIndex) => {
            if (!pageFlip) return;
            try {
              const spreads = pageFlip.getPageCollection();
              const current = spreads.getCurrentSpreadIndex();
              const target = spreads.getSpreadIndexByPage(pageIndex);
              if (target > current) {
                spreads.setCurrentSpreadIndex(target - 1);
                flipNextFixed();
              } else if (target < current) {
                spreads.setCurrentSpreadIndex(target + 1);
                flipPrevFixed();
              }
            } catch {
              // Out-of-range page index: nothing to flip to.
            }
          },
          getCurrentPageIndex: () => pageFlip?.getCurrentPageIndex() ?? 0,
          getOrientation: () => pageFlip?.getOrientation() ?? "landscape",
        };
      }
      onOrientationChangeRef.current?.(pageFlip.getOrientation());
      onReadyRef.current?.();
    });

    return () => {
      cancelled = true;
      bookHost.removeEventListener("mousedown", blockMouseGrab, true);
      bookHost.removeEventListener("touchstart", onTouchStart, true);
      bookHost.removeEventListener("touchmove", onTouchMove, true);
      bookHost.removeEventListener("touchend", onTouchEnd, true);
      bookHost.removeEventListener("touchcancel", onTouchCancel, true);
      queuedFlip = null;
      if (apiRef) apiRef.current = null;
      try {
        pageFlip?.destroy();
      } catch {
        // A partially initialized book has nothing to tear down.
      }
      pageFlip = null;
      for (const page of pages) {
        page.removeAttribute("style");
        staging.appendChild(page);
      }
      bookHost.replaceChildren();
    };
    // The book is rebuilt via a key change, never by prop churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={className}>
      <div ref={stagingRef} style={{ display: "none" }}>
        {children}
      </div>
      <div ref={bookHostRef} />
    </div>
  );
}
