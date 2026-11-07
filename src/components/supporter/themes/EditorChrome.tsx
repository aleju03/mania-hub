import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

/* The theme editor's frame pieces, in the manner of a design tool: dense,
   quiet panels with hairline seams, icon buttons that name themselves on
   hover (with their shortcut), and sections that fold. */

export function ToolButton({ label, shortcut, onClick, active = false, disabled = false, children, tone = "plain" }: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
  tone?: "plain" | "accent";
}) {
  return (
    <span className="group/tool relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={`grid h-9 min-w-9 cursor-pointer place-items-center rounded-lg px-2 transition-colors disabled:cursor-default disabled:opacity-35 ${
          active ? "bg-osu-pink/20 text-osu-pink-light" : tone === "accent" ? "text-osu-pink-light hover:bg-white/[0.06]" : "text-osu-l2 hover:bg-white/[0.06] hover:text-white"
        }`}
      >
        {children}
      </button>
      <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-black/90 px-2 py-1 text-[11px] text-white shadow-lg group-hover/tool:block">
        {label}
        {shortcut ? <span className="ml-2 font-mono text-[10px] text-white/50">{shortcut}</span> : null}
      </span>
    </span>
  );
}

export function ToolDivider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-white/10" />;
}

export function PanelHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-white/[0.06] pl-4 pr-2">
      <h3 className="flex-1 truncate text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1">{title}</h3>
      {children}
    </div>
  );
}

export function InspectorSection({ title, children, defaultOpen = true, right }: { title: string; children: ReactNode; defaultOpen?: boolean; right?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-white/[0.06]">
      <div className="flex h-11 items-center pr-3">
        <button type="button" onClick={() => setOpen((value) => !value)} className="group/section flex h-full flex-1 cursor-pointer items-center gap-2 pl-3.5 text-left">
          <ChevronRight size={14} className={`text-osu-f1 transition-transform duration-200 group-hover/section:text-white ${open ? "rotate-90" : ""}`} />
          <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-osu-l2 group-hover/section:text-white">{title}</span>
        </button>
        {right}
      </div>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="grid gap-1.5 px-4 pb-4">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

/* A labelled row whose control isn't a number (a colour, a choice). */
export function InspectorRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-9 grid-cols-[100px_minmax(0,1fr)] items-center gap-3">
      <span className="truncate text-[12.5px] text-osu-f1">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/* A short bar for a reading against its limit: the cost, the brightness. */
export function Meter({ value, warn, bad, label }: { value: number | null; warn: number; bad: number; label: string }) {
  const tone = value === null ? "bg-white/20" : value > bad ? "bg-rose-400" : value > warn ? "bg-amber-300" : "bg-emerald-400";
  const fill = value === null ? 0 : Math.min(1, value / bad);
  return (
    // The bar drops on phones so the stats fit across; the number beside it
    // keeps its warning colour.
    <span className="hidden items-center gap-1.5 md:inline-flex" title={label}>
      <span className="relative h-1.5 w-14 overflow-hidden rounded-full bg-white/10">
        <span className={`absolute inset-y-0 left-0 rounded-full ${tone}`} style={{ width: `${fill * 100}%` }} />
      </span>
    </span>
  );
}

export function StatusDot({ tone }: { tone: "good" | "warn" | "bad" | "busy" }) {
  const colour = tone === "good" ? "bg-emerald-400" : tone === "warn" ? "bg-amber-300" : tone === "bad" ? "bg-rose-400" : "animate-pulse bg-osu-f1";
  return <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${colour}`} />;
}
