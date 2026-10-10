import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { msg } from "@lingui/core/macro";

import { getI18n } from "../lib/i18n";
import { pageSeo } from "../lib/seo";
import { AuthorizePage, validateAuthorizeSearch } from "../components/companella/AuthorizePage";

export const Route = createFileRoute("/hashi_/authorize")({
  validateSearch: validateAuthorizeSearch,
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: i18n._(msg`Connect an app`),
      description: i18n._(msg`Approve an app for your osu! account.`),
      path: "/hashi/authorize",
      origin: match.context.origin,
      imageTitle: "Connect an app",
      noindex: true,
    });
  },
  component: HashiAuthorizePage,
});

function HashiAuthorizePage() {
  const navigate = useNavigate();
  return (
    <AuthorizePage
      search={Route.useSearch()}
      path="/hashi/authorize"
      onLeave={() => void navigate({ to: "/hashi" })}
    />
  );
}
