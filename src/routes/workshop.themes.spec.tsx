import { createFileRoute, Link } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Fragment, useMemo, useState, type ReactNode } from "react";

import { PageHeader } from "../components/layout/PageHeader";
import { WorkshopTitle } from "../components/supporter/WorkshopTitle";
import { customThemeSpec } from "../lib/custom-theme-spec";
import { getI18n } from "../lib/i18n";

/* The theme spec, laid out to be read: what a theme's code gets and must do.
   It is the same plain text the editor hands out (customThemeSpec), split here
   into sections, lists and code, and still copyable whole for anyone who
   wants it as text. English on purpose: it's about code. */
export const Route = createFileRoute("/workshop/themes/spec")({
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return { meta: [{ title: i18n._(msg`Theme spec`) }, { name: "description", content: i18n._(msg`How to write the code for your own profile theme.`) }] };
  },
  component: ThemeSpecPage,
});

type Block =
  | { kind: "para"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "code"; text: string };
type Section = { id: string; title: string; note: string | null; blocks: Block[] };

const HEADING = /^([A-Z][A-Z ]+[A-Z])(?:\s+\((.+)\))?$/;

/* The plain-text spec as an intro and titled sections. A line in capitals
   starts a section; "- " starts a list item (indented lines continue it);
   other indented lines are code, as is the whole example. */
function parseSpec(spec: string): { intro: Block[]; sections: Section[] } {
  const lines = spec.split("\n").slice(1);
  const intro: Block[] = [];
  const sections: Section[] = [];
  let blocks = intro;
  let code = false;
  const last = () => blocks[blocks.length - 1];
  for (const raw of lines) {
    const heading = HEADING.exec(raw.trim());
    if (heading && raw === raw.trimStart()) {
      const title = heading[1].charAt(0) + heading[1].slice(1).toLowerCase();
      sections.push({ id: heading[1].toLowerCase().replace(/\s+/g, "-"), title, note: heading[2] ?? null, blocks: [] });
      blocks = sections[sections.length - 1].blocks;
      code = heading[1] === "EXAMPLE";
      continue;
    }
    const prev = last();
    if (code) {
      if (prev?.kind === "code") prev.text += `\n${raw}`;
      else if (raw.trim()) blocks.push({ kind: "code", text: raw });
      continue;
    }
    if (!raw.trim()) {
      if (prev) blocks.push({ kind: "para", text: "" });
      continue;
    }
    if (raw.startsWith("- ")) {
      if (prev?.kind === "list") prev.items.push(raw.slice(2));
      else blocks.push({ kind: "list", items: [raw.slice(2)] });
    } else if (raw.startsWith("  ") && prev?.kind === "list" && prev.items.length > 0) {
      prev.items[prev.items.length - 1] += ` ${raw.trim()}`;
    } else if (raw.startsWith("  ")) {
      if (prev?.kind === "code") prev.text += `\n${raw.slice(2)}`;
      else blocks.push({ kind: "code", text: raw.slice(2) });
    } else if (prev?.kind === "para" && prev.text) {
      prev.text += ` ${raw}`;
    } else {
      blocks.push({ kind: "para", text: raw });
    }
  }
  const tidy = (list: Block[]) => list.filter((block) => block.kind !== "para" || block.text);
  return { intro: tidy(intro), sections: sections.map((section) => ({ ...section, blocks: tidy(section.blocks) })) };
}

/* A list item reads as "the thing: what it is"; the thing is code. */
function Item({ text }: { text: string }) {
  const split = /^([^:]{1,90}?):\s(.+)$/.exec(text);
  if (!split || /[.]\s/.test(split[1])) return <Prose text={text} />;
  return (
    <>
      <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[12.5px] text-osu-pink-light">{split[1]}</code>
      <span className="text-osu-l2">{" "}<Prose text={split[2]} /></span>
    </>
  );
}

/* Words that are code inside a sentence (calls, names with dots or
   underscores, GLSL types) set in mono. */
function Prose({ text }: { text: string }) {
  const parts = text.split(/(\b(?:void|float|vec[234]|sampler2D|mat2|int)\s+\w+(?:\([^)]*\))?|\b\w+\([^()]*\)|\b(?:u|gl|_cg)_\w+|\b\w+\.\w+\b|#\w+)/g);
  return (
    <>
      {parts.map((part, index) => index % 2 === 1
        ? <code key={index} className="font-mono text-[12.5px] text-osu-l1">{part}</code>
        : <Fragment key={index}>{part}</Fragment>)}
    </>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, index): ReactNode => {
        if (block.kind === "para") return <p key={index} className="text-[14px] leading-relaxed text-osu-l2"><Prose text={block.text} /></p>;
        if (block.kind === "code") {
          return (
            <pre key={index} className="overflow-x-auto rounded-lg bg-black/30 px-4 py-3 font-mono text-[12.5px] leading-relaxed text-osu-l1">
              {block.text}
            </pre>
          );
        }
        return (
          <ul key={index} className="space-y-2.5">
            {block.items.map((item, at) => (
              <li key={at} className="text-[14px] leading-relaxed text-osu-l2"><Item text={item} /></li>
            ))}
          </ul>
        );
      })}
    </>
  );
}

function ThemeSpecPage() {
  const { t } = useLingui();
  const spec = useMemo(() => customThemeSpec(), []);
  const { intro, sections } = useMemo(() => parseSpec(spec), [spec]);
  const [copied, setCopied] = useState(false);
  return (
    <div className="min-h-[80vh] bg-osu-b5">
      <PageHeader
        iconSrc="/images/icons/workshop.svg"
        title={<WorkshopTitle>{t`theme spec`}</WorkshopTitle>}
        right={<Link to="/workshop/themes" className="text-[12px] font-semibold text-osu-f1 hover:text-white">{t`Your themes`}</Link>}
      />
      <div className="mx-auto grid max-w-[1080px] gap-10 px-4 py-8 sm:px-5 lg:grid-cols-[180px_minmax(0,1fr)]">
        <nav className="hidden lg:block">
          <div className="sticky top-[84px] space-y-1 text-[13px]">
            {sections.map((section) => (
              <a key={section.id} href={`#${section.id}`} className="block rounded-md px-2 py-1 text-osu-f1 transition-colors hover:bg-osu-b4 hover:text-white">{section.title}</a>
            ))}
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(spec).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              })}
              className="mt-4 block cursor-pointer px-2 text-left text-[12px] text-osu-f1 transition-colors hover:text-white"
            >
              {copied ? t`Copied` : t`Copy as plain text`}
            </button>
          </div>
        </nav>
        <article className="max-w-[720px] space-y-10">
          <header className="space-y-3">
            <h1 className="text-[26px] font-bold text-white">{t`Profile theme spec`}</h1>
            <Blocks blocks={intro} />
          </header>
          {sections.map((section) => (
            <section key={section.id} id={section.id} className="scroll-mt-24 space-y-4 border-t border-white/[0.07] pt-8">
              <h2 className="text-[18px] font-semibold text-white">
                {section.title}
                {section.note ? <span className="ml-2 text-[12.5px] font-normal text-osu-f1">{section.note}</span> : null}
              </h2>
              <Blocks blocks={section.blocks} />
            </section>
          ))}
        </article>
      </div>
    </div>
  );
}
