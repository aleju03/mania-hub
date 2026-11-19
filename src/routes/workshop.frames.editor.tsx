import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";

import { FrameEditor } from "../components/supporter/frames/FrameEditor";
import { getI18n } from "../lib/i18n";

/* The avatar frame editor. `draft` names a draft (in this browser or on the
   account); `frame` opens one of the viewer's submitted frames to edit; with
   neither the editor opens on its starting points. */
export const Route = createFileRoute("/workshop/frames/editor")({
  validateSearch: (search: Record<string, unknown>): { draft?: string; frame?: string } => ({
    draft: typeof search.draft === "string" && /^d[a-z0-9]{4,40}$/.test(search.draft) ? search.draft : undefined,
    frame: typeof search.frame === "string" && /^u\d{1,12}$/.test(search.frame) ? search.frame : undefined,
  }),
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return { meta: [{ title: i18n._(msg`Frame editor`) }, { name: "robots", content: "noindex, nofollow" }] };
  },
  component: FrameEditorPage,
});

function FrameEditorPage() {
  const { draft, frame } = Route.useSearch();
  const navigate = useNavigate();
  return <FrameEditor draftId={draft ?? null} frameId={frame ?? null} onDraftId={(id) => void navigate({ to: "/workshop/frames/editor", search: { draft: id }, replace: true })} />;
}
