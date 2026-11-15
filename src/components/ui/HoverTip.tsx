import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// A hover tooltip portalled above its anchor and clamped to the viewport, so it
// escapes cards and modals with overflow clipping. Mouse only: on touch the
// anchor's own label is the information.
export function HoverTip({ tip, className, children }: { tip: ReactNode; className: string; children: ReactNode }) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!anchor || !tipRef.current) return setLeft(null);
    const width = tipRef.current.offsetWidth;
    setLeft(Math.min(Math.max(anchor.x - width / 2, 8), window.innerWidth - width - 8));
  }, [anchor]);
  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [anchor]);
  if (!tip) return <div className={className}>{children}</div>;
  return (
    <div
      className={className}
      onMouseEnter={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setAnchor({ x: rect.left + rect.width / 2, y: rect.top }); }}
      onMouseLeave={() => setAnchor(null)}
    >
      {children}
      {anchor && createPortal(
        <div
          ref={tipRef}
          role="tooltip"
          className="pointer-events-none fixed z-[200] max-w-72 -translate-y-full rounded-lg bg-osu-b3 px-3 py-2 text-xs leading-relaxed text-osu-l2 shadow-xl shadow-black/40"
          style={{ left: left ?? 0, top: anchor.y - 8, visibility: left == null ? "hidden" : undefined }}
        >
          {tip}
        </div>,
        document.body,
      )}
    </div>
  );
}
