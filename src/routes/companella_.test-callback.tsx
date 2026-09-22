import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";

import { getI18n } from "../lib/i18n";
import { PageHeader } from "../components/layout/PageHeader";
import { pageSeo } from "../lib/seo";
import { Panel } from "../components/companella/primitives";

/*
 * The browser test client's registered callback.
 *
 * The exchange itself happens on /companella, where the test panel holds the
 * key and the PKCE verifier, so this page only carries the code across and
 * then takes the parameters back out of the address bar.
 */

export const Route = createFileRoute("/companella_/test-callback")({
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search.code === "string" ? search.code : "",
    state: typeof search.state === "string" ? search.state : "",
  }),
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: i18n._(msg`Companella`),
      description: i18n._(msg`Finishing the test client connection.`),
      path: "/companella/test-callback",
      origin: match.context.origin,
      imageTitle: "Companella",
      noindex: true,
    });
  },
  component: TestCallbackPage,
});

function TestCallbackPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { code, state } = Route.useSearch();

  useEffect(() => {
    // Hand the grant to the panel and replace this entry, so the code does not
    // stay in history behind a back button.
    void navigate({ to: "/companella", search: { code, state }, replace: true });
  }, [code, navigate, state]);

  return (
    <div className="flex-1">
      <PageHeader iconSrc="/images/icons/home.svg" title={t`Companella`} />
      <div className="bg-osu-b5 min-h-[80vh]">
        <div className="mx-auto max-w-[1200px] px-3 py-3 sm:px-5 sm:py-6">
          <div className="mx-auto max-w-xl">
            <Panel title={<Trans>Companella</Trans>}>
              <p className="py-8 text-center text-sm text-osu-f1">
                <Trans>Finishing the connection...</Trans>
              </p>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}
