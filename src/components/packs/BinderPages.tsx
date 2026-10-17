import { Children, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import type { SupporterBinderId } from "#/lib/supporter-pack-style";

/* A supporter's collection as a real binder (lib/supporter-pack-style.ts).
   Open flat: a padded, stitched cover (leather, denim, holo or carbon, with
   its grain lit by an SVG lighting filter in styles.css under .bnd-*), a
   chrome ring mechanism down the spine whose rings arc over into the punched
   holes of two black card-stock pages, and on each page a sheet of nine
   welded clear pockets with one glare across the whole sheet that follows
   the pointer and the scroll. Turning to the next page of the collection
   turns a page: the right-hand leaf swings over the spine onto the left. */

export const BINDER_POCKETS_PER_PAGE = 9;
export const BINDER_PAGE_SIZE = BINDER_POCKETS_PER_PAGE * 2;
const TURN_MS = 760;

function Holes() {
  return (
    <div className="bnd-holes" aria-hidden>
      <span />
      <span />
      <span />
    </div>
  );
}

/* One chrome ring seen from above: it leaves the left page's hole, arcs over
   the spine and drops into the right page's. */
function Ring() {
  return (
    <svg className="bnd-ring" viewBox="0 0 120 40" aria-hidden>
      <defs>
        <linearGradient id="bnd-chrome" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.28" stopColor="#c9ccd3" />
          <stop offset="0.5" stopColor="#6d7079" />
          <stop offset="0.62" stopColor="#3a3c42" />
          <stop offset="0.8" stopColor="#b9bcc4" />
          <stop offset="1" stopColor="#7e8189" />
        </linearGradient>
        <filter id="bnd-ring-shadow" x="-20%" y="-40%" width="140%" height="200%">
          <feGaussianBlur stdDeviation="2.4" />
        </filter>
      </defs>
      <path d="M14 30 C 14 10, 106 10, 106 30" fill="none" stroke="rgba(0,0,0,0.75)" strokeWidth="9" strokeLinecap="round" filter="url(#bnd-ring-shadow)" transform="translate(0 5)" />
      <path d="M14 30 C 14 10, 106 10, 106 30" fill="none" stroke="url(#bnd-chrome)" strokeWidth="8" strokeLinecap="round" />
      <path d="M20 24 C 30 14, 90 14, 100 24" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function Sheet({ items }: { items: ReactNode[] }) {
  return (
    <div className="bnd-sheet">
      {Array.from({ length: BINDER_POCKETS_PER_PAGE }, (_, index) => (
        <div key={index} className={`bnd-pocket ${items[index] ? "" : "bnd-pocket--empty"}`}>
          <div className="bnd-card">{items[index] ?? null}</div>
        </div>
      ))}
      <div className="bnd-sheet-glare" aria-hidden />
    </div>
  );
}

function Page({ items, side }: { items: ReactNode[]; side: "left" | "right" }) {
  return (
    <div className={`bnd-page bnd-page--${side}`}>
      <Holes />
      <Sheet items={items} />
    </div>
  );
}

function splitPages(children: ReactNode): [ReactNode[], ReactNode[]] {
  const items = Children.toArray(children);
  return [items.slice(0, BINDER_POCKETS_PER_PAGE), items.slice(BINDER_POCKETS_PER_PAGE, BINDER_PAGE_SIZE)];
}

/* The glare follows the pointer over the binder, and the scroll when the
   pointer is elsewhere: written to CSS variables, one write per frame. */
function useGlare() {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host || typeof window === "undefined") return;
    let frame = 0;
    let pointer: { x: number; y: number } | null = null;
    const write = () => {
      frame = 0;
      const rect = host.getBoundingClientRect();
      const scroll = 1 - (rect.top + rect.height / 2) / (window.innerHeight + rect.height);
      const x = pointer ? (pointer.x - rect.left) / rect.width : 0.25 + scroll * 0.5;
      const y = pointer ? (pointer.y - rect.top) / rect.height : 0.5;
      host.style.setProperty("--glare-x", `${Math.round(Math.min(1.2, Math.max(-0.2, x)) * 1000) / 10}%`);
      host.style.setProperty("--glare-y", `${Math.round(Math.min(1.2, Math.max(-0.2, y)) * 1000) / 10}%`);
    };
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(write);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      pointer = { x: event.clientX, y: event.clientY };
      queue();
    };
    const onLeave = () => {
      pointer = null;
      queue();
    };
    write();
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    window.addEventListener("scroll", queue, { passive: true });
    window.addEventListener("resize", queue);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("scroll", queue);
      window.removeEventListener("resize", queue);
    };
  }, []);
  return ref;
}

interface Turn {
  id: number;
  direction: "next" | "prev";
  /* The leaf's two faces, and the page left showing under it until it lands. */
  front: ReactNode[];
  back: ReactNode[];
  under: ReactNode[];
}

export function BinderPages({ binder, page = 0, children, className = "" }: {
  binder: SupporterBinderId;
  /* Which page of the collection this is, so a change can be turned rather than swapped. */
  page?: number;
  children: ReactNode;
  className?: string;
}) {
  const ref = useGlare();
  const [left, right] = splitPages(children);
  const previous = useRef<{ page: number; left: ReactNode[]; right: ReactNode[] }>({ page, left, right });
  const [turn, setTurn] = useState<Turn | null>(null);
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { page, left, right };
    if (before.page === page || reduced) return;
    const direction = page > before.page ? "next" : "prev";
    // Next: the old right page lifts and lands on the left, showing the new
    // left on its back; the new right is already underneath. Prev mirrors it.
    setTurn(direction === "next"
      ? { id: Date.now(), direction, front: before.right, back: left, under: before.left }
      : { id: Date.now(), direction, front: before.left, back: right, under: before.right });
    const timer = window.setTimeout(() => setTurn(null), TURN_MS);
    return () => window.clearTimeout(timer);
    // Only a new page number turns a page; new cards on the same page just show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  return (
    <div ref={ref} className={`bnd bnd--${binder} ${className}`}>
      <div className="bnd-spread">
        <div className="bnd-slot bnd-slot--left">
          <Page items={turn?.direction === "next" ? turn.under : left} side="left" />
        </div>
        <div className="bnd-spine" aria-hidden>
          <div className="bnd-plate" />
          <Ring />
          <Ring />
          <Ring />
        </div>
        <div className="bnd-slot bnd-slot--right">
          <Page items={turn?.direction === "prev" ? turn.under : right} side="right" />
        </div>
        {turn && (
          <div key={turn.id} className={`bnd-leaf bnd-leaf--${turn.direction}`} style={{ "--turn-ms": `${TURN_MS}ms` } as CSSProperties}>
            <div className="bnd-leaf-face bnd-leaf-face--front">
              <Page items={turn.front} side={turn.direction === "next" ? "right" : "left"} />
            </div>
            <div className="bnd-leaf-face bnd-leaf-face--back">
              <Page items={turn.back} side={turn.direction === "next" ? "left" : "right"} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
