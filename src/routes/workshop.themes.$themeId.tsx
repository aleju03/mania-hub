import { createFileRoute } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";
import { useRef } from "react";

import { ThemeEditor } from "../components/supporter/themes/ThemeEditor";
import { getI18n } from "../lib/i18n";

/* The theme editor: `new` for a new theme (mode=layers or code; from=<built-in
   id> to start code from one, remix=<gallery id> to remix one), or one of the
   viewer's own. */
export const Route = createFileRoute("/workshop/themes/$themeId")({
  validateSearch: (search: Record<string, unknown>): { from?: string; remix?: number; mode?: "code" | "layers" } => {
    const remix = Number(search.remix);
    return {
      mode: search.mode === "code" || search.mode === "layers" ? search.mode : undefined,
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
  const { themeId } = Route.useParams();
  const { from, remix, mode } = Route.useSearch();
  const id = Number(themeId);
  const existing = Number.isSafeInteger(id) && id > 0 ? id : null;
  /* A new theme's first save moves the address to its id: the same editor
     carries on. Any other change of theme starts a fresh one. */
  const key = `${themeId}|${from ?? ""}|${remix ?? ""}|${mode ?? ""}`;
  const session = useRef(key);
  const created = useRef<string | null>(null);
  if (key !== session.current && key !== created.current) session.current = key;
  return (
    <ThemeEditor
        key={session.current}
        start={{ themeId: existing, from, remix, mode }}
      onCreated={(newId) => {
        created.current = `${newId}|||`;
      }}
    />
  );
}
