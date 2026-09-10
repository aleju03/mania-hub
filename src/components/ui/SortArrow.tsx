import { ArrowDown, ArrowUp } from "lucide-react";

/** Sort direction marker for filter buttons; heavier than a text arrow glyph. */
export function SortArrow({ direction, className = "" }: { direction: "asc" | "desc"; className?: string }) {
  const Icon = direction === "desc" ? ArrowDown : ArrowUp;
  return <Icon aria-hidden className={`h-3 w-3 shrink-0 ${className}`} strokeWidth={3} />;
}
