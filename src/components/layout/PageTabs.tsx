import type { ReactNode } from "react";

interface PageTabItem<T extends string> {
  id: T;
  label: ReactNode;
}

interface PageTabsProps<T extends string> {
  items: PageTabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /**
   * Page-level status text pinned to the end of the tab row. Desktop only:
   * on mobile it would cover the last tab, so pages hand the same node to
   * PageHeader's `rightInline` slot instead.
   */
  right?: ReactNode;
  /** Tighter padding, tabs stretched to fill the row, for narrow containers like the settings drawer. */
  dense?: boolean;
}

export function PageTabs<T extends string>({ items, value, onChange, right, dense = false }: PageTabsProps<T>) {
  return (
    <div className="bg-osu-d5 border-b border-osu-b3/30">
      <div className={`max-w-[1200px] mx-auto flex items-center gap-3 ${dense ? "px-2" : "px-4 sm:px-5"}`}>
        <div className={`flex min-w-0 overflow-x-auto scrollbar-hide ${dense ? "flex-1" : ""}`}>
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => {
              if (value !== item.id) onChange(item.id);
            }}
            className={`relative shrink-0 whitespace-nowrap ${dense ? "grow px-2.5" : "px-3 sm:px-4"} py-2.5 text-[12px] font-medium cursor-pointer transition-colors duration-[120ms] ${
              value === item.id
                ? "text-osu-c1"
                : "text-osu-f1 hover:text-osu-l2"
            }`}
          >
            {item.label}
            {value === item.id && (
              <span
                aria-hidden="true"
                className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-osu-h1"
              />
            )}
          </button>
        ))}
        </div>
        {right ? <div className="ml-auto shrink-0 hidden sm:block">{right}</div> : null}
      </div>
    </div>
  );
}
