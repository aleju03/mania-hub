import { createFileRoute } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";

import { getI18n } from "../lib/i18n";
import { MyDataPanel } from "../components/me/MyDataPanel";

export const Route = createFileRoute("/my-stats")({
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return {
      meta: [
        { title: i18n._(msg`My Stats`) },
        { name: "description", content: "" },
        { name: "robots", content: "noindex, nofollow" },
      ],
    };
  },
  component: MyDataPanel,
});
