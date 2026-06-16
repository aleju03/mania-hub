import { createFileRoute } from "@tanstack/react-router";
import { LegalDocument, LegalParagraph, LegalSection } from "#/components/legal/LegalDocument";

const UPDATED_AT = "June 16, 2026";

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
          The browser stores preferences and caches in localStorage, including theme settings,
          selected country, hidden users, replay viewer preferences, map filters, and similar
          client-side state. You can clear this data through your browser storage controls.
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="Analytics And Logs">
        <LegalParagraph>
          If analytics are configured, Mania Tracker may send page views and interaction events to
          PostHog through the site's sync endpoint. Those events can include route names, selected
          country, referrer, browser language, screen size, and route-specific identifiers such as
          a viewed player, score, beatmapset, or maps tab.
        </LegalParagraph>
        <LegalParagraph>
          The server may process request metadata such as IP address, user agent, timestamps,
          rate-limit activity, and upstream API call information to operate the site, prevent
          abuse, debug errors, and monitor service health.
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
          to serve those features.
        </LegalParagraph>
        <LegalParagraph>
          For privacy, attribution, takedown, or data concerns, contact the maintainer through
          the public osu! profile linked in the footer.
        </LegalParagraph>
      </LegalSection>
    </LegalDocument>
  );
}
