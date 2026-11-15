import { createFileRoute, Link } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Fragment, useMemo, useState, type ReactNode } from "react";

import { PageHeader } from "../components/layout/PageHeader";
import { WorkshopTitle } from "../components/supporter/WorkshopTitle";
import { customThemeSpec, SPEC_HEADINGS, type SpecSectionId } from "../lib/custom-theme-spec";
import type { AppLocale } from "../lib/locale";
import { getI18n } from "../lib/i18n";

/* The theme spec, laid out to be read: what a theme's code gets and must do.
   It is the same plain text the editor hands out (customThemeSpec), split here
   into sections, lists and code, and still copyable whole for anyone who
   wants it as text. The words are in the visitor's language; the code stays
   as written. */
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

/* The plain-text spec as an intro and titled sections. A section's heading
   line (SPEC_HEADINGS, with an optional note in brackets) starts it; "- " starts a list item (indented lines continue it);
   other indented lines are code, as is the whole example. */
function parseSpec(spec: string, headings: Record<SpecSectionId, string>): { intro: Block[]; sections: Section[] } {
  const lines = spec.split("\n").slice(1);
  const intro: Block[] = [];
  const sections: Section[] = [];
  let blocks = intro;
  let code = false;
  const last = () => blocks[blocks.length - 1];
  for (const raw of lines) {
    const heading = raw === raw.trimStart() ? headingOf(raw.trim(), headings) : null;
    if (heading) {
      const [id, text, note] = heading;
      sections.push({ id, title: text.charAt(0) + text.slice(1).toLowerCase(), note, blocks: [] });
      blocks = sections[sections.length - 1].blocks;
      code = id === "example";
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
      prev.items[prev.items.length - 1] = joinLine(prev.items[prev.items.length - 1], raw.trim());
    } else if (raw.startsWith("  ")) {
      if (prev?.kind === "code") prev.text += `\n${raw.slice(2)}`;
      else blocks.push({ kind: "code", text: raw.slice(2) });
    } else if (prev?.kind === "para" && prev.text) {
      prev.text = joinLine(prev.text, raw);
    } else {
      blocks.push({ kind: "para", text: raw });
    }
  }
  const tidy = (list: Block[]) => list.filter((block) => block.kind !== "para" || block.text);
  return { intro: tidy(intro), sections: sections.map((section) => ({ ...section, blocks: tidy(section.blocks) })) };
}

/* A wrapped line back onto the one before it: a space between words, none
   where either side is Chinese, which puts no spaces between words. */
const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;
function joinLine(before: string, line: string): string {
  return CJK.test(before.slice(-1)) || CJK.test(line.charAt(0)) ? before + line : `${before} ${line}`;
}

/* The section a line heads, its heading and the note after it, if any. */
function headingOf(line: string, headings: Record<SpecSectionId, string>): [SpecSectionId, string, string | null] | null {
  for (const [id, text] of Object.entries(headings) as [SpecSectionId, string][]) {
    if (!line.startsWith(text)) continue;
    const rest = line.slice(text.length).trim();
    if (!rest) return [id, text, null];
    const note = /^[(（](.+)[)）]$/.exec(rest);
    if (note) return [id, text, note[1]];
  }
  return null;
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
        ? <code key={index} className="font-mono text-[12.5px] text-osu-l1 [overflow-wrap:anywhere]">{part}</code>
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
  const { t, i18n } = useLingui();
  const locale = i18n.locale as AppLocale;
  const spec = useMemo(() => customThemeSpec(locale), [locale]);
  const { intro, sections } = useMemo(() => parseSpec(spec, SPEC_HEADINGS[locale] ?? SPEC_HEADINGS.en), [spec, locale]);
  const [copied, setCopied] = useState(false);
  return (
    <div className="min-h-[80vh] bg-osu-b5">
      <PageHeader
        iconSrc="/images/icons/workshop.svg"
        title={<WorkshopTitle>{t`theme spec`}</WorkshopTitle>}
        right={<Link to="/workshop/themes" className="text-[12px] font-semibold text-osu-f1 hover:text-white">{t`Your themes`}</Link>}
      />
      <div className="mx-auto grid max-w-[1080px] grid-cols-[minmax(0,1fr)] gap-10 px-4 py-8 sm:px-5 lg:grid-cols-[180px_minmax(0,1fr)]">
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
