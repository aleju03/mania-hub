import { useEffect, useState } from "react";
import { Link, createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

import { getI18n } from "../lib/i18n";
import { track } from "../lib/analytics";
import { canUseAdminFeatures } from "../lib/auth-shared";
import { pageSeo } from "../lib/seo";
import { PageHeader } from "../components/layout/PageHeader";
import { ImageLightbox } from "../components/ui/ImageLightbox";
import { KNOWN_APPS } from "../lib/companella-integration/shared";
import { MANIA_BRIDGE_SOURCE_URL, MANIA_BRIDGE_VERSION, type ManiaBridgeDownloads } from "../lib/mania-bridge";
import { fetchManiaBridgeDownloads } from "../lib/mania-bridge-server";

/*
 * /hashi: Hashi's download page, and where the app's Download button opens. Admin preview until the
 * release, like the Integrations group in Settings.
 */

type BridgeTab = "about" | "screenshots";

export const Route = createFileRoute("/hashi")({
  validateSearch: (search: Record<string, unknown>): { tab?: BridgeTab } => ({
    tab: search.tab === "screenshots" ? "screenshots" : undefined,
  }),
  beforeLoad: ({ context }) => { if (!canUseAdminFeatures(context.auth)) throw notFound(); },
  loader: async () => {
    try {
      return await fetchManiaBridgeDownloads();
    } catch {
      return null;
    }
  },
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: "Hashi",
      description: i18n._(msg`Sends your osu!mania plays from lazer or osu!stable to Mania Tracker and shows what you're playing on your profile and the rankings.`),
      path: "/hashi",
      origin: match.context.origin,
      imageTitle: "Hashi",
    });
  },
  component: BridgePage,
});

// The app's own setting, named as its toggle reads: it is not translated, so it is set apart from the sentence.
const SETTING = "whitespace-nowrap rounded bg-osu-b4 px-1.5 py-0.5 text-[13px] font-semibold text-white";
const shareSetting = "Share what I'm playing";

type Os = "windows" | "linux";

const OS_NAME: Record<Os, string> = { windows: "Windows", linux: "Linux" };

/** The visitor's system, read after hydration so the server render stays neutral. Null for anything else. */
function useDetectedOs(): Os | null {
  const [os, setOs] = useState<Os | null>(null);
  useEffect(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = `${nav.userAgentData?.platform ?? ""} ${nav.userAgent}`;
    if (/Android|CrOS/i.test(platform)) return;
    if (/Windows/i.test(platform)) setOs("windows");
    else if (/Linux/i.test(platform)) setOs("linux");
  }, []);
  return os;
}

function OsLogo({ os, className }: { os: Os; className: string }) {
  return <img src={`/images/os/${os}.svg`} alt="" width={20} height={20} className={className} />;
}

type Package = "exe" | "appimage" | "deb" | "rpm";

/** Counts a download click, with which installer it was. */
function trackDownload(file: Package) {
  track("bridge_download", { package: file, os: file === "exe" ? "windows" : "linux" });
}

function DownloadButton({ os, href }: { os: Os; href: string }) {
  const name = OS_NAME[os];
  return (
    <a
      href={href}
      download
      onClick={() => trackDownload(os === "windows" ? "exe" : "appimage")}
      className="inline-flex items-center justify-center gap-2.5 rounded-full bg-osu-pink px-7 py-3 text-[15px] font-bold text-white transition hover:brightness-110"
    >
      <OsLogo os={os} className="h-5 w-5" />
      <Trans>Download for {name}</Trans>
    </a>
  );
}

// A hairline between inline items, in place of a separator glyph.
const DIVIDER = "h-3 w-px bg-white/15";

// The small download links, with the same hairline between them.
const LINK_ROW = "flex items-center text-[12px] text-osu-f1 [&>*+*]:ml-3 [&>*+*]:border-l [&>*+*]:border-white/15 [&>*+*]:pl-3";

const SMALL_LINK = "inline-flex items-center gap-1.5 transition-colors hover:text-white";

