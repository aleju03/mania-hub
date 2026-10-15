/* Line icons drawn for the /supporter loadout, in the stroke weight of the
   osu! icons in public/images/icons/. */

type IconProps = { className?: string };

export function DiceIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M12 2.8 20.2 7.4v9.2L12 21.2 3.8 16.6V7.4Z" />
      <path d="M3.8 7.4 12 12l8.2-4.6M12 12v9.2" />
      <g fill="currentColor" stroke="none">
        <ellipse cx="12" cy="7.4" rx="1.5" ry="0.9" />
        <circle cx="6.1" cy="11.3" r="1" />
        <circle cx="9.7" cy="17.3" r="1" />
        <circle cx="18.15" cy="10.85" r="1" />
        <circle cx="16.1" cy="14.3" r="1" />
        <circle cx="14.05" cy="17.75" r="1" />
      </g>
    </svg>
  );
}

export function LockIcon({ locked, className }: IconProps & { locked: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
      <path d={locked ? "M8 10.5V8a4 4 0 0 1 8 0v2.5" : "M8 10.5V8a4 4 0 0 1 7.7-1.6"} />
      <circle cx="12" cy="15.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CheckBadge({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <circle cx="8" cy="8" r="8" className="fill-osu-pink" />
      <path d="m4.6 8.3 2.2 2.2 4.6-4.8" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function UploadIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9" />
      <path d="M4.5 14.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}
