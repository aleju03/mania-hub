import type { CSSProperties, ReactNode } from "react";
import { formatNumber } from "#/lib/format";

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
   which number belongs to which name.

   Tinted off whatever it is sitting on rather than set to a named shade, so it
   stays one step above CollectionsBackdrop instead of colliding with it: b4,
   which this used to be, is close enough to that backdrop's tone to disappear
   into it. */
export function ListSurface({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-osu-b3/20 bg-white/[0.045] p-4 sm:p-5 ${className}`}>
      {children}
    </section>
  );
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return <div className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1">{children}</div>;
}

/* Skeletons are shaped like the thing that replaces them, so nothing on the
   page moves when the data lands. `skeleton-pulse` is the site's own shimmer
   (src/styles.css), the same one the score rows use. */
export function SkeletonBlock({
  className = "",
  style,
}: {
  className?: string;
  /* For a width that has to match a piece of real text rather than a size off
     the scale. */
  style?: CSSProperties;
}) {
  return <div className={`skeleton-pulse rounded ${className}`} style={style} />;
}

/* A bar standing in for a line of text, in a box the height that line will
   actually be rather than the height of the bar. The page is built out of
   small type on the default 1.5 leading, so a 10px heading occupies 15px and a
   10px bar left every section a few pixels short; stacked down a column that
   is what made the whole page step when the numbers arrived. */
function TextSkeleton({ fontPx, width, className }: { fontPx: number; width: string; className: string }) {
  return (
    <div className={`flex items-center ${className}`} style={{ height: Math.round(fontPx * 1.5) }}>
      <SkeletonBlock className={`h-2.5 ${width}`} />
    </div>
  );
}

/** A stand-in for SectionHeading, at the height SectionHeading renders. */
export function HeadingSkeleton({ width = "w-28", className = "" }: { width?: string; className?: string }) {
  return <TextSkeleton fontPx={10} width={width} className={className} />;
}

/** A stand-in for a line of the 11px secondary type the page notes things in. */
export function NoteSkeleton({ width = "w-24", className = "" }: { width?: string; className?: string }) {
  return <TextSkeleton fontPx={11} width={width} className={className} />;
}

/* The number a section heading carries, in a slot wide enough to hold it
   before it arrives. Both places this is used sit next to a search box, and a
   count that widens the heading when it loads - or narrows it with every
   keystroke, since searching changes what it counts - drags that box sideways
   under the cursor. Six characters covers five digits and their comma; a
   longer one only ever grows the slot once. */
export function HeadingCount({ value }: { value: number | null }) {
  return (
    <span translate="no" className="ml-1.5 inline-block min-w-[6ch] text-osu-f1/70 tabular-nums">
      {value === null ? "" : formatNumber(value)}
    </span>
  );
}

/* The two sizes a stat value is drawn at: the community header's, which steps
   up on a wide screen, and the shelf's. Its hint is a separate line the grid
   row has to leave room for. */
const STAT_VALUE_HEIGHT = { page: "h-[30px] sm:h-9", shelf: "h-6" } as const;

export function StatSkeleton({
  variant = "page",
  withHint = false,
}: {
  variant?: keyof typeof STAT_VALUE_HEIGHT;
  withHint?: boolean;
}) {
  return (
    <div>
      <HeadingSkeleton width="w-20" />
      <SkeletonBlock className={`mt-1 w-28 ${STAT_VALUE_HEIGHT[variant]}`} />
      {withHint && <NoteSkeleton width="w-20" className="mt-1" />}
    </div>
  );
}

/* The page has two row shapes: a board row, which carries a rank and a 22px
   avatar, and a directory row, which is taller off its 28px one. One skeleton
   for both left the collector list stepping six pixels a row when the names
   landed. */
export function RowSkeleton({ variant = "board" }: { variant?: "board" | "directory" }) {
  if (variant === "directory") {
    return (
      <div className="flex items-center gap-3 rounded-lg px-2 py-2">
        <SkeletonBlock className="h-7 w-7 rounded-full" />
        <SkeletonBlock className="h-2.5 w-32" />
        <SkeletonBlock className="ml-auto h-3 w-14" />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
      <SkeletonBlock className="h-3 w-3 rounded-full" />
      <SkeletonBlock className="h-[22px] w-[22px] rounded-full" />
      <SkeletonBlock className="h-2.5 w-28" />
      <SkeletonBlock className="ml-auto h-3 w-14" />
    </div>
  );
}

export function BoardSkeleton({ rows }: { rows: number }) {
  return (
    <div>
      <HeadingSkeleton />
      <div className="mt-1.5 -mx-2">
        {Array.from({ length: rows }, (_, index) => (
          <RowSkeleton key={index} />
        ))}
      </div>
    </div>
  );
}

/* The showcase wall's grid, shared with the skeleton below rather than written
   out twice. The two had drifted: the wall is auto-fill columns that share the
   leftover width, the skeleton was a wrapping row of fixed-width tiles, and at
   any given viewport those fit a different number of tiles per row at a
   different size. So the page laid out one grid to wait in and reflowed into
   another when the cards landed, dead space down the right included - the
   layout ShowcaseWall.tsx explains why it does not use. */
export const SHOWCASE_GRID_CLASS =
  "grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(124px,1fr))] sm:gap-3";

/* The wall while it loads: the same grid, holding a page's worth of tiles at
   the card's own 5:7 aspect and corner radius, so what arrives lands in the
   holes the skeleton drew. */
export function ShowcaseWallSkeleton({ cards }: { cards: number }) {
  return (
    <div className={SHOWCASE_GRID_CLASS}>
      {Array.from({ length: cards }, (_, index) => (
        <div key={index} className="skeleton-pulse w-full rounded-[10px]" style={{ aspectRatio: "5 / 7" }} />
      ))}
    </div>
  );
}

/* Your own shelf, which is a wrapping row of fixed-width slots rather than the
   wall's grid: five cards at most, so there is no last column to leave dead
   space, and a shelf of three should not stretch three cards across the page.
   Shared with ShowcaseCards, which draws the real thing. */
export const SHOWCASE_ROW_CLASS = "flex flex-wrap gap-2.5 sm:gap-3";
export const SHOWCASE_SLOT_CLASS = "w-[92px] sm:w-[116px]";

/* The shelf while it loads, at the count the caller last saw on it. */
export function ShowcaseRowSkeleton({ cards }: { cards: number }) {
  return (
    <div className={SHOWCASE_ROW_CLASS}>
      {Array.from({ length: cards }, (_, index) => (
        <div
          key={index}
          className={`skeleton-pulse rounded-[10px] ${SHOWCASE_SLOT_CLASS}`}
          style={{ aspectRatio: "5 / 7" }}
        />
      ))}
    </div>
  );
}