/** The installers: the visitor's system as the button, the rest as small links under it. */
function Downloads({ downloads }: { downloads: ManiaBridgeDownloads | null }) {
  const os = useDetectedOs();
  if (!downloads || (!downloads.windows && !downloads.appImage)) {
    return (
      <div className="mt-5 rounded-full bg-osu-b4 px-7 py-3 text-[15px] font-bold text-osu-f1">
        <Trans>Not available yet</Trans>
      </div>
    );
  }
  const linuxPackages = (
    <>
      {downloads.deb && <a href={downloads.deb} download onClick={() => trackDownload("deb")} className={SMALL_LINK}>.deb</a>}
      {downloads.rpm && <a href={downloads.rpm} download onClick={() => trackDownload("rpm")} className={SMALL_LINK}>.rpm</a>}
    </>
  );
  const primary: Os | null = os === "windows" && downloads.windows ? "windows" : os === "linux" && downloads.appImage ? "linux" : null;
  if (!primary) {
    return (
      <>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          {downloads.windows && <DownloadButton os="windows" href={downloads.windows} />}
          {downloads.appImage && <DownloadButton os="linux" href={downloads.appImage} />}
        </div>
        {(downloads.deb || downloads.rpm) && <div className={`mt-3 ${LINK_ROW}`}>{linuxPackages}</div>}
      </>
    );
  }
  return (
    <>
      <div className="mt-5">
        <DownloadButton os={primary} href={primary === "windows" ? downloads.windows! : downloads.appImage!} />
      </div>
      <div className={`mt-3 ${LINK_ROW}`}>
        {primary === "linux" ? linuxPackages : null}
        {primary === "linux" && downloads.windows && (
          <a href={downloads.windows} download onClick={() => trackDownload("exe")} className={SMALL_LINK}><OsLogo os="windows" className="h-3 w-3 opacity-70" />Windows</a>
        )}
        {primary === "windows" && downloads.appImage && (
          <a href={downloads.appImage} download onClick={() => trackDownload("appimage")} className={SMALL_LINK}><OsLogo os="linux" className="h-3 w-3 opacity-70" />Linux</a>
        )}
        {primary === "windows" ? linuxPackages : null}
      </div>
    </>
  );
}

/** The app and what it shows on the site, so nobody installs it blind. Wide ones are site captures. */
const SCREENSHOTS: { src: string; width: number; height: number; alt: MessageDescriptor; wide?: boolean }[] = [
  { src: "/images/hashi/screenshot-1-main.webp", width: 960, height: 1280, alt: msg`Hashi's main window with the last plays it sent` },
  { src: "/images/hashi/screenshot-4-leaderboard.webp", width: 534, height: 790, alt: msg`A map's leaderboard in Hashi` },
  { src: "/images/hashi/screenshot-2-connect.webp", width: 960, height: 1280, alt: msg`Hashi before connecting to Mania Tracker` },
  { src: "/images/hashi/screenshot-3-settings.webp", width: 960, height: 1280, alt: msg`Hashi's settings` },
  { src: "/images/hashi/profile-live.webp", width: 2540, height: 600, alt: msg`A profile showing the map its player is playing`, wide: true },
  { src: "/images/hashi/rankings-live.webp", width: 2330, height: 590, alt: msg`The rankings showing a player who is playing`, wide: true },
];

