import { useEffect, useRef, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { Trans } from "@lingui/react/macro";

type LegalDocumentProps = {
  eyebrow: string;
  title: string;
  updatedAt: string;
  children: ReactNode;
};

export function LegalDocument({ eyebrow, title, updatedAt, children }: LegalDocumentProps) {
  return (
    <div className="min-h-[calc(100vh-60px)] bg-osu-dark text-osu-f1">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-10 sm:px-6 lg:py-14">
        <header className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-osu-pink-light/70">
            {eyebrow}
          </p>
          <h1 className="text-3xl font-black text-white sm:text-4xl">{title}</h1>
          <p className="text-sm text-osu-f1/70">
            <Trans>Last updated {updatedAt}</Trans>
          </p>
        </header>
        {children}
      </div>
    </div>
  );
}

/* A section a link can point at (/terms#id): arriving there scrolls to it and
   lights it up for a moment, so the part that matters is plain to see. */
export function LegalSection({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const hash = useLocation({ select: (location) => location.hash });
  useEffect(() => {
    const section = ref.current;
    if (!id || hash !== id || !section) return;
    section.scrollIntoView({ block: "start" });
    section.classList.remove("legal-target");
    void section.offsetWidth; // restart the glow on a second visit
    section.classList.add("legal-target");
  }, [id, hash]);
  return (
    <section ref={ref} id={id} className="scroll-mt-24 space-y-3 rounded-lg">
      <h2 className="text-lg font-bold text-white">{title}</h2>
      {children}
    </section>
  );
}

export function LegalParagraph({ children }: { children: ReactNode }) {
  return <p className="leading-7 text-osu-f1/85">{children}</p>;
}
