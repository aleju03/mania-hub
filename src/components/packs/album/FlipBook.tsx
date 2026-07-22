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

/* Whether a touch that has moved `deltaX` from a page position of `bookX`
   (the seed point in book coordinates, see tryGrabPage) may take the page as a
   live fold, and which way the engine will fold it. Pure geometry, exported so
   the rules can be tested without an engine. */
export function grabDecision({
  bookX,
  deltaX,
  portrait,
  rectWidth,
  pageWidth,
  index,
  count,
}: {
  bookX: number;
  deltaX: number;
  portrait: boolean;
  rectWidth: number;
  pageWidth: number;
  index: number;
  count: number;
}): { grab: boolean; back: boolean } {
  /* The engine derives the fold direction from where the page is grabbed (its
     getDirectionByPoint): the leading fifth/half of the spread folds back, the
     rest folds forward. Only grab when the drag direction agrees, else the
     fold would fight the finger; disagreeing drags still flip via the release
     swipe. */
  const back = portrait ? bookX - pageWidth <= rectWidth / 5 : bookX < rectWidth / 2;
  if (back !== deltaX > 0) return { grab: false, back };
  if (back ? index < 1 : index >= count - 1) return { grab: false, back };
  /* Hard pages (the covers) don't fold to the finger: the engine rotates the
     whole sheet by the drag's overall progress, so grabbing the closed cover
     mid-page snaps it into a half-open swing for a beat and back on release --
     the album seems to blink away for a frame. Leave rigid flips to taps and
     the release swipe; only soft pages get the live fold. In landscape the
     engine also promotes the page across the sheet from a hard one, so
     cover-adjacent flips stay rigid there. */
  const flippingIndex = portrait
    ? back
      ? index - 1
      : index
    : back
      ? index - 1
      : index === 0
        ? 1
        : index + 2;
  const rigid = portrait
    ? flippingIndex === 0 || flippingIndex === count - 1
    : flippingIndex <= 1 || flippingIndex >= count - 2;
  return { grab: !rigid, back };
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
    /* "Busy" is not the same as state === "flipping". A released drag-fold
       settles through the engine's own animation without ever entering that
       state, so for the whole settle the book looked idle: a flip fired in
       that window skipped the queue and went straight to the engine's flip(),
       which finishes the running animation on its final frame first -- the
       no-transition snap the queue exists to stop -- and a fresh touch could
       grab the page that was still settling, where the settle's frames
       overwrite the finger's geometry until the gesture dies. The flip
       controller's calculation is non-null for both a flip and a settle, and
       null in the dead user_fold the engine is left in when it refuses a fold
       direction, so the arrows can never deadlock waiting for "read". */
    const isBusy = () => {
      if (!pageFlip) return false;
      if (pageFlip.getState() === "flipping") return true;
      return pageFlip.getFlipController().getCalculation() !== null;
    };
    const flipNextFixed = (corner?: "top" | "bottom") => {
      if (!pageFlip) return;
      if (isBusy()) {
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
      if (isBusy()) {
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
      if (!pageFlip || isBusy()) return;
      const rect = pageFlip.getRender().getRect();
      const distRect = pageFlip.getUI().getDistElement().getBoundingClientRect();
      /* Classify the point the ENGINE will classify, not the raw touch-down
         point. The fold is seeded 6px along the drag below and the engine
         derives the fold direction from that seed, so within 6px of the
         back/forward boundary -- which in portrait sits 40% across the visible
         page, not at an edge -- the two disagreed: the bounds and rigid rules
         were checked for one page while the engine folded the other, which at
         page 1 put a live fold on the hard front cover. */
      const seedX = state.x0 + (deltaX > 0 ? 6 : -6);
      const { grab } = grabDecision({
        bookX: seedX - distRect.left - rect.left,
        deltaX,
        portrait: pageFlip.getOrientation() === "portrait",
        rectWidth: rect.width,
        pageWidth: rect.pageWidth,
        index: pageFlip.getCurrentPageIndex(),
        count: pageFlip.getPageCount(),
      });
      if (!grab) return;
      blockRect = distRect;
      state.folding = true;
      /* The engine only starts folding once the move is more than 5px from
         the startUserTouch point, so this anchors at the real touch-down and
         the seed 6px along it takes the fold past that threshold; the finger's
         live position takes over on the next move. */
      pageFlip.startUserTouch(blockPos(state.x0, state.y0));
      pageFlip.userMove(blockPos(seedX, state.y0), true);
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
         cost of a flip on phones. Matched the way the stylesheet matches
         touch, because plenty of Android devices report (hover: hover) and the
         bare query left the shadows switched on there. */
      const noHover = window.matchMedia("(hover: none), (pointer: coarse)").matches;
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
