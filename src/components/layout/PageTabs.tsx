interface PageTabItem<T extends string> {
  id: T;
  label: string;
}

interface PageTabsProps<T extends string> {
  items: PageTabItem<T>[];
  value: T;
  onChange: (value: T) => void;
}

export function PageTabs<T extends string>({ items, value, onChange }: PageTabsProps<T>) {
  return (
    <div className="bg-osu-d5 border-b border-osu-b3/30">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-5 flex overflow-x-auto scrollbar-hide">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => onChange(item.id)}
            className={`relative px-4 py-2.5 text-[12px] font-medium cursor-pointer transition-colors duration-[120ms] ${
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
    </div>
  );
}
