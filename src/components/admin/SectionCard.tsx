import type React from "react";

/* The card shell every admin monitoring panel sits in. */
export function SectionCard({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-osu-b3/30 bg-osu-b4/30 flex flex-col w-full">
      <div className="px-4 pt-3 pb-2 border-b border-osu-b3/20">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-osu-c2 uppercase tracking-wider">{title}</div>
            {subtitle ? <div className="text-[10px] text-osu-f1 mt-0.5">{subtitle}</div> : null}
          </div>
          {actions ? <div className="flex-shrink-0">{actions}</div> : null}
        </div>
      </div>
      <div className="p-3 flex-1 min-h-0">{children}</div>
    </div>
  );
}