function Screenshots() {
  const { i18n } = useLingui();
  const [open, setOpen] = useState<number | null>(null);
  const urls = SCREENSHOTS.map((shot) => shot.src);
  return (
    <div className="mx-auto max-w-4xl px-4">
      <div className="mt-8 grid grid-cols-2 items-start gap-3 border-t border-white/[0.07] pt-8 sm:grid-cols-4">
        {SCREENSHOTS.map((shot, index) => (
          <button
            key={shot.src}
            type="button"
            onClick={() => setOpen(index)}
            className={`cursor-zoom-in overflow-hidden rounded-lg bg-osu-b4 transition hover:brightness-110 ${shot.wide ? "col-span-2 sm:col-span-4" : ""}`}
          >
            <img src={shot.src} alt={i18n._(shot.alt)} width={shot.width} height={shot.height} loading="lazy" className="block h-auto w-full" />
          </button>
        ))}
      </div>
      {open != null ? <ImageLightbox urls={urls} index={open} onIndex={setOpen} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

const LINK = "text-white underline decoration-white/30 underline-offset-2 transition-colors hover:decoration-white";

function BridgePage() {
  const { t } = useLingui();
  const app = KNOWN_APPS["mania-bridge"];
  const downloads = Route.useLoaderData();
  const tab: BridgeTab = Route.useSearch().tab ?? "about";
  const navigate = useNavigate();

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
      <div className="min-h-[80vh] bg-osu-b5 pb-12">
        <div className="mx-auto max-w-xl px-4 pt-6 sm:pt-8">
          <div className="flex flex-col items-center text-center">
            <img src={app.icon} alt="" width={112} height={112} className="h-28 w-28 rounded-full" />
            <h1 className="mt-5 text-3xl font-semibold text-white">{app.name}</h1>
            <p className="mt-2 max-w-sm text-[15px] leading-relaxed text-osu-l2">
              <Trans>Sends your osu!mania plays from lazer or osu!stable to Mania Tracker and shows what you're playing on your profile and the rankings.</Trans>
            </p>

            <Downloads downloads={downloads} />
            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[12px] text-osu-f1">
              <span>v{MANIA_BRIDGE_VERSION}</span>
              <span aria-hidden className={DIVIDER} />
              <span>{t`Windows and Linux`}</span>
              <span aria-hidden className={DIVIDER} />
              <span>{t`lazer and stable`}</span>
            </div>
          </div>

          <div className="mt-6 flex justify-center">
            <div className="inline-flex rounded-full bg-osu-b4 p-1">
              {([["about", t`About`], ["screenshots", t`Screenshots`]] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => navigate({ to: "/hashi", search: id === "about" ? {} : { tab: id }, replace: true, resetScroll: false })}
                  className={`rounded-full px-5 py-1.5 text-[13px] font-semibold transition-colors ${tab === id ? "bg-white/10 text-white" : "text-osu-f1 hover:text-white"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {tab === "screenshots" ? <Screenshots /> : (
        <div className="mx-auto max-w-xl px-4">
          <div className="mt-8 space-y-6 border-t border-white/[0.07] pt-8 text-[15px] leading-relaxed text-osu-l2">
            <section>
              <h2 className="text-[13px] font-semibold text-white"><Trans>What it does</Trans></h2>
              <p className="mt-2">
                <Trans>
                  Hashi sends every mania play you finish on lazer or osu!stable to your account, with its replay, even if you're restricted on Bancho, playing offline or on a private server. With{" "}
                  <span className={SETTING}>{shareSetting}</span> turned on, your profile and the pp rankings on Mania Tracker
                  also show what you're doing in osu!.
                </Trans>
              </p>
            </section>
            <section>
              <h2 className="text-[13px] font-semibold text-white"><Trans>What you need</Trans></h2>
              <p className="mt-2">
                <Trans>
                  It reads osu! through tosu, so tosu has to be running. You can download it from{" "}
                  <a href="https://tosu.app" target="_blank" rel="noopener noreferrer" className={LINK}>tosu.app</a>. On Linux, lazer
                  needs tosu's Linux build.
                </Trans>
              </p>
            </section>
            <section>
              <h2 className="text-[13px] font-semibold text-white"><Trans>On Windows</Trans></h2>
              <p className="mt-2">
                <Trans>
                  The installer isn't signed, because Microsoft charges for code signing, so Windows shows a warning before it runs. Click More info, then Run anyway. The{" "}
                  <a href={MANIA_BRIDGE_SOURCE_URL} target="_blank" rel="noopener noreferrer" onClick={() => track("bridge_source_click")} className={LINK}>source code</a> is on GitHub if you want to check what it does.
                </Trans>
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
        )}
      </div>
    </div>
  );
}
