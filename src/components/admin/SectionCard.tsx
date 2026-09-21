import type React from "react";

/* The card shell every admin monitoring panel sits in. */
export function SectionCard({
  title,
  subtitle,
  actions,
  compactActions = false,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  compactActions?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-osu-b3/30 bg-osu-b4/30 flex flex-col w-full">
      {/* Actions drop under the title on a phone: side by side they squeezed the
          heading down to one letter per line. */}
      <div className="px-3 pt-3 pb-2.5 border-b border-osu-b3/20 sm:px-4">
        <div className={`flex gap-2 sm:gap-3 ${compactActions ? "flex-row items-start justify-between" : "flex-col sm:flex-row sm:items-start sm:justify-between"}`}>
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-osu-c2 uppercase tracking-wider">{title}</div>
            {subtitle ? <div className="text-[11px] text-osu-f1 mt-0.5">{subtitle}</div> : null}
          </div>
          {actions ? <div className="sm:flex-shrink-0">{actions}</div> : null}
        </div>
      </div>
      <div className="p-2.5 flex-1 min-h-0 sm:p-3">{children}</div>
    </div>
  );
}
