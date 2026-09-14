import type { ReactNode } from "react";

interface PageHeaderProps {
  iconSrc: string;
  title: ReactNode;
  right?: ReactNode;
  /**
   * Render `right` on the title line, mobile only, instead of letting it wrap
   * to a row of its own. For short status text that PageTabs shows at the end
   * of the tab row on desktop (the rankings player count); a button still
   * wants the full-width row.
   */
  rightInline?: boolean;
}

export function PageHeader({ iconSrc, title, right, rightInline }: PageHeaderProps) {
  return (
    <div className="bg-osu-d5 border-b border-osu-b3/40">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <img src={iconSrc} alt="" width={28} height={28} className="opacity-60 shrink-0" />
        <h2 className="min-w-0 flex-1 text-[13px] sm:text-[15px] font-medium text-osu-c2 leading-tight">{title}</h2>
        {right && rightInline ? <div className="shrink-0 sm:hidden">{right}</div> : null}
        <span className="mode-icon text-osu-pink shrink-0">{"\ue802"}</span>
        {right && !rightInline ? <div className="w-full sm:w-auto sm:ml-auto">{right}</div> : null}
      </div>
    </div>
  );
}
