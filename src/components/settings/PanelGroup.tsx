import type { ReactNode } from "react";

export function PanelGroup({ label, children, action }: { label: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-osu-pink-light">{label}</span>
        <span className="h-px flex-1 bg-osu-b3/35" />
        {action}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}
