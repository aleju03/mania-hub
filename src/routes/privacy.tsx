import { createFileRoute } from "@tanstack/react-router";
import { LegalDocument, LegalParagraph, LegalSection } from "#/components/legal/LegalDocument";

const UPDATED_AT = "June 27, 2026";

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
          projections, user preferences, and optional Discord bot features. This policy explains
          the data used to operate the site and bot.
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

      <LegalSection title="Discord Bot">
        <LegalParagraph>
          Mania Tracker's Discord bot, maniabot, uses Discord slash-command interactions to answer
          osu!mania lookup commands and to manage optional server live feeds. The bot does not read
          ordinary Discord message content.
        </LegalParagraph>
        <LegalParagraph>
          When you use a bot command, Discord sends the command name, command options, Discord user
          ID, and, when used in a server, guild ID, channel ID, and permission information needed to
          process the command. Command options can include osu! usernames or user IDs, beatmap IDs
          or URLs, country codes, feed type, key mode, and minimum PP thresholds.
        </LegalParagraph>
        <LegalParagraph>
          Live feed subscriptions store the Discord guild ID, channel ID, selected country, feed
          type, minimum PP threshold, Discord user ID that created or updated the subscription, and
          creation time. These records are used to post configured top-play or snipe feed messages
          to the chosen channel.
        </LegalParagraph>
        <LegalParagraph>
          For bot administration and debugging, the live backend may keep a small in-memory summary
          of recent bot interactions, including command name, Discord user ID, guild ID, and time.
          This summary is not durable storage and is cleared when the backend restarts.
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
        <LegalParagraph>
          Discord command responses and live-feed messages are sent back to Discord and are visible
          according to the channel, server, direct message, or interaction context where the bot is
          used. Discord processes that data under Discord's own terms and privacy policy.
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
          Discord live-feed subscriptions are kept until they are removed with the bot's unsubscribe
          command, removed by an admin tool, cleaned up after the bot loses access to the channel,
          or no longer needed to provide the feature. Discord command payloads are used to answer
          the command and are not stored as durable command history, apart from feed subscription
          records, normal server logs, and the short in-memory interaction summary described above.
        </LegalParagraph>
        <LegalParagraph>
          To remove a Discord live feed, use the bot's unsubscribe command in the channel or remove
          the bot from the server. For privacy, deletion, attribution, takedown, or data concerns,
          contact the maintainer through the public osu! profile linked in the footer.
        </LegalParagraph>
      </LegalSection>
    </LegalDocument>
  );
}
