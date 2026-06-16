import type { ReactNode } from "react";

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
          <p className="text-sm text-osu-f1/70">Last updated {updatedAt}</p>
        </header>
        {children}
      </div>
    </div>
  );
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-white">{title}</h2>
      {children}
    </section>
  );
}

export function LegalParagraph({ children }: { children: ReactNode }) {
  return <p className="leading-7 text-osu-f1/85">{children}</p>;
}
