import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";

import { getI18n } from "../lib/i18n";
import { canUseAdminFeatures } from "../lib/auth-shared";
import { pageSeo } from "../lib/seo";
import { PageHeader } from "../components/layout/PageHeader";
import { KNOWN_APPS } from "../lib/companella-integration/shared";
import { MANIA_BRIDGE_DOWNLOAD_URL, MANIA_BRIDGE_SOURCE_URL, MANIA_BRIDGE_VERSION } from "../lib/mania-bridge";

/*
 * /bridge: Mania Bridge's download page, and where the app's Download button opens. Admin preview until the
 * release, like the Integrations group in Settings.
 */

export const Route = createFileRoute("/bridge")({
  beforeLoad: ({ context }) => { if (!canUseAdminFeatures(context.auth)) throw notFound(); },
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: "Mania Bridge",
      description: i18n._(msg`Sends your osu!mania plays to Mania Tracker and shows what you're playing on your profile.`),
      path: "/bridge",
      origin: match.context.origin,
      imageTitle: "Mania Bridge",
    });
  },
  component: BridgePage,
});

// The app's own setting, named as its toggle reads: it is not translated, so it is set apart from the sentence.
const SETTING = "whitespace-nowrap rounded bg-osu-b4 px-1.5 py-0.5 text-[13px] font-semibold text-white";
const shareSetting = "Share what I'm playing";

const LINK = "text-white underline decoration-white/30 underline-offset-2 transition-colors hover:decoration-white";

function BridgePage() {
  const { t } = useLingui();
  const app = KNOWN_APPS["mania-bridge"];

  return (
    <div className="flex-1">
      <PageHeader
        iconSrc="/images/icons/settings.svg"
        title={(
          <>
            <Link to="/settings" search={{ tab: "preferences" }} className="text-osu-f1 transition-colors hover:text-white"><Trans>Settings</Trans></Link>
            <span className="mx-2 text-osu-f1/50">/</span>
            {app.name}
          </>
        )}
      />
      <div className="min-h-[80vh] bg-osu-b5">
        <div className="mx-auto max-w-xl px-4 pt-12 pb-12 sm:pt-16">
          <div className="flex flex-col items-center text-center">
            <img src={app.icon} alt="" width={112} height={112} className="h-28 w-28 rounded-full" />
            <h1 className="mt-5 text-3xl font-semibold text-white">{app.name}</h1>
            <p className="mt-2 max-w-sm text-[15px] leading-relaxed text-osu-l2">
              <Trans>Sends your osu!mania plays to Mania Tracker and shows what you're playing on your profile.</Trans>
            </p>

            {MANIA_BRIDGE_DOWNLOAD_URL ? (
              <a
                href={MANIA_BRIDGE_DOWNLOAD_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-7 inline-flex items-center justify-center rounded-full bg-osu-pink px-7 py-3 text-[15px] font-bold text-white transition hover:brightness-110"
              >
                <Trans>Download</Trans>
              </a>
            ) : (
              <div className="mt-7 rounded-full bg-osu-b4 px-7 py-3 text-[15px] font-bold text-osu-f1">
                <Trans>Not available yet</Trans>
              </div>
            )}
            <div className="mt-3 text-[12px] text-osu-f1">
              v{MANIA_BRIDGE_VERSION} · {t`Windows and Linux`}
              {MANIA_BRIDGE_SOURCE_URL && (
                <>
                  {" · "}
                  <a href={MANIA_BRIDGE_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-white">
                    <Trans>Source code</Trans>
                  </a>
                </>
              )}
            </div>
          </div>

          <div className="mt-12 space-y-6 border-t border-white/[0.07] pt-8 text-[15px] leading-relaxed text-osu-l2">
            <section>
              <h2 className="text-[13px] font-semibold text-white"><Trans>What it does</Trans></h2>
              <p className="mt-2">
                <Trans>
                  Mania Bridge sends every mania play you finish on osu!stable or lazer to your account, with its replay. With{" "}
                  <span className={SETTING}>{shareSetting}</span> turned on, your profile and the pp rankings also show what
                  you're doing in osu!.
                </Trans>
              </p>
            </section>
            <section>
              <h2 className="text-[13px] font-semibold text-white"><Trans>What you need</Trans></h2>
              <p className="mt-2">
                <Trans>Mania Bridge reads osu! through tosu, so tosu has to be running. On Linux, lazer needs tosu's Linux build.</Trans>
              </p>
            </section>
            <section>
              <h2 className="text-[13px] font-semibold text-white"><Trans>Connecting</Trans></h2>
              <p className="mt-2">
                <Trans>
                  Connect it to your account from inside the app. You can revoke the connection in <Link to="/settings" search={{ tab: "preferences" }} className={LINK}>Settings</Link>, under Preferences.
                </Trans>
              </p>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
