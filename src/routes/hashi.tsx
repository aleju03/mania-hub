import { useEffect, useState, type ReactNode } from "react";
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

const FEATURE_IDS = ["boards", "overlay", "live", "analysis", "practice", "skin"] as const;
type FeatureId = (typeof FEATURE_IDS)[number];

export const Route = createFileRoute("/hashi")({
  validateSearch: (search: Record<string, unknown>): { f?: FeatureId } => ({
    f: FEATURE_IDS.find((id) => id !== "boards" && id === search.f),
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
const shareSetting = "Rich presence";
const liveSetting = "Liveplay mode";

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

/**
 * A capture or clip of the app or the site. `pending` marks one that isn't taken yet; it stays hidden until the file is in.
 * `card` is a small capture with its own rounded shape: it shows at its real size, never stretched to the column.
 */
type Media =
  | { kind: "image"; src: string; width: number; height: number; alt: MessageDescriptor; pending?: boolean; card?: boolean }
  | { kind: "clip"; src: string; poster: string; alt: MessageDescriptor; pending?: boolean };

/** Captures of the app's own window are tall and share a row; the rest are wide and stack. */
const isTall = (media: Media) => media.kind === "image" && media.height > media.width;

const BOARDS_MEDIA: Media[] = [
  { kind: "clip", src: "/videos/hashi/hashi-mods.mp4", poster: "/images/hashi/video-mods-poster.webp", alt: msg`Hashi showing a map's leaderboard for Double Time` },
  { kind: "image", src: "/images/hashi/main.webp", width: 960, height: 1280, alt: msg`Hashi's main window with the last plays it sent` },
  { kind: "image", src: "/images/hashi/leaderboard.webp", width: 960, height: 1280, alt: msg`A map's leaderboard in Hashi` },
];
const OVERLAY_MEDIA: Media[] = [
  { kind: "image", src: "/images/hashi/overlay.webp", width: 1048, height: 380, alt: msg`Hashi's overlay card`, card: true },
];
const LIVE_MEDIA: Media[] = [
  { kind: "image", src: "/images/hashi/spectate.webp", width: 1890, height: 840, alt: msg`A play being spectated on a profile` },
  { kind: "image", src: "/images/hashi/profile-live.webp", width: 2540, height: 600, alt: msg`A profile showing the map its player is playing` },
  { kind: "image", src: "/images/hashi/rankings-live.webp", width: 2330, height: 590, alt: msg`The rankings showing a player who is playing` },
];
const ANALYSIS_MEDIA: Media[] = [
  { kind: "image", src: "/images/hashi/analysis.webp", width: 960, height: 1280, alt: msg`The top of a play's analysis, with its score and tips` },
  { kind: "image", src: "/images/hashi/analysis-keys.webp", width: 960, height: 1280, alt: msg`Accuracy for each key and each hand, with the timing chart` },
];
const PRACTICE_MEDIA: Media[] = [
  { kind: "image", src: "/images/hashi/cut.webp", width: 1256, height: 1122, alt: msg`Cutting a map down to one part in Hashi` },
  { kind: "image", src: "/images/hashi/chord-trainer.webp", width: 960, height: 1280, alt: msg`The chord trainer running` },
];
const SKIN_MEDIA: Media[] = [
  { kind: "image", src: "/images/changelog/2026-11-01-hashi-skin-editor.webp", width: 1008, height: 658, alt: msg`Hashi's skin editor on the long notes tab` },
  { kind: "image", src: "/images/changelog/2026-11-01-hashi-skin-editor-layout.webp", width: 1007, height: 764, alt: msg`Hashi's skin editor with the column and combo settings` },
];

/** The picked feature's captures. Images open in the lightbox; clips loop. */
function Stage({ media }: { media: Media[] }) {
  const { i18n } = useLingui();
  const [open, setOpen] = useState<number | null>(null);
  const shown = media.filter((item) => !item.pending);
  const images = shown.filter((item) => item.kind === "image");
  const urls = images.map((item) => item.src);
  const view = (item: Media, className: string) => item.kind === "clip" ? (
    <video
      key={item.src}
      src={item.src}
      poster={item.poster}
      width={1280}
      height={800}
      autoPlay
      muted
      loop
      playsInline
      aria-label={i18n._(item.alt)}
      className={`block h-auto rounded-lg bg-osu-b4 ${className}`}
    />
  ) : (
    <button
      key={item.src}
      type="button"
      onClick={() => setOpen(urls.indexOf(item.src))}
      style={item.card ? { maxWidth: item.width } : undefined}
      className={`cursor-zoom-in transition hover:brightness-110 ${item.card ? "mx-auto block" : "overflow-hidden rounded-lg bg-osu-b4"} ${className}`}
    >
      <img src={item.src} alt={i18n._(item.alt)} width={item.width} height={item.height} className="block h-auto w-full" />
    </button>
  );
  const tall = shown.filter(isTall);
  return (
    <>
      {shown.filter((item) => !isTall(item)).map((item) => view(item, "w-full"))}
      {tall.length > 0 ? (
        <div className="flex justify-center gap-3">
          {tall.map((item) => view(item, "w-[calc(50%-0.375rem)] max-w-[380px]"))}
        </div>
      ) : null}
      {open != null ? <ImageLightbox urls={urls} index={open} onIndex={setOpen} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

const LINK = "text-white underline decoration-white/30 underline-offset-2 transition-colors hover:decoration-white";

function BridgePage() {
  const { t } = useLingui();
  const app = KNOWN_APPS["mania-bridge"];
  const downloads = Route.useLoaderData();
  const active: FeatureId = Route.useSearch().f ?? "boards";
  const navigate = useNavigate();

  const features: { id: FeatureId; title: string; body: ReactNode; media: Media[] }[] = [
    {
      id: "boards",
      title: t`Leaderboards and your profile`,
      media: BOARDS_MEDIA,
      body: (
        <>
          <p><Trans>Every mania play you finish on stable or lazer goes to your profile with its replay.</Trans></p>
          <p>
            <Trans>
              While you pick a song, you see the map's leaderboard for the mods you have on, even DT or HT at any rate,
              Invert or No Release, and on graveyard maps too. You can switch it to your country, your region or your friends,
              or search for a player.
            </Trans>
          </p>
          <p><Trans>Click a player on a leaderboard to see their score and its replay.</Trans></p>
        </>
      ),
    },
    {
      id: "overlay",
      title: t({ message: "Overlay", context: "Hashi feature" }),
      media: OVERLAY_MEDIA,
      body: (
        <>
          <p>
            <Trans>
              The overlay turns the window into a small card that stays above the game. It shows the rating and dan of the map
              you have selected, the play you just finished with its rank, or the map's leaderboard.
            </Trans>
          </p>
          <p><Trans>For streams, the same card goes into OBS as a Browser Source.</Trans></p>
        </>
      ),
    },
    {
      id: "live",
      title: t({ message: "Spectating", context: "Hashi feature" }),
      media: LIVE_MEDIA,
      body: (
        <>
          <p>
            <Trans>
              Turn on <span className={SETTING}>{liveSetting}</span> and anyone can spectate your plays from your profile,
              without opening osu!.
            </Trans>
          </p>
          <p>
            <Trans>
              Turn on <span className={SETTING}>{shareSetting}</span> and your profile and the rankings show what you're doing
              in osu!.
            </Trans>
          </p>
        </>
      ),
    },
    {
      id: "analysis",
      title: t`After each play`,
      media: ANALYSIS_MEDIA,
      body: (
        <>
          <p>
            <Trans>
              Click the chart icon on a play to see how it went. It reads the replay on your computer and shows your timing on
              each key and hand, how you let go of long notes, and where in the map you dropped. It also points out things worth
              fixing, like a bad offset or chords you roll, and compares the play with your last try on that map.
            </Trans>
          </p>
          <p><Trans>This works with <span className={SETTING}>{sendSetting}</span> turned off too.</Trans></p>
        </>
      ),
    },
    {
      id: "practice",
      title: t`Practice`,
      media: PRACTICE_MEDIA,
      body: (
        <>
          <p>
            <Trans>
              If part of a map went badly, you can turn just that part into its own difficulty. It repeats it a few times,
              slower first and then at full speed, and opens it in osu! for you. Practice maps never get sent to Mania Tracker.
            </Trans>
          </p>
          <p>
            <Trans>
              Each practice map comes with a goal to match the acc you got on the rest of the map, at full speed. Every try
              shows up on the goal until you get it.
            </Trans>
          </p>
          <p>
            <Trans>
              You can also cut a map down to the part you want to play, or change its rate on stable. The rate changer shows
              the MSD and dan at the rate you pick.
            </Trans>
          </p>
          <p>
            <Trans>
              There's also a chord trainer for two keys on the same hand. It shows how far apart you press them and has a
              metronome that can speed up.
            </Trans>
          </p>
        </>
      ),
    },
    {
      id: "skin",
      title: t`Skin editor`,
      media: SKIN_MEDIA,
      body: (
        <>
          <p>
            <Trans>
              You can edit your skin and see it on the map you have selected. Change column colors, make each part's
              art narrower or wider, and move the hit position, columns, judgements and combo around. Edits save straight to
              your skin, on stable or lazer.
            </Trans>
          </p>
          <p>
            <Trans>
              You can also open it in a window the size of osu!'s and play the map there with its song, or watch autoplay.
            </Trans>
          </p>
        </>
      ),
    },
  ];

  return (
    <div className="flex-1">
      <PageHeader
        iconSrc="/images/icons/hashi.svg"
        title={app.name}
      />
      <div className="min-h-[80vh] bg-osu-b5 pb-12">
        <div className="mx-auto max-w-xl px-4 pt-6 sm:pt-8">
          <div className="flex flex-col items-center text-center">
            <img src={app.icon} alt="" width={80} height={80} className="h-20 w-20 rounded-full" />
            <h1 className="mt-4 text-2xl font-semibold text-white">{app.name}</h1>
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
        </div>

        <div className="mx-auto max-w-xl px-4 lg:max-w-6xl">
          {/* One grid: the features down the first column, and the picked one's captures after it on a phone or beside the list on a wide screen. */}
          <div className="mt-8 grid border-t border-white/[0.07] pt-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:grid-rows-[repeat(6,auto)_1fr] lg:gap-x-14 lg:pt-10">
            {features.map((feature) => {
              const open = feature.id === active;
              return [
                <div key={feature.id} className="lg:col-start-1">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => navigate({ to: "/hashi", search: feature.id === "boards" ? {} : { f: feature.id }, replace: true, resetScroll: false })}
                    className={`block w-full py-2 text-left text-[19px] font-semibold transition-colors lg:text-[22px] ${open ? "text-white" : "text-osu-f1/70 hover:text-white"}`}
                  >
                    {feature.title}
                  </button>
                  {open ? <div className="space-y-3 pb-4 text-[15px] leading-relaxed text-osu-l2">{feature.body}</div> : null}
                </div>,
                open ? (
                  <div key="stage" className="space-y-3 pb-4 lg:col-start-2 lg:row-start-1 lg:row-span-7 lg:pb-0">
                    <Stage key={feature.id} media={feature.media} />
                  </div>
                ) : null,
              ];
            })}
          </div>

          <div className="mt-10 grid gap-8 border-t border-white/[0.07] pt-8 text-[14px] leading-relaxed text-osu-l2 md:grid-cols-3">
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
                  Connect it to your account from inside the app, or pick Continue without connecting to only use the analysis and the skin editor. You can revoke the connection in <Link to="/settings" search={{ tab: "preferences" }} className={LINK}>Settings</Link>, under Preferences.
                </Trans>
              </p>
            </section>
            <section>
              <h2 className="text-[13px] font-semibold text-white"><Trans>What gets sent</Trans></h2>
              <p className="mt-2">
                <Trans>
                  The <a href={`${MANIA_BRIDGE_SOURCE_URL}#what-gets-sent`} target="_blank" rel="noopener noreferrer" className={LINK}>README</a> lists everything the app sends. It reads osu! on its own.
                </Trans>
              </p>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
