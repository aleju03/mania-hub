/* Hand-rolled minimal typings for the page-flip (StPageFlip) engine, which
   ships untyped. Loose on purpose, same style as the three shim: only the
   surface the album flip-book uses. */
declare module "page-flip" {
  export interface FlipSetting {
    width: number;
    height: number;
    size?: "fixed" | "stretch";
    minWidth?: number;
    maxWidth?: number;
    minHeight?: number;
    maxHeight?: number;
    drawShadow?: boolean;
    flippingTime?: number;
    usePortrait?: boolean;
    startZIndex?: number;
    autoSize?: boolean;
    maxShadowOpacity?: number;
    showCover?: boolean;
    mobileScrollSupport?: boolean;
    swipeDistance?: number;
    clickEventForward?: boolean;
    useMouseEvents?: boolean;
    showPageCorners?: boolean;
    disableFlipByClick?: boolean;
  }

  export type FlipEvent = { data: unknown; object: PageFlip };

  /* The book's size and position in block coordinates. In portrait the rect
     covers the full two-page spread, so `left` is negative (the unseen left
     half hangs off-screen). */
  export interface PageRect {
    left: number;
    top: number;
    width: number;
    height: number;
    pageWidth: number;
  }

  export class PageFlip {
    constructor(element: HTMLElement, settings: FlipSetting);
    loadFromHTML(items: NodeListOf<Element> | Element[]): void;
    updateFromHtml(items: NodeListOf<Element> | Element[]): void;
    flip(page: number, corner?: "top" | "bottom"): void;
    flipNext(corner?: "top" | "bottom"): void;
    flipPrev(corner?: "top" | "bottom"): void;
    turnToPage(page: number): void;
    getPageCount(): number;
    getCurrentPageIndex(): number;
    getOrientation(): "portrait" | "landscape";
    on(event: string, callback: (event: FlipEvent) => void): PageFlip;
    off(event: string): PageFlip;
    destroy(): void;
    /* Internals the FlipBook wrapper reaches into to route around the
       engine's flipNext/flipPrev, whose synthetic click points miss the
       corner test in portrait, and to drive page folds from its own touch
       pipeline (see FlipBook.tsx). */
    getState(): "read" | "user_fold" | "fold_corner" | "flipping";
    getRender(): {
      getRect(): PageRect;
      /* FlipDirection: 0 = forward, 1 = back; null until a flip starts. */
      getDirection(): number | null;
    };
    getFlipController(): {
      flip(globalPos: { x: number; y: number }): void;
      /* Non-null while a flip OR a released fold's settle animation is in
         flight, and null in the dead user_fold state the engine is left in
         when it refuses a fold direction -- so this, not getState(), is the
         honest "is the book busy" test. */
      getCalculation(): object | null;
    };
    getPageCollection(): {
      getCurrentSpreadIndex(): number;
      getSpreadIndexByPage(pageIndex: number): number;
      setCurrentSpreadIndex(index: number): void;
    };
    getUI(): { getDistElement(): HTMLElement };
    /* The drag-fold pipeline (positions are relative to the dist element). */
    startUserTouch(pos: { x: number; y: number }): void;
    userMove(pos: { x: number; y: number }, isTouch: boolean): void;
    userStop(pos: { x: number; y: number }, isSwipe?: boolean): void;
  }
}
