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
       patch the instance so the engine's own swipe handling takes these
       paths too. */
    const flipNextFixed = (corner?: "top" | "bottom") => {
      if (!pageFlip) return;
      const rect = pageFlip.getRender().getRect();
      pageFlip.getFlipController().flip({
        x: rect.left + rect.pageWidth * 2 - 10,
        y: corner === "bottom" ? rect.top + rect.height - 2 : rect.top + 1,
      });
    };
    const flipPrevFixed = (corner?: "top" | "bottom") => {
      if (!pageFlip) return;
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
       draggable. Touch is unaffected: swipes are detected by distance and
       plain taps never reach the click-flip path. */
    const blockMouseGrab = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("button, a")) {
        event.stopPropagation();
      }
    };
    bookHost.addEventListener("mousedown", blockMouseGrab, true);

    /* The engine ignores touches that START on interactive elements (its
       clickEventForward guard) -- and album pages are wall-to-wall slot
       buttons, so on phones most swipes went dead. Re-detect swipes for
       exactly those touches, with the engine's own thresholds (30px of
       mostly-horizontal travel within 250ms). Taps still click: a real
       swipe travels past the browser's click slop, so no click follows. */
    let interactiveTouch: { x: number; y: number; at: number } | null = null;
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!touch || !(event.target instanceof Element) || !event.target.closest("button, a")) return;
      interactiveTouch = { x: touch.clientX, y: touch.clientY, at: Date.now() };
    };
    const onTouchEnd = (event: TouchEvent) => {
      const start = interactiveTouch;
      interactiveTouch = null;
      const touch = event.changedTouches[0];
      if (!start || !touch || Date.now() - start.at > 250) return;
      const deltaX = touch.clientX - start.x;
      if (Math.abs(deltaX) < 30 || Math.abs(touch.clientY - start.y) >= 60) return;
      const hostRect = bookHost.getBoundingClientRect();
      const corner = start.y - hostRect.top >= hostRect.height / 2 ? "bottom" : "top";
      if (deltaX > 0) flipPrevFixed(corner);
      else flipNextFixed(corner);
    };
    bookHost.addEventListener("touchstart", onTouchStart, { passive: true });
    bookHost.addEventListener("touchend", onTouchEnd, { passive: true });

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
      bookHost.removeEventListener("touchstart", onTouchStart);
      bookHost.removeEventListener("touchend", onTouchEnd);
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
