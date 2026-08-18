import type { ReactNode } from "react";

/* The page's shared surfaces.
 *
 * Deliberately not boxes. An earlier pass wrapped every section in a card and
 * the page turned into a stack of containers with the actual numbers small
 * inside them. What separates a section here is a heading and some air; what
 * separates a row is the fill it takes on hover. The only borders on the page
 * are the hairlines between showcase entries, where one person's cards end and
 * the next person's begin. */

export function Section({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={className}>{children}</section>;
}

/* The one surface on the page that keeps a background. A section of prose or a
   two-column board reads fine on the page itself, but the collector list is a
   single full-width run of rows where the name is at one edge and the number
   at the other, and without something holding the row together the eye loses
   which number belongs to which name. */
export function ListSurface({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-osu-b3/20 bg-osu-b4 p-4 sm:p-5 ${className}`}>{children}</section>
  );
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return <div className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1">{children}</div>;
}

/* Skeletons are shaped like the thing that replaces them, so nothing on the
   page moves when the data lands. `skeleton-pulse` is the site's own shimmer
   (src/styles.css), the same one the score rows use. */
export function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div className={`skeleton-pulse rounded ${className}`} />;
}

export function StatSkeleton() {
  return (
    <div>
      <SkeletonBlock className="h-2.5 w-20" />
      <SkeletonBlock className="mt-2 h-8 w-28" />
    </div>
  );
}

export function RowSkeleton() {
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
      <SkeletonBlock className="h-3 w-3 rounded-full" />
      <SkeletonBlock className="h-[22px] w-[22px] rounded-full" />
      <SkeletonBlock className="h-2.5 w-28" />
      <SkeletonBlock className="ml-auto h-3 w-14" />
    </div>
  );
}

export function BoardSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div>
      <SkeletonBlock className="h-2.5 w-28" />
      <div className="mt-2 -mx-2">
        {Array.from({ length: rows }, (_, index) => (
          <RowSkeleton key={index} />
        ))}
      </div>
    </div>
  );
}

/* A showcase row while it loads: card-shaped, at the size the real cards
   render, so the section does not resize under the reader. */
export function ShowcaseRowSkeleton({ cards = 5, withHeader = false }: { cards?: number; withHeader?: boolean }) {
  return (
    <div>
      {withHeader && (
        <div className="mb-3 flex items-center gap-2.5">
          <SkeletonBlock className="h-[26px] w-[26px] rounded-full" />
          <SkeletonBlock className="h-3 w-24" />
          <SkeletonBlock className="ml-auto h-2.5 w-16" />
        </div>
      )}
      <div className="flex flex-wrap gap-2.5 sm:gap-3">
        {/* 5:7 is the card's own aspect, the same one the tiles use, so the
            row does not resize when the real cards arrive. */}
        {Array.from({ length: cards }, (_, index) => (
          <div
            key={index}
            className="skeleton-pulse w-[92px] rounded-[10px] sm:w-[116px]"
            style={{ aspectRatio: "5 / 7" }}
          />
        ))}
      </div>
    </div>
  );
}
