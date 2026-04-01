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
      <div className="max-w-[1200px] mx-auto px-5 flex">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => onChange(item.id)}
            className={`px-4 py-2.5 text-[12px] font-medium cursor-pointer transition-colors duration-[120ms] border-b-2 ${
              value === item.id
                ? "text-osu-c1 border-osu-h1"
                : "text-osu-f1 border-transparent hover:text-osu-l2"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
