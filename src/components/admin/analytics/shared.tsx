import { Check, ChevronDown, Eye, MessagesSquare, Monitor, Package, Palette, Play, Search, Smartphone, Sprout, TriangleAlert, User, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CountryFlag } from "../../ui/CountryFlag";
import { getCountryName } from "../../../lib/country";
import { formatNumber } from "../../../lib/format";
import type { AnalyticsActivityKind, AnalyticsDeviceKind } from "../../../lib/analytics-feed";
import type { AnalyticsCountryRow } from "../../../lib/analytics-monitor";

/* One colour and icon per kind of activity, so a glance down the feed reads as
   "mostly replays" or "a burst of searches" before any word is read. */
export const ACTIVITY_KIND_STYLES: Record<AnalyticsActivityKind, {
  label: string;
  icon: LucideIcon;
  text: string;
  bg: string;
  ring: string;
  bar: string;
}> = {
  visit: { label: "Visits", icon: Eye, text: "text-osu-blue", bg: "bg-osu-blue/12", ring: "ring-osu-blue/30", bar: "bg-osu-blue" },
  search: { label: "Searches", icon: Search, text: "text-osu-yellow", bg: "bg-osu-yellow/12", ring: "ring-osu-yellow/30", bar: "bg-osu-yellow" },
  replay: { label: "Replays", icon: Play, text: "text-osu-pink", bg: "bg-osu-pink/12", ring: "ring-osu-pink/30", bar: "bg-osu-pink" },
  profile: { label: "Profiles", icon: User, text: "text-osu-purple-light", bg: "bg-osu-purple/12", ring: "ring-osu-purple/30", bar: "bg-osu-purple-light" },
  farm: { label: "Farm", icon: Sprout, text: "text-osu-green-light", bg: "bg-osu-green/12", ring: "ring-osu-green/30", bar: "bg-osu-green-light" },
  pack: { label: "Packs", icon: Package, text: "text-osu-orange", bg: "bg-osu-orange/12", ring: "ring-osu-orange/30", bar: "bg-osu-orange" },
  skin: { label: "Skins", icon: Palette, text: "text-osu-c2", bg: "bg-osu-c2/10", ring: "ring-osu-c2/25", bar: "bg-osu-c2" },
  // Discord's own blurple rather than a theme colour, because that is what the
  // rest of the directory is coloured with.
  community: { label: "Servers", icon: MessagesSquare, text: "text-indigo-300", bg: "bg-indigo-400/12", ring: "ring-indigo-400/30", bar: "bg-indigo-400" },
  error: { label: "Errors", icon: TriangleAlert, text: "text-osu-red-light", bg: "bg-osu-red/12", ring: "ring-osu-red/30", bar: "bg-osu-red-light" },
};

/* Per-visitor accents. Slots are assigned in feed order, so the same visitor
   keeps a colour for as long as they stay on screen. */
export const VISITOR_COLORS = [
  { chip: "bg-osu-pink/15 text-osu-pink-light", dot: "bg-osu-pink" },
  { chip: "bg-osu-blue/15 text-osu-blue", dot: "bg-osu-blue" },
  { chip: "bg-osu-green-light/15 text-osu-green-light", dot: "bg-osu-green-light" },
  { chip: "bg-osu-yellow/15 text-osu-yellow", dot: "bg-osu-yellow" },
  { chip: "bg-osu-purple/20 text-osu-purple-light", dot: "bg-osu-purple-light" },
  { chip: "bg-osu-orange/15 text-osu-orange", dot: "bg-osu-orange" },
] as const;

export function visitorColor(slot: number) {
  return VISITOR_COLORS[slot % VISITOR_COLORS.length];
}

/* A clock that only ticks while the tab is visible: the feed ages every row
   against it, and a hidden dashboard has nothing to age. */
export function useTickingNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer != null) return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), intervalMs);
    };
    const stop = () => {
      if (timer == null) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);
  return now;
}

export function DeviceIcon({ deviceKind }: { deviceKind: AnalyticsDeviceKind }) {
  if (deviceKind === "mobile") {
    return (
      <span title="Mobile visitor" aria-label="Mobile visitor" className="inline-flex h-3 w-3 flex-shrink-0 items-center justify-center text-osu-f1/75">
        <Smartphone className="h-3 w-3" aria-hidden="true" />
      </span>
    );
  }
  if (deviceKind === "desktop") {
    return (
      <span title="Desktop visitor" aria-label="Desktop visitor" className="inline-flex h-3 w-3 flex-shrink-0 items-center justify-center text-osu-f1/75">
        <Monitor className="h-3 w-3" aria-hidden="true" />
      </span>
    );
  }
  return <span className="h-3 w-3 flex-shrink-0" aria-hidden="true" />;
}

