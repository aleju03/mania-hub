import { createFileRoute } from "@tanstack/react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { LegalDocument, LegalParagraph, LegalSection } from "#/components/legal/LegalDocument";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy" },
      {
        name: "description",
        content: "Privacy Policy for Mania Tracker.",
      },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  const { t } = useLingui();
  return (
    <LegalDocument eyebrow={t`Privacy`} title={t`Privacy Policy`} updatedAt={t`November 11, 2026`}>
      <LegalSection title={t`Overview`}>
        <LegalParagraph>
          <Trans>
            Mania Tracker is an osu!mania community site built around public osu! data, cached
            projections, and user preferences. This policy explains the data used to operate the
            site.
          </Trans>
        </LegalParagraph>
      </LegalSection>

      <LegalSection title={t`Data The Site Uses`}>
        <LegalParagraph>
          <Trans>
            Mania Tracker uses public osu! profile, score, beatmap, beatmapset, ranking, and replay
            metadata to build rankings, tracker views, maps, snipes, top plays, farm-helper suggestions, profiles, and replay
            views.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            If you sign in with osu!, the site receives the osu! account details allowed by the
            identify and public OAuth scopes, such as user ID, username, avatar URL, and country,
            and keeps the first and last time your account signed in and its country. The site
            stores a signed HTTP-only session cookie so it can recognize you while the session is
            active.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            Some signed-in features store data on the server, tied to your osu! user ID: goals you
            create (goal type, target, progress, and status), your card pack wallet and collection
            (pulled cards and pull times), roster opt-in or opt-out choices, skins you upload and
            like, map collections, replays you upload, profile links to other servers, GOAT poll
            votes, maniabot direct message choices and the players you follow there, and
            farm-helper feedback. The My Stats dashboard does
            not store anything extra; it only shows you data the site already holds about your
            account.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            Uploaded replays are unlisted, not private: anyone with the link can watch them.
            Private skins are shown only to you. If you like a skin without signing in, the site
            stores a random browser ID and a salted hash of your network, not your IP address.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            If you load your osu! friends, the site signs you in again with the friends.read
            scope, reads your friends list once, and stores your friends' osu! user IDs. The
            access token is not kept.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            When you send a bug report, feedback, or a translation report, the site stores your
            message, the page you were on, any screenshots, replies in the thread, and your osu!
            account if you are signed in. Bug reports also include your browser user agent, screen
            size, language, and country.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            If you donate through Ko-fi or lava.top, the site receives the amount, currency, and date
            of the payment, plus the name and message you gave. These are kept privately to
            link supporter status to your osu! account and are not shown publicly.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            The browser stores preferences and caches in localStorage, including theme settings,
            selected country, hidden users, replay viewer preferences, map filters, and similar
            client-side state. You can clear this data through your browser storage controls.
          </Trans>
        </LegalParagraph>
      </LegalSection>

      <LegalSection title={t`Analytics And Logs`}>
        <LegalParagraph>
          <Trans>
            Mania Tracker counts page views and feature usage with its own first-party analytics,
            stored on the site's own server. Events are sent through the site's own endpoint and
            can include the visited route, selected country, referrer, browser language, screen
            size, and route context such as a viewed player, score, beatmapset, or maps tab.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            Analytics groups page views from the same browser using a random visitor ID stored in
            localStorage. The ID is not derived from or linked to your osu! account, and clearing
            site data removes it. The country shown in analytics is derived from the request at
            the hosting edge; the IP address itself and the browser user agent are not stored.
            Analytics events are not sent to any third-party service.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            To prevent abuse, the server counts requests per IP address for rate limiting and caps
            concurrent live connections per IP. These counters live in memory only: the backend
            does not write IP addresses to its database or logs. The server's request logs keep
            a shortened IP address with the last part removed and no user agent, for up to 90
            days. Cloudflare, which sits in front of the site, keeps its own request logs. The
            server also records operational details such as job activity, upstream osu! API
            calls, and errors to monitor service health.
          </Trans>
        </LegalParagraph>
      </LegalSection>

      <LegalSection title={t`Sharing`}>
        <LegalParagraph>
          <Trans>
            Mania Tracker does not sell personal data. Data may be processed by service providers used
            to run the site, including hosting, storage, analytics, osu! API services, and beatmap
            download mirrors. Public osu! data may be cached and re-displayed as part of the
            site's community features.
          </Trans>
        </LegalParagraph>
      </LegalSection>

      <LegalSection title={t`Retention And Controls`}>
        <LegalParagraph>
          <Trans>
            Browser preferences and local caches stay on your device until they expire, are replaced,
            or you clear localStorage. osu! login sessions can last up to 30 days unless you log out
            earlier.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            The server keeps raw score events for about 14 days, live event replay logs for
            about 7 days, API call logs for about 7 days, and country rank snapshots for about
            14 days. Player activity summaries, including scores you submit by hand, are kept
            indefinitely, so your profile history stays complete.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            Durable public projections such as rankings, maps, top plays, snipes, cached profile
            data, and historical aggregates may be kept longer because they are what the site uses
            to serve those features. Goals, card pack collections, skins, collections, uploaded
            replays, and friends lists are kept until you delete them or ask for them to be
            deleted.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            When signed in, you can stop tracking or delete your profile from{' '}
            <a
              href="/my-stats"
              className="text-osu-pink-light underline underline-offset-2 hover:text-white transition-colors"
            >
              My Stats
            </a>
            . Stopping tracking records nothing new and keeps what was already recorded. Deleting
            your profile hides it right away and deletes your plays, stats and profile history 7
            days later, unless you cancel before then. Your packs, skins, uploaded replays and
            collections stay. Deleting everything also deletes those, along with your goals,
            Discord link and supporter status. Cards of you that other players pulled stay with
            them.
          </Trans>
        </LegalParagraph>
        <LegalParagraph>
          <Trans>
            To report a bug or send feedback, use the{' '}
            <a
              href="/report"
              className="text-osu-pink-light underline underline-offset-2 hover:text-white transition-colors"
            >
              Bugs and feedback
            </a>{' '}
            form on the site. For privacy, deletion, attribution, takedown, or any other concern,
            email{' '}
            <a
              href="mailto:contact@mania-tracker.com"
              className="text-osu-pink-light underline underline-offset-2 hover:text-white transition-colors"
            >
              contact@mania-tracker.com
            </a>{' '}
            or contact the maintainer through the public osu! profile linked in the footer.
          </Trans>
        </LegalParagraph>
      </LegalSection>
    </LegalDocument>
  );
}
