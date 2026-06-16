import { createFileRoute } from "@tanstack/react-router";
import { LegalDocument, LegalParagraph, LegalSection } from "#/components/legal/LegalDocument";

export const Route = createFileRoute("/legal")({
  head: () => ({
    meta: [
      { title: "Legal notice" },
      {
        name: "description",
        content: "Legal notice for Mania Tracker.",
      },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: LegalPage,
});

function LegalPage() {
  return (
    <LegalDocument eyebrow="Legal notice" title="Mania Tracker" updatedAt="June 16, 2026">
      <LegalSection title="Unofficial Project">
        <LegalParagraph>
          Mania Tracker is an unofficial community fan project for osu!mania players. It is
          not affiliated with, endorsed by, sponsored by, or approved by ppy Pty Ltd or the
          osu! team.
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="osu! Assets And Data">
        <LegalParagraph>
          Rights in osu!, osu!mania, osu! game branding, ruleset names, ruleset icons, score data,
          replay data, user profile data, and related osu! assets remain with ppy Pty Ltd or the
          applicable rightsholders.
        </LegalParagraph>
        <LegalParagraph>
          Beatmap audio, backgrounds, titles, artist names, creator names, metadata, and other
          user-submitted or third-party content remain with their respective owners. This site
          displays available public metadata and derived information for community reference.
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="Data Sources">
        <LegalParagraph>
          Mania Tracker uses public and authenticated osu! API data, locally cached data,
          server projections, and community data services such as{" "}
          <a
            href="https://osc.kaysting.dev/"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-osu-pink-light hover:text-white transition-colors"
          >
            osu! score cache
          </a>
          .
        </LegalParagraph>
        <LegalParagraph>
          The site caches, queues, and reuses data to avoid repeatedly requesting the same
          information from osu!. Live features are built from the site's own server projections,
          with refresh jobs used to fill in missing details and verify notable scores.
        </LegalParagraph>
        <LegalParagraph>
          The server defaults to a global osu! API limiter that targets 45 requests per
          minute and enforces a hard cap of 60 requests per minute.
        </LegalParagraph>
        <LegalParagraph>
          Even with those safeguards, data may be delayed, incomplete, stale, or unavailable.
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="Use Of The Site">
        <LegalParagraph>
          Please do not abuse the site, overload public endpoints, attempt to bypass access
          controls, send harmful payloads, or use the service in a way that disrupts osu!, ppy,
          community APIs, or other users.
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="Accuracy And Availability">
        <LegalParagraph>
          Mania Tracker is a community project built on external data sources, so rankings,
          scores, snipes, top plays, replay views, and other generated surfaces may be delayed,
          incomplete, unavailable, or incorrect.
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="Contact">
        <LegalParagraph>
          For attribution, takedown, privacy, or data concerns, contact the maintainer through
          the public osu! profile linked in the site footer.
        </LegalParagraph>
      </LegalSection>
    </LegalDocument>
  );
}
