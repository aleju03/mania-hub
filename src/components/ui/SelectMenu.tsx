import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, type LucideIcon } from "lucide-react";

// A small custom dropdown to replace the native <select>, so category-style pickers match the site
// instead of rendering the OS chrome. Options can carry an icon + accent color; the popover mirrors
// the CountrySelector motion/close-on-outside pattern.

export interface SelectMenuOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  colorClass?: string;
}

interface SelectMenuProps<T extends string> {
  value: T;
  options: SelectMenuOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
  align?: "left" | "right";
}

export function SelectMenu<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className = "",
  align = "left",
}: SelectMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const SelectedIcon = selected?.icon;

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md border border-osu-b3/50 bg-osu-b4 px-2.5 py-1.5 text-xs font-semibold text-osu-l2 transition-colors hover:border-osu-b3 hover:bg-osu-b4/80 cursor-pointer"
      >
        {SelectedIcon && <SelectedIcon className={`h-3.5 w-3.5 ${selected?.colorClass ?? "text-osu-f1"}`} />}
        <span className={selected?.colorClass ?? ""}>{selected?.label}</span>
        <ChevronDown className={`h-3.5 w-3.5 text-osu-f1 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            role="listbox"
            className={`absolute top-full z-[70] mt-1 min-w-[9.5rem] overflow-hidden rounded-lg border border-osu-b3/50 bg-osu-b5 p-1 shadow-[0_12px_28px_rgba(0,0,0,0.55)] ${
              align === "right" ? "right-0" : "left-0"
            }`}
          >
            {options.map((option) => {
              const OptionIcon = option.icon;
              const active = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium transition-colors cursor-pointer ${
                    active ? "bg-osu-b3/50 text-white" : "text-osu-l2 hover:bg-osu-b3/40 hover:text-white"
                  }`}
                >
                  {OptionIcon && <OptionIcon className={`h-3.5 w-3.5 ${option.colorClass ?? "text-osu-f1"}`} />}
                  <span className="flex-1">{option.label}</span>
                  {active && <Check className="h-3.5 w-3.5 text-osu-pink" />}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
