import { motion } from "framer-motion";
import type { ReactNode } from "react";

export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
  title?: string;
};

const SIZE_CLASS = {
  sm: "px-2 py-1 text-[10px]",
  md: "px-2.5 py-1.5 text-[11px]",
  icon: "px-1.5 py-1",
} as const;

/**
 * The site's filter idiom: one track holding mutually exclusive choices, with
 * the active one carrying a pink fill that slides between segments. Used
 * wherever a filter bar needs to say "pick one of these" - underlines are
 * reserved for navigation.
 *
 * `id` scopes the sliding fill, so every control on a page needs its own.
 */
export function SegmentedControl<T extends string>({
  id,
  value,
  options,
  onChange,
  size = "md",
  dimInactive = false,
  className = "",
}: {
  id: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  size?: keyof typeof SIZE_CLASS;
  /** For image content (grades), which reads better dimmed than recoloured. */
  dimInactive?: boolean;
  className?: string;
}) {
  return (
    <div className={`inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-osu-b3/25 bg-osu-b4/50 p-0.5 ${className}`}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            title={option.title}
            aria-pressed={active}
            className={`relative cursor-pointer rounded-md font-semibold transition-colors duration-150 ${SIZE_CLASS[size]} ${active
              ? "text-osu-pink-light"
              : `text-osu-f1 hover:text-osu-l2 ${dimInactive ? "opacity-45 hover:opacity-90" : ""}`
            }`}
          >
            {active && (
              <motion.span
                layoutId={`segmented-${id}`}
                className="absolute inset-0 rounded-md bg-osu-pink/15"
                transition={{ type: "spring", stiffness: 460, damping: 38 }}
              />
            )}
            <span className="relative flex items-center justify-center">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A labelled slot in a filter bar. Inline on desktop, label stacked above on
 * mobile so the controls keep their full width in a bottom sheet.
 */
export function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-1 sm:w-auto sm:flex-row sm:items-center sm:gap-2">
      <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.18em] text-osu-f1">{label}</span>
      {children}
    </div>
  );
}
