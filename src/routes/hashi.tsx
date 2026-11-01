import { useEffect, useState, type CSSProperties } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

import { getI18n } from "../lib/i18n";
import { track } from "../lib/analytics";
import { pageSeo } from "../lib/seo";
import { PageHeader } from "../components/layout/PageHeader";
import { ImageLightbox } from "../components/ui/ImageLightbox";
import { KNOWN_APPS } from "../lib/companella-integration/shared";
import { MANIA_BRIDGE_SOURCE_URL, MANIA_BRIDGE_VERSION, type ManiaBridgeDownloads } from "../lib/mania-bridge";
import { fetchManiaBridgeDownloads } from "../lib/mania-bridge-server";

/*
 * /hashi: Hashi's download page, and where the app's Download button opens.
 */

type BridgeTab = "about" | "screenshots";

export const Route = createFileRoute("/hashi")({
  validateSearch: (search: Record<string, unknown>): { tab?: BridgeTab } => ({
    tab: search.tab === "screenshots" ? "screenshots" : undefined,
  }),
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
      description: i18n._(msg`Sends your mania plays to your profile, shows leaderboards for any mods even on graveyard maps, and helps you practice what went wrong.`),
      path: "/hashi",
      origin: match.context.origin,
      imageTitle: "Hashi",
    });
  },
  component: BridgePage,
});

// The app's own settings, named as their toggles read: they are not translated, so they are set apart from the sentence.
const SETTING = "whitespace-nowrap rounded bg-osu-b4 px-1.5 py-0.5 text-[13px] font-semibold text-white";
const sendSetting = "Send my plays";
const shareSetting = "Share my live status";

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

/** The app and what it shows on the site, so nobody installs it blind. Wide ones are site captures; pending ones aren't captured yet. */
const ALL_SCREENSHOTS: { src: string; width: number; height: number; alt: MessageDescriptor; wide?: boolean; pending?: boolean }[] = [
  { src: "/images/hashi/main.webp", width: 960, height: 1280, alt: msg`Hashi's main window with the last plays it sent` },
  { src: "/images/hashi/analysis.webp", width: 960, height: 1280, alt: msg`The top of a play's analysis, with its score and tips` },
  { src: "/images/hashi/analysis-keys.webp", width: 960, height: 1280, alt: msg`Accuracy for each key and each hand, with the timing chart` },
  { src: "/images/hashi/practice-map.webp", width: 960, height: 1280, alt: msg`A practice map's analysis, with its repeats and earlier tries`, pending: true },
  { src: "/images/hashi/chord-trainer.webp", width: 960, height: 1280, alt: msg`The chord trainer running` },
  { src: "/images/hashi/goals.webp", width: 960, height: 1280, alt: msg`The goals page`, pending: true },
  { src: "/images/hashi/leaderboard.webp", width: 960, height: 1280, alt: msg`A map's leaderboard in Hashi` },
  { src: "/images/hashi/profile-live.webp", width: 2540, height: 600, alt: msg`A profile showing the map its player is playing`, wide: true },
  { src: "/images/hashi/rankings-live.webp", width: 2330, height: 590, alt: msg`The rankings showing a player who is playing`, wide: true },
];
const SCREENSHOTS = ALL_SCREENSHOTS.filter((shot) => !shot.pending);

// The app captures share one row while they fit, else two centered rows, so none sits alone; site captures go full width under them.
const TALL_SHOTS = SCREENSHOTS.filter((shot) => !shot.wide).length;
const TALL_COLUMNS = TALL_SHOTS <= 5 ? TALL_SHOTS : Math.ceil(TALL_SHOTS / 2);

