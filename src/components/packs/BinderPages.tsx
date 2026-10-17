import { Children, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import type { SupporterBinderId } from "#/lib/supporter-pack-style";

/* A supporter's collection as a real binder (lib/supporter-pack-style.ts).
   Open flat: a padded, stitched cover (leather, denim, holo or carbon, with
   its grain lit by an SVG lighting filter in styles.css under .bnd-*), a
   chrome ring mechanism down the spine whose rings arc over into the punched
   holes of two black card-stock pages, and on each page a sheet of nine
   welded clear pockets under one faint sheen. The zip binder is the ringless
   kind: a zipper round a padded weave cover, its sheets stitched into a soft
   spine, side-loading pockets. Nothing repaints on scroll or
   hover; the only motion is a page turn, a transform on its own layer. Turning to the next page of the collection
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

/* The ring mechanism: a chrome plate and three rings, rendered in 3D once
   (local-notes/binders/) to images whose origin is the spine's centre. The
   plate stretches between its end caps; each ring image carries the stretch
   of plate under it, with the ring's shadow on it and on the pages, and its
   ends land on the hole centres. */
function Mechanism({ turning }: { turning: boolean }) {
  return (
    <div className="bnd-spine" aria-hidden>
      <div className="bnd-plate" />
      {/* Its own layer: a turning leaf rides up the rings and over the plate,
          so for the middle of a turn the leaf is drawn above them. */}
      <div className={`bnd-rings ${turning ? "bnd-rings--turning" : ""}`} style={{ "--turn-ms": `${TURN_MS}ms` } as CSSProperties}>
        <img className="bnd-ring" src="/images/binders/ring.png" alt="" draggable={false} />
        <img className="bnd-ring" src="/images/binders/ring.png" alt="" draggable={false} />
        <img className="bnd-ring" src="/images/binders/ring.png" alt="" draggable={false} />
      </div>
    </div>
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

interface Turn {
  id: number;
  direction: "next" | "prev";
  /* The leaf's two faces, and the page left showing under it until it lands. */
  front: ReactNode[];
  back: ReactNode[];
  under: ReactNode[];
}

interface Spread {
  page: number;
  left: ReactNode[];
  right: ReactNode[];
}

/* How long a turn waits on the next page's card faces before turning anyway. */
const FACES_WAIT_MS = 900;

export function BinderPages({ binder, page = 0, ready = true, settled = true, children, className = "" }: {
  binder: SupporterBinderId;
  /* Which page of the collection this is, so a change can be turned rather than swapped. */
  page?: number;
  /* Whether the children are the page's cards rather than placeholders: a
     new page is only turned to once they are, and the spread on screen holds
     until then, so a turn never shows a sheet of loading cards. */
  ready?: boolean;
  /* Whether the cards' faces have loaded too; worth a short wait, not a long one. */
  settled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [left, right] = splitPages(children);
  const shown = useRef<Spread>({ page, left, right });
  const [turn, setTurn] = useState<Turn | null>(null);
  const [, rerender] = useState(0);
  const [facesExpired, setFacesExpired] = useState(false);
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const pending = page !== shown.current.page;

  useEffect(() => {
    setFacesExpired(false);
    if (!pending) return;
    const timer = window.setTimeout(() => setFacesExpired(true), FACES_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [page, pending]);

  useLayoutEffect(() => {
    if (!pending) {
      // The same page: new cards or faces just show.
      if (ready) shown.current = { page, left, right };
      return;
    }
    if (!ready || !(settled || facesExpired)) return;
    const before = shown.current;
    shown.current = { page, left, right };
    if (reduced) {
      rerender((n) => n + 1);
      return;
    }
    // Next: the old right page lifts and lands on the left, showing the new
    // left on its back; the new right is already underneath. Prev mirrors it.
    const direction = page > before.page ? "next" : "prev";
    setTurn(direction === "next"
      ? { id: Date.now(), direction, front: before.right, back: left, under: before.left }
      : { id: Date.now(), direction, front: before.left, back: right, under: before.right });
  });

  useEffect(() => {
    if (!turn) return;
    const timer = window.setTimeout(() => setTurn(null), TURN_MS);
    return () => window.clearTimeout(timer);
  }, [turn]);

  /* A zip binder's sheets are bound into its spine, with no rings or holes,
     and a zipper runs round its cover. */
  const ringed = binder !== "zip";
  // While the next page loads, the spread on screen stays put.
  const spread = pending ? shown.current : { page, left, right };

  return (
    <div className={`bnd bnd--${binder} ${className}`}>
      {!ringed && <span className="bnd-zip-pull" aria-hidden />}
      <div className="bnd-spread">
        <div className="bnd-slot bnd-slot--left">
          <Page items={turn?.direction === "next" ? turn.under : spread.left} side="left" />
        </div>
        {ringed ? (
          // Remounted per turn so its layering animation starts with the leaf's.
          <Mechanism key={`mechanism-${turn?.id ?? 0}`} turning={turn !== null} />
        ) : (
          // A zip binder has no rings: its pages are stitched into a soft spine.
          <div className="bnd-spine bnd-spine--soft" aria-hidden />
        )}
        <div className="bnd-slot bnd-slot--right">
          <Page items={turn?.direction === "prev" ? turn.under : spread.right} side="right" />
        </div>
        {turn && (
          <div key={`leaf-${turn.id}`} className={`bnd-leaf bnd-leaf--${turn.direction}`} style={{ "--turn-ms": `${TURN_MS}ms` } as CSSProperties}>
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
