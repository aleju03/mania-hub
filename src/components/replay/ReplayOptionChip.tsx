import { Check } from "lucide-react";
import type { ReactNode } from "react";

// An overlay option you switch on and off. The chip is the label and the
// switch at once, so a card with many options reads as a set of parts that
// are lit or not instead of a column of checkboxes.
export function ReplayOptionChip({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-semibold leading-none transition-colors ${
        checked
          ? "bg-osu-pink/20 text-white hover:bg-osu-pink/30"
          : "bg-white/[0.05] text-osu-f1 hover:bg-white/[0.09] hover:text-osu-l1"
      }`}
    >
      <Check className={`-ml-0.5 h-3 w-3 ${checked ? "text-osu-pink-light" : "text-osu-f1/40"}`} strokeWidth={3} />
      {children}
    </button>
  );
}

export function ReplayOptionChips({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-1.5">{children}</div>;
}
