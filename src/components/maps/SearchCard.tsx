import type { LiveMapSearchEntry } from "../../lib/live-backend";
import { formatDuration, formatNumber } from "../../lib/format";
import { OsuLogo } from "../ui/OsuLogo";

// Shared presentation for a single chart-analyzed map across the global Search
// results and inside Collection detail. Country-agnostic: no player avatars,
// just the chart's identity, pattern mix, and download/open actions.

export const PATTERN_LABEL: Record<string, string> = {
  jack: "Jack",
  stream: "Stream",
  jumpstream: "Jumpstream",
  handstream: "Handstream",
  stamina: "Stamina",
  chordjack: "Chordjack",
  tech: "Tech",
  ln: "LN",
};

export const PATTERN_COLOR: Record<string, string> = {
  jack: "#ec6a9c",
  stream: "#5ab2f2",
  jumpstream: "#46c7b8",
  handstream: "#f3c24a",
  stamina: "#ef9a4d",
  chordjack: "#b483f0",
  tech: "#83cf6b",
  ln: "#f07474",
};

export function patternLabel(pattern: string): string {
  return PATTERN_LABEL[pattern] ?? pattern;
}

export function mapCoverUrl(entry: Pick<LiveMapSearchEntry, "covers" | "beatmapsetId">): string {
  return (
    entry.covers?.card ??
    entry.covers?.list ??
    entry.covers?.cover ??
    `https://assets.ppy.sh/beatmaps/${entry.beatmapsetId}/covers/card.jpg`
  );
}

export function osuBeatmapUrl(entry: Pick<LiveMapSearchEntry, "beatmapId" | "beatmapsetId">): string {
  return `https://osu.ppy.sh/beatmapsets/${entry.beatmapsetId}#mania/${entry.beatmapId}`;
}

// osu!direct scheme: opens the set in the osu! client (matches the random tab).
export function osuDirectUrl(beatmapsetId: number): string {
  return `osu://dl/${beatmapsetId}`;
}

// Direct .osz download via a mirror (no server proxy). catboy.best mirrors the
// same hosts the backend's archive layer uses.
export function oszDownloadUrl(beatmapsetId: number): string {
  return `https://catboy.best/d/${beatmapsetId}`;
}

function statusPill(status: string): { label: string; className: string } | null {
  const s = status.toLowerCase();
  if (s === "ranked" || s === "approved") return { label: "ranked", className: "bg-[#6cf27f] text-black" };
  if (s === "loved") return { label: "loved", className: "bg-[#f26fa6] text-black" };
  if (s === "qualified") return { label: "qualified", className: "bg-[#66ccff] text-black" };
  return null;
}

function secondaryPatterns(entry: LiveMapSearchEntry): string[] {
  return Object.entries(entry.patterns)
    .filter(([key, value]) => key !== entry.primaryPattern && value >= 0.5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([key]) => key);
}

export function SearchCard({ entry, onOpen }: { entry: LiveMapSearchEntry; onOpen?: (entry: LiveMapSearchEntry) => void }) {
  const pill = statusPill(entry.status);
  const secondaries = secondaryPatterns(entry);
  const clickable = !!onOpen;

  return (
    <div
      className={`rounded-xl bg-osu-b4 border border-osu-b3/20 hover:border-osu-pink/40 transition-colors flex flex-col ${clickable ? "cursor-pointer" : ""}`}
      onClick={clickable ? () => onOpen(entry) : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(entry); } } : undefined}
      title={clickable ? "View details" : undefined}
    >
      <div className="relative rounded-t-xl overflow-hidden">
        <img src={mapCoverUrl(entry)} alt="" className="w-full h-[90px] object-cover" loading="lazy" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
        <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/60 text-[9px] font-bold text-white">
          {entry.keyCount}K
        </span>
        <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/60 text-[9px] font-bold text-osu-yellow">
          {"★"}{entry.stars.toFixed(2)}
        </span>
        {pill && (
          <span className={`absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-full text-[8px] font-extrabold uppercase leading-none ${pill.className}`}>
            {pill.label}
          </span>
        )}
        <div className="absolute bottom-0 left-0 right-0 px-2.5 pb-1.5 pr-14">
          <div className="text-[12px] font-semibold text-white truncate leading-tight drop-shadow-lg">{entry.title}</div>
          <div className="text-[10px] text-white/70 truncate leading-tight drop-shadow-lg">{entry.artist}</div>
        </div>
      </div>

      <div className="px-2.5 py-2 flex flex-col gap-1.5 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-osu-l2 truncate flex-1">[{entry.version}]</span>
          <span className="text-[9px] text-osu-f1 flex-shrink-0">{formatDuration(entry.length)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <span className="px-1.5 py-0.5 rounded bg-osu-pink/20 text-osu-pink-light text-[9px] font-semibold leading-none">
            {patternLabel(entry.primaryPattern)}
          </span>
          {secondaries.map((pattern) => (
            <span key={pattern} className="px-1.5 py-0.5 rounded bg-osu-b3/50 text-osu-f1 text-[9px] leading-none">
              {patternLabel(pattern)}
            </span>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 mt-auto pt-1">
          <span className="text-[9px] text-osu-f1 truncate" title={`${entry.creator ? `mapped by ${entry.creator} · ` : ""}${formatNumber(entry.playCount)} plays`}>
            {formatNumber(entry.playCount)} plays
          </span>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <a
              href={osuDirectUrl(entry.beatmapsetId)}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-osu-b3/50 text-osu-l2 text-[9px] hover:bg-osu-b3 transition-colors"
              title="Open in osu! client"
            >
              <OsuLogo className="h-2.5 w-2.5" />
              osu!
            </a>
            <a
              href={oszDownloadUrl(entry.beatmapsetId)}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-osu-pink/20 text-osu-pink-light text-[9px] font-semibold hover:bg-osu-pink/30 transition-colors"
              title="Download .osz"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5" aria-hidden="true">
                <path d="M12 3v10" />
                <path d="m7 10 5 4 5-4" />
                <path d="M5 20h14" />
              </svg>
              osz
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