function Screenshots() {
  const { i18n } = useLingui();
  const [open, setOpen] = useState<number | null>(null);
  const urls = SCREENSHOTS.map((shot) => shot.src);
  const thumb = (shot: (typeof SCREENSHOTS)[number], index: number, className: string) => (
    <button
      key={shot.src}
      type="button"
      onClick={() => setOpen(index)}
      className={`cursor-zoom-in overflow-hidden rounded-lg bg-osu-b4 transition hover:brightness-110 ${className}`}
    >
      <img src={shot.src} alt={i18n._(shot.alt)} width={shot.width} height={shot.height} loading="lazy" className="block h-auto w-full" />
    </button>
  );
  return (
    <div className="mx-auto max-w-4xl px-4">
      <div
        className="mt-8 flex flex-wrap items-start justify-center gap-3 border-t border-white/[0.07] pt-8"
        style={{ "--cols": TALL_COLUMNS } as CSSProperties}
      >
        {SCREENSHOTS.map((shot, index) => shot.wide ? null : thumb(shot, index, "w-[calc((100%-0.75rem)/2)] sm:w-[calc((100%-(var(--cols)-1)*0.75rem)/var(--cols))]"))}
      </div>
      <div className="mt-3 space-y-3">
        {SCREENSHOTS.map((shot, index) => shot.wide ? thumb(shot, index, "block w-full") : null)}
      </div>
      {open != null ? <ImageLightbox urls={urls} index={open} onIndex={setOpen} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

/** Short looping clips of the app at work. The labels are for screen readers; the clips have no captions. */
/** `pending` marks a planned clip that isn't recorded yet; it stays hidden until the file is in. */
type ClipSource = { src: string; poster: string; label: MessageDescriptor; pending?: boolean };

const PRACTICE_CLIP: ClipSource = { src: "/videos/hashi/hashi-practice.mp4", poster: "/images/hashi/video-practice-poster.webp", label: msg`A finished play's analysis in Hashi, turned into a practice map that opens in osu!`, pending: true };
const MODS_CLIP: ClipSource = { src: "/videos/hashi/hashi-mods.mp4", poster: "/images/hashi/video-mods-poster.webp", label: msg`Hashi showing a map's leaderboard for Double Time` };
const GRAVEYARD_CLIP: ClipSource = { src: "/videos/hashi/hashi-graveyard.mp4", poster: "/images/hashi/video-graveyard-poster.webp", label: msg`Hashi showing a leaderboard for a graveyard map` };

/** The clips stack beside the text on wide screens and follow it on narrow ones. */
const CLIPS = [PRACTICE_CLIP, MODS_CLIP, GRAVEYARD_CLIP];

/** One clip; a pending one renders nothing. */
function Clip({ clip }: { clip: ClipSource }) {
  const { i18n } = useLingui();
  if (clip.pending) return null;
  return (
    <video
      src={clip.src}
      poster={clip.poster}
      width={1280}
      height={800}
      autoPlay
      muted
      loop
      playsInline
      aria-label={i18n._(clip.label)}
      className="block h-auto w-full rounded-lg bg-osu-b4"
    />
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
        iconSrc="/images/icons/hashi.svg"
        title={app.name}
      />
      <div className="min-h-[80vh] bg-osu-b5 pb-12">
        <div className="mx-auto max-w-xl px-4 pt-6 sm:pt-8">
          <div className="flex flex-col items-center text-center">
            <img src={app.icon} alt="" width={112} height={112} className="h-28 w-28 rounded-full" />
            <h1 className="mt-5 text-3xl font-semibold text-white">{app.name}</h1>
            <p className="mt-2 max-w-sm text-[15px] leading-relaxed text-osu-l2">
              <Trans>Sends your mania plays to your profile, shows leaderboards for any mods even on graveyard maps, and helps you practice what went wrong.</Trans>
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
        <div className="mx-auto max-w-xl px-4 lg:max-w-6xl">
          <div className="mt-8 grid gap-8 border-t border-white/[0.07] pt-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-10">
            <div className="space-y-6 text-[15px] leading-relaxed text-osu-l2">
              <section>
                <h2 className="text-[13px] font-semibold text-white"><Trans>After each play</Trans></h2>
                <p className="mt-2">
                  <Trans>
                    Click the chart icon on a play to see how it went. It reads the replay on your computer and shows your timing on
                    each key and hand, how you let go of long notes, and where in the map you dropped. It also points out things worth
                    fixing, like a bad offset or chords you roll, and compares the play with your last try on that map.
                  </Trans>
                </p>
                <p className="mt-3">
                  <Trans>This works with <span className={SETTING}>{sendSetting}</span> turned off too.</Trans>
                </p>
              </section>
              <section>
                <h2 className="text-[13px] font-semibold text-white"><Trans>Practice</Trans></h2>
                <p className="mt-2">
                  <Trans>
                    If part of a map went badly, you can turn just that part into its own difficulty. It repeats it a few times,
                    slower first and then at full speed, and opens it in osu! for you. Practice maps never get sent to Mania Tracker.
                  </Trans>
                </p>
                <p className="mt-3">
                  <Trans>
                    There's also a chord trainer for two keys on the same hand. It shows how far apart you press them and has a
                    metronome that can speed up.
                  </Trans>
                </p>
              </section>
              <section>
                <h2 className="text-[13px] font-semibold text-white"><Trans>Goals</Trans></h2>
                <p className="mt-2">
                  <Trans>
                    Each practice map comes with a goal to match the acc you got on the rest of the map, at full speed. Every try
                    shows up on the goal until you get it.
                  </Trans>
                </p>
              </section>
              <section>
                <h2 className="text-[13px] font-semibold text-white"><Trans>Skin editor</Trans></h2>
                <p className="mt-2">
                  <Trans>
                    You can edit your skin and see it on the map you have selected. Change column colors, make each part's
                    art narrower or wider, and move the hit position, columns, judgements and combo around. Edits save straight to
                    your skin, on stable or lazer.
                  </Trans>
                </p>
                <p className="mt-3">
                  <Trans>
                    You can also open it in a window the size of osu!'s and play the map there with its song, or watch autoplay.
                  </Trans>
                </p>
              </section>
              <section>
                <h2 className="text-[13px] font-semibold text-white"><Trans>Leaderboards and your profile</Trans></h2>
                <p className="mt-2">
                  <Trans>
                    While you pick a song, you see the map's leaderboard for the mods you have on, even DT or HT at any rate,
                    Invert or No Release, and on graveyard maps too. You can switch it to your country, your region or your friends,
                    or search for a player.
                  </Trans>
                </p>
                <p className="mt-3">
                  <Trans>
                    Every mania play you finish on stable or lazer goes to your profile with its replay. Turn on{" "}
                    <span className={SETTING}>{shareSetting}</span> and your profile and the rankings show what you're doing in osu!.
                  </Trans>
                </p>
              </section>
            </div>
            <div className="space-y-8">
              <div className="space-y-3">
                {CLIPS.map((clip) => <Clip key={clip.src} clip={clip} />)}
              </div>
              <div className="space-y-6 text-[15px] leading-relaxed text-osu-l2">
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
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