export function VisitorChip({
  label,
  slot,
  country,
  deviceKind,
  viewerUsername,
}: {
  label: string;
  slot: number;
  country: string | null;
  deviceKind: AnalyticsDeviceKind;
  viewerUsername: string | null;
}) {
  const color = visitorColor(slot);
  return (
    <>
      <span className={`font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0 ${color.chip}`}>{label}</span>
      {country ? (
        <CountryFlag code={country} size="xs" />
      ) : (
        <span className="h-[10px] w-[15px] rounded-[1px] bg-osu-b3/40 flex-shrink-0" aria-hidden="true" />
      )}
      <DeviceIcon deviceKind={deviceKind} />
      {viewerUsername ? (
        <span
          className="min-w-0 truncate text-[10px] font-semibold text-osu-pink-light"
          title={`signed in as ${viewerUsername}`}
        >
          {viewerUsername}
        </span>
      ) : (
        // Most visitors browse signed out; naming them keeps the row from
        // reading as a missing username.
        <span className="min-w-0 truncate text-[10px] font-semibold text-osu-f1/50" title="Not signed in">
          Guest
        </span>
      )}
    </>
  );
}

export function InlineCountryFlag({ country }: { country: string | null }) {
  const code = country?.trim().toUpperCase().slice(0, 2);
  if (!code) return null;
  return <CountryFlag code={code} size="xs" />;
}

export function AnalyticsEmptyMessage({ text }: { text: string }) {
  return <div className="text-[11px] text-osu-f1 text-center py-6">{text}</div>;
}

export function AnalyticsErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-osu-red/30 bg-osu-red/10 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-red-light">Analytics error</div>
      <div className="text-[12px] text-osu-l2 mt-1 break-words">{message}</div>
    </div>
  );
}

export function AnalyticsInfoBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-osu-yellow/25 bg-osu-yellow/10 px-4 py-3 text-[12px] text-osu-l2">
      {message}
    </div>
  );
}

export function AnalyticsCountryFilter({
  country,
  options,
  onChange,
  label = "Filter activity by physical country",
}: {
  country: string | null;
  options: AnalyticsCountryRow[];
  onChange: (country: string | null) => void;
  /* What the filter narrows, for anyone reading the page with a screen reader:
     the same control sits over the event feed and over the signed-in roster. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const select = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };

  const activeName = country ? getCountryName(country) || country : null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        className={`flex h-7 max-w-[180px] items-center gap-1.5 rounded-md border px-2 text-[10px] font-semibold transition-colors duration-[120ms] cursor-pointer ${
          country
            ? "border-osu-pink/40 bg-osu-pink/15 text-white"
            : "border-osu-b3/30 bg-osu-b5/70 text-osu-c2 hover:border-osu-b3/60 hover:text-white"
        }`}
      >
        {country ? <CountryFlag code={country} size="xs" decorative /> : null}
        <span className="truncate">{activeName ?? "All countries"}</span>
        <ChevronDown className={`h-3 w-3 flex-shrink-0 text-osu-f1 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute right-0 top-full z-50 mt-1 max-h-[280px] w-52 overflow-y-auto overscroll-contain rounded-lg border border-osu-b3/50 bg-osu-b5 py-1 shadow-[0_10px_25px_rgba(0,0,0,0.5)]"
        >
          <CountryOption label="All countries" selected={country == null} onSelect={() => select(null)} />
          {options.length > 0 ? <div className="my-1 h-px bg-osu-b3/30" /> : null}
          {options.map((entry) => (
            <CountryOption
              key={entry.country}
              code={entry.country}
              label={getCountryName(entry.country) || entry.country}
              count={entry.count}
              selected={country === entry.country}
              onSelect={() => select(entry.country)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CountryOption({
  code,
  label,
  count,
  selected,
  onSelect,
}: {
  code?: string;
  label: string;
  count?: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onMouseDown={(event) => {
        event.preventDefault();
        onSelect();
      }}
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-[80ms] cursor-pointer ${
        selected ? "bg-osu-pink/15 text-white" : "text-osu-l2 hover:bg-osu-b3/50 hover:text-white"
      }`}
    >
      {code ? <CountryFlag code={code} size="xs" decorative /> : <span className="h-[10px] w-[15px] flex-shrink-0" />}
      <span className="flex-1 truncate text-[11px] font-medium">{label}</span>
      {count != null ? <span className="font-mono text-[10px] text-osu-f1">{formatNumber(count)}</span> : null}
      {selected ? <Check className="h-3 w-3 flex-shrink-0 text-osu-pink" /> : null}
    </button>
  );
}
