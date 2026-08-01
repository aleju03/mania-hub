import { createFileRoute } from "@tanstack/react-router";
import { LegalDocument, LegalParagraph, LegalSection } from "#/components/legal/LegalDocument";

const UPDATED_AT = "July 16, 2026";

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
  return (
    <LegalDocument eyebrow="Privacy" title="Privacy Policy" updatedAt={UPDATED_AT}>
      <LegalSection title="Overview">
        <LegalParagraph>
          Mania Tracker is an osu!mania community site built around public osu! data, cached
          projections, and user preferences. This policy explains the data used to operate the
          site.
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="Data The Site Uses">
        <LegalParagraph>
          Mania Tracker uses public osu! profile, score, beatmap, beatmapset, ranking, and replay
          metadata, plus community data services such as osu! score cache, to build rankings,
          tracker views, maps, snipes, top plays, farm-helper suggestions, profiles, and replay
          views.
        </LegalParagraph>
        <LegalParagraph>
          If you sign in with osu!, the site receives the osu! account details allowed by the
          identify and public OAuth scopes, such as user ID, username, avatar URL, and country.
          The site stores a signed HTTP-only session cookie so it can recognize you while the
          session is active.
        </LegalParagraph>
        <LegalParagraph>
          Some signed-in features store data on the server, tied to your osu! user ID: goals you
          create (goal type, target, progress, and status), your card pack wallet and collection
          (pulled cards and pull times), and roster opt-in or opt-out choices. The My Stats
          dashboard does not store anything extra; it only shows you data the site already holds
          about your account.
        </LegalParagraph>
        <LegalParagraph>
          The browser stores preferences and caches in localStorage, including theme settings,
          selected country, hidden users, replay viewer preferences, map filters, and similar
          client-side state. You can clear this data through your browser storage controls.
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="Analytics And Logs">
        <LegalParagraph>
          Mania Tracker counts page views and feature usage with its own first-party analytics,
          stored on the site's own server. Events are sent through the site's own endpoint and
          can include the visited route, selected country, referrer, browser language, screen
          size, and route context such as a viewed player, score, beatmapset, or maps tab.
          Events are kept for 90 days and then deleted.
        </LegalParagraph>
        <LegalParagraph>
          Analytics groups page views from the same browser using a random visitor ID stored in
          localStorage. The ID is not derived from or linked to your osu! account, and clearing
          site data removes it. The country shown in analytics is derived from the request at
          the hosting edge; the IP address itself and the browser user agent are not stored.
          Analytics events are not sent to any third-party service.
        </LegalParagraph>
        <LegalParagraph>
          To prevent abuse, the server counts requests per IP address for rate limiting and caps
          concurrent live connections per IP. These counters live in memory only: the backend
          does not write IP addresses or user agents to its database or logs. Hosting providers
          keep standard request logs, and the server records operational details such as job
          activity, upstream osu! API calls, and errors to monitor service health.
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="Sharing">
        <LegalParagraph>
          Mania Tracker does not sell personal data. Data may be processed by service providers used
          to run the site, including hosting, storage, analytics, osu! API services, and community
          score-data services. Public osu! data may be cached and re-displayed as part of the
          site's community features.
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="Retention And Controls">
        <LegalParagraph>
          Browser preferences and local caches stay on your device until they expire, are replaced,
          or you clear localStorage. osu! login sessions can last up to 30 days unless you log out
          earlier.
        </LegalParagraph>
        <LegalParagraph>
          The server keeps raw score events for about 14 days, live event replay logs for
          about 7 days, completed background-job records for about 2 days, API call logs for about
          7 days, country rank snapshots for about 14 days, and player activity summaries for up
          to 2 years.
        </LegalParagraph>
        <LegalParagraph>
          Durable public projections such as rankings, maps, top plays, snipes, cached profile
          data, and historical aggregates may be kept longer because they are what the site uses
          to serve those features. Goals and card pack collections are kept while your account
          uses those features.
        </LegalParagraph>
        <LegalParagraph>
          For privacy, deletion, attribution, takedown, or data concerns, contact the maintainer
          through the public osu! profile linked in the footer.
        </LegalParagraph>
      </LegalSection>
    </LegalDocument>
  );
}
