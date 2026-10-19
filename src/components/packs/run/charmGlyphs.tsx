import type { ReactNode } from "react";
import { GAME_ICON_BODIES } from "./gameIconBodies";

/* The run's small UI marks: the Run chip's notes, the move arrows, and the
   shop's reroll dice (game-icons.net, see gameIconBodies.ts). The marks
   drawn here share a 24px grid and a 1.9 stroke with round ends. */

const STROKE = 1.9;

function Glyph({ size, className, children }: { size: number; className?: string; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

/* Dice, for the shop's reroll. */
export function RerollGlyph({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      className={className}
      dangerouslySetInnerHTML={{ __html: GAME_ICON_BODIES.reroll }}
    />
  );
}

/* The run's own mark: two notes stepping down to the judgement line. */
export function RunGlyph({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <rect x="2.5" y="3.5" width="8" height="4" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="13.5" y="10" width="8" height="4" rx="1.2" fill="currentColor" stroke="none" />
      <path d="M2 19.5h20" />
    </Glyph>
  );
}

/* Move a charm one key left or right. */
export function NudgeGlyph({ direction, size = 16, className }: { direction: "left" | "right"; size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <path d={direction === "left" ? "M14.5 6 8.5 12l6 6" : "M9.5 6l6 6-6 6"} />
    </Glyph>
  );
}
