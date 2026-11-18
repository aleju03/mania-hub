import { createFileRoute } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";

import { getI18n } from "../lib/i18n";
import { StableAccCalculator } from "../components/tools/StableAccCalculator";

export const Route = createFileRoute("/stable-acc")({
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return {
      meta: [
        { title: i18n._(msg`Stable acc calculator`) },
        { name: "description", content: "" },
        { name: "robots", content: "noindex, nofollow" },
      ],
    };
  },
  component: StableAccCalculator,
});
