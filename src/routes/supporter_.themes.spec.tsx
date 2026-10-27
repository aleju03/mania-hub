import { createFileRoute, Link } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";

import { PageHeader } from "../components/layout/PageHeader";
import { customThemeSpec } from "../lib/custom-theme-spec";
import { getI18n } from "../lib/i18n";

/* The theme spec as plain text: what a theme's code gets and must do. English
   on purpose: it's about code. */
export const Route = createFileRoute("/supporter_/themes/spec")({
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return { meta: [{ title: i18n._(msg`Theme spec`) }, { name: "description", content: i18n._(msg`How to write the code for your own profile theme.`) }] };
  },
  component: ThemeSpecPage,
});

function ThemeSpecPage() {
  const { t } = useLingui();
  const spec = useMemo(() => customThemeSpec(), []);
  const [copied, setCopied] = useState(false);
  return (
    <div className="min-h-[80vh] bg-osu-b5">
      <PageHeader
        iconSrc="/images/icons/supporter-heart.svg"
        title={t`theme spec`}
        right={<Link to="/supporter/themes" className="text-[12px] font-semibold text-osu-f1 hover:text-white">{t`Your themes`}</Link>}
      />
      <div className="mx-auto max-w-[860px] px-4 py-6 sm:px-5">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(spec).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            })}
            className="h-9 cursor-pointer rounded-full bg-osu-pink px-5 text-[13px] font-semibold text-white transition hover:brightness-110"
          >
            {copied ? t`Copied` : t`Copy the spec`}
          </button>
          <p className="text-[12.5px] text-osu-l2">{t`Everything a theme's code gets and has to follow.`}</p>
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-white/[0.07] bg-[#17121b] p-5 font-mono text-[12.5px] leading-relaxed text-osu-l2">{spec}</pre>
      </div>
    </div>
  );
}
