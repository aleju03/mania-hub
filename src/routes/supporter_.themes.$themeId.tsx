import { createFileRoute, Link } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useRef } from "react";

import { PageHeader } from "../components/layout/PageHeader";
import { ThemeEditor } from "../components/supporter/themes/ThemeEditor";
import { getI18n } from "../lib/i18n";

/* The code theme editor: `new` for a new theme (from=<built-in id> to start
   from one, remix=<gallery id> to remix one), or one of the viewer's own. */
export const Route = createFileRoute("/supporter_/themes/$themeId")({
  validateSearch: (search: Record<string, unknown>): { from?: string; remix?: number } => {
    const remix = Number(search.remix);
    return {
      from: typeof search.from === "string" && /^[a-z]{1,20}$/.test(search.from) ? search.from : undefined,
      remix: Number.isSafeInteger(remix) && remix > 0 ? remix : undefined,
    };
  },
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return { meta: [{ title: i18n._(msg`Theme editor`) }, { name: "robots", content: "noindex, nofollow" }] };
  },
  component: ThemeEditorPage,
});

function ThemeEditorPage() {
  const { t } = useLingui();
  const { themeId } = Route.useParams();
  const { from, remix } = Route.useSearch();
  const id = Number(themeId);
  const existing = Number.isSafeInteger(id) && id > 0 ? id : null;
  /* A new theme's first save moves the address to its id: the same editor
     carries on. Any other change of theme starts a fresh one. */
  const key = `${themeId}|${from ?? ""}|${remix ?? ""}`;
  const session = useRef(key);
  const created = useRef<string | null>(null);
  if (key !== session.current && key !== created.current) session.current = key;
  return (
    <div className="min-h-[80vh] bg-osu-b5">
      <PageHeader
        iconSrc="/images/icons/supporter-heart.svg"
        title={t`theme editor`}
        right={<Link to="/supporter/themes" className="text-[12px] font-semibold text-osu-f1 hover:text-white">{t`Your themes`}</Link>}
      />
      <ThemeEditor
        key={session.current}
        start={{ themeId: existing, from, remix }}
        onCreated={(newId) => {
          created.current = `${newId}||`;
        }}
      />
    </div>
  );
}
