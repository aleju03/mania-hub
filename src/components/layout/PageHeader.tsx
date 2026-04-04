import type { ReactNode } from "react";

interface PageHeaderProps {
  iconSrc: string;
  title: string;
  right?: ReactNode;
}

export function PageHeader({ iconSrc, title, right }: PageHeaderProps) {
  return (
    <div className="bg-osu-d5 border-b border-osu-b3/40">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-3 flex items-center gap-3">
        <img src={iconSrc} alt="" width={28} height={28} className="opacity-60" />
        <h2 className="text-[13px] sm:text-[15px] font-medium text-osu-c2">{title}</h2>
        <span className="mode-icon text-osu-pink ml-1">{"\ue802"}</span>
        {right ? <div className="ml-auto">{right}</div> : null}
      </div>
    </div>
  );
}
