import { createFileRoute, notFound } from "@tanstack/react-router";
import { Radio } from "lucide-react";
import { PageHeader } from "../components/layout/PageHeader";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { CommandShowcase } from "../components/discord/CommandShowcase";
import { canUseDevFeatures } from "../lib/auth-shared";
import { isGlobalScope } from "../lib/country";
import { isRegionScope } from "../lib/regions";
import { fetchDiscordPublicInfo, type DiscordPublicInfo } from "../lib/live-backend";
import { DiscordLogo, DISCORD_BLURPLE } from "../components/ui/DiscordLogo";
import { useSelectedCountry } from "../store";
import { pageSeo } from "../lib/seo";

export const Route = createFileRoute("/discord")({
  head: ({ match }) => pageSeo({
    title: "maniabot - Mania Hub for Discord",
    appendSiteName: false,
    description: "Every osu!mania lookup as a slash command, plus live feeds that post new top plays, snipes, and farm maps into any channel.",
    path: "/discord",
    origin: match.context.origin,
    imageKind: "discord",
    noindex: true,
  }),
  beforeLoad: ({ context }) => {
    if (!canUseDevFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  loader: async () => fetchDiscordPublicInfo(),
  component: DiscordToolPage,
});

const BLURPLE = DISCORD_BLURPLE;

function DiscordToolPage() {
  const info = Route.useLoaderData();

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col overflow-clip bg-osu-b5">
        <OsuTriangleBackdrop />
        <div className="relative z-10 flex flex-1 flex-col">
          <PageHeader
            iconSrc="/images/icons/chat.svg"
            title="maniabot"
            right={(
              <span className="rounded bg-osu-yellow/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-osu-yellow">
                dev preview
              </span>
            )}
          />

          <div className="mx-auto w-full max-w-[920px] flex-1 space-y-5 px-4 py-6 sm:px-5">
            <Hero info={info} />
            {info.configured ? <CommandShowcase /> : null}
            {info.configured ? <FeedsCard feedsEnabled={info.feedsEnabled} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function Hero({ info }: { info: DiscordPublicInfo }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-osu-b3/30 bg-osu-b4">
      <div className="relative flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:p-6">
        <img
          src="/images/discord/maniabot-hero-bg.webp"
          alt=""
          className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover object-[50%_30%] opacity-30"
        />
        <div className="relative min-w-0 flex-1">
          <h1 className="text-[17px] font-bold text-white">maniabot</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-osu-l2">
            Every osu!mania lookup as a slash command. Link your account once with <code className="text-osu-pink-light">/link</code> and
            commands like <code className="text-osu-pink-light">/recent</code> work with no username. Live feeds auto-post new top plays,
            snipes and farm maps straight into any channel.
          </p>
        </div>
        {info.configured && info.inviteUrl ? (
          <a
            href={info.inviteUrl}
            target="_blank"
            rel="noreferrer"
            className="relative inline-flex shrink-0 items-center justify-center gap-2 rounded-xl px-6 py-3.5 text-[14px] font-bold text-white shadow-lg transition-[filter,transform] hover:brightness-110 active:scale-[0.98]"
            style={{ backgroundColor: BLURPLE }}
          >
            <DiscordLogo className="h-5 w-5" />
            Add to Discord
          </a>
        ) : null}
      </div>

      {info.configured ? (
        <ol className="grid gap-px border-t border-osu-b3/30 bg-osu-b3/30 text-[12px] sm:grid-cols-3">
          <HowStep n={1} text="Click Add to Discord and pick a server where you have Manage Server." />
          <HowStep n={2} text="Authorize. The bot needs to send messages and embed links." />
          <HowStep n={3} text={(<>Type <code className="text-osu-pink-light">/help</code> for a guided tour, or <code className="text-osu-pink-light">/</code> to see every command.</>)} />
        </ol>
      ) : (
        <SetupNote />
      )}
    </section>
  );
}

function HowStep({ n, text }: { n: number; text: React.ReactNode }) {
  return (
    <li className="flex gap-2.5 bg-osu-b4 p-4">
      <span
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
        style={{ backgroundColor: BLURPLE }}
      >
        {n}
      </span>
      <span className="text-osu-l2">{text}</span>
    </li>
  );
}

function FeedsCard({ feedsEnabled }: { feedsEnabled: boolean }) {
  const scope = useSelectedCountry();
  // The bot's country param takes real countries or "global" — regions are a
  // site-only scope, so the example falls back to global for them.
  const country = isGlobalScope(scope) || isRegionScope(scope) ? "global" : scope;
  return (
    <section className="rounded-xl border border-osu-b3/30 bg-osu-b4 p-4">
      <div className="mb-2 flex items-center gap-2">
        <Radio className="h-4 w-4 text-osu-pink-light" />
        <h3 className="text-[12px] font-semibold text-white">Live feeds</h3>
      </div>
      <p className="text-[12px] leading-relaxed text-osu-l2">
        <code className="text-osu-pink-light">/subscribe feed:Top plays country:{country}</code> posts every
        new {country} top play into the channel it's run in. The other feeds are snipes and new farm maps, and{" "}
        <code className="text-osu-pink-light">min_pp</code> skips scores below a threshold.{" "}
        <code className="text-osu-pink-light">/subscriptions</code> lists a server's active feeds,{" "}
        <code className="text-osu-pink-light">/unsubscribe</code> stops one. Subscribing needs Manage Server.
      </p>
      {!feedsEnabled ? (
        <p className="mt-2 text-[11px] text-osu-l3">Feeds are currently disabled on the backend.</p>
      ) : null}
    </section>
  );
}

function SetupNote() {
  return (
    <div className="border-t border-osu-b3/30 bg-osu-b4 p-5 sm:p-6">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-osu-yellow" />
        <span className="text-[12px] font-semibold text-white">Not connected yet</span>
      </div>
      <p className="mt-1 text-[12px] text-osu-l2">
        Set these on the live backend, then register the commands from the admin dashboard:
      </p>
      <ul className="mt-2 space-y-1 text-[11px] text-osu-l2">
        <li><code className="text-osu-pink-light">ENABLE_DISCORD_BOT=true</code></li>
        <li><code className="text-osu-pink-light">DISCORD_APPLICATION_ID</code>, <code className="text-osu-pink-light">DISCORD_PUBLIC_KEY</code>, <code className="text-osu-pink-light">DISCORD_BOT_TOKEN</code></li>
      </ul>
    </div>
  );
}
