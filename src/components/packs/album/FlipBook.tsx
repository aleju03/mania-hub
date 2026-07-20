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

    void import("page-flip").then(({ PageFlip: PageFlipCtor }) => {
      if (cancelled) return;
      pageFlip = new PageFlipCtor(bookHost, {
        width: pageWidth,
        height: pageHeight,
        size: "stretch",
        minWidth: minPageWidth,
        maxWidth: maxPageWidth,
        minHeight: Math.round(minPageWidth * ratio),
        maxHeight: Math.round(maxPageWidth * ratio),
        showCover: true,
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
          flipNext: () => pageFlip?.flipNext(),
          flipPrev: () => pageFlip?.flipPrev(),
          flipTo: (pageIndex) => pageFlip?.flip(pageIndex),
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
