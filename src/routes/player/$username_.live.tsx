import { createFileRoute } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";

import { LiveSpectatePage } from "../../components/live/LiveSpectatePage";
import { getI18n } from "../../lib/i18n";
import { pageSeo } from "../../lib/seo";

export const Route = createFileRoute("/player/$username_/live")({
  head: ({ params, match }) => {
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: i18n._(msg`Spectating ${params.username}`),
      description: i18n._(msg`Spectate ${params.username} playing osu!mania live.`),
      path: `/player/${encodeURIComponent(params.username)}/live`,
      origin: match.context.origin,
      imageTitle: "Live",
      // Live only while they stream; nothing here for a crawler.
      noindex: true,
    });
  },
  component: LivePage,
});

function LivePage() {
  const { username } = Route.useParams();
  return <LiveSpectatePage user={username} />;
}
