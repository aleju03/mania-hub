import { useId } from "react";
import { Trans } from "@lingui/react/macro";

const PALETTES = [
  ["#a78bfa", "#22d3ee", "#21113f"],
  ["#fb7185", "#c084fc", "#351329"],
  ["#38bdf8", "#818cf8", "#102840"],
  ["#2dd4bf", "#a3e635", "#11302e"],
  ["#fbbf24", "#fb7185", "#372315"],
];

// Decorative cover art, not a chart preview. Stable per chart and rendered
// inline: missing covers need neither a network request nor the replay engine.
export function ReplayCoverFallback({ seed, keyCount, playerName }: {
  seed: string;
  keyCount: number;
  playerName: string;
}) {
  const id = useId();
  let hash = 0;
  for (const character of seed) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  const [accent, secondary, background] = PALETTES[hash % PALETTES.length];
  const lanes = Math.min(18, Math.max(1, keyCount || 4));
  const laneWidth = 240 / lanes;

  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
      <svg viewBox="0 0 600 338" preserveAspectRatio="xMidYMid slice" className="h-full w-full">
        <defs>
          <linearGradient id={`${id}-base`} x1="0" y1="1" x2="1" y2="0">
            <stop stopColor={background} /><stop offset="1" stopColor={accent} />
          </linearGradient>
          <linearGradient id={`${id}-note`} x1="0" y1="0" x2="1" y2="0">
            <stop stopColor={accent} /><stop offset="1" stopColor={secondary} />
          </linearGradient>
          <linearGradient id={`${id}-hold`} x1="0" y1="0" x2="0" y2="1">
            <stop stopColor={secondary} stopOpacity="0" /><stop offset="1" stopColor={secondary} stopOpacity="0.65" />
          </linearGradient>
          <radialGradient id={`${id}-glow`}>
            <stop stopColor={secondary} stopOpacity="0.5" /><stop offset="1" stopColor={secondary} stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="600" height="338" fill={`url(#${id}-base)`} />
        <ellipse cx="420" cy="180" rx="310" ry="230" fill={`url(#${id}-glow)`} />
        <path d="M-50 310 360 -30M-10 400 465 -30M230 400 620 -10" stroke="white" strokeWidth="1" opacity="0.1" />
        <circle cx="72" cy="280" r="155" fill="none" stroke="white" opacity="0.08" />
        <circle cx="72" cy="280" r="190" fill="none" stroke="white" opacity="0.06" />
        <g transform="translate(338 -62) rotate(18 120 220)">
          <rect x="-12" y="0" width="264" height="480" rx="16" fill={background} fillOpacity="0.65" stroke="white" strokeOpacity="0.2" />
          {Array.from({ length: lanes }, (_, lane) => {
            const x = lane * laneWidth;
            const noteY = 70 + ((hash + lane * 83) % 180);
            return (
              <g key={lane}>
                <rect x={x + 1} width={laneWidth - 2} height="470" fill="white" fillOpacity={lane % 2 ? 0.04 : 0.015} />
                <path d={`M${x} 0V470`} stroke="white" strokeOpacity="0.09" />
                {lane % 3 === hash % 3 && <rect x={x + 5} y={noteY - 95} width={Math.max(3, laneWidth - 10)} height="95" fill={`url(#${id}-hold)`} />}
                <rect x={x + 4} y={noteY} width={Math.max(4, laneWidth - 8)} height="12" rx="3" fill={`url(#${id}-note)`} />
                <rect x={x + 4} y={noteY + 90 + (lane % 2) * 28} width={Math.max(4, laneWidth - 8)} height="12" rx="3" fill={lane % 2 ? secondary : "white"} fillOpacity="0.8" />
                <rect x={x + 4} y="378" width={Math.max(4, laneWidth - 8)} height="26" rx="4" fill="white" fillOpacity="0.1" stroke="white" strokeOpacity="0.22" />
              </g>
            );
          })}
          <path d="M0 368H240" stroke={secondary} strokeWidth="3" />
          <path d="M0 368H240" stroke={secondary} strokeWidth="16" opacity="0.12" />
        </g>
        <path d="M0 0H300L210 338H0Z" fill={background} fillOpacity="0.25" />
      </svg>
      <div className="absolute inset-y-0 left-[6%] flex w-[49%] flex-col justify-center pb-2">
        <span className="mb-2 flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.22em] text-white/70">
          <span className="h-1 w-4 rounded-full" style={{ background: secondary }} /><Trans>Replay</Trans>
        </span>
        <span className="line-clamp-2 break-words text-[clamp(1.1rem,2.2vw,1.6rem)] font-extrabold leading-tight text-white drop-shadow-md">{playerName}</span>
        <span className="mt-1.5 text-[10px] font-semibold tracking-wider text-white/50">osu!mania</span>
      </div>
    </div>
  );
}
