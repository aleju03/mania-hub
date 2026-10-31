import { createFileRoute, Link } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

import { PageHeader } from "../components/layout/PageHeader";
import { WorkshopTitle } from "../components/supporter/WorkshopTitle";
import { WorkshopFrames } from "../components/supporter/WorkshopFrames";
import { getI18n } from "../lib/i18n";

/* The workshop's avatar frames: make one, wear it, and browse the ones other
   supporters made (WorkshopFrames). */
export const Route = createFileRoute("/workshop/frames")({
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return { meta: [{ title: i18n._(msg`Avatar frames`) }, { name: "robots", content: "noindex, nofollow" }] };
  },
  component: WorkshopFramesPage,
});

function WorkshopFramesPage() {
  const { t } = useLingui();
  return (
    <div className="min-h-[80vh] bg-osu-b5">
      <PageHeader
        iconSrc="/images/icons/workshop.svg"
        title={<WorkshopTitle>{t`avatar frames`}</WorkshopTitle>}
        right={<Link to="/workshop" className="text-[12px] font-semibold text-osu-f1 hover:text-white">{t`Workshop`}</Link>}
      />
      <div className="mx-auto max-w-[1200px] px-4 py-6 sm:px-5">
        <WorkshopFrames />
      </div>
    </div>
  );
}
