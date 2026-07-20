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
  }
}
