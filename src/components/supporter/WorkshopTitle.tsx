import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useLingui } from "@lingui/react/macro";

/* A workshop page's title as a trail back to the workshop: "workshop › here". */
export function WorkshopTitle({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Link to="/workshop" className="shrink-0 text-osu-f1 transition-colors hover:text-white">{t`workshop`}</Link>
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-osu-f1/60" aria-hidden>
        <path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="truncate">{children}</span>
    </span>
  );
}
