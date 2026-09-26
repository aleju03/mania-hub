import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { Trans } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";

import { getI18n } from "../lib/i18n";
import { useLocale } from "../lib/locale-context";
import { PageHeader } from "../components/layout/PageHeader";
import { ScoreRow } from "../components/player/ScoreRows";
import { pageSeo } from "../lib/seo";
import { COMPANELLA_DOWNLOAD_URL } from "../lib/companella-integration/shared";
import type { OsuScore } from "../lib/types";

/*
 * /news/companella: the Companella announcement. Dev-only until the release,
 * like the Companella group in Settings.
 */

export const Route = createFileRoute("/news_/companella")({
  beforeLoad: () => { if (!import.meta.env.DEV) throw notFound(); },
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: i18n._(msg`Companella`),
      description: i18n._(msg`Submit plays to your account whether you're offline, on a private server or restricted from osu!, through Companella.`),
      path: "/news/companella",
      origin: match.context.origin,
      imageTitle: "Companella",
    });
  },
  component: CompanellaAnnouncement,
});

const PUBLISHED_AT = "2026-09-25T12:00:00Z";
const LINK = "text-white underline decoration-white/30 underline-offset-2 transition-colors hover:decoration-white";

/** The Recent row a play Companella sent looks like, drawn by the profile's own component. */
function exampleImport(): OsuScore {
  const cover = "/images/headers/generic.jpg";
  return {
    id: 0, user_id: 0, mode: "mania", accuracy: 0.9784, score: 912_480,
    max_combo: 1874, passed: true, rank: "S", mods: [], pp: 412,
    statistics: { count_geki: 1620, count_300: 212, count_katu: 31, count_100: 9, count_50: 1, count_miss: 1 },
    ended_at: PUBLISHED_AT, has_replay: false,
    companella: { importId: "example", replay: false },
    user: { id: 0, username: "", avatar_url: "", country_code: "CR" },
    beatmap: {
      id: 0, beatmapset_id: 0, difficulty_rating: 5.4, mode: "mania", status: "ranked",
      total_length: 150, cs: 4, drain: 8, accuracy: 8, ar: 5, bpm: 190, convert: false,
      count_circles: 1874, count_sliders: 0, count_spinners: 0, version: "4K Hard", url: "",
    },
    beatmapset: {
      id: 0, title: "Example Song", artist: "Example Artist", creator: "Mapper", user_id: 0,
      covers: { cover, "cover@2x": cover, card: cover, "card@2x": cover, list: cover, "list@2x": cover, slimcover: cover, "slimcover@2x": cover },
      status: "ranked", play_count: 0, favourite_count: 0, submitted_date: "", ranked_date: null, last_updated: "", bpm: 190, preview_url: "",
    },
  } as OsuScore;
}

function CompanellaAnnouncement() {
  const locale = useLocale();
  const published = new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(PUBLISHED_AT));

  return (
    <div className="flex-1">
      <PageHeader
        iconSrc="/images/icons/news.svg"
        title={(
          <>
            <Link to="/settings" search={{ tab: "preferences" }} className="text-osu-f1 transition-colors hover:text-white"><Trans>Settings</Trans></Link>
            <span className="mx-2 text-osu-f1/50">/</span>
            Companella
          </>
        )}
      />
      <div className="bg-osu-b5 min-h-[80vh]">
        <article className="mx-auto max-w-2xl px-4 py-8 sm:px-5 sm:py-12">
          <div className="text-[12px] text-osu-f1">{published}</div>
          <h1 className="mt-2 text-2xl font-semibold leading-tight text-white sm:text-3xl">
            <Trans>You can now submit plays through Companella</Trans>
          </h1>

          <div className="mt-6 space-y-4 border-t border-white/[0.07] pt-6 text-[15px] leading-relaxed text-osu-l2">
            <p>
              <Trans>
                You can now submit plays to your Mania Tracker account whether you're offline, playing on a private server or
                restricted from osu!.
              </Trans>
            </p>
            <p>
              <Trans>
                Some of you might already know Companella, a desktop app for osu!
                (<a href={COMPANELLA_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" className={LINK}>erdbee.re</a>). You can now
                connect it to Mania Tracker to submit your plays here. This integration works with osu!stable only, so lazer plays
                can't be submitted this way.
              </Trans>
            </p>
            <p>
              <Trans>
                Once you connect Companella to your account, it sends every mania play you finish, with its replay. Those plays
                show on your profile's Recent tab and on the tracker with the Companella icon. A play osu! also has shows once.
              </Trans>
            </p>
            <p>
              <Trans>You can also submit ScoreV2 and Hard Rock plays this way.</Trans>
            </p>
          </div>

          <div className="my-7 overflow-hidden rounded-lg bg-osu-b4/40">
            <ScoreRow
              score={exampleImport()}
              position={0}
              layout={{ modColumns: 0, showPp: true, showReplay: false }}
              onOpenDetails={() => {}}
            />
          </div>

          <div className="space-y-4 text-[15px] leading-relaxed text-osu-l2">
            <p>
              <Trans>
                If osu! restricts your account, your profile keeps showing the plays you submit, and your pp is calculated from the
                ones on ranked maps the same way osu! calculates it, so you still show up on the rankings. Cheating can still get you
                banned from Mania Tracker though.
              </Trans>
            </p>
            <p>
              <Trans>
                Your skill ratings use your accuracy on each play, which for osu! plays is normally guessed from your judgement
                counts. If Companella also sent the replay of a play you set on osu!, it's read from how early or late you hit
                each note instead.
              </Trans>
            </p>
            <p>
              <Trans>
                You can revoke Companella's connection in <Link to="/settings" search={{ tab: "preferences" }} className={LINK}>Settings</Link>, under Preferences. It stops sending plays right away.
              </Trans>
            </p>
          </div>

        </article>
      </div>
    </div>
  );
}
