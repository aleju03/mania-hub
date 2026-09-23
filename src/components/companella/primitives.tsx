/*
 * Small shared pieces for the /companella beta page.
 *
 * Kept deliberately flat: sections are a heading over a hairline, not boxes,
 * no glows, and the data itself carries the weight rather than a subtitle
 * explaining it.
 */

import type { ReactNode } from "react";

export function Panel({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-white/[0.07] pt-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-osu-f1">{title}</h3>
        {right ? <div className="ml-auto">{right}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1/70">{label}</div>
      <div className="truncate text-sm text-white">{children}</div>
    </div>
  );
}

const PILL_TONES = {
  neutral: "bg-osu-b4 text-osu-f1",
  good: "bg-emerald-500/15 text-emerald-300",
  warn: "bg-amber-500/15 text-amber-300",
  bad: "bg-rose-500/15 text-rose-300",
} as const;

export type PillTone = keyof typeof PILL_TONES;

export function Pill({ tone = "neutral", children }: { tone?: PillTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${PILL_TONES[tone]}`}>
      {children}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-osu-f1">{children}</p>;
}

export function ActionButton({
  onClick,
  disabled,
  tone = "neutral",
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  tone?: "neutral" | "danger";
  children: ReactNode;
}) {
  const base = "rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors cursor-pointer disabled:cursor-default disabled:opacity-40";
  const tones = tone === "danger"
    ? "bg-osu-b4 text-rose-300 hover:bg-rose-500/20 hover:text-rose-200"
    : "bg-osu-b4 text-osu-f1 hover:bg-osu-b3 hover:text-white";
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${base} ${tones}`}>
      {children}
    </button>
  );
}
