import { Children, cloneElement, isValidElement, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { animate, useInView, useReducedMotion } from "framer-motion";
import { isLowEndDevice, isScrolling, onScrollingChange } from "../../lib/gpu-queue";

/* The motion on /support: sections rise in as they scroll into view, the
   items in a perk's picture pop in one after another, counts run up to their
   number, and items lift under the pointer. All of it stands still under
   reduced motion.

   The rises and pops are CSS animations (the sm-* rules in styles.css) that
   only an IntersectionObserver starts: opacity and transform animate on the
   compositor, so a page of them coming in costs the main thread nothing
   while it scrolls, where a JS spring per item ran every frame. */

function useShownOnce<T extends Element>(margin: string) {
  const ref = useRef<T>(null);
  const shown = useInView(ref, { once: true, margin: margin as `${number}px` });
  return [ref, shown] as const;
}

export function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const reduced = useReducedMotion();
  const [ref, shown] = useShownOnce<HTMLDivElement>("0px 0px -12% 0px");
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <div ref={ref} className={`sm-rise ${shown ? "is-in" : ""} ${className ?? ""}`} style={delay ? ({ "--sm-delay": `${delay}s` } as CSSProperties) : undefined}>
      {children}
    </div>
  );
}

/* A grid or row whose StaggerItems pop in in order once it is on screen. */
export function Stagger({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  const [ref, shown] = useShownOnce<HTMLDivElement>("0px 0px -10% 0px");
  if (reduced) return <div className={className}>{children}</div>;
  let index = 0;
  return (
    <div ref={ref} className={`sm-stagger ${shown ? "is-in" : ""} ${className ?? ""}`}>
      {Children.map(children, (child) => (isValidElement<{ index?: number }>(child) ? cloneElement(child, { index: index++ }) : child))}
    </div>
  );
}

export function StaggerItem({ children, className, lift = true, index = 0, onPointerEnter, onPointerLeave }: {
  children: ReactNode;
  className?: string;
  lift?: boolean;
  /* Its place in the Stagger, set by it. */
  index?: number;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  return (
    <div
      className={`sm-pop ${lift ? "sm-lift" : ""} ${className ?? ""}`}
      style={{ "--sm-i": index } as CSSProperties}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {children}
    </div>
  );
}

/* A number that runs up from zero the first time it scrolls into view. */
export function CountUp({ value, className }: { value: number; className?: string }) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -10% 0px" });
  useEffect(() => {
    const node = ref.current;
    if (!inView || reduced || !node) return;
    // straight into the text, not through React state: no render per frame
    const controls = animate(0, value, { duration: 1.1, ease: [0.16, 1, 0.3, 1], onUpdate: (n) => (node.textContent = String(Math.round(n))) });
    return () => controls.stop();
  }, [inView, reduced, value]);
  // (React keeps rendering the 0 it started with, so it never writes over the count)
  return <span ref={ref} className={`tabular-nums ${className ?? ""}`}>{reduced ? value : 0}</span>;
}

/* Whether the element is on screen or close to it, for pictures that should
   only run (shaders, videos, cycling) while someone can see them. */
export function useNearView<T extends Element>(margin = "200px 0px") {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // Going live (videos, shaders) or back to stills is a burst of work, so
    // a change that comes mid-scroll waits for the scroll to pause.
    let wanted = false;
    const observer = new IntersectionObserver(([entry]) => {
      wanted = entry.isIntersecting;
      if (!isScrolling()) setNear(wanted);
    }, { rootMargin: margin });
    observer.observe(node);
    const unwatch = onScrollingChange((scrolling) => {
      if (!scrolling) setNear(wanted);
    });
    return () => {
      observer.disconnect();
      unwatch();
    };
  }, [margin]);
  return [ref, near] as const;
}

/* True on a machine where several live previews at once cost more than they
   show (gpu-queue.ts); false until mounted, so the server render matches. */
export function useLowEndDevice(): boolean {
  const [low, setLow] = useState(false);
  useEffect(() => setLow(isLowEndDevice()), []);
  return low;
}
