import { useEffect, useRef, useState, type ReactNode } from "react";
import { animate, motion, useInView, useReducedMotion, type Variants } from "framer-motion";

/* The motion on /support: sections rise in as they scroll into view, the
   items in a perk's picture pop in one after another, counts run up to their
   number, and items lift under the pointer. All of it stands still under
   reduced motion. */

const SPRING = { type: "spring" as const, stiffness: 260, damping: 22 };

export function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 36 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -12% 0px" }}
      transition={{ ...SPRING, delay }}
    >
      {children}
    </motion.div>
  );
}

const STAGGER: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.055, delayChildren: 0.1 } },
};

const POP: Variants = {
  hidden: { opacity: 0, y: 18, scale: 0.86 },
  shown: { opacity: 1, y: 0, scale: 1, transition: { type: "spring", stiffness: 420, damping: 20 } },
};

/* A grid or row whose StaggerItems pop in in order once it is on screen. */
export function Stagger({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div className={className} variants={STAGGER} initial="hidden" whileInView="shown" viewport={{ once: true, margin: "0px 0px -10% 0px" }}>
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className, lift = true }: { children: ReactNode; className?: string; lift?: boolean }) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      variants={POP}
      whileHover={lift ? { y: -5, scale: 1.05, transition: { type: "spring", stiffness: 500, damping: 18 } } : undefined}
    >
      {children}
    </motion.div>
  );
}

/* A number that runs up from zero the first time it scrolls into view. */
export function CountUp({ value, className }: { value: number; className?: string }) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -10% 0px" });
  const [shown, setShown] = useState(reduced ? value : 0);
  useEffect(() => {
    if (!inView || reduced) return;
    const controls = animate(0, value, { duration: 1.1, ease: [0.16, 1, 0.3, 1], onUpdate: (n) => setShown(Math.round(n)) });
    return () => controls.stop();
  }, [inView, reduced, value]);
  return <span ref={ref} className={`tabular-nums ${className ?? ""}`}>{shown}</span>;
}

/* Whether the element is on screen or close to it, for pictures that should
   only run (shaders, videos, cycling) while someone can see them. */
export function useNearView<T extends Element>(margin = "200px 0px") {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: margin });
    observer.observe(node);
    return () => observer.disconnect();
  }, [margin]);
  return [ref, near] as const;
}
