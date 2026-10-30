import { useId, type ReactNode } from "react";

// Two inked hit circles, 1 and 2, the front one masking the back one's edge
// so it sits on any background.
// Drawn twice and roughened like the /bbcode margin doodles.
const FRONT = "M 18.6 12.9 C 18.5 8.6 15 5.5 11.1 5.7 C 7.3 5.9 4.6 9.2 4.8 13.1 C 5 17.1 8.2 20 12 19.8 C 15.8 19.6 18.7 16.8 18.6 12.9 Z";

function Sketch({ children }: { children: ReactNode }) {
  return (
    <>
      <g>{children}</g>
      <g transform="translate(0.6 -0.5)" opacity={0.4}>{children}</g>
    </>
  );
}

function FriendsDoodle() {
  const id = useId().replace(/:/g, "");
  const rough = `friends-doodle-${id}`;
  const behind = `friends-doodle-mask-${id}`;
  return (
    <svg
      viewBox="0 0 32 21"
      className="h-5 w-[30px] shrink-0 overflow-visible group-hover:animate-[friends-doodle-wobble_0.55s_ease-in-out]"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <defs>
        <filter id={rough}>
          <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves={2} seed={11} />
          <feDisplacementMap in="SourceGraphic" scale={1.1} />
        </filter>
        <mask id={behind} maskUnits="userSpaceOnUse" x="-2" y="-2" width="36" height="25">
          <rect x="-2" y="-2" width="36" height="25" fill="white" />
          <path d={FRONT} fill="black" stroke="black" strokeWidth={2.6} />
        </mask>
      </defs>
      <g filter={`url(#${rough})`}>
        <g mask={`url(#${behind})`}>
          <Sketch>
            <path d="M 30.4 9.6 C 30.3 5.3 26.8 2.2 22.9 2.4 C 19.1 2.6 16.4 5.9 16.6 9.8 C 16.8 13.8 20 16.7 23.8 16.5 C 27.6 16.3 30.5 13.5 30.4 9.6 Z" />
            <path d="M 22.2 6.6 C 23.4 6.1 24.6 6 25 7.4 C 25.4 8.9 23.2 10.4 21.9 12.4 L 25.9 12.3" strokeWidth={1.3} />
          </Sketch>
        </g>
        <Sketch>
          <path d={FRONT} />
          <path d="M 10.4 10.3 L 12.3 8.9 L 12.2 16.4" strokeWidth={1.3} />
        </Sketch>
      </g>
    </svg>
  );
}

/** The one action on an empty Friends board: signing in again to read the friends list. */
export function FriendsLoadButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-2.5 rounded-xl py-2 pl-3 pr-4 text-[13px] font-semibold text-osu-pink-light transition-colors hover:text-white"
    >
      <FriendsDoodle />
      {label}
    </button>
  );
}
